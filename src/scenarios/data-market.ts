/**
 * Data Market scenario — first runnable Agora simulation.
 *
 * Participants:
 *   SellerAgent — holds a data item, has an ask price, will accept counters
 *                 within a tolerance band.
 *   BuyerAgent  — wants the data, has a budget, will counter at midpoint if
 *                 the ask is above budget.
 *
 * Both agents use MOCK decision logic (no LLM calls).
 * Swap in a real LLM by overriding handleMessage in a subclass.
 */

import { createIdentity } from "../core/identity.js";
import { Ledger } from "../core/ledger.js";
import { Agent } from "../core/agent.js";
import {
  createMessage,
  MessageType,
  type Message,
  type OfferPayload,
  type CounterPayload,
  type AcceptPayload,
  type RejectPayload,
  type CommitPayload,
  type DeliverPayload,
  type VerifyPayload,
  type ReleasePayload,
} from "../core/message.js";
import { EscrowProtocol } from "../protocols/escrow.js";
import type { ProtocolConfig } from "../protocols/types.js";
import { computeMetrics, type TradeOutcome } from "../protocols/types.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Data item that the seller holds
// ---------------------------------------------------------------------------

export interface DataItem {
  readonly id: string;
  readonly description: string;
  readonly content: string;
  /** SHA-256 of content — agreed hash is shared in OFFER, verified on DELIVER */
  readonly contentHash: string;
}

export function createDataItem(id: string, description: string, content: string): DataItem {
  return Object.freeze({ id, description, content, contentHash: sha256(content) });
}

// ---------------------------------------------------------------------------
// SellerAgent
// ---------------------------------------------------------------------------

export interface SellerConfig {
  readonly name: string;
  readonly initialBalance: number;
  readonly item: DataItem;
  /** Asking price */
  readonly askPrice: number;
  /**
   * The lowest price the seller will accept as a fraction of ask.
   * e.g. 0.8 means "I'll go as low as 80 % of ask".
   */
  readonly minAcceptRatio: number;
}

export class SellerAgent extends Agent {
  private readonly _item: DataItem;
  private readonly _askPrice: number;
  private readonly _minAcceptRatio: number;
  private _log: string[] = [];

  constructor(config: SellerConfig, ledger: Ledger) {
    super(createIdentity(config.name), ledger, config.initialBalance);
    this._item = config.item;
    this._askPrice = config.askPrice;
    this._minAcceptRatio = config.minAcceptRatio;
  }

  get log(): readonly string[] {
    return this._log;
  }

