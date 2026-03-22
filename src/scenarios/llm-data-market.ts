/**
 * LLM Data Market scenario — identical flow to data-market.ts but with
 * LLM-driven agents.
 *
 * Falls back to mock agents automatically when ANTHROPIC_API_KEY is absent so
 * this file can be imported in any environment without hard failures.
 *
 * Usage:
 *   const result = await runLLMDataMarket();         // LLM or mock auto-selected
 *   const result = await runLLMDataMarket(myConfig); // custom config
 */

import { Ledger } from "../core/ledger.js";
import { LLMSellerAgent } from "../agents/llm-data-market.js";
import { LLMBuyerAgent } from "../agents/llm-data-market.js";
import { LLMAgent } from "../agents/llm-agent.js";
import { SellerAgent, BuyerAgent } from "../scenarios/data-market.js";
import {
  DEFAULT_DATA_MARKET_CONFIG,
  type DataMarketConfig,
  type DataMarketResult,
} from "../scenarios/data-market.js";
import { EscrowProtocol } from "../protocols/escrow.js";

// Re-export for convenience so callers can import config from one place.
export { DEFAULT_DATA_MARKET_CONFIG } from "../scenarios/data-market.js";

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

/**
 * Run the Data Market scenario with LLM-driven agents.
 *
 * If ANTHROPIC_API_KEY is set, uses LLMSellerAgent + LLMBuyerAgent (Claude
 * Haiku for both). Otherwise falls back to the deterministic mock agents so
 * the scenario always produces a result.
 */
export async function runLLMDataMarket(
  config: DataMarketConfig = DEFAULT_DATA_MARKET_CONFIG
): Promise<DataMarketResult> {
  const ledger = new Ledger();
  const llmAvailable = LLMAgent.isAvailable();

  let seller: SellerAgent;
  let buyer: BuyerAgent;

  if (llmAvailable) {
    console.log("[llm-data-market] ANTHROPIC_API_KEY detected — using LLM agents");
    seller = new LLMSellerAgent(config.seller, ledger, "claude-haiku-4-5");
    buyer = new LLMBuyerAgent(config.buyer, ledger, "claude-haiku-4-5");
  } else {
    console.log("[llm-data-market] No API key — falling back to mock agents");
    seller = new SellerAgent(config.seller, ledger);
    buyer = new BuyerAgent(config.buyer, ledger);
  }

  const protocol = new EscrowProtocol().withConfig(config.protocol ?? {});

  const outcome = await protocol.run(
    { id: seller.id, send: (msg) => seller.receive(msg) },
    { id: buyer.id, send: (msg) => buyer.receive(msg) },
    ledger
  );

  return {
    outcome,
    sellerLog: seller.log,
    buyerLog: buyer.log,
    finalBalances: {
      seller: seller.balance(),
      buyer: buyer.balance(),
    },
  };
}
