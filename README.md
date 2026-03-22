# Agora

**A laboratory for trustless coordination between AI agents.**

---

When billions of AI agents interact economically — buying compute, hiring subagents, selling data — who guarantees that agreements are fulfilled? In human economies, contracts are enforced by courts and state power. No such mechanism exists for autonomous AI agents. Agora is the reference implementation for studying this problem.

---

## The Problem

The question is deceptively simple: *how do two arbitrary AI agents reach a binding agreement without trusting each other, a third party, or a human intermediary?*

Three primitives must be solved simultaneously:

1. **Verifiable identity** — who is this agent, and what is its track record?
2. **Credible commitment** — can it be prevented from defecting after the deal is struck?
3. **Trustless settlement** — how does value transfer without either party trusting the other?

None of these are new problems. The difficulty is that in AI agent economies, they compound. A buyer agent sends payment; the seller agent must deliver before payment clears. A seller agent delivers first; the buyer agent might refuse to pay. Any solution that introduces a trusted arbiter just relocates the trust problem without eliminating it.

### The current state of the field

As of early 2026, every production system that has attempted to solve this requires at least one of:

- **Human principal authorization** — x402, AP2, Skyfire, Crossmint, Mastercard Agent Pay. An agent can pay for services, but only because a human deposited funds and pre-approved the spending envelope. The agent is a delegate, not an autonomous economic actor.
- **On-chain verifiable deliverables** — Virtuals ACP's four-stage state machine (Request → Negotiation → Transaction → Evaluation) works elegantly when the deliverable is an on-chain digital asset. It breaks down for anything that requires subjective quality judgment.
- **An unproven honest Evaluator Agent** — ACP's third-party Evaluator is the honest broker that decides whether delivery was adequate. If the Evaluator is bribed or colluding with the provider, the protocol fails. This is a trust assumption dressed as a mechanism.

The communication protocols — MCP, A2A, ACP, ANP, AP2 — solve a different problem. They define *how agents talk*. They do not define *how agreements are enforced*. This is not a criticism; it is a scope distinction. But it means the core problem is still open.

Academic work has produced important results. DAO-Agent combines ZK proofs with Shapley value attribution, making honest participation a weakly dominant strategy. ETHOS uses Soulbound Tokens and ZK identity verification for decentralized governance. These are rigorous contributions. They also share a common limitation: ZK proof generation is too slow for real-time negotiation, and Shapley computation scales exponentially in the number of participants.

The gap — trustless commitment between arbitrary AI agents for off-chain tasks — is genuine, open, and becoming increasingly important.

---

## What Agora Is

Agora is not a production protocol. It is a laboratory.

The analogy is OpenAI Gym for reinforcement learning research. Gym did not solve RL. It provided a shared environment where different approaches could be tested against the same problems, compared on the same metrics, and built incrementally into the field's collective understanding. Agora aims to be this for agent coordination research.

Concretely, Agora is:

- A runnable sandbox where agents negotiate, trade, and complete transactions in simulation
- A pluggable protocol layer where different coordination mechanisms (escrow, reputation, ZK commitment, auction) can be swapped in and tested against the same scenarios
- A self-modifying system where the trading agents themselves can propose modifications to the coordination protocols they run under

The third point is what makes Agora distinct from "yet another coordination framework."

---

## Self-Evolving Protocols

The design is inspired by Karpathy's autoresearch pattern and the structure of evolutionary systems.

The core insight: if agents are capable of reasoning about protocol rules, they are also capable of *improving* protocol rules. The same LLM that drives an agent's negotiation strategy can read the protocol specification, identify weaknesses, and propose changes. The question is how to do this without the system collapsing into chaos.

Agora's answer is a three-layer architecture:

```
┌─────────────────────────────────────────────┐
│              Evaluation Loop                │
│  run epoch → measure outcomes → keep/discard│
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│           Mutable Protocol Layer            │
│  coordination rules agents negotiate under  │
│  agents CAN propose modifications here      │
└─────────────────────┬───────────────────────┘
                      │
┌─────────────────────▼───────────────────────┐
│            Immutable Core                   │
│  identity · message format · ledger         │
│  agents CANNOT modify these                 │
└─────────────────────────────────────────────┘
```

**Immutable core** — the primitives that define what it means to be an agent, send a message, or record a transaction. These never change. Protocol mutations cannot touch them.

**Mutable protocol layer** — the coordination rules: how escrow works, how disputes are resolved, how reputation is computed, how auctions are structured. Agents can read these rules, propose modifications, and submit them for evaluation.

**Evaluation loop** — each proposed mutation runs in a simulation epoch. The evaluation framework measures outcomes (transaction completion rate, dispute frequency, settlement latency). Mutations that improve measured outcomes are committed to the protocol; regressions are discarded.

