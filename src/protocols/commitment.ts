/**
 * Cryptographic commitment scheme — ZK commitment protocol foundation.
 *
 * Enables agents to commit to a value (bid, delivery hash, quality score, etc.)
 * without revealing it, then later reveal and prove they committed to that
 * exact value. This is the foundation for trustless sealed-bid auctions,
 * fair exchange, and verifiable promises.
 *
 * Scheme:
 *   commit(value, nonce) → hash = SHA-256(value || nonce)
 *   reveal(value, nonce) → verify hash matches
 *
 * Security properties:
 *   - Hiding:   The hash reveals nothing about the value (given a random nonce).
 *   - Binding:  An agent cannot reveal a different value than what was committed.
 *   - Verifiable: Anyone can verify the reveal using only the public hash.
 */

import crypto from "node:crypto";
import type { EventLog } from "../core/event-log.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Commitment {
  /** Unique commitment ID */
  id: string;
  /** The agent that made this commitment */
  agentId: string;
  /** SHA-256(value || nonce) — the public, non-revealing part */
  hash: string;
  /** Unix timestamp (ms) when the commitment was created */
  createdAt: number;
  /** Has the commitment been opened (revealed)? */
  revealed: boolean;
  /** The original value — only set after a valid reveal */
  revealedValue?: string;
  /** The nonce used — only set after a valid reveal */
  revealedNonce?: string;
  /** Does hash(revealedValue, revealedNonce) match the stored hash? */
  valid?: boolean;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically secure random nonce.
 * @param bytes Number of random bytes (default 32 → 64-char hex string).
 */
export function generateNonce(bytes = 32): string {
  return crypto.randomBytes(bytes).toString("hex");
}

/**
 * Compute the commitment hash: SHA-256(value || nonce).
 *
 * We concatenate with a pipe character as a simple separator; the nonce's
 * random length makes boundary confusion practically impossible.
 */
export function computeHash(value: string, nonce: string): string {
  return crypto
    .createHash("sha256")
    .update(value + "|" + nonce)
    .digest("hex");
}

// ---------------------------------------------------------------------------
// CommitmentStore
// ---------------------------------------------------------------------------

let _commitCounter = 0;

function newCommitmentId(): string {
  return `commit-${Date.now()}-${++_commitCounter}`;
}

export class CommitmentStore {
  private readonly _commitments: Map<string, Commitment> = new Map();

  constructor(private readonly _eventLog?: EventLog) {}

  // ------------------------------------------------------------------
  // Phase 1: Commit
  // ------------------------------------------------------------------

  /**
   * Create a commitment: hash the value with a nonce and store it.
   *
   * If no nonce is provided, a cryptographically secure one is generated.
   * The nonce must be kept secret by the committer until reveal time — it
   * is NOT stored by the CommitmentStore.
   *
   * @returns The commitmentId, the nonce (caller must keep this secret), and
   *          the hash (safe to publish).
   */
  commit(
    agentId: string,
    value: string,
    nonce?: string,
  ): { commitmentId: string; nonce: string; hash: string } {
    const resolvedNonce = nonce ?? generateNonce();
    const hash = computeHash(value, resolvedNonce);
    const id = newCommitmentId();

    const commitment: Commitment = {
      id,
      agentId,
      hash,
      createdAt: Date.now(),
      revealed: false,
    };

    this._commitments.set(id, commitment);

    this._eventLog?.emit(
      "system",
      "commitment.created",
      [agentId],
      { commitmentId: id, hash, agentId },
    );

    return { commitmentId: id, nonce: resolvedNonce, hash };
  }

  // ------------------------------------------------------------------
  // Phase 2: Reveal
  // ------------------------------------------------------------------

