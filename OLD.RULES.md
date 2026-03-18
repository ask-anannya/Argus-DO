# Argus - Project Rules

## CRITICAL: AI Assistant Rules (READ FIRST)

These rules MUST be followed by AI assistants working on this project:

### Mandatory Workflow
1. **ALWAYS update CHANGELOG.md** - Before ANY commit, add entry at TOP
2. **ALWAYS run tests** - After code changes: `npm test`
3. **ALWAYS commit and push** - Never leave uncommitted work
4. **ALWAYS update docs** - INFO.md, RULES.md when making changes

### Quick Reference
```bash
# After making changes:
npm test                    # Run tests (must pass)
# Update CHANGELOG.md       # Add entry at TOP
git add -A && git commit -m "type(scope): description"
git push origin main
```

### Documentation Updates Required
| Change Type | Update These Files |
|-------------|-------------------|
| New feature | CHANGELOG.md, INFO.md |
| Bug fix | CHANGELOG.md |
| Config change | CHANGELOG.md, README.md (if user-facing) |
| New rule/learning | CHANGELOG.md, RULES.md |
| Version bump | CHANGELOG.md, INFO.md, src/server.ts banner |

### Version Info
- **Current Version**: v0.7.8
- **LLM Model**: Gemini 3 Flash Preview (`gemini-3-flash-preview`)
- **Tests**: 237 passing

---

## Core Principles

1. **Deterministic Execution** - No guessing, no invention, no assumptions
2. **Pipeline Compliance** - Follow the exact flow defined in `aidata/prompt.md`
3. **Structured Output** - All LLM outputs must be valid JSON
4. **Latest Dependencies** - Always use up-to-date libraries and tools
5. **Type Safety** - Use Zod for runtime validation, TypeScript for static types

---

## AI Development Rules

### Web Search
- AI assistants CAN search the web for latest documentation
- AI assistants SHOULD verify library versions before suggesting
- AI assistants MUST prefer official documentation sources
- AI assistants SHOULD check npm for latest package versions

### Code Generation
- AI MUST use latest stable versions of libraries
- AI MUST validate generated code against project patterns
- AI MUST run tests after code changes
- AI MUST update documentation files on structural changes

---

## Runtime Constraints

### Allowed Technologies (Latest Versions)
| Technology | Minimum Version | Purpose |
|------------|-----------------|---------|
| Node.js | 22.x | Runtime |
| TypeScript | 5.8.x | Language |
| Express.js | 5.x | Web framework |
| better-sqlite3 | 12.x | Database |
| OpenAI SDK | 4.96.x | LLM integration |
| Vitest | 3.x | Testing |
| Zod | 3.24.x | Validation |
| Redis (ioredis) | 5.x | Message broker |

### NOT Allowed
- Other messaging APIs (only Evolution API)
- Cloud databases in user containers (use file-based)
- Jest (use Vitest instead)
- Any deprecated packages
- Direct WhatsApp Web scraping

---

## Multi-Container Architecture Rules

### Container Isolation
- Each user gets ONE dedicated container
- User data NEVER shared between containers
- Containers communicate ONLY through orchestrator/Redis
- Container crashes must NOT affect other users

### Orchestrator Responsibilities
- Manage container lifecycle (create/stop/restart)
- Handle all push notifications
- Provide dashboard API
- Monitor container health
- Route inter-container messages

### User Container Responsibilities
- Process messages for ONE user only
- Maintain user's SQLite database
- Maintain user's vector store
- Send events to orchestrator for notifications

---

## LLM Usage Rules

### Gemini 3 Models (Primary - via OpenAI-compatible API)
| Model | ID | Use Case |
|-------|-----|----------|
| Gemini 3 Flash Preview | `gemini-3-flash-preview` | Speed + intelligence (recommended) |
| Gemini 3 Pro Preview | `gemini-3-pro-preview` | Most powerful, best for complex tasks |

Configuration via `.env`:
```bash
GEMINI_MODEL=gemini-3-flash-preview  # or gemini-3-pro-preview
```

### Fallback Models (OpenAI)
| Model | Purpose |
|-------|---------|
| `gpt-4o-mini` | Classification (efficient) |
| `gpt-4o` | Extraction (capable) |

### Small LLM (Classification Only)
- Model: `gpt-4o-mini` (latest efficient model)
- Purpose: Event type classification
- Output: Single classification with confidence
- Token budget: < 500 tokens

