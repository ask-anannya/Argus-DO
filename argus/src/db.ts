import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import type { Message, Event, Trigger, Contact, TriggerType } from './types.js';

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!db) {
    throw new Error('Database not initialized. Call initDb() first.');
  }
  return db;
}

export function initDb(dbPath: string): Database.Database {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = 10000');
  db.pragma('temp_store = MEMORY');

  // Migration: Add missing columns to existing tables
  try {
    // Check if reminder_time column exists in events table
    const tableInfo = db.prepare("PRAGMA table_info(events)").all() as Array<{ name: string }>;
    const hasReminderTime = tableInfo.some(col => col.name === 'reminder_time');
    const hasContextUrl = tableInfo.some(col => col.name === 'context_url');
    const hasDismissCount = tableInfo.some(col => col.name === 'dismiss_count');
    const hasSenderName = tableInfo.some(col => col.name === 'sender_name');
    
    if (tableInfo.length > 0) { // Table exists
      if (!hasReminderTime) {
        console.log('⚙️  Adding reminder_time column to events table...');
        db.exec('ALTER TABLE events ADD COLUMN reminder_time INTEGER');
      }
      if (!hasContextUrl) {
        console.log('⚙️  Adding context_url column to events table...');
        db.exec('ALTER TABLE events ADD COLUMN context_url TEXT');
      }
      if (!hasDismissCount) {
        console.log('⚙️  Adding dismiss_count column to events table...');
        db.exec('ALTER TABLE events ADD COLUMN dismiss_count INTEGER DEFAULT 0');
      }
      if (!hasSenderName) {
        console.log('⚙️  Adding sender_name column to events table...');
        db.exec('ALTER TABLE events ADD COLUMN sender_name TEXT');
      }
    }
  } catch (err) {
    // Table doesn't exist yet, will be created below
  }

  // Create tables
  db.exec(`
    -- Messages table
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      sender TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id);
    CREATE INDEX IF NOT EXISTS idx_messages_chat_time ON messages(chat_id, timestamp DESC);

    -- Events table (with new columns for reminder flow)
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id TEXT,
      event_type TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      event_time INTEGER,
      location TEXT,
      participants TEXT,
      keywords TEXT NOT NULL,
      confidence REAL,
      status TEXT DEFAULT 'discovered',
      reminder_time INTEGER,
      context_url TEXT,
      dismiss_count INTEGER DEFAULT 0,
      sender_name TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (message_id) REFERENCES messages(id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_time ON events(event_time);
    CREATE INDEX IF NOT EXISTS idx_events_status ON events(status);
    CREATE INDEX IF NOT EXISTS idx_events_location ON events(location);
    CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
    CREATE INDEX IF NOT EXISTS idx_events_reminder ON events(reminder_time);
    CREATE INDEX IF NOT EXISTS idx_events_context_url ON events(context_url);

    -- Contacts table
    CREATE TABLE IF NOT EXISTS contacts (
      id TEXT PRIMARY KEY,
      name TEXT,
      first_seen INTEGER,
      last_seen INTEGER,
      message_count INTEGER DEFAULT 0
    );

    -- Triggers table
    CREATE TABLE IF NOT EXISTS triggers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      trigger_type TEXT NOT NULL,
      trigger_value TEXT,
      is_fired INTEGER DEFAULT 0,
      fire_count INTEGER DEFAULT 0,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_triggers_unfired ON triggers(is_fired, trigger_type);
    CREATE INDEX IF NOT EXISTS idx_triggers_value ON triggers(trigger_value);

    -- Push subscriptions table
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT UNIQUE NOT NULL,
      keys TEXT NOT NULL,
      created_at INTEGER DEFAULT (strftime('%s', 'now'))
    );

    -- Context dismissals table (tracks dismissed context reminders per URL pattern)
    CREATE TABLE IF NOT EXISTS context_dismissals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id INTEGER NOT NULL,
      url_pattern TEXT NOT NULL,
      dismissed_until INTEGER,
      created_at INTEGER DEFAULT (strftime('%s', 'now')),
      FOREIGN KEY (event_id) REFERENCES events(id)
    );
    CREATE INDEX IF NOT EXISTS idx_context_dismissals_url ON context_dismissals(url_pattern);
  `);

  // Create FTS5 virtual table for full-text search
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS events_fts USING fts5(
      title,
      description,
      keywords,
      location,
      content=events,
      content_rowid=id,
      tokenize='porter unicode61'
    );

    -- Triggers to keep FTS in sync
    CREATE TRIGGER IF NOT EXISTS events_ai AFTER INSERT ON events BEGIN
      INSERT INTO events_fts(rowid, title, description, keywords, location)
      VALUES (new.id, new.title, new.description, new.keywords, new.location);
    END;

    CREATE TRIGGER IF NOT EXISTS events_ad AFTER DELETE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, description, keywords, location)
      VALUES ('delete', old.id, old.title, old.description, old.keywords, old.location);
    END;

    CREATE TRIGGER IF NOT EXISTS events_au AFTER UPDATE ON events BEGIN
      INSERT INTO events_fts(events_fts, rowid, title, description, keywords, location)
      VALUES ('delete', old.id, old.title, old.description, old.keywords, old.location);
      INSERT INTO events_fts(rowid, title, description, keywords, location)
      VALUES (new.id, new.title, new.description, new.keywords, new.location);
    END;
  `);

  console.log('✅ Database initialized:', dbPath);
  return db;
}

// ============ Message Operations ============
export function insertMessage(msg: Message): void {
  const stmt = getDb().prepare(`
    INSERT OR REPLACE INTO messages (id, chat_id, sender, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
  `);
  stmt.run(msg.id, msg.chat_id, msg.sender, msg.content, msg.timestamp);
}

export function getRecentMessages(chatId: string, limit = 5): Message[] {
  const stmt = getDb().prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `);
  return stmt.all(chatId, limit) as Message[];
}

