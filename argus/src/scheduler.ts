import {
  getUnfiredTriggersByType,
  markTriggerFired,
  getEventById,
  updateEventStatus,
  getDueReminders,
  markEventReminded,
  getContextEventsForUrl,
  checkEventConflicts,
  getDueSnoozedEvents
} from './db.js';
import { runDailyBackup, pruneOldBackups } from './backup.js';
import { logFailedReminder } from './errors.js';

// Extended notification with popup type
interface NotificationPayload {
  id: number;
  title: string;
  description: string | null;
  event_time?: number | null;
  location?: string | null;
  event_type?: string;
  triggerType: string;
  popupType: 'event_discovery' | 'event_reminder' | 'context_reminder' | 'conflict_warning' | 'insight_card' | 'snooze_reminder';
  conflictingEvents?: Array<{ id: number; title: string; event_time: number | null }>;
}

type NotifyCallback = (event: NotificationPayload) => void | Promise<void>;

// ============ Retry Queue ============

interface RetryItem {
  payload: NotificationPayload;
  attempt: number;        // 0 = first retry, 1 = second, 2 = third
  nextRetryAt: number;    // Unix ms timestamp
  reason: string;
  markFn: () => Promise<void>;  // called on successful delivery
}

const retryQueue: RetryItem[] = [];
const BACKOFF_MS = [60_000, 300_000, 900_000] as const;  // 1m, 5m, 15m
const MAX_ATTEMPTS = 3;

let failedReminderCount = 0;

export function getRetryQueueSize(): number {
  return retryQueue.length;
}

export function getFailedReminderCount(): number {
  return failedReminderCount;
}

// ============ Scheduler State ============

let schedulerInterval: NodeJS.Timeout | null = null;
let reminderInterval: NodeJS.Timeout | null = null;
let snoozeInterval: NodeJS.Timeout | null = null;
let backupInterval: NodeJS.Timeout | null = null;
let notifyCallback: NotifyCallback | null = null;

let backupRetentionDays = 7;

export function startScheduler(callback: NotifyCallback, intervalMs = 60000, retentionDays = 7): void {
  notifyCallback = callback;
  backupRetentionDays = retentionDays;

  // Run immediately
  checkTimeTriggers();
  checkDueReminders();
  checkSnoozedEvents();

  // Then run periodically
  schedulerInterval = setInterval(checkTimeTriggers, intervalMs);
  // Piggyback processRetryQueue on the 30s reminder interval
  reminderInterval = setInterval(async () => {
    await checkDueReminders();
    await processRetryQueue();
  }, 30000);
  snoozeInterval = setInterval(checkSnoozedEvents, 30000);

  // Daily backup: first run 60s after start, then every 24h
  setTimeout(() => {
    runScheduledBackup();
    backupInterval = setInterval(runScheduledBackup, 24 * 60 * 60 * 1000);
  }, 60 * 1000);

  console.log('⏰ Scheduler started (triggers every', intervalMs / 1000, 's, reminders/snooze every 30s, backup daily)');
}

async function runScheduledBackup(): Promise<void> {
  try {
    await runDailyBackup();
    await pruneOldBackups(backupRetentionDays);
  } catch (err) {
    console.warn('[Scheduler] Daily backup failed:', (err as Error).message);
  }
}

export function stopScheduler(): void {
  if (schedulerInterval) { clearInterval(schedulerInterval); schedulerInterval = null; }
  if (reminderInterval)  { clearInterval(reminderInterval);  reminderInterval  = null; }
  if (snoozeInterval)    { clearInterval(snoozeInterval);    snoozeInterval    = null; }
  if (backupInterval)    { clearInterval(backupInterval);    backupInterval    = null; }
  console.log('⏰ Scheduler stopped');
}

// ============ safeNotify ============

/**
 * Wraps notifyCallback in try-catch.
 * Returns true on success, false if the callback throws or is not set.
 */
