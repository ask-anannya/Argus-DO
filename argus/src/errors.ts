// ============ Error Handling Utilities ============
// Centralized utilities reused across gradient.ts, db.ts, and server.ts:
//   fetchWithTimeout — fetch with AbortController deadline
//   withRetry        — retry with exponential backoff (1 retry, 45s total budget)
//   safeAsync        — catch-and-fallback wrapper with optional dead-letter logging
//   logDeadLetter    — append failed writes to data/dead-letter.jsonl for recovery
//   Custom error classes: TimeoutError, LLMApiError, ElasticError

import * as fs from 'fs';
import * as path from 'path';

// ============ Custom Error Classes ============

export class TimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeoutError';
  }
}

export class LLMApiError extends Error {
  status: number;
  retryable: boolean;
  constructor(message: string, status: number, retryable?: boolean) {
    super(message);
    this.name = 'LLMApiError';
    this.status = status;
    // 5xx and 429 are retryable; 4xx (except 429) are client errors, not retryable
    this.retryable = retryable ?? (status >= 500 || status === 429);
  }
}

export class ElasticError extends Error {
  operation: string;
  index: string;
  constructor(message: string, operation: string, index: string) {
    super(message);
    this.name = 'ElasticError';
    this.operation = operation;
    this.index = index;
  }
}

// ============ fetchWithTimeout ============

/**
 * Wraps fetch() with an AbortController-based timeout.
 * Throws TimeoutError if the request doesn't complete within timeoutMs.
 * Cleans up the timer on success to prevent leaks.
 */
export async function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 30000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new TimeoutError(`Request timed out after ${timeoutMs}ms: ${url}`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ============ withRetry ============

export interface RetryOptions {
  maxRetries?: number;       // default 1 (prevents retry stacking)
  firstTimeoutMs?: number;   // default 30000ms for first attempt
  retryTimeoutMs?: number;   // default 15000ms for retry (total budget: 45s max)
  baseDelayMs?: number;      // default 500ms (doubles per attempt: 500ms, 1000ms)
  shouldRetry?: (err: unknown) => boolean;
}

function defaultShouldRetry(err: unknown): boolean {
  if (err instanceof TimeoutError) return true;
  if (err instanceof LLMApiError) return err.retryable;
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    return (
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('network') ||
      msg.includes('fetch failed') ||
      msg.includes('socket hang up') ||
      msg.includes('connect etimedout')
    );
  }
  return false;
}

/**
 * Retries an async function with exponential backoff.
 * fn receives the applicable timeout for each attempt:
 *   - attempt 0: firstTimeoutMs (30s)
 *   - attempt 1+: retryTimeoutMs (15s) — caps total budget at ~45s
 * Only retries on network/timeout/5xx errors, never on 4xx client errors.
 */
