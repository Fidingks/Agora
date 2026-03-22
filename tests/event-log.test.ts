/**
 * Event log unit + integration tests.
 *
 * Covers: emit, query filters, listeners, unsubscribe, clear, size,
 * formatted output (table / JSON / TSV), summary stats, and integration
 * with EscrowProtocol, ReputationStore, and the auction scenario.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventLog, globalLog, type AgentEvent } from "../src/core/event-log.js";
import { toAgentId } from "../src/core/identity.js";
import { ReputationStore } from "../src/protocols/reputation.js";
import { EscrowProtocol } from "../src/protocols/escrow.js";
import { Ledger } from "../src/core/ledger.js";
import { runAuction } from "../src/scenarios/auction.js";
import {
  createMessage,
  MessageType,
  type Message,
  type OfferPayload,
  type CounterPayload,
  type AcceptPayload,
  type VerifyPayload,
  type DeliverPayload,
} from "../src/core/message.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function freshLog(): EventLog {
  return new EventLog();
}

const ALICE = toAgentId("alice");
const BOB = toAgentId("bob");
const CHARLIE = toAgentId("charlie");

// ---------------------------------------------------------------------------
// Unit tests: EventLog core behaviour
// ---------------------------------------------------------------------------

describe("EventLog: emit and basic retrieval", () => {
  it("starts empty", () => {
    const log = freshLog();
    expect(log.size()).toBe(0);
    expect(log.getAll()).toHaveLength(0);
  });

  it("emit increases size and stores the event", () => {
    const log = freshLog();
    log.emit("escrow", "escrow.locked", [ALICE, BOB], { amount: 100 });
    expect(log.size()).toBe(1);
    const all = log.getAll();
    expect(all[0]?.category).toBe("escrow");
    expect(all[0]?.event).toBe("escrow.locked");
    expect(all[0]?.agentIds).toContain(ALICE);
    expect(all[0]?.data["amount"]).toBe(100);
  });

  it("emit stores a timestamp close to Date.now()", () => {
    const log = freshLog();
    const before = Date.now();
    log.emit("system", "system.boot", [], {});
    const after = Date.now();
    const ts = log.getAll()[0]!.timestamp;
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it("getAll returns a copy — mutations do not affect the store", () => {
    const log = freshLog();
    log.emit("system", "system.boot", [], {});
    const copy = log.getAll();
    copy.length = 0;
    expect(log.size()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: query filters
// ---------------------------------------------------------------------------

describe("EventLog: query by category", () => {
  it("filters events to the requested category only", () => {
    const log = freshLog();
    log.emit("escrow", "escrow.locked", [ALICE], {});
    log.emit("reputation", "reputation.success", [BOB], {});
    log.emit("auction", "auction.bid", [CHARLIE], {});

    const escrow = log.query({ category: "escrow" });
    expect(escrow).toHaveLength(1);
    expect(escrow[0]?.category).toBe("escrow");
  });
});

describe("EventLog: query by event name", () => {
  it("returns only events with the exact event name", () => {
    const log = freshLog();
    log.emit("escrow", "escrow.locked", [ALICE], {});
    log.emit("escrow", "escrow.settled", [ALICE, BOB], {});
    log.emit("escrow", "escrow.locked", [CHARLIE], {});

    const locked = log.query({ event: "escrow.locked" });
    expect(locked).toHaveLength(2);
    locked.forEach((e) => expect(e.event).toBe("escrow.locked"));
  });
});

describe("EventLog: query by agentId", () => {
  it("returns events where agentIds includes the given id", () => {
    const log = freshLog();
    log.emit("negotiation", "negotiation.counter", [ALICE, BOB], {});
    log.emit("negotiation", "negotiation.counter", [BOB, CHARLIE], {});
    log.emit("negotiation", "negotiation.accepted", [ALICE, CHARLIE], {});

    const aliceEvents = log.query({ agentId: ALICE });
    expect(aliceEvents).toHaveLength(2);
    aliceEvents.forEach((e) => expect(e.agentIds).toContain(ALICE));
  });
});

describe("EventLog: query by since timestamp", () => {
  it("excludes events older than the since value", async () => {
    const log = freshLog();
    log.emit("system", "system.boot", [], {});
    const marker = Date.now();
    // Emit a tiny bit after the marker to ensure timestamp > marker
    await new Promise((r) => setTimeout(r, 2));
    log.emit("system", "system.shutdown", [], {});

    const recent = log.query({ since: marker + 1 });
    expect(recent).toHaveLength(1);
    expect(recent[0]?.event).toBe("system.shutdown");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: listeners
// ---------------------------------------------------------------------------

describe("EventLog: listener / unsubscribe", () => {
  it("listener is called on each emit", () => {
    const log = freshLog();
    const calls: AgentEvent[] = [];
    log.on((e) => calls.push(e));

    log.emit("escrow", "escrow.locked", [ALICE], {});
    log.emit("escrow", "escrow.settled", [ALICE, BOB], {});
    expect(calls).toHaveLength(2);
  });

  it("unsubscribe function stops future notifications", () => {
    const log = freshLog();
    const calls: AgentEvent[] = [];
    const off = log.on((e) => calls.push(e));

    log.emit("system", "system.boot", [], {});
    off();
    log.emit("system", "system.shutdown", [], {});
    expect(calls).toHaveLength(1);
  });

  it("multiple listeners are each called independently", () => {
    const log = freshLog();
    let a = 0;
    let b = 0;
    log.on(() => a++);
    log.on(() => b++);

    log.emit("system", "system.boot", [], {});
    expect(a).toBe(1);
    expect(b).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: clear and size
// ---------------------------------------------------------------------------

describe("EventLog: clear and size", () => {
  it("clear removes all stored events", () => {
    const log = freshLog();
    log.emit("system", "system.boot", [], {});
    log.emit("system", "system.shutdown", [], {});
    expect(log.size()).toBe(2);
    log.clear();
    expect(log.size()).toBe(0);
    expect(log.getAll()).toHaveLength(0);
  });

  it("clear does not remove listeners", () => {
    const log = freshLog();
    const calls: AgentEvent[] = [];
    log.on((e) => calls.push(e));
    log.emit("system", "system.boot", [], {});
    log.clear();
    log.emit("system", "system.restart", [], {});
    // The listener fired twice (once before and once after clear).
    expect(calls).toHaveLength(2);
  });

  it("size returns 0 for a fresh log", () => {
    expect(freshLog().size()).toBe(0);
  });

  it("size increments correctly with multiple emits", () => {
    const log = freshLog();
    for (let i = 0; i < 5; i++) {
      log.emit("system", "system.tick", [], { i });
    }
    expect(log.size()).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Unit tests: formatted output
// ---------------------------------------------------------------------------

describe("EventLog: toTable", () => {
  it("returns a non-empty string with a header when events exist", () => {
    const log = freshLog();
    log.emit("escrow", "escrow.locked", [ALICE], { amount: 50 });
    const table = log.toTable();
    expect(typeof table).toBe("string");
    expect(table).toContain("TIMESTAMP");
    expect(table).toContain("CATEGORY");
    expect(table).toContain("EVENT");
    expect(table).toContain("escrow.locked");
  });

  it("returns '(no events)' when the log is empty", () => {
    expect(freshLog().toTable()).toBe("(no events)");
  });
});

describe("EventLog: toJSON", () => {
  it("produces valid JSON that round-trips back to the events array", () => {
    const log = freshLog();
    log.emit("reputation", "reputation.success", [ALICE], { score: 0.75 });
    const json = log.toJSON();
    expect(() => JSON.parse(json)).not.toThrow();
    const parsed = JSON.parse(json) as AgentEvent[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.event).toBe("reputation.success");
  });
});

describe("EventLog: toTSV", () => {
  it("produces tab-separated values with a header row", () => {
    const log = freshLog();
    log.emit("auction", "auction.bid", [BOB, CHARLIE], { bid: 42 });
    const tsv = log.toTSV();
    const lines = tsv.split("\n");
    expect(lines[0]).toContain("timestamp");
    expect(lines[0]).toContain("category");
    expect(lines[0]).toContain("event");
    expect(lines[0]).toContain("agentIds");
    // Data row exists
    expect(lines.length).toBeGreaterThan(1);
    // Tabs present
    expect(lines[1]).toContain("\t");
    expect(lines[1]).toContain("auction.bid");
  });
});

// ---------------------------------------------------------------------------
// Unit tests: summary
// ---------------------------------------------------------------------------

describe("EventLog: summary", () => {
  it("returns zeros for an empty log", () => {
    const s = freshLog().summary();
    expect(s.totalEvents).toBe(0);
    expect(s.uniqueAgents).toBe(0);
    expect(s.timeSpanMs).toBe(0);
    expect(s.byCategory).toEqual({});
  });

  it("counts events by category correctly", () => {
    const log = freshLog();
    log.emit("escrow", "escrow.locked", [ALICE], {});
    log.emit("escrow", "escrow.settled", [ALICE, BOB], {});
    log.emit("reputation", "reputation.success", [BOB], {});

    const s = log.summary();
    expect(s.totalEvents).toBe(3);
    expect(s.byCategory["escrow"]).toBe(2);
    expect(s.byCategory["reputation"]).toBe(1);
  });

  it("counts unique agents across all events", () => {
    const log = freshLog();
    log.emit("escrow", "escrow.locked", [ALICE, BOB], {});
    log.emit("escrow", "escrow.settled", [ALICE, CHARLIE], {});

    const s = log.summary();
    // ALICE appears in both, BOB in first, CHARLIE in second → 3 unique
    expect(s.uniqueAgents).toBe(3);
  });

  it("timeSpanMs is 0 for a single event", () => {
    const log = freshLog();
    log.emit("system", "system.boot", [], {});
    expect(log.summary().timeSpanMs).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Integration: EscrowProtocol emits events
// ---------------------------------------------------------------------------

describe("Integration: EscrowProtocol emits events", () => {
  it("emits escrow.locked and escrow.settled on a successful trade", async () => {
    const log = freshLog();
    const ledger = new Ledger();
    const protocol = new EscrowProtocol(undefined, undefined, log);

    const sellerId = toAgentId("seller-escrow-test");
    const buyerId = toAgentId("buyer-escrow-test");
    ledger.register(sellerId, 0);
    ledger.register(buyerId, 100);

    const itemContent = "test-data";
    const contentHash = createHash("sha256").update(itemContent).digest("hex");

    // Minimal mock seller: responds OFFER → then DELIVER after COMMIT
    const seller = {
      id: sellerId,
      send: async (msg: Message): Promise<Message | null> => {
        if (msg.type === MessageType.HELLO) {
          return createMessage<OfferPayload>({
            from: sellerId,
            to: buyerId,
            type: MessageType.OFFER,
            payload: { itemId: "item-1", itemDescription: "Test item", price: 10, currency: "CREDITS" },
          });
        }
        if (msg.type === MessageType.COMMIT) {
          return createMessage<DeliverPayload>({
            from: sellerId,
            to: buyerId,
            type: MessageType.DELIVER,
            payload: { itemId: "item-1", contentHash, content: itemContent },
          });
        }
        return null;
      },
    };

    // Minimal mock buyer: ACCEPT on first offer → VERIFY=true
    const buyer = {
      id: buyerId,
      send: async (msg: Message): Promise<Message | null> => {
        if (msg.type === MessageType.OFFER) {
          const p = msg.payload as OfferPayload;
          return createMessage<AcceptPayload>({
            from: buyerId,
            to: sellerId,
            type: MessageType.ACCEPT,
            payload: { acceptedOfferId: msg.id, agreedPrice: p.price },
          });
        }
        if (msg.type === MessageType.DELIVER) {
          return createMessage<VerifyPayload>({
            from: buyerId,
            to: sellerId,
            type: MessageType.VERIFY,
            payload: { deliveryMessageId: msg.id, verified: true },
          });
        }
        return null;
      },
    };

    const outcome = await protocol.run(seller, buyer, ledger);
    expect(outcome.result).toBe("SUCCESS");

    const events = log.getAll();
    const eventNames = events.map((e) => e.event);
    expect(eventNames).toContain("escrow.locked");
    expect(eventNames).toContain("escrow.released");
    expect(eventNames).toContain("escrow.settled");
  });
});

// ---------------------------------------------------------------------------
// Integration: ReputationStore emits events
// ---------------------------------------------------------------------------

describe("Integration: ReputationStore emits events", () => {
  it("emits reputation.success on recordSuccess", () => {
    const log = freshLog();
    const store = new ReputationStore(log);
    store.recordSuccess(ALICE);

    const events = log.query({ event: "reputation.success" });
    expect(events).toHaveLength(1);
    expect(events[0]?.agentIds).toContain(ALICE);
    expect(typeof events[0]?.data["score"]).toBe("number");
  });

  it("emits reputation.failure on recordFailure", () => {
    const log = freshLog();
    const store = new ReputationStore(log);
    store.recordFailure(BOB);

    const events = log.query({ event: "reputation.failure" });
    expect(events).toHaveLength(1);
    expect(events[0]?.agentIds).toContain(BOB);
  });
});

// ---------------------------------------------------------------------------
// Integration: auction scenario emits events
// ---------------------------------------------------------------------------

describe("Integration: auction scenario emits events", () => {
  it("emits auction.started, auction.bid, auction.winner, auction.settled on success", async () => {
    const log = freshLog();
    const outcome = await runAuction({ eventLog: log });

    const names = log.getAll().map((e) => e.event);
    expect(names).toContain("auction.started");
    expect(names).toContain("auction.bid");
    // A standard first-price run with default config should settle
    if (outcome.tradeOutcome.result === "SUCCESS") {
      expect(names).toContain("auction.winner");
      expect(names).toContain("auction.settled");
    }
  });

  it("emits auction.no_winner when no bids clear the reserve", async () => {
    const log = freshLog();
    // All budgets below reserve → no valid bids
    await runAuction({
      bidderCount: 2,
      reservePrice: 100,
      bidderBudgets: [5, 5],
      bidderValuations: [4, 4],
      bidAggressiveness: [1.0, 1.0],
      eventLog: log,
    });

    const names = log.getAll().map((e) => e.event);
    expect(names).toContain("auction.no_winner");
  });
});
