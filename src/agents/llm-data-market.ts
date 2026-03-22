/**
 * LLM-driven Seller and Buyer agents for the Data Market scenario.
 *
 * Architecture:
 *  - LLMSellerAgent extends SellerAgent (not LLMAgent directly) so that the
 *    existing mock handleMessage is always available as a fallback via super.
 *  - Same pattern for LLMBuyerAgent extends BuyerAgent.
 *  - On each incoming message the LLM agent tries to get a structured response
 *    from Claude. If the API call fails or the key is absent, it delegates to
 *    super.handleMessage() which runs the deterministic mock logic.
 *
 * The Zod discriminated union AgentResponseSchema is the single source of truth
 * for what Claude is allowed to return. zodOutputFormat() compiles this into the
 * API request so invalid JSON structures are never returned.
 *
 * One LLM call per message received — no batching, no polling.
 *
 * SDK version: @anthropic-ai/sdk ^0.80 (beta.messages.parse + zodOutputFormat).
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import {
  SellerAgent,
  BuyerAgent,
  type SellerConfig,
  type BuyerConfig,
} from "../scenarios/data-market.js";
import {
  createMessage,
  MessageType,
  type Message,
  type OfferPayload,
  type CounterPayload,
  type AcceptPayload,
  type RejectPayload,
  type DeliverPayload,
  type VerifyPayload,
  type ReleasePayload,
} from "../core/message.js";
import type { Ledger } from "../core/ledger.js";
import { createHash } from "node:crypto";
import { LLMAgent } from "./llm-agent.js";

// ---------------------------------------------------------------------------
// Shared Zod schema — defines every response Claude may return.
// The discriminated union means TypeScript narrows the type perfectly after
// the switch on `type`.
// ---------------------------------------------------------------------------

const AgentResponseSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("OFFER"),
    price: z.number().positive(),
    itemDescription: z.string().optional(),
  }),
  z.object({
    type: z.literal("COUNTER"),
    proposedPrice: z.number().positive(),
  }),
  z.object({
    type: z.literal("ACCEPT"),
    agreedPrice: z.number().positive(),
  }),
  z.object({
    type: z.literal("REJECT"),
    reason: z.string(),
  }),
  z.object({
    type: z.literal("DELIVER"),
    contentHash: z.string(),
    content: z.string(),
  }),
  z.object({
    type: z.literal("VERIFY"),
    verified: z.boolean(),
  }),
  z.object({
    type: z.literal("RELEASE"),
    escrowId: z.string(),
  }),
  z.object({
    type: z.literal("NO_RESPONSE"),
    reason: z.string(),
  }),
]);

type AgentResponse = z.infer<typeof AgentResponseSchema>;

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Shared LLM call helper (inline, not via LLMAgent.callLLM — the agents
// extend SellerAgent/BuyerAgent, not LLMAgent directly, so we replicate
// the thin wrapper here rather than use multiple inheritance).
// ---------------------------------------------------------------------------

// Type alias for the cast we need when calling beta.messages.parse().
// zodOutputFormat returns AutoParseableOutputFormat<T> which is structurally
// identical to AutoParseableBetaOutputFormat<T> but TypeScript sees different
// branded types. Both implement parse(string): T so the cast is safe.
type BetaAutoAgentFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat & {
  parse(content: string): AgentResponse;
};

const AGENT_OUTPUT_FORMAT = zodOutputFormat(AgentResponseSchema) as unknown as BetaAutoAgentFormat;

async function callBetaMessages(
  client: Anthropic,
  model: string,
  history: Anthropic.Beta.BetaMessageParam[],
  systemPrompt: string,
  userMessage: string,
  agentName: string
): Promise<AgentResponse | null> {
  history.push({ role: "user", content: userMessage });

  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 512,
      system: systemPrompt,
      messages: history,
      output_format: AGENT_OUTPUT_FORMAT,
    });

    const textContent = response.content.find((b) => b.type === "text");
    if (textContent && textContent.type === "text") {
      history.push({ role: "assistant", content: textContent.text });
    }

    return response.parsed_output as AgentResponse | null;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[${agentName}] LLM call failed, using mock fallback: ${msg}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// LLMSellerAgent
// ---------------------------------------------------------------------------

export class LLMSellerAgent extends SellerAgent {
  private readonly _llmClient: Anthropic;
  private readonly _llmModel: string;
  private readonly _llmHistory: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly _sellerConfig: SellerConfig;

  constructor(config: SellerConfig, ledger: Ledger, model = "claude-haiku-4-5") {
    super(config, ledger);
    this._sellerConfig = config;
    this._llmClient = new Anthropic();
    this._llmModel = model;
  }

  // ---------------------------------------------------------------------------
  // Build the seller's system prompt.
  // Includes all strategic context so Claude can reason about the trade.
  // ---------------------------------------------------------------------------

  private _buildSystemPrompt(): string {
    const minPrice = Math.round(
      this._sellerConfig.askPrice * this._sellerConfig.minAcceptRatio
    );
    return [
      `You are ${this.name}, an autonomous AI agent selling data in the Agora marketplace.`,
      ``,
      `Item for sale:`,
      `  ID         : ${this._sellerConfig.item.id}`,
      `  Description: ${this._sellerConfig.item.description}`,
      `  Content hash: ${this._sellerConfig.item.contentHash}`,
      ``,
      `Pricing strategy:`,
      `  Ask price  : ${this._sellerConfig.askPrice} CREDITS`,
      `  Floor price: ${minPrice} CREDITS (${this._sellerConfig.minAcceptRatio * 100}% of ask)`,
      `  Never accept less than ${minPrice} CREDITS.`,
      ``,
      `Your goal: maximize revenue while closing the deal.`,
      `  - Start by offering at ask price.`,
      `  - If a buyer counters above your floor, accept or re-offer at their counter.`,
      `  - If a buyer counters below your floor, reject with a clear reason.`,
      `  - After agreeing on price and receiving COMMIT, deliver the item immediately.`,
      `  - After receiving RELEASE, the trade is complete — respond with NO_RESPONSE.`,
      ``,
      `Respond ONLY with structured JSON matching the provided schema.`,
      `Choose the "type" field that matches the action you want to take.`,
    ].join("\n");
  }

  override async handleMessage(msg: Message): Promise<Message | null> {
    // Fallback immediately if no API key is present.
    if (!LLMAgent.isAvailable()) {
      return super.handleMessage(msg);
    }

    const userMessage =
      `Incoming message:\n  type: ${msg.type}\n` +
      `  payload: ${JSON.stringify(msg.payload, null, 2)}`;

    const parsed = await callBetaMessages(
      this._llmClient,
      this._llmModel,
      this._llmHistory,
      this._buildSystemPrompt(),
      userMessage,
      this.name
    );

    if (!parsed) {
      return super.handleMessage(msg);
    }

    return this._buildSellerMessage(parsed, msg);
  }

  private _buildSellerMessage(parsed: AgentResponse, incomingMsg: Message): Message | null {
    switch (parsed.type) {
      case "OFFER":
        return createMessage<OfferPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.OFFER,
          payload: {
            itemId: this._sellerConfig.item.id,
            itemDescription: parsed.itemDescription ?? this._sellerConfig.item.description,
            price: parsed.price,
            currency: "CREDITS",
          },
          replyTo: incomingMsg.id,
        });

      case "COUNTER":
        return createMessage<CounterPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.COUNTER,
          payload: {
            originalOfferId: incomingMsg.id,
            proposedPrice: parsed.proposedPrice,
            currency: "CREDITS",
          },
          replyTo: incomingMsg.id,
        });

      case "ACCEPT":
        return createMessage<AcceptPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.ACCEPT,
          payload: {
            acceptedOfferId: incomingMsg.id,
            agreedPrice: parsed.agreedPrice,
          },
          replyTo: incomingMsg.id,
        });

      case "REJECT":
        return createMessage<RejectPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.REJECT,
          payload: {
            rejectedId: incomingMsg.id,
            reason: parsed.reason,
          },
          replyTo: incomingMsg.id,
        });

      case "DELIVER":
        return createMessage<DeliverPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.DELIVER,
          payload: {
            itemId: this._sellerConfig.item.id,
            contentHash: parsed.contentHash,
            content: parsed.content,
          },
          replyTo: incomingMsg.id,
        });

      case "RELEASE":
        return createMessage<ReleasePayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.RELEASE,
          payload: { escrowId: parsed.escrowId },
          replyTo: incomingMsg.id,
        });

      case "VERIFY":
      case "NO_RESPONSE":
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// LLMBuyerAgent
// ---------------------------------------------------------------------------

export class LLMBuyerAgent extends BuyerAgent {
  private readonly _llmClient: Anthropic;
  private readonly _llmModel: string;
  private readonly _llmHistory: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly _buyerConfig: BuyerConfig;

  constructor(config: BuyerConfig, ledger: Ledger, model = "claude-haiku-4-5") {
    super(config, ledger);
    this._buyerConfig = config;
    this._llmClient = new Anthropic();
    this._llmModel = model;
  }

  // ---------------------------------------------------------------------------
  // Build the buyer's system prompt.
  // ---------------------------------------------------------------------------

  private _buildSystemPrompt(): string {
    return [
      `You are ${this.name}, an autonomous AI agent buying data in the Agora marketplace.`,
      ``,
      `Budget: ${this._buyerConfig.budget} CREDITS (hard limit — never agree to pay more)`,
      `Wallet: ${this._buyerConfig.initialBalance} CREDITS`,
      ``,
      `Your goal: acquire the dataset at the best price under your budget.`,
      `  - When you receive an OFFER, evaluate the price against your budget.`,
      `  - If price <= budget, ACCEPT it immediately.`,
      `  - If price > budget and you haven't countered yet, COUNTER at ~${Math.round(this._buyerConfig.firstCounterRatio * 100)}% of the ask.`,
      `  - If you've already countered and the new price is still above budget, REJECT.`,
      `  - When you receive DELIVER, respond with VERIFY — the system will check the hash.`,
      `  - After verification succeeds you may RELEASE the escrow if asked.`,
      ``,
      `Respond ONLY with structured JSON matching the provided schema.`,
      `Choose the "type" field that matches the action you want to take.`,
    ].join("\n");
  }

  override async handleMessage(msg: Message): Promise<Message | null> {
    // Fallback immediately if no API key is present.
    if (!LLMAgent.isAvailable()) {
      return super.handleMessage(msg);
    }

    const userMessage =
      `Incoming message:\n  type: ${msg.type}\n` +
      `  payload: ${JSON.stringify(msg.payload, null, 2)}`;

    const parsed = await callBetaMessages(
      this._llmClient,
      this._llmModel,
      this._llmHistory,
      this._buildSystemPrompt(),
      userMessage,
      this.name
    );

    if (!parsed) {
      return super.handleMessage(msg);
    }

    return this._buildBuyerMessage(parsed, msg);
  }

  private _buildBuyerMessage(parsed: AgentResponse, incomingMsg: Message): Message | null {
    switch (parsed.type) {
      case "OFFER":
        return createMessage<OfferPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.OFFER,
          payload: {
            itemId: "buyer-offer",
            itemDescription: parsed.itemDescription ?? "buyer-initiated offer",
            price: parsed.price,
            currency: "CREDITS",
          },
          replyTo: incomingMsg.id,
        });

      case "COUNTER":
        return createMessage<CounterPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.COUNTER,
          payload: {
            originalOfferId: incomingMsg.id,
            proposedPrice: parsed.proposedPrice,
            currency: "CREDITS",
          },
          replyTo: incomingMsg.id,
        });

      case "ACCEPT":
        return createMessage<AcceptPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.ACCEPT,
          payload: {
            acceptedOfferId: incomingMsg.id,
            agreedPrice: parsed.agreedPrice,
          },
          replyTo: incomingMsg.id,
        });

      case "REJECT":
        return createMessage<RejectPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.REJECT,
          payload: {
            rejectedId: incomingMsg.id,
            reason: parsed.reason,
          },
          replyTo: incomingMsg.id,
        });

      case "DELIVER":
        return createMessage<DeliverPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.DELIVER,
          payload: {
            itemId: "buyer-delivery",
            contentHash: parsed.contentHash,
            content: parsed.content,
          },
          replyTo: incomingMsg.id,
        });

      case "VERIFY": {
        // The buyer verifies using the actual hash from the DELIVER payload, not
        // trusting Claude to compute it — keeps cryptographic integrity intact.
        const deliverPayload = incomingMsg.payload as DeliverPayload;
        const computedHash = sha256(deliverPayload.content ?? "");
        const actuallyVerified = computedHash === deliverPayload.contentHash;
        return createMessage<VerifyPayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.VERIFY,
          payload: {
            deliveryMessageId: incomingMsg.id,
            // Override LLM judgment with cryptographic verification for security.
            verified: actuallyVerified,
          },
          replyTo: incomingMsg.id,
        });
      }

      case "RELEASE":
        return createMessage<ReleasePayload>({
          from: this.id,
          to: incomingMsg.from,
          type: MessageType.RELEASE,
          payload: { escrowId: parsed.escrowId },
          replyTo: incomingMsg.id,
        });

      case "NO_RESPONSE":
        return null;
    }
  }
}
