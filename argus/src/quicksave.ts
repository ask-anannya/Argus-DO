/**
 * QuickSave Context Compressor for Argus
 * 
 * Applies CEP (Context Extension Protocol) principles to optimize
 * LLM prompt context. Uses S2A filtering and density compression
 * to pack more signal into fewer tokens.
 *
 * Based on: QuickSave v9.1 by Kevin Tan (ktg.one)
 *
 * Integration points:
 *   1. compressEventsForPrompt() → used in gradient.ts before every LLM call
 *   2. compressChatHistory()     → used in /api/chat for session memory
 *   3. detectEventEdges()        → cross-event relationship detection
 */

// ============ TYPES ============

export interface EventEdge {
  sourceId: number;
  targetId: number;
  relation: 'cancels' | 'updates' | 'conflicts' | 'related' | 'same_topic';
}

export interface CompressedContext {
  events: string;           // Dense text block for LLM prompt
  eventCount: number;       // How many events represented
  tokenEstimate: number;    // Rough token count
  edges: EventEdge[];       // Cross-event relationships
  compressionRatio: number; // Original chars / compressed chars
}

export interface ChatMemoryResult {
  recentHistory: Array<{ role: string; content: string }>;
  memoryPacket: string | null;
}

// The event shape that all Argus functions use
export interface CompressibleEvent {
  id: number;
  title: string;
  description: string | null;
  event_type: string;
  event_time: number | null;
  location: string | null;
  status: string;
  keywords: string;
  sender_name?: string | null;
  context_url?: string | null;
  created_at?: number;
}

// ============ STATUS / TYPE MARKERS (inspired by QuickSave kanji) ============
// Dense single-char or short markers that compress verbose status/type strings.

const STATUS_MARKERS: Record<string, string> = {
  discovered: '🆕',
  scheduled:  '⏰',
  completed:  '✅',
  ignored:    '🚫',
  snoozed:    '💤',
  reminded:   '🔔',
  expired:    '⌛',
};

const TYPE_MARKERS: Record<string, string> = {
  meeting:        'MTG',
  deadline:       'DL',
  reminder:       'RMD',
  travel:         'TRV',
  task:           'TSK',
  subscription:   'SUB',
  recommendation: 'REC',
  other:          'OTH',
};

// ============ S2A FILTER ============
// System 2 Attention — rank events by signal value.
// High signal: upcoming, recent, has context_url, scheduled
// Low signal:  past + completed, very old discoveries, stale/ignored

export function filterBySignal(
  events: CompressibleEvent[]
): Array<CompressibleEvent & { priority: number }> {
  const now = Math.floor(Date.now() / 1000);
  const DAY = 86400;

  return events
    .map(e => {
      let priority = 5; // baseline

      // ── Time relevance ──
      if (e.event_time) {
        const hoursUntil = (e.event_time - now) / 3600;
        if (hoursUntil > 0 && hoursUntil <= 2)        priority += 4; // Imminent
        else if (hoursUntil > 0 && hoursUntil <= 24)   priority += 3; // Today
        else if (hoursUntil > 0 && hoursUntil <= 168)  priority += 2; // This week
        else if (hoursUntil > 168 && hoursUntil <= 720) priority += 1; // This month
        else if (hoursUntil < 0)                        priority -= 2; // Past
      }

      // ── Status relevance ──
      if (e.status === 'completed' || e.status === 'ignored') priority -= 3;
      if (e.status === 'scheduled')  priority += 1;
      if (e.status === 'snoozed')    priority += 1; // user cared enough to snooze

      // ── Context URL = high value (triggers on browsing) ──
      if (e.context_url) priority += 1;

      // ── Recency of creation ──
      if (e.created_at) {
        const daysOld = (now - e.created_at) / DAY;
        if (daysOld > 30) priority -= 1;
        if (daysOld > 90) priority -= 2;
      }

      // ── Confidence boost ──
      // Events from recommendations/gifts with context_url are high-signal
      if (e.event_type === 'recommendation' && e.context_url) priority += 1;

      return { ...e, priority: Math.max(0, Math.min(10, priority)) };
    })
    .sort((a, b) => b.priority - a.priority);
}

