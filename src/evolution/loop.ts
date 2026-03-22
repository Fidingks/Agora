/**
 * src/evolution/loop.ts — Epoch runner for protocol evolution.
 *
 * Runs N independent data-market simulations and prints aggregate metrics.
 * This is the evaluation harness the evolution agent calls after each config
 * change — analogous to a training step that prints val_bpb.
 *
 * Usage:
 *   npx tsx src/evolution/loop.ts             # 20 runs (default)
 *   npx tsx src/evolution/loop.ts --runs 50   # 50 runs
 *
 * Output (stdout):
 *   ---
 *   successRate:      0.950000
 *   avgDurationMs:    12.500000
 *   disputeRate:      0.000000
 *   failRate:         0.050000
 *   totalRuns:        20
 *   epochMs:          250.000
 *
 *   agora-metrics: successRate=0.95 avgDurationMs=12.5 disputeRate=0.0
 *
 * The agent should grep for "agora-metrics:" to extract the key numbers.
 * Exit code is always 0 — the agent reads metrics from stdout, not exit code.
 */

import {
  runDataMarket,
  DEFAULT_DATA_MARKET_CONFIG,
} from "../scenarios/data-market.js";
import { computeMetrics, type TradeOutcome } from "../protocols/types.js";

// ---------------------------------------------------------------------------
// CLI argument parsing — accept --runs N
// ---------------------------------------------------------------------------

const DEFAULT_EPOCH_RUNS = 20;

function parseArgs(args: string[]): { runs: number } {
  let runs = DEFAULT_EPOCH_RUNS;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--runs" && i + 1 < args.length) {
      const rawValue = args[i + 1] ?? "";
      const parsed = parseInt(rawValue, 10);
      if (!isNaN(parsed) && parsed > 0) {
        runs = parsed;
      } else {
        console.error(`Warning: invalid --runs value "${rawValue}", using default ${DEFAULT_EPOCH_RUNS}`);
      }
      i++; // skip the value token
    }
  }
  return { runs };
}

// ---------------------------------------------------------------------------
// Run a single epoch: N independent trade simulations
// ---------------------------------------------------------------------------

async function runEpoch(runs: number): Promise<{ outcomes: TradeOutcome[]; epochMs: number }> {
  const epochStart = Date.now();
  const outcomes: TradeOutcome[] = [];

  for (let i = 0; i < runs; i++) {
    // Each run gets a fresh ledger and fresh agents (constructed inside runDataMarket).
    // We use DEFAULT_DATA_MARKET_CONFIG unmodified — the protocol reads
    // DEFAULT_PROTOCOL_CONFIG from types.ts, which is what the agent mutates.
    const result = await runDataMarket(DEFAULT_DATA_MARKET_CONFIG);
    outcomes.push(result.outcome);
  }

  const epochMs = Date.now() - epochStart;
  return { outcomes, epochMs };
}

// ---------------------------------------------------------------------------
// Format metrics for machine-readable and human-readable output
// ---------------------------------------------------------------------------

function printMetrics(
  outcomes: TradeOutcome[],
  epochMs: number
): void {
  const metrics = computeMetrics(outcomes);

  const n = outcomes.length;
  const failRate =
    n === 0
      ? 0
      : outcomes.filter(
          (o) => o.result === "FAILED_NEGOTIATION" || o.result === "FAILED_DELIVERY"
        ).length / n;

  // Human-readable block
  console.log("---");
  console.log(`successRate:      ${metrics.successRate.toFixed(6)}`);
  console.log(`avgDurationMs:    ${metrics.avgDurationMs.toFixed(6)}`);
  console.log(`disputeRate:      ${metrics.disputeRate.toFixed(6)}`);
  console.log(`failRate:         ${failRate.toFixed(6)}`);
  console.log(`totalRuns:        ${metrics.sampleSize}`);
  console.log(`epochMs:          ${epochMs.toFixed(3)}`);
  console.log("");

  // Machine-readable summary line — agent greps for this
  console.log(
    `agora-metrics: successRate=${metrics.successRate} avgDurationMs=${metrics.avgDurationMs} disputeRate=${metrics.disputeRate}`
  );
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { runs } = parseArgs(process.argv.slice(2));
  const { outcomes, epochMs } = await runEpoch(runs);
  printMetrics(outcomes, epochMs);
}

main().catch((err: unknown) => {
  console.error("epoch runner error:", err);
  // Exit 0 even on error — the agent checks for "agora-metrics:" presence;
  // its absence signals a crash, which the agent should log and investigate.
  process.exitCode = 0;
});
