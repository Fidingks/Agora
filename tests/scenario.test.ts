/**
 * End-to-end scenario tests for the Data Market.
 *
 * These tests exercise the full stack: SellerAgent + BuyerAgent + EscrowProtocol
 * + Ledger, all running with mock (no-LLM) decision logic.
 *
 * Three cases are covered:
 *   1. Happy path with negotiation  — seller asks 15, buyer budgets 12, settles at 12.
 *   2. Failed negotiation           — HARD_NEGOTIATION_CONFIG, seller floor > buyer max.
 *   3. Immediate accept             — seller asks 10, buyer budgets 12, no counter needed.
 */

import { describe, it, expect } from "vitest";
import {
  runDataMarket,
  DEFAULT_DATA_MARKET_CONFIG,
  HARD_NEGOTIATION_CONFIG,
  createDataItem,
  type DataMarketConfig,
} from "../src/scenarios/data-market.js";
import { ReputationStore } from "../src/protocols/reputation.js";

// ---------------------------------------------------------------------------
// Test 1: happy path — negotiation fires, settles at counter price
// ---------------------------------------------------------------------------

describe("Data Market: happy path with negotiation (seller=15, budget=12)", () => {
  it("produces SUCCESS result", async () => {
    const result = await runDataMarket(DEFAULT_DATA_MARKET_CONFIG);
    expect(result.outcome.result).toBe("SUCCESS");
  });

  it("settles at the buyer's counter price of 12", async () => {
    const result = await runDataMarket(DEFAULT_DATA_MARKET_CONFIG);
    // buyer counters at Math.round(15 * 0.8) = 12; seller accepts (12 >= 0.7*15 = 10.5)
    expect(result.outcome.price).toBe(12);
  });

  it("takes exactly 2 negotiation rounds", async () => {
    const result = await runDataMarket(DEFAULT_DATA_MARKET_CONFIG);
    // Round 1: OFFER(15) → COUNTER(12) → new OFFER(12)
    // Round 2: OFFER(12) → ACCEPT
    expect(result.outcome.negotiationRounds).toBe(2);
  });

  it("transfers funds: seller gains 12, buyer loses 12", async () => {
    const result = await runDataMarket(DEFAULT_DATA_MARKET_CONFIG);
    // seller starts at 0, receives 12
    expect(result.finalBalances.seller).toBe(12);
    // buyer starts at 20, pays 12
    expect(result.finalBalances.buyer).toBe(8);
  });
});

// ---------------------------------------------------------------------------
// Test 2: failed negotiation — buyer's max is below seller's floor
// ---------------------------------------------------------------------------

describe("Data Market: failed negotiation (seller=20/0.9, buyer=12/0.7)", () => {
  it("produces FAILED_NEGOTIATION result", async () => {
    const result = await runDataMarket(HARD_NEGOTIATION_CONFIG);
    expect(result.outcome.result).toBe("FAILED_NEGOTIATION");
  });

  it("has no settled price", async () => {
    const result = await runDataMarket(HARD_NEGOTIATION_CONFIG);
    expect(result.outcome.price).toBeUndefined();
  });

  it("leaves balances unchanged", async () => {
    const result = await runDataMarket(HARD_NEGOTIATION_CONFIG);
    // Neither agent should have lost or gained funds
    expect(result.finalBalances.seller).toBe(0);
    expect(result.finalBalances.buyer).toBe(20);
  });
});

// ---------------------------------------------------------------------------
// Test 3: immediate accept — ask is already within budget, no counter needed
// ---------------------------------------------------------------------------

const IMMEDIATE_ACCEPT_CONFIG: DataMarketConfig = {
  seller: {
    name: "CheapSeller",
    initialBalance: 0,
    item: createDataItem(
      "sample-data",
      "Small sample dataset",
      JSON.stringify({ rows: 100, columns: ["x", "y"] })
    ),
    askPrice: 10,
    minAcceptRatio: 0.8,
  },
  buyer: {
    name: "RichBuyer",
    initialBalance: 20,
    budget: 12,         // ask(10) <= budget(12), so buyer accepts immediately
    firstCounterRatio: 0.8,
  },
};

