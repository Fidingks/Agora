/**
 * Reputation system — pluggable trust module.
 *
 * Tracks per-agent reputation using a Bayesian-inspired formula
 * with Laplace smoothing:
 *
 *   score = (successes + 1) / (successes + failures + 2)
 *
 * This gives new agents a neutral 0.5, converges toward 1.0 with
 * consistent success, and toward 0.0 with consistent failure.
 *
 * Optional time-based decay pulls scores back toward 0.5 so agents
 * cannot ride on stale reputation forever.
 */

import type { AgentId } from "../core/identity.js";
import type { EventLog } from "../core/event-log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReputationRecord {
  readonly score: number;        // [0, 1]
  readonly successCount: number;
  readonly failureCount: number;
  readonly lastUpdated: number;  // Date.now()
}

// Internal mutable record for the store.
interface MutableRecord {
  successCount: number;
  failureCount: number;
  lastUpdated: number;
}

// ---------------------------------------------------------------------------
// Score computation
// ---------------------------------------------------------------------------

/** Laplace-smoothed Bayesian score. */
function computeScore(successes: number, failures: number): number {
  return (successes + 1) / (successes + failures + 2);
}

// ---------------------------------------------------------------------------
// ReputationStore
// ---------------------------------------------------------------------------

export class ReputationStore {
  private readonly _records = new Map<AgentId, MutableRecord>();
  readonly eventLog?: EventLog;

  constructor(eventLog?: EventLog) {
    this.eventLog = eventLog;
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  /**
   * Return the current reputation score for an agent.
   * Unknown agents get the default 0.5 (Laplace prior with 0 observations).
   */
  getReputation(agentId: AgentId): number {
    const rec = this._records.get(agentId);
    if (!rec) return computeScore(0, 0); // 0.5
    return computeScore(rec.successCount, rec.failureCount);
  }

  /**
   * Check whether an agent meets a minimum reputation threshold.
   * A `minScore` of 0 means the gate is disabled — everyone passes.
   */
  meetsMinimum(agentId: AgentId, minScore: number): boolean {
    if (minScore <= 0) return true;
    return this.getReputation(agentId) >= minScore;
  }

  /**
   * Return a snapshot of all tracked agents for debugging / logging.
   */
  snapshot(): Map<AgentId, ReputationRecord> {
    const out = new Map<AgentId, ReputationRecord>();
    for (const [id, rec] of this._records) {
      out.set(id, {
        score: computeScore(rec.successCount, rec.failureCount),
        successCount: rec.successCount,
        failureCount: rec.failureCount,
        lastUpdated: rec.lastUpdated,
      });
    }
    return out;
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  /** Record a successful trade for an agent. */
  recordSuccess(agentId: AgentId): void {
    const rec = this._getOrCreate(agentId);
    rec.successCount++;
    rec.lastUpdated = Date.now();
    this.eventLog?.emit("reputation", "reputation.success", [agentId], {
      successCount: rec.successCount,
      failureCount: rec.failureCount,
      score: computeScore(rec.successCount, rec.failureCount),
    });
  }

  /** Record a failed / disputed trade for an agent. */
  recordFailure(agentId: AgentId): void {
    const rec = this._getOrCreate(agentId);
    rec.failureCount++;
    rec.lastUpdated = Date.now();
    this.eventLog?.emit("reputation", "reputation.failure", [agentId], {
      successCount: rec.successCount,
      failureCount: rec.failureCount,
      score: computeScore(rec.successCount, rec.failureCount),
    });
  }

  // ------------------------------------------------------------------
  // Decay
  // ------------------------------------------------------------------

  /**
   * Apply time-based decay that moves the score toward the neutral 0.5.
   *
   * Formula:
   *   decayedScore = 0.5 + (score - 0.5) * exp(-decayRate * elapsedMs)
   *
   * We back-solve for the effective (successCount, failureCount) that
   * produce the decayed score so the record stays consistent.
   *
   * @param decayRate — per-millisecond rate constant (e.g. 0.001)
   * @param nowMs — current time; defaults to Date.now()
   */
  applyDecay(agentId: AgentId, decayRate: number, nowMs?: number): void {
    const rec = this._records.get(agentId);
    if (!rec) return; // nothing to decay for an unknown agent

    const now = nowMs ?? Date.now();
    const elapsedMs = now - rec.lastUpdated;
    if (elapsedMs <= 0) return;

    const currentScore = computeScore(rec.successCount, rec.failureCount);
    const decayedScore = 0.5 + (currentScore - 0.5) * Math.exp(-decayRate * elapsedMs);

    // Back-solve: given total = successes + failures, find new split that
    // yields the decayed score under Laplace smoothing.
    //   decayedScore = (s + 1) / (total + 2)
    //   s = decayedScore * (total + 2) - 1
    const total = rec.successCount + rec.failureCount;
    const newSuccesses = Math.max(0, decayedScore * (total + 2) - 1);
    const newFailures = Math.max(0, total - newSuccesses);

    rec.successCount = newSuccesses;
    rec.failureCount = newFailures;
    rec.lastUpdated = now;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private _getOrCreate(agentId: AgentId): MutableRecord {
    let rec = this._records.get(agentId);
    if (!rec) {
      rec = { successCount: 0, failureCount: 0, lastUpdated: Date.now() };
      this._records.set(agentId, rec);
    }
    return rec;
  }
}

// ---------------------------------------------------------------------------
// Integration hook — stateless helper that escrow.ts (or others) can call
// ---------------------------------------------------------------------------

/**
 * Check whether an agent should be allowed to trade given a reputation store
 * and a minimum score threshold.
 */
export function shouldAllowTrade(
  store: ReputationStore,
  agentId: AgentId,
  minScore: number,
): boolean {
  return store.meetsMinimum(agentId, minScore);
}
