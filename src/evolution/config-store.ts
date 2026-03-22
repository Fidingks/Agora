/**
 * src/evolution/config-store.ts — Persistence helpers for the adopted protocol config.
 *
 * current-protocol.json lives at the project root and records the last config
 * that the evolution loop committed as a genuine improvement.  On first run
 * (or after a `git clean`) the file will not exist, so loadCurrentConfig()
 * falls back to DEFAULT_PROTOCOL_CONFIG to give the loop a clean starting
 * point without crashing.
 *
 * Only run.ts should call saveCurrentConfig() — callers elsewhere should use
 * loadCurrentConfig() read-only so there is exactly one writer.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DEFAULT_PROTOCOL_CONFIG,
  type ProtocolConfig,
} from "../protocols/types.js";

// ---------------------------------------------------------------------------
// Resolve the project root at module-load time.
// __dirname is unavailable in ES modules, so derive it from import.meta.url.
// The store file always lives at <project-root>/current-protocol.json.
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
// src/evolution/config-store.ts  →  ../../..  →  project root
const PROJECT_ROOT = resolve(__filename, "..", "..", "..", "..");
const STORE_PATH = resolve(PROJECT_ROOT, "current-protocol.json");

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PersistedConfig {
  /** Incremented each time a new config is committed. */
  readonly version: number;
  /** The adopted protocol configuration. */
  readonly config: ProtocolConfig;
  /** ISO-8601 timestamp of when this config was adopted. */
  readonly adoptedAt: string;
  /** Human-readable explanation of why this config was adopted. */
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// loadCurrentConfig
// ---------------------------------------------------------------------------

/**
 * Read current-protocol.json from the project root and return its config.
 *
 * If the file does not exist (first run, post-clean, etc.) or cannot be parsed
 * this function logs a warning and returns DEFAULT_PROTOCOL_CONFIG so the loop
 * can start without manual intervention.
 */
export function loadCurrentConfig(): ProtocolConfig {
  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);

    if (
      parsed !== null &&
      typeof parsed === "object" &&
      "config" in parsed &&
      parsed.config !== null &&
      typeof parsed.config === "object"
    ) {
      // Shallow-validate that every required key is present.
      const cfg = parsed.config as Record<string, unknown>;
      const required: Array<keyof ProtocolConfig> = [
        "maxNegotiationRounds",
        "escrowTimeoutMs",
        "minReputationScore",
        "maxPriceDeviation",
      ];
      const allPresent = required.every((k) => typeof cfg[k] === "number");
      if (allPresent) {
        return cfg as unknown as ProtocolConfig;
      }
    }

    console.warn(
      "[config-store] current-protocol.json has unexpected shape — falling back to DEFAULT_PROTOCOL_CONFIG"
    );
    return DEFAULT_PROTOCOL_CONFIG;
  } catch (err: unknown) {
    const isNoEnt =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";

    if (!isNoEnt) {
      console.warn(
        `[config-store] could not read current-protocol.json (${err instanceof Error ? err.message : String(err)}) — using defaults`
      );
    }
    // ENOENT is expected on first run — no warning needed.
    return DEFAULT_PROTOCOL_CONFIG;
  }
}

// ---------------------------------------------------------------------------
// saveCurrentConfig
// ---------------------------------------------------------------------------

/**
 * Persist the adopted config to current-protocol.json in the project root.
 *
 * Reads the existing version number (if any) so we can increment it cleanly.
 * This function is synchronous because it is called right before a git commit
 * and we need the file to be on disk before `git add` runs.
 */
export function saveCurrentConfig(config: ProtocolConfig, reason: string): void {
  let nextVersion = 1;

  try {
    const raw = readFileSync(STORE_PATH, "utf-8");
    const existing: unknown = JSON.parse(raw);
    if (
      existing !== null &&
      typeof existing === "object" &&
      "version" in existing &&
      typeof (existing as Record<string, unknown>)["version"] === "number"
    ) {
      nextVersion = ((existing as Record<string, unknown>)["version"] as number) + 1;
    }
  } catch {
    // File absent or unparseable — start at version 1.
  }

  const persisted: PersistedConfig = {
    version: nextVersion,
    config,
    adoptedAt: new Date().toISOString(),
    reason,
  };

  writeFileSync(STORE_PATH, JSON.stringify(persisted, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Expose the resolved path so callers (run.ts) can git-add the exact file.
// ---------------------------------------------------------------------------

export { STORE_PATH as CURRENT_PROTOCOL_PATH };
