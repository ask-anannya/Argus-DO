import { searchEventsByKeywords, searchEventsByLocation } from './db.js';
import { validateRelevance } from './gradient.js';
import type { Event, ContextCheckResponse } from './types.js';

// ============ Match Result Cache ============

interface CachedMatch {
  result: ContextCheckResponse;
  cachedAt: number;
}

const matchCache = new Map<string, CachedMatch>();
const MATCH_CACHE_TTL = 10 * 60 * 1000;  // 10 minutes
const MATCH_CACHE_MAX = 200;              // max cached URLs

export function getMatchCacheStats(): { size: number; maxSize: number; ttlSec: number } {
  return { size: matchCache.size, maxSize: MATCH_CACHE_MAX, ttlSec: MATCH_CACHE_TTL / 1000 };
}

function cacheResult(key: string, result: ContextCheckResponse): void {
  matchCache.set(key, { result, cachedAt: Date.now() });
  // FIFO eviction when over max
  if (matchCache.size > MATCH_CACHE_MAX) {
    const oldest = matchCache.keys().next().value;
    if (oldest) matchCache.delete(oldest);
  }
}

// ============ URL Normalization ============

/**
 * Strips tracking params and fragment so the same page with different UTM tags
 * hits the same cache entry.
 */
function normalizeUrl(url: string): string {
  try {
    const u = new URL(url);
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'ref', 'fbclid', 'gclid']
      .forEach(p => u.searchParams.delete(p));
    u.hash = '';
    return u.toString();
  } catch { return url; }
}

// ============ Keyword Overlap Scoring (LLM-free Fallback) ============

/**
 * Scores candidates by keyword overlap with the URL-extracted keywords.
 * Used when LLM validation is unavailable.
 * Confidence is capped at 0.8 — never full confidence without LLM.
 */
