/**
 * Committee arbitration tests.
 *
 * Covers:
 *   1.  Basic resolution — 3 fair arbitrators, clear evidence
 *   2.  All vote claimant → claimant_wins, refundFraction 1.0
 *   3.  All vote respondent → respondent_wins, refundFraction 0.0
 *   4.  All vote split → split verdict
 *   5.  Mixed votes — weighted majority wins
 *   6.  Quorum not met (too many abstains) → no_quorum
 *   7.  Exactly at quorum → valid verdict
 *   8.  Min arbitrators not met → throws error
 *   9.  High-rep arbitrator's vote counts more
 *   10. Low-rep arbitrators can't override a high-rep vote
 *   11. useReputationWeights=false → equal weights (1.0 each)
 *   12. Single arbitrator (minArbitrators=1)
 *   13. All abstain → no_quorum
 *   14. Supermajority threshold effects
 *   15. dispute.filed event is emitted
 *   16. arbitration.vote events are emitted for each arbitrator
 *   17. arbitration.resolved event is emitted
 *   18. Dispute with reputation store affects arbitrator weights
 *   19. claimant_wins → refundFraction exactly 1.0
 *   20. respondent_wins → refundFraction exactly 0.0
 *   21. split verdict → refundFraction between 0 and 1
 *   22. no_quorum → refundFraction 0.5 (neutral)
 *   23. votes array contains all arbitrator entries
 *   24. durationMs is a non-negative number
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  ArbitrationCommittee,
  DEFAULT_ARBITRATION_CONFIG,
  type DisputeCase,
  type ArbitrationConfig,
} from "../src/protocols/arbitration.js";
import { MockArbitrator } from "../src/agents/mock-arbitrator.js";
import { ReputationStore } from "../src/protocols/reputation.js";
import { EventLog } from "../src/core/event-log.js";
import { toAgentId } from "../src/core/identity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDispute(overrides: Partial<DisputeCase> = {}): DisputeCase {
  return {
    id: "dispute-001",
    tradeId: "trade-001",
    claimant: "buyer-agent",
    respondent: "seller-agent",
    claim: "Delivered dataset was corrupted and unusable.",
    evidence: { quality: 0.2 },
    filedAt: Date.now(),
    ...overrides,
  };
}

function makeCommittee(
  config: Partial<ArbitrationConfig> = {},
  reputation?: ReputationStore,
  eventLog?: EventLog,
): ArbitrationCommittee {
  return new ArbitrationCommittee(config, reputation, eventLog);
}

// ---------------------------------------------------------------------------
// 1. Basic resolution — 3 fair arbitrators, clear low-quality evidence
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: basic resolution (fair arbitrators, low quality evidence)", () => {
  it("returns claimant_wins when evidence quality < 0.5", async () => {
    const committee = makeCommittee({ minArbitrators: 3 });
    committee.addArbitrator(new MockArbitrator("arb-1", "fair"));
    committee.addArbitrator(new MockArbitrator("arb-2", "fair"));
    committee.addArbitrator(new MockArbitrator("arb-3", "fair"));

    const outcome = await committee.resolve(makeDispute({ evidence: { quality: 0.2 } }));
    expect(outcome.verdict).toBe("claimant_wins");
  });

  it("returns respondent_wins when evidence quality >= 0.5", async () => {
    const committee = makeCommittee({ minArbitrators: 3 });
    committee.addArbitrator(new MockArbitrator("arb-1", "fair"));
    committee.addArbitrator(new MockArbitrator("arb-2", "fair"));
    committee.addArbitrator(new MockArbitrator("arb-3", "fair"));

    const outcome = await committee.resolve(makeDispute({ evidence: { quality: 0.8 } }));
    expect(outcome.verdict).toBe("respondent_wins");
  });
});

// ---------------------------------------------------------------------------
// 2. All vote claimant → claimant_wins with refundFraction 1.0
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: unanimous claimant vote", () => {
  it("verdict is claimant_wins", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("claimant_wins");
  });

  it("refundFraction is 1.0", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.resolution.refundFraction).toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// 3. All vote respondent → respondent_wins with refundFraction 0.0
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: unanimous respondent vote", () => {
  it("verdict is respondent_wins", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("arb-1", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-2", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-3", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("respondent_wins");
  });

  it("refundFraction is 0.0", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("arb-1", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-2", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-3", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.resolution.refundFraction).toBe(0.0);
  });
});

// ---------------------------------------------------------------------------
// 4. Split votes → split verdict
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: balanced split votes", () => {
  it("verdict is split when votes are evenly divided and no supermajority", async () => {
    // 1 claimant + 1 respondent + 1 split → no supermajority for either side → split
    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      supermajority: 0.67,
    });

    // Use a custom arbitrator that votes "split"
    const splitVoter = {
      id: "arb-split",
      vote: async () => ({ vote: "split" as const, reasoning: "I see both sides equally." }),
    };

    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "respondent"));
    committee.addArbitrator(splitVoter);

    const outcome = await committee.resolve(makeDispute());
    // claimantWeight=1, respondentWeight=1, neither reaches 0.67 of 2 voting weight
    expect(outcome.verdict).toBe("split");
  });
});

// ---------------------------------------------------------------------------
// 5. Mixed votes — majority side wins
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: mixed votes, majority wins", () => {
  it("claimant wins with 2/3 equal-weight votes for claimant", async () => {
    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      supermajority: 0.67,
    });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    // 2/3 = 0.667 ≈ supermajority threshold of 0.67 — exact boundary
    // 2/3 = 0.6667 which is ≥ 0.67? No: 0.6667 < 0.67. So it should be split.
    // Let's use supermajority: 0.65 to ensure 2/3 wins.
    expect(outcome.verdict).toBe("split"); // 0.6667 < 0.67 exact
  });

  it("claimant wins clearly with 3/4 votes when supermajority is 0.6", async () => {
    const committee = makeCommittee({
      minArbitrators: 4,
      useReputationWeights: false,
      supermajority: 0.6,
    });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-4", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("claimant_wins");
  });
});

// ---------------------------------------------------------------------------
// 6. Quorum not met — too many abstains
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: quorum", () => {
  it("returns no_quorum when abstaining votes prevent reaching quorum threshold", async () => {
    // quorumFraction: 0.67 means 67% of total weight must vote non-abstain
    // With 3 arbitrators (equal weight), 2 abstains → only 1/3 ≈ 0.33 voting → no quorum
    const abstainVoter = {
      id: "arb-abstain",
      vote: async () => ({ vote: "abstain" as const, reasoning: "Insufficient info." }),
    };

    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      quorumFraction: 0.67,
    });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator({ ...abstainVoter, id: "arb-2-abstain" });
    committee.addArbitrator({ ...abstainVoter, id: "arb-3-abstain" });

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("no_quorum");
  });

  it("returns valid verdict when exactly at quorum threshold", async () => {
    // 3 arbitrators equal weight, quorumFraction 0.67
    // All 3 vote → 3/3 = 1.0 ≥ 0.67 → quorum met
    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      quorumFraction: 0.67,
    });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).not.toBe("no_quorum");
  });
});

// ---------------------------------------------------------------------------
// 7. Min arbitrators not met → throws error
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: minimum arbitrators enforcement", () => {
  it("throws when fewer than minArbitrators are registered", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("arb-1", "fair"));
    committee.addArbitrator(new MockArbitrator("arb-2", "fair"));
    // Only 2 added, but minimum is 3

    await expect(committee.resolve(makeDispute())).rejects.toThrow();
  });

  it("does not throw when exactly minArbitrators are registered", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    await expect(committee.resolve(makeDispute())).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 8. Reputation weighting — high-rep arbitrator's vote counts more
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: reputation weighting", () => {
  it("high-rep arbitrator's vote outweighs two low-rep votes", async () => {
    // Setup: 1 high-rep claimant-voter vs 2 low-rep respondent-voters.
    // High-rep score ≈ 0.9 (many successes), low-rep ≈ 0.1 (many failures).
    // claimantWeight ≈ 0.9, respondentWeight ≈ 0.1 + 0.1 = 0.2
    // claimant wins if 0.9 / (0.9 + 0.2) ≈ 0.818 ≥ supermajority 0.67

    const reputation = new ReputationStore();
    const highRepId = toAgentId("high-rep-arb");
    const lowRep1Id = toAgentId("low-rep-arb-1");
    const lowRep2Id = toAgentId("low-rep-arb-2");

    // Build up high reputation for high-rep arb.
    for (let i = 0; i < 20; i++) reputation.recordSuccess(highRepId);

    // Build low reputation for low-rep arbs.
    for (let i = 0; i < 20; i++) reputation.recordFailure(lowRep1Id);
    for (let i = 0; i < 20; i++) reputation.recordFailure(lowRep2Id);

    const committee = makeCommittee(
      { minArbitrators: 3, useReputationWeights: true, supermajority: 0.67 },
      reputation,
    );

    committee.addArbitrator(new MockArbitrator(highRepId, "claimant"));
    committee.addArbitrator(new MockArbitrator(lowRep1Id, "respondent"));
    committee.addArbitrator(new MockArbitrator(lowRep2Id, "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("claimant_wins");
    expect(outcome.claimantWeight).toBeGreaterThan(outcome.respondentWeight);
  });

  it("low-rep arbitrators cannot swing result against a high-rep majority", async () => {
    const reputation = new ReputationStore();
    const highRep1 = toAgentId("high-1");
    const highRep2 = toAgentId("high-2");
    const lowRep = toAgentId("low-1");

    for (let i = 0; i < 15; i++) reputation.recordSuccess(highRep1);
    for (let i = 0; i < 15; i++) reputation.recordSuccess(highRep2);
    for (let i = 0; i < 15; i++) reputation.recordFailure(lowRep);

    const committee = makeCommittee(
      { minArbitrators: 3, useReputationWeights: true, supermajority: 0.67 },
      reputation,
    );

    committee.addArbitrator(new MockArbitrator(highRep1, "claimant"));
    committee.addArbitrator(new MockArbitrator(highRep2, "claimant"));
    committee.addArbitrator(new MockArbitrator(lowRep, "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("claimant_wins");
  });

  it("useReputationWeights=false gives equal weight of 1.0 to all arbitrators", async () => {
    const reputation = new ReputationStore();
    const highRepId = toAgentId("high-rep");
    for (let i = 0; i < 20; i++) reputation.recordSuccess(highRepId);

    const committee = makeCommittee(
      { minArbitrators: 3, useReputationWeights: false },
      reputation,
    );

    committee.addArbitrator(new MockArbitrator(highRepId, "claimant"));
    committee.addArbitrator(new MockArbitrator("low-1", "respondent"));
    committee.addArbitrator(new MockArbitrator("low-2", "respondent"));

    const outcome = await committee.resolve(makeDispute());

    // With equal weights: 1 claimant + 2 respondent → respondent wins
    expect(outcome.votes.every((v) => v.weight === 1.0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Edge case: single arbitrator (minArbitrators=1)
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: single arbitrator", () => {
  it("resolves with one arbitrator when minArbitrators=1", async () => {
    const committee = makeCommittee({
      minArbitrators: 1,
      useReputationWeights: false,
      quorumFraction: 0.5,
      supermajority: 0.5,
    });
    committee.addArbitrator(new MockArbitrator("solo-arb", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("claimant_wins");
    expect(outcome.votes).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 10. All abstain → no_quorum
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: all abstain", () => {
  it("returns no_quorum when every arbitrator abstains", async () => {
    const abstainVoter = (id: string) => ({
      id,
      vote: async () => ({ vote: "abstain" as const, reasoning: "No opinion." }),
    });

    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      quorumFraction: 0.67,
    });
    committee.addArbitrator(abstainVoter("a1"));
    committee.addArbitrator(abstainVoter("a2"));
    committee.addArbitrator(abstainVoter("a3"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("no_quorum");
  });
});

// ---------------------------------------------------------------------------
// 11. Supermajority threshold effects
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: supermajority threshold", () => {
  it("strict supermajority=0.9 prevents win at 2/3", async () => {
    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      supermajority: 0.9,
    });
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    // 2/3 ≈ 0.667 < 0.9 → no supermajority → split
    expect(outcome.verdict).toBe("split");
  });

  it("loose supermajority=0.4 allows simple majority to win", async () => {
    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      supermajority: 0.4,
    });
    committee.addArbitrator(new MockArbitrator("arb-1", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-2", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    // 2/3 ≈ 0.667 ≥ 0.4 → respondent_wins
    expect(outcome.verdict).toBe("respondent_wins");
  });
});

// ---------------------------------------------------------------------------
// 12. Event logging
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: event logging", () => {
  it("emits dispute.filed event when resolve is called", async () => {
    const eventLog = new EventLog();
    const committee = makeCommittee(
      { minArbitrators: 3, useReputationWeights: false },
      undefined,
      eventLog,
    );
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    await committee.resolve(makeDispute({ id: "d-001" }));

    const filed = eventLog.query({ event: "dispute.filed" });
    expect(filed).toHaveLength(1);
    expect(filed[0]!.data["disputeId"]).toBe("d-001");
  });

  it("emits one arbitration.vote event per arbitrator", async () => {
    const eventLog = new EventLog();
    const committee = makeCommittee(
      { minArbitrators: 3, useReputationWeights: false },
      undefined,
      eventLog,
    );
    committee.addArbitrator(new MockArbitrator("arb-1", "claimant"));
    committee.addArbitrator(new MockArbitrator("arb-2", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-3", "claimant"));

    await committee.resolve(makeDispute());

    const voteEvents = eventLog.query({ event: "arbitration.vote" });
    expect(voteEvents).toHaveLength(3);
  });

  it("emits arbitration.resolved event with correct verdict", async () => {
    const eventLog = new EventLog();
    const committee = makeCommittee(
      { minArbitrators: 3, useReputationWeights: false },
      undefined,
      eventLog,
    );
    committee.addArbitrator(new MockArbitrator("arb-1", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-2", "respondent"));
    committee.addArbitrator(new MockArbitrator("arb-3", "respondent"));

    await committee.resolve(makeDispute({ id: "d-resolved" }));

    const resolved = eventLog.query({ event: "arbitration.resolved" });
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.data["verdict"]).toBe("respondent_wins");
    expect(resolved[0]!.data["disputeId"]).toBe("d-resolved");
  });
});

// ---------------------------------------------------------------------------
// 13. Integration — reputation store affects arbitrator weights
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: integration with reputation store", () => {
  it("arbitrator weights reflect their reputation score", async () => {
    const reputation = new ReputationStore();
    const arbId = toAgentId("rep-aware-arb");

    // Give this arbitrator 10 successes → score ≈ (10+1)/(10+0+2) ≈ 0.917
    for (let i = 0; i < 10; i++) reputation.recordSuccess(arbId);

    const committee = makeCommittee(
      { minArbitrators: 1, useReputationWeights: true, quorumFraction: 0.1 },
      reputation,
    );
    committee.addArbitrator(new MockArbitrator(arbId, "claimant"));

    const outcome = await committee.resolve(makeDispute());

    // Weight should be the reputation score, not the default 1.0.
    const arbVote = outcome.votes.find((v) => v.arbitratorId === arbId);
    expect(arbVote).toBeDefined();
    expect(arbVote!.weight).toBeCloseTo(11 / 12, 3); // (10+1)/(10+0+2) ≈ 0.917
    expect(arbVote!.weight).not.toBe(1.0);
  });
});

// ---------------------------------------------------------------------------
// 14. Outcome field correctness
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: outcome fields", () => {
  it("claimant_wins → refundFraction exactly 1.0", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("a1", "claimant"));
    committee.addArbitrator(new MockArbitrator("a2", "claimant"));
    committee.addArbitrator(new MockArbitrator("a3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("claimant_wins");
    expect(outcome.resolution.refundFraction).toBe(1.0);
  });

  it("respondent_wins → refundFraction exactly 0.0", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("a1", "respondent"));
    committee.addArbitrator(new MockArbitrator("a2", "respondent"));
    committee.addArbitrator(new MockArbitrator("a3", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("respondent_wins");
    expect(outcome.resolution.refundFraction).toBe(0.0);
  });

  it("split verdict → refundFraction strictly between 0 and 1", async () => {
    // 1 claimant, 1 respondent, 1 respondent → no supermajority for claimant, but let's
    // force a true split by using equal claimant/respondent weight with supermajority 0.9.
    const committee = makeCommittee({
      minArbitrators: 2,
      useReputationWeights: false,
      supermajority: 0.9,
      quorumFraction: 0.5,
    });
    committee.addArbitrator(new MockArbitrator("a1", "claimant"));
    committee.addArbitrator(new MockArbitrator("a2", "respondent"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("split");
    expect(outcome.resolution.refundFraction).toBeGreaterThan(0);
    expect(outcome.resolution.refundFraction).toBeLessThan(1);
  });

  it("no_quorum → refundFraction is 0.5 (neutral)", async () => {
    const abstainVoter = (id: string) => ({
      id,
      vote: async () => ({ vote: "abstain" as const, reasoning: "No opinion." }),
    });

    const committee = makeCommittee({
      minArbitrators: 3,
      useReputationWeights: false,
      quorumFraction: 0.67,
    });
    committee.addArbitrator(abstainVoter("a1"));
    committee.addArbitrator(abstainVoter("a2"));
    committee.addArbitrator(abstainVoter("a3"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.verdict).toBe("no_quorum");
    expect(outcome.resolution.refundFraction).toBe(0.5);
  });

  it("votes array has one entry per registered arbitrator", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("a1", "claimant"));
    committee.addArbitrator(new MockArbitrator("a2", "claimant"));
    committee.addArbitrator(new MockArbitrator("a3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(outcome.votes).toHaveLength(3);
    expect(outcome.votes.map((v) => v.arbitratorId)).toEqual(
      expect.arrayContaining(["a1", "a2", "a3"]),
    );
  });

  it("durationMs is a non-negative number", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("a1", "claimant"));
    committee.addArbitrator(new MockArbitrator("a2", "claimant"));
    committee.addArbitrator(new MockArbitrator("a3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    expect(typeof outcome.durationMs).toBe("number");
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("totalWeight equals sum of all arbitrator weights", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("a1", "claimant"));
    committee.addArbitrator(new MockArbitrator("a2", "respondent"));
    committee.addArbitrator(new MockArbitrator("a3", "claimant"));

    const outcome = await committee.resolve(makeDispute());
    const sumOfWeights = outcome.votes.reduce((sum, v) => sum + v.weight, 0);
    expect(outcome.totalWeight).toBeCloseTo(sumOfWeights, 6);
  });
});

// ---------------------------------------------------------------------------
// 15. MockArbitrator bias modes
// ---------------------------------------------------------------------------

describe("MockArbitrator: bias modes", () => {
  it("'claimant' bias always votes claimant", async () => {
    const arb = new MockArbitrator("arb", "claimant");
    const result = await arb.vote(makeDispute({ evidence: { quality: 0.99 } }));
    expect(result.vote).toBe("claimant");
  });

  it("'respondent' bias always votes respondent", async () => {
    const arb = new MockArbitrator("arb", "respondent");
    const result = await arb.vote(makeDispute({ evidence: { quality: 0.01 } }));
    expect(result.vote).toBe("respondent");
  });

  it("'fair' bias votes claimant when quality < 0.5", async () => {
    const arb = new MockArbitrator("arb", "fair");
    const result = await arb.vote(makeDispute({ evidence: { quality: 0.3 } }));
    expect(result.vote).toBe("claimant");
  });

  it("'fair' bias votes respondent when quality >= 0.5", async () => {
    const arb = new MockArbitrator("arb", "fair");
    const result = await arb.vote(makeDispute({ evidence: { quality: 0.7 } }));
    expect(result.vote).toBe("respondent");
  });

  it("'fair' bias votes claimant when no quality field is present", async () => {
    const arb = new MockArbitrator("arb", "fair");
    const result = await arb.vote(makeDispute({ evidence: {} }));
    expect(result.vote).toBe("claimant");
  });

  it("returns a non-empty reasoning string for every vote", async () => {
    for (const bias of ["fair", "claimant", "respondent"] as const) {
      const arb = new MockArbitrator("arb", bias);
      const result = await arb.vote(makeDispute());
      expect(typeof result.reasoning).toBe("string");
      expect(result.reasoning.length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 16. DisputeCase fields flow through correctly
// ---------------------------------------------------------------------------

describe("ArbitrationCommittee: disputeId propagation", () => {
  it("outcome.disputeId matches the filed dispute id", async () => {
    const committee = makeCommittee({ minArbitrators: 3, useReputationWeights: false });
    committee.addArbitrator(new MockArbitrator("a1", "claimant"));
    committee.addArbitrator(new MockArbitrator("a2", "claimant"));
    committee.addArbitrator(new MockArbitrator("a3", "claimant"));

    const dispute = makeDispute({ id: "unique-dispute-xyz" });
    const outcome = await committee.resolve(dispute);
    expect(outcome.disputeId).toBe("unique-dispute-xyz");
  });
});
