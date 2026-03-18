# Argus — Proactive Memory Assistant v4.0.0-gradient

AI-powered WhatsApp assistant that learns from your conversations, detects events, and reminds you at the right moment — while you browse. Powered by **Llama 3.3 70B via DigitalOcean Gradient** and **SQLite**. Refer to `argus/ARCH.md` for architecture details.

## DigitalOcean Features Used

Argus uses two distinct DigitalOcean Gradient products — one for AI inference, one for deploying an agentic AI service.

### 1. Gradient Serverless Inference

| Detail | Value |
|--------|-------|
| **Product** | DigitalOcean Gradient Serverless Inference |
| **Model** | `llama3.3-70b-instruct` |
| **Endpoint** | `https://inference.do-ai.run/v1` (OpenAI-compatible) |
| **Auth** | `DO_GRADIENT_MODEL_KEY` (sk-do-...) |
| **Client** | `openai` npm package with custom `baseURL` |

**Where it's used — `argus/src/gradient.ts`:**

Every AI function in Argus calls Gradient Serverless through `callLlama()`:

| Function | What it does |
|----------|-------------|
| `extractEvents()` | Extracts events/tasks/reminders from a WhatsApp message |
| `detectAction()` | Detects if the user is cancelling, completing, snoozing an existing event |
| `generatePopupBlueprint()` | Generates the full popup spec (icon, title, body with sender attribution, buttons) |
| `validateRelevance()` | Confirms whether a browser URL actually matches a stored event |
| `chatWithContext()` | Natural language Q&A over the user's saved events (fallback path for `/api/chat`) |

All five functions are wrapped in `withFallback()` from `ai-tier.ts` — if Gradient is unavailable, the system automatically falls back to regex heuristics (Tier 2) or cached responses (Tier 3).

**Llama-specific handling:** Llama 3.3 70B ignores `response_format: json_object` and often returns prose + markdown-wrapped JSON. `repairJSON(raw, preferredKey)` in `gradient.ts` scans all `{ }` blocks in the response and selects the one containing the expected schema key (`"events"`, `"isAction"`, `"response"`, etc.).

---

### 2. Gradient ADK (Agent Development Kit)

| Detail | Value |
|--------|-------|
| **Product** | DigitalOcean Gradient ADK |
| **Package** | `gradient-adk` v0.2.11 (Python) |
| **Framework** | LangGraph (Python 3.12) |
| **Deployed at** | `https://agents.do-ai.run/v1/<agent-id>/production/run` |
| **Auth** | `DIGITALOCEAN_API_TOKEN` (dop_v1_...) |
| **CLI** | `gradient agent init` → `gradient agent deploy` |

**Where it's used — `argus-agent/`:**

The ADK agent is a standalone Python/LangGraph service deployed to DigitalOcean. It is the **primary handler for `/api/chat`** — when the user opens the AI Chat sidebar in the Chrome extension, Argus POSTs the query to the ADK agent URL instead of calling Llama directly.

The agent has two tools that call back into Argus through the internal API (protected by `INTERNAL_API_SECRET`):

| Tool | Calls | Purpose |
|------|-------|---------|
| `search_events(query)` | `POST /api/internal/search` | FTS5 keyword search over stored events |
| `get_event(id)` | `GET /api/internal/events/:id` | Fetch a specific event by ID |

**Flow:**
```
Extension sidepanel
    → POST /api/chat { query }
    → Argus POSTs to ADK Agent URL
    → LangGraph tool-call loop:
        search_events("meeting") → /api/internal/search (x-internal-secret)
        get_event(42)            → /api/internal/events/42 (x-internal-secret)
    ← Agent returns natural language answer
    ← Argus forwards to extension

    (if ADK agent unreachable or fails)
    → falls back to chatWithContext() — direct Llama call with events in prompt
```