// ============ EVENT COMPRESSION ============
// Compress event list into a dense text block for LLM prompts.
// Uses abbreviated format: #ID|TYPE|STATUS|"Title"|time|loc|sender|keywords
// ~40-55% fewer tokens vs the old verbose format.

export function compressEventsForPrompt(
  events: CompressibleEvent[],
  maxEvents: number = 60
): CompressedContext {
  if (events.length === 0) {
    return {
      events: 'No events stored yet.',
      eventCount: 0,
      tokenEstimate: 5,
      edges: [],
      compressionRatio: 1,
    };
  }

  // Measure original size
  const originalSize = events.reduce((acc, e) => {
    return acc + `[x] ID#${e.id} | "${e.title}" | type: ${e.event_type} | time: x | location: ${e.location || 'none'} | status: ${e.status} | sender: ${e.sender_name || 'unknown'} | keywords: ${e.keywords}${e.description ? ' | desc: ' + e.description : ''}`.length;
  }, 0);

  // Step 1: S2A filter — rank by signal
  const ranked = filterBySignal(events);

  // Step 2: Take top N by priority
  const selected = ranked.slice(0, maxEvents);

  // Step 3: Compress each event to dense single-line format
  const lines = selected.map(e => {
    const type = TYPE_MARKERS[e.event_type] || 'OTH';
    const status = STATUS_MARKERS[e.status] || '❓';

    let timeStr = '—';
    if (e.event_time) {
      const d = new Date(e.event_time * 1000);
      const isPast = d.getTime() < Date.now();
      timeStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      timeStr += ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      if (isPast) timeStr += ' [PAST]';
    }

    // Dense format: #ID|TYPE|STATUS|"Title"|time|loc|sender|keywords
    // Omit description in the compressed line — title + keywords carry enough signal
    const parts = [
      `#${e.id}`,
      type,
      status,
      `"${e.title}"`,
      timeStr,
      e.location || '—',
      e.sender_name || '?',
      e.keywords,
    ];

    return parts.join('|');
  });

  const compressed = lines.join('\n');

  // Detect cross-event edges
  const edges = detectEventEdges(selected);

  // Add edge summary if any found (helps LLM understand relationships)
  let edgeSuffix = '';
  if (edges.length > 0) {
    const edgeLines = edges.slice(0, 10).map(e =>
      `#${e.sourceId}→#${e.targetId}(${e.relation})`
    );
    edgeSuffix = '\nRelationships: ' + edgeLines.join(', ');
  }

  return {
    events: compressed + edgeSuffix,
    eventCount: selected.length,
    tokenEstimate: Math.ceil((compressed.length + edgeSuffix.length) / 4),
    edges,
    compressionRatio: originalSize > 0 ? originalSize / compressed.length : 1,
  };
}

// ============ EDGE DETECTION (L2 Relational) ============
// Detect relationships between events — same topic, cancel↔subscription, time conflicts.
// QuickSave L2 principle: "What connections would topic-by-topic miss?"

export function detectEventEdges(
  events: CompressibleEvent[]
): EventEdge[] {
  const edges: EventEdge[] = [];
  if (events.length < 2) return edges;

  // Pre-compute keyword sets
  const kwSets = events.map(e => 
    new Set(e.keywords.toLowerCase().split(',').map(k => k.trim()).filter(k => k.length > 2))
  );

  for (let i = 0; i < events.length; i++) {
    for (let j = i + 1; j < events.length; j++) {
      // ── Keyword overlap → related / same_topic ──
      const overlap = [...kwSets[i]].filter(k => kwSets[j].has(k));
      
      if (overlap.length >= 2) {
        const titleA = events[i].title.toLowerCase();
        const titleB = events[j].title.toLowerCase();
        
        // Subscription + cancel in title → cancels relationship
        const aIsSub = events[i].event_type === 'subscription';
        const bIsSub = events[j].event_type === 'subscription';
        const aIsCancel = titleA.includes('cancel') || titleA.includes('unsubscribe');
        const bIsCancel = titleB.includes('cancel') || titleB.includes('unsubscribe');
        
        if ((aIsSub && bIsCancel) || (bIsSub && aIsCancel)) {
          edges.push({ sourceId: events[i].id, targetId: events[j].id, relation: 'cancels' });
        } else {
          edges.push({ sourceId: events[i].id, targetId: events[j].id, relation: 'same_topic' });
        }
      }

      // ── Time conflict (within 1 hour) ──
      if (events[i].event_time && events[j].event_time) {
        const diff = Math.abs(events[i].event_time! - events[j].event_time!);
        if (diff <= 3600 && diff > 0) {
          edges.push({ sourceId: events[i].id, targetId: events[j].id, relation: 'conflicts' });
        }
      }
    }
  }

  return edges;
}