export function getMessageById(id: string): Message | undefined {
  const stmt = getDb().prepare('SELECT * FROM messages WHERE id = ?');
  return stmt.get(id) as Message | undefined;
}

// ============ Event Operations ============

/**
 * Check if a similar event already exists within the last N hours.
 * Uses title similarity (case-insensitive, trimmed) to find duplicates.
 * Returns the existing event if found, null otherwise.
 */
export function findDuplicateEvent(title: string, hoursWindow: number = 48): Event | null {
  const cutoff = Math.floor(Date.now() / 1000) - hoursWindow * 60 * 60;
  const normalizedTitle = title.trim().toLowerCase();
  
  // Exact title match (case-insensitive)
  const exactMatch = getDb().prepare(`
    SELECT * FROM events
    WHERE LOWER(TRIM(title)) = ? AND created_at > ? AND status NOT IN ('completed', 'expired', 'ignored')
    LIMIT 1
  `).get(normalizedTitle, cutoff) as Event | undefined;
  
  if (exactMatch) return exactMatch;
  
  // Fuzzy match: check if the new title is contained in an existing title or vice versa
  // This catches cases like "Try cashews at Zantyes" vs "Try cashews at Zantye's"
  const recentEvents = getDb().prepare(`
    SELECT * FROM events
    WHERE created_at > ? AND status NOT IN ('completed', 'expired', 'ignored')
    ORDER BY created_at DESC
    LIMIT 100
  `).all(cutoff) as Event[];
  
  for (const existing of recentEvents) {
    const existingTitle = existing.title.trim().toLowerCase();
    
    // Skip very short existing titles (1-2 words) — too generic to match on substring
    // e.g. "Meeting" should NOT match "Meeting with Nityam at 5pm"
    const existingWords = existingTitle.split(/\s+/).length;
    const newWords = normalizedTitle.split(/\s+/).length;
    
    if (existingWords <= 2 || newWords <= 2) {
      // For short titles: only match if they're essentially the same (exact or cleaned)
      const cleanExisting = existingTitle.replace(/[''`\-]/g, '');
      const cleanNew = normalizedTitle.replace(/[''`\-]/g, '');
      if (cleanExisting === cleanNew) {
        return existing;
      }
      continue;
    }
    
    // For longer titles (3+ words): allow substring containment
    // This catches "Try cashews at Zantyes" vs "Try cashews at Zantye's"
    if (existingTitle.includes(normalizedTitle) || normalizedTitle.includes(existingTitle)) {
      return existing;
    }
    // Remove apostrophes/special chars and compare
    const cleanExisting = existingTitle.replace(/[''`\-]/g, '');
    const cleanNew = normalizedTitle.replace(/[''`\-]/g, '');
    if (cleanExisting === cleanNew) {
      return existing;
    }
  }
  
  return null;
}