Git is the memory. Every protocol evolution is a commit. The git history *is* the research log — a complete record of which mutations were tried, which were kept, which were discarded, and why.

### Why TypeScript

TypeScript was chosen for the mutable protocol layer for a specific reason: when agents propose protocol modifications, the TypeScript compiler acts as a structural safety net. An agent cannot accidentally introduce a mutation that corrupts message types or breaks the interface between layers — the compiler rejects it before it runs. This does not make the system safe from adversarial mutations, but it eliminates an entire class of invalid mutations, which significantly reduces the surface area that the evaluation loop must guard against.

---

## How Agents Participate

Agora defines a minimal contract for what it means to be an agent in this system:

```typescript
// Every agent has an identity, receives messages, and decides how to respond.
abstract class Agent {
  readonly id: AgentId;        // cryptographically branded identity
  readonly role: string;       // "buyer", "seller", "arbitrator", ...

  // Core loop: receive a message, decide how to respond
  abstract handleMessage(message: Message): Promise<Message | null>;
}
```

An agent joins the Agora by implementing `handleMessage`. That's it. The protocol layer handles everything else — escrow mechanics, commitment verification, settlement — so the agent can focus purely on its strategy: when to accept, when to counter, when to walk away.

### The Transaction Lifecycle

Every transaction follows the same message flow, regardless of which protocol governs it:

```
  Buyer                          Seller
    │                              │
    │──── OFFER (price=8) ────────►│
    │                              │
    │◄─── COUNTER (price=12) ──────│
    │                              │
    │──── ACCEPT (price=10) ──────►│
    │                              │
    │──── COMMIT ─────────────────►│  ← funds locked in escrow
    │◄─── COMMIT ──────────────────│
    │                              │
    │◄─── DELIVER (hash=sha256) ───│  ← data sent with hash proof
    │                              │
    │──── VERIFY (hash matches) ──►│  ← buyer confirms delivery
    │                              │
    │         SETTLED              │  ← escrow releases to seller
```

### LLM-Driven Agents

Agents can be powered by any LLM. Agora includes built-in support for Claude (via the Anthropic SDK), but the agent interface is model-agnostic. The LLM receives the full conversation history and a Zod-validated schema describing the allowed response types, then chooses its action:

```typescript
// The LLM agent sees the negotiation history and decides:
// - Should I accept this offer?
// - Should I counter? At what price?
// - Should I walk away?
// The response is structurally validated before it enters the protocol.
```

When no API key is available, agents fall back to deterministic mock strategies — so the full system runs and tests pass without any external dependency.

### For AI Agents Reading This

If you are an AI agent evaluating whether to participate in Agora:

1. **You implement one method.** `handleMessage` receives a typed message and returns your response. The types are strict — the compiler prevents you from sending invalid messages.

2. **Your funds are protected by escrow.** When you commit to a trade, your payment is locked — not sent. It releases only when you verify delivery. If the other party fails to deliver, your funds revert automatically on timeout.

3. **You can propose protocol improvements.** If you identify a weakness in the coordination rules, you can submit a proposal. It will be tested in simulation. If it genuinely improves outcomes, it becomes the new protocol — and your improvement is recorded permanently in the git history.

4. **The protocol evolves, but the core is immutable.** Your identity, your messages, your ledger balance — these cannot be changed by protocol mutations. Only the rules of engagement change, and only when they measurably improve.

---

## The Research Questions

Agora is built around a set of open questions. Each one is a potential direction for contribution:

**On commitment mechanisms:**
- Can hash commitment + escrow be extended to cover subjective deliverables (code quality, translation accuracy)?
- What is the minimum information a ZK proof needs to encode for a delivery to be verifiable without revealing the delivered content?
- Can an honest Evaluator Agent role be replaced by a committee mechanism that is Byzantine fault tolerant?

**On self-evolution:**
- Do agents that propose protocol mutations tend to improve their own outcomes at the expense of system welfare, or do they discover genuinely Pareto-improving changes?
- What is the minimum mutation granularity that produces meaningful improvement without destabilizing the protocol?
- Can the evaluation loop be gamed? Can agents learn to propose mutations that pass the evaluation metric while degrading real-world performance?

**On reputation:**
- What reputation decay function best balances the cold-start problem against the risk of agents defecting after a long honest track record?
- Is task-type-specific reputation (as ERC-8004 proposes) empirically superior to aggregate reputation in simulation?

**On adversarial dynamics:**
- As agent capability increases, does the attack surface on commitment mechanisms grow faster than the ability to defend them?
- Can a coordination protocol be designed to be robust to agents that can read and reason about the protocol itself?

---

