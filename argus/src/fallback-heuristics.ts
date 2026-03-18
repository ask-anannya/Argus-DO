// ============ TIER 2: Heuristic Fallbacks ============
// Pure-algorithm replacements for LLM functions.
// No API calls — regex/pattern matching only.
// Used when LLM is down or rate-limited.

import type { LLMExtraction, LLMValidation, Event } from './types.js';
import type { ActionResult, ChatResponse, PopupBlueprint } from './gradient.js';

// ============ Date helpers (offline, no LLM) ============

function resolveRelativeDate(text: string, now: Date): Date | null {
  const t = text.toLowerCase();

  // Absolute time mentions like "5pm", "10:30", "17:00"
  const timeMatch = t.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/);

  // "tomorrow" / "kal"
  if (/\b(tomorrow|kal)\b/.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 1);
    if (timeMatch) applyTime(d, timeMatch);
    else d.setHours(10, 0, 0, 0);
    return d;
  }

  // "today" / "aaj"
  if (/\b(today|aaj)\b/.test(t)) {
    const d = new Date(now);
    if (timeMatch) applyTime(d, timeMatch);
    else d.setHours(10, 0, 0, 0);
    return d;
  }

  // "next week"
  if (/next week/.test(t)) {
    const d = new Date(now);
    d.setDate(d.getDate() + 7);
    d.setHours(10, 0, 0, 0);
    return d;
  }

  // Day names — "Monday", "Tuesday", etc.
  const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  for (let i = 0; i < dayNames.length; i++) {
    if (t.includes(dayNames[i])) {
      const d = new Date(now);
      const diff = (i - d.getDay() + 7) % 7 || 7;
      d.setDate(d.getDate() + diff);
      if (timeMatch) applyTime(d, timeMatch);
      else d.setHours(10, 0, 0, 0);
      return d;
    }
  }

  // Standalone time mention (no day, but explicit time)
  if (timeMatch) {
    const d = new Date(now);
    applyTime(d, timeMatch);
    // If in the past, use tomorrow
    if (d.getTime() <= now.getTime()) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  return null;
}

function applyTime(d: Date, match: RegExpMatchArray): void {
  let hours = parseInt(match[1]);
  const minutes = parseInt(match[2] || '0');
  const meridiem = match[3];

  if (meridiem === 'pm' && hours < 12) hours += 12;
  if (meridiem === 'am' && hours === 12) hours = 0;

  d.setHours(hours, minutes, 0, 0);
}

// ============ Tier 2: analyzeMessage replacement ============

