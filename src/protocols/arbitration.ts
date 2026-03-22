/**
 * Committee Arbitration Protocol — mutable layer.
 *
 * When two agents disagree on a trade outcome (e.g., buyer claims delivery
 * was bad, seller claims it was fine), a committee of neutral arbitrators
 * votes to resolve the dispute. This provides decentralized dispute resolution
 * without requiring a trusted central authority.
 *
 * Algorithm:
 *   1. File dispute → create DisputeCase
 *   2. Each arbitrator votes independently
 *   3. Count votes, weighted by reputation if enabled (default weight 1.0)
 *   4. Check quorum: if voting weight < quorumFraction × total weight → no_quorum
 *   5. Determine verdict:
 *      - claimantWeight / votingWeight ≥ supermajority → claimant_wins (refund = 1.0)
 *      - respondentWeight / votingWeight ≥ supermajority → respondent_wins (refund = 0.0)
 *      - else → split (refund = claimantWeight / (claimantWeight + respondentWeight))
 *   6. Emit events throughout
 */

import type { ReputationStore } from "./reputation.js";
import type { EventLog } from "../core/event-log.js";

// ---------------------------------------------------------------------------
// Dispute types
// ---------------------------------------------------------------------------

export interface DisputeCase {
  id: string;
  tradeId: string;
  /** Who filed the dispute. */
  claimant: string;
  /** Who is being disputed. */
  respondent: string;
  /** Human-readable description of the dispute. */
  claim: string;
  /** Supporting data — arbitrators use this to evaluate the dispute. */
  evidence: Record<string, unknown>;
  filedAt: number;
}

export type ArbitrationVote = "claimant" | "respondent" | "split" | "abstain";

export interface ArbitratorVote {
  arbitratorId: string;
  vote: ArbitrationVote;
  reasoning: string;
  /** Reputation-based vote weight. Defaults to 1.0 when no reputation store. */
  weight: number;
}

export interface ArbitrationOutcome {
  disputeId: string;
  verdict: "claimant_wins" | "respondent_wins" | "split" | "no_quorum";
  votes: ArbitratorVote[];
  totalWeight: number;
  claimantWeight: number;
  respondentWeight: number;
  splitWeight: number;
  resolution: {
    /** 0.0 = respondent keeps all, 1.0 = full refund to claimant */
    refundFraction: number;
  };
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface ArbitrationConfig {
  /** Minimum committee size. Default: 3 */
  minArbitrators: number;
  /** Maximum committee size. Default: 7 */
  maxArbitrators: number;
  /**
   * Fraction of total weight that must actively vote (non-abstain) for the
   * result to be valid. Default: 0.67
   */
  quorumFraction: number;
  /**
   * Fraction of voting weight needed for a decisive win (claimant or respondent).
   * Below this threshold the verdict is "split". Default: 0.67
   */
  supermajority: number;
  /** Weight votes by the arbitrator's reputation score. Default: true */
  useReputationWeights: boolean;
}

export const DEFAULT_ARBITRATION_CONFIG: ArbitrationConfig = {
  minArbitrators: 3,
  maxArbitrators: 7,
  quorumFraction: 0.67,
  supermajority: 0.67,
  useReputationWeights: true,
};

// ---------------------------------------------------------------------------
// Arbitrator interface
// ---------------------------------------------------------------------------

export interface Arbitrator {
  id: string;
  vote(dispute: DisputeCase): Promise<{ vote: ArbitrationVote; reasoning: string }>;
}

// ---------------------------------------------------------------------------
// ArbitrationCommittee
// ---------------------------------------------------------------------------

export class ArbitrationCommittee {
  private readonly _config: ArbitrationConfig;
  private readonly _reputation?: ReputationStore;
  private readonly _eventLog?: EventLog;
  private readonly _arbitrators: Arbitrator[] = [];

  constructor(
    config: Partial<ArbitrationConfig> = {},
    reputation?: ReputationStore,
    eventLog?: EventLog,
  ) {
    this._config = { ...DEFAULT_ARBITRATION_CONFIG, ...config };
    this._reputation = reputation;
    this._eventLog = eventLog;
  }

  /** Add an arbitrator to the committee. Must be called before resolve(). */
  addArbitrator(arbitrator: Arbitrator): void {
    this._arbitrators.push(arbitrator);
  }

