/**
 * Escrow protocol — first concrete CoordinationProtocol.
 *
 * State machine:
 *
 *   NEGOTIATE  ──accept──►  COMMIT  ──deliver──►  VERIFY  ──release──►  SETTLED
 *       │                     │                     │
 *   reject/timeout         refund               dispute
 *       │                     │                     │
 *       ▼                     ▼                     ▼
 *    FAILED               REFUNDED              DISPUTED
 *
 * The protocol is a coordinator that:
 *  1. Sends an initial OFFER from seller to buyer.
 *  2. Handles up to maxNegotiationRounds of counter-offers.
 *  3. On ACCEPT, instructs buyer to lock funds in escrow (COMMIT).
 *  4. Instructs seller to deliver once escrow is confirmed.
 *  5. Instructs buyer to verify delivery.
 *  6. On VERIFY=true, releases escrow to seller.
 *  7. On VERIFY=false or timeout, refunds escrow to buyer.
 */

import type { AgentId } from "../core/identity.js";
import type { EscrowId } from "../core/ledger.js";
import type { Ledger } from "../core/ledger.js";
import {
  createMessage,
  MessageType,
  type Message,
  type OfferPayload,
  type AcceptPayload,
  type CommitPayload,
  type DeliverPayload,
  type VerifyPayload,
  type ReleasePayload,
  type RejectPayload,
  type CounterPayload,
} from "../core/message.js";
import {
  DEFAULT_PROTOCOL_CONFIG,
  type CoordinationProtocol,
  type ProtocolConfig,
  type TradeOutcome,
} from "./types.js";

// ---------------------------------------------------------------------------
// Escrow protocol stages (internal)
// ---------------------------------------------------------------------------

type Stage =
  | "NEGOTIATE"
  | "COMMIT"
  | "DELIVER"
  | "VERIFY"
  | "SETTLED"
  | "FAILED"
  | "REFUNDED"
  | "DISPUTED";

interface EscrowState {
  stage: Stage;
  currentPrice: number;
  rounds: number;
  escrowId: EscrowId | null;
  deliveryHash: string | null;
  startedAt: number;
}

// ---------------------------------------------------------------------------
// Helper: assert a result is ok or throw
// ---------------------------------------------------------------------------
function assertOk<T>(
  result: { ok: boolean; value?: T; error?: { message: string } },
  context: string
): T {
  if (!result.ok) {
    throw new Error(`${context}: ${result.error?.message ?? "unknown error"}`);
  }
  return result.value as T;
}

// ---------------------------------------------------------------------------
// EscrowProtocol
// ---------------------------------------------------------------------------

export class EscrowProtocol implements CoordinationProtocol {
  readonly name = "escrow-v1";
  readonly config: ProtocolConfig;

  constructor(config: ProtocolConfig = DEFAULT_PROTOCOL_CONFIG) {
    this.config = config;
  }

  withConfig(overrides: Partial<ProtocolConfig>): EscrowProtocol {
    return new EscrowProtocol({ ...this.config, ...overrides });
  }

  // ------------------------------------------------------------------
  // Main entry point
  // ------------------------------------------------------------------

  async run(
    seller: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    buyer: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    ledger: Ledger
  ): Promise<TradeOutcome> {
    const state: EscrowState = {
      stage: "NEGOTIATE",
      currentPrice: 0,
      rounds: 0,
      escrowId: null,
      deliveryHash: null,
      startedAt: Date.now(),
    };

    // Step 1: request an offer from the seller
    const offerRequest = createMessage<Record<string, never>>({
      from: buyer.id,
      to: seller.id,
      type: MessageType.HELLO,
      payload: {},
    });

    let response = await seller.send(offerRequest);

    // Negotiation loop
    while (state.stage === "NEGOTIATE" && state.rounds < this.config.maxNegotiationRounds) {
      if (!response) break;

      if (response.type === MessageType.OFFER) {
        const offerPayload = response.payload as OfferPayload;
        state.currentPrice = offerPayload.price;
        state.rounds++;

        // Forward offer to buyer
        const buyerReply = await buyer.send(response);
        if (!buyerReply) {
          state.stage = "FAILED";
          break;
        }

        response = await this._handleBuyerReply(buyerReply, seller, buyer, state, ledger);
      } else if (response.type === MessageType.REJECT) {
        state.stage = "FAILED";
        break;
      } else {
        // Unexpected message type — abort
        state.stage = "FAILED";
        break;
      }
    }

    if (state.stage === "NEGOTIATE") {
      // Ran out of rounds
      state.stage = "FAILED";
    }

    const durationMs = Date.now() - state.startedAt;

    return {
      result:
        state.stage === "SETTLED"
          ? "SUCCESS"
          : state.stage === "DISPUTED"
          ? "DISPUTED"
          : "FAILED_NEGOTIATION",
      price: state.stage === "SETTLED" ? state.currentPrice : undefined,
      durationMs,
      agentIds: [seller.id, buyer.id],
      negotiationRounds: state.rounds,
    };
  }

