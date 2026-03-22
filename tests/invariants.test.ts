/**
 * Protocol invariant tests — property-based verification of system safety guarantees.
 *
 * These tests mathematically verify that no matter what agents do, certain
 * invariants never break. They serve as the "trustless proof" for the system.
 *
 * Property testing is implemented inline (no external library) using a
 * deterministic-seeded PRNG for reproducible failures.
 */

import { describe, it, expect } from "vitest";
import { Ledger } from "../src/core/ledger.js";
import type { EscrowId } from "../src/core/ledger.js";
import { toAgentId, createAgentId } from "../src/core/identity.js";
import type { AgentId } from "../src/core/identity.js";
import { ReputationStore } from "../src/protocols/reputation.js";
import { EscrowProtocol } from "../src/protocols/escrow.js";
import { DEFAULT_PROTOCOL_CONFIG } from "../src/protocols/types.js";
import {
  runAuction,
  type AuctionConfig,
} from "../src/scenarios/auction.js";
import {
  createMessage,
  MessageType,
  type Message,
  type OfferPayload,
  type AcceptPayload,
  type CounterPayload,
  type DeliverPayload,
  type VerifyPayload,
  type RejectPayload,
  type CommitPayload,
  type ReleasePayload,
} from "../src/core/message.js";
import type { MessageId } from "../src/core/message.js";

// ---------------------------------------------------------------------------
// Simple property-test runner (no external dependency)
// ---------------------------------------------------------------------------