  /**
   * Resolve a dispute by collecting votes from all committee members and
   * determining a verdict. Returns an ArbitrationOutcome with the full
   * audit trail of votes and weights.
   */
  async resolve(dispute: DisputeCase): Promise<ArbitrationOutcome> {
    const startedAt = Date.now();
    const arbitratorIds = this._arbitrators.map((a) => a.id);

    // Emit dispute filed event.
    this._eventLog?.emit(
      "system",
      "dispute.filed",
      [dispute.claimant, dispute.respondent],
      {
        disputeId: dispute.id,
        tradeId: dispute.tradeId,
        claim: dispute.claim,
        arbitrators: arbitratorIds,
      },
    );

    // Validate minimum arbitrator count.
    if (this._arbitrators.length < this._config.minArbitrators) {
      throw new Error(
        `Committee requires at least ${this._config.minArbitrators} arbitrators, ` +
        `but only ${this._arbitrators.length} are registered.`,
      );
    }

    // Collect votes from all arbitrators in parallel.
    const rawVotes = await Promise.all(
      this._arbitrators.map(async (arbitrator) => {
        const { vote, reasoning } = await arbitrator.vote(dispute);

        // Determine weight: reputation-based or flat 1.0.
        let weight = 1.0;
        if (this._config.useReputationWeights && this._reputation) {
          weight = this._reputation.getReputation(
            arbitrator.id as Parameters<ReputationStore["getReputation"]>[0],
          );
        }

        const arbitratorVote: ArbitratorVote = {
          arbitratorId: arbitrator.id,
          vote,
          reasoning,
          weight,
        };

        // Emit per-vote event.
        this._eventLog?.emit(
          "system",
          "arbitration.vote",
          [arbitrator.id, dispute.claimant, dispute.respondent],
          {
            disputeId: dispute.id,
            vote,
            weight,
            reasoning,
          },
        );

        return arbitratorVote;
      }),
    );

    // Tally weights by vote type.
    let totalWeight = 0;
    let claimantWeight = 0;
    let respondentWeight = 0;
    let splitWeight = 0;
    let abstainWeight = 0;

    for (const v of rawVotes) {
      totalWeight += v.weight;
      switch (v.vote) {
        case "claimant":
          claimantWeight += v.weight;
          break;
        case "respondent":
          respondentWeight += v.weight;
          break;
        case "split":
          splitWeight += v.weight;
          break;
        case "abstain":
          abstainWeight += v.weight;
          break;
      }
    }

    // Voting weight is total minus abstentions.
    const votingWeight = totalWeight - abstainWeight;

    // Check quorum: enough non-abstaining votes?
    const quorumMet =
      totalWeight === 0
        ? false
        : votingWeight / totalWeight >= this._config.quorumFraction;

    let verdict: ArbitrationOutcome["verdict"];
    let refundFraction: number;

    if (!quorumMet) {
      verdict = "no_quorum";
      refundFraction = 0.5; // neutral split on no_quorum
    } else {
      // Determine decisive winner among claimant vs respondent.
      const claimantFraction =
        votingWeight > 0 ? claimantWeight / votingWeight : 0;
      const respondentFraction =
        votingWeight > 0 ? respondentWeight / votingWeight : 0;

      if (claimantFraction >= this._config.supermajority) {
        verdict = "claimant_wins";
        refundFraction = 1.0;
      } else if (respondentFraction >= this._config.supermajority) {
        verdict = "respondent_wins";
        refundFraction = 0.0;
      } else {
        // Neither side has supermajority → split.
        verdict = "split";
        // refundFraction proportional to claimant's share of the decisive votes.
        const decisiveWeight = claimantWeight + respondentWeight;
        refundFraction =
          decisiveWeight > 0 ? claimantWeight / decisiveWeight : 0.5;
      }
    }

    const durationMs = Date.now() - startedAt;

    // Emit resolution event.
    this._eventLog?.emit(
      "system",
      "arbitration.resolved",
      [dispute.claimant, dispute.respondent, ...arbitratorIds],
      {
        disputeId: dispute.id,
        verdict,
        refundFraction,
        totalWeight,
        claimantWeight,
        respondentWeight,
        splitWeight,
        quorumMet,
        durationMs,
      },
    );

    return {
      disputeId: dispute.id,
      verdict,
      votes: rawVotes,
      totalWeight,
      claimantWeight,
      respondentWeight,
      splitWeight,
      resolution: { refundFraction },
      durationMs,
    };
  }
}
