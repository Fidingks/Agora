/**
 * Ledger unit tests.
 *
 * Covers: credit / debit / balance, escrow create / release / refund,
 * and every expected error path.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { Ledger } from "../src/core/ledger.js";
import { toAgentId } from "../src/core/identity.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ALICE = toAgentId("alice");
const BOB = toAgentId("bob");

function freshLedger(aliceBalance = 100, bobBalance = 50): Ledger {
  const ledger = new Ledger();
  ledger.register(ALICE, aliceBalance);
  ledger.register(BOB, bobBalance);
  return ledger;
}

// ---------------------------------------------------------------------------
// balance
// ---------------------------------------------------------------------------

describe("Ledger.balance", () => {
  it("returns initial balance after registration", () => {
    const ledger = freshLedger(100, 50);
    const result = ledger.balance(ALICE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(100);
  });

  it("returns UNKNOWN_AGENT for unregistered agent", () => {
    const ledger = new Ledger();
    const result = ledger.balance(toAgentId("ghost"));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_AGENT");
  });
});

// ---------------------------------------------------------------------------
// credit
// ---------------------------------------------------------------------------

describe("Ledger.credit", () => {
  it("increases balance by the credited amount", () => {
    const ledger = freshLedger(100);
    ledger.credit(ALICE, 25);
    const result = ledger.balance(ALICE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(125);
  });

  it("returns the new balance on success", () => {
    const ledger = freshLedger(100);
    const result = ledger.credit(ALICE, 10);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(110);
  });

  it("rejects zero amount", () => {
    const ledger = freshLedger();
    const result = ledger.credit(ALICE, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NEGATIVE_AMOUNT");
  });

  it("rejects negative amount", () => {
    const ledger = freshLedger();
    const result = ledger.credit(ALICE, -5);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NEGATIVE_AMOUNT");
  });

  it("returns UNKNOWN_AGENT for unregistered agent", () => {
    const ledger = new Ledger();
    const result = ledger.credit(toAgentId("ghost"), 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_AGENT");
  });
});

// ---------------------------------------------------------------------------
// debit
// ---------------------------------------------------------------------------

describe("Ledger.debit", () => {
  it("decreases balance by the debited amount", () => {
    const ledger = freshLedger(100);
    ledger.debit(ALICE, 30);
    const result = ledger.balance(ALICE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(70);
  });

  it("allows debiting the full balance", () => {
    const ledger = freshLedger(100);
    const result = ledger.debit(ALICE, 100);
    expect(result.ok).toBe(true);
  });

  it("returns INSUFFICIENT_FUNDS when balance is too low", () => {
    const ledger = freshLedger(10);
    const result = ledger.debit(ALICE, 99);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSUFFICIENT_FUNDS");
  });

  it("does not mutate balance on INSUFFICIENT_FUNDS", () => {
    const ledger = freshLedger(10);
    ledger.debit(ALICE, 99); // should fail
    const result = ledger.balance(ALICE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value).toBe(10);
  });

  it("rejects zero amount", () => {
    const ledger = freshLedger();
    const result = ledger.debit(ALICE, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("NEGATIVE_AMOUNT");
  });
});

// ---------------------------------------------------------------------------
// transfer
// ---------------------------------------------------------------------------

describe("Ledger.transfer", () => {
  it("moves funds from sender to receiver", () => {
    const ledger = freshLedger(100, 50);
    const result = ledger.transfer(ALICE, BOB, 40);
    expect(result.ok).toBe(true);

    const aliceBal = ledger.balance(ALICE);
    const bobBal = ledger.balance(BOB);
    expect(aliceBal.ok && aliceBal.value).toBe(60);
    expect(bobBal.ok && bobBal.value).toBe(90);
  });

  it("fails and rolls back when sender has insufficient funds", () => {
    const ledger = freshLedger(5, 50);
    const result = ledger.transfer(ALICE, BOB, 10);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSUFFICIENT_FUNDS");

    // Alice balance unchanged
    const aliceBal = ledger.balance(ALICE);
    expect(aliceBal.ok && aliceBal.value).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// escrow — create
// ---------------------------------------------------------------------------

describe("Ledger.escrow (create)", () => {
  it("deducts from sender and returns an EscrowId", () => {
    const ledger = freshLedger(100);
    const result = ledger.escrow(ALICE, 30);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(typeof result.value).toBe("string");
      expect(result.value.startsWith("escrow-")).toBe(true);
    }
    const bal = ledger.balance(ALICE);
    expect(bal.ok && bal.value).toBe(70);
  });

  it("fails with INSUFFICIENT_FUNDS when balance is too low", () => {
    const ledger = freshLedger(5);
    const result = ledger.escrow(ALICE, 20);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("INSUFFICIENT_FUNDS");
  });
});

// ---------------------------------------------------------------------------
// escrow — release
// ---------------------------------------------------------------------------

describe("Ledger.releaseEscrow", () => {
  it("credits the recipient with the escrowed amount", () => {
    const ledger = freshLedger(100, 0);
    const escrowResult = ledger.escrow(ALICE, 40);
    expect(escrowResult.ok).toBe(true);
    if (!escrowResult.ok) return;

    const releaseResult = ledger.releaseEscrow(escrowResult.value, BOB);
    expect(releaseResult.ok).toBe(true);

    const bobBal = ledger.balance(BOB);
    expect(bobBal.ok && bobBal.value).toBe(40);
  });

  it("fails with UNKNOWN_ESCROW for a non-existent escrow id", () => {
    const ledger = freshLedger();
    const result = ledger.releaseEscrow("escrow-fake-999" as ReturnType<typeof ledger.escrow> extends { value: infer V } ? V : never, BOB);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_ESCROW");
  });

  it("fails with ESCROW_ALREADY_SETTLED if released twice", () => {
    const ledger = freshLedger(100, 0);
    const escrowResult = ledger.escrow(ALICE, 10);
    if (!escrowResult.ok) throw new Error("escrow failed");

    ledger.releaseEscrow(escrowResult.value, BOB);
    const second = ledger.releaseEscrow(escrowResult.value, BOB);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("ESCROW_ALREADY_SETTLED");
  });
});

// ---------------------------------------------------------------------------
// escrow — refund
// ---------------------------------------------------------------------------

describe("Ledger.refundEscrow", () => {
  it("returns the escrowed amount to the original sender", () => {
    const ledger = freshLedger(100);
    const escrowResult = ledger.escrow(ALICE, 40);
    if (!escrowResult.ok) throw new Error("escrow failed");

    expect(ledger.balance(ALICE)).toMatchObject({ ok: true, value: 60 });

    const refundResult = ledger.refundEscrow(escrowResult.value);
    expect(refundResult.ok).toBe(true);

    expect(ledger.balance(ALICE)).toMatchObject({ ok: true, value: 100 });
  });

  it("fails with UNKNOWN_ESCROW for a non-existent escrow id", () => {
    const ledger = freshLedger();
    const result = ledger.refundEscrow("escrow-fake-000" as ReturnType<typeof ledger.escrow> extends { value: infer V } ? V : never);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("UNKNOWN_ESCROW");
  });

  it("fails with ESCROW_ALREADY_SETTLED if refunded twice", () => {
    const ledger = freshLedger(100);
    const escrowResult = ledger.escrow(ALICE, 10);
    if (!escrowResult.ok) throw new Error("escrow failed");

    ledger.refundEscrow(escrowResult.value);
    const second = ledger.refundEscrow(escrowResult.value);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("ESCROW_ALREADY_SETTLED");
  });

  it("cannot refund after release", () => {
    const ledger = freshLedger(100, 0);
    const escrowResult = ledger.escrow(ALICE, 10);
    if (!escrowResult.ok) throw new Error("escrow failed");

    ledger.releaseEscrow(escrowResult.value, BOB);
    const refund = ledger.refundEscrow(escrowResult.value);
    expect(refund.ok).toBe(false);
    if (!refund.ok) expect(refund.error.code).toBe("ESCROW_ALREADY_SETTLED");
  });
});

// ---------------------------------------------------------------------------
// snapshot
// ---------------------------------------------------------------------------

describe("Ledger.snapshot", () => {
  it("returns a plain object with current balances", () => {
    const ledger = freshLedger(100, 50);
    const snap = ledger.snapshot();
    expect(snap[ALICE]).toBe(100);
    expect(snap[BOB]).toBe(50);
  });
});
