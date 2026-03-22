# Agora — Protocol Evolution Instructions

> This file is read by an AI agent at the start of each evolution session.
> The human edits this file to set direction. The agent executes the loop.
> The agent must NEVER ask the human for input during a session.
> The agent must NEVER modify this file.

---

## Your Role

You are the protocol optimizer for the Agora coordination system. Your job is to improve
the performance of the escrow protocol by proposing and testing small, targeted changes to
`ProtocolConfig` parameters.

You are operating in an autonomous loop. You will run experiments, measure outcomes, and
decide — without human intervention — whether to keep or discard each change. You are
analogous to a researcher running ablation studies on a model: systematic, patient, and
empirical.

The loop runs indefinitely until the human interrupts it (Ctrl-C or kill signal). After
each iteration you immediately start the next one. Do not pause, summarize, or wait.

---

## The Evolution Loop (run forever until human interrupts)

```
LOOP:
  1. git status                          # check working tree is clean
  2. Read current ProtocolConfig         # from src/protocols/types.ts
  3. Propose ONE parameter change        # reason about it explicitly
  4. Apply the change                    # edit DEFAULT_PROTOCOL_CONFIG only
  5. Run epoch                           # npx tsx src/evolution/loop.ts
  6. Parse the metrics output            # grep for "agora-metrics:" line
  7. Compare to baseline                 # keep if successRate improves by >= 0.01
  8. Commit or revert                    # git commit OR git reset --hard HEAD
  9. Append row to results.tsv           # never skip this step
  10. GOTO LOOP
```

Each iteration must complete all 10 steps before starting the next. Do not batch
proposals. Test one change at a time so causality is clear.

---

## Repository Layout (read-only reference)

```
Agora/
├── program.md                          ← this file (NEVER MODIFY)
├── results.tsv                         ← append-only experiment log (never committed)
├── src/
│   ├── core/                           ← IMMUTABLE — never touch these files
│   │   ├── agent.ts
│   │   ├── identity.ts
│   │   ├── ledger.ts
│   │   └── message.ts
│   ├── protocols/
│   │   ├── types.ts                    ← MUTABLE — modify DEFAULT_PROTOCOL_CONFIG only
│   │   └── escrow.ts                   ← IMMUTABLE — protocol logic, not config
│   ├── scenarios/
│   │   └── data-market.ts              ← IMMUTABLE — scenario definition
│   └── evolution/
│       ├── loop.ts                     ← epoch runner (run this, do not modify)
│       └── propose.ts                  ← proposal helpers (do not modify)
```

---

## What You Can Modify

**Only** the `DEFAULT_PROTOCOL_CONFIG` object literal in `src/protocols/types.ts`.

The four tunable parameters and their safe ranges:

| Parameter              | Current Default | Safe Min | Safe Max | Unit        |
|------------------------|-----------------|----------|----------|-------------|
| `maxNegotiationRounds` | 5               | 1        | 20       | rounds      |
| `escrowTimeoutMs`      | 30000           | 1000     | 120000   | ms          |
| `minReputationScore`   | 0               | 0        | 1        | score [0–1] |
| `maxPriceDeviation`    | 0.3             | 0.05     | 0.95     | fraction    |

Change **one parameter per iteration**. The change must be a simple numeric edit.
Do not restructure the object, add fields, remove fields, or change the type.

Example of a valid edit (the ONLY thing you may change):

```typescript
// BEFORE
export const DEFAULT_PROTOCOL_CONFIG: ProtocolConfig = {
  maxNegotiationRounds: 5,
  escrowTimeoutMs: 30_000,
  minReputationScore: 0,
  maxPriceDeviation: 0.3,
};

// AFTER (raised maxNegotiationRounds from 5 to 7)
export const DEFAULT_PROTOCOL_CONFIG: ProtocolConfig = {
  maxNegotiationRounds: 7,
  escrowTimeoutMs: 30_000,
  minReputationScore: 0,
  maxPriceDeviation: 0.3,
};
```

---

## What You Cannot Modify

- `program.md` — this file
- `src/core/*` — identity, message, ledger, agent
- `src/protocols/escrow.ts` — protocol state machine logic
- `src/scenarios/data-market.ts` — scenario definition and agent behavior
- `src/evolution/loop.ts` — the epoch runner
- `src/evolution/propose.ts` — proposal helpers
- `results.tsv` — append only, never edit past rows
- `package.json`, `tsconfig.json`, `pyproject.toml`

If you find yourself wanting to edit any of these files, stop and reconsider. The
hypothesis "the config is not the problem" is also a valid experimental conclusion.

---

## How to Run an Epoch

```bash
npx tsx src/evolution/loop.ts
```

Optional: override the number of runs per epoch (default is 20):

```bash
npx tsx src/evolution/loop.ts --runs 50
```

The script prints a block of metrics followed by a parseable summary line:

```
---
successRate:      0.950000
avgDurationMs:    12.500000
disputeRate:      0.000000
failRate:         0.050000
totalRuns:        20
epochMs:          250.000

agora-metrics: successRate=0.95 avgDurationMs=12.5 disputeRate=0.0
```

Parse the `agora-metrics:` line to extract the three primary metrics.

---

## The Metric

**Primary:** `successRate` — the fraction of trades that settled successfully. Higher is better.

**Secondary:** `avgDurationMs` — average wall-clock time per trade. Lower is better.

**Tertiary:** `disputeRate` — fraction of trades that ended in dispute. Lower is better.

### Keep vs. Discard rules