  /**
   * Open a commitment by providing the original value and nonce.
   *
   * Recomputes SHA-256(value || nonce) and checks it matches the stored
   * hash. The commitment is marked as revealed regardless of whether the
   * hash matches, so observers can tell an attempt was made.
   *
   * @throws Error if the commitmentId is not found or already revealed.
   */
  reveal(
    commitmentId: string,
    value: string,
    nonce: string,
  ): { valid: boolean; commitment: Commitment } {
    const commitment = this._commitments.get(commitmentId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${commitmentId}`);
    }
    if (commitment.revealed) {
      throw new Error(`Commitment already revealed: ${commitmentId}`);
    }

    const recomputedHash = computeHash(value, nonce);
    const valid = recomputedHash === commitment.hash;

    commitment.revealed = true;
    commitment.revealedValue = value;
    commitment.revealedNonce = nonce;
    commitment.valid = valid;

    this._eventLog?.emit(
      "system",
      "commitment.revealed",
      [commitment.agentId],
      { commitmentId, valid, agentId: commitment.agentId },
    );

    return { valid, commitment };
  }

  // ------------------------------------------------------------------
  // Verify (post-reveal read)
  // ------------------------------------------------------------------

  /**
   * Verify a commitment that has already been revealed.
   * Re-checks hash(revealedValue, revealedNonce) against the stored hash.
   * Emits a "commitment.verified" event each call.
   *
   * @throws Error if commitment is not found or has not been revealed yet.
   */
  verify(commitmentId: string): { valid: boolean; commitment: Commitment } {
    const commitment = this._commitments.get(commitmentId);
    if (!commitment) {
      throw new Error(`Commitment not found: ${commitmentId}`);
    }
    if (!commitment.revealed) {
      throw new Error(`Commitment not yet revealed: ${commitmentId}`);
    }

    const recomputedHash = computeHash(
      commitment.revealedValue!,
      commitment.revealedNonce!,
    );
    const valid = recomputedHash === commitment.hash;

    // Keep the stored valid flag consistent.
    commitment.valid = valid;

    this._eventLog?.emit(
      "system",
      "commitment.verified",
      [commitment.agentId],
      { commitmentId, valid, agentId: commitment.agentId },
    );

    return { valid, commitment };
  }

  // ------------------------------------------------------------------
  // Query
  // ------------------------------------------------------------------

  getCommitment(id: string): Commitment | undefined {
    return this._commitments.get(id);
  }

  getByAgent(agentId: string): Commitment[] {
    return Array.from(this._commitments.values()).filter(
      (c) => c.agentId === agentId,
    );
  }

  getAllRevealed(): Commitment[] {
    return Array.from(this._commitments.values()).filter((c) => c.revealed);
  }

  getAllUnrevealed(): Commitment[] {
    return Array.from(this._commitments.values()).filter((c) => !c.revealed);
  }

  // ------------------------------------------------------------------
  // Batch operations
  // ------------------------------------------------------------------

  /**
   * Commit multiple (agentId, value) pairs in one call.
   * Each entry gets an independently generated nonce.
   */
  commitBatch(
    entries: { agentId: string; value: string }[],
  ): { commitmentId: string; nonce: string; hash: string }[] {
    return entries.map((e) => this.commit(e.agentId, e.value));
  }

  /**
   * Reveal multiple commitments at once.
   * Errors on individual reveals do not abort the rest; a failed reveal
   * returns { valid: false } and captures the error message in the
   * commitment's revealedValue field for diagnostics.
   */
  revealBatch(
    reveals: { commitmentId: string; value: string; nonce: string }[],
  ): { valid: boolean; commitment: Commitment }[] {
    return reveals.map((r) => {
      try {
        return this.reveal(r.commitmentId, r.value, r.nonce);
      } catch (err) {
        // Surface the error as an invalid reveal so callers can handle it.
        const placeholder: Commitment = {
          id: r.commitmentId,
          agentId: "unknown",
          hash: "",
          createdAt: 0,
          revealed: false,
          valid: false,
          revealedValue: err instanceof Error ? err.message : String(err),
        };
        return { valid: false, commitment: placeholder };
      }
    });
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  stats(): {
    total: number;
    revealed: number;
    unrevealed: number;
    valid: number;
    invalid: number;
  } {
    let revealed = 0;
    let valid = 0;
    let invalid = 0;

    for (const c of this._commitments.values()) {
      if (c.revealed) {
        revealed++;
        if (c.valid === true) valid++;
        else if (c.valid === false) invalid++;
      }
    }

    return {
      total: this._commitments.size,
      revealed,
      unrevealed: this._commitments.size - revealed,
      valid,
      invalid,
    };
  }
}