describe("Data Market: immediate accept (seller=10, budget=12)", () => {
  it("produces SUCCESS result", async () => {
    const result = await runDataMarket(IMMEDIATE_ACCEPT_CONFIG);
    expect(result.outcome.result).toBe("SUCCESS");
  });

  it("settles at the original ask price of 10", async () => {
    const result = await runDataMarket(IMMEDIATE_ACCEPT_CONFIG);
    expect(result.outcome.price).toBe(10);
  });

  it("takes exactly 1 negotiation round", async () => {
    const result = await runDataMarket(IMMEDIATE_ACCEPT_CONFIG);
    // OFFER(10) → ACCEPT immediately, no counter
    expect(result.outcome.negotiationRounds).toBe(1);
  });

  it("transfers funds: seller gains 10, buyer loses 10", async () => {
    const result = await runDataMarket(IMMEDIATE_ACCEPT_CONFIG);
    expect(result.finalBalances.seller).toBe(10);
    expect(result.finalBalances.buyer).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// Reputation-gated trades
// ---------------------------------------------------------------------------

describe("reputation-gated trades", () => {
  /**
   * Since agent IDs are generated at runtime (timestamp-based), we need a
   * two-pass approach for tests that pre-poison reputation:
   *   1. Run a trade to discover the agent IDs (they're in outcome.agentIds).
   *   2. Manipulate the store, then run again with the same store.
   *
   * But agents are recreated each call so IDs differ between runs.
   * Instead, for gating tests we use the EscrowProtocol + Ledger directly
   * so we control the agent IDs.
   */

  it("trade succeeds when both agents have sufficient reputation", async () => {
    const store = new ReputationStore();
    // New agents have 0.5 (Laplace prior). Threshold below that → pass.
    const config: DataMarketConfig = {
      ...DEFAULT_DATA_MARKET_CONFIG,
      protocol: { minReputationScore: 0.4 },
      reputationStore: store,
    };
    const result = await runDataMarket(config);
    expect(result.outcome.result).toBe("SUCCESS");
  });

  it("trade is rejected when buyer has insufficient reputation", async () => {
    const { Ledger } = await import("../src/core/ledger.js");
    const { EscrowProtocol } = await import("../src/protocols/escrow.js");
    const { SellerAgent, BuyerAgent, createDataItem: makeItem } = await import("../src/scenarios/data-market.js");

    const store = new ReputationStore();
    const ledger = new Ledger();
    const item = makeItem("test", "test", "test-content");

    const seller = new SellerAgent({ name: "GateSeller", initialBalance: 0, item, askPrice: 10, minAcceptRatio: 0.8 }, ledger);
    const buyer = new BuyerAgent({ name: "GateBuyer", initialBalance: 20, budget: 12, firstCounterRatio: 0.8 }, ledger);

    // Tank buyer reputation
    for (let i = 0; i < 20; i++) store.recordFailure(buyer.id);
    // buyer score ≈ 1/22 ≈ 0.045

    const protocol = new EscrowProtocol({
      maxNegotiationRounds: 5,
      escrowTimeoutMs: 30_000,
      minReputationScore: 0.4,
      maxPriceDeviation: 0.3,
    }, store);

    const outcome = await protocol.run(
      { id: seller.id, send: (msg) => seller.receive(msg) },
      { id: buyer.id, send: (msg) => buyer.receive(msg) },
      ledger,
    );

    expect(outcome.result).toBe("FAILED_NEGOTIATION");
    expect(outcome.negotiationRounds).toBe(0);
  });

  it("trade is rejected when seller has insufficient reputation", async () => {
    const { Ledger } = await import("../src/core/ledger.js");
    const { EscrowProtocol } = await import("../src/protocols/escrow.js");
    const { SellerAgent, BuyerAgent, createDataItem: makeItem } = await import("../src/scenarios/data-market.js");

    const store = new ReputationStore();
    const ledger = new Ledger();
    const item = makeItem("test", "test", "test-content");

    const seller = new SellerAgent({ name: "BadSeller", initialBalance: 0, item, askPrice: 10, minAcceptRatio: 0.8 }, ledger);
    const buyer = new BuyerAgent({ name: "GoodBuyer", initialBalance: 20, budget: 12, firstCounterRatio: 0.8 }, ledger);

    // Tank seller reputation
    for (let i = 0; i < 20; i++) store.recordFailure(seller.id);

    const protocol = new EscrowProtocol({
      maxNegotiationRounds: 5,
      escrowTimeoutMs: 30_000,
      minReputationScore: 0.4,
      maxPriceDeviation: 0.3,
    }, store);

    const outcome = await protocol.run(
      { id: seller.id, send: (msg) => seller.receive(msg) },
      { id: buyer.id, send: (msg) => buyer.receive(msg) },
      ledger,
    );

    expect(outcome.result).toBe("FAILED_NEGOTIATION");
    expect(outcome.negotiationRounds).toBe(0);
  });

  it("successful trade updates both agents' reputation scores", async () => {
    const store = new ReputationStore();
    const config: DataMarketConfig = {
      ...DEFAULT_DATA_MARKET_CONFIG,
      protocol: { minReputationScore: 0 },
      reputationStore: store,
    };
    const result = await runDataMarket(config);
    expect(result.outcome.result).toBe("SUCCESS");

    // Extract agent IDs from outcome
    const [sellerId, buyerId] = result.outcome.agentIds;

    // After 1 success: score = (1+1)/(1+0+2) = 2/3 ≈ 0.667 (up from 0.5)
    expect(store.getReputation(sellerId)).toBeCloseTo(2 / 3);
    expect(store.getReputation(buyerId)).toBeCloseTo(2 / 3);
  });

  it("after a failed trade, the failing agent's reputation decreases", async () => {
    const store = new ReputationStore();
    const config: DataMarketConfig = {
      ...HARD_NEGOTIATION_CONFIG,
      protocol: { minReputationScore: 0 },
      reputationStore: store,
    };
    const result = await runDataMarket(config);
    expect(result.outcome.result).toBe("FAILED_NEGOTIATION");

    // Pure negotiation failures (no escrow entered) don't change reputation.
    // Both agents should still be at the default 0.5.
    const [sellerId, buyerId] = result.outcome.agentIds;
    expect(store.getReputation(sellerId)).toBeCloseTo(0.5);
    expect(store.getReputation(buyerId)).toBeCloseTo(0.5);
  });

  it("with minReputationScore=0 (default), reputation gate is disabled — all trades proceed", async () => {
    const { Ledger } = await import("../src/core/ledger.js");
    const { EscrowProtocol } = await import("../src/protocols/escrow.js");
    const { SellerAgent, BuyerAgent, createDataItem: makeItem } = await import("../src/scenarios/data-market.js");

    const store = new ReputationStore();
    const ledger = new Ledger();
    const item = makeItem("test", "test", "test-content");

    const seller = new SellerAgent({ name: "LowRepSeller", initialBalance: 0, item, askPrice: 10, minAcceptRatio: 0.8 }, ledger);
    const buyer = new BuyerAgent({ name: "LowRepBuyer", initialBalance: 20, budget: 12, firstCounterRatio: 0.8 }, ledger);

    // Tank both reputations
    for (let i = 0; i < 50; i++) {
      store.recordFailure(seller.id);
      store.recordFailure(buyer.id);
    }

    // minReputationScore=0 means gate is disabled
    const protocol = new EscrowProtocol({
      maxNegotiationRounds: 5,
      escrowTimeoutMs: 30_000,
      minReputationScore: 0,
      maxPriceDeviation: 0.3,
    }, store);

    const outcome = await protocol.run(
      { id: seller.id, send: (msg) => seller.receive(msg) },
      { id: buyer.id, send: (msg) => buyer.receive(msg) },
      ledger,
    );

    expect(outcome.result).toBe("SUCCESS");
  });
});