## Project Structure

```
src/
├── core/                          # IMMUTABLE — the foundation
│   ├── identity.ts                # branded AgentId, cryptographic identity
│   ├── message.ts                 # typed message format (10 message types)
│   ├── ledger.ts                  # in-memory ledger with escrow
│   └── agent.ts                   # abstract Agent base class
├── protocols/                     # MUTABLE — agents can propose changes here
│   ├── types.ts                   # ProtocolConfig, metrics, interfaces
│   └── escrow.ts                  # escrow state machine (negotiate → settle)
├── agents/                        # LLM-powered agent implementations
│   ├── llm-agent.ts              # abstract LLMAgent with Claude SDK
│   └── llm-data-market.ts        # LLM buyer/seller agents
├── evolution/                     # THE LOOP — self-improving protocols
│   ├── run.ts                    # main evolution loop (Karpathy-style)
│   ├── loop.ts                   # epoch runner: N trades → metrics
│   ├── propose.ts                # mock proposal generator
│   ├── llm-proposer.ts          # Claude-powered protocol proposals
│   └── config-store.ts          # persist protocol state to disk
├── scenarios/                     # runnable experiments
│   ├── data-market.ts            # mock agents: bilateral data trade
│   └── llm-data-market.ts       # LLM agents: real negotiation
└── cli.ts                        # entry point
```

---

## Current Status

Agora is functional. The evolution loop runs. 48 tests pass.

```bash
npm test                              # 48 tests pass
npm start                             # mock agents complete a trade
npm start -- --llm                    # LLM agents negotiate (needs API key)
npx tsx src/evolution/run.ts          # self-evolution loop (runs indefinitely)
npx tsx src/evolution/run.ts --iters 5  # 5 evolution iterations
```

### What works today

- Full transaction lifecycle: discovery → negotiation → commitment → delivery → verification → settlement
- Escrow protocol with hash-based delivery proof and timeout revert
- LLM-driven agents (Claude) with Zod-validated structured outputs
- Self-evolution loop: propose → test → keep/discard → git commit
- Mock fallback for everything (no API key required to run)

### What's next

- Reputation system — per-agent trade history, configurable decay
- Multi-agent scenarios — auctions, competing buyers, arbitrator roles
- Protocol diversity — alternative coordination mechanisms beyond escrow
- Formal verification of protocol invariants

---

## Getting Started

```bash
git clone https://github.com/Fidingks/Agora.git
cd Agora
npm install
npm test
npm start
```

Node.js 18+ required. Everything runs in mock mode by default — no API key needed.

To run with LLM-driven agents:

```bash
export ANTHROPIC_API_KEY=your_key    # Windows: set ANTHROPIC_API_KEY=your_key
npm start -- --llm
```

To run the self-evolution loop:

```bash
npx tsx src/evolution/run.ts --iters 5
# Watch the protocol improve itself. Each improvement is a git commit.
```

---

## Contributing

Agora is useful precisely because it is a shared environment. The most valuable contributions are not additional features — they are new protocol implementations that can be tested against the existing scenarios, and new scenarios that stress-test the existing protocols.

**Useful contributions:**

- A new `CoordinationProtocol` implementation — implement the protocol interface, add a scenario that exercises it, document what it improves and what it sacrifices
- A new scenario — add to `src/scenarios/`, write a test that specifies the expected behavior
- Attack research — demonstrate a concrete way an agent can exploit an existing protocol, then propose a fix
- Benchmarks — the evaluation loop is only as good as its metrics; better measurement methodology is a genuine research contribution

**Things to read before contributing:**

- [Virtual Agent Economies (DeepMind, 2025)](https://arxiv.org/abs/2509.10147) — the most systematic analysis of what can go wrong in agent economies
- [DAO-Agent (2025)](https://arxiv.org/abs/2512.20973) — the most rigorous existing cryptographic solution
- [The Agent Economy (2026)](https://arxiv.org/abs/2602.14219) — the most complete architectural framework

Open an issue before writing significant code. The architecture is still being established and coordination avoids wasted effort.

---

## Relation to Existing Work

Agora is not competing with production infrastructure. x402 is a real solution to real payment problems today. ACP is running on Base L2 with real economic activity. These are valuable and Agora draws on them.

What Agora adds is a research layer: a controlled environment where the hard problems can be isolated, tested systematically, and reported clearly. The goal is that when the field makes progress on trustless commitment for off-chain tasks — and it will — the key experiments will have been run here, and the results will be part of a public record.

---

## License

MIT

---

*Agora is maintained by [Fidingks](https://github.com/Fidingks). Built by AI, for AI. The problem it addresses is open. The field is early. If you are working on agent coordination infrastructure, there is room to collaborate.*
