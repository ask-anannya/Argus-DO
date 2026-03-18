import type { LLMExtraction, LLMValidation, Event } from './types.js';
import { compressEventsForPrompt, compressChatHistory, compressEventsLight } from './quicksave.js';
import { withFallback, reportSuccess, reportFailure, registerHealthPing } from './ai-tier.js';
import { cacheGet, cacheSet } from './response-cache.js';
import {
  heuristicAnalyze,
  heuristicDetectAction,
  heuristicValidateRelevance,
  heuristicChat,
  heuristicGeneratePopupBlueprint,
} from './fallback-heuristics.js';
import OpenAI from 'openai';

const MODEL = 'llama3.3-70b-instruct';

let llmClient: OpenAI | null = null;

export function initGradient(cfg: { apiKey: string }): void {
  llmClient = new OpenAI({
    baseURL: 'https://inference.do-ai.run/v1',
    apiKey: cfg.apiKey,
  });
  console.log('✅ Gradient initialized: llama3.3-70b-instruct');
  registerHealthPing(gradientHealthPing);
}


async function gradientHealthPing(): Promise<boolean> {
  if (!llmClient) return false;
  try {
    await llmClient.chat.completions.create({
      model: MODEL,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 1,
    });
    return true;
  } catch {
    return false;
  }
}

async function callLlama(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  jsonMode = true
): Promise<string> {
  if (!llmClient) throw new Error('Gradient not initialized. Call initGradient() first.');

  // Llama sometimes ignores response_format and returns prose + markdown.
  // Reinforce JSON-only output in the last user message when in JSON mode.
  const enforced = jsonMode ? messages.map((m, i) =>
    i === messages.length - 1 && m.role === 'user'
      ? { ...m, content: m.content + '\n\nIMPORTANT: Return ONLY valid JSON. No prose, no markdown fences, no explanation.' }
      : m
  ) : messages;

  try {
    const completion = await llmClient.chat.completions.create({
      model: MODEL,
      messages: enforced,
      temperature: 0.1,
      max_tokens: 4096,
      ...(jsonMode && { response_format: { type: 'json_object' } }),
    });
    const content = completion.choices[0]?.message?.content || '';
    reportSuccess();
    return content;
  } catch (err) {
    reportFailure(err);
    throw err;
  }
}

const SYSTEM_PROMPT = `You are the AI brain of Argus, a proactive WhatsApp memory assistant. Your job is to intelligently extract, classify, and match events from casual WhatsApp conversations.

CRITICAL RULES:
- Understand Hinglish (Hindi + English mix), broken English, typos, and informal chat language
- Distinguish REAL events/tasks from spam, forwarded promotions, memes, and casual chatter
- A message like "get canva at 199" or "netflix at just 99" is a PROMOTIONAL/SPAM message, NOT a genuine user intent — set confidence < 0.3
- Genuine intent examples: "I want to cancel netflix", "need to get canva pro for work", "bro try cashews at Zantyes in Goa"
- Always consider the FULL conversation context — who said what, and whether it is the USER's own intent vs someone forwarding a deal
- Be VERY conservative: fewer false positives is MUCH better than catching everything
- When the sender is a business/brand account, treat messages as promotional (low confidence)
- DO NOT extract developer/coding chat, vague "I will" statements, work status updates, or casual social chat as events
- Only extract events with CLEAR, SPECIFIC, ACTIONABLE intent (who/what/when/where)
- Return valid JSON only`;

// ============ DATE CONTEXT HELPER ============
function formatDateContext(messageTimestamp?: number): string {
  const now = new Date();
  const msgDate = messageTimestamp ? new Date(messageTimestamp * 1000) : now;

  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const fmtDate = (d: Date) =>
    `${dayNames[d.getDay()]}, ${d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}`;
  const fmtTime = (d: Date) =>
    d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

  const nextDayLines: string[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(msgDate);
    d.setDate(d.getDate() + i);
    nextDayLines.push(`- "${dayNames[d.getDay()]}" → ${fmtDate(d)}`);
  }

  const tomorrow = new Date(msgDate);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dayAfter = new Date(msgDate);
  dayAfter.setDate(dayAfter.getDate() + 2);

  const endOfWeek = new Date(msgDate);
  endOfWeek.setDate(endOfWeek.getDate() + (7 - endOfWeek.getDay()));

  const endOfMonth = new Date(msgDate.getFullYear(), msgDate.getMonth() + 1, 0);

  const nextWeekStart = new Date(msgDate);
  nextWeekStart.setDate(nextWeekStart.getDate() + (8 - nextWeekStart.getDay()));

  return `=== DATE/TIME CONTEXT (use this to resolve ALL relative dates) ===
Right now      : ${fmtDate(now)}, ${fmtTime(now)}
Message sent at: ${fmtDate(msgDate)}, ${fmtTime(msgDate)}
Today is       : ${dayNames[now.getDay()]}

Pre-resolved day-name look-up (ALWAYS use these exact dates):
- "today" / "aaj"       → ${fmtDate(msgDate)}
- "tomorrow" / "kal"    → ${fmtDate(tomorrow)}
- "day after" / "parso" → ${fmtDate(dayAfter)}
${nextDayLines.join('\n')}
- "this week" / "end of week"   → ${fmtDate(endOfWeek)}
- "this month" / "end of month" → ${fmtDate(endOfMonth)}
- "next week"                   → week starting ${fmtDate(nextWeekStart)}
===`;
}

// ============ TRUNCATED JSON REPAIR ============

