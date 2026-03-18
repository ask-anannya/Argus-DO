# Argus - Ultra-Simple Architecture

**Version:** 2.7.1  
**Last Updated:** February 9, 2026  
**Status:** Active Development - Full Pipeline Working (Evolution → Webhook → Gemini → Extension Overlays)

---

## Overview

**Argus** is an AI-powered WhatsApp assistant that learns from your conversations and provides proactive reminders based on browser context. This document describes the **ultra-simplified architecture** that avoids unnecessary complexity while delivering core functionality.

### Core Principle
**SQLite + Gemini Only** - No vectors, no FAISS, no embeddings, no RAG complexity.

---

## Technology Stack

| Component | Technology | Version | Purpose |
|-----------|-----------|---------|---------|
| **Runtime** | Node.js | 22.x | JavaScript runtime |
| **Language** | TypeScript | 5.8.x | Type-safe development |
| **Web Server** | Express.js | 5.x | HTTP server & WebSocket |
| **Database** | SQLite | better-sqlite3 12.x | Single-file storage |
| **LLM** | Gemini 3 Flash Preview | Latest | Event extraction & validation |
| **WhatsApp** | Evolution API | v2.1.1 | WhatsApp Web integration |
| **Browser** | Chrome Extension | Manifest V3 | URL detection |
| **Notifications** | Web Push API | Native | Browser notifications |
| **Validation** | Zod | 3.24.x | Schema validation |

### What We're NOT Using
❌ FAISS vector store  
❌ OpenAI embeddings  
❌ RAG pipelines  
❌ Multi-stage LLM calls  
❌ Token compression libraries  

### External Dependencies (Evolution API)
✅ PostgreSQL 16 — Evolution API database  
✅ Redis 7 — Evolution API cache  
(These are used by Evolution API, not Argus core which uses SQLite only)  

---

## System Architecture

```
┌─────────────────────────────────────────┐
│         User's WhatsApp Messages        │
└──────────────┬──────────────────────────┘
               │ (Evolution API Webhook)
               ▼
┌─────────────────────────────────────────┐
│      Argus Service (Node.js)            │
│  ┌───────────────────────────────────┐  │
│  │  1. Message Ingestion             │  │
│  │     - Store in SQLite             │  │
│  │     - Extract with Gemini         │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  2. SQLite Database (events.db)   │  │
│  │     - messages (raw WhatsApp)     │  │
│  │     - events (extracted)          │  │
│  │     - contacts (people)           │  │
│  │     - triggers (scheduled)        │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  3. Context Matcher               │  │
│  │     - SQL FTS5 (keyword search)   │  │
│  │     - Gemini validation (top 10)  │  │
│  └───────────────────────────────────┘  │
│  ┌───────────────────────────────────┐  │
│  │  4. Trigger Engine                │  │
│  │     - Time-based (cron jobs)      │  │
│  │     - URL-based (from extension)  │  │
│  └───────────────────────────────────┘  │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│    Chrome Extension (Background)        │
│  - Detects URL changes                  │
│  - Sends to Argus API                   │
│  - Displays notification cards          │
└─────────────────────────────────────────┘
```

---

## Data Flow

### 1. Message Ingestion (WhatsApp → Events)

```
Evolution API Webhook
    ↓
Store raw message in `messages` table
    ↓
Send to Gemini: "Extract events from this message"
    ↓
Parse JSON response (Zod validation)
    ↓
Insert into `events` table (if found)
    ↓
Create `triggers` for time/location/keywords
```

**Performance:**
- Cost per message: ~$0.0001 (Gemini Flash)
- Time: ~500ms
- Single API call per message

### 2. Context Matching (URL → Relevant Events)

```
User browses "makemytrip.com/goa" in Chrome
    ↓
Extension sends: { url: "...", title: "..." }
    ↓
SQLite FTS5 Query:
    SELECT * FROM events_fts 
    WHERE events_fts MATCH 'goa OR travel'
    LIMIT 10
    ↓
Send top 10 to Gemini: "Which events are relevant?"
    ↓
Return top 3 matches with confidence scores
    ↓
Show notification card in browser
```

