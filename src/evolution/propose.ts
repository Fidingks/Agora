/**
 * src/evolution/propose.ts — Protocol change proposal interface and mock generator.
 *
 * A ProtocolProposal is the unit of change the evolution loop tests.
 * Each proposal targets exactly one ProtocolConfig parameter and includes
 * the rationale so that results.tsv entries are self-documenting.
 *
 * This module does NOT make LLM calls. It is the structural contract that
 * an LLM-based proposer must satisfy. The mock generator uses simple
 * heuristics so the loop can run end-to-end before LLM integration.
 *
 * To plug in a real LLM proposer:
 *   1. Implement `generateProposal(config, lastMetrics): Promise<ProtocolProposal>`
 *   2. Pass the current config and last metrics as context
 *   3. Parse the LLM's structured response into a ProtocolProposal
 *   4. Validate that parameterName is a known key and values are in safe range
 */

import type { ProtocolConfig } from "../protocols/types.js";
import type { ProtocolMetrics } from "../protocols/types.js";
import { clamp } from "./bounds.js";

// ---------------------------------------------------------------------------
// Proposal type
// ---------------------------------------------------------------------------

/**
 * A single, targeted proposal to change one ProtocolConfig parameter.
 *
 * The evolution agent:
 *  1. Generates a proposal (this struct)
 *  2. Applies proposedValue to DEFAULT_PROTOCOL_CONFIG in types.ts
 *  3. Runs an epoch to measure the effect
 *  4. Keeps or discards based on the metric delta
 */
export interface ProtocolProposal {
  /** The config key to change. Must be a key of ProtocolConfig. */
  readonly parameterName: keyof ProtocolConfig;

  /** Value currently in DEFAULT_PROTOCOL_CONFIG (before the change). */
  readonly currentValue: number;

  /** Value to write into DEFAULT_PROTOCOL_CONFIG for this trial. */
  readonly proposedValue: number;

  /**
   * One-sentence explanation of why this change might improve metrics.
   * Written to results.tsv as the "description" field.
   */
  readonly rationale: string;
}

// ---------------------------------------------------------------------------
// Mock proposal generator — heuristic-based, no LLM required.
//
// Priority order:
//   1. If successRate is critically low → increase maxNegotiationRounds
//   2. If successRate is low but not critical → increase maxPriceDeviation
//   3. If avgDurationMs is high → decrease maxNegotiationRounds
//   4. Otherwise → nudge maxPriceDeviation toward the center
// ---------------------------------------------------------------------------

/**
 * Generate a heuristic proposal based on the last epoch's metrics.
 *
 * This mock is deterministic: given the same config and metrics it always
 * returns the same proposal. That is intentional — the evolution loop is
 * responsible for trying the proposal and logging the outcome, not for
 * randomizing proposals on retry.
 */
export function generateMockProposal(
  config: ProtocolConfig,
  lastMetrics: ProtocolMetrics
): ProtocolProposal {
  const { successRate, avgDurationMs } = lastMetrics;

  // Case 1: critically low success — agents can't agree at all.
  // More rounds give them more chances to find a mutually acceptable price.
  if (successRate < 0.5) {
    const proposedValue = clamp(
      config.maxNegotiationRounds + 3,
      "maxNegotiationRounds"
    );
    return {
      parameterName: "maxNegotiationRounds",
      currentValue: config.maxNegotiationRounds,
      proposedValue,
      rationale:
        `successRate ${successRate.toFixed(2)} is critically low; adding 3 negotiation rounds ` +
        `to give agents more chances to converge on a price.`,
    };
  }

  // Case 2: low but recoverable success — the price gap may be too strict.
  // Widening maxPriceDeviation lets the seller accept counter-offers further
  // from the original ask, reducing failed negotiations.
  if (successRate < 0.8) {
    const step = 0.05;
    const proposedValue = clamp(config.maxPriceDeviation + step, "maxPriceDeviation");
    return {
      parameterName: "maxPriceDeviation",
      currentValue: config.maxPriceDeviation,
      proposedValue,
      rationale:
        `successRate ${successRate.toFixed(2)} is below 0.80; widening maxPriceDeviation ` +
        `by ${step} to allow the seller to accept counter-offers that diverge more from the ask.`,
    };
  }

  // Case 3: good success but slow — the protocol is burning rounds it doesn't need.
  // Reducing maxNegotiationRounds speeds up the happy path without losing trades
  // that would have settled anyway.
  const HIGH_DURATION_THRESHOLD_MS = 50;
  if (avgDurationMs > HIGH_DURATION_THRESHOLD_MS && config.maxNegotiationRounds > 2) {
    const proposedValue = clamp(
      config.maxNegotiationRounds - 1,
      "maxNegotiationRounds"
    );
    return {
      parameterName: "maxNegotiationRounds",
      currentValue: config.maxNegotiationRounds,
      proposedValue,
      rationale:
        `successRate is good (${successRate.toFixed(2)}) but avgDurationMs ${avgDurationMs.toFixed(1)} ` +
        `exceeds ${HIGH_DURATION_THRESHOLD_MS}ms; reducing maxNegotiationRounds by 1 to tighten the loop.`,
    };
  }

  // Case 4: everything looks fine — explore whether tighter price deviation
  // maintains success while simplifying the negotiation contract.
  // If this fails the agent discards it and has learned a bound.
  const tighterDeviation = clamp(
    parseFloat((config.maxPriceDeviation - 0.05).toFixed(2)),
    "maxPriceDeviation"
  );
  return {
    parameterName: "maxPriceDeviation",
    currentValue: config.maxPriceDeviation,
    proposedValue: tighterDeviation,
    rationale:
      `Metrics look healthy (successRate=${successRate.toFixed(2)}, avgDurationMs=${avgDurationMs.toFixed(1)}ms); ` +
      `probing whether a tighter maxPriceDeviation (${tighterDeviation}) maintains success — ` +
      `prefer simpler protocol contracts when they perform equally well.`,
  };
}