**Why ADK over direct Llama chat?** The ADK agent can iteratively query the database — it calls tools multiple times, narrows results, then synthesises a response. Direct `chatWithContext()` can only embed a fixed snapshot of events in the prompt.

---

### DigitalOcean credentials summary

| Env Var | Product | Used by |
|---------|---------|---------|
| `DO_GRADIENT_MODEL_KEY` | Gradient Serverless Inference | `gradient.ts` — all `callLlama()` calls |
| `DIGITALOCEAN_API_TOKEN` | Gradient ADK (deploy/manage agent) | `gradient agent deploy` CLI |
| `ADK_AGENT_URL` | Gradient ADK (runtime endpoint) | `server.ts` — `/api/chat` handler |
| `INTERNAL_API_SECRET` | Internal API (Argus ↔ ADK agent) | `server.ts` + `argus-agent/main.py` |

---

## Quick Start

### Docker (Recommended — works on Linux / Windows / macOS)

```bash
git clone https://github.com/ask-anannya/Argus-DO
cd whatsapp-chat-rmd-argus/argus
cp .env.example .env          # Fill in DO_GRADIENT_MODEL_KEY + Evolution API credentials
docker compose up -d           # Starts 4 containers (builds everything from source)
docker compose logs -f argus   # View Argus logs
```

> **Everything is included** — Evolution API source, QuickSave, and Argus are all in this repo. No extra downloads needed.

### Local Development

```bash
cd argus
npm install
cp .env.example .env           # Fill in DO_GRADIENT_MODEL_KEY + Evolution API credentials
npm run dev                    # Hot-reload dev server on :3000
```

## Docker Architecture

```
┌─────────────────────────────────────────────────────┐
│                  docker compose                      │
│                                                      │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ postgres │←─│ evolution-api │←─│    argus      │  │
│  │ :5432    │  │ :8080         │  │ :3000         │  │
│  └──────────┘  └──────────────┘  └───────┬───────┘  │
│  ┌──────────┐        ↑                   │          │
│  │  redis   │────────┘                   │ WS+HTTP  │
│  │ :6379    │                            │          │
│  └──────────┘                            ▼          │
│                               Chrome Extension      │
└─────────────────────────────────────────────────────┘
```

| Container | Image | Purpose |
|-----------|-------|---------|
| `argus-server` | Built from `./Dockerfile` | Express server, Llama 3.3 70B via Gradient, SQLite, WebSocket |
| `argus-evolution` | Built from `../evolution-api/Dockerfile` | WhatsApp bridge (Evolution API v2.3) |
| `argus-postgres` | `postgres:16-alpine` | Evolution API database |
| `argus-redis` | `redis:7-alpine` | Evolution API cache |

### Docker Commands

```bash
docker compose up -d               # Start all 4 containers
docker compose up -d --build       # Rebuild + start
docker compose logs -f argus       # Argus logs
docker compose logs -f evolution-api # Evolution logs
docker compose down                # Stop
docker compose down -v             # Stop + delete all data
docker compose ps                  # Status
```

## Project Structure