  // ------------------------------------------------------------------
  // Handle whatever the buyer sends back during/after negotiation
  // ------------------------------------------------------------------

  private async _handleBuyerReply(
    reply: Message,
    seller: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    buyer: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    state: EscrowState,
    ledger: Ledger
  ): Promise<Message | null> {
    switch (reply.type) {
      case MessageType.ACCEPT: {
        const acceptPayload = reply.payload as AcceptPayload;
        state.currentPrice = acceptPayload.agreedPrice;
        state.stage = "COMMIT";
        await this._runCommitPhase(reply, seller, buyer, state, ledger);
        return null;
      }

      case MessageType.COUNTER: {
        const counterPayload = reply.payload as CounterPayload;
        const deviation =
          Math.abs(counterPayload.proposedPrice - state.currentPrice) / state.currentPrice;

        if (deviation > this.config.maxPriceDeviation) {
          // Price gap is too large — seller rejects
          const rejectMsg = createMessage<RejectPayload>({
            from: seller.id,
            to: buyer.id,
            type: MessageType.REJECT,
            payload: { rejectedId: reply.id, reason: "Price deviation exceeds tolerance" },
            replyTo: reply.id,
          });
          state.stage = "FAILED";
          await buyer.send(rejectMsg);
          return null;
        }

        // Seller accepts the counter by sending a new OFFER at the counter price
        state.currentPrice = counterPayload.proposedPrice;
        const newOffer = createMessage<OfferPayload>({
          from: seller.id,
          to: buyer.id,
          type: MessageType.OFFER,
          payload: {
            itemId: "data-item-1",
            itemDescription: "Dataset",
            price: state.currentPrice,
            currency: "CREDITS",
          },
          replyTo: reply.id,
        });
        return newOffer;
      }

      case MessageType.REJECT: {
        state.stage = "FAILED";
        return null;
      }

      default:
        state.stage = "FAILED";
        return null;
    }
  }

  // ------------------------------------------------------------------
  // COMMIT → DELIVER → VERIFY → SETTLE
  // ------------------------------------------------------------------

  private async _runCommitPhase(
    acceptMsg: Message,
    seller: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    buyer: { id: AgentId; send: (msg: Message) => Promise<Message | null> },
    state: EscrowState,
    ledger: Ledger
  ): Promise<void> {
    // Buyer locks funds in escrow
    const escrowResult = ledger.escrow(buyer.id, state.currentPrice);
    if (!escrowResult.ok) {
      state.stage = "FAILED";
      return;
    }
    state.escrowId = escrowResult.value;

    const commitMsg = createMessage<CommitPayload>({
      from: buyer.id,
      to: seller.id,
      type: MessageType.COMMIT,
      payload: { escrowId: state.escrowId, amount: state.currentPrice },
      replyTo: acceptMsg.id,
    });

    // Notify seller: funds are in escrow, please deliver
    const deliverResponse = await seller.send(commitMsg);
    if (!deliverResponse || deliverResponse.type !== MessageType.DELIVER) {
      // Seller didn't deliver — refund buyer
      assertOk(ledger.refundEscrow(state.escrowId), "refund on missing delivery");
      state.stage = "REFUNDED";
      return;
    }

    const deliverPayload = deliverResponse.payload as DeliverPayload;
    state.deliveryHash = deliverPayload.contentHash;

    // Buyer verifies delivery
    const verifyResponse = await buyer.send(deliverResponse);
    if (!verifyResponse || verifyResponse.type !== MessageType.VERIFY) {
      assertOk(ledger.refundEscrow(state.escrowId), "refund on missing verify");
      state.stage = "REFUNDED";
      return;
    }

    const verifyPayload = verifyResponse.payload as VerifyPayload;

    if (!verifyPayload.verified) {
      // Verification failed — could open dispute; for now refund
      if (verifyPayload.reason === "DISPUTE") {
        state.stage = "DISPUTED";
      } else {
        assertOk(ledger.refundEscrow(state.escrowId), "refund on verify=false");
        state.stage = "REFUNDED";
      }
      return;
    }

    // Verification passed — release escrow to seller
    const releaseMsg = createMessage<ReleasePayload>({
      from: buyer.id,
      to: seller.id,
      type: MessageType.RELEASE,
      payload: { escrowId: state.escrowId },
      replyTo: verifyResponse.id,
    });

    assertOk(ledger.releaseEscrow(state.escrowId, seller.id), "release escrow");
    await seller.send(releaseMsg);

    state.stage = "SETTLED";
  }
}
