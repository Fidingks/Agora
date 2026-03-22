/**
 * Sealed-bid first-price auction scenario — first multi-agent Agora simulation.
 *
 * Participants:
 *   AuctioneerAgent (1) — holds a data asset, sets a reserve price, collects
 *                         sealed bids, awards to the highest valid bidder.
 *   BidderAgent (2-5)   — each has a budget & private valuation, submits a
 *                         sealed bid based on configurable aggressiveness.
 *
 * Flow:
 *   1. Auctioneer sends OFFER to every bidder (item + reserve price).
 *   2. Each bidder replies with COUNTER (bid) or REJECT (pass).
 *   3. Auctioneer picks the highest bid above reserve (first bidder wins ties).
 *      Winner gets ACCEPT, losers get REJECT.
 *   4. Winner + Auctioneer enter escrow (COMMIT → DELIVER → VERIFY → RELEASE).
 *   5. If no valid bids, auction fails.
 *
 * All agents use MOCK decision logic (no LLM calls).
 */

import { createIdentity, type AgentId } from "../core/identity.js";
import { Ledger } from "../core/ledger.js";
import { Agent } from "../core/agent.js";
import {
  createMessage,
  MessageType,
  type Message,
  type MessageId,
  type OfferPayload,
  type CounterPayload,
  type AcceptPayload,
  type RejectPayload,
  type CommitPayload,
  type DeliverPayload,
  type VerifyPayload,
  type ReleasePayload,
} from "../core/message.js";
import type { ProtocolConfig, TradeOutcome } from "../protocols/types.js";
import type { ReputationStore } from "../protocols/reputation.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

// ---------------------------------------------------------------------------
// Data item (same shape as in data-market.ts, inlined to avoid coupling)
// ---------------------------------------------------------------------------

export interface AuctionItem {
  readonly id: string;
  readonly description: string;
  readonly content: string;
  readonly contentHash: string;
}

export function createAuctionItem(id: string, description: string, content: string): AuctionItem {
  return Object.freeze({ id, description, content, contentHash: sha256(content) });
}

// ---------------------------------------------------------------------------
// AuctioneerAgent
// ---------------------------------------------------------------------------

export class AuctioneerAgent extends Agent {
  private readonly _item: AuctionItem;
  private readonly _reservePrice: number;
  private _log: string[] = [];

  constructor(
    name: string,
    ledger: Ledger,
    initialBalance: number,
    item: AuctionItem,
    reservePrice: number,
  ) {
    super(createIdentity(name), ledger, initialBalance);
    this._item = item;
    this._reservePrice = reservePrice;
  }

  get log(): readonly string[] {
    return this._log;
  }

  get reservePrice(): number {
    return this._reservePrice;
  }

  get item(): AuctionItem {
    return this._item;
  }

  /**
   * Build the OFFER message that announces the auction to a single bidder.
   */
  createOfferMessage(toBidderId: AgentId): Message<OfferPayload> {
    return createMessage<OfferPayload>({
      from: this.id,
      to: toBidderId,
      type: MessageType.OFFER,
      payload: {
        itemId: this._item.id,
        itemDescription: this._item.description,
        price: this._reservePrice,
        currency: "CREDITS",
      },
    });
  }