```
argus-whatsapp-assistant/           # ← Clone this repo
├── argus/                          # Main application
│   ├── src/
│   │   ├── server.ts               # Express + WebSocket server, all API routes
│   │   ├── db.ts                   # SQLite (better-sqlite3) — all DB operations + FTS5 search
│   │   ├── gradient.ts             # Llama 3.3 70B via Gradient — extraction, popup blueprints, chat
│   │   ├── ingestion.ts            # WhatsApp message processing pipeline
│   │   ├── ai-tier.ts              # AI fallback tier manager (Tier 1/2/3)
│   │   ├── fallback-heuristics.ts  # Tier 2 — regex/pattern replacements for LLM
│   │   ├── response-cache.ts       # Tier 3 — LRU response cache
│   │   ├── backup.ts               # Export/import/prune backup logic
│   │   ├── quicksave.ts            # QuickSave CEP v9.1 — context compression
│   │   ├── matcher.ts              # URL pattern matching for context triggers
│   │   ├── scheduler.ts            # Time-based reminders + snooze + daily backup
│   │   ├── evolution-db.ts         # Direct PostgreSQL read for message history
│   │   ├── errors.ts               # Typed error classes + retry/timeout utilities
│   │   └── types.ts                # Zod schemas + config parser
│   ├── extension/                  # Chrome Extension (Manifest V3)
│   │   ├── manifest.json           # <all_urls> content scripts
│   │   ├── background.js           # WebSocket, API calls, context checks
│   │   ├── content.js              # Popup overlays (8 types), DOM form watcher
│   │   ├── sidepanel.html/js       # AI Chat sidebar
│   │   ├── popup.html/js           # Extension popup with stats + backup export
│   │   └── icons/                  # Extension icons
│   ├── tests/                      # Vitest tests
│   ├── data/backups/               # Daily backup files (argus-backup-YYYY-MM-DD.json)
│   ├── Dockerfile                  # Multi-stage Node 22 Alpine
│   ├── docker-compose.yml          # Full stack (4 containers)
│   └── .env.example                # Environment template
├── argus-agent/                    # DigitalOcean Gradient ADK Agent
│   ├── main.py                     # LangGraph agent with search_events + get_event tools
│   ├── requirements.txt            # gradient-adk, langchain-core, langgraph, httpx
│   └── .env                        # Agent credentials (GRADIENT_MODEL_ACCESS_KEY, etc.)
├── evolution-api/                  # WhatsApp Bridge (included, builds from source)
│   ├── src/                        # Evolution API v2.3.7 source
│   ├── Dockerfile                  # Node 24 Alpine build
│   ├── prisma/                     # Database schema
│   └── docker-compose.yaml         # (Not used — we use argus/docker-compose.yml)
└── quicksave/                      # QuickSave CEP v9.1 (reference spec)
    ├── SKILL.md                    # Full protocol specification
    └── references/                 # PDL, S2A, NCL, expert docs
```

## Development Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with hot reload |
| `npm run build` | Build TypeScript → `dist/` |
| `npm start` | Run production server |
| `npm test` | Run tests (~2s, Vitest) |
| `npm run lint` | Lint code (ESLint, cached) |
| `npm run format` | Format code (Prettier) |
| `npm run typecheck` | Type-check without emitting |

## Chrome Extension Setup

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** → select `extension/` folder
4. (For local `file://` testing) → Enable **Allow access to file URLs**

## API Endpoints

### Core

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check (includes `aiTier`, `aiTierMode`) |
| `/api/stats` | GET | Event and message statistics |
| `/api/ai-status` | GET | AI tier status, cooldown, cache stats |

### Events

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/events` | GET | List events (filter by `?status=`) |
| `/api/events/:id` | GET | Get single event |
| `/api/events/:id` | PATCH | Update event fields |
| `/api/events/:id` | DELETE | Delete event |
| `/api/events/:id/set-reminder` | POST | Schedule event reminder |
| `/api/events/:id/snooze` | POST | Snooze for X minutes |
| `/api/events/:id/ignore` | POST | Ignore event |
| `/api/events/:id/complete` | POST | Mark done |
| `/api/events/:id/done` | POST | Mark done (alias) |
| `/api/events/:id/dismiss` | POST | Dismiss notification |
| `/api/events/:id/acknowledge` | POST | Acknowledge reminder |
| `/api/events/:id/confirm-update` | POST | Confirm pending update |
| `/api/events/:id/context-url` | POST | Set context URL for event |
| `/api/events/day/:timestamp` | GET | Get all events for a day |
| `/api/events/status/:status` | GET | Get events by status |

### WhatsApp / Messages

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/messages` | GET | List stored messages |
| `/api/whatsapp/messages` | GET | Messages from Evolution API |
| `/api/whatsapp/search` | GET | Search messages (`?q=`) |
| `/api/whatsapp/contacts` | GET | Contact list |
| `/api/whatsapp/chats` | GET | Chat list |
| `/api/whatsapp/instances` | GET | Evolution API instance status |
| `/api/whatsapp/stats` | GET | WhatsApp message statistics |