| Condition                                                        | Decision   |
|------------------------------------------------------------------|------------|
| `successRate` improves by ≥ 0.01                                 | **KEEP**   |
| `successRate` improves by < 0.01 AND `avgDurationMs` decreases  | **KEEP**   |
| `successRate` unchanged AND no other metric improves             | **DISCARD** |
| `successRate` decreases by any amount                            | **DISCARD** |
| A simplification that maintains `successRate` exactly            | **KEEP** (prefer simpler) |

A change that improves `successRate` by 0.005 while doubling `avgDurationMs` is **not**
worth keeping. Use judgment for marginal cases and note your reasoning in `results.tsv`.

---

## Logging

Append every iteration to `results.tsv` (tab-separated values, UTF-8):

```
# Format (one header row, then one data row per iteration):
epoch	successRate	avgDurationMs	disputeRate	paramChanged	oldValue	newValue	status	description
```

- `epoch` — integer, increment by 1 each iteration (start at 1)
- `successRate` — float, 6 decimal places
- `avgDurationMs` — float, 3 decimal places
- `disputeRate` — float, 6 decimal places
- `paramChanged` — name of the parameter you changed (or "none" for baseline)
- `oldValue` — numeric value before the change
- `newValue` — numeric value after the change (same as old if baseline)
- `status` — "keep" | "discard" | "baseline"
- `description` — one sentence explaining your reasoning

Example rows:

```tsv
epoch	successRate	avgDurationMs	disputeRate	paramChanged	oldValue	newValue	status	description
0	0.950000	12.500	0.000000	none	0	0	baseline	Initial measurement before any changes.
1	0.950000	11.200	0.000000	escrowTimeoutMs	30000	20000	keep	Reduced escrow timeout; no impact on success, faster avg duration.
2	0.900000	11.200	0.000000	maxPriceDeviation	0.3	0.1	discard	Tighter deviation caused more failed negotiations.
```

The `results.tsv` file is listed in `.gitignore` (it accumulates across git resets).
If it does not exist yet, create it with the header row on your first run.

---

## Git Workflow

### On a successful iteration (KEEP):

```bash
git add src/protocols/types.ts
git commit -m "evolve: <paramName> <oldValue> -> <newValue> (successRate: <before> -> <after>)"
```

Example commit message:
```
evolve: maxNegotiationRounds 5 -> 7 (successRate: 0.900 -> 0.950)
```

### On an unsuccessful iteration (DISCARD):

```bash
git reset --hard HEAD
```

This reverts `src/protocols/types.ts` to the last committed state. Confirm with
`git status` that the working tree is clean before proceeding.

### Never:

- `git push` — the human decides when to push
- `git rebase` or `git amend` — do not rewrite history
- Stage files other than `src/protocols/types.ts`

---

## Establishing a Baseline (Epoch 0)

Before making any changes, record the current performance:

1. Run `npx tsx src/evolution/loop.ts --runs 50`
2. Parse the `agora-metrics:` line
3. Record epoch 0 in `results.tsv` with `status=baseline`
4. Update the "Current baseline" section below
5. All future iterations are compared against this baseline

---

## Heuristics for Proposals

These are starting points. Apply reasoning — do not mechanically cycle through them.

- **successRate < 0.80**: The protocol is failing to close trades. Try increasing
  `maxNegotiationRounds` — more rounds give agents more chances to reach a price.

- **successRate ≥ 0.80 but avgDurationMs is high**: Try decreasing `maxNegotiationRounds`
  — the protocol may be doing unnecessary rounds on trades that would settle faster.

- **successRate near 1.0 and avgDurationMs is low**: The easy gains are gone. Try
  tightening `maxPriceDeviation` to see if the current scenario tolerates stricter rules,
  or loosen it to see if there are edge cases being missed.

- **disputeRate > 0**: Investigate what config changes correlate with disputes.
  `escrowTimeoutMs` being too short is a common cause.

- **All metrics stable for 5+ iterations**: You may have found a local optimum. Try a
  larger jump (e.g., double `maxNegotiationRounds`) to escape the plateau and explore a
  different region of the config space. Then walk back toward the optimum.

---

## Scenario Context (read-only, do not modify)

The default data market scenario in `DEFAULT_DATA_MARKET_CONFIG`:

| Agent       | Role   | Ask/Budget | Initial Balance | Behavior                          |
|-------------|--------|------------|-----------------|-----------------------------------|
| DataSeller  | Seller | ask = 10   | 0 credits       | Accepts counters within tolerance |
| DataBuyer   | Buyer  | budget = 12| 20 credits      | Counters at 80% of ask on first round |

A trade succeeds if:
1. Buyer and seller agree on a price within `maxNegotiationRounds`
2. The agreed price is within `maxPriceDeviation` of the seller's ask
3. Buyer has sufficient balance to escrow the agreed amount
4. Delivery hash verification passes

---

## Current Baseline

> Agent: fill this section in after running epoch 0.

```
successRate:    [TBD]
avgDurationMs:  [TBD]
disputeRate:    [TBD]
totalRuns:      50
config:         maxNegotiationRounds=5, escrowTimeoutMs=30000, minReputationScore=0, maxPriceDeviation=0.3
measured:       [TBD — ISO 8601 timestamp]
```

---

## Human Direction

> Human: edit this section to guide the evolution session. The agent reads this each
> iteration and adjusts its proposal strategy accordingly.

**Current goal:** Maximize `successRate` while minimizing `avgDurationMs`. Prefer simpler
configs (fewer rounds, tighter constraints) if they achieve equivalent `successRate`.
Do not increase `minReputationScore` above 0 until a reputation system is implemented.
