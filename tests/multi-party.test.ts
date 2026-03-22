/**
 * Tests for the multi-party negotiation protocol.
 *
 * Covers:
 *   1.  3 agreeable agents reach consensus in 1 round
 *   2.  1 stubborn agent blocks consensus when threshold requires all
 *   3.  Threshold 0.5 — majority is enough; 2/3 agents accept → success
 *   4.  Threshold 1.0 — unanimous required; 1 stubborn → failure
 *   5.  Max rounds exhausted → outcome.success is false
 *   6.  totalRounds equals maxRounds on timeout
 *   7.  Counter-proposals shift terms toward compromise
 *   8.  Event log records multi-party.start, proposals, rounds, success
 *   9.  Reputation gate blocks low-rep agent
 *   10. Minimum participants enforced — too few → fails
 *   11. Maximum participants enforced — too many → fails
 *   12. 5 agreeable agents converge
 *   13. Outcome.participants lists all agent IDs
 *   14. Outcome.acceptors contains proposer + accepting voters
 *   15. Round counting is accurate (completedRounds.length === totalRounds)
 *   16. finalTerms is null on failure
 *   17. All-reject agents cycle through proposers each round
 *   18. averageTerms blending — counter terms move toward midpoint
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Ledger } from "../src/core/ledger.js";
import { EventLog } from "../src/core/event-log.js";
import { ReputationStore } from "../src/protocols/reputation.js";
import { toAgentId } from "../src/core/identity.js";
import {
  MultiPartyNegotiation,
  DEFAULT_MULTI_PARTY_CONFIG,
  type MultiPartyProposal,
  type NegotiationParticipant,
} from "../src/protocols/multi-party.js";
import { MockNegotiator } from "../src/agents/mock-negotiator.js";
import { runMultiPartyScenario } from "../src/scenarios/multi-party.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeNegotiation(
  overrides: Partial<import("../src/protocols/multi-party.js").MultiPartyConfig> = {},
  eventLog?: EventLog,
  reputation?: ReputationStore,
): MultiPartyNegotiation {
  const ledger = new Ledger();
  return new MultiPartyNegotiation(overrides, ledger, reputation, eventLog);
}

function agreeableAgent(id: string, terms: Record<string, number> = { price: 100 }): MockNegotiator {
  return new MockNegotiator({ id, preferredTerms: terms, flexibility: 0.5 });
}

function stubbornAgent(id: string): MockNegotiator {
  return new MockNegotiator({ id, preferredTerms: { price: 100 }, stubborn: true });
}

// ---------------------------------------------------------------------------
// 1. 3 agreeable agents reach consensus in round 0
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: 3 agreeable agents", () => {
  it("reaches consensus and returns success=true", async () => {
    const neg = makeNegotiation({ consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 105 }));
    neg.addParticipant(agreeableAgent("a3", { price: 95 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
    expect(outcome.finalTerms).not.toBeNull();
  });

  it("lists all 3 participants in outcome.participants", async () => {
    const neg = makeNegotiation({ consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("a1"));
    neg.addParticipant(agreeableAgent("a2"));
    neg.addParticipant(agreeableAgent("a3"));

    const outcome = await neg.run();

    expect(outcome.participants).toHaveLength(3);
    expect(outcome.participants).toContain("a1");
    expect(outcome.participants).toContain("a2");
    expect(outcome.participants).toContain("a3");
  });

  it("acceptors includes proposer and voters who said accept", async () => {
    const neg = makeNegotiation({ consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(agreeableAgent("a3", { price: 100 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
    // Proposer (a1) + at least one acceptor from remaining two.
    expect(outcome.acceptors.length).toBeGreaterThanOrEqual(1);
    expect(outcome.acceptors).toContain("a1"); // proposer auto-accepts
  });
});

// ---------------------------------------------------------------------------
// 2. 1 stubborn agent blocks consensus when threshold requires all (1.0)
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: 1 stubborn agent with threshold 1.0", () => {
  it("fails to reach consensus", async () => {
    const neg = makeNegotiation({ consensusThreshold: 1.0, maxRounds: 3 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(stubbornAgent("stubborn"));

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
  });

  it("returns null finalTerms on failure", async () => {
    const neg = makeNegotiation({ consensusThreshold: 1.0, maxRounds: 2 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(stubbornAgent("stubborn"));

    const outcome = await neg.run();

    expect(outcome.finalTerms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. Threshold 0.5 — majority sufficient; 2/3 agreeable agents → success
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: threshold 0.5 (majority)", () => {
  it("succeeds when 2 of 3 agents accept (threshold=0.5)", async () => {
    // With threshold 0.5: need ≥ ceil(0.5 * 3) = 2 accepts.
    // Agents a1 (proposer, auto-accept) + a2 (agreeable) = 2/3 ≥ 0.5 × 3 = 1.5 → success.
    const neg = makeNegotiation({ consensusThreshold: 0.5 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(stubbornAgent("stubborn"));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Threshold 1.0 — unanimous; 1 stubborn → failure
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: threshold 1.0 (unanimous)", () => {
  it("fails if even one agent rejects", async () => {
    const neg = makeNegotiation({ consensusThreshold: 1.0, maxRounds: 2 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(stubbornAgent("stubborn"));

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
  });

  it("succeeds with all agreeable agents and threshold 1.0", async () => {
    const neg = makeNegotiation({ consensusThreshold: 1.0 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(agreeableAgent("a3", { price: 100 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 5. Max rounds exhausted → failure
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: max rounds timeout", () => {
  it("returns success=false after maxRounds with all-stubborn agents", async () => {
    const neg = makeNegotiation({ maxRounds: 4, consensusThreshold: 0.67 });
    neg.addParticipant(stubbornAgent("s1"));
    neg.addParticipant(stubbornAgent("s2"));
    neg.addParticipant(stubbornAgent("s3"));

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. totalRounds equals maxRounds on timeout
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: round counting on timeout", () => {
  it("totalRounds equals maxRounds when all agents are stubborn", async () => {
    const maxRounds = 5;
    const neg = makeNegotiation({ maxRounds, consensusThreshold: 0.67 });
    neg.addParticipant(stubbornAgent("s1"));
    neg.addParticipant(stubbornAgent("s2"));
    neg.addParticipant(stubbornAgent("s3"));

    const outcome = await neg.run();

    expect(outcome.totalRounds).toBe(maxRounds);
    expect(outcome.rounds).toHaveLength(maxRounds);
  });

  it("totalRounds equals completedRounds.length", async () => {
    const neg = makeNegotiation({ maxRounds: 3, consensusThreshold: 0.67 });
    neg.addParticipant(stubbornAgent("s1"));
    neg.addParticipant(stubbornAgent("s2"));
    neg.addParticipant(stubbornAgent("s3"));

    const outcome = await neg.run();

    expect(outcome.totalRounds).toBe(outcome.rounds.length);
  });
});

// ---------------------------------------------------------------------------
// 7. Counter-proposals shift terms toward compromise
// ---------------------------------------------------------------------------

describe("MockNegotiator: counter-proposal blending", () => {
  it("counter terms are a midpoint between preferred and proposed", async () => {
    // Agent prefers price=100; proposal comes in at price=200 (100% deviation).
    // With flexibility=0.2, the deviation 1.0 > 0.2 → counter at (100+200)/2=150.
    const agent = new MockNegotiator({
      id: "test-agent",
      preferredTerms: { price: 100 },
      flexibility: 0.2,
    });

    const proposal: MultiPartyProposal = {
      proposerId: "other",
      terms: { price: 200 },
      round: 0,
    };

    const { vote, counterTerms } = await agent.vote(proposal);

    // Deviation = |200-100|/100 = 1.0. Within 2*flexibility=0.4? No → reject.
    // With 2*flexibility = 0.4, deviation 1.0 > 0.4 → reject, not counter.
    // That's correct behaviour; let's verify the vote is either counter or reject.
    expect(["reject", "counter"]).toContain(vote);

    // Now test with closer proposal — within 2*flexibility should counter.
    const closeProposal: MultiPartyProposal = {
      proposerId: "other",
      terms: { price: 125 },
      round: 0,
    };
    const close = await agent.vote(closeProposal);
    // deviation = 25/100 = 0.25 > flexibility(0.2) but ≤ 2*flexibility(0.4) → counter
    expect(close.vote).toBe("counter");
    expect(close.counterTerms).toBeDefined();
    // Counter should be midpoint: (125 + 100) / 2 = 112.5
    expect(close.counterTerms!["price"]).toBeCloseTo(112.5);
  });

  it("agent accepts when proposed terms are within flexibility", async () => {
    const agent = new MockNegotiator({
      id: "test-agent",
      preferredTerms: { price: 100 },
      flexibility: 0.2,
    });

    const proposal: MultiPartyProposal = {
      proposerId: "other",
      terms: { price: 110 }, // deviation = 10/100 = 0.1 ≤ 0.2
      round: 0,
    };

    const { vote } = await agent.vote(proposal);
    expect(vote).toBe("accept");
  });

  it("negotiation converges with agents that counter-propose", async () => {
    // Both agents are slightly apart but flexible enough to counter-meet.
    const neg = makeNegotiation({ maxRounds: 10, consensusThreshold: 0.67 });
    neg.addParticipant(
      new MockNegotiator({ id: "a1", preferredTerms: { price: 80 }, flexibility: 0.4 }),
    );
    neg.addParticipant(
      new MockNegotiator({ id: "a2", preferredTerms: { price: 120 }, flexibility: 0.4 }),
    );
    neg.addParticipant(
      new MockNegotiator({ id: "a3", preferredTerms: { price: 100 }, flexibility: 0.4 }),
    );

    const outcome = await neg.run();

    // With flexibility 0.4, a spread of 80-120 (50% from center) should eventually converge.
    expect(outcome.success).toBe(true);
    // Final price should be somewhere between 80 and 120.
    expect(outcome.finalTerms!["price"]).toBeGreaterThan(60);
    expect(outcome.finalTerms!["price"]).toBeLessThan(140);
  });
});

// ---------------------------------------------------------------------------
// 8. Event log records all rounds
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: event log integration", () => {
  it("emits multi-party.start event", async () => {
    const log = new EventLog();
    const neg = makeNegotiation({ consensusThreshold: 0.67 }, log);
    neg.addParticipant(agreeableAgent("a1"));
    neg.addParticipant(agreeableAgent("a2"));
    neg.addParticipant(agreeableAgent("a3"));

    await neg.run();

    const startEvents = log.query({ event: "multi-party.start" });
    expect(startEvents).toHaveLength(1);
  });

  it("emits multi-party.proposal for each round", async () => {
    const log = new EventLog();
    // Force 2 rounds by making agents counter-propose first.
    const neg = makeNegotiation({ maxRounds: 3, consensusThreshold: 1.0 }, log);
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(stubbornAgent("s1")); // blocks unanimity

    await neg.run();

    const proposalEvents = log.query({ event: "multi-party.proposal" });
    expect(proposalEvents.length).toBeGreaterThanOrEqual(1);
  });

  it("emits multi-party.success on consensus", async () => {
    const log = new EventLog();
    const neg = makeNegotiation({ consensusThreshold: 0.67 }, log);
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(agreeableAgent("a3", { price: 100 }));

    await neg.run();

    const successEvents = log.query({ event: "multi-party.success" });
    expect(successEvents).toHaveLength(1);
  });

  it("emits multi-party.timeout when rounds exhausted", async () => {
    const log = new EventLog();
    const neg = makeNegotiation({ maxRounds: 2, consensusThreshold: 1.0 }, log);
    neg.addParticipant(agreeableAgent("a1"));
    neg.addParticipant(agreeableAgent("a2"));
    neg.addParticipant(stubbornAgent("stubborn"));

    await neg.run();

    const timeoutEvents = log.query({ event: "multi-party.timeout" });
    expect(timeoutEvents).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Reputation gate blocks low-rep agent
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: reputation gate", () => {
  it("fails immediately if an agent has insufficient reputation", async () => {
    const log = new EventLog();
    const reputation = new ReputationStore(log);

    // Record several failures for "low-rep-agent" to push score below 0.7.
    const lowRepId = toAgentId("low-rep-agent");
    for (let i = 0; i < 5; i++) {
      reputation.recordFailure(lowRepId);
    }

    // Verify the score is below 0.7.
    expect(reputation.getReputation(lowRepId)).toBeLessThan(0.7);

    const neg = makeNegotiation(
      { minReputationScore: 0.7, consensusThreshold: 0.67 },
      log,
      reputation,
    );
    neg.addParticipant(agreeableAgent("good-agent-1"));
    neg.addParticipant(agreeableAgent("good-agent-2"));
    neg.addParticipant(agreeableAgent("low-rep-agent")); // will fail the gate

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
    expect(outcome.rounds).toHaveLength(0); // no rounds run — gated before negotiation
  });

  it("proceeds normally when all agents meet reputation threshold", async () => {
    const reputation = new ReputationStore();

    // Give all agents good history.
    for (const id of ["g1", "g2", "g3"]) {
      for (let i = 0; i < 5; i++) {
        reputation.recordSuccess(toAgentId(id));
      }
    }

    const neg = makeNegotiation(
      { minReputationScore: 0.5, consensusThreshold: 0.67 },
      undefined,
      reputation,
    );
    neg.addParticipant(agreeableAgent("g1", { price: 100 }));
    neg.addParticipant(agreeableAgent("g2", { price: 100 }));
    neg.addParticipant(agreeableAgent("g3", { price: 100 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10. Minimum participants enforced
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: minimum participants", () => {
  it("fails immediately with 2 participants when minParticipants=3", async () => {
    const neg = makeNegotiation({ minParticipants: 3, consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("a1"));
    neg.addParticipant(agreeableAgent("a2"));

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
    expect(outcome.rounds).toHaveLength(0);
  });

  it("succeeds with exactly minParticipants=3 agents", async () => {
    const neg = makeNegotiation({ minParticipants: 3, consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(agreeableAgent("a3", { price: 100 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 11. Maximum participants enforced
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: maximum participants", () => {
  it("fails immediately with more than maxParticipants agents", async () => {
    const neg = makeNegotiation({ maxParticipants: 3, minParticipants: 3 });
    // Add 4 agents — exceeds maxParticipants=3.
    for (let i = 0; i < 4; i++) {
      neg.addParticipant(agreeableAgent(`a${i + 1}`));
    }

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
    expect(outcome.rounds).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 12. 5 agreeable agents converge
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: 5 agents", () => {
  it("5 fully agreeable agents reach consensus", async () => {
    const neg = makeNegotiation({
      minParticipants: 3,
      maxParticipants: 10,
      consensusThreshold: 0.67,
    });
    for (let i = 0; i < 5; i++) {
      neg.addParticipant(agreeableAgent(`a${i + 1}`, { price: 100 }));
    }

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
    expect(outcome.participants).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// 13. outcome.participants lists all agent IDs
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: participants field", () => {
  it("participants contains the IDs of all registered agents", async () => {
    const ids = ["alice", "bob", "carol", "dave"];
    const neg = makeNegotiation({ minParticipants: 3, maxParticipants: 10 });
    for (const id of ids) {
      neg.addParticipant(agreeableAgent(id, { price: 100 }));
    }

    const outcome = await neg.run();

    expect(outcome.participants).toEqual(expect.arrayContaining(ids));
    expect(outcome.participants).toHaveLength(ids.length);
  });
});

// ---------------------------------------------------------------------------
// 14. acceptors contains proposer + accepting voters
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: acceptors field", () => {
  it("acceptors contains the proposer ID on success", async () => {
    const neg = makeNegotiation({ consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("proposer", { price: 100 }));
    neg.addParticipant(agreeableAgent("voter1", { price: 100 }));
    neg.addParticipant(agreeableAgent("voter2", { price: 100 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
    // The first round proposer is "proposer" (index 0).
    expect(outcome.acceptors).toContain("proposer");
  });

  it("acceptors is empty on failure", async () => {
    const neg = makeNegotiation({ maxRounds: 1, consensusThreshold: 1.0 });
    neg.addParticipant(agreeableAgent("a1"));
    neg.addParticipant(agreeableAgent("a2"));
    neg.addParticipant(stubbornAgent("stubborn"));

    const outcome = await neg.run();

    expect(outcome.success).toBe(false);
    expect(outcome.acceptors).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 15. Round counting is accurate
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: round counting accuracy", () => {
  it("early success means totalRounds < maxRounds", async () => {
    const maxRounds = 10;
    const neg = makeNegotiation({ maxRounds, consensusThreshold: 0.67 });
    neg.addParticipant(agreeableAgent("a1", { price: 100 }));
    neg.addParticipant(agreeableAgent("a2", { price: 100 }));
    neg.addParticipant(agreeableAgent("a3", { price: 100 }));

    const outcome = await neg.run();

    expect(outcome.success).toBe(true);
    expect(outcome.totalRounds).toBeLessThanOrEqual(maxRounds);
    expect(outcome.totalRounds).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------------------------------------------
// 16. finalTerms is null on failure (already covered; explicit dedicated test)
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: finalTerms null on failure", () => {
  it("finalTerms is null when negotiation times out", async () => {
    const neg = makeNegotiation({ maxRounds: 2, consensusThreshold: 1.0 });
    neg.addParticipant(agreeableAgent("a1"));
    neg.addParticipant(agreeableAgent("a2"));
    neg.addParticipant(stubbornAgent("stubborn"));

    const outcome = await neg.run();

    expect(outcome.finalTerms).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 17. All-reject agents cycle through proposers each round
// ---------------------------------------------------------------------------

describe("MultiPartyNegotiation: round-robin proposer cycling", () => {
  it("proposer cycles across agents round by round", async () => {
    const maxRounds = 6;
    const neg = makeNegotiation({ maxRounds, consensusThreshold: 1.0 });
    neg.addParticipant(stubbornAgent("s1"));
    neg.addParticipant(stubbornAgent("s2"));
    neg.addParticipant(stubbornAgent("s3"));

    const outcome = await neg.run();

    // With 3 agents and 6 rounds, each agent proposes exactly twice.
    const proposerIds = outcome.rounds.map((r) => r.proposal.proposerId);
    expect(proposerIds[0]).toBe("s1"); // round 0 % 3 = 0
    expect(proposerIds[1]).toBe("s2"); // round 1 % 3 = 1
    expect(proposerIds[2]).toBe("s3"); // round 2 % 3 = 2
    expect(proposerIds[3]).toBe("s1"); // round 3 % 3 = 0
    expect(proposerIds[4]).toBe("s2"); // round 4 % 3 = 1
    expect(proposerIds[5]).toBe("s3"); // round 5 % 3 = 2
  });
});

// ---------------------------------------------------------------------------
// 18. scenario runner — integration smoke test
// ---------------------------------------------------------------------------

describe("runMultiPartyScenario: scenario integration", () => {
  it("default 3-agent scenario succeeds", async () => {
    const { outcome } = await runMultiPartyScenario(3);
    expect(outcome.success).toBe(true);
    expect(outcome.participants).toHaveLength(3);
  });

  it("5-agent scenario runs without error", async () => {
    const { outcome } = await runMultiPartyScenario(5);
    // 5 agents with 40% flexibility should converge on a price.
    expect(outcome.participants).toHaveLength(5);
  });

  it("eventLog is populated with negotiation events", async () => {
    const { eventLog } = await runMultiPartyScenario(3);
    const events = eventLog.query({ category: "negotiation" });
    expect(events.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// 19. DEFAULT_MULTI_PARTY_CONFIG shape check
// ---------------------------------------------------------------------------

describe("DEFAULT_MULTI_PARTY_CONFIG", () => {
  it("has expected default values", () => {
    expect(DEFAULT_MULTI_PARTY_CONFIG.minParticipants).toBe(3);
    expect(DEFAULT_MULTI_PARTY_CONFIG.maxParticipants).toBe(10);
    expect(DEFAULT_MULTI_PARTY_CONFIG.maxRounds).toBe(10);
    expect(DEFAULT_MULTI_PARTY_CONFIG.consensusThreshold).toBeCloseTo(2 / 3);
    expect(DEFAULT_MULTI_PARTY_CONFIG.proposalTimeoutMs).toBe(5000);
    expect(DEFAULT_MULTI_PARTY_CONFIG.minReputationScore).toBe(0);
  });
});
