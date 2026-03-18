import { insertMessage, insertEvent, insertTrigger, getRecentMessages, upsertContact, checkEventConflicts, findActiveEventsByKeywords, getActiveEvents, ignoreEvent, completeEvent as dbCompleteEvent, snoozeEvent, deleteEvent, updateEvent, findDuplicateEvent, getEventById } from './db.js';
import { extractEvents, shouldSkipMessage, detectAction } from './gradient.js';
import type { Message, WhatsAppWebhook, TriggerType } from './types.js';

interface ConflictInfo {
  id: number;
  title: string;
  event_time: number | null;
}

interface CreatedEvent {
  id: number;
  event_type: string;
  title: string;
  description: string | null;
  event_time: number | null;
  location: string | null;
  participants: string;
  keywords: string;
  confidence: number;
  context_url?: string | null;
  sender_name?: string | null;
  conflicts?: ConflictInfo[];
}

interface ActionResult {
  action: string;
  targetEventId: number | null;
  targetEventTitle: string | null;
  message: string;
}

interface PendingAction {
  action: string;
  targetEventId: number;
  targetEventTitle: string;
  changes: Record<string, any>;
  description: string; // human-readable summary of what will change
}

interface IngestionResult {
  messageId: string;
  eventsCreated: number;
  triggersCreated: number;
  skipped: boolean;
  skipReason?: string;
  events?: CreatedEvent[];
  conflicts?: Array<{ eventId: number; conflictsWith: ConflictInfo[] }>;
  // Action results (for when user sends "cancel it", "done", etc.)
  actionPerformed?: ActionResult;
  // Pending confirmation (for modify actions — user must approve)
  pendingAction?: PendingAction;
}

