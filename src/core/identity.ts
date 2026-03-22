/**
 * Agent identity — immutable layer.
 *
 * AgentId is a branded string so callers cannot accidentally pass a raw string
 * where an AgentId is expected. All identity objects are frozen on creation.
 */

// Branded type: string that has been validated as an AgentId.
export type AgentId = string & { readonly __brand: "AgentId" };

let _counter = 0;

/**
 * Mint a new, globally-unique AgentId.
 * Format: "agent-<timestamp>-<counter>"
 */
export function createAgentId(): AgentId {
  const ts = Date.now();
  const n = ++_counter;
  return `agent-${ts}-${n}` as AgentId;
}

/**
 * Cast a raw string to AgentId without generating a new one.
 * Useful for tests and deserialization — prefer createAgentId() in production.
 */
export function toAgentId(raw: string): AgentId {
  if (!raw) throw new Error("AgentId must be a non-empty string");
  return raw as AgentId;
}

export interface AgentIdentity {
  readonly id: AgentId;
  readonly name: string;
  readonly createdAt: Date;
}

/**
 * Create a frozen AgentIdentity. The id is generated automatically.
 */
export function createIdentity(name: string): AgentIdentity {
  if (!name.trim()) throw new Error("Agent name must be non-empty");
  return Object.freeze({
    id: createAgentId(),
    name,
    createdAt: new Date(),
  });
}
