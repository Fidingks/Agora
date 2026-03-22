/**
 * Reputation system unit tests.
 *
 * Covers: default scores, success/failure recording, Bayesian convergence,
 * minimum-score gating, time-based decay, snapshot, multi-agent isolation,
 * and edge cases.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { ReputationStore, shouldAllowTrade } from "../src/protocols/reputation.js";
import { toAgentId } from "../src/core/identity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = toAgentId("alice");
const BOB = toAgentId("bob");
const CHARLIE = toAgentId("charlie");

function freshStore(): ReputationStore {
  return new ReputationStore();
}

/** Bayesian score helper — mirrors the formula in reputation.ts */
function bayesian(successes: number, failures: number): number {
  return (successes + 1) / (successes + failures + 2);
}

// ---------------------------------------------------------------------------
// Default score for new agents
// ---------------------------------------------------------------------------

describe("ReputationStore — default score", () => {
  it("returns 0.5 for an unknown agent", () => {
    const store = freshStore();
    expect(store.getReputation(ALICE)).toBe(0.5);
  });

  it("returns 0.5 for any agent that has never been recorded", () => {
    const store = freshStore();
    store.recordSuccess(ALICE); // only alice has history
    expect(store.getReputation(BOB)).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Recording successes
// ---------------------------------------------------------------------------

describe("ReputationStore — recordSuccess", () => {
  it("increases reputation toward 1.0", () => {
    const store = freshStore();
    store.recordSuccess(ALICE);
    const score = store.getReputation(ALICE);
    // (1+1)/(1+0+2) = 2/3 ≈ 0.6667
    expect(score).toBeCloseTo(bayesian(1, 0), 10);
    expect(score).toBeGreaterThan(0.5);
  });

  it("converges toward 1.0 with many successes", () => {
    const store = freshStore();
    for (let i = 0; i < 100; i++) store.recordSuccess(ALICE);
    const score = store.getReputation(ALICE);
    // (100+1)/(100+0+2) = 101/102 ≈ 0.9902
    expect(score).toBeCloseTo(bayesian(100, 0), 10);
    expect(score).toBeGreaterThan(0.99);
  });
});

// ---------------------------------------------------------------------------
// Recording failures
// ---------------------------------------------------------------------------

describe("ReputationStore — recordFailure", () => {
  it("decreases reputation toward 0.0", () => {
    const store = freshStore();
    store.recordFailure(ALICE);
    const score = store.getReputation(ALICE);
    // (0+1)/(0+1+2) = 1/3 ≈ 0.3333
    expect(score).toBeCloseTo(bayesian(0, 1), 10);
    expect(score).toBeLessThan(0.5);
  });

  it("converges toward 0.0 with many failures", () => {
    const store = freshStore();
    for (let i = 0; i < 100; i++) store.recordFailure(ALICE);
    const score = store.getReputation(ALICE);
    // (0+1)/(0+100+2) = 1/102 ≈ 0.0098
    expect(score).toBeCloseTo(bayesian(0, 100), 10);
    expect(score).toBeLessThan(0.01);
  });
});

// ---------------------------------------------------------------------------
// Mixed successes and failures
// ---------------------------------------------------------------------------

describe("ReputationStore — mixed outcomes", () => {
  it("converges to the correct Bayesian score for 7 successes, 3 failures", () => {
    const store = freshStore();
    for (let i = 0; i < 7; i++) store.recordSuccess(ALICE);
    for (let i = 0; i < 3; i++) store.recordFailure(ALICE);
    // (7+1)/(7+3+2) = 8/12 ≈ 0.6667
    expect(store.getReputation(ALICE)).toBeCloseTo(bayesian(7, 3), 10);
  });

  it("converges to the correct Bayesian score for equal successes and failures", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) {
      store.recordSuccess(ALICE);
      store.recordFailure(ALICE);
    }
    // (10+1)/(10+10+2) = 11/22 = 0.5
    expect(store.getReputation(ALICE)).toBeCloseTo(0.5, 10);
  });
});

// ---------------------------------------------------------------------------
// meetsMinimum
// ---------------------------------------------------------------------------

describe("ReputationStore — meetsMinimum", () => {
  it("returns true when score is above minScore", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.recordSuccess(ALICE);
    // score ≈ 0.917 — well above 0.6
    expect(store.meetsMinimum(ALICE, 0.6)).toBe(true);
  });

  it("returns false when score is below minScore", () => {
    const store = freshStore();
    for (let i = 0; i < 5; i++) store.recordFailure(ALICE);
    // score ≈ 0.143
    expect(store.meetsMinimum(ALICE, 0.3)).toBe(false);
  });

  it("returns true when score exactly equals minScore", () => {
    const store = freshStore();
    // Default is 0.5; set min to 0.5
    expect(store.meetsMinimum(ALICE, 0.5)).toBe(true);
  });

  it("returns true for any agent when minScore is 0 (disabled)", () => {
    const store = freshStore();
    // Even an agent with terrible reputation passes when gate is disabled
    for (let i = 0; i < 50; i++) store.recordFailure(BOB);
    expect(store.meetsMinimum(BOB, 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Decay
// ---------------------------------------------------------------------------

describe("ReputationStore — applyDecay", () => {
  it("moves a high score toward 0.5 over time", () => {
    const store = freshStore();
    for (let i = 0; i < 20; i++) store.recordSuccess(ALICE);
    const scoreBefore = store.getReputation(ALICE);
    expect(scoreBefore).toBeGreaterThan(0.9);

    // Simulate 10 seconds with a moderate decay rate
    const now = Date.now();
    store.applyDecay(ALICE, 0.001, now + 10_000);
    const scoreAfter = store.getReputation(ALICE);

    expect(scoreAfter).toBeLessThan(scoreBefore);
    expect(scoreAfter).toBeGreaterThan(0.5); // still above neutral
  });

  it("moves a low score toward 0.5 over time", () => {
    const store = freshStore();
    for (let i = 0; i < 20; i++) store.recordFailure(ALICE);
    const scoreBefore = store.getReputation(ALICE);
    expect(scoreBefore).toBeLessThan(0.1);

    const now = Date.now();
    store.applyDecay(ALICE, 0.001, now + 10_000);
    const scoreAfter = store.getReputation(ALICE);

    expect(scoreAfter).toBeGreaterThan(scoreBefore);
    expect(scoreAfter).toBeLessThan(0.5); // still below neutral
  });

  it("does nothing for an unknown agent", () => {
    const store = freshStore();
    // Should not throw
    store.applyDecay(ALICE, 0.001, Date.now() + 10_000);
    expect(store.getReputation(ALICE)).toBe(0.5);
  });

  it("does nothing when no time has elapsed", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.recordSuccess(ALICE);
    const scoreBefore = store.getReputation(ALICE);

    // applyDecay with nowMs equal to lastUpdated
    const snap = store.snapshot();
    const lastUpdated = snap.get(ALICE)!.lastUpdated;
    store.applyDecay(ALICE, 0.1, lastUpdated);

    expect(store.getReputation(ALICE)).toBeCloseTo(scoreBefore, 10);
  });

  it("with extreme decay, score approaches 0.5", () => {
    const store = freshStore();
    for (let i = 0; i < 50; i++) store.recordSuccess(ALICE);
    expect(store.getReputation(ALICE)).toBeGreaterThan(0.95);

    // Very large elapsed time * rate => exp(-big) ≈ 0
    store.applyDecay(ALICE, 1, Date.now() + 100_000);
    expect(store.getReputation(ALICE)).toBeCloseTo(0.5, 1);
  });
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe("ReputationStore — snapshot", () => {
  it("returns all tracked agents", () => {
    const store = freshStore();
    store.recordSuccess(ALICE);
    store.recordFailure(BOB);

    const snap = store.snapshot();
    expect(snap.size).toBe(2);
    expect(snap.has(ALICE)).toBe(true);
    expect(snap.has(BOB)).toBe(true);
  });

  it("does not include agents that were never recorded", () => {
    const store = freshStore();
    store.recordSuccess(ALICE);
    const snap = store.snapshot();
    expect(snap.has(BOB)).toBe(false);
  });

  it("records contain correct counts and score", () => {
    const store = freshStore();
    store.recordSuccess(ALICE);
    store.recordSuccess(ALICE);
    store.recordFailure(ALICE);

    const snap = store.snapshot();
    const rec = snap.get(ALICE)!;
    expect(rec.successCount).toBe(2);
    expect(rec.failureCount).toBe(1);
    expect(rec.score).toBeCloseTo(bayesian(2, 1), 10);
    expect(rec.lastUpdated).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Multiple agents tracked independently
// ---------------------------------------------------------------------------

describe("ReputationStore — multi-agent independence", () => {
  it("tracks agents independently", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.recordSuccess(ALICE);
    for (let i = 0; i < 10; i++) store.recordFailure(BOB);

    const aliceScore = store.getReputation(ALICE);
    const bobScore = store.getReputation(BOB);

    expect(aliceScore).toBeCloseTo(bayesian(10, 0), 10);
    expect(bobScore).toBeCloseTo(bayesian(0, 10), 10);
    expect(aliceScore).toBeGreaterThan(0.9);
    expect(bobScore).toBeLessThan(0.1);
  });

  it("recording on one agent does not affect another", () => {
    const store = freshStore();
    store.recordSuccess(ALICE);
    const bobBefore = store.getReputation(BOB);
    store.recordFailure(ALICE);
    const bobAfter = store.getReputation(BOB);
    expect(bobBefore).toBe(bobAfter);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe("ReputationStore — edge cases", () => {
  it("many successes then one failure does not crash reputation", () => {
    const store = freshStore();
    for (let i = 0; i < 100; i++) store.recordSuccess(ALICE);
    const scoreBefore = store.getReputation(ALICE);
    expect(scoreBefore).toBeGreaterThan(0.99);

    store.recordFailure(ALICE);
    const scoreAfter = store.getReputation(ALICE);
    // (100+1)/(100+1+2) = 101/103 ≈ 0.9806 — dip but not crash
    expect(scoreAfter).toBeCloseTo(bayesian(100, 1), 10);
    expect(scoreAfter).toBeGreaterThan(0.97);
  });

  it("minReputationScore = 0 means everyone passes (disabled gate)", () => {
    const store = freshStore();
    // Agent with zero history
    expect(store.meetsMinimum(CHARLIE, 0)).toBe(true);
    // Agent with terrible reputation
    for (let i = 0; i < 100; i++) store.recordFailure(CHARLIE);
    expect(store.meetsMinimum(CHARLIE, 0)).toBe(true);
  });

  it("score never exceeds 1.0 or goes below 0.0", () => {
    const store = freshStore();
    for (let i = 0; i < 10_000; i++) store.recordSuccess(ALICE);
    expect(store.getReputation(ALICE)).toBeLessThanOrEqual(1.0);

    for (let i = 0; i < 10_000; i++) store.recordFailure(BOB);
    expect(store.getReputation(BOB)).toBeGreaterThanOrEqual(0.0);
  });
});

// ---------------------------------------------------------------------------
// shouldAllowTrade integration hook
// ---------------------------------------------------------------------------

describe("shouldAllowTrade", () => {
  it("returns true when reputation is sufficient", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.recordSuccess(ALICE);
    expect(shouldAllowTrade(store, ALICE, 0.6)).toBe(true);
  });

  it("returns false when reputation is insufficient", () => {
    const store = freshStore();
    for (let i = 0; i < 10; i++) store.recordFailure(ALICE);
    expect(shouldAllowTrade(store, ALICE, 0.3)).toBe(false);
  });

  it("returns true when minScore is 0 regardless of reputation", () => {
    const store = freshStore();
    for (let i = 0; i < 50; i++) store.recordFailure(ALICE);
    expect(shouldAllowTrade(store, ALICE, 0)).toBe(true);
  });
});
