/**
 * In-memory ledger — immutable layer.
 *
 * Simulates a minimal economic substrate: balances + escrow.
 * No blockchain, no persistence. All state lives in Maps.
 *
 * Every mutating operation returns Result<T, LedgerError> so callers
 * are forced to handle failure at the type level.
 */

import type { AgentId } from "./identity.js";

// ---------------------------------------------------------------------------
// Result type (no external library needed)
// ---------------------------------------------------------------------------

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

export type LedgerErrorCode =
  | "INSUFFICIENT_FUNDS"
  | "UNKNOWN_AGENT"
  | "UNKNOWN_ESCROW"
  | "ESCROW_ALREADY_SETTLED"
  | "NEGATIVE_AMOUNT";

export interface LedgerError {
  readonly code: LedgerErrorCode;
  readonly message: string;
}

// ---------------------------------------------------------------------------
// Escrow
// ---------------------------------------------------------------------------

export type EscrowId = string & { readonly __brand: "EscrowId" };

let _escrowCounter = 0;

function newEscrowId(): EscrowId {
  return `escrow-${Date.now()}-${++_escrowCounter}` as EscrowId;
}

type EscrowStatus = "HELD" | "RELEASED" | "REFUNDED";

interface EscrowRecord {
  readonly id: EscrowId;
  readonly from: AgentId;
  readonly amount: number;
  status: EscrowStatus;
}

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export class Ledger {
  private readonly _balances = new Map<AgentId, number>();
  private readonly _escrows = new Map<EscrowId, EscrowRecord>();

  // ------------------------------------------------------------------
  // Account management
  // ------------------------------------------------------------------

  /** Register an agent with an initial balance (defaults to 0). */
  register(agentId: AgentId, initialBalance = 0): void {
    if (initialBalance < 0) {
      throw new Error("Initial balance cannot be negative");
    }
    // Allow re-registration only if the agent doesn't exist yet.
    if (!this._balances.has(agentId)) {
      this._balances.set(agentId, initialBalance);
    }
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  balance(agentId: AgentId): Result<number, LedgerError> {
    const bal = this._balances.get(agentId);
    if (bal === undefined) {
      return err({ code: "UNKNOWN_AGENT", message: `Unknown agent: ${agentId}` });
    }
    return ok(bal);
  }

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  credit(agentId: AgentId, amount: number): Result<number, LedgerError> {
    if (amount <= 0) {
      return err({ code: "NEGATIVE_AMOUNT", message: "Credit amount must be positive" });
    }
    const current = this._balances.get(agentId);
    if (current === undefined) {
      return err({ code: "UNKNOWN_AGENT", message: `Unknown agent: ${agentId}` });
    }
    const next = current + amount;
    this._balances.set(agentId, next);
    return ok(next);
  }

  debit(agentId: AgentId, amount: number): Result<number, LedgerError> {
    if (amount <= 0) {
      return err({ code: "NEGATIVE_AMOUNT", message: "Debit amount must be positive" });
    }
    const current = this._balances.get(agentId);
    if (current === undefined) {
      return err({ code: "UNKNOWN_AGENT", message: `Unknown agent: ${agentId}` });
    }
    if (current < amount) {
      return err({
        code: "INSUFFICIENT_FUNDS",
        message: `Agent ${agentId} has ${current} but needs ${amount}`,
      });
    }
    const next = current - amount;
    this._balances.set(agentId, next);
    return ok(next);
  }

  transfer(from: AgentId, to: AgentId, amount: number): Result<void, LedgerError> {
    const debitResult = this.debit(from, amount);
    if (!debitResult.ok) return debitResult;

    const creditResult = this.credit(to, amount);
    if (!creditResult.ok) {
      // Rollback the debit — credit back the sender.
      this._balances.set(from, (this._balances.get(from) ?? 0) + amount);
      return creditResult;
    }

    return ok(undefined);
  }

  // ------------------------------------------------------------------
  // Escrow
  // ------------------------------------------------------------------

  /**
   * Lock `amount` from `from` into escrow.
   * Returns the EscrowId so it can be referenced in COMMIT messages.
   */
  escrow(from: AgentId, amount: number): Result<EscrowId, LedgerError> {
    const debitResult = this.debit(from, amount);
    if (!debitResult.ok) return debitResult;

    const id = newEscrowId();
    this._escrows.set(id, { id, from, amount, status: "HELD" });
    return ok(id);
  }

  /**
   * Release escrowed funds to `to` (typically the seller after verification).
   */
  releaseEscrow(id: EscrowId, to: AgentId): Result<void, LedgerError> {
    const record = this._escrows.get(id);
    if (!record) {
      return err({ code: "UNKNOWN_ESCROW", message: `Escrow not found: ${id}` });
    }
    if (record.status !== "HELD") {
      return err({
        code: "ESCROW_ALREADY_SETTLED",
        message: `Escrow ${id} is already ${record.status}`,
      });
    }

    const creditResult = this.credit(to, record.amount);
    if (!creditResult.ok) return creditResult;

    record.status = "RELEASED";
    return ok(undefined);
  }

  /**
   * Refund escrowed funds back to the original sender (on failure / dispute).
   */
  refundEscrow(id: EscrowId): Result<void, LedgerError> {
    const record = this._escrows.get(id);
    if (!record) {
      return err({ code: "UNKNOWN_ESCROW", message: `Escrow not found: ${id}` });
    }
    if (record.status !== "HELD") {
      return err({
        code: "ESCROW_ALREADY_SETTLED",
        message: `Escrow ${id} is already ${record.status}`,
      });
    }

    const creditResult = this.credit(record.from, record.amount);
    if (!creditResult.ok) return creditResult;

    record.status = "REFUNDED";
    return ok(undefined);
  }

  // ------------------------------------------------------------------
  // Debug
  // ------------------------------------------------------------------

  snapshot(): Record<string, number> {
    return Object.fromEntries(this._balances);
  }

  escrowSnapshot(): Record<string, { from: string; amount: number; status: EscrowStatus }> {
    return Object.fromEntries(
      Array.from(this._escrows.entries()).map(([k, v]) => [
        k,
        { from: v.from, amount: v.amount, status: v.status },
      ])
    );
  }
}
