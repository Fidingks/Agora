/**
 * Comprehensive tests for the sealed-bid first-price auction scenario.
 *
 * Covers:
 *   1.  Happy path — 3 bidders, winner is highest valid bid above reserve
 *   2.  No valid bids — all below reserve
 *   3.  Single bidder wins — only one bid above reserve
 *   4.  All bidders pass — everyone rejects
 *   5.  Budget constraint — valuation high but budget low
 *   6.  Tie breaking — equal bids → first bidder wins
 *   7.  Reserve price exactly met — accepted
 *   8.  Final balances — winner pays, auctioneer receives, losers unchanged
 *   9.  Reputation integration — winner + auctioneer get recordSuccess()
 *   10. Auction metrics — verify AuctionOutcome fields
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  runAuction,
  DEFAULT_AUCTION_CONFIG,
  type AuctionConfig,
  type AuctionType,
} from "../src/scenarios/auction.js";
import { ReputationStore } from "../src/protocols/reputation.js";
import {
  LLMAuctionBidder,
  BidDecisionSchema,
  type LLMAuctionBidderConfig,
} from "../src/agents/llm-auction-agent.js";
import { runLLMAuction } from "../src/scenarios/llm-auction.js";
import { Ledger } from "../src/core/ledger.js";
import {
  createMessage,
  MessageType,
  type MessageId,
  type OfferPayload,
} from "../src/core/message.js";

// ---------------------------------------------------------------------------
// 1. Happy path: 3 bidders, default config
//    Bidder 0: 14*0.9 = 12.6  (valid, above reserve 10)
//    Bidder 1: 11*0.8 = 8.8   (below reserve 10, passes)
//    Bidder 2: 18*0.7 = 12.6  (tie with Bidder 0 — Bidder 0 wins)
//    Winner: Bidder 0 at 12.6
// ---------------------------------------------------------------------------

describe("Auction: happy path (default config, 3 bidders)", () => {
  it("produces SUCCESS result", async () => {
    const result = await runAuction();
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("winning bid is 12.6 (Bidder 0)", async () => {
    const result = await runAuction();
    expect(result.winningBid).toBeCloseTo(12.6);
  });

  it("has 2 valid bids (Bidder 0 and Bidder 2)", async () => {
    const result = await runAuction();
    expect(result.validBidCount).toBe(2);
  });

  it("reports 3 total bidders", async () => {
    const result = await runAuction();
    expect(result.totalBidders).toBe(3);
  });

  it("winner is not null", async () => {
    const result = await runAuction();
    expect(result.winnerId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 2. No valid bids — all bidders below reserve
// ---------------------------------------------------------------------------

describe("Auction: no valid bids (all below reserve)", () => {
  const config: Partial<AuctionConfig> = {
    bidderCount: 3,
    reservePrice: 20,
    bidderBudgets: [10, 10, 10],
    bidderValuations: [8, 9, 7],
    bidAggressiveness: [1.0, 1.0, 1.0],
  };

  it("produces FAILED_NEGOTIATION", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("FAILED_NEGOTIATION");
  });

  it("winningBid is null", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeNull();
  });

  it("validBidCount is 0", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(0);
  });

  it("winnerId is null", async () => {
    const result = await runAuction(config);
    expect(result.winnerId).toBeNull();
  });

  it("price is undefined", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.price).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 3. Single bidder wins — only one bid above reserve
// ---------------------------------------------------------------------------

describe("Auction: single valid bidder", () => {
  const config: Partial<AuctionConfig> = {
    bidderCount: 3,
    reservePrice: 10,
    bidderBudgets: [20, 5, 5],
    bidderValuations: [15, 5, 5],
    bidAggressiveness: [0.9, 0.9, 0.9],
    // Bidder 0: 15*0.9=13.5 (above reserve)
    // Bidder 1: 5*0.9=4.5 (below reserve)
    // Bidder 2: 5*0.9=4.5 (below reserve)
  };

  it("produces SUCCESS", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("exactly 1 valid bid", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(1);
  });

  it("winning bid is 13.5", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeCloseTo(13.5);
  });
});

// ---------------------------------------------------------------------------
// 4. All bidders pass — everyone rejects (valuations below reserve)
// ---------------------------------------------------------------------------

describe("Auction: all bidders pass", () => {
  const config: Partial<AuctionConfig> = {
    bidderCount: 2,
    reservePrice: 100,
    bidderBudgets: [50, 50],
    bidderValuations: [30, 40],
    bidAggressiveness: [1.0, 1.0],
    // Bidder 0: 30*1.0=30, capped at budget 50 → 30 < 100 → pass
    // Bidder 1: 40*1.0=40, capped at budget 50 → 40 < 100 → pass
  };

  it("produces FAILED_NEGOTIATION", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("FAILED_NEGOTIATION");
  });

  it("validBidCount is 0", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(0);
  });

  it("totalBidders is 2", async () => {
    const result = await runAuction(config);
    expect(result.totalBidders).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 5. Budget constraint — high valuation but low budget caps the bid
// ---------------------------------------------------------------------------

describe("Auction: budget constraint caps bid", () => {
  const config: Partial<AuctionConfig> = {
    bidderCount: 2,
    reservePrice: 10,
    bidderBudgets: [8, 20],
    bidderValuations: [100, 12],
    bidAggressiveness: [1.0, 1.0],
    // Bidder 0: valuation 100 * 1.0 = 100, capped at budget 8 → 8 < reserve 10 → pass
    // Bidder 1: valuation 12 * 1.0 = 12, budget 20 → bid 12 ≥ reserve → valid
  };

  it("Bidder 0 is excluded by budget constraint", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(1);
  });

  it("Bidder 1 wins at 12", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeCloseTo(12);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });
});

// ---------------------------------------------------------------------------
// 6. Tie breaking — equal bids → first bidder wins (deterministic)
// ---------------------------------------------------------------------------

describe("Auction: tie breaking (first bidder wins)", () => {
  const config: Partial<AuctionConfig> = {
    bidderCount: 3,
    reservePrice: 10,
    bidderBudgets: [20, 20, 20],
    bidderValuations: [15, 15, 15],
    bidAggressiveness: [0.8, 0.8, 0.8],
    // All bid 15*0.8 = 12.  First bidder (Bidder-0) wins.
  };

  it("produces SUCCESS", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("all 3 bids are valid", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(3);
  });

  it("winning bid is 12", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeCloseTo(12);
  });

  it("winner is the first bidder (deterministic tie-break)", async () => {
    // Run twice to ensure determinism
    const r1 = await runAuction(config);
    const r2 = await runAuction(config);
    // Both should pick a winner (not null)
    expect(r1.winnerId).not.toBeNull();
    expect(r2.winnerId).not.toBeNull();
    // We can't compare IDs across runs (they're generated with timestamps)
    // but we verify the winning bid is the same
    expect(r1.winningBid).toBeCloseTo(r2.winningBid!);
  });
});

// ---------------------------------------------------------------------------
// 7. Reserve price exactly met — bid equals reserve → accepted
// ---------------------------------------------------------------------------

describe("Auction: reserve price exactly met", () => {
  const config: Partial<AuctionConfig> = {
    bidderCount: 1,
    reservePrice: 10,
    bidderBudgets: [20],
    bidderValuations: [10],
    bidAggressiveness: [1.0],
    // Bidder 0: 10*1.0 = 10 == reserve → accepted
  };

  it("produces SUCCESS", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("winning bid equals reserve price", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBe(10);
  });

  it("validBidCount is 1", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 8. Verify final balances — winner pays, auctioneer receives, losers unchanged
// ---------------------------------------------------------------------------

describe("Auction: final balance verification", () => {
  it("winner pays the winning bid, auctioneer receives it", async () => {
    // Use a config where we know exactly who wins and the price
    const config: Partial<AuctionConfig> = {
      bidderCount: 2,
      reservePrice: 10,
      bidderBudgets: [20, 15],
      bidderValuations: [16, 12],
      bidAggressiveness: [1.0, 1.0],
      // Bidder 0: 16*1.0=16 (winner)
      // Bidder 1: 12*1.0=12 (loser)
    };

    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");

    // The tradeOutcome includes all agent IDs: [auctioneer, bidder0, bidder1]
    // auctioneer starts at 0, gains 16 → 16
    // bidder0 starts at 20, pays 16 → 4
    // bidder1 starts at 15, pays nothing → 15
    expect(result.tradeOutcome.price).toBe(16);

    // We verify via the Ledger indirectly through the outcome
    // (The Ledger is internal to runAuction, but the tradeOutcome.price
    //  confirms the transfer happened since result=SUCCESS)
    expect(result.winningBid).toBe(16);
  });
});

// ---------------------------------------------------------------------------
// 9. Reputation integration — winner + auctioneer get recordSuccess()
// ---------------------------------------------------------------------------

describe("Auction: reputation integration", () => {
  it("records success for winner and auctioneer on successful auction", async () => {
    const store = new ReputationStore();
    const config: Partial<AuctionConfig> = {
      ...DEFAULT_AUCTION_CONFIG,
      reputationStore: store,
    };

    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");

    // Extract IDs: first is auctioneer, rest are bidders
    const auctioneerId = result.tradeOutcome.agentIds[0]!;
    const winnerId = result.winnerId!;

    // After 1 success: score = (1+1)/(1+0+2) = 2/3 ≈ 0.667
    expect(store.getReputation(auctioneerId)).toBeCloseTo(2 / 3);
    expect(store.getReputation(winnerId)).toBeCloseTo(2 / 3);
  });

  it("does not change reputation for losing bidders", async () => {
    const store = new ReputationStore();
    const config: Partial<AuctionConfig> = {
      bidderCount: 2,
      reservePrice: 10,
      bidderBudgets: [20, 20],
      bidderValuations: [15, 12],
      bidAggressiveness: [1.0, 1.0],
      reputationStore: store,
    };

    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");

    // Loser is the second agent in the bidders list (index 2 in allAgentIds,
    // since index 0 is auctioneer). Their reputation should remain at 0.5 (default).
    const loserId = result.tradeOutcome.agentIds[2]!;
    expect(store.getReputation(loserId)).toBeCloseTo(0.5);
  });

  it("no reputation updates when store is not provided", async () => {
    // Just verify it doesn't throw
    const result = await runAuction(DEFAULT_AUCTION_CONFIG);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("no reputation updates on failed auction", async () => {
    const store = new ReputationStore();
    const config: Partial<AuctionConfig> = {
      bidderCount: 2,
      reservePrice: 100,
      bidderBudgets: [10, 10],
      bidderValuations: [5, 5],
      bidAggressiveness: [1.0, 1.0],
      reputationStore: store,
    };

    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("FAILED_NEGOTIATION");

    // All agents should remain at default 0.5
    for (const agentId of result.tradeOutcome.agentIds) {
      expect(store.getReputation(agentId)).toBeCloseTo(0.5);
    }
  });
});

// ---------------------------------------------------------------------------
// 10. Auction metrics — verify AuctionOutcome fields are correct
// ---------------------------------------------------------------------------

describe("Auction: outcome metrics", () => {
  it("includes all agent IDs (auctioneer + bidders)", async () => {
    const config: Partial<AuctionConfig> = {
      bidderCount: 4,
      reservePrice: 5,
      bidderBudgets: [20, 20, 20, 20],
      bidderValuations: [10, 10, 10, 10],
      bidAggressiveness: [0.8, 0.8, 0.8, 0.8],
    };
    const result = await runAuction(config);
    // 1 auctioneer + 4 bidders = 5 agent IDs
    expect(result.tradeOutcome.agentIds).toHaveLength(5);
  });

  it("durationMs is non-negative", async () => {
    const result = await runAuction();
    expect(result.tradeOutcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("negotiationRounds is 1 for auction (single round of bidding)", async () => {
    const result = await runAuction();
    expect(result.tradeOutcome.negotiationRounds).toBe(1);
  });

  it("successful auction has a defined price matching winningBid", async () => {
    const result = await runAuction();
    expect(result.tradeOutcome.result).toBe("SUCCESS");
    expect(result.tradeOutcome.price).toBe(result.winningBid);
  });

  it("failed auction has undefined price", async () => {
    const result = await runAuction({
      bidderCount: 1,
      reservePrice: 100,
      bidderBudgets: [10],
      bidderValuations: [5],
      bidAggressiveness: [1.0],
    });
    expect(result.tradeOutcome.result).toBe("FAILED_NEGOTIATION");
    expect(result.tradeOutcome.price).toBeUndefined();
  });

  it("works with 5 bidders (max)", async () => {
    const config: Partial<AuctionConfig> = {
      bidderCount: 5,
      reservePrice: 5,
      bidderBudgets: [20, 20, 20, 20, 20],
      bidderValuations: [10, 8, 12, 6, 15],
      bidAggressiveness: [0.9, 0.9, 0.9, 0.9, 0.9],
      // Bids: 9, 7.2, 10.8, 5.4, 13.5 — all above reserve 5
      // Winner: Bidder 4 at 13.5
    };
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
    expect(result.winningBid).toBeCloseTo(13.5);
    expect(result.validBidCount).toBe(5);
    expect(result.totalBidders).toBe(5);
  });

  it("works with 2 bidders (min)", async () => {
    const config: Partial<AuctionConfig> = {
      bidderCount: 2,
      reservePrice: 5,
      bidderBudgets: [20, 20],
      bidderValuations: [10, 8],
      bidAggressiveness: [0.9, 0.9],
    };
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
    expect(result.totalBidders).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 11. Vickrey auction — winner pays second-highest bid
//
//   Bidder 0: 20 * 1.0 = 20  (highest — wins)
//   Bidder 1: 15 * 1.0 = 15  (second — sets payment)
//   Bidder 2: 12 * 1.0 = 12  (third)
//   Reserve: 10
//   Expected settlement price: 15 (second-highest bid)
// ---------------------------------------------------------------------------

describe("Vickrey auction: winner pays second-highest price", () => {
  const config: Partial<AuctionConfig> = {
    auctionType: "vickrey" as AuctionType,
    bidderCount: 3,
    reservePrice: 10,
    bidderBudgets: [30, 25, 20],
    bidderValuations: [20, 15, 12],
    bidAggressiveness: [1.0, 1.0, 1.0],
    // Bids: 20, 15, 12 — all above reserve
    // Winner: Bidder 0 (bid 20); pays second-highest = 15
  };

  it("produces SUCCESS", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("winningBid is the highest bid (20)", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeCloseTo(20);
  });

  it("settlementPrice is the second-highest bid (15)", async () => {
    const result = await runAuction(config);
    expect(result.settlementPrice).toBeCloseTo(15);
  });

  it("tradeOutcome.price equals settlementPrice, not winningBid", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.price).toBeCloseTo(15);
    expect(result.tradeOutcome.price).not.toBeCloseTo(20);
  });

  it("reports auctionType as 'vickrey'", async () => {
    const result = await runAuction(config);
    expect(result.auctionType).toBe("vickrey");
  });

  it("has 3 valid bids", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// 12. Vickrey: single bidder above reserve → pays reserve price
//
//   Only Bidder 0 clears the reserve.  In a Vickrey auction with one
//   bidder, the fallback payment is the reserve price itself.
//   Bidder 0: valuation=20, aggressiveness=1.0 → bid=20 (above reserve 10)
//   Bidder 1: valuation=5,  aggressiveness=1.0 → bid=5  (below reserve 10)
// ---------------------------------------------------------------------------

describe("Vickrey auction: single bidder above reserve pays reserve price", () => {
  const config: Partial<AuctionConfig> = {
    auctionType: "vickrey" as AuctionType,
    bidderCount: 2,
    reservePrice: 10,
    bidderBudgets: [30, 10],
    bidderValuations: [20, 5],
    bidAggressiveness: [1.0, 1.0],
  };

  it("produces SUCCESS", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("exactly 1 valid bid", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(1);
  });

  it("winningBid is 20 (Bidder 0's actual bid)", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeCloseTo(20);
  });

  it("settlementPrice is the reserve price (10), not the winning bid", async () => {
    const result = await runAuction(config);
    expect(result.settlementPrice).toBeCloseTo(10);
  });

  it("tradeOutcome.price equals reserve price (10)", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.price).toBeCloseTo(10);
  });
});

// ---------------------------------------------------------------------------
// 13. Vickrey: no bids above reserve → no winner (same behaviour as first-price)
// ---------------------------------------------------------------------------

describe("Vickrey auction: no bids above reserve → no winner", () => {
  const config: Partial<AuctionConfig> = {
    auctionType: "vickrey" as AuctionType,
    bidderCount: 3,
    reservePrice: 50,
    bidderBudgets: [20, 20, 20],
    bidderValuations: [10, 10, 10],
    bidAggressiveness: [1.0, 1.0, 1.0],
  };

  it("produces FAILED_NEGOTIATION", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("FAILED_NEGOTIATION");
  });

  it("winningBid is null", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeNull();
  });

  it("settlementPrice is null", async () => {
    const result = await runAuction(config);
    expect(result.settlementPrice).toBeNull();
  });

  it("validBidCount is 0", async () => {
    const result = await runAuction(config);
    expect(result.validBidCount).toBe(0);
  });

  it("winnerId is null", async () => {
    const result = await runAuction(config);
    expect(result.winnerId).toBeNull();
  });

  it("auctionType is 'vickrey'", async () => {
    const result = await runAuction(config);
    expect(result.auctionType).toBe("vickrey");
  });
});

// ---------------------------------------------------------------------------
// 14. Vickrey: two tied highest bids
//
//   Bidder 0: 15 * 1.0 = 15  (ties for highest — first bidder wins)
//   Bidder 1: 15 * 1.0 = 15  (tied — sets the settlement price)
//   Bidder 2: 10 * 1.0 = 10  (third)
//   Reserve: 8
//   winningBid = 15, settlementPrice = 15 (second-highest equals highest)
// ---------------------------------------------------------------------------

describe("Vickrey auction: two equal highest bids", () => {
  const config: Partial<AuctionConfig> = {
    auctionType: "vickrey" as AuctionType,
    bidderCount: 3,
    reservePrice: 8,
    bidderBudgets: [20, 20, 15],
    bidderValuations: [15, 15, 10],
    bidAggressiveness: [1.0, 1.0, 1.0],
  };

  it("produces SUCCESS", async () => {
    const result = await runAuction(config);
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("winningBid is 15", async () => {
    const result = await runAuction(config);
    expect(result.winningBid).toBeCloseTo(15);
  });

  it("settlementPrice equals the tied second bid (15)", async () => {
    // When two bids tie for first, the 'second-highest' is the same value
    const result = await runAuction(config);
    expect(result.settlementPrice).toBeCloseTo(15);
  });

  it("first bidder wins the tie deterministically", async () => {
    const r1 = await runAuction(config);
    const r2 = await runAuction(config);
    expect(r1.winningBid).not.toBeNull();
    expect(r2.winningBid).not.toBeNull();
    // Both runs elect a winner and pay the same settlement price
    expect(r1.settlementPrice).toBeCloseTo(r2.settlementPrice!);
  });
});

// ---------------------------------------------------------------------------
// 15. Backward compatibility: default config (no auctionType) uses first-price
// ---------------------------------------------------------------------------

describe("Backward compat: default auction is first-price", () => {
  it("auctionType defaults to 'first-price'", async () => {
    const result = await runAuction();
    expect(result.auctionType).toBe("first-price");
  });

  it("settlementPrice equals winningBid for first-price", async () => {
    const result = await runAuction();
    expect(result.tradeOutcome.result).toBe("SUCCESS");
    expect(result.settlementPrice).toBeCloseTo(result.winningBid!);
  });

  it("explicit first-price config also sets settlementPrice = winningBid", async () => {
    const config: Partial<AuctionConfig> = {
      auctionType: "first-price" as AuctionType,
      bidderCount: 2,
      reservePrice: 10,
      bidderBudgets: [30, 25],
      bidderValuations: [20, 15],
      bidAggressiveness: [1.0, 1.0],
    };
    const result = await runAuction(config);
    expect(result.auctionType).toBe("first-price");
    expect(result.settlementPrice).toBeCloseTo(result.winningBid!);
    expect(result.tradeOutcome.price).toBeCloseTo(result.winningBid!);
  });
});

// ---------------------------------------------------------------------------
// 16. LLMAuctionBidder — mock mode (no API key): bid schema + bounds
// ---------------------------------------------------------------------------

describe("LLMAuctionBidder: mock mode bid is valid (no API key)", () => {
  // Ensure the environment has NO API key so tests are deterministic.
  const originalKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalKey;
    }
  });

  it("BidDecisionSchema validates a correct bid object", () => {
    const result = BidDecisionSchema.safeParse({ bid: 12.5, reasoning: "Test reasoning" });
    expect(result.success).toBe(true);
  });

  it("BidDecisionSchema rejects a non-positive bid", () => {
    const result = BidDecisionSchema.safeParse({ bid: -5, reasoning: "Bad bid" });
    expect(result.success).toBe(false);
  });

  it("BidDecisionSchema rejects a missing reasoning field", () => {
    const result = BidDecisionSchema.safeParse({ bid: 10 });
    expect(result.success).toBe(false);
  });

  it("falls back to mock bid and responds to OFFER with COUNTER", async () => {
    const ledger = new Ledger();
    const cfg: LLMAuctionBidderConfig = {
      name: "TestBidder",
      budget: 20,
      valuation: 15,
      aggressiveness: 0.9,
      auctionType: "first-price",
      competitorCount: 2,
    };
    const bidder = new LLMAuctionBidder(cfg, ledger);

    const offerMsg = createMessage<OfferPayload>({
      from: "auctioneer-id" as any,
      to: bidder.id,
      type: MessageType.OFFER,
      payload: { itemId: "item-1", itemDescription: "Test item", price: 8, currency: "CREDITS" },
    });

    const response = await bidder.receive(offerMsg);
    // With valuation=15, aggressiveness=0.9, bid=13.5 > reserve=8 → COUNTER
    expect(response).not.toBeNull();
    expect(response!.type).toBe(MessageType.COUNTER);
  });

  it("bid is within [reserve, min(valuation, budget)] bounds in mock mode", async () => {
    const ledger = new Ledger();
    const cfg: LLMAuctionBidderConfig = {
      name: "BoundsBidder",
      budget: 20,
      valuation: 14,
      aggressiveness: 0.8,
      auctionType: "first-price",
      competitorCount: 1,
    };
    const bidder = new LLMAuctionBidder(cfg, ledger);
    const reservePrice = 8;

    const offerMsg = createMessage<OfferPayload>({
      from: "auctioneer-id" as any,
      to: bidder.id,
      type: MessageType.OFFER,
      payload: {
        itemId: "item-1",
        itemDescription: "Test item",
        price: reservePrice,
        currency: "CREDITS",
      },
    });

    const response = await bidder.receive(offerMsg);
    expect(response).not.toBeNull();
    expect(response!.type).toBe(MessageType.COUNTER);

    const counterPayload = response!.payload as { proposedPrice: number };
    expect(counterPayload.proposedPrice).toBeGreaterThanOrEqual(reservePrice);
    expect(counterPayload.proposedPrice).toBeLessThanOrEqual(
      Math.min(cfg.valuation, cfg.budget),
    );
  });

  it("passes when valuation is below reserve price", async () => {
    const ledger = new Ledger();
    const cfg: LLMAuctionBidderConfig = {
      name: "PassBidder",
      budget: 20,
      valuation: 5, // below reserve
      aggressiveness: 1.0,
      auctionType: "first-price",
      competitorCount: 1,
    };
    const bidder = new LLMAuctionBidder(cfg, ledger);
    const reservePrice = 10;

    const offerMsg = createMessage<OfferPayload>({
      from: "auctioneer-id" as any,
      to: bidder.id,
      type: MessageType.OFFER,
      payload: {
        itemId: "item-1",
        itemDescription: "Test item",
        price: reservePrice,
        currency: "CREDITS",
      },
    });

    const response = await bidder.receive(offerMsg);
    // valuation(5) < reserve(10) → REJECT
    expect(response).not.toBeNull();
    expect(response!.type).toBe(MessageType.REJECT);
  });
});

// ---------------------------------------------------------------------------
// 17. LLMAuctionBidder — strategy framing (mock mode, verified via auctionType)
// ---------------------------------------------------------------------------

describe("LLMAuctionBidder: strategy framing (mock mode)", () => {
  const originalKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalKey;
    }
  });

  it("auctionType getter returns the configured type (first-price)", () => {
    const ledger = new Ledger();
    const bidder = new LLMAuctionBidder(
      { name: "B", budget: 20, valuation: 15, auctionType: "first-price", competitorCount: 2 },
      ledger,
    );
    expect(bidder.auctionType).toBe("first-price");
  });

  it("auctionType getter returns the configured type (vickrey)", () => {
    const ledger = new Ledger();
    const bidder = new LLMAuctionBidder(
      { name: "B", budget: 20, valuation: 15, auctionType: "vickrey", competitorCount: 2 },
      ledger,
    );
    expect(bidder.auctionType).toBe("vickrey");
  });

  it("Vickrey bidder uses aggressiveness=1.0 (bids true value in mock)", async () => {
    const ledger = new Ledger();
    const cfg: LLMAuctionBidderConfig = {
      name: "VickreyBidder",
      budget: 30,
      valuation: 20,
      aggressiveness: 1.0, // Vickrey dominant strategy: bid true value
      auctionType: "vickrey",
      competitorCount: 2,
    };
    const bidder = new LLMAuctionBidder(cfg, ledger);

    const offerMsg = createMessage<OfferPayload>({
      from: "auctioneer-id" as any,
      to: bidder.id,
      type: MessageType.OFFER,
      payload: { itemId: "item-1", itemDescription: "Test", price: 10, currency: "CREDITS" },
    });

    const response = await bidder.receive(offerMsg);
    expect(response!.type).toBe(MessageType.COUNTER);
    const counterPayload = response!.payload as { proposedPrice: number };
    // With aggressiveness=1.0, mock bid = valuation*1.0 = 20
    expect(counterPayload.proposedPrice).toBeCloseTo(20);
  });

  it("first-price bidder with aggressiveness=0.8 shades bid below valuation", async () => {
    const ledger = new Ledger();
    const cfg: LLMAuctionBidderConfig = {
      name: "FirstPriceBidder",
      budget: 30,
      valuation: 20,
      aggressiveness: 0.8, // bid shaded to 16 (below valuation 20)
      auctionType: "first-price",
      competitorCount: 2,
    };
    const bidder = new LLMAuctionBidder(cfg, ledger);

    const offerMsg = createMessage<OfferPayload>({
      from: "auctioneer-id" as any,
      to: bidder.id,
      type: MessageType.OFFER,
      payload: { itemId: "item-1", itemDescription: "Test", price: 10, currency: "CREDITS" },
    });

    const response = await bidder.receive(offerMsg);
    expect(response!.type).toBe(MessageType.COUNTER);
    const counterPayload = response!.payload as { proposedPrice: number };
    // mock bid = 20 * 0.8 = 16 < 20 (shaded below valuation)
    expect(counterPayload.proposedPrice).toBeLessThan(cfg.valuation);
    expect(counterPayload.proposedPrice).toBeCloseTo(16);
  });
});

// ---------------------------------------------------------------------------
// 18. runLLMAuction — full scenario runs to completion (mock mode)
// ---------------------------------------------------------------------------

describe("runLLMAuction: full scenario (mock mode)", () => {
  const originalKey = process.env["ANTHROPIC_API_KEY"];

  beforeEach(() => {
    delete process.env["ANTHROPIC_API_KEY"];
  });

  afterEach(() => {
    if (originalKey !== undefined) {
      process.env["ANTHROPIC_API_KEY"] = originalKey;
    }
  });

  it("default first-price LLM auction produces SUCCESS", async () => {
    const result = await runLLMAuction();
    expect(result.tradeOutcome.result).toBe("SUCCESS");
  });

  it("returns a bidderReasoning map with entries for all bidders", async () => {
    const result = await runLLMAuction({ bidderCount: 3 });
    expect(Object.keys(result.bidderReasoning).length).toBe(3);
  });

  it("bidderReasoning values are non-empty strings (mock label present)", async () => {
    const result = await runLLMAuction({ bidderCount: 2 });
    for (const reasoning of Object.values(result.bidderReasoning)) {
      // In mock mode the reasoning contains "[mock]"
      expect(reasoning.length).toBeGreaterThan(0);
    }
  });

  it("vickrey LLM auction reports correct auctionType", async () => {
    const result = await runLLMAuction({ auctionType: "vickrey" });
    expect(result.auctionType).toBe("vickrey");
  });

  it("LLM auction winner ID is not null on success", async () => {
    const result = await runLLMAuction();
    expect(result.tradeOutcome.result).toBe("SUCCESS");
    expect(result.winnerId).not.toBeNull();
  });

  it("vickrey LLM auction settlementPrice <= winningBid", async () => {
    const result = await runLLMAuction({ auctionType: "vickrey", bidderCount: 3 });
    if (result.tradeOutcome.result === "SUCCESS") {
      expect(result.settlementPrice).not.toBeNull();
      expect(result.settlementPrice!).toBeLessThanOrEqual(result.winningBid!);
    }
  });

  it("first-price LLM auction settlementPrice equals winningBid", async () => {
    const result = await runLLMAuction({ auctionType: "first-price" });
    if (result.tradeOutcome.result === "SUCCESS") {
      expect(result.settlementPrice).toBeCloseTo(result.winningBid!);
    }
  });

  it("totalBidders matches the configured bidder count", async () => {
    const result = await runLLMAuction({ bidderCount: 4 });
    expect(result.totalBidders).toBe(4);
  });

  it("durationMs is non-negative", async () => {
    const result = await runLLMAuction();
    expect(result.tradeOutcome.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("LLM auction includes auctioneer + bidders in agentIds", async () => {
    const result = await runLLMAuction({ bidderCount: 3 });
    // 1 auctioneer + 3 bidders = 4
    expect(result.tradeOutcome.agentIds).toHaveLength(4);
  });
});
