/**
 * src/evolution/run.ts — Autonomous protocol evolution loop.
 *
 * This is the Karpathy-style autoresearch main loop for Agora.  Each iteration:
 *   1. Proposes one config change (LLM if ANTHROPIC_API_KEY is set, mock otherwise).
 *   2. Runs an epoch with the proposed config.
 *   3. Compares successRate (primary) and avgDurationMs (secondary) to the current best.
 *   4. Commits the change to disk + git when it represents a genuine improvement.
 *   5. Appends one row to results.tsv regardless of outcome.
 *
 * The loop runs indefinitely until interrupted (CTRL+C).
 *
 * Usage:
 *   npx tsx src/evolution/run.ts                # run forever, 20 trades/epoch
 *   npx tsx src/evolution/run.ts --iters 5      # stop after 5 iterations
 *   npx tsx src/evolution/run.ts --runs 30      # 30 trades per epoch
 *   npx tsx src/evolution/run.ts --dry-run      # show proposal but don't commit
 */

import { execSync } from "node:child_process";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  computeMetrics,
  DEFAULT_PROTOCOL_CONFIG,
  type ProtocolConfig,
  type ProtocolMetrics,
  type TradeOutcome,
} from "../protocols/types.js";
import {
  runDataMarket,
  DEFAULT_DATA_MARKET_CONFIG,
} from "../scenarios/data-market.js";
import { applyProposal, type ProtocolProposal } from "./propose.js";
import { generateLLMProposal } from "./llm-proposer.js";
import {
  loadCurrentConfig,
  saveCurrentConfig,
  CURRENT_PROTOCOL_PATH,
} from "./config-store.js";

// ---------------------------------------------------------------------------
// Project root (needed for results.tsv path)
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const PROJECT_ROOT = resolve(__filename, "..", "..", "..", "..");
const RESULTS_PATH = resolve(PROJECT_ROOT, "results.tsv");

// ---------------------------------------------------------------------------
// Tunable constants
// ---------------------------------------------------------------------------

/** Minimum successRate improvement required to keep a proposed change. */
const MIN_IMPROVEMENT_DELTA = 0.01;

/**
 * Keep a change that is no worse on successRate if it is at least this much
 * faster (5 % speedup).
 */
const DURATION_IMPROVEMENT_RATIO = 0.95;

/** Number of recent proposals to feed back to the LLM proposer. */
const HISTORY_WINDOW = 10;

/** Default trades per epoch. */
const DEFAULT_EPOCH_RUNS = 20;

// ---------------------------------------------------------------------------
// Exported helpers — tested independently in tests/evolution.test.ts
// ---------------------------------------------------------------------------

/**
 * Return true when the proposed metrics represent a genuine improvement over
 * the current-best metrics:
 *   - Primary:   successRate improved by >= MIN_IMPROVEMENT_DELTA
 *   - Secondary: successRate unchanged AND avgDurationMs improved by >= 5 %
 */
export function isImprovement(
  current: ProtocolMetrics,
  proposed: ProtocolMetrics
): boolean {
  const successDelta = proposed.successRate - current.successRate;
  if (successDelta >= MIN_IMPROVEMENT_DELTA) return true;

  const successSame = Math.abs(successDelta) < MIN_IMPROVEMENT_DELTA;
  const fasterEnough = proposed.avgDurationMs <= current.avgDurationMs * DURATION_IMPROVEMENT_RATIO;
  return successSame && fasterEnough;
}

/**
 * Merge a proposal's target parameter into a config snapshot.
 * Delegates to propose.ts `applyProposal` so the logic lives in one place;
 * re-exported here so tests can import from a single location.
 */
export { applyProposal };

// ---------------------------------------------------------------------------
// CLI argument parsing
// ---------------------------------------------------------------------------

interface RunArgs {
  /** Maximum number of improvement iterations (0 = run forever). */
  iters: number;
  /** Trades per epoch. */
  runs: number;
  /** If true, print the proposal but do not write files or commit. */
  dryRun: boolean;
}

function parseArgs(argv: string[]): RunArgs {
  let iters = 0;
  let runs = DEFAULT_EPOCH_RUNS;
  let dryRun = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? "";
    if (arg === "--iters" && i + 1 < argv.length) {
      const v = parseInt(argv[i + 1] ?? "", 10);
      if (!isNaN(v) && v > 0) iters = v;
      i++;
    } else if (arg === "--runs" && i + 1 < argv.length) {
      const v = parseInt(argv[i + 1] ?? "", 10);
      if (!isNaN(v) && v > 0) runs = v;
      i++;
    } else if (arg === "--dry-run") {
      dryRun = true;
    }
  }

  return { iters, runs, dryRun };
}

