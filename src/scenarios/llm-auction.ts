/**
 * LLM Auction scenario — runs a sealed-bid auction where every bidder is
 * powered by Claude Haiku instead of rule-based logic.
 *
 * When ANTHROPIC_API_KEY is absent the scenario falls back to the
 * deterministic mock BidderAgent automatically (via LLMAuctionBidder's
 * super.handleMessage() fallback), so it can always be imported in tests.
 *
 * Usage:
 *   npx tsx src/scenarios/llm-auction.ts                  # first-price
 *   npx tsx src/scenarios/llm-auction.ts --type vickrey   # vickrey
 */

import { Ledger } from "../core/ledger.js";
import { LLMAuctionBidder, type LLMAuctionBidderConfig } from "../agents/llm-auction-agent.js";
import { AuctioneerAgent, createAuctionItem } from "../scenarios/auction.js";
import type { AuctionType, AuctionOutcome } from "../scenarios/auction.js";
import {
  createMessage,
  MessageType,
  type MessageId,
  type CounterPayload,
  type AcceptPayload,
  type RejectPayload,
  type CommitPayload,
  type DeliverPayload,
  type VerifyPayload,
  type ReleasePayload,
} from "../core/message.js";
import type { AgentId } from "../core/identity.js";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export interface LLMAuctionConfig {
  /** Number of LLM bidders (2–4). Default: 3 */
  bidderCount?: number;
  /** Reserve price. Default: 10 */
  reservePrice?: number;
  /** Auction mechanism. Default: "first-price" */
  auctionType?: AuctionType;
  /** LLM model to use for bidders. Default: "claude-haiku-4-5" */
  model?: string;
}