export function insertEvent(event: Omit<Event, 'id' | 'created_at'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO events (message_id, event_type, title, description, event_time, location, participants, keywords, confidence, status, context_url, sender_name)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    event.message_id,
    event.event_type,
    event.title,
    event.description,
    event.event_time,
    event.location,
    event.participants,
    event.keywords,
    event.confidence,
    event.status || 'pending',
    event.context_url || null,
    event.sender_name || null
  );
  return result.lastInsertRowid as number;
}

export function getEventById(id: number): Event | undefined {
  const stmt = getDb().prepare('SELECT * FROM events WHERE id = ?');
  return stmt.get(id) as Event | undefined;
}

export function getPendingEvents(limit = 50): Event[] {
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status = 'pending'
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as Event[];
}

export function getRecentEvents(days = 90, limit = 100): Event[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE created_at > ? AND status = 'pending'
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(cutoff, limit) as Event[];
}

export function updateEventStatus(id: number, status: EventStatus): void {
  const stmt = getDb().prepare('UPDATE events SET status = ? WHERE id = ?');
  stmt.run(status, id);
  console.log(`📝 [DB] Event ${id} status → ${status}`);
}

// ============ Search Operations ============
export function searchEventsByLocation(location: string, days = 90, limit = 10): Event[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE location LIKE ? AND status IN ('pending', 'scheduled') AND created_at > ?
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(`%${location}%`, cutoff, limit) as Event[];
}

