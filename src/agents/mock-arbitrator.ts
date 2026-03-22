/**
 * Mock arbitrator for testing the committee arbitration protocol.
 *
 * Supports three bias modes:
 *   - "fair"       — evaluates evidence.quality; votes claimant if quality < 0.5,
 *                    respondent if quality >= 0.5. Falls back to "claimant" if no
 *                    quality field is present.
 *   - "claimant"   — always sides with the claimant regardless of evidence.
 *   - "respondent" — always sides with the respondent regardless of evidence.
 *
 * The weight field is set by the ArbitrationCommittee (based on reputation);
 * the MockArbitrator itself does not manage weights.
 */

import type { Arbitrator, ArbitrationVote, DisputeCase } from "../protocols/arbitration.js";

// ---------------------------------------------------------------------------
// Bias type
// ---------------------------------------------------------------------------

export type ArbitratorBias = "fair" | "claimant" | "respondent";

// ---------------------------------------------------------------------------
// MockArbitrator
// ---------------------------------------------------------------------------

export class MockArbitrator implements Arbitrator {
  readonly id: string;
  private readonly _bias: ArbitratorBias;

  constructor(id: string, bias: ArbitratorBias = "fair") {
    this.id = id;
    this._bias = bias;
  }

  async vote(
    dispute: DisputeCase,
  ): Promise<{ vote: ArbitrationVote; reasoning: string }> {
    switch (this._bias) {
      case "claimant":
        return {
          vote: "claimant",
          reasoning: `Arbitrator ${this.id} is biased toward claimant — always supports the filing party.`,
        };

      case "respondent":
        return {
          vote: "respondent",
          reasoning: `Arbitrator ${this.id} is biased toward respondent — always supports the defending party.`,
        };

      case "fair": {
        // Evaluate evidence quality.
        const quality = dispute.evidence["quality"];

        if (typeof quality !== "number") {
          // No numeric quality signal — default to supporting the claimant
          // (conservative: assume the dispute was filed with good reason).
          return {
            vote: "claimant",
            reasoning: `Arbitrator ${this.id} found no numeric quality evidence; defaulting to claimant.`,
          };
        }

        if (quality < 0.5) {
          return {
            vote: "claimant",
            reasoning:
              `Arbitrator ${this.id} evaluated evidence quality=${quality.toFixed(3)} ` +
              `(< 0.5) — delivery was substandard; ruling for claimant.`,
          };
        } else {
          return {
            vote: "respondent",
            reasoning:
              `Arbitrator ${this.id} evaluated evidence quality=${quality.toFixed(3)} ` +
              `(≥ 0.5) — delivery meets expectations; ruling for respondent.`,
          };
        }
      }
    }
  }
}
