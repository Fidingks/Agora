/**
 * src/evolution/auction-loop.ts — Auction-specific epoch runner for protocol evolution.
 *
 * Runs N independent sealed-bid auctions and returns aggregated TradeOutcome[]
 * so the evolution loop can compute metrics and decide whether a config change
 * improved auction performance.
 *
 * Parallel to loop.ts (which runs bilateral data-market trades).
 * The evolution loop in run.ts picks which epoch runner to use based on
 * the --scenario CLI flag.
 */

import {
  runAuction,
  DEFAULT_AUCTION_CONFIG,
  type AuctionConfig,
} from "../scenarios/auction.js";
import type { ProtocolConfig, TradeOutcome } from "../protocols/types.js";

// ---------------------------------------------------------------------------
// Epoch runner — N independent auction simulations
// ---------------------------------------------------------------------------

/**
 * Runs `runs` auction epochs and returns aggregated metrics.
 * Each epoch runs one sealed-bid auction with the given protocol config.
 *
 * The `protocolOverride` is used to:
 *   - Set `reservePriceMultiplier` on the auction's effective reserve price
 *   - Set `minBidders` as the minimum bidder threshold
 *
 * Other ProtocolConfig fields (maxNegotiationRounds, escrowTimeoutMs, etc.)
 * are passed through to the auction's protocol config for future use.
 */
export async function runAuctionEpoch(
  runs: number,
  protocolOverride: Partial<ProtocolConfig>
): Promise<{ outcomes: TradeOutcome[]; epochMs: number }> {
  const epochStart = Date.now();
  const outcomes: TradeOutcome[] = [];

  for (let i = 0; i < runs; i++) {
    // Apply protocol overrides to the auction config.
    // reservePriceMultiplier adjusts the effective reserve price.
    // minBidders filters auctions with too few participants.
    const effectiveReserve =
      DEFAULT_AUCTION_CONFIG.reservePrice *
      (protocolOverride.reservePriceMultiplier ?? 1.0);

    const minBidders = protocolOverride.minBidders ?? 2;

    const auctionConfig: Partial<AuctionConfig> = {
      ...DEFAULT_AUCTION_CONFIG,
      reservePrice: effectiveReserve,
      protocol: protocolOverride,
    };

    // If the number of bidders is below the minimum threshold,
    // record a FAILED_NEGOTIATION without running the auction.
    if (DEFAULT_AUCTION_CONFIG.bidderCount < minBidders) {
      const durationMs = Date.now() - epochStart;
      outcomes.push({
        result: "FAILED_NEGOTIATION",
        price: undefined,
        durationMs,
        agentIds: [],
        negotiationRounds: 0,
      });
      continue;
    }

    const result = await runAuction(auctionConfig);
    outcomes.push(result.tradeOutcome);
  }

  return { outcomes, epochMs: Date.now() - epochStart };
}