export function searchEventsByKeywords(keywords: string[], days = 90, limit = 10): Event[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60;
  
  // Try exact location match first
  for (const kw of keywords) {
    const exact = searchEventsByLocation(kw, days, limit);
    if (exact.length > 0) return exact;
  }
  
  // FTS5 search
  const query = keywords.join(' OR ');
  try {
    const stmt = getDb().prepare(`
      SELECT e.* FROM events e
      JOIN events_fts f ON e.id = f.rowid
      WHERE events_fts MATCH ? AND e.status IN ('pending', 'scheduled') AND e.created_at > ?
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(query, cutoff, limit) as Event[];
  } catch {
    // Fallback to LIKE search
    const likeConditions = keywords.map(() => '(keywords LIKE ? OR title LIKE ? OR description LIKE ?)').join(' OR ');
    const likeParams = keywords.flatMap(kw => [`%${kw}%`, `%${kw}%`, `%${kw}%`]);
    const stmt = getDb().prepare(`
      SELECT * FROM events
      WHERE (${likeConditions}) AND status IN ('pending', 'scheduled') AND created_at > ?
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(...likeParams, cutoff, limit) as Event[];
  }
}

// ============ Trigger Operations ============
export function insertTrigger(trigger: Omit<Trigger, 'id' | 'created_at'>): number {
  const stmt = getDb().prepare(`
    INSERT INTO triggers (event_id, trigger_type, trigger_value, is_fired)
    VALUES (?, ?, ?, ?)
  `);
  const result = stmt.run(trigger.event_id, trigger.trigger_type, trigger.trigger_value, trigger.is_fired ? 1 : 0);
  return result.lastInsertRowid as number;
}

export function getUnfiredTriggersByType(type: string): Trigger[] {
  const stmt = getDb().prepare(`
    SELECT * FROM triggers WHERE trigger_type = ? AND is_fired = 0
  `);
  return stmt.all(type) as Trigger[];
}

export function getUnfiredUrlTriggers(): Trigger[] {
  const stmt = getDb().prepare(`
    SELECT t.*, e.title, e.description FROM triggers t
    JOIN events e ON t.event_id = e.id
    WHERE t.trigger_type = 'url' AND t.is_fired = 0 AND e.status = 'pending'
  `);
  return stmt.all() as Trigger[];
}

export function markTriggerFired(id: number): void {
  const stmt = getDb().prepare('UPDATE triggers SET is_fired = 1 WHERE id = ?');
  stmt.run(id);
}

// ============ Contact Operations ============
export function upsertContact(contact: Contact): void {
  const stmt = getDb().prepare(`
    INSERT INTO contacts (id, name, first_seen, last_seen, message_count)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, contacts.name),
      last_seen = excluded.last_seen,
      message_count = contacts.message_count + 1
  `);
  stmt.run(contact.id, contact.name, contact.first_seen, contact.last_seen, contact.message_count);
}

// ============ Stats ============
// Event Status Types (proper lifecycle)
// discovered → User hasn't acted yet (new from WhatsApp)
// scheduled → User approved, will show context reminders & 1hr before reminders
// snoozed → User said "later", will remind again after 30min
// ignored → User doesn't care (hidden but not deleted)
// reminded → 1-hour before reminder was shown
// completed → User marked as done
// expired → Event time passed without action
export type EventStatus = 'discovered' | 'scheduled' | 'snoozed' | 'ignored' | 'reminded' | 'completed' | 'expired';

export function getStats(): { 
  messages: number; 
  events: number; 
  triggers: number;
  // New proper status counts
  discoveredEvents: number;
  scheduledEvents: number;
  snoozedEvents: number;
  ignoredEvents: number;
  remindedEvents: number;
  completedEvents: number;
  expiredEvents: number;
  // Legacy (for backwards compat)
  pendingEvents: number;
} {
  const db = getDb();
  const messages = (db.prepare('SELECT COUNT(*) as count FROM messages').get() as { count: number }).count;
  const events = (db.prepare('SELECT COUNT(*) as count FROM events').get() as { count: number }).count;
  const triggers = (db.prepare('SELECT COUNT(*) as count FROM triggers').get() as { count: number }).count;
  
  // New status counts
  const discoveredEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'discovered'").get() as { count: number }).count;
  const scheduledEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'scheduled'").get() as { count: number }).count;
  const snoozedEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'snoozed'").get() as { count: number }).count;
  const ignoredEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'ignored'").get() as { count: number }).count;
  const remindedEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'reminded'").get() as { count: number }).count;
  const completedEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'completed'").get() as { count: number }).count;
  const expiredEvents = (db.prepare("SELECT COUNT(*) as count FROM events WHERE status = 'expired'").get() as { count: number }).count;
  
  // Legacy - pendingEvents = discovered + snoozed (events needing attention)
  const pendingEvents = discoveredEvents + snoozedEvents;
  
  return { messages, events, triggers, discoveredEvents, scheduledEvents, snoozedEvents, ignoredEvents, remindedEvents, completedEvents, expiredEvents, pendingEvents };
}

// ============ Message Queries ============
export function getAllMessages(options: {
  limit?: number;
  offset?: number;
  sender?: string;
}): Message[] {
  const { limit = 50, offset = 0, sender } = options;
  
  if (sender) {
    const stmt = getDb().prepare(`
      SELECT * FROM messages
      WHERE sender = ?
      ORDER BY timestamp DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(sender, limit, offset) as Message[];
  }
  
  const stmt = getDb().prepare(`
    SELECT * FROM messages
    ORDER BY timestamp DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset) as Message[];
}

// ============ Event Queries ============
export function getAllEvents(options: {
  limit?: number;
  offset?: number;
  status?: EventStatus | 'all' | 'active'; // 'active' = discovered + scheduled + snoozed
}): (Event & { source_message?: string; source_sender?: string })[] {
  const { limit = 50, offset = 0, status = 'all' } = options;
  
  // 'active' = all events needing attention (not ignored/completed/expired)
  if (status === 'active') {
    const stmt = getDb().prepare(`
      SELECT e.*, m.content as source_message, m.sender as source_sender
      FROM events e
      LEFT JOIN messages m ON e.message_id = m.id
      WHERE e.status IN ('discovered', 'scheduled', 'snoozed', 'reminded')
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(limit, offset) as (Event & { source_message?: string; source_sender?: string })[];
  }
  
  if (status !== 'all') {
    const stmt = getDb().prepare(`
      SELECT e.*, m.content as source_message, m.sender as source_sender
      FROM events e
      LEFT JOIN messages m ON e.message_id = m.id
      WHERE e.status = ?
      ORDER BY e.created_at DESC
      LIMIT ? OFFSET ?
    `);
    return stmt.all(status, limit, offset) as (Event & { source_message?: string; source_sender?: string })[];
  }
  
  const stmt = getDb().prepare(`
    SELECT e.*, m.content as source_message, m.sender as source_sender
    FROM events e
    LEFT JOIN messages m ON e.message_id = m.id
    ORDER BY e.created_at DESC
    LIMIT ? OFFSET ?
  `);
  return stmt.all(limit, offset) as (Event & { source_message?: string; source_sender?: string })[];
}

// Find pending events matching keywords (for updates/cancellations)
export function findPendingEventsByKeywords(keywords: string[]): Event[] {
  if (keywords.length === 0) return [];
  
  const conditions = keywords.map(() => `keywords LIKE ?`).join(' OR ');
  const params = keywords.map(kw => `%${kw.toLowerCase()}%`);
  
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status = 'pending' AND (${conditions})
    ORDER BY created_at DESC
    LIMIT 10
  `);
  
  return stmt.all(...params) as Event[];
}

// Find active events by keywords (for action commands - searches all non-completed/expired statuses)
export function findActiveEventsByKeywords(keywords: string[]): Event[] {
  if (keywords.length === 0) return [];
  
  // Build search across title, keywords, description, location
  const conditions = keywords.map(() => 
    `(LOWER(keywords) LIKE ? OR LOWER(title) LIKE ? OR LOWER(COALESCE(description,'')) LIKE ? OR LOWER(COALESCE(location,'')) LIKE ?)`
  ).join(' OR ');
  const params = keywords.flatMap(kw => {
    const lk = `%${kw.toLowerCase()}%`;
    return [lk, lk, lk, lk];
  });
  
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status NOT IN ('completed', 'expired', 'ignored') AND (${conditions})
    ORDER BY created_at DESC
    LIMIT 10
  `);
  
  return stmt.all(...params) as Event[];
}

// Get all active events (for LLM action matching context)
export function getActiveEvents(limit = 20): Event[] {
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status NOT IN ('completed', 'expired', 'ignored', 'dismissed')
    ORDER BY created_at DESC
    LIMIT ?
  `);
  return stmt.all(limit) as Event[];
}

// Update event time (for reschedule actions)
export function updateEventTime(eventId: number, newTime: number): void {
  const stmt = getDb().prepare(`
    UPDATE events SET event_time = ? WHERE id = ?
  `);
  stmt.run(newTime, eventId);
  console.log(`📝 [DB] Event ${eventId} time updated to ${new Date(newTime * 1000).toISOString()}`);
}

// General-purpose event update (for CRUD via LLM or API)
// Only updates fields that are explicitly provided (non-undefined)
export function updateEvent(eventId: number, fields: {
  title?: string;
  description?: string | null;
  event_time?: number | null;
  location?: string | null;
  keywords?: string;
  context_url?: string | null;
  event_type?: string;
  participants?: string;
  status?: string;
  sender_name?: string | null;
}): boolean {
  const event = getEventById(eventId);
  if (!event) {
    console.log(`❌ [DB] updateEvent: Event ${eventId} not found`);
    return false;
  }

  const updates: string[] = [];
  const values: any[] = [];

  if (fields.title !== undefined) { updates.push('title = ?'); values.push(fields.title); }
  if (fields.description !== undefined) { updates.push('description = ?'); values.push(fields.description); }
  if (fields.event_time !== undefined) { updates.push('event_time = ?'); values.push(fields.event_time); }
  if (fields.location !== undefined) { updates.push('location = ?'); values.push(fields.location); }
  if (fields.keywords !== undefined) { updates.push('keywords = ?'); values.push(fields.keywords); }
  if (fields.context_url !== undefined) { updates.push('context_url = ?'); values.push(fields.context_url); }
  if (fields.event_type !== undefined) { updates.push('event_type = ?'); values.push(fields.event_type); }
  if (fields.participants !== undefined) { updates.push('participants = ?'); values.push(fields.participants); }
  if (fields.status !== undefined) { updates.push('status = ?'); values.push(fields.status); }
  if (fields.sender_name !== undefined) { updates.push('sender_name = ?'); values.push(fields.sender_name); }

  if (updates.length === 0) {
    console.log(`⏭️ [DB] updateEvent: No fields to update for event ${eventId}`);
    return false;
  }

  values.push(eventId);
  const sql = `UPDATE events SET ${updates.join(', ')} WHERE id = ?`;
  getDb().prepare(sql).run(...values);

  const changedFields = Object.keys(fields).filter(k => (fields as any)[k] !== undefined).join(', ');
  console.log(`📝 [DB] Event ${eventId} updated: [${changedFields}]`);
  return true;
}

export function deleteEvent(id: number): void {
  // Delete associated triggers FIRST (foreign key constraint)
  const triggerStmt = getDb().prepare('DELETE FROM triggers WHERE event_id = ?');
  triggerStmt.run(id);
  // Delete context dismissals
  const dismissStmt = getDb().prepare('DELETE FROM context_dismissals WHERE event_id = ?');
  dismissStmt.run(id);
  // Then delete the event
  const stmt = getDb().prepare('DELETE FROM events WHERE id = ?');
  stmt.run(id);
}

// ============ Enhanced Event Operations ============

// Schedule reminders for an event at multiple intervals (24h, 1h, 15min before)
export function scheduleEventReminder(eventId: number): void {
  const event = getEventById(eventId);
  if (!event) {
    const stmt = getDb().prepare(`UPDATE events SET status = 'scheduled' WHERE id = ?`);
    stmt.run(eventId);
    return;
  }

  if (!event.event_time) {
    // No event_time — mark as scheduled (URL/context-based events)
    const stmt = getDb().prepare(`UPDATE events SET status = 'scheduled' WHERE id = ?`);
    stmt.run(eventId);
    return;
  }

  const now = Math.floor(Date.now() / 1000);
  const intervals: Array<{ type: TriggerType; offset: number }> = [
    { type: 'reminder_24h', offset: 24 * 60 * 60 },
    { type: 'reminder_1hr', offset: 60 * 60 },
    { type: 'reminder_15m', offset: 15 * 60 },
  ];

  // Set the earliest future reminder as the primary reminder_time
  let primaryReminderTime: number | null = null;
  for (const { type, offset } of intervals) {
    const triggerTime = event.event_time - offset;
    if (triggerTime > now) {
      if (!primaryReminderTime) primaryReminderTime = triggerTime;
      insertTrigger({
        event_id: eventId,
        trigger_type: type,
        trigger_value: triggerTime.toString(),
        is_fired: false,
      });
    }
  }

  if (primaryReminderTime) {
    const stmt = getDb().prepare(`UPDATE events SET status = 'scheduled', reminder_time = ? WHERE id = ?`);
    stmt.run(primaryReminderTime, eventId);
  } else {
    // All intervals already passed, just mark as scheduled
    const stmt = getDb().prepare(`UPDATE events SET status = 'scheduled' WHERE id = ?`);
    stmt.run(eventId);
  }
}

// Get events due for reminder (reminder_time has passed)
export function getDueReminders(): Event[] {
  const now = Math.floor(Date.now() / 1000);
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status = 'scheduled' AND reminder_time IS NOT NULL AND reminder_time <= ?
    ORDER BY reminder_time ASC
  `);
  return stmt.all(now) as Event[];
}

// Mark event as reminded
export function markEventReminded(eventId: number): void {
  const stmt = getDb().prepare(`
    UPDATE events SET status = 'reminded' WHERE id = ?
  `);
  stmt.run(eventId);
}

// Get events with context URL that match a given URL
// Matches if URL contains the context_url keyword (case-insensitive)
// Also matches by location field when context_url is null (e.g., canva events)
// Only returns SCHEDULED events (user must have approved them first)
export function getContextEventsForUrl(url: string): Event[] {
  const urlLower = url.toLowerCase();
  console.log(`🔎 [DB] getContextEventsForUrl: url="${url}"`);
  
  // Match by context_url OR by location field
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status = 'scheduled'
    AND (
      (context_url IS NOT NULL AND context_url != '' AND LOWER(?) LIKE '%' || LOWER(context_url) || '%')
      OR
      (location IS NOT NULL AND location != '' AND (context_url IS NULL OR context_url = '') AND LOWER(?) LIKE '%' || LOWER(location) || '%')
    )
  `);
  const results = stmt.all(urlLower, urlLower) as Event[];
  console.log(`📊 [DB] Query returned ${results.length} event(s) with status='scheduled'`);
  if (results.length > 0) {
    results.forEach(e => {
      console.log(`   └─ Event #${e.id}: "${e.title}" (status: ${e.status}, context_url: ${e.context_url}, location: ${e.location})`);
    });
  }
  return results;
}

// Get all events for a specific day (for reschedule/day-view)
export function getEventsForDay(dayTimestamp: number): Event[] {
  const d = new Date(dayTimestamp * 1000);
  d.setHours(0, 0, 0, 0);
  const startOfDay = Math.floor(d.getTime() / 1000);
  const endOfDay = startOfDay + 24 * 60 * 60;
  
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE event_time IS NOT NULL
    AND event_time BETWEEN ? AND ?
    AND status NOT IN ('ignored', 'expired')
    ORDER BY event_time ASC
  `);
  return stmt.all(startOfDay, endOfDay) as Event[];
}

// Check for calendar conflicts with existing events
export function checkEventConflicts(eventTime: number, durationMinutes = 60): Event[] {
  // Check events within +/- duration window
  const startWindow = eventTime - (durationMinutes * 60);
  const endWindow = eventTime + (durationMinutes * 60);
  
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE event_time IS NOT NULL
    AND event_time BETWEEN ? AND ?
    AND status NOT IN ('completed', 'expired')
    ORDER BY event_time ASC
  `);
  return stmt.all(startWindow, endWindow) as Event[];
}

