/**
 * src/evolution/bounds.ts — Shared safe bounds for protocol config parameters.
 *
 * Both the mock proposer and the LLM proposer need to clamp proposed values
 * into a safe range. This module is the single source of truth for those ranges.
 */

import type { ProtocolConfig } from "../protocols/types.js";

/**
 * Safe bounds for each ProtocolConfig parameter.
 * Proposals outside these ranges are clamped before testing.
 * Mirrors the table in program.md.
 */
export const SAFE_BOUNDS: Record<keyof ProtocolConfig, { min: number; max: number }> = {
  maxNegotiationRounds: { min: 1, max: 20 },
  escrowTimeoutMs: { min: 1_000, max: 120_000 },
  minReputationScore: { min: 0, max: 1 },
  maxPriceDeviation: { min: 0.05, max: 0.95 },
  reservePriceMultiplier: { min: 0.5, max: 2.0 },
  minBidders: { min: 1, max: 5 },
};

/**
 * Clamp a proposed value to the safe bounds for the given parameter.
 */
export function clamp(value: number, param: keyof ProtocolConfig): number {
  const bounds = SAFE_BOUNDS[param];
  return Math.max(bounds.min, Math.min(bounds.max, value));
}
