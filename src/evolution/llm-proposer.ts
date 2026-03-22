/**
 * LLM-driven protocol proposal generator.
 *
 * Replaces the deterministic mock heuristic in propose.ts with strategic
 * reasoning by Claude Opus 4.6. Proposal quality directly affects whether the
 * evolution loop improves or degrades — this is worth the extra latency/cost.
 *
 * Adaptive thinking is enabled so Opus can reason through trade-offs before
 * committing to a parameter change.
 *
 * Structured output via Zod ensures the response is always a well-formed
 * ProtocolProposal without brittle string parsing.
 *
 * Falls back to generateMockProposal() if:
 *  - ANTHROPIC_API_KEY is absent
 *  - The API call throws
 *  - parsed_output is null (model couldn't satisfy the schema)
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import type { ProtocolConfig } from "../protocols/types.js";
import type { ProtocolMetrics } from "../protocols/types.js";
import type { ProtocolProposal } from "./propose.js";
import { generateMockProposal } from "./propose.js";
import { clamp } from "./bounds.js";

// ---------------------------------------------------------------------------
// Zod schema for the LLM's output
// ---------------------------------------------------------------------------

/**
 * All ProtocolConfig keys that the proposer is allowed to target.
 * Mirrors keyof ProtocolConfig explicitly so Zod can validate it.
 */
const ProtocolConfigKeySchema = z.enum([
  "maxNegotiationRounds",
  "escrowTimeoutMs",
  "minReputationScore",
  "maxPriceDeviation",
]);

const LLMProposalSchema = z.object({
  /**
   * Which config parameter to change. Must be a valid key of ProtocolConfig.
   */
  parameterName: ProtocolConfigKeySchema,

  /**
   * The new value to trial. Will be clamped to safe bounds before returning.
   */
  proposedValue: z.number(),

  /**
   * One-sentence explanation of why this change is expected to help.
   * Recorded in results.tsv for post-hoc analysis.
   */
  rationale: z.string().min(10).max(500),
});

type LLMProposalOutput = z.infer<typeof LLMProposalSchema>;

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

function buildSystemPrompt(
  currentConfig: ProtocolConfig,
  lastMetrics: ProtocolMetrics,
  proposalHistory: ProtocolProposal[]
): string {
  const recentHistory =
    proposalHistory.length === 0
      ? "  (no previous proposals)"
      : proposalHistory
          .slice(-5) // show only the last 5 to avoid prompt bloat
          .map(
            (p, i) =>
              `  ${i + 1}. Changed ${p.parameterName}: ${p.currentValue} → ${p.proposedValue}\n` +
              `     Rationale: ${p.rationale}`
          )
          .join("\n");

  return [
    "You are the Protocol Optimization Agent for Agora, an AI agent coordination sandbox.",
    "",
    "Your job: propose ONE targeted change to the protocol configuration that will improve",
    "the trade success rate or reduce average negotiation duration.",
    "",
    "## Current Protocol Configuration",
    JSON.stringify(currentConfig, null, 2),
    "",
    "## Last Epoch Metrics",
    `  successRate          : ${lastMetrics.successRate.toFixed(3)} (target: > 0.8)`,
    `  avgDurationMs        : ${lastMetrics.avgDurationMs.toFixed(1)} ms (lower is better)`,
    `  disputeRate          : ${lastMetrics.disputeRate.toFixed(3)} (lower is better)`,
    `  avgNegotiationRounds : ${lastMetrics.avgNegotiationRounds.toFixed(2)}`,
    `  sampleSize           : ${lastMetrics.sampleSize}`,
    "",
    "## Recent Proposals (most recent last)",
    recentHistory,
    "",
    "## Parameter Safe Bounds",
    "  maxNegotiationRounds : [1, 20]",
    "  escrowTimeoutMs      : [1000, 120000]",
    "  minReputationScore   : [0, 1]",
    "  maxPriceDeviation    : [0.05, 0.95]",
    "",
    "## Instructions",
    "1. Analyse the metrics and identify the weakest signal.",
    "2. Reason about which parameter change would most directly address it.",
    "3. Avoid repeating a change that was tried recently unless there is a clear reason.",
    "4. Output exactly ONE proposal with a concise rationale (max 500 chars).",
    "",
    "Respond ONLY with JSON matching the provided schema.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate a ProtocolProposal using Claude Opus with extended thinking.
 *
 * Falls back to generateMockProposal() on any failure so the evolution loop
 * always has a valid proposal to trial.
 */
export async function generateLLMProposal(
  currentConfig: ProtocolConfig,
  lastMetrics: ProtocolMetrics,
  proposalHistory: ProtocolProposal[]
): Promise<ProtocolProposal> {
  const apiKey = process.env["ANTHROPIC_API_KEY"];

  if (!apiKey) {
    console.warn("[llm-proposer] ANTHROPIC_API_KEY not set — using mock proposer");
    return generateMockProposal(currentConfig, lastMetrics);
  }

  const client = new Anthropic();

  const systemPrompt = buildSystemPrompt(currentConfig, lastMetrics, proposalHistory);

  const userMessage =
    "Based on the metrics above, propose ONE parameter change that will improve protocol " +
    "performance. Think carefully about WHY this specific change will help, then output " +
    "your proposal.";

  let llmOutput: LLMProposalOutput | null = null;

  try {
    const response = await client.messages.parse({
      model: "claude-opus-4-6",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
      output_config: {
        format: zodOutputFormat(LLMProposalSchema),
      },
    });

    llmOutput = response.parsed_output;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[llm-proposer] API call failed, falling back to mock: ${msg}`);
    return generateMockProposal(currentConfig, lastMetrics);
  }

  if (!llmOutput) {
    console.warn("[llm-proposer] parsed_output was null — falling back to mock");
    return generateMockProposal(currentConfig, lastMetrics);
  }

  // Clamp to safe bounds regardless of what Claude returned.
  const clampedValue = clamp(llmOutput.proposedValue, llmOutput.parameterName);

  const proposal: ProtocolProposal = {
    parameterName: llmOutput.parameterName,
    currentValue: currentConfig[llmOutput.parameterName],
    proposedValue: clampedValue,
    rationale: llmOutput.rationale,
  };

  console.log(
    `[llm-proposer] proposal: ${proposal.parameterName} ` +
      `${proposal.currentValue} → ${proposal.proposedValue}`
  );
  console.log(`[llm-proposer] rationale: ${proposal.rationale}`);

  return proposal;
}
