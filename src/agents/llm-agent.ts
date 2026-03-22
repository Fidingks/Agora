/**
 * LLMAgent — abstract base class for agents backed by Claude.
 *
 * Design decisions:
 *  - Extends the core Agent so LLM agents plug into every existing protocol
 *    without changes to the protocol layer.
 *  - Maintains a conversation history so that multi-turn context is preserved
 *    across messages in a single trade session.
 *  - callLLM() is generic over a Zod schema: the schema is compiled into the
 *    API request via zodOutputFormat(), so Claude always returns valid JSON.
 *  - If ANTHROPIC_API_KEY is absent or the API call throws, callLLM returns
 *    null and the caller is responsible for falling back to mock logic.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { ZodSchema } from "zod";
import { Agent } from "../core/agent.js";
import type { AgentIdentity } from "../core/identity.js";
import type { Ledger } from "../core/ledger.js";

export abstract class LLMAgent extends Agent {
  protected readonly client: Anthropic;
  protected readonly model: string;

  /**
   * Accumulated conversation history for this agent's current session.
   * Passed as `messages` to every API call so Claude retains context.
   */
  protected readonly history: Anthropic.MessageParam[] = [];

  constructor(
    identity: AgentIdentity,
    ledger: Ledger,
    initialBalance: number,
    model = "claude-haiku-4-5"
  ) {
    super(identity, ledger, initialBalance);
    // Anthropic() picks up ANTHROPIC_API_KEY from process.env automatically.
    // If the key is absent the constructor still succeeds; the first API call
    // will throw and callLLM will catch it and return null.
    this.client = new Anthropic();
    this.model = model;
  }

  // ---------------------------------------------------------------------------
  // Static availability check
  // ---------------------------------------------------------------------------

  /**
   * Returns true iff ANTHROPIC_API_KEY is present in the environment.
   * Callers use this to decide whether to instantiate LLM agents at all.
   */
  static isAvailable(): boolean {
    return !!process.env["ANTHROPIC_API_KEY"];
  }

  // ---------------------------------------------------------------------------
  // Core LLM call helper
  // ---------------------------------------------------------------------------

  /**
   * Call Claude and parse the response with the provided Zod schema.
   *
   * Steps:
   *  1. Appends `userMessage` to `history` as a "user" turn.
   *  2. Calls `client.messages.parse()` with zodOutputFormat + output_config.
   *  3. Appends the assistant reply to `history` for the next turn.
   *  4. Returns the parsed, type-safe object from `parsed_output`.
   *
   * On any error (network, API key, parse failure) logs a warning and
   * returns null so the caller can fall back to mock logic.
   */
  protected async callLLM<T>(
    systemPrompt: string,
    userMessage: string,
    schema: ZodSchema<T>
  ): Promise<T | null> {
    if (!LLMAgent.isAvailable()) {
      return null;
    }

    this.history.push({ role: "user", content: userMessage });

    try {
      const response = await this.client.messages.parse({
        model: this.model,
        max_tokens: 16000,
        system: systemPrompt,
        messages: this.history,
        output_config: {
          format: zodOutputFormat(schema),
        },
      });

      // Append the assistant's reply to history so future calls have context.
      const textContent = response.content.find((b) => b.type === "text");
      if (textContent && textContent.type === "text") {
        this.history.push({
          role: "assistant",
          content: textContent.text,
        });
      }

      return response.parsed_output;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] LLM call failed, falling back to mock: ${msg}`);
      return null;
    }
  }
}
