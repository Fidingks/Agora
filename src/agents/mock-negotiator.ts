/**
 * MockNegotiator — deterministic NegotiationParticipant for testing.
 *
 * Each agent has:
 *   - preferredTerms : the outcome it most wants
 *   - flexibility    : fraction by which it will stretch away from its preference
 *                      when evaluating another agent's proposal (0 = inflexible,
 *                      1 = accepts anything).
 *   - stubborn       : if true the agent always rejects regardless of terms.
 *
 * Propose strategy:
 *   If a seed is provided, the agent proposes the midpoint between the seed and
 *   its own preferred terms.  On round 0 it simply proposes its own preference.
 *
 * Vote strategy:
 *   For each term key, check whether the proposed value is within
 *   flexibility × |preferredValue| of preferredValue.
 *   If ALL keys pass → "accept".
 *   If SOME keys are close (within 2× flexibility) → "counter" at midpoint.
 *   Otherwise → "reject".
 */

import type {
  NegotiationParticipant,
  MultiPartyProposal,
  VoteResult,
} from "../protocols/multi-party.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MockNegotiatorConfig {
  id: string;
  /** The ideal terms this agent wants to converge to. */
  preferredTerms: Record<string, number>;
  /**
   * Fractional tolerance around preferred values.
   * 0.2 means "I accept anything within ±20 % of my preferred value."
   * Default: 0.2
   */
  flexibility?: number;
  /**
   * If true, always votes "reject" regardless of terms.
   * Useful for testing how stubborn agents block consensus.
   * Default: false
   */
  stubborn?: boolean;
}

// ---------------------------------------------------------------------------
// MockNegotiator
// ---------------------------------------------------------------------------

export class MockNegotiator implements NegotiationParticipant {
  readonly id: string;
  private readonly _preferred: Record<string, number>;
  private readonly _flexibility: number;
  private readonly _stubborn: boolean;

  constructor(config: MockNegotiatorConfig) {
    this.id = config.id;
    this._preferred = config.preferredTerms;
    this._flexibility = config.flexibility ?? 0.2;
    this._stubborn = config.stubborn ?? false;
  }

  // ------------------------------------------------------------------
  // NegotiationParticipant: propose
  // ------------------------------------------------------------------

  async propose(
    currentTerms: Record<string, number> | null,
    _round: number,
  ): Promise<Record<string, number>> {
    if (!currentTerms) {
      // Round 0: propose preferred terms.
      return { ...this._preferred };
    }

    // Subsequent rounds: propose midpoint between seed and own preference.
    const merged: Record<string, number> = {};

    // All keys from both sides.
    const allKeys = new Set([
      ...Object.keys(currentTerms),
      ...Object.keys(this._preferred),
    ]);

    for (const key of allKeys) {
      const seedVal = currentTerms[key] ?? this._preferred[key] ?? 0;
      const prefVal = this._preferred[key] ?? seedVal;
      merged[key] = (seedVal + prefVal) / 2;
    }

    return merged;
  }

  // ------------------------------------------------------------------
  // NegotiationParticipant: vote
  // ------------------------------------------------------------------

  async vote(proposal: MultiPartyProposal): Promise<{
    vote: VoteResult;
    counterTerms?: Record<string, number>;
  }> {
    if (this._stubborn) {
      return { vote: "reject" };
    }

    const terms = proposal.terms;
    const allKeys = new Set([
      ...Object.keys(terms),
      ...Object.keys(this._preferred),
    ]);

    let allAcceptable = true;
    let somewhatClose = true;
    const counterTerms: Record<string, number> = {};

    for (const key of allKeys) {
      const proposed = terms[key] ?? 0;
      const preferred = this._preferred[key] ?? 0;

      // Avoid division by zero: use absolute tolerance of 1 when preferred === 0.
      const base = Math.abs(preferred) > 0 ? Math.abs(preferred) : 1;
      const deviation = Math.abs(proposed - preferred) / base;

      if (deviation > this._flexibility) {
        allAcceptable = false;
        // Counter at midpoint between proposal and preference.
        counterTerms[key] = (proposed + preferred) / 2;
      } else {
        // Within tolerance — accept this key.
        counterTerms[key] = proposed;
      }

      if (deviation > 2 * this._flexibility) {
        somewhatClose = false;
      }
    }

    if (allAcceptable) {
      return { vote: "accept" };
    }

    if (somewhatClose) {
      return { vote: "counter", counterTerms };
    }

    return { vote: "reject" };
  }
}