export async function withRetry<T>(
  fn: (timeoutMs: number) => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const maxRetries    = options.maxRetries    ?? 1;
  const firstTimeout  = options.firstTimeoutMs ?? 30000;
  const retryTimeout  = options.retryTimeoutMs ?? 15000;
  const baseDelay     = options.baseDelayMs    ?? 500;
  const shouldRetry   = options.shouldRetry    ?? defaultShouldRetry;

  let lastError: unknown;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    const timeoutMs = attempt === 0 ? firstTimeout : retryTimeout;
    try {
      return await fn(timeoutMs);
    } catch (err) {
      lastError = err;
      if (attempt < maxRetries && shouldRetry(err)) {
        const delay = baseDelay * Math.pow(2, attempt); // 500ms, 1000ms, ...
        const msg = err instanceof Error ? err.message.slice(0, 80) : String(err);
        console.warn(`[withRetry] Attempt ${attempt + 1}/${maxRetries + 1} failed: ${msg} — retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        break;
      }
    }
  }

  throw lastError;
}

// ============ safeAsync ============

export interface SafeAsyncOptions {
  deadLetter?: boolean;  // log payload to dead-letter file on failure
  payload?: unknown;     // the data to include in the dead-letter entry
}

/**
 * Wraps an async function with try-catch, logs the error, and returns fallback.
 * If DEBUG_ERRORS=true env var is set, re-throws instead of swallowing (for development).
 * If deadLetter=true and payload is provided, appends to data/dead-letter.jsonl.
 */
export async function safeAsync<T>(
  fn: () => Promise<T>,
  fallback: T,
  context: string,
  opts: SafeAsyncOptions = {}
): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`❌ [${context}] ${msg}`);

    if (opts.deadLetter && opts.payload !== undefined) {
      logDeadLetter(context, opts.payload, err);
    }

    if (process.env.DEBUG_ERRORS === 'true') {
      throw err; // Surfaces bugs during development instead of silently returning fallback
    }

    return fallback;
  }
}

// ============ logDeadLetter ============

const DEAD_LETTER_PATH = path.join(process.cwd(), 'data', 'dead-letter.jsonl');
const DEAD_LETTER_MAX_BYTES = 10 * 1024 * 1024; // 10 MB — rotate beyond this

/**
 * Appends a failed write operation to data/dead-letter.jsonl (one JSON object per line).
 * Enables recovery: each entry contains enough data to replay the failed write.
 * Auto-rotates to dead-letter.jsonl.old when the file exceeds 10 MB.
 */
export function logDeadLetter(operation: string, data: unknown, error: unknown): void {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      operation,
      data,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    };

    fs.mkdirSync(path.dirname(DEAD_LETTER_PATH), { recursive: true });

    // Auto-rotate if > 10 MB
    try {
      if (fs.statSync(DEAD_LETTER_PATH).size > DEAD_LETTER_MAX_BYTES) {
        fs.renameSync(DEAD_LETTER_PATH, DEAD_LETTER_PATH + '.old');
        console.log('[DeadLetter] Rotated dead-letter file (exceeded 10 MB)');
      }
    } catch { /* file doesn't exist yet — first entry */ }

    fs.appendFileSync(DEAD_LETTER_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    console.warn(`[DeadLetter] "${operation}" failed — entry saved to dead-letter.jsonl`);
  } catch (writeErr) {
    console.error('[DeadLetter] Could not write dead-letter entry:', writeErr);
  }
}

// ============ logFailedReminder ============

const FAILED_REMINDERS_PATH = path.join(process.cwd(), 'data', 'failed-reminders.jsonl');

/**
 * Appends a permanently-failed reminder to data/failed-reminders.jsonl.
 * Called after MAX_ATTEMPTS retries have all failed.
 * Each entry: { timestamp, eventId, eventTitle, triggerType, attempts, lastError }
 * Auto-rotates to failed-reminders.jsonl.old when > 10 MB.
 */
export function logFailedReminder(
  payload: { id: number; title: string; triggerType: string },
  attempts: number,
  lastError: unknown
): void {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      eventId: payload.id,
      eventTitle: payload.title,
      triggerType: payload.triggerType,
      attempts,
      lastError: lastError instanceof Error ? lastError.message : String(lastError),
    };

    fs.mkdirSync(path.dirname(FAILED_REMINDERS_PATH), { recursive: true });

    // Auto-rotate if > 10 MB
    try {
      if (fs.statSync(FAILED_REMINDERS_PATH).size > DEAD_LETTER_MAX_BYTES) {
        fs.renameSync(FAILED_REMINDERS_PATH, FAILED_REMINDERS_PATH + '.old');
        console.log('[FailedReminders] Rotated file (exceeded 10 MB)');
      }
    } catch { /* file doesn't exist yet — first entry */ }

    fs.appendFileSync(FAILED_REMINDERS_PATH, JSON.stringify(entry) + '\n', 'utf-8');
    console.warn(`[FailedReminders] Event "${payload.title}" (id: ${payload.id}) permanently failed after ${attempts} attempt(s)`);
  } catch (writeErr) {
    console.error('[FailedReminders] Could not write entry:', writeErr);
  }
}