**Performance:**
- Cost per context check: ~$0.0003
- Time: ~800ms
- SQL query: <10ms, Gemini validation: ~800ms

---

## Database Schema

### Schema Design (4 Tables Only)

#### 1. `messages` - Raw WhatsApp Data
```sql
CREATE TABLE messages (
  id TEXT PRIMARY KEY,           -- WhatsApp message ID
  chat_id TEXT NOT NULL,         -- Group/contact ID
  sender TEXT NOT NULL,          -- Phone number
  content TEXT NOT NULL,         -- Message text
  timestamp INTEGER NOT NULL,    -- Unix timestamp
  created_at INTEGER DEFAULT (strftime('%s', 'now'))
);

CREATE INDEX idx_messages_timestamp ON messages(timestamp);
CREATE INDEX idx_messages_chat ON messages(chat_id);
```

#### 2. `events` - Extracted Events
```sql
CREATE TABLE events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id TEXT,               -- Link to source message
  event_type TEXT NOT NULL,      -- 'meeting', 'deadline', 'reminder', 'travel'
  title TEXT NOT NULL,           -- "Goa trip"
  description TEXT,              -- Full details
  event_time INTEGER,            -- When it happens (unix timestamp)
  location TEXT,                 -- "Goa", "Office", etc.
  participants TEXT,             -- JSON array of contacts
  keywords TEXT,                 -- Searchable keywords (comma-separated)
  confidence REAL,               -- 0.0 to 1.0
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  
  FOREIGN KEY (message_id) REFERENCES messages(id)
);

CREATE INDEX idx_events_time ON events(event_time);
CREATE INDEX idx_events_keywords ON events(keywords);

-- Full-text search index
CREATE VIRTUAL TABLE events_fts USING fts5(
  title, 
  description, 
  keywords,
  content=events,
  content_rowid=id
);
```

#### 3. `contacts` - People
```sql
CREATE TABLE contacts (
  id TEXT PRIMARY KEY,           -- Phone number
  name TEXT,                     -- "Rahul", "Sister"
  first_seen INTEGER,
  last_seen INTEGER,
  message_count INTEGER DEFAULT 0
);
```

#### 4. `triggers` - Scheduled Checks
```sql
CREATE TABLE triggers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id INTEGER NOT NULL,
  trigger_type TEXT NOT NULL,    -- 'time', 'url', 'keyword'
  trigger_value TEXT,            -- "2026-02-10 18:00" or "goa" or "makemytrip.com"
  is_fired INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (strftime('%s', 'now')),
  
  FOREIGN KEY (event_id) REFERENCES events(id)
);

CREATE INDEX idx_triggers_unfired ON triggers(is_fired, trigger_type);
```

---

## Smart Search (No Vector Embeddings)

### Two-Step Process

**Step 1: SQL Full-Text Search (FTS5)**
```typescript
// Extract keywords from URL
const keywords = extractKeywords("makemytrip.com/goa"); 
// Returns: ["goa", "travel"]

// Search using SQLite FTS5
const candidates = db.prepare(`
  SELECT e.*, rank 
  FROM events_fts 
  WHERE events_fts MATCH ? 
  ORDER BY rank 
  LIMIT 10
`).all(keywords.join(' OR '));
```

**Step 2: Gemini Validation (Only Top 10)**
```typescript
const prompt = `
Context: User is browsing "${url}"

Which of these events are relevant? Return ONLY the event IDs.

Events:
${candidates.map(e => `[${e.id}] ${e.title}: ${e.description}`).join('\n')}

Return JSON: { "relevant": [1, 5, 7], "confidence": 0.85 }
`;

const response = await gemini.chat(prompt);
```

**Why This Works:**
- FTS5 narrows down from 50k to 10 messages (~99.98% reduction)
- Gemini validates only 10 candidates (~5,000 tokens vs 500k+)
- Total cost: $0.0003 per check
- Total time: ~800ms
- Accuracy: 90%+

