/**
 * events-demo.ts — Demonstration of the Agora event logging system.
 *
 * Runs three mini-scenarios and prints the event log table at the end:
 *   1. A standard first-price auction (should settle)
 *   2. An auction with no valid bids (should emit auction.no_winner)
 *   3. ReputationStore updates (success + failure)
 *
 * Usage:
 *   npm run events-demo
 *   npx tsx src/scenarios/events-demo.ts
 */

import { EventLog } from "../core/event-log.js";
import { ReputationStore } from "../protocols/reputation.js";
import { runAuction } from "./auction.js";
import { toAgentId } from "../core/identity.js";

async function main(): Promise<void> {
  const log = new EventLog();

  // ── Print every event as it happens ──────────────────────────────────────

  const off = log.on((e) => {
    const ts = new Date(e.timestamp).toISOString().replace("T", " ").replace("Z", "");
    console.log(`  [${ts}] ${e.category.padEnd(12)} ${e.event}`);
  });

  // ── Scenario 1: standard first-price auction ──────────────────────────────

  console.log("\n=== Scenario 1: First-price auction (3 bidders) ===\n");
  const outcome1 = await runAuction({ eventLog: log });
  console.log(
    `\n  Result: ${outcome1.tradeOutcome.result}` +
      (outcome1.settlementPrice !== null ? `  Price: ${outcome1.settlementPrice}` : "")
  );

  // ── Scenario 2: auction with no bids above reserve ────────────────────────

  console.log("\n=== Scenario 2: Auction with no valid bids ===\n");
  const outcome2 = await runAuction({
    bidderCount: 2,
    reservePrice: 100,
    bidderBudgets: [5, 5],
    bidderValuations: [4, 4],
    bidAggressiveness: [1.0, 1.0],
    eventLog: log,
  });
  console.log(`\n  Result: ${outcome2.tradeOutcome.result}`);

  // ── Scenario 3: reputation events ────────────────────────────────────────

  console.log("\n=== Scenario 3: Reputation updates ===\n");
  const repStore = new ReputationStore(log);
  const alice = toAgentId("alice");
  const bob = toAgentId("bob");

  repStore.recordSuccess(alice);
  repStore.recordSuccess(alice);
  repStore.recordFailure(bob);

  console.log(
    `\n  Alice score: ${repStore.getReputation(alice).toFixed(3)}` +
      `  Bob score: ${repStore.getReputation(bob).toFixed(3)}`
  );

  // Stop live printing before final table
  off();

  // ── Print the full event log table ───────────────────────────────────────

  console.log("\n\n════════════════════════════════════════════════════════════════");
  console.log("  FULL EVENT LOG");
  console.log("════════════════════════════════════════════════════════════════\n");
  console.log(log.toTable());

  // ── Print summary ─────────────────────────────────────────────────────────

  const s = log.summary();
  console.log("\n── Summary ─────────────────────────────────────────────────────");
  console.log(`  Total events : ${s.totalEvents}`);
  console.log(`  Unique agents: ${s.uniqueAgents}`);
  console.log(`  Time span    : ${s.timeSpanMs} ms`);
  console.log("  By category  :");
  for (const [cat, count] of Object.entries(s.byCategory)) {
    console.log(`    ${cat.padEnd(14)} ${count}`);
  }
  console.log("────────────────────────────────────────────────────────────────\n");
}

main().catch((err: unknown) => {
  console.error("events-demo crashed:", err);
  process.exit(1);
});
