/**
 * LLM-driven bidder agent for the Agora auction scenario.
 *
 * LLMAuctionBidder wraps BidderAgent (same pattern as llm-data-market.ts:
 * extend the mock class, override handleMessage, fall back to super on
 * missing API key or LLM error).
 *
 * Key design decisions:
 *   - Uses a simple BidDecisionSchema (bid + reasoning) — one LLM call per
 *     OFFER message received.  All other message types (ACCEPT / REJECT /
 *     DELIVER) are handled by the deterministic base class because they
 *     require no strategic decision.
 *   - System prompt explains the auction-theory distinction between
 *     first-price (shade below true value) and Vickrey (bid true value).
 *   - Falls back to BidderAgent.computeBid() so tests always pass without
 *     an API key.
 */

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BidderAgent } from "../scenarios/auction.js";
import type { AuctionType } from "../scenarios/auction.js";
import {
  createMessage,
  MessageType,
  type Message,
  type OfferPayload,
  type CounterPayload,
  type RejectPayload,
} from "../core/message.js";
import type { Ledger } from "../core/ledger.js";
import { LLMAgent } from "./llm-agent.js";

// ---------------------------------------------------------------------------
// Zod schema — the single structured output Claude may return for a bid.
// ---------------------------------------------------------------------------

export const BidDecisionSchema = z.object({
  /** The amount to bid, in CREDITS.  Must be > 0 and <= budget. */
  bid: z.number().positive(),
  /** One-sentence explanation of the bidding strategy chosen. */
  reasoning: z.string(),
});

export type BidDecision = z.infer<typeof BidDecisionSchema>;

// ---------------------------------------------------------------------------
// Type alias for the beta.messages.parse cast (same workaround as
// llm-data-market.ts — both zodOutputFormat flavours are structurally
// identical but TypeScript sees different branded types).
// ---------------------------------------------------------------------------

type BetaBidFormat = Anthropic.Beta.Messages.BetaJSONOutputFormat & {
  parse(content: string): BidDecision;
};

const BID_OUTPUT_FORMAT = zodOutputFormat(BidDecisionSchema) as unknown as BetaBidFormat;

// ---------------------------------------------------------------------------
// Config for LLMAuctionBidder
// ---------------------------------------------------------------------------

export interface LLMAuctionBidderConfig {
  /** Display name for the agent. */
  name: string;
  /** Hard cap on spending. */
  budget: number;
  /** Private valuation — the true maximum willingness to pay. */
  valuation: number;
  /**
   * Fallback aggressiveness used by the rule-based mock (0.5–1.0).
   * Default: 0.8
   */
  aggressiveness?: number;
  /** Auction mechanism — drives the LLM's strategic framing. */
  auctionType: AuctionType;
  /** Number of competing bidders, used for LLM context. */
  competitorCount: number;
}

// ---------------------------------------------------------------------------
// LLMAuctionBidder
// ---------------------------------------------------------------------------

export class LLMAuctionBidder extends BidderAgent {
  private readonly _llmClient: Anthropic;
  private readonly _llmModel: string;
  private readonly _llmHistory: Anthropic.Beta.BetaMessageParam[] = [];
  private readonly _auctionType: AuctionType;
  private readonly _competitorCount: number;
  /** Own copy of valuation (base class field is private). */
  private readonly _ownValuation: number;
  /** Own copy of budget (base class field is private). */
  private readonly _ownBudget: number;
  /** Own copy of aggressiveness for display / mock log messages. */
  private readonly _ownAggressiveness: number;
  /** Stores the last reasoning string for inspection (tests / scenario output). */
  private _lastReasoning = "";

  constructor(
    config: LLMAuctionBidderConfig,
    ledger: Ledger,
    model = "claude-haiku-4-5",
  ) {
    const aggressiveness = config.aggressiveness ?? 0.8;
    super(
      config.name,
      ledger,
      config.budget, // initial balance equals budget
      config.budget,
      config.valuation,
      aggressiveness,
    );
    this._llmClient = new Anthropic();
    this._llmModel = model;
    this._auctionType = config.auctionType;
    this._competitorCount = config.competitorCount;
    this._ownValuation = config.valuation;
    this._ownBudget = config.budget;
    this._ownAggressiveness = aggressiveness;
  }

  // ---------------------------------------------------------------------------
  // Public accessors — useful for test assertions and scenario output.
  // ---------------------------------------------------------------------------

  /** The last reasoning produced by LLM or mock fallback. */
  get lastReasoning(): string {
    return this._lastReasoning;
  }

  /** Auction type this bidder is configured for. */
  get auctionType(): AuctionType {
    return this._auctionType;
  }

  // ---------------------------------------------------------------------------
  // System prompt — teaches Claude the game-theoretic distinction between
  // first-price and Vickrey bidding strategies.
  // ---------------------------------------------------------------------------

