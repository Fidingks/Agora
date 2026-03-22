/**
 * src/evolution/compare.ts — Protocol Comparison Framework.
 *
 * Runs the same trade scenario through both bilateral (data-market) and
 * auction protocols under an identical ProtocolConfig, then returns
 * side-by-side metrics and a plain-text recommendation.
 *
 * This lets researchers answer: "For this config, which coordination
 * mechanism produces better outcomes?"
 *
 * Usage (CLI):
 *   npm run compare
 *
 * Usage (programmatic):
 *   import { runComparison } from "./compare.js";
 *   const result = await runComparison(DEFAULT_PROTOCOL_CONFIG, 20);
 */

import {
  computeMetrics,
  DEFAULT_PROTOCOL_CONFIG,
  type ProtocolConfig,
  type ProtocolMetrics,
} from "../protocols/types.js";
import {
  runDataMarket,
  DEFAULT_DATA_MARKET_CONFIG,
} from "../scenarios/data-market.js";
import { runAuctionEpoch } from "./auction-loop.js";
import type { TradeOutcome } from "../protocols/types.js";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ComparisonResult {
  /** Metrics from the bilateral (data-market escrow) protocol. */
  bilateral: ProtocolMetrics;
  /** Metrics from the sealed-bid auction protocol. */
  auction: ProtocolMetrics;
  /**
   * Signed deltas: positive means auction outperformed bilateral,
   * negative means bilateral outperformed auction.
   */
  delta: {
    /** auction.successRate - bilateral.successRate */
    successRate: number;
    /** auction.avgDurationMs - bilateral.avgDurationMs */
    avgDurationMs: number;
    /** auction.avgNegotiationRounds - bilateral.avgNegotiationRounds */
    avgNegotiationRounds: number;
  };
  /** Human-readable verdict summarising which protocol performed better. */
  recommendation: string;
}

// ---------------------------------------------------------------------------
// Bilateral epoch runner (mirrors the pattern in run.ts)
// ---------------------------------------------------------------------------

async function runBilateralEpoch(
  runs: number,
  protocolOverride: Partial<ProtocolConfig>
): Promise<{ outcomes: TradeOutcome[]; epochMs: number }> {
  const epochStart = Date.now();
  const outcomes: TradeOutcome[] = [];

  const config = { ...DEFAULT_DATA_MARKET_CONFIG, protocol: protocolOverride };

  for (let i = 0; i < runs; i++) {
    const result = await runDataMarket(config);
    outcomes.push(result.outcome);
  }

  return { outcomes, epochMs: Date.now() - epochStart };
}

// ---------------------------------------------------------------------------
// Recommendation builder
// ---------------------------------------------------------------------------

/**
 * Build a concise recommendation string based on the computed deltas.
 *
 * Decision priority:
 *   1. successRate delta dominates (threshold: 0.01 = 1 pp)
 *   2. If equal, use avgDurationMs (faster is better)
 *   3. If truly identical, report a tie
 */