### Context & AI

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/context-check` | POST | Check URL for matching events (FTS5 keyword search) |
| `/api/form-check` | POST | Check form field mismatch against memory |
| `/api/extract-context` | POST | Extract context from URL |
| `/api/chat` | POST | AI Chat — ADK Agent first, falls back to direct Llama |

### Internal (ADK Agent)

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/internal/search` | POST | FTS5 event search — requires `x-internal-secret` header |
| `/api/internal/events/:id` | GET | Fetch event by ID — requires `x-internal-secret` header |

### Backup

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/backup/export` | GET | Download full backup as JSON |
| `/api/backup/list` | GET | List available backup files |
| `/api/backup/import` | POST | Import backup from JSON body |
| `/api/backup/restore/:filename` | POST | Restore from a saved backup file |

### Webhook & WebSocket

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/webhook/whatsapp` | POST | Evolution API webhook receiver |
| `/ws` | WebSocket | Real-time notifications to extension |

## How It Works

```
WhatsApp Message → Evolution API → Webhook → Argus Server
                                                  │
                                         Llama 3.3 70B (Tier 1)
                                         or Heuristics (Tier 2)
                                         or Safe Default (Tier 3)
                                        extracts events/tasks/reminders
                                                  │
                                           SQLite (FTS5) stores
                                           and indexes events
                                                  │
                                   ┌──────────────┼──────────────┐
                                   │              │              │
                              WebSocket      URL Match      DOM Watch
                              (new event)   (context)      (form field)
                                   │              │              │
                                   └──────────────┼──────────────┘
                                                  │
                                          Chrome Extension
                                         shows popup overlay
```

### AI Fallback Tier System

Argus automatically downgrades when Llama/Gradient is unavailable:

| Tier | Condition | Behavior |
|------|-----------|----------|
| **1** | Normal operation | Llama 3.3 70B via Gradient (full accuracy) |
| **2** | 1+ failures, cooldown active | Regex/pattern heuristics |
| **3** | 10+ consecutive failures | LRU cache; safe defaults (`{events: []}`) on cache miss |

Cooldown schedule: 1 failure → 30s, 3 consecutive → 5min, 10 consecutive → 15min. Recovery to Tier 1 is immediate on any success.

### JSON Repair

Llama 3.3 70B sometimes wraps JSON in prose or markdown fences. `repairJSON()` in `gradient.ts` uses a 4-step extraction:

1. Direct `JSON.parse()`
2. Extract from ` ```json ``` ` markdown fences
3. Scan all `{ }` blocks — prefer the one containing the expected key (`"events"`, `"isAction"`, etc.)
4. Brace-closing repair on truncated JSON

## SQLite Database

Argus uses **SQLite** (`better-sqlite3`, synchronous API) as its sole database. All tables and FTS5 virtual tables are created automatically on startup.

### Tables

| Table | Purpose |
|-------|---------|
| `events` | Events/tasks/reminders extracted from WhatsApp |
| `messages` | Raw WhatsApp messages (source of truth) |
| `triggers` | Time and URL-based notification triggers |
| `contacts` | Contact list with message counts |
| `context_dismissals` | Per-URL dismissal suppression (30-minute window) |
| `push_subscriptions` | Browser push subscription tokens |
| `events_fts` | FTS5 virtual table over events (title, keywords, description) |

### FTS5 Search

`/api/context-check` and `/api/internal/search` use `ftsSearchEvents()` which runs a SQLite FTS5 `MATCH` query across `title`, `keywords`, and `description`. Results are ranked by BM25 relevance.

## DigitalOcean Gradient ADK Agent

When `/api/chat` is called, Argus first tries the **DO Gradient ADK Agent** (deployed Python/LangGraph service). The agent has two tools it can call back into Argus:

- `search_events(query)` → `POST /api/internal/search` (FTS5)
- `get_event(id)` → `GET /api/internal/events/:id`

Both internal endpoints require the `x-internal-secret` header. If the ADK agent is unreachable or fails, `/api/chat` falls back to direct `chatWithContext()` (Llama call with events embedded in prompt).

## API Error Handling

All error handling is centralized in `src/errors.ts`.

### Custom Error Classes

| Class | Fields | Retryable |
|-------|--------|-----------|
| `TimeoutError` | `message` | Yes — always |
| `LLMApiError` | `status`, `retryable` | Yes if 5xx or 429; No if 4xx |
| `ElasticError` | `operation`, `index` | No (handled by `safeAsync`) |

### `fetchWithTimeout`

Wraps `fetch()` with an `AbortController` deadline (default 30 s). Throws `TimeoutError` on expiry and cleans up the timer on success.

### `withRetry`

Retries an async operation with exponential backoff:

| Attempt | Timeout | Delay before retry |
|---------|---------|--------------------|
| 1st | 30 s | — |
| 2nd (retry) | 15 s | 500 ms |

Max 1 retry by default (total budget ≤ 45 s). Only retries on `TimeoutError`, `LLMApiError` (retryable), or network errors (`ECONNREFUSED`, `ENOTFOUND`, `fetch failed`, `socket hang up`, `ETIMEDOUT`). Never retries 4xx client errors.

### `safeAsync`

Catch-and-fallback wrapper used on all SQLite writes. Returns a safe fallback value on failure so the server never crashes on a write error. Set `DEBUG_ERRORS=true` to re-throw instead (surfaces bugs during development).

### Dead-Letter Log

Failed writes are appended to `data/dead-letter.jsonl` (one JSON object per line). Each entry contains the operation name, original payload, error message, and stack trace. The file auto-rotates to `dead-letter.jsonl.old` when it exceeds 10 MB.

## Scheduler Retry

The scheduler (`src/scheduler.ts`) guarantees at-least-once delivery of notifications to the Chrome extension.

### Retry Queue

When `notifyCallback` (WebSocket broadcast) throws or the extension is disconnected, the notification is placed in an in-memory retry queue with exponential backoff:

| Attempt | Delay |
|---------|-------|
| 1st retry | 1 minute |
| 2nd retry | 5 minutes |
| 3rd retry | 15 minutes |

The queue is drained every 30 seconds (piggybacked on the reminder check interval). On success the associated `markFn` is called to prevent re-firing.

### Permanent Failure

After 3 failed attempts the notification is dropped from the queue and its details appended to `data/failed-reminders.jsonl` for manual review.

### Scheduler Intervals

| Task | Interval |
|------|----------|
| Time triggers | Every 60 s |
| Due reminders + retry queue | Every 30 s |
| Snoozed events | Every 30 s |
| Daily backup | 60 s after start, then every 24 h |

## Database Backup

Argus automatically exports all SQLite data to local JSON files daily.

### Automatic Backup

The scheduler runs `runDailyBackup()` 60 seconds after startup, then every 24 hours. Old backups beyond `BACKUP_RETENTION_DAYS` (default 7) are pruned automatically after each run.

### Backup Format

```json
{
  "version": "1.0",
  "exportedAt": "2026-03-18T00:00:00.000Z",
  "source": "argus-sqlite",
  "counts": { "events": 120, "messages": 3400 },
  "indices": { "events": [...], "messages": [...], ... }
}
```

### Import Modes

| Mode | Behavior |
|------|----------|
| `merge` | Upserts documents — existing records are updated, new ones created |
| `replace` | Clears each table first, then bulk-inserts |

### Manual Backup via Extension

The extension popup has an **Export Backup** button that triggers `GET /api/backup/export` and downloads the JSON file directly to the browser.

## Working Scenarios