export interface LLMAuctionResult extends AuctionOutcome {
  /** Per-bidder reasoning strings captured from the LLM (or mock). */
  bidderReasoning: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Internal escrow settlement (copy of the logic in auction.ts — kept
// independent to avoid coupling to the internal helpers of that module).
// ---------------------------------------------------------------------------

async function settleLLMEscrow(
  auctioneer: AuctioneerAgent,
  winner: LLMAuctionBidder,
  settlementPrice: number,
  ledger: Ledger,
  acceptMsgId: MessageId,
): Promise<boolean> {
  const escrowResult = ledger.escrow(winner.id, settlementPrice);
  if (!escrowResult.ok) return false;
  const escrowId = escrowResult.value;

  const commitMsg = createMessage<CommitPayload>({
    from: winner.id,
    to: auctioneer.id,
    type: MessageType.COMMIT,
    payload: { escrowId, amount: settlementPrice },
    replyTo: acceptMsgId,
  });

  const deliverResponse = await auctioneer.receive(commitMsg);
  if (!deliverResponse || deliverResponse.type !== MessageType.DELIVER) {
    ledger.refundEscrow(escrowId);
    return false;
  }

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
// Main runner
// ---------------------------------------------------------------------------

export async function runLLMAuction(
  config: LLMAuctionConfig = {},
): Promise<LLMAuctionResult> {
  const bidderCount = Math.max(2, Math.min(config.bidderCount ?? 3, 4));
  const reservePrice = config.reservePrice ?? 10;
  const auctionType: AuctionType = config.auctionType ?? "first-price";
  const model = config.model ?? "claude-haiku-4-5";

  const startedAt = Date.now();
  const ledger = new Ledger();

  // -------------------------------------------------------------------------
  // Create auction item
  // -------------------------------------------------------------------------

  const item = createAuctionItem(
    "auction-item-llm-1",
    "Premium analytics dataset (500k rows, 3 columns)",
    JSON.stringify({ rows: 500_000, columns: ["id", "value", "score"] }),
  );

  // -------------------------------------------------------------------------
  // Create auctioneer
  // -------------------------------------------------------------------------

  const auctioneer = new AuctioneerAgent("Auctioneer", ledger, 0, item, reservePrice);

  // -------------------------------------------------------------------------
  // Create LLM bidders with randomised budgets / valuations
  //
  // Valuations are drawn from [reservePrice * 0.8, reservePrice * 2.5] so
  // there is genuine strategic uncertainty.  Budgets are set to valuation × 1.2
  // (bidder always has funds to cover their true value).
  // -------------------------------------------------------------------------

  // Use a seeded-ish deterministic spread for reproducibility in tests.
  const valuationMultipliers = [1.4, 1.1, 1.8, 1.2];
  const bidders: LLMAuctionBidder[] = [];

  for (let i = 0; i < bidderCount; i++) {
    const mult = valuationMultipliers[i % valuationMultipliers.length]!;
    const valuation = Math.round(reservePrice * mult * 10) / 10;
    const budget = Math.round(valuation * 1.3 * 10) / 10;

    const bidderCfg: LLMAuctionBidderConfig = {
      name: `Bidder-${i}`,
      budget,
      valuation,
      aggressiveness: auctionType === "vickrey" ? 1.0 : 0.8,
      auctionType,
      competitorCount: bidderCount - 1,
    };

    bidders.push(new LLMAuctionBidder(bidderCfg, ledger, model));
  }

  const allAgentIds: AgentId[] = [auctioneer.id, ...bidders.map((b) => b.id)];

  // -------------------------------------------------------------------------
  // Phase 1: Broadcast OFFER, collect bids
  // -------------------------------------------------------------------------

  interface BidEntry {
    bidder: LLMAuctionBidder;
    price: number;
  }

  const validBids: BidEntry[] = [];

  for (const bidder of bidders) {
    const offerMsg = auctioneer.createOfferMessage(bidder.id);
    const response = await bidder.receive(offerMsg);

    if (!response) continue;

    if (response.type === MessageType.COUNTER) {
      const counterPayload = response.payload as CounterPayload;
      if (counterPayload.proposedPrice >= reservePrice) {
        validBids.push({ bidder, price: counterPayload.proposedPrice });
      }
    }
    // REJECT → bidder passed
  }

  // -------------------------------------------------------------------------
  // Build reasoning map (all bidders, including those who passed)
  // -------------------------------------------------------------------------

  const bidderReasoning: Record<string, string> = {};
  for (const bidder of bidders) {
    bidderReasoning[bidder.name] = bidder.lastReasoning;
  }

  // -------------------------------------------------------------------------
  // Phase 2: Pick winner (highest bid, first-bidder wins ties)
  // -------------------------------------------------------------------------

  if (validBids.length === 0) {
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
      totalBidders: bidderCount,
      winnerId: null,
      auctionType,
      bidderReasoning,
    };
  }

  // Sort descending by price; stable sort preserves insertion order for ties.
  validBids.sort((a, b) => b.price - a.price);
  const winner = validBids[0]!;

  // -------------------------------------------------------------------------
  // Determine settlement price
  // -------------------------------------------------------------------------

  let settlementPrice: number;
  if (auctionType === "vickrey") {
    settlementPrice = validBids.length >= 2 ? validBids[1]!.price : reservePrice;
  } else {
    settlementPrice = winner.price;
  }

  // -------------------------------------------------------------------------
  // Phase 3: Notify winner (ACCEPT) and losers (REJECT)
  // -------------------------------------------------------------------------

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

  // -------------------------------------------------------------------------
  // Phase 4: Escrow settlement with winner
  // -------------------------------------------------------------------------

  const settled = await settleLLMEscrow(
    auctioneer,
    winner.bidder,
    settlementPrice,
    ledger,
    acceptMsg.id,
  );

  const durationMs = Date.now() - startedAt;
  const tradeResult = settled ? ("SUCCESS" as const) : ("FAILED_DELIVERY" as const);

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
    totalBidders: bidderCount,
    winnerId: winner.bidder.id,
    auctionType,
    bidderReasoning,
  };
}

// ---------------------------------------------------------------------------
// CLI entrypoint guard
// ---------------------------------------------------------------------------

function isEntrypoint(): boolean {
  // ESM: import.meta.url is file:///...path  vs  process.argv[1] is the raw path
  const url = new URL(import.meta.url);
  const entryPath = process.argv[1];
  if (!entryPath) return false;
  // Normalise to forward slashes for comparison on Windows.
  const filePath = url.pathname.replace(/^\/([A-Z]:)/, "$1").replace(/\//g, "\\");
  const argPath = entryPath.replace(/\//g, "\\");
  return filePath === argPath || url.pathname.endsWith(entryPath.replace(/\\/g, "/"));
}

if (isEntrypoint()) {
  // Parse --type flag from CLI args
  const typeIdx = process.argv.indexOf("--type");
  const rawType = typeIdx !== -1 ? process.argv[typeIdx + 1] : undefined;
  const auctionType: AuctionType =
    rawType === "vickrey" || rawType === "first-price" ? rawType : "first-price";

  console.log(`\n=== Agora LLM Auction (${auctionType}) ===\n`);

  runLLMAuction({ auctionType }).then((result) => {
    const { tradeOutcome, winningBid, settlementPrice, validBidCount, totalBidders, auctionType: type, bidderReasoning } = result;

    console.log(`Auction type   : ${type}`);
    console.log(`Bidders        : ${totalBidders}`);
    console.log(`Valid bids     : ${validBidCount}`);
    console.log(`Outcome        : ${tradeOutcome.result}`);
    console.log(`Winning bid    : ${winningBid ?? "none"}`);
    console.log(`Settlement     : ${settlementPrice ?? "none"}`);
    console.log(`Duration       : ${tradeOutcome.durationMs} ms`);

    if (Object.keys(bidderReasoning).length > 0) {
      console.log(`\nBidder reasoning:`);
      for (const [name, reasoning] of Object.entries(bidderReasoning)) {
        if (reasoning) {
          console.log(`  ${name}: ${reasoning}`);
        }
      }
    }

    console.log("\nDone.");
  }).catch((err) => {
    console.error("LLM Auction failed:", err);
    process.exit(1);
  });
}