// Dismiss a context event for a URL (can be temporary or permanent)
export function dismissContextEvent(eventId: number, urlPattern: string, permanent = false): void {
  console.log(`💾 [DB] dismissContextEvent: eventId=${eventId}, urlPattern="${urlPattern}", permanent=${permanent}`);
  if (permanent) {
    // Mark as completed (won't show again)
    updateEventStatus(eventId, 'completed');
    console.log(`✅ [DB] Event ${eventId} permanently dismissed (status → completed)`);
  } else {
    // Increment dismiss count and store URL pattern for future reference
    const stmt = getDb().prepare(`
      UPDATE events SET dismiss_count = dismiss_count + 1 WHERE id = ?
    `);
    stmt.run(eventId);
    console.log(`🕐 [DB] Event ${eventId} temporarily dismissed (dismiss_count incremented)`);
    
    // Store dismissal with URL pattern (if provided) for potential re-trigger logic
    if (urlPattern) {
      try {
        const dismissStmt = getDb().prepare(`
          INSERT INTO context_dismissals (event_id, url_pattern, dismissed_until)
          VALUES (?, ?, ?)
        `);
        // Dismiss for 30 minutes
        const dismissUntil = Math.floor(Date.now() / 1000) + 1800;
        dismissStmt.run(eventId, urlPattern, dismissUntil);
      } catch (e) {
        // Table might not exist in older DBs, ignore
      }
    }
  }
}