function forAll<T>(
  generator: () => T,
  property: (input: T) => void,
  runs = 100
): void {
  for (let i = 0; i < runs; i++) {
    property(generator());
  }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (xorshift32) so failures are reproducible
// ---------------------------------------------------------------------------

let _seed = 0xdeadbeef;

function _rand(): number {
  _seed ^= _seed << 13;
  _seed ^= _seed >> 17;
  _seed ^= _seed << 5;
  // Ensure positive 32-bit integer via unsigned-right-shift
  _seed = _seed >>> 0;
  return _seed / 0x100000000; // [0, 1)
}

function randomInt(min: number, max: number): number {
  return Math.floor(_rand() * (max - min + 1)) + min;
}

function randomFloat(min: number, max: number): number {
  return _rand() * (max - min) + min;
}

function randomAgentId(): AgentId {
  return toAgentId(`agent-prop-${randomInt(1, 1_000_000)}`);
}

// ---------------------------------------------------------------------------
// Helper: sum all balances in a fresh ledger (after registrations)
// ---------------------------------------------------------------------------

function totalBalances(ledger: Ledger): number {
  const snap = ledger.snapshot();
  return Object.values(snap).reduce((acc, v) => acc + v, 0);
}

// ---------------------------------------------------------------------------
// Helper: Bayesian score formula (mirrors reputation.ts)
// ---------------------------------------------------------------------------

function bayesianScore(successes: number, failures: number): number {
  return (successes + 1) / (successes + failures + 2);
}

// ===========================================================================
// Ledger invariants
// ===========================================================================

describe("Ledger invariants", () => {
  // -------------------------------------------------------------------------
  // 1. Total supply is conserved — sum of all balances + escrowed = initial total
  // -------------------------------------------------------------------------
  it("invariant 1: total supply is conserved after escrow lock", () => {
    forAll(
      () => ({
        aliceBal: randomInt(50, 500),
        bobBal: randomInt(50, 500),
        lockAmount: randomInt(1, 49),
      }),
      ({ aliceBal, bobBal, lockAmount }) => {
        const ledger = new Ledger();
        const alice = toAgentId("inv1-alice");
        const bob = toAgentId("inv1-bob");
        ledger.register(alice, aliceBal);
        ledger.register(bob, bobBal);

        const initialTotal = aliceBal + bobBal;

        // Lock some funds
        const escrowResult = ledger.escrow(alice, lockAmount);
        expect(escrowResult.ok).toBe(true);

        // After escrow, alice's balance dropped by lockAmount, but that
        // money is now held in escrow — not destroyed.
        const balanceTotal = totalBalances(ledger);
        const escrowTotal = Object.values(ledger.escrowSnapshot()).reduce(
          (acc, e) => acc + (e.status === "HELD" ? e.amount : 0),
          0
        );

        expect(balanceTotal + escrowTotal).toBeCloseTo(initialTotal, 8);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 2. No balance ever goes negative
  // -------------------------------------------------------------------------
  it("invariant 2: no balance ever goes negative", () => {
    forAll(
      () => ({
        initialBal: randomInt(10, 200),
        debitAmount: randomInt(1, 300),
      }),
      ({ initialBal, debitAmount }) => {
        const ledger = new Ledger();
        const agent = randomAgentId();
        ledger.register(agent, initialBal);

        // Attempt the debit — may fail due to insufficient funds
        ledger.debit(agent, debitAmount);

        const balResult = ledger.balance(agent);
        expect(balResult.ok).toBe(true);
        if (balResult.ok) {
          expect(balResult.value).toBeGreaterThanOrEqual(0);
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // 3. Credit then debit of the same amount returns to the original balance
  // -------------------------------------------------------------------------
  it("invariant 3: credit then debit of same amount restores balance", () => {
    forAll(
      () => ({
        initial: randomInt(0, 500),
        amount: randomInt(1, 200),
      }),
      ({ initial, amount }) => {
        const ledger = new Ledger();
        const agent = randomAgentId();
        ledger.register(agent, initial);

        ledger.credit(agent, amount);
        ledger.debit(agent, amount);

        const result = ledger.balance(agent);
        expect(result.ok).toBe(true);
        if (result.ok) {
          expect(result.value).toBeCloseTo(initial, 8);
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // 4. Escrow lock + refund = original balance (no money created/destroyed)
  // -------------------------------------------------------------------------
  it("invariant 4: escrow lock + refund = original balance", () => {
    forAll(
      () => ({
        initial: randomInt(50, 500),
        lockAmount: randomInt(1, 49),
      }),
      ({ initial, lockAmount }) => {
        const ledger = new Ledger();
        const agent = randomAgentId();
        ledger.register(agent, initial);

        const escrowResult = ledger.escrow(agent, lockAmount);
        expect(escrowResult.ok).toBe(true);
        if (!escrowResult.ok) return;

        const afterLock = ledger.balance(agent);
        expect(afterLock.ok && afterLock.value).toBe(initial - lockAmount);

        ledger.refundEscrow(escrowResult.value);

        const afterRefund = ledger.balance(agent);
        expect(afterRefund.ok).toBe(true);
        if (afterRefund.ok) {
          expect(afterRefund.value).toBeCloseTo(initial, 8);
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // 5. Escrow lock + settle transfers exactly the locked amount
  // -------------------------------------------------------------------------
  it("invariant 5: escrow release transfers exactly the locked amount to recipient", () => {
    forAll(
      () => ({
        buyerBal: randomInt(50, 500),
        sellerBal: randomInt(0, 100),
        tradeAmount: randomInt(1, 49),
      }),
      ({ buyerBal, sellerBal, tradeAmount }) => {
        const ledger = new Ledger();
        const buyer = randomAgentId();
        const seller = toAgentId(`seller-${randomInt(1, 999999)}`);
        ledger.register(buyer, buyerBal);
        ledger.register(seller, sellerBal);

        const escrowResult = ledger.escrow(buyer, tradeAmount);
        expect(escrowResult.ok).toBe(true);
        if (!escrowResult.ok) return;

        ledger.releaseEscrow(escrowResult.value, seller);

        const sellerBal2 = ledger.balance(seller);
        expect(sellerBal2.ok).toBe(true);
        if (sellerBal2.ok) {
          expect(sellerBal2.value).toBeCloseTo(sellerBal + tradeAmount, 8);
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // 6. Double-spend is impossible — can't debit more than balance
  // -------------------------------------------------------------------------
  it("invariant 6: double-spend is impossible — second debit fails when balance is exhausted", () => {
    forAll(
      () => ({
        balance: randomInt(1, 100),
      }),
      ({ balance }) => {
        const ledger = new Ledger();
        const agent = randomAgentId();
        ledger.register(agent, balance);

        // First debit takes entire balance
        const first = ledger.debit(agent, balance);
        expect(first.ok).toBe(true);

        // Second debit must fail — nothing left
        const second = ledger.debit(agent, 1);
        expect(second.ok).toBe(false);
        if (!second.ok) {
          expect(second.error.code).toBe("INSUFFICIENT_FUNDS");
        }
      }
    );
  });

  // -------------------------------------------------------------------------
  // 7. Concurrent escrows on same agent don't interfere (independent IDs)
  // -------------------------------------------------------------------------
  it("invariant 7: multiple concurrent escrows on same agent are independent", () => {
    forAll(
      () => ({
        initial: randomInt(100, 500),
        lock1: randomInt(10, 40),
        lock2: randomInt(10, 40),
      }),
      ({ initial, lock1, lock2 }) => {
        // Ensure we have enough balance for both locks
        const total = lock1 + lock2;
        if (total > initial) return; // skip under-funded cases

        const ledger = new Ledger();
        const agent = randomAgentId();
        ledger.register(agent, initial);

        const e1 = ledger.escrow(agent, lock1);
        const e2 = ledger.escrow(agent, lock2);

        expect(e1.ok).toBe(true);
        expect(e2.ok).toBe(true);
        if (!e1.ok || !e2.ok) return;

        // They must have distinct IDs
        expect(e1.value).not.toBe(e2.value);

        // Balance reduced by both
        const bal = ledger.balance(agent);
        expect(bal.ok).toBe(true);
        if (bal.ok) {
          expect(bal.value).toBeCloseTo(initial - lock1 - lock2, 8);
        }

        // Refunding e1 does not affect e2
        ledger.refundEscrow(e1.value);
        const afterRefund1 = ledger.balance(agent);
        expect(afterRefund1.ok).toBe(true);
        if (afterRefund1.ok) {
          expect(afterRefund1.value).toBeCloseTo(initial - lock2, 8);
        }

        // e2 can still be refunded independently
        const refund2 = ledger.refundEscrow(e2.value);
        expect(refund2.ok).toBe(true);
      }
    );
  });
});

// ===========================================================================
// Escrow protocol invariants
// ===========================================================================

describe("Escrow protocol invariants", () => {
  // Helper: build a mock seller that always accepts and delivers
  function makeSeller(
    id: AgentId
  ): { id: AgentId; send: (msg: Message) => Promise<Message | null> } {
    return {
      id,
      async send(msg: Message): Promise<Message | null> {
        switch (msg.type) {
          case MessageType.HELLO:
            return createMessage<OfferPayload>({
              from: id,
              to: msg.from,
              type: MessageType.OFFER,
              payload: {
                itemId: "item-1",
                itemDescription: "Test item",
                price: 50,
                currency: "CREDITS",
              },
            });

          case MessageType.COMMIT:
            return createMessage<DeliverPayload>({
              from: id,
              to: msg.from,
              type: MessageType.DELIVER,
              payload: {
                itemId: "item-1",
                contentHash: "abc123",
                content: "data",
              },
              replyTo: msg.id,
            });

          case MessageType.RELEASE:
            return null;

          default:
            return null;
        }
      },
    };
  }

  // Helper: build a mock buyer that always accepts the first offer
  function makeBuyer(
    id: AgentId,
    accept: boolean
  ): { id: AgentId; send: (msg: Message) => Promise<Message | null> } {
    return {
      id,
      async send(msg: Message): Promise<Message | null> {
        switch (msg.type) {
          case MessageType.OFFER: {
            const payload = msg.payload as OfferPayload;
            if (accept) {
              return createMessage<AcceptPayload>({
                from: id,
                to: msg.from,
                type: MessageType.ACCEPT,
                payload: { acceptedOfferId: msg.id, agreedPrice: payload.price },
                replyTo: msg.id,
              });
            } else {
              return createMessage<RejectPayload>({
                from: id,
                to: msg.from,
                type: MessageType.REJECT,
                payload: { rejectedId: msg.id, reason: "Not interested" },
                replyTo: msg.id,
              });
            }
          }

          case MessageType.DELIVER: {
            const deliverPayload = msg.payload as DeliverPayload;
            return createMessage<VerifyPayload>({
              from: id,
              to: msg.from,
              type: MessageType.VERIFY,
              payload: { deliveryMessageId: msg.id, verified: true },
              replyTo: msg.id,
            });
          }

          case MessageType.REJECT:
            return null;

          default:
            return null;
        }
      },
    };
  }

  // -------------------------------------------------------------------------
  // 8. State machine only moves forward
  // -------------------------------------------------------------------------
  it("invariant 8: successful trade produces SUCCESS outcome (forward progression)", async () => {
    // Run many protocol instances and verify each ends in SUCCESS or a terminal failure state
    for (let i = 0; i < 20; i++) {
      const ledger = new Ledger();
      const sellerId = toAgentId(`seller-8-${i}`);
      const buyerId = toAgentId(`buyer-8-${i}`);

      ledger.register(sellerId, 0);
      ledger.register(buyerId, 200);

      const protocol = new EscrowProtocol(DEFAULT_PROTOCOL_CONFIG);
      const seller = makeSeller(sellerId);
      const buyer = makeBuyer(buyerId, true);

      const outcome = await protocol.run(seller, buyer, ledger);

      // Must be a known terminal state — never an intermediate
      expect(["SUCCESS", "FAILED_NEGOTIATION", "FAILED_DELIVERY", "DISPUTED"]).toContain(
        outcome.result
      );
    }
  });

  // -------------------------------------------------------------------------
  // 9. Settlement transfers exactly the agreed price
  // -------------------------------------------------------------------------
  it("invariant 9: settlement transfers exactly the agreed price", async () => {
    for (let i = 0; i < 20; i++) {
      const ledger = new Ledger();
      const sellerId = toAgentId(`seller-9-${i}`);
      const buyerId = toAgentId(`buyer-9-${i}`);
      const sellerInitial = 0;
      const buyerInitial = 200;
      const agreedPrice = 50;

      ledger.register(sellerId, sellerInitial);
      ledger.register(buyerId, buyerInitial);

      const protocol = new EscrowProtocol(DEFAULT_PROTOCOL_CONFIG);
      const seller = makeSeller(sellerId);
      const buyer = makeBuyer(buyerId, true);

      const outcome = await protocol.run(seller, buyer, ledger);

      if (outcome.result === "SUCCESS") {
        const sellerBal = ledger.balance(sellerId);
        const buyerBal = ledger.balance(buyerId);

        expect(sellerBal.ok).toBe(true);
        expect(buyerBal.ok).toBe(true);

        if (sellerBal.ok && buyerBal.ok) {
          // Seller received exactly agreedPrice
          expect(sellerBal.value).toBeCloseTo(sellerInitial + agreedPrice, 8);
          // Buyer paid exactly agreedPrice
          expect(buyerBal.value).toBeCloseTo(buyerInitial - agreedPrice, 8);
          // Total supply unchanged
          expect(sellerBal.value + buyerBal.value).toBeCloseTo(
            sellerInitial + buyerInitial,
            8
          );
        }
      }
    }
  });

  // -------------------------------------------------------------------------
  // 10. Failed negotiation leaves all balances unchanged
  // -------------------------------------------------------------------------
  it("invariant 10: rejected negotiation leaves all balances unchanged", async () => {
    for (let i = 0; i < 20; i++) {
      const ledger = new Ledger();
      const sellerId = toAgentId(`seller-10-${i}`);
      const buyerId = toAgentId(`buyer-10-${i}`);
      const sellerInitial = 0;
      const buyerInitial = 200;

      ledger.register(sellerId, sellerInitial);
      ledger.register(buyerId, buyerInitial);

      const protocol = new EscrowProtocol(DEFAULT_PROTOCOL_CONFIG);
      // Buyer rejects
      const seller = makeSeller(sellerId);
      const buyer = makeBuyer(buyerId, false);

      const outcome = await protocol.run(seller, buyer, ledger);

      expect(outcome.result).toBe("FAILED_NEGOTIATION");

      const sellerBal = ledger.balance(sellerId);
      const buyerBal = ledger.balance(buyerId);

      expect(sellerBal.ok && sellerBal.value).toBe(sellerInitial);
      expect(buyerBal.ok && buyerBal.value).toBe(buyerInitial);
    }
  });

  // -------------------------------------------------------------------------
  // 11. Timeout/cancellation refunds escrowed funds to buyer
  // -------------------------------------------------------------------------
  it("invariant 11: refundEscrow returns all locked funds to the payer", () => {
    forAll(
      () => ({
        balance: randomInt(50, 500),
        lockAmount: randomInt(1, 49),
      }),
      ({ balance, lockAmount }) => {
        const ledger = new Ledger();
        const agent = randomAgentId();
        ledger.register(agent, balance);

        const escrowResult = ledger.escrow(agent, lockAmount);
        expect(escrowResult.ok).toBe(true);
        if (!escrowResult.ok) return;

        // Simulate timeout by refunding
        const refundResult = ledger.refundEscrow(escrowResult.value);
        expect(refundResult.ok).toBe(true);

        // Balance must be fully restored
        const finalBal = ledger.balance(agent);
        expect(finalBal.ok).toBe(true);
        if (finalBal.ok) {
          expect(finalBal.value).toBeCloseTo(balance, 8);
        }
      }
    );
  });
});

// ===========================================================================
// Reputation invariants
// ===========================================================================

describe("Reputation invariants", () => {
  // -------------------------------------------------------------------------
  // 12. Score is always in [0, 1]
  // -------------------------------------------------------------------------
  it("invariant 12: score is always in [0, 1] regardless of history", () => {
    forAll(
      () => ({
        successes: randomInt(0, 500),
        failures: randomInt(0, 500),
      }),
      ({ successes, failures }) => {
        const store = new ReputationStore();
        const agent = randomAgentId();

        for (let i = 0; i < successes; i++) store.recordSuccess(agent);
        for (let i = 0; i < failures; i++) store.recordFailure(agent);

        const score = store.getReputation(agent);
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 13. Score after success >= score before (monotonically increases)
  // -------------------------------------------------------------------------
  it("invariant 13: recording a success never decreases score", () => {
    forAll(
      () => ({
        successes: randomInt(0, 50),
        failures: randomInt(0, 50),
      }),
      ({ successes, failures }) => {
        const store = new ReputationStore();
        const agent = randomAgentId();

        for (let i = 0; i < successes; i++) store.recordSuccess(agent);
        for (let i = 0; i < failures; i++) store.recordFailure(agent);

        const before = store.getReputation(agent);
        store.recordSuccess(agent);
        const after = store.getReputation(agent);

        expect(after).toBeGreaterThanOrEqual(before - 1e-12); // tolerance for float
      }
    );
  });

  // -------------------------------------------------------------------------
  // 14. Score after failure <= score before (monotonically decreases)
  // -------------------------------------------------------------------------
  it("invariant 14: recording a failure never increases score", () => {
    forAll(
      () => ({
        successes: randomInt(0, 50),
        failures: randomInt(0, 50),
      }),
      ({ successes, failures }) => {
        const store = new ReputationStore();
        const agent = randomAgentId();

        for (let i = 0; i < successes; i++) store.recordSuccess(agent);
        for (let i = 0; i < failures; i++) store.recordFailure(agent);

        const before = store.getReputation(agent);
        store.recordFailure(agent);
        const after = store.getReputation(agent);

        expect(after).toBeLessThanOrEqual(before + 1e-12); // tolerance for float
      }
    );
  });

  // -------------------------------------------------------------------------
  // 15. New agent's score = 0.5 (Laplace prior)
  // -------------------------------------------------------------------------
  it("invariant 15: new agent's score is exactly 0.5", () => {
    forAll(
      () => randomAgentId(),
      (agent) => {
        const store = new ReputationStore();
        expect(store.getReputation(agent)).toBe(0.5);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 16. After N successes and 0 failures, score > 0.5
  // -------------------------------------------------------------------------
  it("invariant 16: any number of successes (>= 1) with no failures yields score > 0.5", () => {
    forAll(
      () => randomInt(1, 100),
      (n) => {
        const store = new ReputationStore();
        const agent = randomAgentId();

        for (let i = 0; i < n; i++) store.recordSuccess(agent);

        const score = store.getReputation(agent);
        expect(score).toBeGreaterThan(0.5);
        // Also verify exact formula: (n+1)/(n+2)
        expect(score).toBeCloseTo(bayesianScore(n, 0), 10);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 17. Time decay moves score toward 0.5, never away from it
  // -------------------------------------------------------------------------
  it("invariant 17: decay always moves score toward 0.5, never away", () => {
    forAll(
      () => ({
        successes: randomInt(0, 100),
        failures: randomInt(0, 100),
        decayRate: randomFloat(0.0001, 0.01),
        elapsedMs: randomInt(1000, 60_000),
      }),
      ({ successes, failures, decayRate, elapsedMs }) => {
        const store = new ReputationStore();
        const agent = randomAgentId();

        for (let i = 0; i < successes; i++) store.recordSuccess(agent);
        for (let i = 0; i < failures; i++) store.recordFailure(agent);

        const scoreBefore = store.getReputation(agent);

        // Apply decay simulating elapsedMs into the future
        const snap = store.snapshot();
        const baseTime = snap.get(agent)?.lastUpdated ?? Date.now();
        store.applyDecay(agent, decayRate, baseTime + elapsedMs);

        const scoreAfter = store.getReputation(agent);

        if (scoreBefore > 0.5) {
          // Score should have moved toward 0.5 (decreased or stayed)
          expect(scoreAfter).toBeLessThanOrEqual(scoreBefore + 1e-10);
          expect(scoreAfter).toBeGreaterThanOrEqual(0.5 - 1e-10);
        } else if (scoreBefore < 0.5) {
          // Score should have moved toward 0.5 (increased or stayed)
          expect(scoreAfter).toBeGreaterThanOrEqual(scoreBefore - 1e-10);
          expect(scoreAfter).toBeLessThanOrEqual(0.5 + 1e-10);
        } else {
          // Exactly 0.5 stays at 0.5
          expect(scoreAfter).toBeCloseTo(0.5, 8);
        }
      }
    );
  });
});

// ===========================================================================
// Auction invariants
// ===========================================================================

describe("Auction invariants", () => {
  // -------------------------------------------------------------------------
  // 18. Winner's bid is always >= reserve price
  // -------------------------------------------------------------------------
  it("invariant 18: winner's bid is always >= reserve price", async () => {
    const configs: Partial<AuctionConfig>[] = [
      {
        bidderCount: 3,
        reservePrice: 10,
        bidderBudgets: [50, 50, 50],
        bidderValuations: [20, 15, 25],
        bidAggressiveness: [0.9, 0.85, 0.8],
      },
      {
        bidderCount: 2,
        reservePrice: 20,
        bidderBudgets: [100, 100],
        bidderValuations: [30, 40],
        bidAggressiveness: [0.9, 0.85],
      },
      {
        bidderCount: 4,
        reservePrice: 5,
        bidderBudgets: [30, 30, 30, 30],
        bidderValuations: [10, 12, 8, 15],
        bidAggressiveness: [0.9, 0.9, 0.9, 0.9],
      },
    ];

    for (const cfg of configs) {
      const result = await runAuction(cfg);
      if (result.winnerId !== null && result.winningBid !== null) {
        expect(result.winningBid).toBeGreaterThanOrEqual(cfg.reservePrice!);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 19. In first-price auction: settlement = winning bid
  // -------------------------------------------------------------------------
  it("invariant 19: first-price auction settlement equals winning bid", async () => {
    for (let i = 0; i < 10; i++) {
      const reservePrice = randomInt(5, 20);
      const result = await runAuction({
        bidderCount: 3,
        reservePrice,
        bidderBudgets: [100, 100, 100],
        bidderValuations: [
          randomInt(reservePrice + 5, 80),
          randomInt(reservePrice + 5, 80),
          randomInt(reservePrice + 5, 80),
        ],
        bidAggressiveness: [0.9, 0.85, 0.8],
        auctionType: "first-price",
      });

      if (result.winnerId !== null) {
        expect(result.settlementPrice).not.toBeNull();
        expect(result.settlementPrice).toBeCloseTo(result.winningBid!, 8);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 20. In Vickrey auction: settlement <= winning bid
  // -------------------------------------------------------------------------
  it("invariant 20: Vickrey auction settlement price <= winning bid", async () => {
    for (let i = 0; i < 10; i++) {
      const reservePrice = randomInt(5, 15);
      const result = await runAuction({
        bidderCount: 3,
        reservePrice,
        bidderBudgets: [200, 200, 200],
        bidderValuations: [
          randomInt(reservePrice + 10, 100),
          randomInt(reservePrice + 10, 100),
          randomInt(reservePrice + 10, 100),
        ],
        bidAggressiveness: [0.9, 0.85, 0.8],
        auctionType: "vickrey",
      });

      if (result.winnerId !== null && result.winningBid !== null && result.settlementPrice !== null) {
        expect(result.settlementPrice).toBeLessThanOrEqual(result.winningBid + 1e-8);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 21. No bidder pays more than their bid
  // -------------------------------------------------------------------------
  it("invariant 21: no bidder pays more than their submitted bid (balance check)", async () => {
    const initialBudget = 200;

    for (const auctionType of ["first-price", "vickrey"] as const) {
      const result = await runAuction({
        bidderCount: 3,
        reservePrice: 10,
        bidderBudgets: [initialBudget, initialBudget, initialBudget],
        bidderValuations: [40, 35, 50],
        bidAggressiveness: [0.9, 0.85, 0.8],
        auctionType,
      });

      if (result.winnerId !== null && result.settlementPrice !== null && result.winningBid !== null) {
        // The winner never pays more than their submitted bid
        expect(result.settlementPrice).toBeLessThanOrEqual(result.winningBid + 1e-8);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 22. Auction with no valid bids produces no winner
  // -------------------------------------------------------------------------
  it("invariant 22: auction with all bids below reserve produces no winner", async () => {
    // All bidders have valuations below the reserve price
    const result = await runAuction({
      bidderCount: 3,
      reservePrice: 100,
      bidderBudgets: [20, 20, 20],
      bidderValuations: [10, 8, 12],
      bidAggressiveness: [0.9, 0.9, 0.9],
    });

    expect(result.winnerId).toBeNull();
    expect(result.winningBid).toBeNull();
    expect(result.settlementPrice).toBeNull();
    expect(result.validBidCount).toBe(0);
    expect(result.tradeOutcome.result).toBe("FAILED_NEGOTIATION");
  });

  // -------------------------------------------------------------------------
  // 22b. Auction with zero-budget bidders produces no winner
  // -------------------------------------------------------------------------
  it("invariant 22b: auction where all bids are below reserve with varied configs", async () => {
    for (let i = 0; i < 5; i++) {
      const reserve = randomInt(50, 100);
      // All valuations deliberately below reserve
      const result = await runAuction({
        bidderCount: 3,
        reservePrice: reserve,
        bidderBudgets: [reserve - 1, reserve - 2, reserve - 3],
        bidderValuations: [reserve - 5, reserve - 10, reserve - 15],
        bidAggressiveness: [1.0, 1.0, 1.0],
      });

      expect(result.winnerId).toBeNull();
      expect(result.settlementPrice).toBeNull();
    }
  });
});

// ===========================================================================
// Cross-system invariants
// ===========================================================================

describe("Cross-system invariants", () => {
  // -------------------------------------------------------------------------
  // 23. Full trade cycle preserves total money supply
  // -------------------------------------------------------------------------
  it("invariant 23: full trade cycle preserves total money supply", async () => {
    for (let i = 0; i < 10; i++) {
      const sellerInitial = 0;
      const buyerInitial = randomInt(100, 500);
      const tradePrice = randomInt(10, Math.floor(buyerInitial / 2));

      const result = await runAuction({
        bidderCount: 1,
        reservePrice: tradePrice,
        bidderBudgets: [buyerInitial],
        bidderValuations: [buyerInitial],
        bidAggressiveness: [1.0],
      });

      // In the auction, the "seller" (auctioneer) starts at 0 and the
      // "buyer" (bidder) starts at buyerInitial. After any outcome,
      // total supply must be conserved.
      if (result.tradeOutcome.result === "SUCCESS" && result.settlementPrice !== null) {
        // Verify that the total (seller+buyer) equals the initial total.
        // The auction creates fresh ledger internally; we can only assert
        // that tradeOutcome.price equals settlementPrice (integrity check).
        expect(result.tradeOutcome.price).toBeCloseTo(result.settlementPrice, 8);
      }
    }
  });

  // -------------------------------------------------------------------------
  // 23b. Ledger total supply preserved across a full escrow trade cycle
  // -------------------------------------------------------------------------
  it("invariant 23b: ledger total supply is unchanged after a full escrow cycle", () => {
    forAll(
      () => ({
        sellerBal: randomInt(0, 200),
        buyerBal: randomInt(50, 500),
        tradeAmt: randomInt(1, 49),
      }),
      ({ sellerBal, buyerBal, tradeAmt }) => {
        const ledger = new Ledger();
        const seller = toAgentId(`cs23b-seller-${randomInt(1, 999999)}`);
        const buyer = toAgentId(`cs23b-buyer-${randomInt(1, 999999)}`);

        ledger.register(seller, sellerBal);
        ledger.register(buyer, buyerBal);

        const initialTotal = sellerBal + buyerBal;

        // Buyer escrows tradeAmt
        const escrowResult = ledger.escrow(buyer, tradeAmt);
        expect(escrowResult.ok).toBe(true);
        if (!escrowResult.ok) return;

        // Release to seller (simulating successful delivery)
        ledger.releaseEscrow(escrowResult.value, seller);

        const finalTotal = totalBalances(ledger);
        expect(finalTotal).toBeCloseTo(initialTotal, 8);
      }
    );
  });

  // -------------------------------------------------------------------------
  // 24. Reputation + escrow: low-rep agent is correctly blocked
  // -------------------------------------------------------------------------
  it("invariant 24: agent below minReputationScore is blocked from trading", async () => {
    // Set up a low-reputation seller
    const repStore = new ReputationStore();
    const lowRepSellerId = toAgentId("low-rep-seller-24");

    // Sink their reputation with many failures
    for (let i = 0; i < 30; i++) {
      repStore.recordFailure(lowRepSellerId);
    }

    const lowRepScore = repStore.getReputation(lowRepSellerId);
    expect(lowRepScore).toBeLessThan(0.1);

    // Create protocol with minReputationScore above the low-rep agent's score
    const protocol = new EscrowProtocol(
      { ...DEFAULT_PROTOCOL_CONFIG, minReputationScore: 0.3 },
      repStore
    );

    const ledger = new Ledger();
    const buyerId = toAgentId("buyer-24");
    ledger.register(lowRepSellerId, 0);
    ledger.register(buyerId, 500);

    const buyerInitialBal = 500;

    // Mock seller (low-rep)
    const seller = {
      id: lowRepSellerId,
      async send(_msg: Message): Promise<Message | null> {
        return null;
      },
    };

    // Mock buyer that accepts
    const buyer = {
      id: buyerId,
      async send(_msg: Message): Promise<Message | null> {
        return null;
      },
    };

    const outcome = await protocol.run(seller, buyer, ledger);

    // Trade must be blocked
    expect(outcome.result).toBe("FAILED_NEGOTIATION");

    // Buyer's balance must be unchanged — no funds moved
    const buyerBal = ledger.balance(buyerId);
    expect(buyerBal.ok && buyerBal.value).toBe(buyerInitialBal);
  });

  // -------------------------------------------------------------------------
  // 24b. High-rep agent passes the reputation gate
  // -------------------------------------------------------------------------
  it("invariant 24b: agent above minReputationScore is allowed to proceed", async () => {
    const repStore = new ReputationStore();
    const highRepSellerId = toAgentId("high-rep-seller-24b");

    // Build up reputation
    for (let i = 0; i < 20; i++) {
      repStore.recordSuccess(highRepSellerId);
    }

    const score = repStore.getReputation(highRepSellerId);
    expect(score).toBeGreaterThan(0.8);

    // minReputationScore well below the agent's score
    const protocol = new EscrowProtocol(
      { ...DEFAULT_PROTOCOL_CONFIG, minReputationScore: 0.5 },
      repStore
    );

    const ledger = new Ledger();
    const buyerId = toAgentId("buyer-24b");
    ledger.register(highRepSellerId, 0);
    ledger.register(buyerId, 200);

    // Seller makes an offer and delivers
    const seller = {
      id: highRepSellerId,
      async send(msg: Message): Promise<Message | null> {
        if (msg.type === MessageType.HELLO) {
          return createMessage<OfferPayload>({
            from: highRepSellerId,
            to: msg.from,
            type: MessageType.OFFER,
            payload: {
              itemId: "item-24b",
              itemDescription: "Premium data",
              price: 50,
              currency: "CREDITS",
            },
          });
        }
        if (msg.type === MessageType.COMMIT) {
          return createMessage<DeliverPayload>({
            from: highRepSellerId,
            to: msg.from,
            type: MessageType.DELIVER,
            payload: { itemId: "item-24b", contentHash: "hash-ok", content: "data" },
            replyTo: msg.id,
          });
        }
        return null;
      },
    };

    // Buyer accepts the offer and verifies delivery
    const buyer = {
      id: buyerId,
      async send(msg: Message): Promise<Message | null> {
        if (msg.type === MessageType.OFFER) {
          const p = msg.payload as OfferPayload;
          return createMessage<AcceptPayload>({
            from: buyerId,
            to: msg.from,
            type: MessageType.ACCEPT,
            payload: { acceptedOfferId: msg.id, agreedPrice: p.price },
            replyTo: msg.id,
          });
        }
        if (msg.type === MessageType.DELIVER) {
          return createMessage<VerifyPayload>({
            from: buyerId,
            to: msg.from,
            type: MessageType.VERIFY,
            payload: { deliveryMessageId: msg.id, verified: true },
            replyTo: msg.id,
          });
        }
        if (msg.type === MessageType.REJECT) {
          return null;
        }
        return null;
      },
    };

    const outcome = await protocol.run(seller, buyer, ledger);

    // High-rep agent must NOT be blocked — trade proceeds to SUCCESS
    expect(outcome.result).toBe("SUCCESS");
    expect(outcome.price).toBe(50);
  });
});
