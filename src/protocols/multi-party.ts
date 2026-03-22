/**
 * Multi-party negotiation protocol — mutable layer.
 *
 * Enables 3+ agents to reach consensus on a set of terms before a deal
 * executes. This is the harder coordination problem: coalition formation.
 *
 * Algorithm (per round):
 *   1. Proposer rotates round-robin among all participants.
 *   2. Current proposer submits terms (optionally seeded by last counter average).
 *   3. All OTHER participants vote: accept | reject | counter.
 *   4. accept votes ≥ consensusThreshold × total  → SUCCESS.
 *   5. counter votes exist → average counter-terms become the seed for next round.
 *   6. All reject → move to next proposer.
 *   7. After maxRounds without consensus → FAILED.
 *
 * The proposer auto-votes "accept" for its own proposal, so only other
 * participants' votes are collected. The threshold check uses the total
 * participant count (including the proposer).
 */

import type { Ledger } from "../core/ledger.js";
import type { EventLog } from "../core/event-log.js";
import type { ReputationStore } from "./reputation.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface MultiPartyConfig {
  /** Minimum agents needed to start (default: 3). */
  minParticipants: number;
  /** Maximum agents allowed (default: 10). */
  maxParticipants: number;
  /**
   * Fraction of total participants that must accept for consensus.
   * e.g. 0.67 means 2/3 of all participants (including proposer).
   * Default: 0.67
   */
  consensusThreshold: number;
  /** Max negotiation rounds before timeout (default: 10). */
  maxRounds: number;
  /** Per-round timeout in ms — informational only for mock agents (default: 5000). */
  proposalTimeoutMs: number;
  /**
   * Minimum reputation score (0–1) required to participate.
   * 0 means the gate is disabled. Default: 0.
   */
  minReputationScore: number;
}

export const DEFAULT_MULTI_PARTY_CONFIG: MultiPartyConfig = {
  minParticipants: 3,
  maxParticipants: 10,
  consensusThreshold: 2 / 3,
  maxRounds: 10,
  proposalTimeoutMs: 5000,
  minReputationScore: 0,
};

// ---------------------------------------------------------------------------
// Participant interface — agents implement this
// ---------------------------------------------------------------------------

export interface NegotiationParticipant {
  /** Unique agent identifier. */
  id: string;

  /**
   * Called when it is this agent's turn to propose.
   * @param currentTerms  Averaged counter-terms from the previous round, or null if round 0.
   * @param round         Current round index (0-based).
   */
  propose(
    currentTerms: Record<string, number> | null,
    round: number,
  ): Promise<Record<string, number>>;

  /**
   * Called when another agent has made a proposal.
   * @param proposal  The proposal to evaluate.
   */
  vote(proposal: MultiPartyProposal): Promise<{
    vote: VoteResult;
    counterTerms?: Record<string, number>;
  }>;
}

// ---------------------------------------------------------------------------
// Data shapes
// ---------------------------------------------------------------------------

export interface MultiPartyProposal {
  proposerId: string;
  terms: Record<string, number>;
  round: number;
}

export type VoteResult = "accept" | "reject" | "counter";

export interface ParticipantVote {
  agentId: string;
  vote: VoteResult;
  counterTerms?: Record<string, number>;
}

export interface NegotiationRound {
  round: number;
  proposal: MultiPartyProposal;
  votes: ParticipantVote[];
  consensusReached: boolean;
}

export interface MultiPartyOutcome {
  success: boolean;
  finalTerms: Record<string, number> | null;
  rounds: NegotiationRound[];
  participants: string[];
  /** IDs of participants who voted accept in the winning round. */
  acceptors: string[];
  totalRounds: number;
  durationMs: number;
}

// ---------------------------------------------------------------------------
// Helper: average a list of term objects key-by-key
// ---------------------------------------------------------------------------

function averageTerms(termsList: Array<Record<string, number>>): Record<string, number> {
  if (termsList.length === 0) return {};

  // Collect all keys across all term maps.
  const allKeys = new Set<string>();
  for (const t of termsList) {
    for (const k of Object.keys(t)) {
      allKeys.add(k);
    }
  }

  const result: Record<string, number> = {};
  for (const key of allKeys) {
    let sum = 0;
    let count = 0;
    for (const t of termsList) {
      if (key in t) {
        sum += t[key]!;
        count++;
      }
    }
    result[key] = count > 0 ? sum / count : 0;
  }
  return result;
}

// ---------------------------------------------------------------------------
// MultiPartyNegotiation
// ---------------------------------------------------------------------------

export class MultiPartyNegotiation {
  private readonly _config: MultiPartyConfig;
  private readonly _ledger: Ledger;
  private readonly _reputation?: ReputationStore;
  private readonly _eventLog?: EventLog;
  private readonly _participants: NegotiationParticipant[] = [];

  constructor(
    config: Partial<MultiPartyConfig>,
    ledger: Ledger,
    reputation?: ReputationStore,
    eventLog?: EventLog,
  ) {
    this._config = { ...DEFAULT_MULTI_PARTY_CONFIG, ...config };
    this._ledger = ledger;
    this._reputation = reputation;
    this._eventLog = eventLog;
  }

  /** Register a participant. Must be called before run(). */
  addParticipant(agent: NegotiationParticipant): void {
    this._participants.push(agent);
  }

