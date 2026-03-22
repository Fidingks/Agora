/**
 * Event logging / observability system — immutable infrastructure layer.
 *
 * Records every meaningful action in the system: trades, negotiations,
 * escrow state transitions, reputation changes, evolution decisions.
 *
 * Design choices:
 *  - EventLog is injectable — pass it as an optional parameter; never required.
 *  - Global singleton (globalLog) available for convenience.
 *  - Zero overhead when no listeners are attached and nothing queries the log.
 *  - All write operations are synchronous; the log is append-only.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EventCategory =
  | "negotiation"
  | "escrow"
  | "reputation"
  | "auction"
  | "evolution"
  | "system";

export interface AgentEvent {
  readonly timestamp: number;
  readonly category: EventCategory;
  /** Dot-namespaced event name, e.g. "escrow.locked", "auction.bid". */
  readonly event: string;
  /** IDs of every agent involved in the event. */
  readonly agentIds: string[];
  /** Event-specific payload. */
  readonly data: Record<string, unknown>;
}

export interface EventFilter {
  category?: EventCategory;
  /** Exact match on the `event` field. */
  event?: string;
  /** Return only events where agentIds includes this value. */
  agentId?: string;
  /** Return only events with timestamp >= this value. */
  since?: number;
}

export interface EventSummary {
  totalEvents: number;
  byCategory: Record<string, number>;
  uniqueAgents: number;
  timeSpanMs: number;
}

// ---------------------------------------------------------------------------
// EventLog
// ---------------------------------------------------------------------------

export class EventLog {
  private readonly _events: AgentEvent[] = [];
  private readonly _listeners: ((event: AgentEvent) => void)[] = [];

  // ------------------------------------------------------------------
  // Write
  // ------------------------------------------------------------------

  /**
   * Append a new event and notify all registered listeners.
   */
  emit(
    category: EventCategory,
    event: string,
    agentIds: string[],
    data: Record<string, unknown> = {}
  ): void {
    const e: AgentEvent = {
      timestamp: Date.now(),
      category,
      event,
      agentIds,
      data,
    };
    this._events.push(e);

    // Notify listeners (synchronous — no async here to keep the hot path cheap).
    for (const listener of this._listeners) {
      listener(e);
    }
  }

  // ------------------------------------------------------------------
  // Subscribe
  // ------------------------------------------------------------------

  /**
   * Register a listener that is called on every future `emit`.
   * Returns an unsubscribe function.
   */
  on(listener: (event: AgentEvent) => void): () => void {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) {
        this._listeners.splice(idx, 1);
      }
    };
  }

  // ------------------------------------------------------------------
  // Read
  // ------------------------------------------------------------------

  /**
   * Return all events that match the given filter (all fields are optional).
   * Returns a new array; mutations do not affect the internal store.
   */
  query(filter: EventFilter = {}): AgentEvent[] {
    return this._events.filter((e) => {
      if (filter.category !== undefined && e.category !== filter.category) return false;
      if (filter.event !== undefined && e.event !== filter.event) return false;
      if (filter.agentId !== undefined && !e.agentIds.includes(filter.agentId)) return false;
      if (filter.since !== undefined && e.timestamp < filter.since) return false;
      return true;
    });
  }

  /** Return a shallow copy of all events. */
  getAll(): AgentEvent[] {
    return [...this._events];
  }

  /** Remove all stored events. Does NOT remove listeners. */
  clear(): void {
    this._events.length = 0;
  }

  /** Number of stored events. */
  size(): number {
    return this._events.length;
  }

  // ------------------------------------------------------------------
  // Formatted output
  // ------------------------------------------------------------------

  /**
   * Human-readable fixed-width table suitable for console output.
   *
   * Example:
   *   TIMESTAMP            CATEGORY     EVENT                  AGENTS
   *   ─────────────────    ──────────   ─────────────────────  ──────────────────
   *   2024-01-01T00:00:00  escrow       escrow.locked          agent-1, agent-2
   */
  toTable(): string {
    if (this._events.length === 0) {
      return "(no events)";
    }

    const COL_TS = 24;
    const COL_CAT = 14;
    const COL_EVT = 30;

    const pad = (s: string, n: number) => s.slice(0, n).padEnd(n);

    const header =
      pad("TIMESTAMP", COL_TS) +
      pad("CATEGORY", COL_CAT) +
      pad("EVENT", COL_EVT) +
      "AGENTS";

    const divider =
      "─".repeat(COL_TS - 1) +
      " " +
      "─".repeat(COL_CAT - 1) +
      " " +
      "─".repeat(COL_EVT - 1) +
      " " +
      "─".repeat(20);

    const rows = this._events.map((e) => {
      const ts = new Date(e.timestamp).toISOString().replace("T", " ").replace("Z", "");
      const agents = e.agentIds.join(", ");
      return pad(ts, COL_TS) + pad(e.category, COL_CAT) + pad(e.event, COL_EVT) + agents;
    });

    return [header, divider, ...rows].join("\n");
  }

  /**
   * JSON export — returns a pretty-printed JSON string.
   */
  toJSON(): string {
    return JSON.stringify(this._events, null, 2);
  }

  /**
   * TSV export — tab-separated values, suitable for spreadsheets.
   * Header: timestamp\tcategory\tevent\tagentIds\tdata
   */
  toTSV(): string {
    const header = "timestamp\tcategory\tevent\tagentIds\tdata";
    const rows = this._events.map((e) => {
      const agents = e.agentIds.join(",");
      const data = JSON.stringify(e.data).replace(/\t/g, " ");
      return [e.timestamp, e.category, e.event, agents, data].join("\t");
    });
    return [header, ...rows].join("\n");
  }

  // ------------------------------------------------------------------
  // Stats
  // ------------------------------------------------------------------

  /**
   * Compute summary statistics over all stored events.
   */
  summary(): EventSummary {
    const total = this._events.length;

    const byCategory: Record<string, number> = {};
    const agentSet = new Set<string>();
    let minTs = Infinity;
    let maxTs = -Infinity;

    for (const e of this._events) {
      byCategory[e.category] = (byCategory[e.category] ?? 0) + 1;
      for (const id of e.agentIds) {
        agentSet.add(id);
      }
      if (e.timestamp < minTs) minTs = e.timestamp;
      if (e.timestamp > maxTs) maxTs = e.timestamp;
    }

    const timeSpanMs = total === 0 ? 0 : maxTs - minTs;

    return {
      totalEvents: total,
      byCategory,
      uniqueAgents: agentSet.size,
      timeSpanMs,
    };
  }
}

// ---------------------------------------------------------------------------
// Global singleton — convenient when you don't want to pass an instance around.
// ---------------------------------------------------------------------------

export const globalLog = new EventLog();