// ============ CHAT HISTORY COMPRESSION ============
// When AI sidebar chat history gets long, compress older turns into a
// dense "memory packet" — the core QuickSave session handoff use case.
// Recent turns stay raw (LLM needs exact wording), older turns get
// S2A-filtered into key facts/questions/decisions.

export function compressChatHistory(
  history: Array<{ role: string; content: string }>,
  maxRecentTurns: number = 6
): ChatMemoryResult {
  if (history.length <= maxRecentTurns) {
    return { recentHistory: history, memoryPacket: null };
  }

  // Split: older turns → compress, recent turns → keep raw
  const olderTurns = history.slice(0, history.length - maxRecentTurns);
  const recentHistory = history.slice(-maxRecentTurns);

  // S2A filter — extract signal from older turns
  const userQueries: string[] = [];
  const argusKeyFacts: string[] = [];
  const eventRefs: string[] = [];

  for (const turn of olderTurns) {
    const content = turn.content.trim();
    if (!content || content.length < 5) continue;

    if (turn.role === 'user') {
      // Keep user questions/requests (truncated)
      const summary = content.length > 100 ? content.slice(0, 100) + '…' : content;
      userQueries.push(summary);
    } else {
      // Argus responses — extract key facts only (S2A: discard pleasantries, filler)
      const sentences = content.split(/[.!]\s+/).filter(s => s.length > 15);
      for (const sentence of sentences.slice(0, 3)) {
        // Keep sentences about events, actions, recommendations
        if (/\b(event|meeting|reminder|deadline|scheduled|cancel|done|recommend|gift|travel|subscription|tomorrow|today|next week)\b/i.test(sentence)) {
          const fact = sentence.length > 120 ? sentence.slice(0, 120) + '…' : sentence;
          argusKeyFacts.push(fact);
        }
        // Keep event ID references
        const idMatch = sentence.match(/#(\d+)/g);
        if (idMatch) eventRefs.push(...idMatch);
      }
    }
  }

  // Build compressed packet
  const packetParts: string[] = [];
  packetParts.push(`[Prior conversation: ${olderTurns.length} turns compressed]`);
  
  if (userQueries.length > 0) {
    packetParts.push('User asked: ' + userQueries.slice(-5).join(' → '));
  }
  if (argusKeyFacts.length > 0) {
    packetParts.push('Key facts: ' + argusKeyFacts.slice(-5).join(' | '));
  }
  if (eventRefs.length > 0) {
    const uniqueRefs = [...new Set(eventRefs)].slice(0, 10);
    packetParts.push('Events discussed: ' + uniqueRefs.join(', '));
  }

  return {
    recentHistory,
    memoryPacket: packetParts.join('\n'),
  };
}

// ============ LIGHTWEIGHT EVENT SUMMARY ============
// For smaller contexts (analyzeMessage, detectAction) where we don't need
// full compression but still want dense format.

export function compressEventsLight(
  events: Array<{ id: number; title: string; event_type: string; keywords: string; event_time: number | null; location: string | null; description: string | null; sender_name?: string | null }>
): string {
  if (events.length === 0) return '';

  return events.map(e => {
    const type = TYPE_MARKERS[e.event_type] || 'OTH';
    let timeStr = 'no date';
    if (e.event_time) {
      const d = new Date(e.event_time * 1000);
      timeStr = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
      timeStr += ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }
    return `  [#${e.id}] ${type} "${e.title}" | ${timeStr} | ${e.location || '—'} | kw: ${e.keywords} | from: ${e.sender_name || '?'}`;
  }).join('\n');
}
