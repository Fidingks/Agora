/**
 * Agora CLI entry point.
 *
 * Usage:
 *   npm start              # run default data-market scenario with mock agents
 *   npm start -- --llm     # run with LLM agents (requires ANTHROPIC_API_KEY)
 *   tsx src/cli.ts         # same, via tsx
 *   tsx src/cli.ts --llm   # same with LLM agents
 */

import { runDataMarket, DEFAULT_DATA_MARKET_CONFIG } from "./scenarios/data-market.js";
import { runLLMDataMarket } from "./scenarios/llm-data-market.js";
import { LLMAgent } from "./agents/llm-agent.js";
import type { TradeOutcome } from "./protocols/types.js";

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function header(title: string): void {
  const line = "─".repeat(60);
  console.log(`\n${line}`);
  console.log(`  ${title}`);
  console.log(line);
}

function printOutcome(outcome: TradeOutcome): void {
  header("Trade Outcome");
  console.log(`  Result            : ${outcome.result}`);
  console.log(
    `  Final price       : ${outcome.price !== undefined ? outcome.price + " CREDITS" : "—"}`
  );
  console.log(`  Negotiation rounds: ${outcome.negotiationRounds}`);
  console.log(`  Duration          : ${outcome.durationMs} ms`);
  console.log(`  Agents            : ${outcome.agentIds.join(", ")}`);
}

function printBalances(seller: number, buyer: number): void {
  header("Final Ledger Balances");
  console.log(`  DataSeller : ${seller} CREDITS`);
  console.log(`  DataBuyer  : ${buyer} CREDITS`);
}

function printLog(label: string, log: readonly string[]): void {
  console.log(`\n  [${label}]`);
  for (const line of log) {
    console.log(`    ${line}`);
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs(): { useLLM: boolean } {
  const args = process.argv.slice(2);
  return { useLLM: args.includes("--llm") };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const { useLLM } = parseArgs();

  // Determine effective mode: --llm flag only activates LLM mode if the API
  // key is actually present. Otherwise we warn and fall back to mock.
  const llmAvailable = LLMAgent.isAvailable();
  const runWithLLM = useLLM && llmAvailable;

  console.log("\n╔══════════════════════════════════════════════════════════╗");
  console.log("║                  AGORA  —  Data Market                  ║");
  console.log("╚══════════════════════════════════════════════════════════╝");

  if (useLLM && !llmAvailable) {
    console.warn(
      "\n  WARNING: --llm flag set but ANTHROPIC_API_KEY is not defined." +
        "\n  Running in mock (offline) mode instead.\n"
    );
  }

  const mode = runWithLLM ? "LLM agents (claude-haiku-4-5)" : "mock agents (offline)";
  console.log(`\nMode: ${mode}`);
  console.log("\nRunning scenario: two agents negotiate a data purchase...");
  console.log(`  Seller ask  : ${DEFAULT_DATA_MARKET_CONFIG.seller.askPrice} CREDITS`);
  console.log(`  Buyer budget: ${DEFAULT_DATA_MARKET_CONFIG.buyer.budget} CREDITS`);
  console.log(`  Buyer wallet: ${DEFAULT_DATA_MARKET_CONFIG.buyer.initialBalance} CREDITS`);

  const result = runWithLLM
    ? await runLLMDataMarket(DEFAULT_DATA_MARKET_CONFIG)
    : await runDataMarket(DEFAULT_DATA_MARKET_CONFIG);

  header("Message Log");
  printLog("DataSeller", result.sellerLog);
  printLog("DataBuyer", result.buyerLog);

  printOutcome(result.outcome);
  printBalances(result.finalBalances.seller, result.finalBalances.buyer);

  console.log("\n");

  // Exit with non-zero code if trade failed so CI can detect regressions.
  if (result.outcome.result !== "SUCCESS") {
    process.exitCode = 1;
  }
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exitCode = 1;
});