// ---------------------------------------------------------------------------
// Auction-specific mock proposal generator
//
// Priority order:
//   1. If successRate is critically low → lower reservePriceMultiplier
//   2. If successRate is low → reduce minBidders to allow smaller auctions
//   3. If successRate is good and duration is high → raise reservePriceMultiplier
//      to filter weak bidders and speed up resolution
//   4. Otherwise → explore raising minBidders for more competitive auctions
// ---------------------------------------------------------------------------

/**
 * Generate a heuristic proposal targeting auction-specific parameters.
 *
 * Same determinism contract as generateMockProposal — given the same config
 * and metrics, always returns the same proposal.
 */
export function generateAuctionMockProposal(
  config: ProtocolConfig,
  lastMetrics: ProtocolMetrics
): ProtocolProposal {
  const { successRate, avgDurationMs } = lastMetrics;

  // Case 1: critically low success — reserve price may be too high, scaring
  // away bidders. Lower the multiplier so more bids clear the reserve.
  if (successRate < 0.5) {
    const proposedValue = clamp(
      parseFloat((config.reservePriceMultiplier - 0.15).toFixed(2)),
      "reservePriceMultiplier"
    );
    return {
      parameterName: "reservePriceMultiplier",
      currentValue: config.reservePriceMultiplier,
      proposedValue,
      rationale:
        `successRate ${successRate.toFixed(2)} is critically low in auction mode; lowering ` +
        `reservePriceMultiplier by 0.15 to reduce effective reserve and attract more valid bids.`,
    };
  }

  // Case 2: low but recoverable success — might need fewer required bidders
  // so auctions with thin participation can still proceed.
  if (successRate < 0.8 && config.minBidders > 1) {
    const proposedValue = clamp(config.minBidders - 1, "minBidders");
    return {
      parameterName: "minBidders",
      currentValue: config.minBidders,
      proposedValue,
      rationale:
        `successRate ${successRate.toFixed(2)} is below 0.80; reducing minBidders from ` +
        `${config.minBidders} to ${proposedValue} so auctions with fewer participants can still proceed.`,
    };
  }

  // Case 3: good success but slow — raising the reserve filters out marginal
  // bidders, reducing the number of bids to process and speeding resolution.
  const HIGH_DURATION_THRESHOLD_MS = 50;
  if (avgDurationMs > HIGH_DURATION_THRESHOLD_MS) {
    const proposedValue = clamp(
      parseFloat((config.reservePriceMultiplier + 0.1).toFixed(2)),
      "reservePriceMultiplier"
    );
    return {
      parameterName: "reservePriceMultiplier",
      currentValue: config.reservePriceMultiplier,
      proposedValue,
      rationale:
        `successRate is good (${successRate.toFixed(2)}) but avgDurationMs ${avgDurationMs.toFixed(1)} ` +
        `exceeds ${HIGH_DURATION_THRESHOLD_MS}ms; raising reservePriceMultiplier to filter weak bidders.`,
    };
  }

  // Case 4: healthy metrics — explore whether requiring more bidders
  // increases competition and produces better prices.
  const proposedValue = clamp(config.minBidders + 1, "minBidders");
  return {
    parameterName: "minBidders",
    currentValue: config.minBidders,
    proposedValue,
    rationale:
      `Auction metrics look healthy (successRate=${successRate.toFixed(2)}, avgDurationMs=${avgDurationMs.toFixed(1)}ms); ` +
      `probing whether requiring ${proposedValue} bidders improves competition and final prices.`,
  };
}

// ---------------------------------------------------------------------------
// Utility: apply a proposal to a config snapshot (for logging / dry-run)
// ---------------------------------------------------------------------------

/**
 * Return a new ProtocolConfig with the proposed change applied.
 * Does not mutate the input. Used by tests and the evolution agent
 * to verify what a proposal would produce before writing to disk.
 */
export function applyProposal(
  config: ProtocolConfig,
  proposal: ProtocolProposal
): ProtocolConfig {
  return {
    ...config,
    [proposal.parameterName]: proposal.proposedValue,
  };
}