---

## Message Processing (Single Gemini Call)

### Extraction Prompt
```typescript
const prompt = `
Extract events from this WhatsApp message. Return JSON only.

Message:
"Hey, let's meet in Goa next Friday at that cashew shop Rahul mentioned. 
Flight at 3pm, book hotel near beach."

Schema:
{
  "events": [
    {
      "type": "travel",
      "title": "Goa trip",
      "description": "Meet at cashew shop Rahul mentioned",
      "event_time": "2026-02-14T15:00:00Z",
      "location": "Goa",
      "participants": ["Rahul"],
      "keywords": ["goa", "flight", "hotel", "beach", "cashew"]
    }
  ]
}

If no event found, return: { "events": [] }
`;
```

**Benefits:**
- Single API call extracts everything
- No multi-stage pipeline
- No token compression needed
- Structured JSON output with Zod validation

---

## Chrome Extension

### Minimal Implementation

**Background Service Worker**
```typescript
// URL detection only - no DOM reading
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url) {
    // Send URL to Argus API
    fetch('http://localhost:3000/api/context-check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ 
        url: tab.url, 
        title: tab.title 
      })
    })
    .then(res => res.json())
    .then(events => {
      if (events.length > 0) {
        // Show Chrome notification
        chrome.notifications.create({
          type: 'basic',
          title: events[0].title,
          message: events[0].description,
          iconUrl: 'icon.png'
        });
      }
    });
  }
});
```

**Features:**
- No content scripts needed
- No DOM manipulation
- Just URL + title extraction
- Lightweight and fast

---

## Scalability Analysis

### 50,000 Messages

**Storage:**
- 50k messages × 500 bytes = **25 MB**
- ~5k events (10% hit rate) × 1KB = **5 MB**
- FTS5 index: ~10 MB
- **Total database size: ~40 MB** (SQLite handles easily)

**Search Performance:**
- FTS5 query on 50k messages: **<10ms**
- No vector calculations needed
- Linear scaling with message count

**Gemini Costs (Monthly):**
- Ingestion: 50k messages × $0.0001 = **$5.00** (one-time)
- Context checks: 100 checks/day × $0.0003 × 30 days = **$0.90/month**
- **Total: ~$6 setup + $1/month** ongoing

**Memory:**
- SQLite memory usage: ~50 MB
- Node.js process: ~100 MB
- **Total: <200 MB** per user

---

## File Structure

```
argus/
├── src/
│   ├── server.ts              # Express server + webhooks
│   ├── db.ts                  # SQLite setup + queries
│   ├── gemini.ts              # Gemini API wrapper
│   ├── ingestion.ts           # Message → Events processing
│   ├── matcher.ts             # URL → Events search
│   ├── scheduler.ts           # Time-based triggers
│   └── types.ts               # Zod schemas
├── extension/
│   ├── manifest.json          # Chrome extension config
│   ├── background.js          # URL detection service worker
│   ├── popup.html             # Quick status view
│   └── popup.js               # Popup logic
├── data/
│   └── events.db              # SQLite database (auto-created)
├── tests/
│   ├── ingestion.test.ts
│   ├── matcher.test.ts
│   └── db.test.ts
├── .env                       # API keys & config
├── .env.example               # Template
├── package.json
├── tsconfig.json
├── INFO.md                    # This file
└── RULES.md                   # Development rules
```

**Estimated LOC:**
- TypeScript backend: ~1,200 lines
- Chrome extension: ~200 lines
- Tests: ~300 lines
- **Total: ~1,700 lines**

---

## API Endpoints

### Core API

```typescript
// Webhook from Evolution API
POST /api/webhook/whatsapp
Body: { event: "messages.upsert", instance: "arguas", data: { key: { remoteJid, fromMe, id }, pushName, message: { conversation }, messageTimestamp } }

// Context check from Chrome extension
POST /api/context-check
Body: { url: "https://...", title: "..." }
Response: [{ event_id, title, description, confidence }]

// Get all events (dashboard)
GET /api/events?limit=50&offset=0

// Get specific event
GET /api/events/:id

// Health check
GET /api/health
```

