import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

// Mock db module for testing
const TEST_DB_PATH = './data/test-events.db';

describe('Database Operations', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Clean up
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
    
    // Ensure directory exists
    const dir = path.dirname(TEST_DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(TEST_DB_PATH);
    db.pragma('journal_mode = WAL');

    // Create tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        chat_id TEXT NOT NULL,
        sender TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );

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
        status TEXT DEFAULT 'pending',
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      );
    `);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(TEST_DB_PATH)) {
      fs.unlinkSync(TEST_DB_PATH);
    }
  });

  it('should insert and retrieve messages', () => {
    const stmt = db.prepare(`
      INSERT INTO messages (id, chat_id, sender, content, timestamp)
      VALUES (?, ?, ?, ?, ?)
    `);
    stmt.run('msg1', 'chat1', 'user1', 'Hello world', Date.now());

    const result = db.prepare('SELECT * FROM messages WHERE id = ?').get('msg1');
    expect(result).toBeDefined();
    expect((result as { content: string }).content).toBe('Hello world');
  });

  it('should insert and retrieve events', () => {
    const stmt = db.prepare(`
      INSERT INTO events (message_id, event_type, title, keywords, confidence)
      VALUES (?, ?, ?, ?, ?)
    `);
    const result = stmt.run('msg1', 'meeting', 'Team standup', 'meeting,standup,team', 0.9);

    expect(result.lastInsertRowid).toBe(1);

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(1);
    expect(event).toBeDefined();
    expect((event as { title: string }).title).toBe('Team standup');
  });

  it('should search events by location', () => {
    db.prepare(`
      INSERT INTO events (event_type, title, location, keywords, confidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run('travel', 'Goa trip', 'Goa', 'goa,travel,beach', 0.9, Math.floor(Date.now() / 1000));

    const events = db.prepare(`
      SELECT * FROM events WHERE location LIKE ?
    `).all('%Goa%');

    expect(events.length).toBe(1);
    expect((events[0] as { title: string }).title).toBe('Goa trip');
  });

  it('should handle event status updates', () => {
    db.prepare(`
      INSERT INTO events (event_type, title, keywords, confidence, status)
      VALUES (?, ?, ?, ?, ?)
    `).run('task', 'Buy groceries', 'groceries,shopping', 0.8, 'pending');

    db.prepare('UPDATE events SET status = ? WHERE id = ?').run('completed', 1);

    const event = db.prepare('SELECT * FROM events WHERE id = ?').get(1);
    expect((event as { status: string }).status).toBe('completed');
  });
});

describe('Message Classification', () => {
  it('should detect event keywords', () => {
    const eventKeywords = /\b(meet|meeting|call|tomorrow|deadline|reminder)\b/i;
    
    expect(eventKeywords.test('lets meet tomorrow')).toBe(true);
    expect(eventKeywords.test('nice weather today')).toBe(false);
    expect(eventKeywords.test('deadline is friday')).toBe(true);
  });

  it('should detect time patterns', () => {
    const timePatterns = /\b(\d{1,2}:\d{2}|\d{1,2}\s*(am|pm))\b/i;
    
    expect(timePatterns.test('meet at 5pm')).toBe(true);
    expect(timePatterns.test('call at 10:30')).toBe(true);
    expect(timePatterns.test('hello world')).toBe(false);
  });

  it('should handle Hinglish messages', () => {
    const hindiTime = /\b(kal|aaj|parso|subah|shaam|raat)\b/i;
    
    expect(hindiTime.test('kal milte hain')).toBe(true);
    expect(hindiTime.test('aaj shaam ko')).toBe(true);
    expect(hindiTime.test('meeting tomorrow')).toBe(false);
  });
});