### Big LLM (Extraction Only)
- Model: `gpt-4o` (latest capable model)
- Purpose: Structured data extraction
- Output: JSON schema only (use response_format)
- Token budget: As needed (with compression)

### Embedding Model
- Model: `text-embedding-3-small`
- Purpose: Vector similarity search
- Dimensions: 1536

---

## Schema Validation Rules

### Use Zod for All External Data
```typescript
// Always validate incoming data
const result = SomeSchema.safeParse(data);
if (!result.success) {
  // Handle validation error
}
```

### Schema Definitions
- Define all schemas in `src/shared/types.ts`
- Export both schema and inferred type
- Use `.nullable()` for optional fields
- Use `.min()/.max()` for numeric constraints

---

## Token Compression Rules

### MUST Compress When
- Context exceeds `TOKEN_THRESHOLD` (default: 2000 tokens)
- Multiple messages (>1) in context

### NEVER Compress
- Single messages
- Structured JSON
- Already compressed content

### Token Estimation
- Use `tiktoken` for accurate counts
- Fallback: ~4 characters per token

---

## Output Rules

### All LLM Outputs MUST
- Be valid JSON (use `response_format: { type: 'json_object' }`)
- Follow the defined Zod schema exactly
- Include confidence scores (0-1)

### All LLM Outputs MUST NOT
- Contain prose or explanations
- Contain markdown formatting
- Contain comments or emojis
- Contain assumed/inferred data

### Missing Data Handling
- If data missing → set to `null`
- If confidence low → set `confidence < 0.5`

---

## Event Type Definitions

| Type | When to Use |
|------|-------------|
| `new_event` | New event detected, no prior record |
| `update_event` | Modification to existing event |
| `signal_event` | Condition trigger for pending event |
| `irrelevant` | Not event-related |

---

## Database Rules

### SQLite (Per User Container)
- Single file database per user
- Path: `./data/db/events.db`
- Use WAL mode for performance
- Use transactions for multi-step operations
- Use prepared statements (prevent SQL injection)

### Database Cleanup Guide

When resetting the database for fresh testing, preserve valuable data:

| Table | Action | Reason |
|-------|--------|--------|
| `messages` | **KEEP** | Original WhatsApp messages |
| `learned_patterns` | **KEEP** | Auto-learned extraction patterns (valuable) |
| `contacts` | **KEEP** | Contact information |
| `push_subscriptions` | **KEEP** | Browser push subscriptions |
| `events` | CLEAR | Can regenerate from messages |
| `reminders` | CLEAR | Old scheduled reminders |
| `pipeline_logs` | CLEAR | Debug/audit logs |
| `llm_extraction_logs` | CLEAR | LLM call logs |
| `llm_calls` | CLEAR | LLM API call logs (v0.7.8) |
| `pattern_learning_runs` | CLEAR | Learning job history |
| `archive_metadata` | CLEAR | Archive tracking |

**Quick cleanup command:**
```bash
sqlite3 data/db/events.db "
DELETE FROM events;
DELETE FROM reminders;
DELETE FROM pipeline_logs;
DELETE FROM llm_extraction_logs;
DELETE FROM llm_calls;
DELETE FROM pattern_learning_runs;
DELETE FROM archive_metadata;
VACUUM;
"

# Also reset metrics
curl -X POST http://localhost:3000/api/metrics/reset
```

### Vector Store (Per User Container)
- File-backed index
- Path: `./data/vectors/`
- Use cosine similarity
- Regenerate on schema changes

### Redis (Orchestrator)
- Pub/Sub for container events
- Hash storage for user/container data
- List storage for push subscriptions

---

## Code Style Rules

### TypeScript
- Strict mode enabled
- NO `any` types (use `unknown` + validation)
- Use Zod inferred types
- Async/await over callbacks
- ES modules (not CommonJS)

### Error Handling
- Never swallow errors silently
- Log all errors with context
- Return structured error responses
- Use `safeParse` for validation

### Naming
- camelCase for variables/functions
- PascalCase for classes/interfaces/schemas
- UPPER_SNAKE_CASE for constants
- Descriptive names, no abbreviations

### Imports
- Use `.js` extension for local imports
- Group: external → internal → types
- Use named exports (not default)

---

## Pipeline Execution Rules

### Order of Operations
1. Receive webhook
2. Validate payload (Zod)
3. Store raw message
4. Heuristic gate
5. Small LLM classification
6. Context building
7. Token estimation/compression
8. Big LLM extraction
9. Validate extraction (Zod)
10. Event routing
11. Database operations
12. Vector operations
13. Notify orchestrator
14. Schedule reminders