function buildRecommendation(
  bilateral: ProtocolMetrics,
  auction: ProtocolMetrics,
  delta: ComparisonResult["delta"]
): string {
  const SUCCESS_THRESHOLD = 0.01;

  if (delta.successRate >= SUCCESS_THRESHOLD) {
    return (
      `Auction is recommended: higher success rate ` +
      `(+${(delta.successRate * 100).toFixed(1)} pp, ` +
      `${auction.successRate.toFixed(3)} vs ${bilateral.successRate.toFixed(3)})`
    );
  }

  if (delta.successRate <= -SUCCESS_THRESHOLD) {
    return (
      `Bilateral is recommended: higher success rate ` +
      `(+${(-delta.successRate * 100).toFixed(1)} pp, ` +
      `${bilateral.successRate.toFixed(3)} vs ${auction.successRate.toFixed(3)})`
    );
  }

  // Success rates are within threshold — use duration as tie-breaker
  if (delta.avgDurationMs < 0) {
    // Auction is faster (negative delta = auction - bilateral < 0)
    const pct = ((-delta.avgDurationMs / bilateral.avgDurationMs) * 100).toFixed(1);
    return (
      `Auction is recommended: comparable success rate, ` +
      `${pct}% faster (${auction.avgDurationMs.toFixed(1)} ms vs ${bilateral.avgDurationMs.toFixed(1)} ms)`
    );
  }

  if (delta.avgDurationMs > 0) {
    const pct = ((delta.avgDurationMs / auction.avgDurationMs) * 100).toFixed(1);
    return (
      `Bilateral is recommended: comparable success rate, ` +
      `${pct}% faster (${bilateral.avgDurationMs.toFixed(1)} ms vs ${auction.avgDurationMs.toFixed(1)} ms)`
    );
  }

  return (
    `Both protocols are equivalent: success rate=${bilateral.successRate.toFixed(3)}, ` +
    `avgDurationMs=${bilateral.avgDurationMs.toFixed(1)} ms`
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run both the bilateral and auction epoch runners under the same
 * `config` and return a `ComparisonResult` with metrics, deltas, and
 * a recommendation.
 *
 * @param config      - ProtocolConfig to apply to both protocols.
 *                      Defaults to `DEFAULT_PROTOCOL_CONFIG`.
 * @param epochSize   - Number of trades/auctions per protocol run.
 *                      Defaults to 20.
 */
export async function runComparison(
  config: ProtocolConfig = DEFAULT_PROTOCOL_CONFIG,
  epochSize = 20
): Promise<ComparisonResult> {
  // Run both epochs concurrently for speed.
  const [bilateralResult, auctionResult] = await Promise.all([
    runBilateralEpoch(epochSize, config),
    runAuctionEpoch(epochSize, config),
  ]);

  const bilateral = computeMetrics(bilateralResult.outcomes);
  const auction = computeMetrics(auctionResult.outcomes);

  const delta: ComparisonResult["delta"] = {
    successRate: auction.successRate - bilateral.successRate,
    avgDurationMs: auction.avgDurationMs - bilateral.avgDurationMs,
    avgNegotiationRounds: auction.avgNegotiationRounds - bilateral.avgNegotiationRounds,
  };

  const recommendation = buildRecommendation(bilateral, auction, delta);

  return { bilateral, auction, delta, recommendation };
}

// ---------------------------------------------------------------------------
// CLI entry — pretty-print a comparison table
// ---------------------------------------------------------------------------

function pad(s: string, width: number, right = false): string {
  return right ? s.padStart(width) : s.padEnd(width);
}

function formatNum(n: number, decimals = 4): string {
  return n.toFixed(decimals);
}

function printComparisonTable(result: ComparisonResult): void {
  const { bilateral, auction, delta } = result;

  const LABEL_W = 26;
  const COL_W = 12;

  const header =
    pad("Metric", LABEL_W) +
    pad("Bilateral", COL_W, true) +
    pad("Auction", COL_W, true) +
    pad("Delta", COL_W, true);

  const divider = "─".repeat(LABEL_W + COL_W * 3);

  console.log("\n" + "═".repeat(LABEL_W + COL_W * 3));
  console.log("  Agora Protocol Comparison");
  console.log("═".repeat(LABEL_W + COL_W * 3));
  console.log(header);
  console.log(divider);

  const rows: Array<[string, string, string, string]> = [
    [
      "successRate",
      formatNum(bilateral.successRate),
      formatNum(auction.successRate),
      (delta.successRate >= 0 ? "+" : "") + formatNum(delta.successRate),
    ],
    [
      "avgDurationMs",
      formatNum(bilateral.avgDurationMs, 2),
      formatNum(auction.avgDurationMs, 2),
      (delta.avgDurationMs >= 0 ? "+" : "") + formatNum(delta.avgDurationMs, 2),
    ],
    [
      "disputeRate",
      formatNum(bilateral.disputeRate),
      formatNum(auction.disputeRate),
      (auction.disputeRate - bilateral.disputeRate >= 0 ? "+" : "") +
        formatNum(auction.disputeRate - bilateral.disputeRate),
    ],
    [
      "avgNegotiationRounds",
      formatNum(bilateral.avgNegotiationRounds, 2),
      formatNum(auction.avgNegotiationRounds, 2),
      (delta.avgNegotiationRounds >= 0 ? "+" : "") +
        formatNum(delta.avgNegotiationRounds, 2),
    ],
    [
      "sampleSize",
      String(bilateral.sampleSize),
      String(auction.sampleSize),
      "",
    ],
  ];

  for (const [label, bil, auc, dlt] of rows) {
    console.log(
      pad(label, LABEL_W) +
        pad(bil, COL_W, true) +
        pad(auc, COL_W, true) +
        pad(dlt, COL_W, true)
    );
  }

  console.log(divider);
  console.log(`\nRecommendation: ${result.recommendation}\n`);
}

// ---------------------------------------------------------------------------
// isEntrypoint guard — only run CLI when invoked directly
// ---------------------------------------------------------------------------

function isEntrypoint(): boolean {
  try {
    const scriptPath = resolve(process.argv[1] ?? "");
    const thisPath = resolve(fileURLToPath(import.meta.url));
    return scriptPath === thisPath;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  console.log("Running comparison (20 epochs each, default protocol config)…");
  const result = await runComparison(DEFAULT_PROTOCOL_CONFIG, 20);
  printComparisonTable(result);
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    console.error("compare error:", err);
    process.exit(1);
  });
}