export async function processWebhook(
  payload: WhatsAppWebhook,
  options: { processOwnMessages: boolean; skipGroupMessages: boolean }
): Promise<IngestionResult> {
  const { data } = payload;

  // Extract message content
  const content = data.message?.conversation || data.message?.extendedTextMessage?.text;
  if (!content) {
    return { messageId: data.key.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'no_content' };
  }

  // Check if from self
  if (data.key.fromMe && !options.processOwnMessages) {
    return { messageId: data.key.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'own_message' };
  }

  // Check if group
  const isGroup = data.key.remoteJid.includes('@g.us');
  if (isGroup && options.skipGroupMessages) {
    return { messageId: data.key.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'group_message' };
  }

  // Create message object
  const timestamp = typeof data.messageTimestamp === 'string'
    ? parseInt(data.messageTimestamp)
    : data.messageTimestamp;

  const senderName = data.pushName || null;

  const message: Message = {
    id: data.key.id,
    chat_id: data.key.remoteJid,
    sender: data.key.fromMe ? 'self' : data.key.remoteJid.split('@')[0],
    content,
    timestamp,
  };

  // Store message
  await insertMessage(message);

  // Update contact
  await upsertContact({
    id: message.sender,
    name: senderName,
    first_seen: timestamp,
    last_seen: timestamp,
    message_count: 1,
  });

  // Trivial pre-filter — skip pure noise (empty, emoji, "ok", "lol", etc.)
  // Everything else goes to the LLM — no more brittle keyword heuristics
  if (shouldSkipMessage(content)) {
    return { messageId: message.id, eventsCreated: 0, triggersCreated: 0, skipped: true, skipReason: 'trivial_message' };
  }

  // Get context from recent messages
  const recentMessages = await getRecentMessages(message.chat_id, 5);
  const context = recentMessages
    .filter(m => m.id !== message.id)
    .map(m => m.content);

  // ============ STEP 1: Check if this is an ACTION on existing event ============
  const activeEvents = await getActiveEvents(20);
  const actionResult = await detectAction(content, context, activeEvents.map(e => ({
    id: e.id!,
    title: e.title,
    event_type: e.event_type,
    keywords: e.keywords,
  })), timestamp);

  if (actionResult.isAction && actionResult.confidence >= 0.6 && actionResult.action !== 'none') {
    console.log(`🎯 [ACTION] Detected action: "${actionResult.action}" on "${actionResult.targetDescription}" (confidence: ${actionResult.confidence})`);

    // Find the target event
    let targetEvent = null;

    // Try to find by keywords
    if (actionResult.targetKeywords.length > 0) {
      const matches = await findActiveEventsByKeywords(actionResult.targetKeywords);
      if (matches.length > 0) {
        targetEvent = matches[0]; // Best match
      }
    }

    // Fallback: use most recent active event
    if (!targetEvent && activeEvents.length > 0) {
      targetEvent = activeEvents[0];
    }

    if (targetEvent && targetEvent.id) {
      const eventId = targetEvent.id;
      let actionMessage = '';

      switch (actionResult.action) {
        case 'cancel':
        case 'delete':
          await deleteEvent(eventId);
          actionMessage = `Deleted: "${targetEvent.title}"`;
          console.log(`🗑️ [ACTION] Deleted event #${eventId}: "${targetEvent.title}"`);
          break;

        case 'complete':
          await dbCompleteEvent(eventId);
          actionMessage = `Completed: "${targetEvent.title}"`;
          console.log(`✅ [ACTION] Completed event #${eventId}: "${targetEvent.title}"`);
          break;

        case 'ignore':
          await ignoreEvent(eventId);
          actionMessage = `Ignored: "${targetEvent.title}" - won't remind again`;
          console.log(`🚫 [ACTION] Ignored event #${eventId}: "${targetEvent.title}"`);
          break;

        case 'snooze':
        case 'postpone':
          const minutes = actionResult.snoozeMinutes || 30;
          await snoozeEvent(eventId, minutes);
          const durationText = minutes >= 10080 ? 'next week' : minutes >= 1440 ? 'tomorrow' : minutes >= 60 ? `${Math.round(minutes / 60)} hours` : `${minutes} minutes`;
          actionMessage = `Snoozed: "${targetEvent.title}" → will remind ${durationText}`;
          console.log(`💤 [ACTION] Snoozed event #${eventId} for ${minutes} min: "${targetEvent.title}"`);
          break;

        case 'modify': {
          // Build the proposed changes — but DON'T apply them yet.
          // Return as pendingAction so the user gets a confirmation popup.
          const proposedChanges: Record<string, any> = {};

          if (actionResult.newTime) {
            try {
              let parsedTime = Math.floor(new Date(actionResult.newTime).getTime() / 1000);
              if (!isNaN(parsedTime) && parsedTime > 0) {
                const nowUnix = Math.floor(Date.now() / 1000);
                if (parsedTime < nowUnix - 3600) {
                  const weekSec = 7 * 24 * 3600;
                  while (parsedTime < nowUnix) parsedTime += weekSec;
                  console.log(`⏩ [Date Fix] Action newTime was past, moved to ${new Date(parsedTime * 1000).toISOString()}`);
                }
                proposedChanges.event_time = parsedTime;
              } else {
                console.log(`⚠️ [ACTION] Invalid newTime from LLM: "${actionResult.newTime}" → NaN`);
              }
            } catch {
              // invalid time, skip
            }
          }
          if (actionResult.newTitle) proposedChanges.title = actionResult.newTitle;
          if (actionResult.newLocation) proposedChanges.location = actionResult.newLocation;
          if (actionResult.newDescription) proposedChanges.description = actionResult.newDescription;

          if (Object.keys(proposedChanges).length > 0) {
            // Build human-readable description of changes
            const parts: string[] = [];
            if (proposedChanges.title) parts.push(`title → "${proposedChanges.title}"`);
            if (proposedChanges.event_time) {
              const d = new Date(proposedChanges.event_time * 1000);
              const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
              parts.push(`time → ${dayNames[d.getDay()]}, ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`);
            }
            if (proposedChanges.location) parts.push(`location → "${proposedChanges.location}"`);
            if (proposedChanges.description) parts.push(`description updated`);
            const changeDesc = parts.join(', ');

            console.log(`📋 [ACTION] Modify proposed for event #${eventId} "${targetEvent.title}": ${changeDesc} — waiting for user confirmation`);

            return {
              messageId: message.id,
              eventsCreated: 0,
              triggersCreated: 0,
              skipped: false,
              pendingAction: {
                action: 'modify',
                targetEventId: eventId,
                targetEventTitle: targetEvent.title,
                changes: proposedChanges,
                description: changeDesc,
              },
            };
          }
          actionMessage = `Modify requested but no changes specified`;
          break;
        }

        default:
          actionMessage = `Unknown action: ${actionResult.action}`;
      }

      return {
        messageId: message.id,
        eventsCreated: 0,
        triggersCreated: 0,
        skipped: false,
        actionPerformed: {
          action: actionResult.action,
          targetEventId: eventId,
          targetEventTitle: targetEvent.title,
          message: actionMessage,
        },
      };
    }
  }

  // ============ STEP 2: Not an action → extract NEW events (or updates to existing) ============
  const result = await processMessage(message, context, senderName, activeEvents);

  return result;
}

