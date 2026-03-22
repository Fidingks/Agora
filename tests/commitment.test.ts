/**
 * Commitment protocol tests — comprehensive verification of the ZK commitment
 * scheme implemented in src/protocols/commitment.ts.
 *
 * Coverage:
 *   - Core commitment operations (commit / reveal / verify)
 *   - Batch operations
 *   - Query helpers (getByAgent, getAllRevealed, getAllUnrevealed)
 *   - Stats
 *   - Security properties (hiding, binding, collision-resistance)
 *   - Event logging
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  CommitmentStore,
  generateNonce,
  computeHash,
} from "../src/protocols/commitment.js";
import { EventLog } from "../src/core/event-log.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStore(log?: EventLog): CommitmentStore {
  return new CommitmentStore(log);
}

// ---------------------------------------------------------------------------
// 1. Core commitment operations
// ---------------------------------------------------------------------------

describe("CommitmentStore: commit", () => {
  it("returns a commitmentId, nonce, and hash", () => {
    const store = makeStore();
    const result = store.commit("agent-1", "bid-100");
    expect(result.commitmentId).toBeTruthy();
    expect(result.nonce).toBeTruthy();
    expect(result.hash).toHaveLength(64); // SHA-256 → 64 hex chars
  });

  it("stores the commitment as unrevealed", () => {
    const store = makeStore();
    const { commitmentId } = store.commit("agent-1", "secret");
    const c = store.getCommitment(commitmentId);
    expect(c).toBeDefined();
    expect(c!.revealed).toBe(false);
    expect(c!.revealedValue).toBeUndefined();
    expect(c!.valid).toBeUndefined();
  });

  it("same value + same nonce produces the same hash (deterministic)", () => {
    const nonce = "fixed-nonce-xyz";
    const h1 = computeHash("bid-200", nonce);
    const h2 = computeHash("bid-200", nonce);
    expect(h1).toBe(h2);
  });

  it("same value + different nonce produces a different hash (hiding)", () => {
    const h1 = computeHash("bid-200", "nonce-a");
    const h2 = computeHash("bid-200", "nonce-b");
    expect(h1).not.toBe(h2);
  });

  it("accepts a caller-supplied nonce", () => {
    const store = makeStore();
    const myNonce = "my-custom-nonce-42";
    const { nonce, hash } = store.commit("agent-1", "value", myNonce);
    expect(nonce).toBe(myNonce);
    expect(hash).toBe(computeHash("value", myNonce));
  });
});

// ---------------------------------------------------------------------------
// 2. Reveal
// ---------------------------------------------------------------------------

describe("CommitmentStore: reveal", () => {
  it("reveal with correct value+nonce returns valid=true", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("agent-1", "bid-150");
    const { valid } = store.reveal(commitmentId, "bid-150", nonce);
    expect(valid).toBe(true);
  });

  it("reveal with wrong value returns valid=false", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("agent-1", "bid-150");
    const { valid } = store.reveal(commitmentId, "bid-999", nonce);
    expect(valid).toBe(false);
  });

  it("reveal with wrong nonce returns valid=false", () => {
    const store = makeStore();
    const { commitmentId } = store.commit("agent-1", "bid-150");
    const { valid } = store.reveal(commitmentId, "bid-150", "wrong-nonce");
    expect(valid).toBe(false);
  });

  it("sets revealed=true and stores revealedValue/revealedNonce after reveal", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("agent-1", "answer-42");
    store.reveal(commitmentId, "answer-42", nonce);
    const c = store.getCommitment(commitmentId)!;
    expect(c.revealed).toBe(true);
    expect(c.revealedValue).toBe("answer-42");
    expect(c.revealedNonce).toBe(nonce);
  });

  it("double reveal throws an error", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("agent-1", "value");
    store.reveal(commitmentId, "value", nonce);
    expect(() => store.reveal(commitmentId, "value", nonce)).toThrow(
      /already revealed/i,
    );
  });

  it("reveal of unknown commitmentId throws", () => {
    const store = makeStore();
    expect(() =>
      store.reveal("nonexistent-id", "value", "nonce"),
    ).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// 3. Verify
// ---------------------------------------------------------------------------

describe("CommitmentStore: verify", () => {
  it("verify after valid reveal returns valid=true", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("agent-1", "bid-500");
    store.reveal(commitmentId, "bid-500", nonce);
    const { valid } = store.verify(commitmentId);
    expect(valid).toBe(true);
  });

  it("verify after invalid reveal returns valid=false", () => {
    const store = makeStore();
    const { commitmentId } = store.commit("agent-1", "bid-500");
    // Reveal with wrong value — valid=false stored
    store.reveal(commitmentId, "bid-000", "wrong-nonce");
    const { valid } = store.verify(commitmentId);
    expect(valid).toBe(false);
  });

  it("verify on unrevealed commitment throws", () => {
    const store = makeStore();
    const { commitmentId } = store.commit("agent-1", "value");
    expect(() => store.verify(commitmentId)).toThrow(/not yet revealed/i);
  });

  it("verify on unknown commitment throws", () => {
    const store = makeStore();
    expect(() => store.verify("ghost-id")).toThrow(/not found/i);
  });
});

// ---------------------------------------------------------------------------
// 4. Batch operations
// ---------------------------------------------------------------------------

describe("CommitmentStore: batch", () => {
  it("commitBatch creates multiple commitments", () => {
    const store = makeStore();
    const entries = [
      { agentId: "a1", value: "100" },
      { agentId: "a2", value: "200" },
      { agentId: "a3", value: "300" },
    ];
    const results = store.commitBatch(entries);
    expect(results).toHaveLength(3);
    expect(store.stats().total).toBe(3);
    for (const r of results) {
      expect(r.commitmentId).toBeTruthy();
      expect(r.hash).toHaveLength(64);
    }
  });

  it("revealBatch reveals multiple commitments", () => {
    const store = makeStore();
    const entries = [
      { agentId: "a1", value: "100" },
      { agentId: "a2", value: "200" },
    ];
    const commits = store.commitBatch(entries);
    const reveals = commits.map((c, i) => ({
      commitmentId: c.commitmentId,
      value: entries[i]!.value,
      nonce: c.nonce,
    }));
    const results = store.revealBatch(reveals);
    expect(results).toHaveLength(2);
    for (const r of results) {
      expect(r.valid).toBe(true);
    }
  });

  it("revealBatch handles a mix of valid and invalid reveals", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("a1", "correct-value");
    const { commitmentId: c2 } = store.commit("a2", "other-value");

    const results = store.revealBatch([
      { commitmentId, value: "correct-value", nonce },   // valid
      { commitmentId: c2, value: "wrong", nonce: "bad" }, // invalid
    ]);

    expect(results[0]!.valid).toBe(true);
    expect(results[1]!.valid).toBe(false);
  });

  it("revealBatch does not throw on a non-existent commitmentId", () => {
    const store = makeStore();
    const results = store.revealBatch([
      { commitmentId: "ghost-id", value: "v", nonce: "n" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]!.valid).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Query operations
// ---------------------------------------------------------------------------

describe("CommitmentStore: queries", () => {
  it("getByAgent returns only that agent's commitments", () => {
    const store = makeStore();
    store.commit("alice", "val-1");
    store.commit("alice", "val-2");
    store.commit("bob",   "val-3");

    const aliceCommits = store.getByAgent("alice");
    expect(aliceCommits).toHaveLength(2);
    for (const c of aliceCommits) {
      expect(c.agentId).toBe("alice");
    }
  });

  it("getByAgent returns an empty array for an unknown agent", () => {
    const store = makeStore();
    expect(store.getByAgent("nobody")).toHaveLength(0);
  });

  it("getAllUnrevealed returns only unrevealed commitments", () => {
    const store = makeStore();
    const { commitmentId: c1, nonce: n1 } = store.commit("a", "x");
    store.commit("b", "y");
    store.reveal(c1, "x", n1);

    const unrevealed = store.getAllUnrevealed();
    expect(unrevealed).toHaveLength(1);
    expect(unrevealed[0]!.revealed).toBe(false);
  });

  it("getAllRevealed returns only revealed commitments", () => {
    const store = makeStore();
    const { commitmentId, nonce } = store.commit("a", "x");
    store.commit("b", "y");
    store.reveal(commitmentId, "x", nonce);

    const revealed = store.getAllRevealed();
    expect(revealed).toHaveLength(1);
    expect(revealed[0]!.revealed).toBe(true);
  });

  it("stats returns accurate counts", () => {
    const store = makeStore();
    const { commitmentId: c1, nonce: n1 } = store.commit("a", "good");
    const { commitmentId: c2 }            = store.commit("b", "good2");
    store.commit("c", "pending");

    store.reveal(c1, "good",   n1);   // valid
    store.reveal(c2, "WRONG", "bad"); // invalid

    const s = store.stats();
    expect(s.total).toBe(3);
    expect(s.revealed).toBe(2);
    expect(s.unrevealed).toBe(1);
    expect(s.valid).toBe(1);
    expect(s.invalid).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 6. Security properties (property-based)
// ---------------------------------------------------------------------------

describe("CommitmentStore: security properties", () => {
  it("for random values and nonces, commit-then-reveal always validates", () => {
    const store = makeStore();
    // Use 50 distinct random-ish values + nonces generated at runtime
    const pairs: { value: string; nonce: string }[] = [];
    for (let i = 0; i < 50; i++) {
      pairs.push({ value: `val-${i}-${Math.random()}`, nonce: generateNonce() });
    }

    for (const { value, nonce } of pairs) {
      const { commitmentId } = store.commit(`agent-${value}`, value, nonce);
      const { valid } = store.reveal(commitmentId, value, nonce);
      expect(valid).toBe(true);
    }
  });

  it("no two different (value, nonce) pairs produce the same hash", () => {
    const hashes = new Set<string>();
    const pairs: [string, string][] = [
      ["value-A", "nonce-1"],
      ["value-A", "nonce-2"],  // same value, different nonce
      ["value-B", "nonce-1"],  // different value, same nonce
      ["value-B", "nonce-2"],
      ["",        "nonce-1"],  // empty value
      ["value-A", ""],         // empty nonce
    ];

    for (const [v, n] of pairs) {
      hashes.add(computeHash(v, n));
    }
    // All six pairs should produce distinct hashes
    expect(hashes.size).toBe(pairs.length);
  });

  it("cannot determine value from hash alone (known values hidden)", () => {
    // Verify that two commitments with the same value but different nonces
    // produce different hashes — the value is hidden.
    const store = makeStore();
    const { hash: h1 } = store.commit("agent-1", "SECRET-BID-500");
    const { hash: h2 } = store.commit("agent-2", "SECRET-BID-500");
    // Different nonces → different hashes even for the same value
    expect(h1).not.toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// 7. Utility functions
// ---------------------------------------------------------------------------

describe("generateNonce / computeHash utilities", () => {
  it("generateNonce returns a non-empty hex string", () => {
    const n = generateNonce();
    expect(n).toBeTruthy();
    expect(n).toMatch(/^[0-9a-f]+$/);
  });

  it("generateNonce with different calls produces different values", () => {
    const n1 = generateNonce();
    const n2 = generateNonce();
    expect(n1).not.toBe(n2);
  });

  it("generateNonce respects the bytes parameter", () => {
    // 16 bytes → 32 hex chars
    const n = generateNonce(16);
    expect(n).toHaveLength(32);
  });

  it("computeHash returns a 64-char hex string", () => {
    const h = computeHash("test-value", "test-nonce");
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// 8. Event logging
// ---------------------------------------------------------------------------

describe("CommitmentStore: event logging", () => {
  let log: EventLog;
  let store: CommitmentStore;

  beforeEach(() => {
    log = new EventLog();
    store = makeStore(log);
  });

  it('commit emits a "commitment.created" event', () => {
    store.commit("agent-1", "bid-100");
    const events = log.query({ event: "commitment.created" });
    expect(events).toHaveLength(1);
    expect(events[0]!.agentIds).toContain("agent-1");
  });

  it('reveal emits a "commitment.revealed" event', () => {
    const { commitmentId, nonce } = store.commit("agent-1", "bid-100");
    store.reveal(commitmentId, "bid-100", nonce);
    const events = log.query({ event: "commitment.revealed" });
    expect(events).toHaveLength(1);
    expect(events[0]!.agentIds).toContain("agent-1");
  });

  it('verify emits a "commitment.verified" event', () => {
    const { commitmentId, nonce } = store.commit("agent-1", "bid-100");
    store.reveal(commitmentId, "bid-100", nonce);
    store.verify(commitmentId);
    const events = log.query({ event: "commitment.verified" });
    expect(events).toHaveLength(1);
  });

  it("commitBatch emits one event per commitment", () => {
    store.commitBatch([
      { agentId: "a1", value: "v1" },
      { agentId: "a2", value: "v2" },
      { agentId: "a3", value: "v3" },
    ]);
    const events = log.query({ event: "commitment.created" });
    expect(events).toHaveLength(3);
  });

  it("event data includes commitmentId and hash", () => {
    const { commitmentId, hash } = store.commit("agent-1", "secret");
    const events = log.query({ event: "commitment.created" });
    expect(events[0]!.data["commitmentId"]).toBe(commitmentId);
    expect(events[0]!.data["hash"]).toBe(hash);
  });

  it("reveal event reports valid flag", () => {
    const { commitmentId, nonce } = store.commit("agent-1", "truth");
    store.reveal(commitmentId, "lie", nonce);
    const events = log.query({ event: "commitment.revealed" });
    expect(events[0]!.data["valid"]).toBe(false);
  });
});