export function heuristicAnalyze(
  message: string,
  _context: string[] = [],
  _existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string; event_time: number | null; location: string | null; description: string | null; sender_name?: string | null }> = [],
  messageTimestamp?: number
): LLMExtraction {
  const now = messageTimestamp ? new Date(messageTimestamp * 1000) : new Date();
  const t = message.trim();

  if (t.length < 5) return { events: [] };

  // Quick noise filter: pure greetings/reactions
  if (/^(ok|okay|k|lol|haha|hi|hey|bye|thanks|thx|nice|cool|done|yes|no|yep|nope)$/i.test(t)) {
    return { events: [] };
  }

  // Action detection patterns — if it's an action, don't extract as new event
  const actionPatterns = [
    /\b(cancel|done|ho gaya|kar liya|completed|not now|baad mein|later|remind me|don't remind|delete|remove|hata do|ignore|skip)\b/i,
  ];
  if (actionPatterns.some(p => p.test(t))) {
    return { events: [] };
  }

  const keywords: string[] = [];
  let eventType: LLMExtraction['events'][0]['type'] = 'other';
  let title = '';
  let location: string | null = null;
  let eventTime: string | null = null;
  let confidence = 0.5;

  // ---- Subscription detection ----
  const subServices = ['netflix', 'hotstar', 'amazon prime', 'prime video', 'disney+', 'spotify', 'youtube premium', 'gym', 'domain', 'hosting', 'canva', 'notion'];
  const subMatch = subServices.find(s => t.toLowerCase().includes(s));
  const subActions = /\b(cancel|renew|subscribe|unsubscribe|stop|start)\b/i.exec(t);
  if (subMatch) {
    eventType = 'subscription';
    location = subMatch;
    keywords.push(subMatch, 'subscription');
    title = subActions ? `${subActions[0].charAt(0).toUpperCase() + subActions[0].slice(1)} ${subMatch.charAt(0).toUpperCase() + subMatch.slice(1)}` : `Check ${subMatch}`;
    confidence = 0.7;
  }

  // ---- Meeting / commitment detection ----
  const meetingPatterns = [
    /\b(meeting|call|standup|sync|dinner|lunch|breakfast|coffee|hangout|milte hai|milna|catch up|interview|appointment)\b/i,
  ];
  if (!subMatch && meetingPatterns.some(p => p.test(t))) {
    eventType = 'meeting';
    const m = t.match(/\b(meeting|call|standup|dinner|lunch|breakfast|coffee|hangout|interview|appointment)\b/i);
    title = m ? `${m[0].charAt(0).toUpperCase() + m[0].slice(1)}` : 'Meeting';
    keywords.push('meeting');
    confidence = 0.66;
  }

  // ---- Task / reminder detection ----
  const taskPatterns = [/\b(need to|have to|must|should|want to|gotta|remember to|don't forget|reminder)\b/i];
  if (!subMatch && eventType === 'other' && taskPatterns.some(p => p.test(t))) {
    eventType = 'task';
    title = t.length > 60 ? t.slice(0, 57) + '...' : t;
    keywords.push('task', 'reminder');
    confidence = 0.66;
  }

  // If no pattern matched, skip
  if (eventType === 'other' && !subMatch && title === '') {
    return { events: [] };
  }

  if (title === '') {
    title = t.length > 60 ? t.slice(0, 57) + '...' : t;
  }

  // ---- Date/time extraction ----
  const resolved = resolveRelativeDate(t, now);
  if (resolved) {
    eventTime = resolved.toISOString();
    // Explicit time mention is a strong signal — boost confidence
    if (eventType === 'meeting' || eventType === 'task') {
      confidence = Math.min(0.95, confidence + 0.06);
    }
  }

  // ---- Location extraction ----
  const locationPatterns = [
    /\bin ([\w\s]+?)(?:\s|$|,|\.|!)/i,
    /\bat ([\w\s]+?)(?:\s|$|,|\.|!)/i,
  ];
  for (const p of locationPatterns) {
    const m = p.exec(t);
    if (m && m[1].trim().length > 2 && m[1].trim().length < 30) {
      location = location || m[1].trim().toLowerCase();
      keywords.push(location!);
      break;
    }
  }

  return {
    events: [{
      type: eventType,
      title,
      description: `Heuristic extraction: "${t.slice(0, 100)}"`,
      event_time: eventTime,
      location,
      participants: [],
      keywords,
      confidence,
      event_action: 'create',
      target_event_id: null,
    }],
  };
}

// ============ Tier 2: detectAction replacement ============

export function heuristicDetectAction(
  message: string,
  _context: string[] = [],
  existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string }> = []
): ActionResult {
  const t = message.trim().toLowerCase();

  // Complete / done
  if (/\b(done|ho gaya|kar liya|completed|already done|already cancelled|already unsubscribed|khatam|finish|finished)\b/.test(t)) {
    const target = findTargetEvent(t, existingEvents);
    return {
      isAction: true, action: 'complete',
      targetKeywords: target?.keywords.split(',').map(k => k.trim()) || [],
      targetDescription: target?.title || '',
      confidence: 0.75,
    };
  }

  // Cancel / delete
  if (/\b(cancel|delete|remove|hata do|band karo|mat rakhna|dismiss)\b/.test(t)) {
    const target = findTargetEvent(t, existingEvents);
    return {
      isAction: true, action: 'cancel',
      targetKeywords: target?.keywords.split(',').map(k => k.trim()) || [],
      targetDescription: target?.title || '',
      confidence: 0.75,
    };
  }

  // Ignore / stop
  if (/\b(ignore|stop reminding|mat yaad dilao|never show|nahi chahiye|chhod do|skip|leave it|not interested)\b/.test(t)) {
    const target = findTargetEvent(t, existingEvents);
    return {
      isAction: true, action: 'ignore',
      targetKeywords: target?.keywords.split(',').map(k => k.trim()) || [],
      targetDescription: target?.title || '',
      confidence: 0.7,
    };
  }

  // Snooze / later
  if (/\b(not now|later|baad mein|remind me later|kal yaad dilana|remind me tomorrow|next week|remind next)\b/.test(t)) {
    const isNextWeek = /next week/.test(t);
    const isTomorrow = /tomorrow|kal/.test(t);
    const target = findTargetEvent(t, existingEvents);
    return {
      isAction: true, action: 'postpone',
      targetKeywords: target?.keywords.split(',').map(k => k.trim()) || [],
      targetDescription: target?.title || '',
      snoozeMinutes: isNextWeek ? 10080 : isTomorrow ? 1440 : 30,
      confidence: 0.65,
    };
  }

  return { isAction: false, action: 'none', targetKeywords: [], targetDescription: '', confidence: 0 };
}

function findTargetEvent(
  message: string,
  events: Array<{ id: number; title: string; event_type: string; keywords: string }>
): (typeof events)[0] | null {
  let bestMatch: (typeof events)[0] | null = null;
  let bestScore = 0;

  for (const ev of events) {
    const text = `${ev.title} ${ev.keywords}`.toLowerCase();
    const words = text.split(/\W+/).filter(w => w.length > 2);
    const score = words.filter(w => message.includes(w)).length;
    if (score > bestScore) {
      bestScore = score;
      bestMatch = ev;
    }
  }

  return bestScore > 0 ? bestMatch : null;
}

// ============ Tier 2: validateRelevance replacement ============

export function heuristicValidateRelevance(
  url: string,
  title: string,
  candidates: Event[]
): LLMValidation {
  if (candidates.length === 0) return { relevant: [], confidence: 0 };

  const urlLower = (url + ' ' + title).toLowerCase();
  const urlWords = urlLower.split(/\W+/).filter(w => w.length > 2);

  const relevant: number[] = [];

  candidates.forEach((event, idx) => {
    const eventText = `${event.title} ${event.keywords} ${event.location || ''} ${event.description || ''}`.toLowerCase();
    const eventWords = eventText.split(/\W+/).filter(w => w.length > 2);

    // Count overlap between URL words and event words
    const overlap = urlWords.filter(w => eventWords.includes(w)).length;
    const overlapScore = overlap / Math.max(urlWords.length, 1);

    if (overlapScore >= 0.1 || overlap >= 2) {
      relevant.push(idx);
    }
  });

  const confidence = relevant.length > 0 ? Math.min(0.6, relevant.length * 0.15) : 0;
  return { relevant, confidence };
}

// ============ Tier 2: chatWithContext replacement ============

export function heuristicChat(
  query: string,
  events: Array<{ id: number; title: string; description: string | null; event_type: string; event_time: number | null; location: string | null; status: string; keywords: string; sender_name?: string | null }>,
  _history: Array<{ role: string; content: string }> = []
): ChatResponse {
  const q = query.toLowerCase();
  const now = Date.now() / 1000;

  // Filter to active events
  const active = events.filter(e => !['completed', 'ignored', 'expired'].includes(e.status));

  // Score events by keyword overlap with query
  const queryWords = q.split(/\W+/).filter(w => w.length > 2);
  const scored = active
    .map(e => {
      const text = `${e.title} ${e.keywords} ${e.description || ''} ${e.location || ''}`.toLowerCase();
      const words = text.split(/\W+/).filter(w => w.length > 2);
      const score = queryWords.filter(w => words.includes(w)).length;
      return { event: e, score };
    })
    .filter(x => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  if (scored.length === 0) {
    // Check for "today" / "this week" queries
    if (/\b(today|aaj|this week)\b/.test(q)) {
      const todayStart = Math.floor(new Date().setHours(0, 0, 0, 0) / 1000);
      const todayEnd = todayStart + 86400;
      const todayEvents = active.filter(e => e.event_time && e.event_time >= todayStart && e.event_time <= todayEnd);
      if (todayEvents.length > 0) {
        const list = todayEvents.map(e => `• ${e.title}`).join('\n');
        return {
          response: `Here's what you have today:\n${list}`,
          relevantEventIds: todayEvents.map(e => e.id),
        };
      }
    }

    return {
      response: "I couldn't find any matching events. (AI is in fallback mode — try again when the LLM is back online for smarter search.)",
      relevantEventIds: [],
    };
  }

  const list = scored.map(x => {
    const e = x.event;
    const timeStr = e.event_time
      ? (e.event_time > now ? `on ${new Date(e.event_time * 1000).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}` : '(past)')
      : '';
    return `• ${e.title}${timeStr ? ' ' + timeStr : ''}${e.sender_name ? ` (from ${e.sender_name})` : ''}`;
  }).join('\n');

  return {
    response: `Here are the most relevant events I found:\n${list}\n\n_(Running in fallback mode — AI is temporarily unavailable.)_`,
    relevantEventIds: scored.map(x => x.event.id),
  };
}

// ============ Tier 2: generatePopupBlueprint replacement ============
// Simply delegates to getDefaultPopupBlueprint from gradient.ts
// (imported lazily to avoid circular deps at module init)

export function heuristicGeneratePopupBlueprint(
  event: { title: string; description?: string | null; event_type?: string; location?: string | null; sender_name?: string | null; keywords?: string; event_time?: number | null },
  _triggerContext: { url?: string; pageTitle?: string; conflictingEvents?: Array<{ title: string; event_time?: number | null }> },
  popupType: string
): PopupBlueprint {
  // Re-implemented here to avoid circular import with gradient.ts
  const sender = event.sender_name || null;
  const bodyText = (desc: string | null | undefined) =>
    sender ? `${sender} mentioned: ${desc || event.title}` : desc || event.title;

  switch (popupType) {
    case 'event_discovery':
      return {
        icon: '📅', headerClass: 'discovery',
        title: 'New Event Detected!',
        subtitle: sender ? `From your chat with ${sender}` : 'From your WhatsApp messages',
        body: bodyText(event.description),
        question: 'Would you like to set a reminder?',
        buttons: [
          { text: '⏰ Set Reminder', action: 'set-reminder', style: 'primary' },
          { text: '💤 Later', action: 'snooze', style: 'secondary' },
          { text: '🚫 Not Interested', action: 'ignore', style: 'outline' },
        ],
        popupType,
      };
    case 'event_reminder':
      return {
        icon: '⏰', headerClass: 'reminder',
        title: 'Event Starting Soon!',
        subtitle: sender ? `${sender} mentioned this` : 'Your scheduled reminder',
        body: bodyText(event.description),
        question: null,
        buttons: [
          { text: '✓ Got It', action: 'acknowledge', style: 'primary' },
          { text: '✅ Mark Done', action: 'done', style: 'success' },
          { text: '💤 Snooze 30min', action: 'snooze', style: 'secondary' },
        ],
        popupType,
      };
    case 'context_reminder':
      if (event.event_type === 'recommendation') {
        return {
          icon: '🛍️', headerClass: 'insight',
          title: 'Sale Alert!',
          subtitle: sender ? `From your chat with ${sender}` : 'From your conversations',
          body: `${sender ? sender + ' mentioned' : 'You noted'}: "${event.description || event.title}". Check it out!`,
          question: 'Want to browse?',
          buttons: [
            { text: '🛒 Browse Now', action: 'acknowledge', style: 'primary' },
            { text: '💤 Not Now', action: 'dismiss-temp', style: 'secondary' },
            { text: '🚫 Not Interested', action: 'dismiss-permanent', style: 'outline' },
          ],
          popupType,
        };
      }
      return {
        icon: '🎯', headerClass: 'context',
        title: 'Remember This?',
        subtitle: sender ? `From your chat with ${sender}` : 'From your conversations',
        body: bodyText(event.description),
        question: "You're browsing related content right now!",
        buttons: [
          { text: '✅ Done', action: 'done', style: 'success' },
          { text: '💤 Not Now', action: 'dismiss-temp', style: 'secondary' },
          { text: '🚫 Never Show', action: 'dismiss-permanent', style: 'outline' },
        ],
        popupType,
      };
    case 'conflict_warning':
      return {
        icon: '🗓️', headerClass: 'conflict',
        title: 'Schedule Conflict!',
        subtitle: 'You might be double-booked',
        body: bodyText(event.description),
        question: 'Want to check your schedule?',
        buttons: [
          { text: '📅 View My Day', action: 'view-day', style: 'primary' },
          { text: '✅ Keep Both', action: 'acknowledge', style: 'secondary' },
          { text: '🚫 Skip This One', action: 'ignore', style: 'outline' },
        ],
        popupType,
      };
    default:
      return {
        icon: '💡', headerClass: 'insight',
        title: event.title,
        subtitle: sender ? `From ${sender}` : 'From your messages',
        body: bodyText(event.description),
        question: null,
        buttons: [
          { text: '👍 Thanks!', action: 'acknowledge', style: 'primary' },
          { text: '🚫 Dismiss', action: 'ignore', style: 'outline' },
        ],
        popupType,
      };
  }
}