async function safeNotify(payload: NotificationPayload): Promise<boolean> {
  if (!notifyCallback) return false;
  try {
    await notifyCallback(payload);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[Scheduler] Notify failed for "${payload.title}" (id: ${payload.id}): ${msg}`);
    return false;
  }
}

// ============ Retry Queue Logic ============

/**
 * Adds a failed notification to the retry queue with exponential backoff.
 * If MAX_ATTEMPTS is reached, logs to data/failed-reminders.jsonl instead.
 */
function scheduleRetry(
  payload: NotificationPayload,
  reason: string,
  attempt: number,
  markFn: () => Promise<void>
): void {
  if (attempt >= MAX_ATTEMPTS) {
    failedReminderCount++;
    logFailedReminder(payload, attempt, reason);
    return;
  }
  const delayMs = BACKOFF_MS[attempt];
  retryQueue.push({ payload, attempt, nextRetryAt: Date.now() + delayMs, reason, markFn });
  console.warn(`[Scheduler] Retry #${attempt + 1}/${MAX_ATTEMPTS} queued for "${payload.title}" in ${delayMs / 1000}s`);
}

/**
 * Processes all due retry items.
 * Called every 30s, piggybacked on reminderInterval.
 */
async function processRetryQueue(): Promise<void> {
  const now = Date.now();
  // Iterate in reverse so splice doesn't skip items
  for (let i = retryQueue.length - 1; i >= 0; i--) {
    const item = retryQueue[i];
    if (item.nextRetryAt > now) continue;

    retryQueue.splice(i, 1);  // Remove before attempting to avoid double-fire

    const success = await safeNotify(item.payload);
    if (success) {
      try {
        await item.markFn();
      } catch (err) {
        console.error(`[Scheduler] markFn failed after retry success for "${item.payload.title}":`, err);
      }
      console.log(`[Scheduler] Retry #${item.attempt + 1} succeeded for "${item.payload.title}"`);
    } else {
      scheduleRetry(item.payload, item.reason, item.attempt + 1, item.markFn);
    }
  }
}

// ============ Snoozed Events ============

async function checkSnoozedEvents(): Promise<void> {
  try {
    const dueEvents = await getDueSnoozedEvents();

    for (const event of dueEvents) {
      if (!event.id) continue;

      if (notifyCallback) {
        const payload: NotificationPayload = {
          id: event.id,
          title: event.title,
          description: event.description,
          event_time: event.event_time,
          location: event.location,
          event_type: event.event_type,
          triggerType: 'snooze',
          popupType: 'event_discovery',
        };

        const success = await safeNotify(payload);
        if (success) {
          console.log(`💤 Snoozed event due: ${event.title}`);
          await updateEventStatus(event.id, 'discovered');
        } else {
          // Keep event in snoozed state until delivery succeeds
          const id = event.id;
          scheduleRetry(payload, 'callback_failed', 0, async () => updateEventStatus(id, 'discovered'));
        }
      } else {
        // No callback registered — still unsnooze the event
        await updateEventStatus(event.id, 'discovered');
      }
    }
  } catch (err) {
    console.error('Scheduler: checkSnoozedEvents error:', err);
  }
}

// ============ Due Reminders (1-hour-before) ============

async function checkDueReminders(): Promise<void> {
  try {
    const dueReminders = await getDueReminders();

    for (const event of dueReminders) {
      if (!event.id) continue;

      if (notifyCallback) {
        const payload: NotificationPayload = {
          id: event.id,
          title: event.title,
          description: event.description,
          event_time: event.event_time,
          location: event.location,
          event_type: event.event_type,
          triggerType: 'reminder_1hr',
          popupType: 'event_reminder',
        };

        const success = await safeNotify(payload);
        if (success) {
          console.log(`🔔 1-hour reminder fired: ${event.title}`);
          await markEventReminded(event.id);
        } else {
          const id = event.id;
          scheduleRetry(payload, 'callback_failed', 0, async () => markEventReminded(id));
        }
      } else {
        // No callback — still mark reminded so it doesn't re-fire
        await markEventReminded(event.id);
      }
    }
  } catch (err) {
    console.error('Scheduler: checkDueReminders error:', err);
  }
}

// ============ Context Triggers ============

// Check for context URL triggers (called when user visits a URL)
export async function checkContextTriggers(url: string): Promise<NotificationPayload[]> {
  const events = await getContextEventsForUrl(url);
  const notifications: NotificationPayload[] = [];

  console.log(`[Scheduler] Checking URL "${url}" - found ${events.length} matching events`);

  for (const event of events) {
    if (event.id) {
      console.log(`[Scheduler] Context match: Event #${event.id} "${event.title}" (context_url: ${event.context_url})`);
      notifications.push({
        id: event.id,
        title: event.title,
        description: event.description,
        event_time: event.event_time,
        location: event.location,
        event_type: event.event_type,
        triggerType: 'url',
        popupType: 'context_reminder',
      });
    }
  }

  return notifications;
}

// Check for calendar conflicts with a new event
export async function checkCalendarConflicts(eventId: number, eventTime: number): Promise<NotificationPayload | null> {
  const conflicts = await checkEventConflicts(eventTime, 60);

  const otherConflicts = conflicts.filter(e => e.id !== eventId);

  if (otherConflicts.length === 0) return null;

  const event = await getEventById(eventId);
  if (!event) return null;

  console.log(`[Scheduler] Conflict detected: Event #${eventId} conflicts with ${otherConflicts.length} events`);

  return {
    id: event.id!,
    title: event.title,
    description: event.description,
    event_time: event.event_time,
    location: event.location,
    event_type: event.event_type,
    triggerType: 'conflict',
    popupType: 'conflict_warning',
    conflictingEvents: otherConflicts.map(e => ({
      id: e.id!,
      title: e.title,
      event_time: e.event_time
    }))
  };
}

// ============ Time Triggers ============

async function checkTimeTriggers(): Promise<void> {
  try {
    const now = Date.now();
    const triggerTypes = ['time', 'time_24h', 'time_1h', 'time_15m', 'reminder_24h', 'reminder_1hr', 'reminder_15m'];
    let triggers: any[] = [];
    for (const tt of triggerTypes) {
      const batch = await getUnfiredTriggersByType(tt);
      triggers = triggers.concat(batch);
    }

    for (const trigger of triggers) {
      try {
        const triggerTime = new Date(trigger.trigger_value).getTime();

        if (triggerTime <= now + 5 * 60 * 1000) {
          const event = await getEventById(trigger.event_id);

          if (event && (event.status === 'pending' || event.status === 'scheduled' || event.status === 'discovered' || event.status === 'reminded')) {
            const payload: NotificationPayload = {
              id: event.id!,
              title: event.title,
              description: event.description,
              event_time: event.event_time,
              location: event.location,
              event_type: event.event_type,
              triggerType: 'time',
              popupType: 'event_reminder',
            };

            const triggerId = trigger.id!;
            const success = await safeNotify(payload);
            if (success) {
              await markTriggerFired(triggerId);
              console.log(`🔔 Time trigger fired: ${event.title}`);
            } else {
              scheduleRetry(payload, 'callback_failed', 0, async () => markTriggerFired(triggerId));
            }
          } else {
            // Event doesn't qualify (wrong status, not found) — mark fired to avoid re-firing
            await markTriggerFired(trigger.id!);
          }
        }
      } catch (error) {
        console.error(`Failed to process trigger ${trigger.id}:`, error);
      }
    }
  } catch (err) {
    console.error('Scheduler: checkTimeTriggers error:', err);
  }
}

// ============ Event Lifecycle Helpers ============

// Mark event as completed
export async function completeEvent(eventId: number): Promise<void> {
  await updateEventStatus(eventId, 'completed');
  console.log(`✅ Event ${eventId} marked as completed`);
}

// Mark event as expired
export async function expireEvent(eventId: number): Promise<void> {
  await updateEventStatus(eventId, 'expired');
  console.log(`⏳ Event ${eventId} marked as expired`);
}

// Cleanup old events (run daily)
export function cleanupOldEvents(_daysOld = 90): number {
  return 0;
}