function keywordOverlapValidation(
  urlKeywords: string[],
  candidates: Event[]
): { relevant: number[]; confidence: number } {
  const urlSet = new Set(urlKeywords.map(k => k.toLowerCase()));
  const scored: { idx: number; score: number }[] = [];

  for (let i = 0; i < candidates.length; i++) {
    const event = candidates[i];
    const eventWords = new Set(
      `${event.title} ${event.keywords} ${event.location || ''} ${event.description || ''}`
        .toLowerCase()
        .split(/[\s,]+/)
        .filter(w => w.length > 2)
    );

    // Count overlapping keywords (substring match in either direction)
    let overlap = 0;
    for (const kw of urlSet) {
      for (const ew of eventWords) {
        if (ew.includes(kw) || kw.includes(ew)) { overlap++; break; }
      }
    }

    const score = urlSet.size > 0 ? overlap / urlSet.size : 0;
    if (score >= 0.3) {  // At least 30% keyword overlap
      scored.push({ idx: i, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const relevant = scored.slice(0, 5).map(s => s.idx);
  const confidence = scored.length > 0 ? scored[0].score * 0.8 : 0;  // Cap at 0.8

  return { relevant, confidence };
}

// ============ URL Pattern Extraction ============

// Common URL patterns to extract context
const URL_PATTERNS: Array<{ pattern: RegExp; activity: string; keywords: (match: RegExpMatchArray) => string[] }> = [
  // Travel
  { pattern: /makemytrip\.com.*\/(flights?|hotels?|trains?)\/?(.*)$/i, activity: 'travel_booking', keywords: m => extractUrlKeywords(m[2]) },
  { pattern: /goibibo\.com.*\/(flights?|hotels?)\/?(.*)$/i, activity: 'travel_booking', keywords: m => extractUrlKeywords(m[2]) },
  { pattern: /booking\.com.*\/(.*)$/i, activity: 'hotel_booking', keywords: m => extractUrlKeywords(m[1]) },
  { pattern: /airbnb\.(com|co\.in).*\/(.*)$/i, activity: 'accommodation', keywords: m => extractUrlKeywords(m[2]) },
  { pattern: /skyscanner\.(com|co\.in).*\/(.*)$/i, activity: 'flight_search', keywords: m => extractUrlKeywords(m[2]) },
  { pattern: /tripadvisor\.(com|in).*\/(.*)$/i, activity: 'travel_research', keywords: m => extractUrlKeywords(m[2]) },

  // Shopping
  { pattern: /amazon\.(com|in).*\/s\?.*k=([^&]+)/i, activity: 'shopping_search', keywords: m => [decodeURIComponent(m[2]).replace(/\+/g, ' ')] },
  { pattern: /amazon\.(com|in).*\/dp\/\w+/i, activity: 'shopping_product', keywords: () => [] },
  { pattern: /amazon\.(com|in)/i, activity: 'shopping', keywords: () => ['amazon', 'shopping', 'gift', 'buy'] },
  { pattern: /flipkart\.com.*\/search\?q=([^&]+)/i, activity: 'shopping_search', keywords: m => [decodeURIComponent(m[1])] },
  { pattern: /flipkart\.com/i, activity: 'shopping', keywords: () => ['flipkart', 'shopping', 'gift', 'buy'] },
  { pattern: /myntra\.com.*\/(.*)$/i, activity: 'fashion_shopping', keywords: m => extractUrlKeywords(m[1]) },
  { pattern: /myntra\.com/i, activity: 'fashion_shopping', keywords: () => ['myntra', 'fashion', 'shoes', 'sneakers', 'clothes', 'gift'] },
  { pattern: /nykaa\.com/i, activity: 'beauty_shopping', keywords: () => ['nykaa', 'beauty', 'makeup', 'cosmetics', 'skincare', 'gift'] },
  { pattern: /ajio\.com/i, activity: 'fashion_shopping', keywords: () => ['ajio', 'fashion', 'clothes', 'shoes', 'gift'] },
  { pattern: /tatacliq\.com/i, activity: 'shopping', keywords: () => ['tatacliq', 'shopping', 'electronics', 'fashion', 'gift'] },

  // Subscriptions
  { pattern: /netflix\.com/i, activity: 'streaming', keywords: () => ['netflix', 'subscription', 'streaming'] },
  { pattern: /spotify\.com/i, activity: 'music', keywords: () => ['spotify', 'subscription', 'music'] },
  { pattern: /primevideo\.com/i, activity: 'streaming', keywords: () => ['prime', 'amazon', 'subscription'] },
  { pattern: /hotstar\.com|disney\+/i, activity: 'streaming', keywords: () => ['hotstar', 'disney', 'subscription'] },
  { pattern: /canva\.com/i, activity: 'design', keywords: () => ['canva', 'design', 'subscription'] },

  // Finance
  { pattern: /policybazaar\.com.*\/(car|bike|health|life)/i, activity: 'insurance', keywords: m => [m[1], 'insurance'] },
  { pattern: /bankbazaar\.com/i, activity: 'finance', keywords: () => ['loan', 'credit', 'bank'] },

  // Calendar/Productivity
  { pattern: /calendar\.google\.com/i, activity: 'calendar', keywords: () => ['meeting', 'event', 'schedule'] },
  { pattern: /outlook\.(com|office)/i, activity: 'email', keywords: () => ['email', 'meeting'] },
];

function extractUrlKeywords(path: string): string[] {
  if (!path) return [];
  return path
    .split(/[/\-_?&=]+/)
    .filter(s => s.length > 2 && !/^\d+$/.test(s))
    .map(s => decodeURIComponent(s).toLowerCase())
    .slice(0, 5);
}

export function extractContextFromUrl(url: string, title?: string): { activity: string; keywords: string[] } {
  // Try URL patterns
  for (const { pattern, activity, keywords } of URL_PATTERNS) {
    const match = url.match(pattern);
    if (match) {
      const kws = keywords(match);
      // Also extract from URL path
      const urlObj = new URL(url);
      const pathKeywords = extractUrlKeywords(urlObj.pathname);
      return {
        activity,
        keywords: [...new Set([...kws, ...pathKeywords])].filter(Boolean),
      };
    }
  }

  // Fallback: extract from URL and title
  const urlObj = new URL(url);
  const pathKeywords = extractUrlKeywords(urlObj.pathname);
  const titleKeywords = title
    ? title.toLowerCase().split(/\s+/).filter(w => w.length > 3).slice(0, 5)
    : [];

  return {
    activity: 'browsing',
    keywords: [...new Set([...pathKeywords, ...titleKeywords])].filter(Boolean),
  };
}

// ============ matchContext (with cache + fallbacks) ============

export async function matchContext(
  url: string,
  title?: string,
  hotWindowDays = 90
): Promise<ContextCheckResponse> {
  const start = Date.now();

  // Step 1: Cache check (normalize URL to dedupe tracking params)
  const cacheKey = normalizeUrl(url);
  const cached = matchCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < MATCH_CACHE_TTL) {
    console.log(`🔍 Context check: ${url}`);
    console.log(`   Cache hit (${Date.now() - start}ms)`);
    return cached.result;
  }

  // Step 2: Extract context from URL
  const { keywords } = extractContextFromUrl(url, title);

  if (keywords.length === 0) {
    return { matched: false, events: [], confidence: 0 };
  }

  console.log(`🔍 Context check: ${url}`);
  console.log(`   Keywords: ${keywords.join(', ')}`);

  // Step 3: Elastic search (cascading queries) — fallback to stale cache if ES is down
  let candidates: Event[] = [];

  try {
    // Try exact location match first
    for (const kw of keywords) {
      candidates = await searchEventsByLocation(kw, hotWindowDays, 10);
      if (candidates.length > 0) break;
    }

    // If no location match, try multi-match
    if (candidates.length === 0) {
      candidates = await searchEventsByKeywords(keywords, hotWindowDays, 10);
    }
  } catch (err) {
    console.warn(`⚠️ [matchContext] ES search failed: ${err instanceof Error ? err.message : err}`);
    if (cached) {
      console.log(`   Returning stale cache for ${url} (${Date.now() - start}ms)`);
      return cached.result;
    }
    return { matched: false, events: [], confidence: 0 };
  }

  if (candidates.length === 0) {
    console.log(`   No candidates found (${Date.now() - start}ms)`);
    const emptyResult: ContextCheckResponse = { matched: false, events: [], confidence: 0 };
    cacheResult(cacheKey, emptyResult);
    return emptyResult;
  }

  console.log(`   Found ${candidates.length} candidates`);

  // Step 4: LLM validation — fallback to keyword overlap scoring if LLM is down
  let validation: { relevant: number[]; confidence: number };

  try {
    validation = await validateRelevance(url, title || '', candidates);
  } catch {
    console.warn('⚠️ [matchContext] LLM validation failed, using keyword overlap scoring');
    validation = keywordOverlapValidation(keywords, candidates);
  }

  if (validation.relevant.length === 0) {
    console.log(`   No relevant events (${Date.now() - start}ms)`);
    const noMatchResult: ContextCheckResponse = { matched: false, events: [], confidence: validation.confidence };
    cacheResult(cacheKey, noMatchResult);
    return noMatchResult;
  }

  // Build matched events list
  const matchedEvents = validation.relevant
    .map(idx => candidates[idx])
    .filter((e): e is Event => e !== undefined);

  console.log(`   Matched ${matchedEvents.length} events (${Date.now() - start}ms)`);

  const result: ContextCheckResponse = {
    matched: true,
    events: matchedEvents,
    confidence: validation.confidence,
  };

  cacheResult(cacheKey, result);
  return result;
}

// Quick check without LLM (for real-time triggers)
export async function quickMatchByUrl(url: string): Promise<Event[]> {
  const { keywords } = extractContextFromUrl(url);
  if (keywords.length === 0) return [];

  return searchEventsByKeywords(keywords.slice(0, 3), 90, 5);
}
