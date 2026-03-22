/**
 * Multi-party negotiation scenario — coalition formation demo.
 *
 * Sets up N MockNegotiator agents with spread-out price preferences,
 * then runs MultiPartyNegotiation and prints the outcome table.
 *
 * Usage:
 *   npm run multi-party
 *   npx tsx src/scenarios/multi-party.ts
 *   npx tsx src/scenarios/multi-party.ts --agents 5
 */

import { Ledger } from "../core/ledger.js";
import { EventLog } from "../core/event-log.js";
import { MultiPartyNegotiation, type MultiPartyOutcome } from "../protocols/multi-party.js";
import { MockNegotiator } from "../agents/mock-negotiator.js";
import type { MultiPartyConfig } from "../protocols/multi-party.js";

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

export interface MultiPartyScenarioResult {
  outcome: MultiPartyOutcome;
  eventLog: EventLog;
}

/**
 * Run a multi-party negotiation with `numAgents` mock negotiators.
 * Each agent has a slightly different price preference so the scenario
 * exercises the counter-proposal averaging path.
 */
export async function runMultiPartyScenario(
  numAgents = 3,
  configOverrides?: Partial<MultiPartyConfig>,
): Promise<MultiPartyScenarioResult> {
  const ledger = new Ledger();
  const eventLog = new EventLog();

  const negotiation = new MultiPartyNegotiation(
    { minParticipants: 3, ...configOverrides },
    ledger,
    undefined,
    eventLog,
  );

  // Generate agents with price preferences spread around a midpoint of 100.
  // e.g. for 3 agents: 80, 100, 120  (step = 20)
  const midpoint = 100;
  const step = numAgents > 1 ? midpoint / numAgents : 0;

  for (let i = 0; i < numAgents; i++) {
    const price = midpoint - Math.floor(numAgents / 2) * step + i * step;
    const split = 0.3 + i * (0.4 / Math.max(numAgents - 1, 1));

    negotiation.addParticipant(
      new MockNegotiator({
        id: `agent-${i + 1}`,
        preferredTerms: { price, split: Math.round(split * 100) / 100 },
        flexibility: 0.4, // 40 % tolerance — agents are reasonably cooperative
      }),
    );
  }

  const outcome = await negotiation.run();

  return { outcome, eventLog };
}

// ---------------------------------------------------------------------------
// Formatted output
// ---------------------------------------------------------------------------

function printOutcome(outcome: MultiPartyOutcome): void {
  console.log("\n=== Multi-Party Negotiation Result ===\n");
  console.log(`Status      : ${outcome.success ? "SUCCESS ✓" : "FAILED ✗"}`);
  console.log(`Participants: ${outcome.participants.join(", ")}`);
  console.log(`Rounds      : ${outcome.totalRounds}`);
  console.log(`Duration    : ${outcome.durationMs} ms`);

  if (outcome.success && outcome.finalTerms) {
    console.log("\nFinal Terms:");
    for (const [key, value] of Object.entries(outcome.finalTerms)) {
      console.log(`  ${key.padEnd(12)} : ${value}`);
    }
    console.log(`\nAcceptors   : ${outcome.acceptors.join(", ")}`);
  }

  if (outcome.rounds.length > 0) {
    console.log("\nRound-by-Round Summary:");
    console.log(
      "  " +
        "Round".padEnd(8) +
        "Proposer".padEnd(16) +
        "Accepts".padEnd(10) +
        "Consensus",
    );
    console.log("  " + "─".repeat(50));

    for (const r of outcome.rounds) {
      const accepts = r.votes.filter((v) => v.vote === "accept").length;
      const total = r.votes.length;
      console.log(
        "  " +
          String(r.round).padEnd(8) +
          r.proposal.proposerId.padEnd(16) +
          `${accepts}/${total}`.padEnd(10) +
          (r.consensusReached ? "YES" : "no"),
      );
    }
  }

  console.log("");
}

// ---------------------------------------------------------------------------
// CLI entrypoint guard
// ---------------------------------------------------------------------------

function isEntrypoint(): boolean {
  const url = new URL(import.meta.url);
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  const filePath = url.pathname.replace(/^\/([A-Z]:)/, "$1").replace(/\//g, "\\");
  const argPath = entryPath.replace(/\//g, "\\");
  return filePath === argPath || url.pathname.endsWith(entryPath.replace(/\\/g, "/"));
}

if (isEntrypoint()) {
  const agentIdx = process.argv.indexOf("--agents");
  const rawAgents = agentIdx !== -1 ? process.argv[agentIdx + 1] : undefined;
  const numAgents = rawAgents !== undefined ? parseInt(rawAgents, 10) : 3;

  const validAgents = isNaN(numAgents) || numAgents < 3 ? 3 : numAgents;

  console.log(`\n=== Agora Multi-Party Negotiation (${validAgents} agents) ===`);

  runMultiPartyScenario(validAgents)
    .then(({ outcome, eventLog }) => {
      printOutcome(outcome);

      console.log("=== Event Log ===");
      console.log(eventLog.toTable());
      console.log("");
    })
    .catch((err: unknown) => {
      console.error("Error:", err);
      process.exit(1);
    });
}