  private _buildSystemPrompt(reservePrice: number): string {
    const maxBid = Math.min(this._ownValuation, this._ownBudget);

    const strategyGuide =
      this._auctionType === "vickrey"
        ? [
            `Auction type: VICKREY (second-price sealed-bid).`,
            ``,
            `Game-theory insight: In a Vickrey auction the DOMINANT STRATEGY is to`,
            `bid your TRUE valuation (${this._ownValuation} CREDITS) regardless of`,
            `competitors.  Bidding above true value risks paying more than the item`,
            `is worth.  Bidding below may forfeit a profitable win.  Bid truthfully.`,
          ]
        : [
            `Auction type: FIRST-PRICE sealed-bid.`,
            ``,
            `Game-theory insight: In a first-price auction you pay your OWN bid if`,
            `you win, so you should SHADE your bid below your true valuation to earn`,
            `a positive surplus.  With ${this._competitorCount} competitor(s), a`,
            `rule-of-thumb is to bid (n-1)/n × valuation where n = total bidders.`,
            `Never bid above your true valuation of ${this._ownValuation} CREDITS.`,
          ];

    return [
      `You are ${this.name}, an autonomous AI bidder in the Agora marketplace.`,
      ``,
      `Private information:`,
      `  True valuation : ${this._ownValuation} CREDITS  (max you'd ever pay)`,
      `  Budget (wallet) : ${this._ownBudget} CREDITS  (hard cap — never bid more)`,
      `  Reserve price  : ${reservePrice} CREDITS  (bid must be ≥ this to qualify)`,
      `  Competitors    : ${this._competitorCount}`,
      ``,
      ...strategyGuide,
      ``,
      `Hard constraints:`,
      `  - bid must be ≥ ${reservePrice} (reserve price)`,
      `  - bid must be ≤ ${maxBid} (min of valuation and budget)`,
      `  - If reservePrice > valuation, set bid to the reserve price and explain`,
      `    in reasoning that bidding is not economically rational.`,
      ``,
      `Return ONLY structured JSON matching the provided schema:`,
      `  { bid: <number>, reasoning: <string> }`,
    ].join("\n");
  }

  // ---------------------------------------------------------------------------
  // Core: call the LLM to get a bid decision.
  // Returns null on error or missing API key — caller falls back to mock.
  // ---------------------------------------------------------------------------

  private async _askLLMForBid(reservePrice: number): Promise<BidDecision | null> {
    if (!LLMAgent.isAvailable()) {
      return null;
    }

    const userMessage = [
      `A sealed-bid auction OFFER has arrived:`,
      `  Reserve price  : ${reservePrice} CREDITS`,
      `  Your valuation : ${this._ownValuation} CREDITS`,
      `  Your budget    : ${this._ownBudget} CREDITS`,
      `  Auction type   : ${this._auctionType}`,
      `  Competitors    : ${this._competitorCount}`,
      ``,
      `Decide your bid and explain your reasoning in one sentence.`,
    ].join("\n");

    this._llmHistory.push({ role: "user", content: userMessage });

    try {
      const response = await this._llmClient.beta.messages.parse({
        model: this._llmModel,
        max_tokens: 256,
        system: this._buildSystemPrompt(reservePrice),
        messages: this._llmHistory,
        output_format: BID_OUTPUT_FORMAT,
      });

      const textContent = response.content.find((b) => b.type === "text");
      if (textContent && textContent.type === "text") {
        this._llmHistory.push({ role: "assistant", content: textContent.text });
      }

      return (response.parsed_output as BidDecision | null) ?? null;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[${this.name}] LLM bid call failed, using mock fallback: ${msg}`);
      return null;
    }
  }

  // ---------------------------------------------------------------------------
  // Override handleMessage: replace OFFER handling with LLM-driven bid.
  // All other message types (ACCEPT / REJECT / DELIVER) delegate to base class.
  // ---------------------------------------------------------------------------

  override async handleMessage(msg: Message): Promise<Message | null> {
    if (msg.type !== MessageType.OFFER) {
      // No strategic decision needed — let the deterministic base class handle
      // ACCEPT, REJECT, DELIVER, and any unexpected message types.
      return super.handleMessage(msg);
    }

    const offerPayload = msg.payload as OfferPayload;
    const reservePrice = offerPayload.price;

    // Attempt an LLM-driven bid decision.
    const decision = await this._askLLMForBid(reservePrice);

    if (decision === null) {
      // No API key or LLM error — fall back to rule-based bidding.
      this._lastReasoning =
        `[mock] rule-based bid: valuation=${this._ownValuation} × aggressiveness=${this._ownAggressiveness}`;
      return super.handleMessage(msg);
    }

    // Clamp to safe bounds: bid ∈ [reserve, min(valuation, budget)].
    const maxAllowed = Math.min(this._ownValuation, this._ownBudget);
    const clampedBid = Math.max(reservePrice, Math.min(decision.bid, maxAllowed));

    this._lastReasoning = decision.reasoning;

    // If the valuation is below the reserve price the bidder should pass.
    // We detect this by checking whether the only valid clamped bid equals
    // reserve while the bidder's own valuation is below reserve.
    if (this._ownValuation < reservePrice) {
      return createMessage<RejectPayload>({
        from: this.id,
        to: msg.from,
        type: MessageType.REJECT,
        payload: {
          rejectedId: msg.id,
          reason: `Valuation (${this._ownValuation}) below reserve (${reservePrice})`,
        },
        replyTo: msg.id,
      });
    }

    return createMessage<CounterPayload>({
      from: this.id,
      to: msg.from,
      type: MessageType.COUNTER,
      payload: {
        originalOfferId: msg.id,
        proposedPrice: clampedBid,
        currency: "CREDITS",
      },
      replyTo: msg.id,
    });
  }
}
