/**
 * Base Agent class — immutable layer.
 *
 * Defines the minimal surface that every agent must implement.
 * The message queue is intentionally simple: agents process messages
 * one-at-a-time so the first scenario is easy to reason about.
 */

import type { AgentIdentity } from "./identity.js";
import type { Message } from "./message.js";
import { Ledger } from "./ledger.js";
import type { AgentId } from "./identity.js";

export abstract class Agent {
  readonly identity: AgentIdentity;
  protected readonly ledger: Ledger;

  /** Internal inbox: messages that haven't been processed yet. */
  private readonly _queue: Message[] = [];

  constructor(identity: AgentIdentity, ledger: Ledger, initialBalance: number) {
    this.identity = identity;
    this.ledger = ledger;
    this.ledger.register(identity.id, initialBalance);
  }

  get id(): AgentId {
    return this.identity.id;
  }

  get name(): string {
    return this.identity.name;
  }

  // ------------------------------------------------------------------
  // Abstract: subclasses implement their decision logic here.
  // Return null if no response is required.
  // ------------------------------------------------------------------

  abstract handleMessage(msg: Message): Promise<Message | null>;

  // ------------------------------------------------------------------
  // Messaging
  // ------------------------------------------------------------------

  /**
   * Deliver a message directly to another agent.
   * The message is added to the recipient's queue and immediately processed.
   */
  async send(to: Agent, msg: Message): Promise<Message | null> {
    return to.receive(msg);
  }

  /**
   * Push a message into this agent's queue and process it.
   * Called by other agents via `send`.
   */
  async receive(msg: Message): Promise<Message | null> {
    this._queue.push(msg);
    return this._processNext();
  }

  private async _processNext(): Promise<Message | null> {
    const msg = this._queue.shift();
    if (msg === undefined) return null;
    return this.handleMessage(msg);
  }

  // ------------------------------------------------------------------
  // Convenience: read own balance without unwrapping Result manually.
  // ------------------------------------------------------------------

  balance(): number {
    const result = this.ledger.balance(this.id);
    if (!result.ok) throw new Error(`Ledger error for ${this.name}: ${result.error.message}`);
    return result.value;
  }
}