### DO NOT
- Skip steps
- Reorder steps
- Add steps without documentation
- Process without logging

---

## Testing Rules

### Framework
- Use Vitest (NOT Jest)
- Minimum 70% coverage target
- Tests in `tests/` directory

### Test Types
| Type | Location | Purpose |
|------|----------|---------|
| Unit | `tests/unit/` | Individual functions |
| Integration | `tests/integration/` | Module interaction |
| E2E | `tests/e2e/` | Full flow testing |

### Mocking
- Mock external APIs (OpenAI, Redis)
- Use in-memory SQLite for DB tests
- Use msw for HTTP mocking

---

## Documentation Rules

| File | Update When |
|------|-------------|
| `INFO.md` | Structural changes, new modules |
| `RULES.md` | Policy changes, new rules |
| `CHANGELOG.md` | Any code change (prepend) |
| `aidata/prompt.md` | Pipeline logic changes |

---

## Git Rules

### Commit Discipline
- **ALWAYS commit after completing a task** - Never leave uncommitted work
- **ALWAYS push after committing** - Keep remote in sync
- Meaningful commit messages (conventional commits format)
- One logical change per commit
- Update CHANGELOG.md before committing

### Commit Message Format
```
type(scope): description

[optional body]
[optional footer]
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `docs`: Documentation only
- `style`: Formatting, no code change
- `refactor`: Code restructuring
- `test`: Adding/fixing tests
- `chore`: Maintenance tasks

Examples:
```bash
git commit -m "feat(learning): add auto-learning pattern system"
git commit -m "fix(pipeline): handle null time extraction"
git commit -m "docs: update architecture diagrams for v0.5.0"
git commit -m "test(ruleEngine): add Hindi time pattern tests"
```

### Branch Strategy
- `main` - Production-ready code
- `develop` - Integration branch
- `feature/*` - New features
- `fix/*` - Bug fixes
- `docs/*` - Documentation updates

### Workflow
```bash
# Before starting work
git pull origin main

# After completing a task
git add .
git commit -m "type(scope): description"
git push origin main  # or feature branch

# Create PR for feature branches
gh pr create --title "feat: description" --body "## Summary\n- Change 1\n- Change 2"
```

### Prohibited Actions
- Never commit `.env` files or secrets
- Never force push to main (`--force`)
- Never commit with `--no-verify` (skips hooks)
- Never commit large binary files
- Never commit `node_modules/`

### .gitignore Must Include
```
node_modules/
dist/
.env
.env.*
*.log
data/db/*.db
data/vectors/
logs/
.DS_Store
*.sqlite
```

---

## Security Rules

### Secrets
- Never log API keys
- Never commit `.env` files
- Use environment variables only
- Rotate keys regularly

### Input Validation
- Validate ALL webhook inputs (Zod)
- Sanitize database inputs (prepared statements)
- Validate container IDs before operations

### Network
- Rate limit API endpoints
- Use HTTPS in production
- Validate WebSocket origins
- Authenticate inter-container communication

---

## Container Security

### User Containers
- Run as non-root user
- Read-only filesystem (except /data)
- Resource limits (CPU, memory)
- Network isolation

### Orchestrator
- Authenticate internal API calls
- Validate container commands
- Log all container operations
- Monitor for anomalies

---

## Common Mistakes to Avoid

### Testing Mistakes
| Mistake | Solution |
|---------|----------|
| Using `vi.advanceTimersByTime()` without `vi.useFakeTimers()` | Use real delays with `await new Promise(resolve => setTimeout(resolve, ms))` or call `vi.useFakeTimers()` first |
| Forgetting to reset singleton state between tests | Always call `reset()` in `beforeEach` for singletons like MetricsCollector |
| Not mocking external dependencies | Mock OpenAI, Redis, and other external APIs in test setup |
| Using Jest APIs in Vitest | Use Vitest equivalents (`vi.fn()` instead of `jest.fn()`) |

### TypeScript Mistakes
| Mistake | Solution |
|---------|----------|
| Importing but not using variables | Remove unused imports or use them (LSP will flag these) |
| Using `config` import when not needed | Only import what you use from config module |
| Forgetting `.js` extension in imports | Always use `.js` extension for local imports (ES modules) |

### Documentation Mistakes
| Mistake | Solution |
|---------|----------|
| Not updating CHANGELOG.md | Add entry at TOP of file for every code change |
| Not updating RULES.md with learnings | Add new rules/mistakes as they're discovered |
| Forgetting to update version in banner | Update version in `src/server.ts` startup banner |

### Metrics/Monitoring Mistakes
| Mistake | Solution |
|---------|----------|
| Division by zero in rate calculations | Always use `|| 1` fallback: `const rate = count / (total \|\| 1)` |
| Unbounded array growth for timing data | Use ring buffer with fixed size (e.g., 1000 entries) |
| Not recording errors in metrics | Call `metrics.recordError()` in catch blocks |

### Pipeline Mistakes
| Mistake | Solution |
|---------|----------|
| Not tracking timing at each stage | Use `Timer` class with marks for each pipeline stage |
| Skipping LLM when rule engine confidence is low | Only skip LLM when `confidence >= 0.75 AND hasTime` |
| Not recording whether rule engine or LLM handled extraction | Call appropriate `recordRuleEngineExtraction()` or `recordLlmExtraction()` |

---

## Metrics Best Practices

### Counter Naming
- Use descriptive names: `messagesProcessed`, not `msgCnt`
- Group related counters: `eventsCreated`, `eventsUpdated`
- Separate success/failure: `llmExtractions`, `llmSkipped`

### Rate Calculations
```typescript
// Always prevent division by zero
const rate = count / (total || 1);

// Round to 2 decimal places for display
const displayRate = Math.round(rate * 100) / 100;
```

### Timing Measurements
```typescript
// Use Timer class for precise measurements
const timer = createTimer();
// ... do work ...
timer.mark('step1');
// ... more work ...
timer.mark('step2');

// Record timing
metrics.recordTiming({
  heuristic: timer.duration('start', 'step1'),
  ruleEngine: timer.duration('step1', 'step2'),
  total: timer.elapsed()
});
```

### Periodic Logging
- Default interval: 5 minutes
- Log final summary on shutdown
- Configurable via `METRICS_LOG_INTERVAL` env var
- Set to 0 to disable

---

## Logging Best Practices (v0.7.8)

### Use Loud Logger for Visibility
```typescript
import { logStep, logLLM, logError, logSuccess, logWarn } from '../utils/loudLogger.js';

// Pipeline steps
logStep('HEURISTIC', 'passed', { score: 12.5 });

// LLM calls (logs to console + file + DB)
logLLM('classification', {
  model: 'gemini-3-flash-preview',
  prompt: 'Classify this message...',
  response: '{"event_type": "new_event"}',
  tokens: { prompt: 100, completion: 50 },
  duration_ms: 250
});

// Errors - YELL loudly
logError('EXTRACTION', 'Failed to parse JSON', { response: rawResponse });

// Success
logSuccess('EVENT_CREATED', { id: 'abc123', title: 'Meeting' });

// Warnings
logWarn('LOW_CONFIDENCE', { confidence: 0.4 });
```

### Store LLM Calls in Database
```typescript
import { storeLLMCall } from '../database/sqlite.js';

await storeLLMCall({
  id: crypto.randomUUID(),
  message_id: messageId,
  call_type: 'classification',
  model: 'gemini-3-flash-preview',
  provider: 'gemini',
  prompt: fullPrompt,
  response: rawResponse,
  response_parsed: JSON.stringify(parsed),
  finish_reason: 'stop',
  tokens_prompt: usage.prompt_tokens,
  tokens_completion: usage.completion_tokens,
  tokens_total: usage.total_tokens,
  duration_ms: endTime - startTime,
  success: 1,
  error: null,
  created_at: new Date().toISOString()
});
```

### Log File Locations
| File | Purpose |
|------|---------|
| `data/logs/pipeline.log` | All pipeline events |
| `data/logs/llm.log` | LLM calls summary |
| `data/logs/llm-full.log` | Full prompts and responses |
| `data/logs/errors.log` | All errors (easy to grep) |
| `data/logs/warnings.log` | All warnings |
| `data/logs/message-flow.log` | Message tracking |

### Quick Debug Commands
```bash
# Check recent errors
cat data/logs/errors.log | tail -20

# Check LLM calls
sqlite3 data/db/events.db "SELECT id, call_type, model, success, error FROM llm_calls ORDER BY created_at DESC LIMIT 10;"

# Watch pipeline in real-time
tail -f data/logs/pipeline.log

# Check LLM full responses
cat data/logs/llm-full.log | tail -50
```