  override async handleMessage(msg: Message): Promise<Message | null> {
    this._log.push(`[${this.name}] received ${msg.type} from ${msg.from}`);

    switch (msg.type) {
      case MessageType.HELLO: {
        // Buyer said hello — respond with an OFFER
        return createMessage<OfferPayload>({
          from: this.id,
          to: msg.from,
          type: MessageType.OFFER,
          payload: {
            itemId: this._item.id,
            itemDescription: this._item.description,
            price: this._askPrice,
            currency: "CREDITS",
          },
          replyTo: msg.id,
        });
      }

      case MessageType.COMMIT: {
        // Buyer has locked funds — deliver the goods
        const commitPayload = msg.payload as CommitPayload;
        this._log.push(
          `[${this.name}] escrow ${commitPayload.escrowId} confirmed, delivering item`
        );
        return createMessage<DeliverPayload>({
          from: this.id,
          to: msg.from,
          type: MessageType.DELIVER,
          payload: {
            itemId: this._item.id,
            contentHash: this._item.contentHash,
            content: this._item.content,
          },
          replyTo: msg.id,
        });
      }

      case MessageType.RELEASE: {
        const releasePayload = msg.payload as ReleasePayload;
        this._log.push(
          `[${this.name}] received RELEASE for escrow ${releasePayload.escrowId}. Balance: ${this.balance()}`
        );
        return null;
      }

      case MessageType.REJECT: {
        const rejectPayload = msg.payload as RejectPayload;
        this._log.push(`[${this.name}] trade rejected: ${rejectPayload.reason}`);
        return null;
      }

      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// BuyerAgent
// ---------------------------------------------------------------------------

export interface BuyerConfig {
  readonly name: string;
  readonly initialBalance: number;
  /** Maximum the buyer is willing to pay */
  readonly budget: number;
  /**
   * First counter-offer as a fraction of ask price.
   * e.g. 0.8 means "counter at 80 % of whatever is asked".
   */
  readonly firstCounterRatio: number;
}

export class BuyerAgent extends Agent {
  private readonly _budget: number;
  private readonly _firstCounterRatio: number;
  private _lastOfferPrice = 0;
  private _hasCountered = false;
  private _log: string[] = [];

  constructor(config: BuyerConfig, ledger: Ledger) {
    super(createIdentity(config.name), ledger, config.initialBalance);
    this._budget = config.budget;
    this._firstCounterRatio = config.firstCounterRatio;
  }

  get log(): readonly string[] {
    return this._log;
  }

  override async handleMessage(msg: Message): Promise<Message | null> {
    this._log.push(`[${this.name}] received ${msg.type} from ${msg.from}`);

    switch (msg.type) {
      case MessageType.OFFER: {
        const offerPayload = msg.payload as OfferPayload;
        this._lastOfferPrice = offerPayload.price;

        if (offerPayload.price <= this._budget) {
          // Affordable — accept
          this._log.push(
            `[${this.name}] offer ${offerPayload.price} <= budget ${this._budget}, accepting`
          );
          return createMessage<AcceptPayload>({
            from: this.id,
            to: msg.from,
            type: MessageType.ACCEPT,
            payload: { acceptedOfferId: msg.id, agreedPrice: offerPayload.price },
            replyTo: msg.id,
          });
        }

        if (!this._hasCountered) {
          // First counter: try at firstCounterRatio of the ask
          const counterPrice = Math.round(offerPayload.price * this._firstCounterRatio);
          this._hasCountered = true;
          this._log.push(
            `[${this.name}] offer ${offerPayload.price} > budget ${this._budget}, countering at ${counterPrice}`
          );
          return createMessage<CounterPayload>({
            from: this.id,
            to: msg.from,
            type: MessageType.COUNTER,
            payload: {
              originalOfferId: msg.id,
              proposedPrice: counterPrice,
              currency: "CREDITS",
            },
            replyTo: msg.id,
          });
        }

        // Second offer after counter: accept if <= budget, else reject
        if (offerPayload.price <= this._budget) {
          return createMessage<AcceptPayload>({
            from: this.id,
            to: msg.from,
            type: MessageType.ACCEPT,
            payload: { acceptedOfferId: msg.id, agreedPrice: offerPayload.price },
            replyTo: msg.id,
          });
        }

        this._log.push(`[${this.name}] still too expensive, rejecting`);
        return createMessage<RejectPayload>({
          from: this.id,
          to: msg.from,
          type: MessageType.REJECT,
          payload: { rejectedId: msg.id, reason: "Price exceeds budget after counter" },
          replyTo: msg.id,
        });
      }

      case MessageType.DELIVER: {
        const deliverPayload = msg.payload as DeliverPayload;
        // Verify: recompute hash from received content
        const computedHash = sha256(deliverPayload.content);
        const verified = computedHash === deliverPayload.contentHash;
        this._log.push(
          `[${this.name}] delivery received, hash ${verified ? "OK" : "MISMATCH"}`
        );
        return createMessage<VerifyPayload>({
          from: this.id,
          to: msg.from,
          type: MessageType.VERIFY,
          payload: { deliveryMessageId: msg.id, verified },
          replyTo: msg.id,
        });
      }

      case MessageType.REJECT: {
        const rejectPayload = msg.payload as RejectPayload;
        this._log.push(`[${this.name}] offer rejected: ${rejectPayload.reason}`);
        return null;
      }

      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Scenario runner
// ---------------------------------------------------------------------------

export interface DataMarketConfig {
  seller: SellerConfig;
  buyer: BuyerConfig;
  protocol?: Partial<ProtocolConfig>;
}

export interface DataMarketResult {
  outcome: TradeOutcome;
  sellerLog: readonly string[];
  buyerLog: readonly string[];
  finalBalances: { seller: number; buyer: number };
}

export async function runDataMarket(config: DataMarketConfig): Promise<DataMarketResult> {
  const ledger = new Ledger();

  const seller = new SellerAgent(config.seller, ledger);
  const buyer = new BuyerAgent(config.buyer, ledger);

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

// ---------------------------------------------------------------------------
// Default scenario configuration used by the CLI
// ---------------------------------------------------------------------------

export const DEFAULT_DATA_MARKET_CONFIG: DataMarketConfig = {
  seller: {
    name: "DataSeller",
    initialBalance: 0,
    item: createDataItem(
      "weather-2024",
      "Global weather dataset 2024",
      JSON.stringify({ rows: 1_000_000, columns: ["lat", "lon", "temp", "humidity"] })
    ),
    // Ask above budget so negotiation fires:
    // seller asks 15 → buyer counters at 12 (80% of 15 = 12)
    // seller checks: 12 >= 0.7 * 15 = 10.5 → accepts via new OFFER(12)
    // buyer receives OFFER(12) <= budget 12 → ACCEPT → settles at 12
    askPrice: 15,
    minAcceptRatio: 0.7,
  },
  buyer: {
    name: "DataBuyer",
    initialBalance: 20,
    budget: 12,
    firstCounterRatio: 0.8,
  },
};

/**
 * Hard negotiation scenario — intentionally fails.
 *
 * seller asks 20, won't go below 90% = 18.
 * buyer counters at 70% of ask = 14, but budget cap is 12.
 * seller re-offers at 14 (within maxPriceDeviation of 0.3).
 * buyer sees 14 > budget 12 and rejects → FAILED_NEGOTIATION.
 */
export const HARD_NEGOTIATION_CONFIG: DataMarketConfig = {
  seller: {
    name: "HardSeller",
    initialBalance: 0,
    item: createDataItem(
      "premium-dataset",
      "Premium proprietary dataset",
      JSON.stringify({ rows: 5_000_000, columns: ["id", "value", "timestamp"] })
    ),
    askPrice: 20,
    minAcceptRatio: 0.9, // floor = 18; won't go below that
  },
  buyer: {
    name: "LowBudgetBuyer",
    initialBalance: 20,
    budget: 12,           // hard cap; can never pay more
    firstCounterRatio: 0.7, // counters at 14 (seller re-offers 14 > budget 12 → reject)
  },
};

// Re-export for convenience
export { computeMetrics };