---

## Development Phases

### Phase 1: Core Foundation (Week 1)
- [ ] SQLite database setup with FTS5
- [ ] Express server with webhook endpoint
- [ ] Gemini API integration
- [ ] Basic message ingestion
- [ ] Zod schema validation

### Phase 2: Event Processing (Week 1-2)
- [ ] Message → Event extraction
- [ ] Event storage with triggers
- [ ] Context matching (SQL + Gemini)
- [ ] Time-based trigger scheduler

### Phase 3: Chrome Extension (Week 2)
- [ ] Manifest V3 setup
- [ ] URL detection background worker
- [ ] API integration
- [ ] Chrome notification display

### Phase 4: Polish & Testing (Week 3)
- [ ] Unit tests (Vitest)
- [ ] Integration tests
- [ ] Error handling
- [ ] Documentation
- [ ] Performance optimization

---

## Environment Configuration

### Required API Keys

```bash
# Gemini API (Google AI Studio or OpenAI-compatible)
GEMINI_API_KEY=your_gemini_api_key
GEMINI_MODEL=gemini-3-flash-preview

# Evolution API (WhatsApp)
EVOLUTION_API_URL=https://your-evolution-instance.com
EVOLUTION_API_KEY=your_evolution_key

# Server Configuration
PORT=3000
NODE_ENV=development

# Database
DB_PATH=./data/events.db
```

---

## Testing Strategy

### Unit Tests
- Database operations (CRUD)
- Gemini API wrapper
- Event extraction logic
- Context matching algorithm

### Integration Tests
- End-to-end message processing
- Webhook handling
- Chrome extension API

### Test Coverage Target
- Minimum: 80%
- Core logic: 95%

---

## Performance Targets

| Metric | Target | Current |
|--------|--------|---------|
| Message ingestion | <1s | TBD |
| Context check | <1s | TBD |
| SQL FTS5 query | <10ms | TBD |
| Database size (50k msgs) | <100MB | TBD |
| Memory usage | <200MB | TBD |
| Gemini API calls/msg | 1 | TBD |

---

## Key Design Decisions

### Why SQLite FTS5?
- Built-in full-text search (no external dependencies)
- Sub-10ms query performance on 50k records
- Zero configuration required
- Single-file portability

### Why Gemini 3 Flash?
- 10x cheaper than GPT-4
- 2x faster response time
- Structured JSON output support
- Sufficient for extraction tasks

### Why No Embeddings?
- FTS5 provides 90%+ accuracy for keyword matching
- Gemini validation catches edge cases
- Embeddings add complexity and cost
- Not needed for this use case

### Why Single Container?
- Data isolation per user
- Simple deployment model
- Easy to debug and test
- Scales horizontally

---

## Success Metrics

### Technical
- ✅ <1s message processing time
- ✅ <$10/month operational cost per user
- ✅ 90%+ event extraction accuracy
- ✅ <200MB memory footprint

### User Experience
- ✅ Zero manual tagging required
- ✅ Proactive notifications feel "magic"
- ✅ No false positive spam
- ✅ Instant context matching

---

## Future Enhancements (Out of Scope for MVP)

- Multi-user dashboard
- Analytics and insights
- Custom trigger rules (user-defined)
- Voice message transcription
- Image OCR for event extraction
- Multi-language support
- Mobile app notifications

---

## References

- [Evolution API Docs](https://doc.evolution-api.com/)
- [Gemini API Docs](https://ai.google.dev/docs)
- [SQLite FTS5 Docs](https://www.sqlite.org/fts5.html)
- [Chrome Extension Docs](https://developer.chrome.com/docs/extensions/mv3/)

---

**Last Updated:** February 4, 2026  
**Maintained By:** Development Team  
**License:** Private