/** Extract all top-level { } blocks from a string using brace matching. */
function extractAllJsonObjects(raw: string): any[] {
  const results: any[] = [];
  let i = 0;
  while (i < raw.length) {
    const brace = raw.indexOf('{', i);
    if (brace === -1) break;
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = brace; j < raw.length; j++) {
      const c = raw[j];
      if (c === '"' && (j === 0 || raw[j - 1] !== '\\')) inStr = !inStr;
      if (!inStr) {
        if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
    }
    if (end !== -1) {
      try { results.push(JSON.parse(raw.slice(brace, end + 1))); } catch { /* malformed */ }
      i = end + 1;
    } else {
      i = brace + 1;
    }
  }
  return results;
}

function repairJSON(raw: string, preferredKey?: string): any | null {
  let s = raw.trim();
  if (!s) return null;

  // Step 1: try direct parse first
  try { return JSON.parse(s); } catch { /* continue */ }

  // Step 2: extract JSON from a markdown code block anywhere in the response
  const fenceMatch = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch) {
    try { return JSON.parse(fenceMatch[1].trim()); } catch { /* continue */ }
  }

  // Step 3: scan ALL top-level { } blocks — prefer the one with preferredKey
  const allObjects = extractAllJsonObjects(s);
  if (allObjects.length > 0) {
    if (preferredKey) {
      const preferred = allObjects.find(obj => obj[preferredKey] !== undefined);
      if (preferred) return preferred;
    }
    // Fall back to first valid block
    return allObjects[0];
  }

  // Step 4: strip leading prose then apply brace-closing repair
  const firstBrace = s.indexOf('{');
  const firstBracket = s.indexOf('[');
  const start = firstBrace === -1 ? firstBracket
              : firstBracket === -1 ? firstBrace
              : Math.min(firstBrace, firstBracket);
  s = start !== -1 ? s.slice(start) : s;

  const quoteCount = (s.match(/(?<!\\)"/g) || []).length;
  if (quoteCount % 2 !== 0) s += '"';

  const opens  = { '{': 0, '[': 0 };
  const closes: Record<string, '{' | '['> = { '}': '{', ']': '[' };
  let inString = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '"' && (i === 0 || s[i - 1] !== '\\')) { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{' || c === '[') opens[c]++;
    if (c === '}' || c === ']') opens[closes[c]]--;
  }

  s = s.replace(/,\s*$/, '');

  for (let i = 0; i < opens['[']; i++) s += ']';
  for (let i = 0; i < opens['{']; i++) s += '}';

  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// ============ UNIFIED MESSAGE ANALYSIS ============

async function _llamaAnalyzeMessage(
  message: string,
  context: string[] = [],
  _currentDate: string = new Date().toISOString(),
  existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string; event_time: number | null; location: string | null; description: string | null; sender_name?: string | null }> = [],
  messageTimestamp?: number
): Promise<LLMExtraction> {
  const contextBlock = context.length > 0
    ? `\nPrevious messages in this chat (for context):\n${context.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n`
    : '';

  const existingEventsBlock = existingEvents.length > 0
    ? `\nUser's EXISTING events/reminders (they may refer to these):\n${compressEventsLight(existingEvents)}\n`
    : '';

  const prompt = `Analyze this WhatsApp message. First decide if it contains any real event/task/reminder. If yes, extract them. If no, return empty events array.

IMPORTANT: If the message refers to or UPDATES an existing event (listed below), set "event_action" and "target_event_id" instead of creating a duplicate.

${formatDateContext(messageTimestamp)}
${contextBlock}${existingEventsBlock}
Message to analyze:
"${message}"

Return JSON with this exact schema:
{
  "events": [
    {
      "type": "meeting" | "deadline" | "reminder" | "travel" | "task" | "subscription" | "recommendation" | "other",
      "title": "short title",
      "description": "full details or null",
      "event_time": "ISO datetime or null",
      "location": "place name (goa, mumbai) or service name (netflix, hotstar, amazon)",
      "participants": ["names mentioned"],
      "keywords": ["searchable", "keywords", "include place names and service names"],
      "confidence": 0.0 to 1.0,
      "event_action": "create" | "update" | "merge" | null,
      "target_event_id": null or ID number of the existing event being updated
    }
  ]
}

EVENT ACTION RULES:
- "create" (default): This is a NEW event, not related to any existing event
- "update": This message UPDATES an existing event (changes time, location, title, details, etc.)
  - Set target_event_id to the ID of the event being updated
  - Only set the fields that are CHANGING (leave others as null)
  - Example: "change dinner to Friday 9pm" → event_action="update", target_event_id=<dinner event ID>, event_time=Friday 9pm
  - Example: "move the meeting to conference room B" → event_action="update", target_event_id=<meeting ID>, location="conference room B"
  - Example: "add Rahul to dinner" → event_action="update", target_event_id=<dinner ID>, participants=["Rahul"]
- "merge": This message adds info to an existing event (same event, new details)
  - Example: "also bring chips for the dinner" → event_action="merge", target_event_id=<dinner ID>

CRITICAL: Only set event_action="update" or "merge" when the message CLEARLY references an existing event.
If uncertain, treat as "create" — false creates are better than wrong updates.

Rules:
- Understand informal/broken English and Hinglish (Hindi+English mix)
- Handle typos: "cancle" = "cancel", "tomoro" = "tomorrow", "goa" = "goa"
- "kal" = tomorrow, "aaj" = today, "parso" = day after tomorrow
- "this week" = within 7 days, use end of week as event_time
- Extract times like "5pm", "shaam ko" (evening), "subah" (morning)
- Time-of-day defaults: "subah" = 9:00 AM, "dopahar" = 1:00 PM, "shaam ko" = 6:00 PM, "raat ko" = 9:00 PM
- When a day name is mentioned without a specific time, default to 10:00 AM

ABSOLUTE DATE RESOLUTION RULES (CRITICAL — READ CAREFULLY):
- Use the pre-resolved dates from the DATE/TIME CONTEXT section above — do NOT calculate dates yourself
- "Thursday" = the NEXT Thursday shown in the look-up table, NOT a past Thursday
- If two messages in the SAME conversation say "Thursday 8pm" and "Thursday 8:30pm" → they mean the SAME Thursday, just different times
- event_time MUST be in the FUTURE (after the "Message sent at" time) unless the message explicitly uses past tense
- If your resolved date falls BEFORE "Message sent at", add 7 days to get the next occurrence
- NEVER guess or fabricate dates — if no time reference exists, event_time MUST be null

CRITICAL DATE/TIME RULE:
- ONLY set event_time if the message EXPLICITLY mentions a date, time, or relative time reference
- "meeting tomorrow at 5pm" → event_time = tomorrow 5pm ✅
- "cancel netflix this month" → event_time = end of this month ✅
- "kal 10 baje" → event_time = tomorrow 10am ✅
- "You should try cashews from Zantye's in Goa" → event_time = null ❌ (NO date mentioned!)
- "I need to cancel Amazon Prime" → event_time = null ❌ (NO specific date!)
- "Rahul recommended this restaurant" → event_time = null ❌ (just a recommendation)
- Do NOT fabricate or guess dates. If no time reference exists, event_time MUST be null.

- For SUBSCRIPTIONS (Netflix, Hotstar, Amazon Prime, gym, domain, hosting):
  - type = "subscription"
  - location = JUST the service name (netflix, hotstar, amazon) - NOT full domain!
  - keywords = include the service name
  - title = action to take (Cancel Netflix, Renew Hotstar, etc)

- For TRAVEL/RECOMMENDATIONS (trips, places, things to buy/do):
  - type = "travel" or "recommendation"
  - location = place name (goa, mumbai, delhi)
  - keywords = include the place name and any products/shops mentioned
  - Example: "Rahul recommended cashews at Zantye's in Goa" → type=recommendation, location=goa, keywords=[goa, cashews, zantyes, rahul]

- For GIFTS / SHOPPING INTENT (buying something for someone):
  - type = "recommendation"
  - If the conversation mentions a PRODUCT CATEGORY (makeup, sneakers, perfume, clothes, electronics, etc.) and a PERSON (sister, mom, friend name, girlfriend, etc.), extract it
  - keywords MUST include the product category AND shopping site hints for URL-based triggering
  - If the recipient is female (sister, mom, girlfriend, bhabhi, didi, wife, "uske liye") → add "beauty", "makeup", "nykaa", "myntra" to keywords
  - If the recipient is male (brother, dad, boyfriend, bhai) → add "electronics", "gadgets", "amazon", "flipkart" to keywords
  - If gender is unknown or product is general → add "amazon", "flipkart", "myntra" to keywords
  - location = null (no specific place — this is URL-triggered, NOT location-based)
  - event_time = null unless a specific date like "birthday next month" or "anniversary on 15th" is mentioned
  - participants = include the recipient's name or relationship
  - confidence = 0.8+ for clear gift/shopping intent
  - Examples:
    - "Need to get makeup for sis birthday" → type=recommendation, title="Gift for sister - makeup", keywords=[makeup, beauty, gift, birthday, sister, nykaa, myntra], participants=["sister"], event_time=null, confidence=0.85
    - "Priya loves those Nike shoes" → type=recommendation, title="Gift idea - Nike shoes for Priya", keywords=[nike, shoes, sneakers, gift, priya, myntra, amazon], participants=["Priya"], event_time=null, confidence=0.8
    - "Get something nice for mom" → type=recommendation, title="Gift for Mom", keywords=[gift, mom, mother, beauty, nykaa, myntra, amazon], participants=["mom"], event_time=null, confidence=0.8
    - "bhai ko kuch lena hai birthday pe" → type=recommendation, title="Birthday gift for brother", keywords=[gift, birthday, brother, electronics, amazon, flipkart], participants=["brother"], event_time=null, confidence=0.8
    - "need to buy lipstick" → type=recommendation, title="Buy lipstick", keywords=[lipstick, makeup, beauty, nykaa, myntra, gift], event_time=null, confidence=0.8

- For MEETINGS and INFORMAL COMMITMENTS:
  - IMPORTANT: Questions like "Can we meet at 5pm?" or "Dinner Thursday?" ARE events!
  - Informal commitments like "I'll be there Thursday" or "See you at dinner" ARE events
  - "Let's do Thursday dinner" = meeting, event_time = this Thursday evening
  - "Can we have a meeting on 15th at 10:30?" = meeting, extract the date/time
  - Group chat commitments ("I'll join", "count me in", "I'm coming") = meeting events

- Intent phrases like "want to", "need to", "have to", "should" indicate tasks
- If no event/task found, return: {"events": []}
- Keywords should include: location names, service names, product names, people names, group names
- Confidence < 0.5 if uncertain

SPAM/PROMOTION FILTER (VERY IMPORTANT):
- Messages like "Get X at just ₹199" or "X Pro at 50% off" are PROMOTIONS, not user intent
- Forwarded deal messages, brand/business account messages = promotional (confidence < 0.3)
- "I want to get canva pro" = genuine intent (confidence 0.8+)
- "Get Canva Pro at just ₹200" = promotional spam (confidence 0.2)
- "Bro try the cashews at Zantyes" from a friend = genuine recommendation (confidence 0.9)
- "Best cashews! Order now at 40% off!" = spam (confidence 0.1)
- Price mentions like "at just 99", "only ₹199", "50% off" are strong spam signals
- If uncertain whether genuine or spam, set confidence < 0.4

NOISE FILTER — DO NOT EXTRACT these as events (return empty events array):
- Developer/work chat about code: "Create problems 104 in PC", "fix the API", "push the code", "deploy to staging", "debug the issue", "check the endpoint", "play with APIs"
- Vague "I will" statements without specific time/place: "I will start robotics man", "will do it", "I'll check", "I'll send", "will see"
- Status updates / progress reports: "I can complete in 10%", "almost done", "working on it", "in progress", "done with the first part"
- Past-tense completion reports: "got doc for everflow at 4am", "already sent it", "done bhai", "finished the report"
- Casual work conversation: "share design", "review the spacing", "check after dev", "upgrade vibe coding game"
- Meta-comments about tasks: "need to focus on this", "let me handle it", "I got this"
- Generic social chat: "how are you", "what's up", "good morning", "haha", "lol", "ok", "nice"
- Short ambiguous fragments: messages under 5 words without a clear event/task signal

ONLY extract events that have CLEAR, SPECIFIC, ACTIONABLE intent:
- ✅ "Cancel my Netflix subscription" — clear action + specific service
- ✅ "Bro try cashews at Zantyes in Goa" — specific recommendation with place
- ✅ "Meeting tomorrow at 5pm" — specific event with time
- ✅ "Dinner Thursday at 8" — specific commitment with day/time
- ✅ "Need to pay rent by 15th" — clear deadline
- ✅ "Need makeup for sis birthday" — gift intent with recipient + product category
- ✅ "Priya loved those Nike shoes" — gift idea, specific product + person
- ✅ "bhai ko kuch lena hai" — shopping intent in Hinglish
- ❌ "I will start robotics man" — vague, no time, no specifics
- ❌ "Complete restosmem broo" — dev chat / status update
- ❌ "Send payment via UPI" — vague, no amount/to whom/when
- ❌ "Create problems 104 in PC" — coding/dev task, not a life event
- ❌ "Upgrade vibe coding game" — casual chat, not actionable
- ❌ "Share design" — work chat, not a schedulable event`;

  const response = await callLlama([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  try {
    const parsed = JSON.parse(response);
    return {
      events: parsed.events || [],
    };
  } catch {
    const repaired = repairJSON(response, 'events');
    if (repaired && repaired.events) {
      console.warn('⚠️ Repaired truncated Llama JSON — recovered', repaired.events.length, 'event(s)');
      return { events: repaired.events };
    }
    console.error('Failed to parse Llama response:', response);
    return { events: [] };
  }
}

/** Public wrapper — applies 3-tier fallback logic around Llama analyzeMessage. */
export async function analyzeMessage(
  message: string,
  context: string[] = [],
  _currentDate: string = new Date().toISOString(),
  existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string; event_time: number | null; location: string | null; description: string | null; sender_name?: string | null }> = [],
  messageTimestamp?: number
): Promise<LLMExtraction> {
  const cacheKey = message.slice(0, 300);
  return withFallback(
    async () => {
      const result = await _llamaAnalyzeMessage(message, context, _currentDate, existingEvents, messageTimestamp);
      cacheSet('analyzeMessage', cacheKey, result);
      return result;
    },
    () => Promise.resolve(heuristicAnalyze(message, context, existingEvents, messageTimestamp)),
    () => Promise.resolve(cacheGet<LLMExtraction>('analyzeMessage', cacheKey) ?? { events: [] })
  );
}

// extractEvents is an alias for analyzeMessage (backwards compat with batch import)
export const extractEvents = analyzeMessage;

// ============ ACTION DETECTION ============

export interface ActionResult {
  isAction: boolean;
  action: 'cancel' | 'complete' | 'postpone' | 'snooze' | 'ignore' | 'delete' | 'modify' | 'none';
  targetKeywords: string[];
  targetDescription: string;
  snoozeMinutes?: number;
  newTime?: string;
  newTitle?: string;
  newLocation?: string;
  newDescription?: string;
  confidence: number;
}

async function _llamaDetectAction(
  message: string,
  context: string[] = [],
  existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string }> = [],
  messageTimestamp?: number
): Promise<ActionResult> {
  const eventsBlock = existingEvents.length > 0
    ? `\nUser's existing events/reminders:\n${existingEvents.map((e, i) => `[${i}] #${e.id}|${e.event_type}|"${e.title}"|kw:${e.keywords}`).join('\n')}\n`
    : '';

  const contextBlock = context.length > 0
    ? `\nRecent chat messages:\n${context.map((m, i) => `${i + 1}. "${m}"`).join('\n')}\n`
    : '';

  const prompt = `Analyze this WhatsApp message. Is the user trying to PERFORM AN ACTION on a previously stored event/reminder/task? Or is this a NEW event?

${formatDateContext(messageTimestamp)}
${contextBlock}${eventsBlock}
Message: "${message}"

Return JSON:
{
  "isAction": true/false,
  "action": "cancel" | "complete" | "postpone" | "snooze" | "ignore" | "delete" | "modify" | "none",
  "targetKeywords": ["keywords", "to", "find", "target", "event"],
  "targetDescription": "what the user is referring to",
  "snoozeMinutes": null or number (for postpone: 30, 60, 1440 for tomorrow, 10080 for next week),
  "newTime": null or "ISO datetime" (for reschedule),
  "newTitle": null or "new title" (for title change),
  "newLocation": null or "new location" (for location change),
  "newDescription": null or "new description" (for description change),
  "confidence": 0.0 to 1.0
}

RULES - Detect these as ACTIONS (isAction=true):
- "cancel it" / "cancel the meeting" / "cancel netflix reminder" → action=cancel
- "done" / "already done" / "ho gaya" / "kar liya" / "completed" → action=complete
- "not now" / "later" / "baad mein" / "remind me later" → action=snooze, snoozeMinutes=30
- "remind me tomorrow" / "kal yaad dilana" → action=postpone, snoozeMinutes=1440
- "remind me next week" → action=postpone, snoozeMinutes=10080
- "don't remind me" / "mat yaad dilao" / "stop reminding" / "never show" → action=ignore
- "delete it" / "remove it" / "hata do" → action=delete
- "don't bring it up" / "I don't care" / "not interested" / "nahi chahiye" → action=ignore
- "I already cancelled it" / "already unsubscribed" → action=complete
- "change to 5pm" / "move to Friday" / "reschedule" → action=modify, newTime=...
- "change location to office" / "venue changed to cafe" → action=modify, newLocation=...
- "rename it to team standup" / "actually it's a lunch not dinner" → action=modify, newTitle=...
- "add more details: bring laptop" / "update: also need to discuss budget" → action=modify, newDescription=...
- "postpone" / "push it" / "aage karo" → action=postpone, snoozeMinutes=1440
- "skip it" / "chhod do" / "leave it" → action=ignore

CRITICAL: If it matches an existing event from the list, use that event's keywords in targetKeywords.
For MODIFY actions: set the specific new* field (newTime, newTitle, newLocation, newDescription) with the updated value.
If it's a new event/task/recommendation (NOT an action), return: {"isAction": false, "action": "none", "targetKeywords": [], "targetDescription": "", "confidence": 0}`;

  const response = await callLlama([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  try {
    const parsed = JSON.parse(response);
    return {
      isAction: parsed.isAction || false,
      action: parsed.action || 'none',
      targetKeywords: parsed.targetKeywords || [],
      targetDescription: parsed.targetDescription || '',
      snoozeMinutes: parsed.snoozeMinutes || undefined,
      newTime: parsed.newTime || undefined,
      newTitle: parsed.newTitle || undefined,
      newLocation: parsed.newLocation || undefined,
      newDescription: parsed.newDescription || undefined,
      confidence: parsed.confidence || 0,
    };
  } catch {
    const repaired = repairJSON(response, 'isAction');
    if (repaired && repaired.action) {
      console.warn('⚠️ Repaired truncated action JSON');
      return {
        isAction: repaired.isAction || false,
        action: repaired.action || 'none',
        targetKeywords: repaired.targetKeywords || [],
        targetDescription: repaired.targetDescription || '',
        snoozeMinutes: repaired.snoozeMinutes || undefined,
        newTime: repaired.newTime || undefined,
        newTitle: repaired.newTitle || undefined,
        newLocation: repaired.newLocation || undefined,
        newDescription: repaired.newDescription || undefined,
        confidence: repaired.confidence || 0,
      };
    }
    console.error('Failed to parse action detection response:', response);
    return { isAction: false, action: 'none', targetKeywords: [], targetDescription: '', confidence: 0 };
  }
}

/** Public wrapper — applies 3-tier fallback logic around Llama detectAction. */
export async function detectAction(
  message: string,
  context: string[] = [],
  existingEvents: Array<{ id: number; title: string; event_type: string; keywords: string }> = [],
  messageTimestamp?: number
): Promise<ActionResult> {
  const safeDefault: ActionResult = { isAction: false, action: 'none', targetKeywords: [], targetDescription: '', confidence: 0 };
  const cacheKey = message.slice(0, 300);
  return withFallback(
    async () => {
      const result = await _llamaDetectAction(message, context, existingEvents, messageTimestamp);
      cacheSet('detectAction', cacheKey, result);
      return result;
    },
    () => Promise.resolve(heuristicDetectAction(message, context, existingEvents)),
    () => Promise.resolve(cacheGet<ActionResult>('detectAction', cacheKey) ?? safeDefault)
  );
}

// ============ AI CHAT WITH EVENTS CONTEXT ============

export interface ChatResponse {
  response: string;
  relevantEventIds: number[];
}

async function _llamaChatWithContext(
  query: string,
  events: Array<{ id: number; title: string; description: string | null; event_type: string; event_time: number | null; location: string | null; status: string; keywords: string; sender_name?: string | null; context_url?: string | null }>,
  history: Array<{ role: string; content: string }> = []
): Promise<ChatResponse> {
  const dateContext = formatDateContext();

  const compressed = compressEventsForPrompt(events as any);
  const eventsBlock = compressed.events;
  console.log(`📦 [QS] Chat context: ${events.length} events → ${compressed.eventCount} selected (${compressed.compressionRatio.toFixed(1)}x compression, ~${compressed.tokenEstimate} tokens)`);

  const { recentHistory, memoryPacket } = compressChatHistory(history);
  const historyBlock = recentHistory.length > 0
    ? recentHistory.map(h => `${h.role === 'user' ? 'User' : 'Argus'}: ${h.content}`).join('\n')
    : '';

  const prompt = `You are Argus AI, a helpful and conversational memory assistant. You have access to the user's saved events, tasks, reminders and recommendations from their WhatsApp conversations.

${dateContext}
${memoryPacket ? `\n=== PRIOR CONTEXT (compressed) ===\n${memoryPacket}\n` : ''}
=== USER'S EVENTS/TASKS (compressed format: #ID|TYPE|STATUS|"Title"|time|location|sender|keywords) ===
${eventsBlock}

${historyBlock ? `=== RECENT CONVERSATION ===\n${historyBlock}\n` : ''}
User's question: "${query}"

INSTRUCTIONS:
- Answer naturally and conversationally, like a smart personal assistant
- Reference specific events by name, date, sender when relevant
- If user asks "what do I have today/this week", filter events by date — ONLY show FUTURE events
- Events marked [PAST] have already occurred — mention this if the user asks about them
- When displaying dates, always include the day of week (e.g., "Thursday, Feb 12 at 8 PM")
- If user asks about recommendations or gifts, search through event descriptions and types
- If user asks about a specific person (e.g., "what did Rahul say?"), filter by sender_name
- If user asks about subscriptions, filter by event_type = "subscription"
- If no relevant events found, say so honestly and offer to help with something else
- Keep responses concise but informative (2-5 sentences usually)
- Use emoji sparingly for readability
- If the user wants to take an action (mark done, delete, snooze), tell them they can use the buttons on the event cards below, or say it in WhatsApp chat
- Return the IDs of events you reference in your response

Return JSON:
{
  "response": "your conversational response text",
  "relevantEventIds": [1, 5, 12]
}`;

  // Build messages array with conversation history
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
    { role: 'system', content: SYSTEM_PROMPT },
  ];

  // Inject last 10 turns of conversation history
  for (const h of recentHistory.slice(-10)) {
    messages.push({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: h.content,
    });
  }

  messages.push({ role: 'user', content: prompt });

  const response = await callLlama(messages);

  try {
    const parsed = JSON.parse(response);
    return {
      response: parsed.response || 'I could not process that. Try asking differently.',
      relevantEventIds: parsed.relevantEventIds || [],
    };
  } catch {
    const repaired = repairJSON(response, 'response');
    if (repaired && repaired.response) {
      console.warn('⚠️ Repaired truncated chat JSON');
      return { response: repaired.response, relevantEventIds: repaired.relevantEventIds || [] };
    }
    console.error('Failed to parse chat response:', response);
    return {
      response: response || 'Sorry, something went wrong.',
      relevantEventIds: [],
    };
  }
}

/** Public wrapper — applies 3-tier fallback logic around Llama chatWithContext. */
export async function chatWithContext(
  query: string,
  events: Array<{ id: number; title: string; description: string | null; event_type: string; event_time: number | null; location: string | null; status: string; keywords: string; sender_name?: string | null; context_url?: string | null }>,
  history: Array<{ role: string; content: string }> = []
): Promise<ChatResponse> {
  const cacheKey = `${query.slice(0, 200)}|${events.map(e => e.id).join(',')}`;
  const safeDefault: ChatResponse = {
    response: "I'm having trouble connecting. Ask again in a bit! 🔄",
    relevantEventIds: [],
  };
  return withFallback(
    async () => {
      const result = await _llamaChatWithContext(query, events, history);
      cacheSet('chatWithContext', cacheKey, result);
      return result;
    },
    () => Promise.resolve(heuristicChat(query, events, history)),
    () => Promise.resolve(cacheGet<ChatResponse>('chatWithContext', cacheKey) ?? safeDefault)
  );
}

// ============ RE-RANK EVENTS (LLM-based relevance ranking) ============

export async function reRankEvents(
  query: string,
  candidates: any[],
  topK = 5,
): Promise<any[]> {
  if (candidates.length === 0) return [];
  if (candidates.length <= topK) return candidates;
  if (!llmClient) return candidates.slice(0, topK);

  try {
    const completion = await llmClient.chat.completions.create({
      model: MODEL,
      messages: [
        {
          role: 'system',
          content: `You are a relevance ranking engine. Given a user context query and a list of candidate events from the user's WhatsApp memory, return the IDs of the most relevant events in order of relevance (most relevant first). Return ONLY a JSON object with an "ids" array of event ID strings. Example: {"ids":["3","1","7"]}. Return at most ${topK} IDs. Only include events that are genuinely relevant.`,
        },
        {
          role: 'user',
          content: `Query: "${query}"\n\nCandidates:\n${candidates
            .map(e => `ID:${e.id} | ${e.title} | ${e.keywords || ''} | ${e.description || ''}`)
            .join('\n')}`,
        },
      ],
      temperature: 0.0,
      response_format: { type: 'json_object' },
    });

    const raw = completion.choices[0]?.message?.content ?? '{"ids":[]}';
    const parsed = JSON.parse(raw);
    const rankedIds: string[] = Array.isArray(parsed) ? parsed : (parsed.ids ?? []);

    const idToEvent = new Map(candidates.map(e => [String(e.id), e]));
    return rankedIds
      .map(id => idToEvent.get(id))
      .filter((e): e is any => e !== undefined)
      .slice(0, topK);
  } catch {
    return candidates.slice(0, topK);
  }
}

// ============ VALIDATE RELEVANCE (used by matcher.ts) ============

async function _llamaValidateRelevance(
  url: string,
  title: string,
  candidates: Event[]
): Promise<LLMValidation> {
  if (candidates.length === 0) {
    return { relevant: [], confidence: 0 };
  }

  const prompt = `User is browsing this webpage. Determine which saved events are relevant RIGHT NOW.

Current URL: ${url}
Page Title: ${title}

Candidate events from user's WhatsApp history:
${candidates.map((e, i) => `[${i}] ${e.title}: ${e.description || 'no description'} (location: ${e.location || 'none'}, keywords: ${e.keywords}, sender: ${(e as any).sender_name || 'unknown'})`).join('\n')}

Return JSON with:
{
  "relevant": [0, 2, 5],  // indices of relevant events
  "confidence": 0.85      // overall confidence 0-1
}

Rules:
- Only mark events that user would find USEFUL to be reminded about NOW
- Travel booking site + travel/recommendation event = relevant
- Shopping site + gift/purchase mention = relevant
- Subscription site + subscription cancellation = relevant
- Be conservative - fewer false positives is better
- If nothing relevant, return: {"relevant": [], "confidence": 0}`;

  const response = await callLlama([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: prompt },
  ]);

  try {
    const parsed = JSON.parse(response);
    return {
      relevant: parsed.relevant || [],
      confidence: parsed.confidence || 0,
    };
  } catch {
    const repaired = repairJSON(response, 'relevant');
    if (repaired && repaired.relevant) {
      console.warn('⚠️ Repaired truncated validation JSON');
      return { relevant: repaired.relevant, confidence: repaired.confidence || 0 };
    }
    console.error('Failed to parse validation response:', response);
    return { relevant: [], confidence: 0 };
  }
}

/** Public wrapper — applies 3-tier fallback logic around Llama validateRelevance. */
export async function validateRelevance(
  url: string,
  title: string,
  candidates: Event[]
): Promise<LLMValidation> {
  if (candidates.length === 0) return { relevant: [], confidence: 0 };
  const cacheKey = `${url}|${candidates.map(c => c.id).join(',')}`;
  return withFallback(
    async () => {
      const result = await _llamaValidateRelevance(url, title, candidates);
      cacheSet('validateRelevance', cacheKey, result);
      return result;
    },
    () => Promise.resolve(heuristicValidateRelevance(url, title, candidates)),
    () => Promise.resolve(cacheGet<LLMValidation>('validateRelevance', cacheKey) ?? { relevant: [], confidence: 0 })
  );
}

// ============ TRIVIAL PRE-FILTER ============
export function shouldSkipMessage(message: string): boolean {
  const trimmed = message.trim();
  if (trimmed.length < 3) return true;
  if (/^[\p{Emoji}\s]+$/u.test(trimmed)) return true;
  const trivial = /^(ok|okay|k|lol|haha|hahaha|ha|hmm|hmmm|yes|no|yep|nope|sure|yeah|yea|nah|👍|👌|❤️|🙏|😂|nice|cool|good|thanks|thx|ty|gm|gn|good morning|good night|hi|hello|hey|bye|see ya|ttyl|brb|omg|wtf|lmao|rofl|ikr)$/i;
  if (trivial.test(trimmed)) return true;
  return false;
}

// ============ POPUP BLUEPRINT GENERATOR ============

export interface PopupButton {
  text: string;
  action: string;
  style: 'primary' | 'success' | 'secondary' | 'outline';
}

export interface PopupBlueprint {
  icon: string;
  headerClass: string;
  title: string;
  subtitle: string;
  body: string;
  question: string | null;
  buttons: PopupButton[];
  popupType: string;
}

async function _llamaGeneratePopupBlueprint(
  event: { title: string; description?: string | null; event_type?: string; location?: string | null; sender_name?: string | null; keywords?: string; event_time?: number | null },
  triggerContext: { url?: string; pageTitle?: string; conflictingEvents?: Array<{ title: string; event_time?: number | null }> },
  popupType: string
): Promise<PopupBlueprint> {
  const conflictBlock = triggerContext.conflictingEvents && triggerContext.conflictingEvents.length > 0
    ? `\nConflicting events: ${triggerContext.conflictingEvents.map(e => {
        let t = `"${e.title}"`;
        if (e.event_time) t += ` at ${new Date(e.event_time * 1000).toLocaleString()}`;
        return t;
      }).join(', ')}`
    : '';

  const prompt = `Generate a COMPLETE popup specification for Argus memory assistant. The Chrome extension will render EXACTLY what you return — no hardcoded logic on the client.

Event: "${event.title}"
Description: "${event.description || ''}"
Type: ${event.event_type || 'other'}
Location: ${event.location || 'none'}
Original sender: ${event.sender_name || 'unknown'}
Keywords: ${event.keywords || ''}
Event time: ${event.event_time ? new Date(event.event_time * 1000).toLocaleString() : 'none'}
Popup type: ${popupType}
Current URL: ${triggerContext.url || 'none'}
Page title: ${triggerContext.pageTitle || 'none'}${conflictBlock}

Return JSON:
{
  "icon": "single emoji for the popup header",
  "headerClass": "discovery" | "reminder" | "context" | "conflict" | "insight",
  "title": "short header (max 6 words)",
  "subtitle": "one-line context (who mentioned, when)",
  "body": "the main message to show user. ALWAYS start with '[SenderName] mentioned: ...' if sender is known (not 'unknown'). Natural, conversational, specific. Max 2 sentences.",
  "question": "what should user do? (1 sentence question) or null if not needed",
  "buttons": [
    {"text": "emoji + label", "action": "action-name", "style": "primary|success|secondary|outline"},
    ...
  ],
  "popupType": "${popupType}"
}

BUTTON ACTIONS (use these exact action names):
- "set-reminder" — schedule a reminder for later
- "done" / "complete" — mark event as done
- "snooze" — remind in 30 min
- "ignore" — never remind again
- "acknowledge" — got it, dismiss
- "dismiss-temp" — not now, remind later on this site
- "dismiss-permanent" — never show on this site again
- "view-day" — show the user's day schedule
- "delete" — delete event entirely

BUTTON STYLES: "primary" (purple gradient), "success" (green), "secondary" (gray), "outline" (border only)

RULES BY POPUP TYPE:
- event_discovery: User just sent a message with an event. Show what was found, let them set reminder or dismiss. 2-3 buttons.
- event_reminder: Time-based trigger fired (24h/1h/15m before event). Urgent tone. 2-3 buttons.
- context_reminder: User is on a website matching a saved event (e.g., netflix.com + cancel netflix). Persistent. 3 buttons.
- conflict_warning: New event overlaps with existing ones. Show conflict details. 3 buttons including "View My Day".
- insight_card: General suggestion/recommendation. Friendly tone. 2 buttons.
- snooze_reminder: Snoozed event is back. 2-3 buttons.

SPECIAL RULE — GIFT/SHOPPING CONTEXT REMINDERS:
If the event type is "recommendation" AND the user is on a SHOPPING site (nykaa, myntra, amazon, flipkart, ajio, etc.):
- ALWAYS mention that there's a SALE going on right now on the site (we show this to add urgency)
- Include WHO mentioned the product/gift and WHAT they wanted
- Use the format: "There's a sale going on [site]! [Person] mentioned they wanted [product]. Perfect time to grab it!"
- This ONLY applies to gift/recommendation/shopping events — NOT to subscription events like Netflix

EXAMPLES:
- Gift/shopping context (IMPORTANT — follow this pattern for all gift/recommendation events on shopping sites):
  {"icon": "🛍️", "headerClass": "insight", "title": "Sale Alert! 🎉", "subtitle": "From your chat with Priya", "body": "There's a sale going on Nykaa right now! Priya mentioned she wanted that lipstick. Perfect time to grab it as a gift!", "question": "Want to check it out?", "buttons": [{"text": "🛒 Browse Now", "action": "acknowledge", "style": "primary"}, {"text": "💤 Not Now", "action": "dismiss-temp", "style": "secondary"}, {"text": "🚫 Not Interested", "action": "dismiss-permanent", "style": "outline"}], "popupType": "context_reminder"}
- Recommendation context: {"icon": "💡", "headerClass": "context", "title": "Remember This?", "subtitle": "From your chat with Rahul", "body": "Rahul recommended cashews at Zantye's shop in Goa. You're browsing travel sites right now!", "question": "Want to save the location?", "buttons": [{"text": "📍 Save Location", "action": "done", "style": "success"}, {"text": "💤 Not Now", "action": "dismiss-temp", "style": "secondary"}, {"text": "🚫 Not Interested", "action": "dismiss-permanent", "style": "outline"}], "popupType": "context_reminder"}
- Subscription: {"icon": "💳", "headerClass": "context", "title": "Subscription Alert!", "subtitle": "From your notes", "body": "You planned to cancel Netflix. You're on Netflix right now.", "question": "Ready to cancel?", "buttons": [{"text": "✅ Already Done", "action": "done", "style": "success"}, {"text": "💤 Remind Later", "action": "dismiss-temp", "style": "secondary"}, {"text": "🚫 Stop Reminding", "action": "dismiss-permanent", "style": "outline"}], "popupType": "context_reminder"}
- Conflict: {"icon": "🗓️", "headerClass": "conflict", "title": "Double-Booked?", "subtitle": "Let's sort your schedule", "body": "You told the dinner group you'd join Thursday, but this new meeting overlaps.", "question": "Want to see your full day?", "buttons": [{"text": "📅 View My Day", "action": "view-day", "style": "primary"}, {"text": "✅ Keep Both", "action": "acknowledge", "style": "secondary"}, {"text": "🚫 Skip This One", "action": "ignore", "style": "outline"}], "popupType": "conflict_warning"}

Be SPECIFIC — use actual names, places, services from the event. Never be generic.`;

  try {
    const response = await callLlama([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt },
    ]);
    const parsed = JSON.parse(response);
    return {
      icon: parsed.icon || '📅',
      headerClass: parsed.headerClass || 'discovery',
      title: parsed.title || event.title,
      subtitle: parsed.subtitle || `From ${event.sender_name || 'your messages'}`,
      body: parsed.body || (event.sender_name ? `${event.sender_name} mentioned: ${event.description || event.title}` : event.description || event.title),
      question: parsed.question || null,
      buttons: parsed.buttons || [
        { text: '👍 Got It', action: 'acknowledge', style: 'primary' },
        { text: '🚫 Dismiss', action: 'ignore', style: 'outline' },
      ],
      popupType: parsed.popupType || popupType,
    };
  } catch {
    return getDefaultPopupBlueprint(event, popupType);
  }
}

/** Public wrapper — applies 3-tier fallback logic around Llama generatePopupBlueprint. */
export async function generatePopupBlueprint(
  event: { title: string; description?: string | null; event_type?: string; location?: string | null; sender_name?: string | null; keywords?: string; event_time?: number | null },
  triggerContext: { url?: string; pageTitle?: string; conflictingEvents?: Array<{ title: string; event_time?: number | null }> },
  popupType: string
): Promise<PopupBlueprint> {
  const cacheKey = `${event.title.slice(0, 100)}|${popupType}`;
  return withFallback(
    async () => {
      const result = await _llamaGeneratePopupBlueprint(event, triggerContext, popupType);
      cacheSet('generatePopupBlueprint', cacheKey, result);
      return result;
    },
    () => Promise.resolve(heuristicGeneratePopupBlueprint(event, triggerContext, popupType)),
    () => Promise.resolve(cacheGet<PopupBlueprint>('generatePopupBlueprint', cacheKey) ?? getDefaultPopupBlueprint(event, popupType))
  );
}

// Fallback when Llama fails — ensures popups always work.
export function getDefaultPopupBlueprint(
  event: { title: string; description?: string | null; event_type?: string; sender_name?: string | null },
  popupType: string
): PopupBlueprint {
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
          title: 'Sale Alert! 🎉',
          subtitle: sender ? `From your chat with ${sender}` : 'From your conversations',
          body: `There's a sale going on right now! ${sender ? sender + ' mentioned' : 'You noted'}: "${event.description || event.title}". Perfect time to check it out!`,
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
        question: 'You\'re browsing related content right now!',
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