  override async handleMessage(msg: Message): Promise<Message | null> {
    this._log.push(`[${this.name}] received ${msg.type} from ${msg.from}`);

    switch (msg.type) {
      case MessageType.COMMIT: {
        // Winner has locked funds — deliver the goods.
        const commitPayload = msg.payload as CommitPayload;
        this._log.push(
          `[${this.name}] escrow ${commitPayload.escrowId} confirmed, delivering item`,
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
          `[${this.name}] received RELEASE for escrow ${releasePayload.escrowId}. Balance: ${this.balance()}`,
        );
        return null;
      }

      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// BidderAgent
// ---------------------------------------------------------------------------

export class BidderAgent extends Agent {
  private readonly _budget: number;
  private readonly _valuation: number;
  private readonly _aggressiveness: number;
  private _log: string[] = [];

  constructor(
    name: string,
    ledger: Ledger,
    initialBalance: number,
    budget: number,
    valuation: number,
    aggressiveness: number,
  ) {
    super(createIdentity(name), ledger, initialBalance);
    this._budget = budget;
    this._valuation = valuation;
    this._aggressiveness = aggressiveness;
  }

  get log(): readonly string[] {
    return this._log;
  }

  get budget(): number {
    return this._budget;
  }

  get valuation(): number {
    return this._valuation;
  }

  /**
   * Decide whether to accept the current Dutch auction price.
   *
   * A rational bidder accepts when the price is at or below their valuation
   * (they gain surplus).  We also honour the budget constraint: if the bidder
   * cannot afford the current price, they cannot accept.
   *
   * Returns true (accept) or false (reject/wait).
   */
  decideDutchAccept(currentPrice: number): boolean {
    // Cannot afford it
    if (currentPrice > this._budget) return false;
    // Accept once the price is at or below valuation
    return currentPrice <= this._valuation;
  }

  /**
   * Compute this bidder's sealed bid for the given reserve price.
   * Returns null if the bidder should pass (bid would be below reserve or
   * valuation is below reserve).
   */
  computeBid(reservePrice: number): number | null {
    // Raw bid based on valuation and aggressiveness
    let bid = this._valuation * this._aggressiveness;

    // Cap at budget
    bid = Math.min(bid, this._budget);

    // If the bid doesn't meet the reserve, pass
    if (bid < reservePrice) {
      return null;
    }

    return bid;
  }

  override async handleMessage(msg: Message): Promise<Message | null> {
    this._log.push(`[${this.name}] received ${msg.type} from ${msg.from}`);

    switch (msg.type) {
      case MessageType.OFFER: {
        const offerPayload = msg.payload as OfferPayload;
        const reservePrice = offerPayload.price;
        const bid = this.computeBid(reservePrice);

        if (bid === null) {
          this._log.push(
            `[${this.name}] passing on auction (reserve=${reservePrice}, valuation=${this._valuation}, budget=${this._budget})`,
          );
          return createMessage<RejectPayload>({
            from: this.id,
            to: msg.from,
            type: MessageType.REJECT,
            payload: { rejectedId: msg.id, reason: "Bid below reserve" },
            replyTo: msg.id,
          });
        }

        this._log.push(
          `[${this.name}] bidding ${bid} (reserve=${reservePrice}, valuation=${this._valuation})`,
        );
        return createMessage<CounterPayload>({
          from: this.id,
          to: msg.from,
          type: MessageType.COUNTER,
          payload: {
            originalOfferId: msg.id,
            proposedPrice: bid,
            currency: "CREDITS",
          },
          replyTo: msg.id,
        });
      }

      case MessageType.ACCEPT: {
        this._log.push(`[${this.name}] won the auction!`);
        return null;
      }

      case MessageType.REJECT: {
        const rejectPayload = msg.payload as RejectPayload;
        this._log.push(`[${this.name}] lost auction: ${rejectPayload.reason}`);
        return null;
      }

      case MessageType.DELIVER: {
        // Verify delivery: recompute hash from received content
        const deliverPayload = msg.payload as DeliverPayload;
        const computedHash = sha256(deliverPayload.content);
        const verified = computedHash === deliverPayload.contentHash;
        this._log.push(
          `[${this.name}] delivery received, hash ${verified ? "OK" : "MISMATCH"}`,
        );
        return createMessage<VerifyPayload>({
          from: this.id,
          to: msg.from,
          type: MessageType.VERIFY,
          payload: { deliveryMessageId: msg.id, verified },
          replyTo: msg.id,
        });
      }

      default:
        return null;
    }
  }
}

// ---------------------------------------------------------------------------
// Auction type
// ---------------------------------------------------------------------------

/**
 * Supported auction mechanisms:
 *   "first-price" — winner pays their own (highest) bid.
 *   "vickrey"     — winner pays the second-highest bid (or reserve price
 *                   when only one bid clears the reserve).  This is the
 *                   classic second-price sealed-bid mechanism that makes
 *                   truthful bidding a dominant strategy.
 *   "dutch"       — descending-price auction.  Price starts at startingPrice
 *                   and drops by priceDecrement each round.  The first bidder
 *                   to accept the current price wins at that price.
 */
export type AuctionType = "first-price" | "vickrey" | "dutch";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AuctionConfig {
  /** Number of bidders (2-5) */
  bidderCount: number;
  /** Auctioneer's reserve price */
  reservePrice: number;
  /** Bidder budgets (array, length must match bidderCount) */
  bidderBudgets: number[];
  /** Bidder private valuations */
  bidderValuations: number[];
  /** Bid aggressiveness per bidder (0.5-1.0) */
  bidAggressiveness: number[];
  /** Protocol config overrides */
  protocol?: Partial<ProtocolConfig>;
  /** Optional reputation store */
  reputationStore?: ReputationStore;
  /**
   * Auction mechanism.  Defaults to "first-price" so all existing callers
   * are unaffected.
   */
  auctionType?: AuctionType;

  // ---- Dutch auction parameters (ignored for other auction types) ----

  /**
   * Dutch auction: initial high price.
   * Defaults to reservePrice * 2.
   */
  startingPrice?: number;
  /**
   * Dutch auction: how much the price drops each round.
   * Defaults to reservePrice * 0.1.
   */
  priceDecrement?: number;
  /**
   * Dutch auction: maximum number of descending rounds before the auction
   * ends with no winner.
   * Defaults to 10.
   */
  maxRounds?: number;
}

export const DEFAULT_AUCTION_CONFIG: AuctionConfig = {
  bidderCount: 3,
  reservePrice: 10,
  bidderBudgets: [20, 15, 25],
  bidderValuations: [14, 11, 18],
  bidAggressiveness: [0.9, 0.8, 0.7],
  // Bidder 0: bids 14*0.9=12.6
  // Bidder 1: bids 11*0.8=8.8 (below reserve 10, won't bid)
  // Bidder 2: bids 18*0.7=12.6 (tie — first bidder wins)
  // Winner: Bidder 0 at 12.6
};

// ---------------------------------------------------------------------------
// Outcome
// ---------------------------------------------------------------------------

export interface AuctionOutcome {
  /** The trade outcome (reuses TradeOutcome from types.ts) */
  tradeOutcome: TradeOutcome;
  /**
   * The highest bid submitted, or null if no winner.
   * In a Vickrey auction this is NOT what the winner pays — see
   * `settlementPrice` for the actual payment.
   */
  winningBid: number | null;
  /**
   * The price actually paid by the winner (and recorded in the ledger).
   *   first-price: equals winningBid
   *   vickrey    : equals the second-highest bid, or the reserve price when
   *                only one bidder cleared the reserve
   * Null when there is no winner.
   */
  settlementPrice: number | null;
  /** Number of valid bids received */
  validBidCount: number;
  /** Total bidders */
  totalBidders: number;
  /** Winner agent ID, or null */
  winnerId: AgentId | null;
  /** Auction mechanism that was used */
  auctionType: AuctionType;
}

// ---------------------------------------------------------------------------
// Escrow settlement phase (reuses the COMMIT → DELIVER → VERIFY → RELEASE
// pattern from EscrowProtocol but driven directly since the negotiation
// phase is already complete)
// ---------------------------------------------------------------------------

/**
 * Run the post-auction escrow settlement between the auctioneer and the
 * winning bidder.  Returns true on success, false on failure.
 */
async function settleEscrow(
  auctioneer: AuctioneerAgent,
  winner: BidderAgent,
  agreedPrice: number,
  ledger: Ledger,
  acceptMsgId: MessageId,
): Promise<boolean> {
  // 1. Buyer locks funds in escrow
  const escrowResult = ledger.escrow(winner.id, agreedPrice);
  if (!escrowResult.ok) return false;
  const escrowId = escrowResult.value;

  // 2. COMMIT — notify auctioneer that funds are locked
  const commitMsg = createMessage<CommitPayload>({
    from: winner.id,
    to: auctioneer.id,
    type: MessageType.COMMIT,
    payload: { escrowId, amount: agreedPrice },
    replyTo: acceptMsgId,
  });

  const deliverResponse = await auctioneer.receive(commitMsg);
  if (!deliverResponse || deliverResponse.type !== MessageType.DELIVER) {
    ledger.refundEscrow(escrowId);
    return false;
  }

  // 3. VERIFY — winner checks the delivery
  const verifyResponse = await winner.receive(deliverResponse);
  if (!verifyResponse || verifyResponse.type !== MessageType.VERIFY) {
    ledger.refundEscrow(escrowId);
    return false;
  }

  const verifyPayload = verifyResponse.payload as VerifyPayload;
  if (!verifyPayload.verified) {
    ledger.refundEscrow(escrowId);
    return false;
  }

  // 4. RELEASE — funds go to auctioneer
  const releaseResult = ledger.releaseEscrow(escrowId, auctioneer.id);
  if (!releaseResult.ok) return false;

  const releaseMsg = createMessage<ReleasePayload>({
    from: winner.id,
    to: auctioneer.id,
    type: MessageType.RELEASE,
    payload: { escrowId },
    replyTo: verifyResponse.id,
  });
  await auctioneer.receive(releaseMsg);

  return true;
}

// ---------------------------------------------------------------------------
// Dutch auction runner (separated for clarity)
// ---------------------------------------------------------------------------

/**
 * Run a Dutch (descending-price) auction.
 *
 * Price starts at `startingPrice` and drops by `priceDecrement` each round.
 * The first bidder to accept the current price wins at that price.
 * If multiple bidders accept in the same round, the one with the lowest
 * index (earliest in the bidders array) wins.
 * If no one accepts after `maxRounds` rounds, the auction fails.
 */
async function runDutchAuction(
  cfg: AuctionConfig,
  auctioneer: AuctioneerAgent,
  bidders: BidderAgent[],
  allAgentIds: AgentId[],
  ledger: Ledger,
  startedAt: number,
): Promise<AuctionOutcome> {
  const startingPrice = cfg.startingPrice ?? cfg.reservePrice * 2;
  const priceDecrement = cfg.priceDecrement ?? cfg.reservePrice * 0.1;
  const maxRounds = cfg.maxRounds ?? 10;

  let currentPrice = startingPrice;
  let roundsRun = 0;

  // Track which bidders are still active (have not been eliminated)
  const activeBidders = [...bidders];

  for (let round = 0; round < maxRounds; round++) {
    roundsRun = round + 1;

    // Broadcast the current price to all active bidders via OFFER message
    // and collect their decisions (ACCEPT vs REJECT / COUNTER is ignored).
    const acceptors: BidderAgent[] = [];

    for (const bidder of activeBidders) {
      const offerMsg = createMessage<OfferPayload>({
        from: auctioneer.id,
        to: bidder.id,
        type: MessageType.OFFER,
        payload: {
          itemId: auctioneer.item.id,
          itemDescription: auctioneer.item.description,
          price: currentPrice,
          currency: "CREDITS",
        },
      });

      // Bidder decision: accept if price ≤ valuation and within budget
      if (bidder.decideDutchAccept(currentPrice)) {
        acceptors.push(bidder);
        // Deliver the OFFER so the agent's log is updated (we drive the
        // decision externally but keep messaging consistent)
        await bidder.receive(offerMsg);
      } else {
        await bidder.receive(offerMsg);
      }
    }

    if (acceptors.length > 0) {
      // First acceptor wins (lowest index in original bidders array)
      // acceptors are already in insertion order of activeBidders, which
      // preserves the original order.
      const winner = acceptors[0]!;
      const settlementPrice = currentPrice;

      // Notify the winner
      const acceptMsg = createMessage<AcceptPayload>({
        from: auctioneer.id,
        to: winner.id,
        type: MessageType.ACCEPT,
        payload: { acceptedOfferId: "" as MessageId, agreedPrice: settlementPrice },
      });
      await winner.receive(acceptMsg);

      // Notify all non-winners (other acceptors and still-active bidders)
      for (const bidder of activeBidders) {
        if (bidder.id !== winner.id) {
          const rejectMsg = createMessage<RejectPayload>({
            from: auctioneer.id,
            to: bidder.id,
            type: MessageType.REJECT,
            payload: { rejectedId: "" as MessageId, reason: "Another bidder accepted first" },
          });
          await bidder.receive(rejectMsg);
        }
      }

      // Escrow settlement
      const settled = await settleEscrow(
        auctioneer,
        winner,
        settlementPrice,
        ledger,
        acceptMsg.id,
      );

      const durationMs = Date.now() - startedAt;

      // Reputation updates
      if (cfg.reputationStore) {
        if (settled) {
          cfg.reputationStore.recordSuccess(auctioneer.id);
          cfg.reputationStore.recordSuccess(winner.id);
        } else {
          cfg.reputationStore.recordFailure(auctioneer.id);
        }
      }

      const tradeResult = settled ? "SUCCESS" as const : "FAILED_DELIVERY" as const;

      return {
        tradeOutcome: {
          result: tradeResult,
          price: settled ? settlementPrice : undefined,
          durationMs,
          agentIds: allAgentIds,
          negotiationRounds: roundsRun,
        },
        winningBid: settlementPrice,
        settlementPrice: settled ? settlementPrice : null,
        validBidCount: acceptors.length,
        totalBidders: cfg.bidderCount,
        winnerId: winner.id,
        auctionType: "dutch",
      };
    }

    // No acceptors this round — drop the price for the next round
    currentPrice -= priceDecrement;

    // If price has fallen below reserve, stop immediately
    if (currentPrice < cfg.reservePrice) {
      roundsRun = round + 1;
      break;
    }
  }

  // No winner after all rounds
  const durationMs = Date.now() - startedAt;

  // Notify all bidders that the auction failed
  for (const bidder of bidders) {
    const rejectMsg = createMessage<RejectPayload>({
      from: auctioneer.id,
      to: bidder.id,
      type: MessageType.REJECT,
      payload: { rejectedId: "" as MessageId, reason: "Dutch auction ended — no winner" },
    });
    await bidder.receive(rejectMsg);
  }

  return {
    tradeOutcome: {
      result: "FAILED_NEGOTIATION",
      price: undefined,
      durationMs,
      agentIds: allAgentIds,
      negotiationRounds: roundsRun,
    },
    winningBid: null,
    settlementPrice: null,
    validBidCount: 0,
    totalBidders: cfg.bidderCount,
    winnerId: null,
    auctionType: "dutch",
  };
}

// ---------------------------------------------------------------------------
// Main runner
// ---------------------------------------------------------------------------

export async function runAuction(
  config?: Partial<AuctionConfig>,
): Promise<AuctionOutcome> {
  const cfg: AuctionConfig = { ...DEFAULT_AUCTION_CONFIG, ...config };
  const auctionType: AuctionType = cfg.auctionType ?? "first-price";
  const startedAt = Date.now();
  const ledger = new Ledger();

  // Create the auction item
  const item = createAuctionItem(
    "auction-item-1",
    "Premium dataset",
    JSON.stringify({ rows: 500_000, columns: ["id", "value", "score"] }),
  );

  // Create the auctioneer
  const auctioneer = new AuctioneerAgent(
    "Auctioneer",
    ledger,
    0,
    item,
    cfg.reservePrice,
  );

  // Create bidders
  const bidders: BidderAgent[] = [];
  for (let i = 0; i < cfg.bidderCount; i++) {
    const budget = cfg.bidderBudgets[i] ?? 10;
    const valuation = cfg.bidderValuations[i] ?? 10;
    const aggressiveness = cfg.bidAggressiveness[i] ?? 0.8;
    bidders.push(
      new BidderAgent(
        `Bidder-${i}`,
        ledger,
        budget,      // initial balance = budget
        budget,
        valuation,
        aggressiveness,
      ),
    );
  }

  // Collect all agent IDs for the TradeOutcome
  const allAgentIds: AgentId[] = [auctioneer.id, ...bidders.map((b) => b.id)];

  // ------------------------------------------------------------------
  // Dutch auction has a completely different flow — delegate immediately.
  // ------------------------------------------------------------------

  if (auctionType === "dutch") {
    return runDutchAuction(cfg, auctioneer, bidders, allAgentIds, ledger, startedAt);
  }

  // ------------------------------------------------------------------
  // Phase 1: Broadcast OFFER to all bidders, collect bids
  // ------------------------------------------------------------------

  interface BidEntry {
    bidder: BidderAgent;
    price: number;
  }

  const validBids: BidEntry[] = [];

  for (const bidder of bidders) {
    const offerMsg = auctioneer.createOfferMessage(bidder.id);
    const response = await bidder.receive(offerMsg);

    if (!response) continue;

    if (response.type === MessageType.COUNTER) {
      const counterPayload = response.payload as CounterPayload;
      if (counterPayload.proposedPrice >= cfg.reservePrice) {
        validBids.push({ bidder, price: counterPayload.proposedPrice });
      }
    }
    // REJECT or anything else → bidder passed
  }

  // ------------------------------------------------------------------
  // Phase 2: Pick the winner (highest bid, first-bidder wins ties)
  // ------------------------------------------------------------------

  if (validBids.length === 0) {
    // No valid bids — auction fails
    const durationMs = Date.now() - startedAt;

    // Notify all bidders that auction failed
    for (const bidder of bidders) {
      const rejectMsg = createMessage<RejectPayload>({
        from: auctioneer.id,
        to: bidder.id,
        type: MessageType.REJECT,
        payload: { rejectedId: "" as MessageId, reason: "No valid bids — auction cancelled" },
      });
      await bidder.receive(rejectMsg);
    }

    return {
      tradeOutcome: {
        result: "FAILED_NEGOTIATION",
        price: undefined,
        durationMs,
        agentIds: allAgentIds,
        negotiationRounds: 1,
      },
      winningBid: null,
      settlementPrice: null,
      validBidCount: 0,
      totalBidders: cfg.bidderCount,
      winnerId: null,
      auctionType,
    };
  }

  // Sort descending by price; stable sort preserves insertion order for ties
  validBids.sort((a, b) => b.price - a.price);
  const winner = validBids[0]!;

  // ------------------------------------------------------------------
  // Determine settlement price based on auction type.
  //
  // first-price: winner pays their own bid (winner.price)
  // vickrey:     winner pays the second-highest bid, or the reserve
  //              price when they are the only valid bidder.
  // ------------------------------------------------------------------

  let settlementPrice: number;
  if (auctionType === "vickrey") {
    if (validBids.length >= 2) {
      // Second-highest bid is the first element after the winner in the
      // sorted (descending) array.
      settlementPrice = validBids[1]!.price;
    } else {
      // Only one bidder cleared the reserve — they pay the reserve price.
      settlementPrice = cfg.reservePrice;
    }
  } else {
    // first-price: pay your own bid
    settlementPrice = winner.price;
  }

  // ------------------------------------------------------------------
  // Phase 3: Notify winner (ACCEPT) and losers (REJECT)
  // ------------------------------------------------------------------

  const acceptMsg = createMessage<AcceptPayload>({
    from: auctioneer.id,
    to: winner.bidder.id,
    type: MessageType.ACCEPT,
    payload: { acceptedOfferId: "" as MessageId, agreedPrice: settlementPrice },
  });
  await winner.bidder.receive(acceptMsg);

  for (const bid of validBids.slice(1)) {
    const rejectMsg = createMessage<RejectPayload>({
      from: auctioneer.id,
      to: bid.bidder.id,
      type: MessageType.REJECT,
      payload: { rejectedId: "" as MessageId, reason: "Outbid" },
    });
    await bid.bidder.receive(rejectMsg);
  }

  // Also notify bidders that didn't place valid bids (they already got
  // their own REJECT during the bidding phase, so no extra notification)

  // ------------------------------------------------------------------
  // Phase 4: Escrow settlement with the winner
  // ------------------------------------------------------------------

  const settled = await settleEscrow(
    auctioneer,
    winner.bidder,
    settlementPrice,
    ledger,
    acceptMsg.id,
  );

  const durationMs = Date.now() - startedAt;

  // Update reputation if a store is provided
  if (cfg.reputationStore) {
    if (settled) {
      cfg.reputationStore.recordSuccess(auctioneer.id);
      cfg.reputationStore.recordSuccess(winner.bidder.id);
    } else {
      cfg.reputationStore.recordFailure(auctioneer.id);
    }
  }

  const tradeResult = settled ? "SUCCESS" as const : "FAILED_DELIVERY" as const;

  return {
    tradeOutcome: {
      result: tradeResult,
      price: settled ? settlementPrice : undefined,
      durationMs,
      agentIds: allAgentIds,
      negotiationRounds: 1,
    },
    winningBid: winner.price,
    settlementPrice: settled ? settlementPrice : null,
    validBidCount: validBids.length,
    totalBidders: cfg.bidderCount,
    winnerId: winner.bidder.id,
    auctionType,
  };
}