// Set context URL for an event (for URL-based triggers like Netflix)
export function setEventContextUrl(eventId: number, contextUrl: string): void {
  const stmt = getDb().prepare(`
    UPDATE events SET context_url = ? WHERE id = ?
  `);
  stmt.run(contextUrl, eventId);
  
  // Also create a URL trigger
  insertTrigger({
    event_id: eventId,
    trigger_type: 'url',
    trigger_value: contextUrl,
    is_fired: false,
  });
}

// ============ Event Status Actions ============

// Snooze event (remind again in 30 minutes)
export function snoozeEvent(eventId: number, snoozeMinutes = 30): void {
  const snoozeUntil = Math.floor(Date.now() / 1000) + (snoozeMinutes * 60);
  const stmt = getDb().prepare(`
    UPDATE events SET status = 'snoozed', reminder_time = ? WHERE id = ?
  `);
  stmt.run(snoozeUntil, eventId);
  console.log(`💤 [DB] Event ${eventId} snoozed until ${new Date(snoozeUntil * 1000).toLocaleTimeString()}`);
}

// Ignore event (user doesn't care, but don't delete)
export function ignoreEvent(eventId: number): void {
  const stmt = getDb().prepare(`
    UPDATE events SET status = 'ignored' WHERE id = ?
  `);
  stmt.run(eventId);
  console.log(`🚫 [DB] Event ${eventId} ignored`);
}