### 1. Travel Recommendations (Goa Cashews)
```
"Rahul recommended cashews at Zantye's in Goa"
User visits goatourism.com
Popup: "Rahul mentioned: Get cashews from Zantye's when going to Goa"
```

### 2. Insurance Accuracy (Form Mismatch)
```
User owns Honda Civic 2018 (from WhatsApp chats)
User visits ACKO and types "Honda Civic 2022"
Popup: "Hold on — you own a Honda Civic 2018! You might be overpaying!"
"Fix It" button auto-fills the correct value
```

### 3. Gift Intent (E-commerce)
```
"Need to buy makeup for sis birthday"
User visits Nykaa
Popup: "Sale going on! Priya mentioned wanting makeup for your sister"
```

### 4. Subscription Cancel (Netflix)
```
"Want to cancel my Netflix this week"
User visits netflix.com
Popup: "You planned to cancel your Netflix subscription"
```

### 5. Calendar Conflict Detection
```
"Meeting tomorrow at 5pm"
"Call with John tomorrow at 5pm"
Popup: "You might be double-booked" + View My Day timeline
```

## Popup Types (8)

| Type | Trigger |
|------|---------|
| `event_discovery` | New event detected from WhatsApp |
| `event_reminder` | Time-based (24h, 1h, 15min before) |
| `context_reminder` | URL matches event context |
| `conflict_warning` | Overlapping events detected |
| `insight_card` | Suggestions from conversations |
| `snooze_reminder` | Snoozed event fires again |
| `update_confirm` | Confirm event modification |
| `form_mismatch` | Form input doesn't match memory |

## Configuration

Copy `.env.example` to `.env` and set:

```bash
# ─── Required ──────────────────────────────────────
DO_GRADIENT_MODEL_KEY=sk-do-...      # DigitalOcean Gradient API key
DIGITALOCEAN_API_TOKEN=      # Personal Access Token (genai CRUD + project read)

# ─── ADK Agent (optional — enables agentic chat) ───
ADK_AGENT_URL=https://agents.do-ai.run/v1/<agent-id>/production/run

# ─── Internal API Security ─────────────────────────
INTERNAL_API_SECRET=<random-hex>     # Shared secret for ADK agent → Argus calls

# ─── SQLite ────────────────────────────────────────
SQLITE_PATH=./data/argus.db

# ─── Evolution API / WhatsApp ──────────────────────
EVOLUTION_API_URL=http://localhost:8080
EVOLUTION_API_KEY=rmd_evolution_api_key_12345
EVOLUTION_INSTANCE_NAME=argus

# ─── OpenAI (kept for future use) ──────────────────
OPENAI_API_KEY=sk-proj-...
OPENAI_MODEL_SMALL=gpt-4o-mini
OPENAI_MODEL_BIG=gpt-4o

# ─── Message Processing ─────────────────────────────
PROCESS_OWN_MESSAGES=true
SKIP_GROUP_MESSAGES=true

# ─── AI Fallback Tier (optional) ───────────────────
AI_TIER_MODE=auto              # auto | tier1_only | tier2_only | tier3_only
AI_COOLDOWN_BASE_SEC=30        # base cooldown after first failure
AI_CACHE_TTL_SEC=3600          # Tier 3 cache TTL (seconds)
AI_CACHE_MAX_SIZE=500          # Tier 3 LRU cache entries

# ─── Backup (optional) ─────────────────────────────
BACKUP_RETENTION_DAYS=7        # days to keep daily backups
```

## Performance

| Metric | Value |
|--------|-------|
| Message ingestion | <500ms |
| Context check (FTS5) | <50ms |
| SQLite query | <5ms |
| Memory usage | <150MB |
| Test suite | ~2s |

## Testing

```bash
npm test              # Run all tests
npm run test:watch    # Watch mode
npm run test:coverage # With coverage
```

## License

MIT — see [LICENSE](../LICENSE) for details.