// ---------------------------------------------------------------------------
// Epoch runner — N independent data-market simulations
// ---------------------------------------------------------------------------

async function runEpoch(
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
// results.tsv helpers
// ---------------------------------------------------------------------------

const TSV_HEADER =
  "iter\tsuccessRate\tavgDurationMs\tdisputeRate\tchange\tstatus\trationale\n";

function ensureTsvExists(): void {
  if (!existsSync(RESULTS_PATH)) {
    writeFileSync(RESULTS_PATH, TSV_HEADER, "utf-8");
  }
}

function appendTsvRow(
  iter: number,
  metrics: ProtocolMetrics,
  change: string,
  status: "keep" | "discard",
  rationale: string
): void {
  const row = [
    iter,
    metrics.successRate.toFixed(3),
    metrics.avgDurationMs.toFixed(3),
    metrics.disputeRate.toFixed(3),
    change,
    status,
    // Rationale may contain tabs — replace them to keep TSV valid.
    rationale.replace(/\t/g, " "),
  ].join("\t");
  appendFileSync(RESULTS_PATH, row + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Stage current-protocol.json and commit with a structured message.
 * Returns the short commit hash on success, null on failure.
 * Errors are caught so a git failure never kills the loop.
 */
function gitCommit(
  description: string,
  rationale: string,
  before: ProtocolMetrics,
  after: ProtocolMetrics
): string | null {
  try {
    execSync(`git add "${CURRENT_PROTOCOL_PATH}"`, {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
    });

    const msg = [
      `evolution: adopt config change — ${description}`,
      "",
      rationale,
      "",
      `Before: successRate=${before.successRate.toFixed(3)}`,
      `After:  successRate=${after.successRate.toFixed(3)}`,
    ].join("\n");

    execSync(`git commit -m ${JSON.stringify(msg)}`, {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
    });

    const hash = execSync("git rev-parse --short HEAD", {
      cwd: PROJECT_ROOT,
      stdio: "pipe",
    })
      .toString()
      .trim();

    return hash;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[run] git commit failed (continuing): ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Pretty-print helpers
// ---------------------------------------------------------------------------

const WIDE = "════════════════════════════════════════════════";
const THIN = "────────────────────────────────────────────────";

function formatChange(proposal: ProtocolProposal): string {
  return `${proposal.parameterName}: ${proposal.currentValue} → ${proposal.proposedValue}`;
}

function printIterationSummary(
  iter: number,
  change: string,
  baseline: ProtocolMetrics,
  proposed: ProtocolMetrics,
  decision: "KEEP" | "DISCARD",
  decisionReason: string,
  commitHash: string | null
): void {
  console.log("\n" + WIDE);
  console.log(`  Iteration ${iter}  |  ${change}`);
  console.log(WIDE);
  console.log(
    `  Baseline:  successRate=${baseline.successRate.toFixed(3)}  avgMs=${baseline.avgDurationMs.toFixed(2)}  [current best]`
  );
  console.log(
    `  Proposed:  successRate=${proposed.successRate.toFixed(3)}  avgMs=${proposed.avgDurationMs.toFixed(2)}  [this run]`
  );

  if (decision === "KEEP") {
    const commitPart = commitHash ? `  Committed: ${commitHash}` : "  (dry-run — no commit)";
    console.log(`  Decision:  KEEP — ${decisionReason}`);
    console.log(commitPart);
  } else {
    console.log(`  Decision:  DISCARD — ${decisionReason}`);
  }
  console.log(THIN);
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { iters, runs, dryRun } = parseArgs(process.argv.slice(2));

  console.log("\nAgora Protocol Evolution Loop");
  console.log("CTRL+C to stop\n");
  if (dryRun) console.log("[dry-run mode — no files will be written or committed]\n");

  ensureTsvExists();

  // Load (or default) the current best config.
  let currentConfig: ProtocolConfig = loadCurrentConfig();

  // ── Iteration 0: baseline epoch with the current config ──────────────────

  console.log(`Running baseline epoch (${runs} trades)…`);
  const { outcomes: baseOutcomes } = await runEpoch(runs, currentConfig);
  let currentMetrics = computeMetrics(baseOutcomes);

  console.log(
    `Baseline: successRate=${currentMetrics.successRate.toFixed(3)}  ` +
      `avgMs=${currentMetrics.avgDurationMs.toFixed(2)}  ` +
      `disputeRate=${currentMetrics.disputeRate.toFixed(3)}`
  );

  if (!dryRun) {
    appendTsvRow(
      0,
      currentMetrics,
      "baseline",
      "keep",
      "Initial baseline"
    );
  }

  // Proposal history kept in memory for context-aware LLM proposals.
  const proposalHistory: ProtocolProposal[] = [];

  // ── Evolution loop ────────────────────────────────────────────────────────

  let iteration = 0;
  while (iters === 0 || iteration < iters) {
    iteration++;

    // 1. Generate a proposal.
    const proposal = await generateLLMProposal(
      currentConfig,
      currentMetrics,
      proposalHistory.slice(-HISTORY_WINDOW)
    );

    const change = formatChange(proposal);

    // 2. Build the proposed config by applying the proposal to current.
    const proposedConfig = applyProposal(currentConfig, proposal);

    // 3. Run an epoch with the proposed config.
    const { outcomes: trialOutcomes } = await runEpoch(runs, proposedConfig);
    const trialMetrics = computeMetrics(trialOutcomes);

    // 4. Decide keep / discard.
    const keep = isImprovement(currentMetrics, trialMetrics);

    // Build a human-readable reason for the decision.
    let decisionReason: string;
    if (keep) {
      const successDelta = trialMetrics.successRate - currentMetrics.successRate;
      if (successDelta >= MIN_IMPROVEMENT_DELTA) {
        decisionReason = `successRate improved by ${(successDelta * 100).toFixed(1)} pp`;
      } else {
        const speedup =
          ((currentMetrics.avgDurationMs - trialMetrics.avgDurationMs) /
            currentMetrics.avgDurationMs) *
          100;
        decisionReason = `${speedup.toFixed(1)}% faster at equal success rate`;
      }
    } else {
      const successDelta = trialMetrics.successRate - currentMetrics.successRate;
      if (successDelta < 0) {
        decisionReason = `successRate hurt (${(successDelta * 100).toFixed(1)} pp)`;
      } else {
        // Same or marginally better success but not fast enough.
        const speedup =
          ((currentMetrics.avgDurationMs - trialMetrics.avgDurationMs) /
            currentMetrics.avgDurationMs) *
          100;
        decisionReason = `speed gain ${speedup.toFixed(1)}% below 5% threshold`;
      }
    }

    // 5. Commit or discard.
    let commitHash: string | null = null;

    if (keep && !dryRun) {
      saveCurrentConfig(proposedConfig, `${change}: ${proposal.rationale}`);
      commitHash = gitCommit(change, proposal.rationale, currentMetrics, trialMetrics);
      currentConfig = proposedConfig;
      currentMetrics = trialMetrics;
    } else if (keep && dryRun) {
      // In dry-run mode we still update the in-memory config so subsequent
      // proposals have accurate context, but nothing is written to disk.
      currentConfig = proposedConfig;
      currentMetrics = trialMetrics;
    }

    // 6. Append to results.tsv (skip in dry-run to keep the log clean).
    if (!dryRun) {
      appendTsvRow(
        iteration,
        trialMetrics,
        change,
        keep ? "keep" : "discard",
        proposal.rationale
      );
    }

    // 7. Print iteration summary.
    printIterationSummary(
      iteration,
      change,
      // Show the pre-trial metrics as "baseline" even after a keep so the
      // user can see the delta clearly.
      keep ? trialMetrics : currentMetrics,
      trialMetrics,
      keep ? "KEEP" : "DISCARD",
      decisionReason,
      commitHash
    );

    // 8. Record proposal in history (after printing, so logs stay clean).
    proposalHistory.push(proposal);
    if (proposalHistory.length > HISTORY_WINDOW) {
      proposalHistory.shift();
    }
  }

  console.log(`\nEvolution loop finished after ${iteration} iteration(s).`);
}

// ---------------------------------------------------------------------------
// Only execute the loop when this file is the direct entrypoint.
// When imported by tests or other modules we export helpers but do NOT run.
// ---------------------------------------------------------------------------

// Resolve both sides to normalised file-system paths so the comparison works
// on all platforms (Windows back-slashes vs forward slashes, drive letters…).
function isEntrypoint(): boolean {
  try {
    // process.argv[1] is the script path Node was started with.
    // import.meta.url is the URL of this module file.
    const scriptPath = resolve(process.argv[1] ?? "");
    const thisPath = resolve(fileURLToPath(import.meta.url));
    return scriptPath === thisPath;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    console.error("Evolution loop crashed:", err);
    process.exit(1);
  });
}