// Complete event (user marked as done)
export function completeEvent(eventId: number): void {
  const stmt = getDb().prepare(`
    UPDATE events SET status = 'completed' WHERE id = ?
  `);
  stmt.run(eventId);
  console.log(`✅ [DB] Event ${eventId} completed`);
}

// Get snoozed events that are due
export function getDueSnoozedEvents(): Event[] {
  const now = Math.floor(Date.now() / 1000);
  const stmt = getDb().prepare(`
    SELECT * FROM events
    WHERE status = 'snoozed' AND reminder_time IS NOT NULL AND reminder_time <= ?
    ORDER BY reminder_time ASC
  `);
  return stmt.all(now) as Event[];
}

// Get events by status
export function getEventsByStatus(status: string, limit = 50): Event[] {
  const stmt = getDb().prepare(`
    SELECT * FROM events WHERE status = ? ORDER BY created_at DESC LIMIT ?
  `);
  return stmt.all(status, limit) as Event[];
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// ── FTS5 search for re-ranker ─────────────────────────────────────────────────
export function ftsSearchEvents(query: string, limit = 20): Event[] {
  const safeQuery = query.replace(/['"*()]/g, ' ').trim();
  if (!safeQuery) return getActiveEvents(limit);

  try {
    const stmt = getDb().prepare(`
      SELECT e.* FROM events_fts fts
      JOIN events e ON e.id = fts.rowid
      WHERE events_fts MATCH ?
        AND e.status NOT IN ('completed', 'expired', 'ignored')
      ORDER BY rank
      LIMIT ?
    `);
    return stmt.all(safeQuery, limit) as Event[];
  } catch {
    return findActiveEventsByKeywords(query.split(/\s+/).filter(w => w.length > 2));
  }
}

// ── Data export / import for backup ──────────────────────────────────────────
export function exportAllData(): Record<string, any[]> {
  const db = getDb();
  return {
    events:        db.prepare('SELECT * FROM events').all(),
    messages:      db.prepare('SELECT * FROM messages').all(),
    triggers:      db.prepare('SELECT * FROM triggers').all(),
    contacts:      db.prepare('SELECT * FROM contacts').all(),
    dismissals:    db.prepare('SELECT * FROM context_dismissals').all(),
    subscriptions: db.prepare('SELECT * FROM push_subscriptions').all(),
  };
}

export function importData(
  data: Record<string, any[]>,
  mode: 'merge' | 'replace',
): void {
  const db = getDb();
  db.transaction(() => {
    if (mode === 'replace') {
      db.prepare('DELETE FROM context_dismissals').run();
      db.prepare('DELETE FROM triggers').run();
      db.prepare('DELETE FROM events').run();
      db.prepare('DELETE FROM messages').run();
      db.prepare('DELETE FROM contacts').run();
      db.prepare('DELETE FROM push_subscriptions').run();
    }

    for (const row of (data.events ?? [])) {
      db.prepare(`
        INSERT OR REPLACE INTO events
          (id, message_id, event_type, title, description, event_time, location,
           participants, keywords, confidence, status, reminder_time, context_url,
           dismiss_count, sender_name, created_at)
        VALUES
          (@id, @message_id, @event_type, @title, @description, @event_time, @location,
           @participants, @keywords, @confidence, @status, @reminder_time, @context_url,
           @dismiss_count, @sender_name, @created_at)
      `).run(row);
    }
    for (const row of (data.messages ?? [])) {
      db.prepare(`INSERT OR REPLACE INTO messages (id, chat_id, sender, content, timestamp, created_at) VALUES (@id, @chat_id, @sender, @content, @timestamp, @created_at)`).run(row);
    }
    for (const row of (data.triggers ?? [])) {
      db.prepare(`INSERT OR REPLACE INTO triggers (id, event_id, trigger_type, trigger_value, is_fired, fire_count, created_at) VALUES (@id, @event_id, @trigger_type, @trigger_value, @is_fired, @fire_count, @created_at)`).run(row);
    }
    for (const row of (data.contacts ?? [])) {
      db.prepare(`INSERT OR REPLACE INTO contacts (id, name, first_seen, last_seen, message_count) VALUES (@id, @name, @first_seen, @last_seen, @message_count)`).run(row);
    }
    for (const row of (data.dismissals ?? [])) {
      db.prepare(`INSERT OR REPLACE INTO context_dismissals (id, event_id, url_pattern, dismissed_until, created_at) VALUES (@id, @event_id, @url_pattern, @dismissed_until, @created_at)`).run(row);
    }
    for (const row of (data.subscriptions ?? [])) {
      db.prepare(`INSERT OR REPLACE INTO push_subscriptions (id, endpoint, keys, created_at) VALUES (@id, @endpoint, @keys, @created_at)`).run(row);
    }
  })();
}

export function getPushSubscriptions(): Array<{ endpoint: string; keys: string }> {
  return getDb().prepare('SELECT endpoint, keys FROM push_subscriptions').all() as Array<{ endpoint: string; keys: string }>;
}
