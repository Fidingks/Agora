/**
 * commitment-demo.ts — Demonstration of the ZK commitment protocol.
 *
 * Three agents each commit to a secret bid, then all reveal simultaneously.
 * Also demonstrates that changing a value after committing is detectable.
 *
 * Usage:
 *   npm run commitment-demo
 *   npx tsx src/scenarios/commitment-demo.ts
 */

import { EventLog } from "../core/event-log.js";
import { CommitmentStore, generateNonce, computeHash } from "../protocols/commitment.js";

// ---------------------------------------------------------------------------
// Demo runner
// ---------------------------------------------------------------------------

export async function runCommitmentDemo(): Promise<void> {
  const log = new EventLog();
  const store = new CommitmentStore(log);

  // Track events live
  log.on((e) => {
    const ts = new Date(e.timestamp).toISOString().replace("T", " ").replace("Z", "");
    console.log(`  [${ts}] ${e.category.padEnd(8)} ${e.event.padEnd(28)} ${e.agentIds.join(", ")}`);
  });

  console.log("════════════════════════════════════════════════════════════════");
  console.log("  Agora — ZK Commitment Protocol Demo");
  console.log("════════════════════════════════════════════════════════════════\n");

  // ── Phase 1: Commit ───────────────────────────────────────────────────────

  console.log("── Phase 1: Each agent commits to a secret bid ─────────────────\n");

  const agents = [
    { id: "agent-alpha", bid: "250" },
    { id: "agent-beta",  bid: "310" },
    { id: "agent-gamma", bid: "275" },
  ];

  // Each agent holds their own nonce — the store never keeps it.
  const agentNonces: Map<string, string> = new Map();
  const agentCommitIds: Map<string, string> = new Map();

  for (const agent of agents) {
    const { commitmentId, nonce, hash } = store.commit(agent.id, agent.bid);
    agentNonces.set(agent.id, nonce);
    agentCommitIds.set(agent.id, commitmentId);
    console.log(`  ${agent.id.padEnd(14)} commitmentId=${commitmentId}`);
    console.log(`  ${"".padEnd(14)} hash        =${hash}`);
    console.log(`  ${"".padEnd(14)} (secret bid =${agent.bid}, nonce kept private)\n`);
  }

  console.log(`  CommitmentStore now holds ${store.stats().total} commitments,`);
  console.log(`  all unrevealed: ${store.stats().unrevealed}\n`);

  // ── Phase 2: Simultaneous reveal ─────────────────────────────────────────

  console.log("── Phase 2: Simultaneous reveal (all agents open at once) ───────\n");

  const reveals = agents.map((agent) => ({
    commitmentId: agentCommitIds.get(agent.id)!,
    value: agent.bid,
    nonce: agentNonces.get(agent.id)!,
  }));

  const results = store.revealBatch(reveals);

  for (let i = 0; i < agents.length; i++) {
    const agent  = agents[i]!;
    const result = results[i]!;
    const status = result.valid ? "VALID  ✓" : "INVALID ✗";
    console.log(`  ${agent.id.padEnd(14)} bid=${agent.bid.padEnd(5)} reveal=${status}`);
  }

  console.log();

  // ── Phase 3: Verify stats ─────────────────────────────────────────────────

  const s = store.stats();
  console.log("── Phase 3: Commitment statistics ───────────────────────────────\n");
  console.log(`  total     : ${s.total}`);
  console.log(`  revealed  : ${s.revealed}`);
  console.log(`  unrevealed: ${s.unrevealed}`);
  console.log(`  valid     : ${s.valid}`);
  console.log(`  invalid   : ${s.invalid}`);
  console.log();

  // ── Phase 4: Tamper detection ─────────────────────────────────────────────

  console.log("── Phase 4: Tamper detection — cheating is detectable ───────────\n");

  const cheaterStore = new CommitmentStore();
  const cheaterNonce = generateNonce();
  const { commitmentId: cheatId, hash: committedHash } = cheaterStore.commit(
    "agent-cheater",
    "200",  // commits to 200…
    cheaterNonce,
  );

  console.log(`  agent-cheater committed to bid=200`);
  console.log(`  stored hash: ${committedHash}`);
  console.log();

  // Now tries to reveal with a different value
  const tamperedReveal = cheaterStore.reveal(cheatId, "999", cheaterNonce);
  console.log(`  Reveal attempt with tampered value=999:`);
  console.log(`  valid=${tamperedReveal.valid} (expected: false — tamper detected!)`);
  console.log();

  // Show that the correct value would have passed
  const cheaterStore2 = new CommitmentStore();
  const { commitmentId: cheatId2 } = cheaterStore2.commit("agent-cheater", "200", cheaterNonce);
  const honestReveal = cheaterStore2.reveal(cheatId2, "200", cheaterNonce);
  console.log(`  Reveal with honest value=200:`);
  console.log(`  valid=${honestReveal.valid} (expected: true)\n`);

  // ── Phase 5: Verify that hash is deterministic ────────────────────────────

  console.log("── Phase 5: Determinism — same value+nonce always produces same hash ─\n");

  const fixedNonce = "test-nonce-12345";
  const h1 = computeHash("hello", fixedNonce);
  const h2 = computeHash("hello", fixedNonce);
  const h3 = computeHash("world", fixedNonce);
  console.log(`  hash("hello", "${fixedNonce}") = ${h1}`);
  console.log(`  hash("hello", "${fixedNonce}") = ${h2}  ← same`);
  console.log(`  hash("world", "${fixedNonce}") = ${h3}  ← different value → different hash`);
  console.log(`  Deterministic: ${h1 === h2 ? "YES" : "NO"}`);
  console.log(`  Hiding      : ${h1 !== h3 ? "YES (different values differ)" : "NO"}`);
  console.log();

  // ── Event log summary ─────────────────────────────────────────────────────

  console.log("── Event log ────────────────────────────────────────────────────\n");
  console.log(log.toTable());
  const summary = log.summary();
  console.log(`\n  Total events : ${summary.totalEvents}`);
  console.log(`  Unique agents: ${summary.uniqueAgents}`);
  console.log("════════════════════════════════════════════════════════════════\n");
}

// ---------------------------------------------------------------------------
// Entrypoint guard — runs only when executed directly, not when imported
// ---------------------------------------------------------------------------

const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("commitment-demo.ts") ||
    process.argv[1].endsWith("commitment-demo.js"));

if (isEntrypoint) {
  runCommitmentDemo().catch((err: unknown) => {
    console.error("commitment-demo crashed:", err);
    process.exit(1);
  });
}
