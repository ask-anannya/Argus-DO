ALWAYS USE THIS FILE FOR RULES

## Project Location
- Main code: `./argus/`
- Documentation: `./INFO.md`, `./aidata/`

## Git Workflow
- ALWAYS commit and push code after making changes
- Use descriptive commit messages
- Keep MD files (RULES.md, INFO.md, CHANGELOG.md) up to date with changes

## Changelog
MAINTAIN a changelog file : APPEND only : AT TOP OF FILE : `argus/CHANGELOG.md`

## Environment
- DO NOT DELETE ANYTHING FROM .ENV : MARK AS IGNORE IF NOT IN USE
- DO NOT USE OPENAI EMBEDDINGS ANYMORE : MARK AS IGNORE IF IN .ENV
- Copy `.env.example` to `.env` for new setups

## Documentation
- KEEP README FILE UP TO DATE
- DO NOT EDIT ANYTHING IN `aidata/*` FILES
- Only edit: README.md, RULES.md, CHANGELOG.md, INFO.md

## Development Commands
```bash
cd argus

# Development
npm install          # Install dependencies
npm run dev          # Start with hot reload
npm test             # Fast tests (~2s)
npm run lint         # Lint code (cached)
npm run format       # Format code
npm run typecheck    # Type check

# Production
npm run build        # Build TypeScript
npm start            # Run production

# Docker
docker-compose up -d # Start all services
```

## Chrome Extension
```bash
# Convert SVG to PNG (if icons change)
cd argus/extension/icons
convert -background none icon.svg -resize 16x16 icon16.png
convert -background none icon.svg -resize 32x32 icon32.png
convert -background none icon.svg -resize 48x48 icon48.png
convert -background none icon.svg -resize 128x128 icon128.png

# Load extension:
# 1. chrome://extensions/
# 2. Enable Developer mode
# 3. Load unpacked → select argus/extension/
```

## Server
- NEVER restart, run, or kill the server — it is already running and auto-restarts on rebuild
- Only run `npx tsc` to rebuild; the server picks up changes automatically
- Do NOT use `node dist/server.js`, `npm run dev`, `kill`, or any server start/stop commands

## Architecture Constraints
- **Elasticsearch (Serverless)** used for ALL data storage and search
- **Hybrid Search**: Keyword + Semantic (Vector) search for context matching
- **Gemini 3 Flash Preview** (via Google AI Studio or Elastic Inference)
- **Agent Builder**: Agents defined via Elastic Agent Builder (optional MCP integration)
- 90-day hot window for context
- Single container per user
- URL detection + DOM form watching
- QuickSave context compression (S2A filter + dense format) for all Gemini prompts

## QuickSave Integration (src/quicksave.ts)
- S2A Filter: ranks events by signal (time relevance, status, recency) → top N only
- Dense Format: `#ID|TYPE|STATUS|"Title"|time|loc|sender|keywords` (~40-55% fewer tokens)
- L2 Edge Detection: cross-event relationships (cancels, conflicts, same_topic)
- Chat Memory: older chat turns compressed into memory packet for session continuity
- Based on CEP v9.1 by Kevin Tan (ktg.one)
- NEVER modify the QuickSave protocol spec files in `quicksave/` — they are reference only

## Testing Strategy
- Vitest with single fork (fast)
- Dot reporter (minimal output)
- Cache enabled for speed
- Target: <3s test runs

## Docker Images (Pre-built)
```yaml
node:22-alpine              # Argus runtime
atendai/evolution-api:v2.1.1 # WhatsApp bridge
postgres:16-alpine          # Evolution DB
# elasticsearch:8.15.0       # (Optional) Local Dev only
```

## API Endpoints
| Endpoint | Method | Purpose |
|----------|--------|---------|
| /api/health | GET | Health check |
| /api/stats | GET | Get statistics |
| /api/events | GET | List events (filter by status) |
| /api/events/:id/set-reminder | POST | Schedule event (discovered → scheduled) |
| /api/events/:id/snooze | POST | Snooze event for X minutes |
| /api/events/:id/ignore | POST | Ignore event (hide without delete) |
| /api/events/:id/complete | POST | Mark done |
| /api/events/:id/dismiss | POST | Dismiss notification |
| /api/events/:id/acknowledge | POST | Acknowledge reminder |
| /api/events/:id | DELETE | Delete event permanently |
| /api/events/:id | PATCH | Update event fields (CRUD) |
| /api/events/:id/confirm-update | POST | Confirm a pending modify action |
| /api/events/day/:timestamp | GET | Get all events for a day (reschedule view) |
| /api/webhook/whatsapp | POST | WhatsApp webhook |
| /api/context-check | POST | Check URL context |
| /api/form-check | POST | Check form field mismatch (insurance accuracy) |
| /api/chat | POST | AI Chat - context-aware conversation |
| /ws | WS | Real-time notifications |

## Chrome Extension Components
- **manifest.json** - Manifest V3, sidePanel permission, no `"type": "module"` in background
- **background.js** - Service worker: WebSocket, API calls, sidePanel handler
- **content.js** - Dynamic popups overlay (8 types: discovery, reminder, context, conflict, insight, snooze, update_confirm, form_mismatch), toast notifications, DOM form watcher for insurance accuracy
- **sidepanel.html/js** - AI Chat sidebar with markdown rendering
- **popup.html/js** - Extension popup with event cards and stats

## Event Status Lifecycle
```
discovered → scheduled → reminded → completed
         ↓           ↓
      snoozed     snoozed
         ↓           ↓
      ignored     expired
```

