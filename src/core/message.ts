/**
 * Agent-to-agent message format — immutable layer.
 *
 * Every interaction in Agora is expressed as a typed Message.
 * The payload type T is determined by the MessageType, keeping the
 * type system honest without reaching for `any`.
 */

import type { AgentId } from "./identity.js";

// ---------------------------------------------------------------------------
// Branded MessageId
// ---------------------------------------------------------------------------

export type MessageId = string & { readonly __brand: "MessageId" };

let _msgCounter = 0;

export function createMessageId(): MessageId {
  return `msg-${Date.now()}-${++_msgCounter}` as MessageId;
}

// ---------------------------------------------------------------------------
// Protocol message types
// Ordered to mirror the stages of a negotiation → commit → settle lifecycle.
// ---------------------------------------------------------------------------

export enum MessageType {
  /** Initial greeting / capability advertisement */
  HELLO = "HELLO",

  /** Seller proposes a price / terms */
  OFFER = "OFFER",

  /** Buyer counters with different terms */
  COUNTER = "COUNTER",

  /** One party accepts the current terms */
  ACCEPT = "ACCEPT",

  /** One party rejects and terminates the negotiation */
  REJECT = "REJECT",

  /** Buyer commits funds to escrow — deal is locked */
  COMMIT = "COMMIT",

  /** Seller delivers the agreed item (hash + payload) */
  DELIVER = "DELIVER",

  /** Buyer signals delivery was verified */
  VERIFY = "VERIFY",

  /** Buyer releases escrowed funds to seller */
  RELEASE = "RELEASE",

  /** Either party opens a dispute */
  DISPUTE = "DISPUTE",
}

// ---------------------------------------------------------------------------
// Generic Message<T>
// ---------------------------------------------------------------------------

export interface Message<T = unknown> {
  readonly id: MessageId;
  readonly from: AgentId;
  readonly to: AgentId;
  readonly type: MessageType;
  readonly payload: T;
  readonly timestamp: Date;
  /** Optional reference to the message being replied to */
  readonly replyTo?: MessageId;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createMessage<T>(params: {
  from: AgentId;
  to: AgentId;
  type: MessageType;
  payload: T;
  replyTo?: MessageId;
}): Message<T> {
  return Object.freeze({
    id: createMessageId(),
    from: params.from,
    to: params.to,
    type: params.type,
    payload: params.payload,
    timestamp: new Date(),
    ...(params.replyTo !== undefined ? { replyTo: params.replyTo } : {}),
  });
}

// ---------------------------------------------------------------------------
// Well-known payload shapes (used by protocols and scenarios)
// ---------------------------------------------------------------------------

export interface HelloPayload {
  agentName: string;
  capabilities: string[];
}

export interface OfferPayload {
  itemId: string;
  itemDescription: string;
  price: number;
  currency: string;
}

export interface CounterPayload {
  originalOfferId: MessageId;
  proposedPrice: number;
  currency: string;
}

export interface AcceptPayload {
  acceptedOfferId: MessageId;
  agreedPrice: number;
}

export interface RejectPayload {
  rejectedId: MessageId;
  reason: string;
}

export interface CommitPayload {
  escrowId: string;
  amount: number;
}

export interface DeliverPayload {
  itemId: string;
  /** SHA-256 hex of the delivered content */
  contentHash: string;
  /** The actual content (base64 or plain text in the sandbox) */
  content: string;
}

export interface VerifyPayload {
  deliveryMessageId: MessageId;
  verified: boolean;
  reason?: string;
}

export interface ReleasePayload {
  escrowId: string;
}

export interface DisputePayload {
  reason: string;
  evidenceMessageIds: MessageId[];
}
