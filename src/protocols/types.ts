/**
 * Protocol interface definitions — mutable layer.
 *
 * Agents can propose modifications to ProtocolConfig.
 * The evaluation loop measures TradeOutcome → ProtocolMetrics and
 * decides whether to adopt the change (keep) or discard it (revert).
 *
 * "Mutable" here means these are the things that evolve over time,
 * not that the TypeScript objects are mutated at runtime.
 */

import type { AgentId } from "../core/identity.js";
import type { Message } from "../core/message.js";
import type { Ledger } from "../core/ledger.js";

// ---------------------------------------------------------------------------
// Tunable parameters — the knobs agents can propose to turn.
// ---------------------------------------------------------------------------

export interface ProtocolConfig {
  /**
   * Maximum number of counter-offer rounds before the protocol times out.
   * Default: 5
   */
  readonly maxNegotiationRounds: number;

  /**
   * How many milliseconds an escrow is held before it can be auto-refunded.
   * Default: 30_000 (30 s in sandbox time)
   */
  readonly escrowTimeoutMs: number;

  /**
   * Minimum reputation score (0–1) required for a trade to proceed.
   * Default: 0  (no restriction in phase 1)
   */
  readonly minReputationScore: number;

  /**
   * Maximum relative price deviation an agent will accept in a counter-offer.
   * e.g. 0.2 means "I won't go more than 20 % away from my ask/bid".
   * Default: 0.3
   */
  readonly maxPriceDeviation: number;

  /**
   * Multiplier applied to the base reserve price in auction scenarios.
   * e.g. 1.2 means the effective reserve is 120 % of the base reserve.
   * Default: 1.0
   */
  readonly reservePriceMultiplier: number;

  /**
   * Minimum number of bidders required for an auction to proceed.
   * If fewer bidders are present, the auction is cancelled.
   * Default: 2
   */
  readonly minBidders: number;
}

export const DEFAULT_PROTOCOL_CONFIG: ProtocolConfig = {
  maxNegotiationRounds: 5,
  escrowTimeoutMs: 30_000,
  minReputationScore: 0,
  maxPriceDeviation: 0.3,
  reservePriceMultiplier: 1.0,
  minBidders: 2,
};

// ---------------------------------------------------------------------------
// Trade outcome — one data point emitted after each completed (or failed) run.
// ---------------------------------------------------------------------------

export type TradeResult = "SUCCESS" | "FAILED_NEGOTIATION" | "FAILED_DELIVERY" | "DISPUTED";

export interface TradeOutcome {
  readonly result: TradeResult;
  /** Final agreed price, undefined if negotiation never succeeded. */
  readonly price: number | undefined;
  /** Wall-clock milliseconds from first message to settlement (or failure). */
  readonly durationMs: number;
  readonly agentIds: readonly AgentId[];
  readonly negotiationRounds: number;
}

// ---------------------------------------------------------------------------
// Protocol metrics — aggregate over many TradeOutcomes.
// Analogous to val_bpb in language model evaluation: one number that tells
// you if a protocol mutation was an improvement.
// ---------------------------------------------------------------------------

export interface ProtocolMetrics {
  readonly successRate: number;      // [0, 1]
  readonly avgDurationMs: number;
  readonly disputeRate: number;      // [0, 1]
  readonly avgNegotiationRounds: number;
  readonly sampleSize: number;
}

export function computeMetrics(outcomes: TradeOutcome[]): ProtocolMetrics {
  if (outcomes.length === 0) {
    return {
      successRate: 0,
      avgDurationMs: 0,
      disputeRate: 0,
      avgNegotiationRounds: 0,
      sampleSize: 0,
    };
  }

  const n = outcomes.length;
  const successes = outcomes.filter((o) => o.result === "SUCCESS").length;
  const disputes = outcomes.filter((o) => o.result === "DISPUTED").length;
  const totalDuration = outcomes.reduce((s, o) => s + o.durationMs, 0);
  const totalRounds = outcomes.reduce((s, o) => s + o.negotiationRounds, 0);

  return {
    successRate: successes / n,
    avgDurationMs: totalDuration / n,
    disputeRate: disputes / n,
    avgNegotiationRounds: totalRounds / n,
    sampleSize: n,
  };
}

// ---------------------------------------------------------------------------
// CoordinationProtocol — the interface every concrete protocol implements.
// ---------------------------------------------------------------------------

export interface CoordinationProtocol {
  readonly name: string;
  readonly config: ProtocolConfig;

  /**
   * Execute a complete trade between `seller` and `buyer`.
   * The protocol orchestrates the message exchange and ledger operations.
   * Returns a TradeOutcome describing what happened.
   */
  run(
    seller: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    buyer: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    ledger: Ledger
  ): Promise<TradeOutcome>;

  /**
   * Return a new protocol instance with a modified config.
   * Used by the evolution loop to trial proposed changes.
   */
  withConfig(config: Partial<ProtocolConfig>): CoordinationProtocol;
}