  /** Execute the full multi-party negotiation and return the outcome. */
  async run(): Promise<MultiPartyOutcome> {
    const startedAt = Date.now();
    const ids = this._participants.map((p) => p.id);

    this._eventLog?.emit("negotiation", "multi-party.start", ids, {
      participants: ids,
      config: this._config,
    });

    // ── Validation ──────────────────────────────────────────────────────────

    if (this._participants.length < this._config.minParticipants) {
      const durationMs = Date.now() - startedAt;
      this._eventLog?.emit("negotiation", "multi-party.failed", ids, {
        reason: "insufficient participants",
        count: this._participants.length,
        required: this._config.minParticipants,
      });
      return {
        success: false,
        finalTerms: null,
        rounds: [],
        participants: ids,
        acceptors: [],
        totalRounds: 0,
        durationMs,
      };
    }

    if (this._participants.length > this._config.maxParticipants) {
      const durationMs = Date.now() - startedAt;
      this._eventLog?.emit("negotiation", "multi-party.failed", ids, {
        reason: "too many participants",
        count: this._participants.length,
        max: this._config.maxParticipants,
      });
      return {
        success: false,
        finalTerms: null,
        rounds: [],
        participants: ids,
        acceptors: [],
        totalRounds: 0,
        durationMs,
      };
    }

    // ── Reputation gate ─────────────────────────────────────────────────────

    if (this._reputation && this._config.minReputationScore > 0) {
      for (const p of this._participants) {
        if (!this._reputation.meetsMinimum(p.id as Parameters<ReputationStore["meetsMinimum"]>[0], this._config.minReputationScore)) {
          const durationMs = Date.now() - startedAt;
          this._eventLog?.emit("negotiation", "multi-party.failed", ids, {
            reason: "reputation gate",
            agentId: p.id,
          });
          return {
            success: false,
            finalTerms: null,
            rounds: [],
            participants: ids,
            acceptors: [],
            totalRounds: 0,
            durationMs,
          };
        }
      }
    }

    // ── Negotiation loop ────────────────────────────────────────────────────

    const completedRounds: NegotiationRound[] = [];
    /** Running seed for counter-proposal averaging; null on round 0. */
    let currentSeed: Record<string, number> | null = null;
    const totalParticipants = this._participants.length;

    for (let roundIdx = 0; roundIdx < this._config.maxRounds; roundIdx++) {
      // Pick proposer by round-robin index.
      const proposerIdx = roundIdx % totalParticipants;
      const proposer = this._participants[proposerIdx]!;
      const voters = this._participants.filter((_, i) => i !== proposerIdx);

      // 1. Ask proposer to propose.
      const proposedTerms = await proposer.propose(currentSeed, roundIdx);

      const proposal: MultiPartyProposal = {
        proposerId: proposer.id,
        terms: proposedTerms,
        round: roundIdx,
      };

      this._eventLog?.emit("negotiation", "multi-party.proposal", ids, {
        round: roundIdx,
        proposerId: proposer.id,
        terms: proposedTerms,
      });

      // 2. Collect votes from ALL participants (including the proposer).
      // The proposer votes on their own proposal — a stubborn agent will
      // still reject even their own terms.  Non-stubborn agents typically
      // accept their own proposal since it matches their preference.
      const votes: ParticipantVote[] = [];

      for (const participant of this._participants) {
        const { vote, counterTerms } = await participant.vote(proposal);
        votes.push({ agentId: participant.id, vote, counterTerms });
      }

      // 3. Count accepts across all participants.
      const totalAccepts = votes.filter((v) => v.vote === "accept").length;

      const consensusReached =
        totalAccepts / totalParticipants >= this._config.consensusThreshold;

      const roundRecord: NegotiationRound = {
        round: roundIdx,
        proposal,
        votes,
        consensusReached,
      };
      completedRounds.push(roundRecord);

      this._eventLog?.emit("negotiation", "multi-party.round", ids, {
        round: roundIdx,
        accepts: totalAccepts,
        total: totalParticipants,
        consensusReached,
      });

      if (consensusReached) {
        // Build acceptors list — all participants who accepted.
        const acceptors = votes
          .filter((v) => v.vote === "accept")
          .map((v) => v.agentId);

        // Reputation: record success for all participants.
        if (this._reputation) {
          for (const p of this._participants) {
            this._reputation.recordSuccess(p.id as Parameters<ReputationStore["recordSuccess"]>[0]);
          }
        }

        const durationMs = Date.now() - startedAt;
        this._eventLog?.emit("negotiation", "multi-party.success", ids, {
          finalTerms: proposedTerms,
          totalRounds: completedRounds.length,
          durationMs,
        });

        return {
          success: true,
          finalTerms: proposedTerms,
          rounds: completedRounds,
          participants: ids,
          acceptors,
          totalRounds: completedRounds.length,
          durationMs,
        };
      }

      // 4. No consensus. Compute next seed from counter-proposals.
      const counterTermsList = votes
        .filter((v) => v.vote === "counter" && v.counterTerms !== undefined)
        .map((v) => v.counterTerms!);

      if (counterTermsList.length > 0) {
        // Blend counters with the current proposal for next seed.
        currentSeed = averageTerms([proposedTerms, ...counterTermsList]);
      } else {
        // All-reject path: keep current proposal as seed for the next proposer.
        currentSeed = proposedTerms;
      }
    }

    // ── Max rounds exceeded → FAILED ────────────────────────────────────────

    const durationMs = Date.now() - startedAt;
    this._eventLog?.emit("negotiation", "multi-party.timeout", ids, {
      maxRounds: this._config.maxRounds,
      durationMs,
    });

    return {
      success: false,
      finalTerms: null,
      rounds: completedRounds,
      participants: ids,
      acceptors: [],
      totalRounds: completedRounds.length,
      durationMs,
    };
  }
}
