// ============ AI Tier Manager ============
// Central orchestrator that wraps every AI function with fallback logic.
// Implements 3-tier degradation strategy:
//   Tier 1: Full LLM AI (normal operation)
//   Tier 2: Heuristic fallbacks (LLM down)
//   Tier 3: LRU cache + safe defaults (everything down)
//
// Escalation thresholds:
//   1  consecutive failure  → Tier 2 for baseCooldown (default 30s)
//   3  consecutive failures → Tier 2 for 5 minutes
//   10 consecutive failures → Tier 3 for 15 minutes
//   Any success             → immediately reset to Tier 1

export type Tier = 1 | 2 | 3;
export type TierMode = 'auto' | 'tier1_only' | 'tier2_only' | 'tier3_only';

export interface TierStatus {
  currentTier: Tier;
  tierMode: TierMode;
  consecutiveFailures: number;
  totalFailures: number;
  totalSuccesses: number;
  cooldownUntil: number | null;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
}

// ============ Module state ============
let tierMode: TierMode = 'auto';
let baseCooldownSec = 30;

let currentTier: Tier = 1;
let consecutiveFailures = 0;
let totalFailures = 0;
let totalSuccesses = 0;
let cooldownUntil: number | null = null;
let lastFailureAt: number | null = null;
let lastSuccessAt: number | null = null;

let healthCheckInterval: ReturnType<typeof setInterval> | null = null;
let healthPingFn: (() => Promise<boolean>) | null = null;

// ============ Public API ============

export function initTierManager(opts: {
  mode?: TierMode;
  baseCooldownSec?: number;
}): void {
  tierMode = opts.mode || 'auto';
  baseCooldownSec = opts.baseCooldownSec || 30;
  console.log(`🎛️ [AI-Tier] Initialized: mode=${tierMode}, baseCooldown=${baseCooldownSec}s`);
}

/** Register a lightweight function that pings LLM health. Called every 60s during cooldown. */
export function registerHealthPing(fn: () => Promise<boolean>): void {
  healthPingFn = fn;
}

/** Returns the current active tier (1, 2, or 3). Respects cooldown expiry. */
export function getCurrentTier(): Tier {
  // Forced mode overrides everything
  if (tierMode === 'tier1_only') return 1;
  if (tierMode === 'tier2_only') return 2;
  if (tierMode === 'tier3_only') return 3;

  // Auto mode: check if cooldown has expired
  if (cooldownUntil !== null && Date.now() > cooldownUntil) {
    console.log('⏰ [AI-Tier] Cooldown expired → optimistically resetting to Tier 1');
    cooldownUntil = null;
    currentTier = 1;
    stopHealthCheck();
  }

  return currentTier;
}

/** Call this when a LLM API call succeeds. Immediately resets to Tier 1. */
export function reportSuccess(): void {
  totalSuccesses++;
  lastSuccessAt = Date.now();

  if (consecutiveFailures > 0 || currentTier !== 1) {
    console.log(`✅ [AI-Tier] LLM recovered after ${consecutiveFailures} failure(s) → Tier 1`);
  }

  consecutiveFailures = 0;
  currentTier = 1;
  cooldownUntil = null;
  stopHealthCheck();
}

/** Call this when a LLM API call fails. Escalates tier based on failure count. */
export function reportFailure(error?: Error | unknown): void {
  consecutiveFailures++;
  totalFailures++;
  lastFailureAt = Date.now();

  const errMsg = error instanceof Error ? error.message : String(error || 'unknown');

  if (consecutiveFailures >= 10) {
    const cooldownMs = 15 * 60 * 1000; // 15 minutes
    currentTier = 3;
    cooldownUntil = Date.now() + cooldownMs;
    console.error(`🚨 [AI-Tier] ${consecutiveFailures} consecutive failures → Tier 3 (15 min cooldown). ${errMsg}`);
  } else if (consecutiveFailures >= 3) {
    const cooldownMs = 5 * 60 * 1000; // 5 minutes
    currentTier = 2;
    cooldownUntil = Date.now() + cooldownMs;
    console.warn(`⚠️ [AI-Tier] ${consecutiveFailures} consecutive failures → Tier 2 (5 min cooldown). ${errMsg}`);
  } else {
    const cooldownMs = baseCooldownSec * 1000;
    currentTier = 2;
    cooldownUntil = Date.now() + cooldownMs;
    console.warn(`⚠️ [AI-Tier] Failure #${consecutiveFailures} → Tier 2 (${baseCooldownSec}s cooldown). ${errMsg}`);
  }

  startHealthCheck();
}

/** Returns current tier status for /api/ai-status endpoint. */
export function getAiStatus(): TierStatus {
  return {
    currentTier: getCurrentTier(),
    tierMode,
    consecutiveFailures,
    totalFailures,
    totalSuccesses,
    cooldownUntil,
    lastFailureAt,
    lastSuccessAt,
  };
}

// ============ Core: withFallback ============

/**
 * Wraps a function call with tier-based fallback logic.
 * - Auto mode: tries tier1 → tier2 → tier3 on failure
 * - Forced modes: uses only the specified tier (no fallback)
 */
export async function withFallback<T>(
  tier1Fn: () => Promise<T>,
  tier2Fn: () => Promise<T>,
  tier3Fn: () => Promise<T>
): Promise<T> {
  // Forced modes — no fallback
  if (tierMode === 'tier1_only') return tier1Fn();
  if (tierMode === 'tier2_only') return tier2Fn();
  if (tierMode === 'tier3_only') return tier3Fn();

  // Auto mode
  const tier = getCurrentTier();

  if (tier === 1) {
    try {
      return await tier1Fn();
      // Note: reportSuccess() is called inside callLLM() on API success
    } catch {
      // reportFailure() was already called inside callLLM() before the throw
      // Fall through to tier 2
    }
  }

  // At this point, either we started in tier 2/3 or tier 1 just failed
  if (getCurrentTier() <= 2) {
    try {
      return await tier2Fn();
    } catch (err2) {
      console.error('[AI-Tier] Tier 2 heuristic also failed:', err2);
      // Fall through to tier 3
    }
  }

  return tier3Fn();
}

// ============ Health Check (background ping) ============

function startHealthCheck(): void {
  if (healthCheckInterval !== null || healthPingFn === null) return;

  healthCheckInterval = setInterval(async () => {
    // Stop if already recovered
    if (currentTier === 1) {
      stopHealthCheck();
      return;
    }

    if (!healthPingFn) return;

    try {
      console.log('🏥 [AI-Tier] Health check ping...');
      const healthy = await healthPingFn();
      if (healthy) {
        console.log('💚 [AI-Tier] Health check passed → recovering to Tier 1');
        reportSuccess();
      } else {
        console.log('💔 [AI-Tier] Health check failed, staying in Tier', currentTier);
      }
    } catch {
      // Ping failed, stay in current tier
    }
  }, 60 * 1000); // every 60 seconds

  console.log('🏥 [AI-Tier] Started background health check (60s interval)');
}

function stopHealthCheck(): void {
  if (healthCheckInterval !== null) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    console.log('🏥 [AI-Tier] Stopped background health check');
  }
}