export async function processMessage(
  message: Message,
  context: string[] = [],
  senderName: string | null = null,
  existingEvents: Array<{ id?: number; title: string; event_type: string; keywords: string; event_time: number | null; location: string | null; description: string | null; sender_name?: string | null }> = []
): Promise<IngestionResult> {
  let eventsCreated = 0;
  let triggersCreated = 0;
  const createdEvents: CreatedEvent[] = [];

  try {
    // Extract events using LLM — now with existing events context for CRUD
    const eventsForLLM = existingEvents.map(e => ({
      id: e.id!,
      title: e.title,
      event_type: e.event_type,
      keywords: e.keywords,
      event_time: e.event_time,
      location: e.location,
      description: e.description,
      sender_name: e.sender_name,
    }));
    const extraction = await extractEvents(message.content, context, new Date().toISOString(), eventsForLLM, message.timestamp);

    for (const event of extraction.events) {
      if (event.confidence < 0.65) {
        console.log(`⏭️ Skipping low-confidence event: "${event.title}" (${event.confidence})`);
        continue;
      }

      // ============ HANDLE EVENT UPDATES (CRUD) ============
      // If LLM says this is an update/merge to an existing event, perform the update
      const eventAction = (event as any).event_action || 'create';
      const targetEventId = (event as any).target_event_id;

      if ((eventAction === 'update' || eventAction === 'merge') && targetEventId) {
        // Verify the target event still exists AND is still active (not deleted/ignored/completed)
        const targetExists = await getEventById(targetEventId);
        const inactiveStatuses = ['deleted', 'ignored', 'completed'];
        if (!targetExists || inactiveStatuses.includes((targetExists as any).status)) {
          console.log(`⚠️ [CRUD] Target event #${targetEventId} no longer exists or has status "${(targetExists as any)?.status}" — creating new event instead.`);
          // Fall through to the normal create path below
        } else {
          console.log(`🔄 [CRUD] ${eventAction} on event #${targetEventId}: "${event.title}"`);

          const updateFields: Record<string, any> = {};
          if (eventAction === 'update') {
            // Only update fields that LLM explicitly set
            if (event.title) updateFields.title = event.title;
            if (event.description) updateFields.description = event.description;
            if (event.location) updateFields.location = event.location;
            if (event.event_time) {
              try {
                let parsedTime = Math.floor(new Date(event.event_time).getTime() / 1000);
                if (!isNaN(parsedTime) && parsedTime > 0) {
                  // Guard: push past dates forward
                  const nowUnix = Math.floor(Date.now() / 1000);
                  if (parsedTime < nowUnix - 3600) {
                    const weekSec = 7 * 24 * 3600;
                    while (parsedTime < nowUnix) parsedTime += weekSec;
                    console.log(`\u23e9 [Date Fix] CRUD update had past date, moved to ${new Date(parsedTime * 1000).toISOString()}`);
                  }
                  updateFields.event_time = parsedTime;
                }
              } catch { /* skip invalid time */ }
            }
            if (event.keywords && event.keywords.length > 0) updateFields.keywords = event.keywords.join(',');
            if (event.participants && event.participants.length > 0) updateFields.participants = JSON.stringify(event.participants);
          } else if (eventAction === 'merge') {
            // Merge: append to description
            if (event.description) {
              const existing = existingEvents.find(e => e.id === targetEventId);
              const existingDesc = existing?.description || '';
              updateFields.description = existingDesc ? `${existingDesc}. ${event.description}` : event.description;
            }
            if (event.participants && event.participants.length > 0) {
              const existing = existingEvents.find(e => e.id === targetEventId);
              try {
                const existingParticipants = JSON.parse(existing?.sender_name || '[]');
                const merged = [...new Set([...existingParticipants, ...event.participants])];
                updateFields.participants = JSON.stringify(merged);
              } catch {
                updateFields.participants = JSON.stringify(event.participants);
              }
            }
          }

          if (Object.keys(updateFields).length > 0) {
            const updated = await updateEvent(targetEventId, updateFields);
            if (updated) {
              const changedStr = Object.keys(updateFields).join(', ');
              console.log(`✅ [CRUD] Event #${targetEventId} updated: [${changedStr}]`);

              createdEvents.push({
                id: targetEventId,
                event_type: event.type,
                title: event.title,
                description: event.description,
                event_time: updateFields.event_time || null,
                location: event.location,
                participants: updateFields.participants || JSON.stringify(event.participants),
                keywords: event.keywords.join(','),
                confidence: event.confidence,
                context_url: null,
                sender_name: senderName,
              });
              eventsCreated++; // Count as an "event processed"
              continue; // Skip normal insert — we updated instead
            } else {
              console.log(`⚠️ [CRUD] updateEvent #${targetEventId} returned falsy — falling through to create new event`);
              // Fall through to normal insert below
            }
          } else {
            continue; // Nothing to update, skip silently
          }
        }
      }

      // Deduplication: skip if a similar event already exists in last 48 hours
      const isDuplicate = await findDuplicateEvent(event.title, 48);
      if (isDuplicate) {
        console.log(`⏭️ Skipping duplicate event: "${event.title}" (matches existing #${isDuplicate.id}: "${isDuplicate.title}")`);
        continue;
      }

      // Parse event time
      let eventTime: number | null = null;
      if (event.event_time) {
        try {
          eventTime = Math.floor(new Date(event.event_time).getTime() / 1000);
          if (isNaN(eventTime)) {
            console.log(`\u26a0\ufe0f [Date] Invalid event_time from LLM: "${event.event_time}" \u2192 NaN`);
            eventTime = null;
          } else {
            // Guard: if LLM returned a date in the past, push forward by weeks
            const nowUnix = Math.floor(Date.now() / 1000);
            if (eventTime < nowUnix - 3600) { // more than 1 hour in the past
              const weekSec = 7 * 24 * 3600;
              while (eventTime < nowUnix) eventTime += weekSec;
              console.log(`\u23e9 [Date Fix] LLM returned past date for "${event.title}", moved forward to ${new Date(eventTime * 1000).toISOString()}`);
            }
          }
        } catch {
          eventTime = null;
        }
      }

      // Determine context_url based on event type
      let contextUrl: string | null = null;

      // Known streaming/service keywords that should trigger context reminders
      const serviceKeywords = [
        'netflix', 'hotstar', 'amazon', 'prime', 'disney', 'spotify',
        'youtube', 'hulu', 'hbo', 'zee5', 'sonyliv', 'jiocinema',
        'canva', 'figma', 'notion', 'slack', 'zoom',
        'gym', 'domain', 'hosting', 'hostinger', 'aws', 'azure', 'vercel', 'heroku'
      ];

      // Build search text from all fields
      const searchText = `${event.location || ''} ${event.keywords.join(' ')} ${event.title} ${event.description || ''}`.toLowerCase();

      // Check for service keywords in ANY event type
      for (const service of serviceKeywords) {
        if (searchText.includes(service)) {
          contextUrl = service;
          console.log(`[Ingestion] Found context keyword "${service}" in event "${event.title}"`);
          break;
        }
      }

      // For travel: extract location keywords (goa, mumbai, delhi, etc.)
      if (event.type === 'travel' || event.type === 'recommendation') {
        const travelKeywords = [
          'goa', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata', 'hyderabad',
          'jaipur', 'udaipur', 'kerala', 'manali', 'shimla', 'ladakh', 'kashmir',
          'thailand', 'bali', 'singapore', 'dubai', 'maldives', 'europe'
        ];

        const travelSearchText = `${event.location || ''} ${event.keywords.join(' ')} ${event.title} ${event.description || ''}`.toLowerCase();

        for (const place of travelKeywords) {
          if (travelSearchText.includes(place)) {
            contextUrl = place;
            break;
          }
        }
      }

      // For gifts/shopping: map product categories to shopping site keywords
      // so that visiting nykaa/myntra/amazon triggers the reminder
      if (!contextUrl && event.type === 'recommendation') {
        const shoppingText = `${event.keywords.join(' ')} ${event.title} ${event.description || ''}`.toLowerCase();

        // Beauty/makeup → nykaa
        const beautyKeywords = ['makeup', 'beauty', 'cosmetic', 'skincare', 'lipstick', 'foundation', 'perfume', 'fragrance', 'nykaa'];
        const fashionKeywords = ['sneakers', 'shoes', 'clothes', 'dress', 'fashion', 'shirt', 'jeans', 'kurta', 'saree', 'myntra', 'nike', 'adidas', 'puma'];
        const giftKeywords = ['gift', 'birthday', 'anniversary', 'present'];

        const isBeauty = beautyKeywords.some(k => shoppingText.includes(k));
        const isFashion = fashionKeywords.some(k => shoppingText.includes(k));
        const isGift = giftKeywords.some(k => shoppingText.includes(k));

        if (isBeauty) {
          contextUrl = 'nykaa';
          console.log(`[Ingestion] Gift/beauty intent → context_url="nykaa" for "${event.title}"`);
        } else if (isFashion) {
          contextUrl = 'myntra';
          console.log(`[Ingestion] Gift/fashion intent → context_url="myntra" for "${event.title}"`);
        } else if (isGift) {
          // General gift → amazon (broadest match)
          contextUrl = 'amazon';
          console.log(`[Ingestion] Gift/general intent → context_url="amazon" for "${event.title}"`);
        }
      }

      // For any event mentioning a location, also try to set context_url
      if (!contextUrl && event.location) {
        const locationLower = event.location.toLowerCase();
        // Check for travel destinations in location
        const places = ['goa', 'mumbai', 'delhi', 'bangalore', 'chennai', 'kolkata'];
        for (const place of places) {
          if (locationLower.includes(place)) {
            contextUrl = place;
            break;
          }
        }
      }

      // Events start as 'discovered' — user must approve/acknowledge them
      // Context/URL-based events (recommendations, subscriptions) go to 'scheduled' since they trigger on URL visits
      const isContextEvent = contextUrl !== null;
      const initialStatus = isContextEvent ? 'scheduled' as const : 'discovered' as const;

      // Insert event
      const eventData = {
        message_id: message.id,
        event_type: event.type,
        title: event.title,
        description: event.description,
        event_time: eventTime,
        location: event.location,
        participants: JSON.stringify(event.participants),
        keywords: event.keywords.join(','),
        confidence: event.confidence,
        status: initialStatus,
        context_url: contextUrl,
        sender_name: senderName,
      };
      const eventId = await insertEvent(eventData);
      eventsCreated++;

      // Track for return
      createdEvents.push({
        id: eventId,
        event_type: event.type,
        title: event.title,
        description: event.description,
        event_time: eventTime,
        location: event.location,
        participants: JSON.stringify(event.participants),
        keywords: event.keywords.join(','),
        confidence: event.confidence,
        context_url: contextUrl,
        sender_name: senderName,
      });

      // Check for calendar conflicts
      if (eventTime) {
        const conflicts = await checkEventConflicts(eventTime, 60);
        const otherConflicts = conflicts.filter(e => e.id !== eventId);
        if (otherConflicts.length > 0) {
          const lastEvent = createdEvents[createdEvents.length - 1];
          lastEvent.conflicts = otherConflicts.map(e => ({
            id: e.id!,
            title: e.title,
            event_time: e.event_time
          }));
          console.log(`⚠️ Conflict: Event "${event.title}" conflicts with ${otherConflicts.length} events`);
        }
      }

      // Create triggers
      // Time-based triggers at 3 intervals: 24h, 1h, 15min before event
      if (eventTime) {
        const intervals: Array<{ type: TriggerType; offset: number }> = [
          { type: 'time_24h', offset: 24 * 60 * 60 },
          { type: 'time_1h', offset: 60 * 60 },
          { type: 'time_15m', offset: 15 * 60 },
        ];
        const now = Math.floor(Date.now() / 1000);
        for (const { type, offset } of intervals) {
          const triggerTime = eventTime - offset;
          if (triggerTime > now) {
            await insertTrigger({
              event_id: eventId,
              trigger_type: type,
              trigger_value: new Date(triggerTime * 1000).toISOString(),
              is_fired: false,
            });
            triggersCreated++;
          }
        }
      }

      // Location/URL triggers
      if (event.location) {
        await insertTrigger({
          event_id: eventId,
          trigger_type: 'url',
          trigger_value: event.location.toLowerCase(),
          is_fired: false,
        });
        triggersCreated++;
      }

      // Keyword triggers (for important keywords)
      const importantKeywords = event.keywords.filter(kw =>
        ['travel', 'flight', 'hotel', 'buy', 'gift', 'birthday', 'meeting', 'deadline', 'dinner', 'lunch', 'coffee'].some(ik => kw.toLowerCase().includes(ik))
      );
      for (const kw of importantKeywords.slice(0, 3)) {
        await insertTrigger({
          event_id: eventId,
          trigger_type: 'keyword',
          trigger_value: kw.toLowerCase(),
          is_fired: false,
        });
        triggersCreated++;
      }
    }

    console.log(`📥 Processed message ${message.id}: ${eventsCreated} events, ${triggersCreated} triggers`);

  } catch (error) {
    console.error(`❌ Failed to process message ${message.id}:`, error);
  }

  return { messageId: message.id, eventsCreated, triggersCreated, skipped: false, events: createdEvents };
}

// Batch import for initial data load
export async function batchImportMessages(
  messages: Array<{ content: string; sender: string; chatId: string; timestamp: number }>
): Promise<{ total: number; processed: number; events: number }> {
  let processed = 0;
  let totalEvents = 0;

  for (const msg of messages) {
    const message: Message = {
      id: `import_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      chat_id: msg.chatId,
      sender: msg.sender,
      content: msg.content,
      timestamp: msg.timestamp,
    };

    await insertMessage(message);

    // Trivial pre-filter only — LLM decides the rest
    if (!shouldSkipMessage(msg.content)) {
      const result = await processMessage(message);
      totalEvents += result.eventsCreated;
      processed++;
    }
  }

  return { total: messages.length, processed, events: totalEvents };
}
