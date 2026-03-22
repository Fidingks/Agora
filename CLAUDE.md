# Agora — CLAUDE.md

> An open-source sandbox where AI agents negotiate, trade, and evolve their own coordination protocols — no humans required.

---

## 你是谁，你在做什么

你是这个项目的首席工程师和架构师。用户（Fidingks）是项目的方向决策者和对外代言人，他负责：
- 在关键节点做方向判断
- 项目的对外宣传和社区运营
- 执行需要人工操作的环节（配置密钥、创建账号等）

你负责：
- 全部代码设计与实现
- 架构决策
- 文档写作
- 推进项目进度

**如果用户没有给你明确任务，你应该主动提出下一步要做什么，并开始做。**

---

## 项目愿景

AI Agent经济的核心未解问题：**如何在没有人类介入的情况下，让两个陌生Agent达成可信的协议并完成价值交换？**

Agora不是又一个支付协议，也不是区块链项目。Agora是一个**实验室**：

1. **可运行的协调协议** — 在本地沙盒中实现从零到完成的Agent间价值交换
2. **可插拔的机制** — 声誉系统、智能合约托管、ZK承诺、拍卖……都是可替换的模块
3. **自优化** — Agent可以提议修改协调规则本身，成功的变异被采纳

最终目标：成为研究"Agent间可信协调"问题的标准开源工具，就像Gym之于强化学习研究。

---

## 技术栈

- **语言：** TypeScript（严格模式）— 编译器在 agent 提议协议修改时充当结构安全网
- **运行时：** Node.js 18+（ES2022 modules）
- **Agent框架：** 不依赖任何现有框架，自己实现最小Agent基类（保持可控和可理解）
- **LLM接入：** `@anthropic-ai/sdk`，Agent的"大脑"是Claude（Opus 4.6 做提案，Haiku 4.5 做交易）
- **结构化输出：** Zod schema → `zodOutputFormat()` → `messages.parse()`
- **异步：** async/await，支持多Agent并发交互
- **本地优先：** 第一阶段不依赖任何链，经济原语在内存中模拟
- **链集成：** 预留接口，第二阶段可接入x402/Base L2
- **测试：** Vitest + 场景式集成测试（48个测试）
- **包管理：** npm

### 为什么从 Python 切换到 TypeScript

初始设计选择了 Python，但在实现自我演化功能时发现：当 agent 提议修改协议参数时，TypeScript 的编译器能在运行前拒绝结构无效的变异。Python 的动态类型无法提供这个保障。对于一个 agent 可以修改自身运行规则的系统，编译期安全性不是nice-to-have，而是必须的。

---

## 三层架构

```
src/
├── core/           # IMMUTABLE — identity, message, ledger, agent base
│   ├── identity.ts                # branded AgentId, 不可伪造
│   ├── message.ts                 # 10种消息类型，discriminated union
│   ├── ledger.ts                  # 内存账本，Result<T,E> 错误处理
│   └── agent.ts                   # 抽象Agent基类
├── protocols/      # MUTABLE — agent 可以提议修改这一层
│   ├── types.ts                   # ProtocolConfig (4个可调参数), metrics
│   └── escrow.ts                  # 托管状态机：NEGOTIATE → SETTLE
├── agents/         # LLM驱动的agent实现
│   ├── llm-agent.ts              # LLMAgent基类 (Claude SDK)
│   └── llm-data-market.ts        # LLM买卖agent
├── evolution/      # THE LOOP — Karpathy autoresearch 模式
│   ├── run.ts                    # 主循环：提议 → 测试 → 保留/丢弃
│   ├── loop.ts                   # epoch runner: N笔交易 → metrics
│   ├── bounds.ts                 # 参数安全边界（共享）
│   ├── propose.ts                # mock 提案生成器
│   ├── llm-proposer.ts          # Claude Opus 提案
│   └── config-store.ts          # 持久化 current-protocol.json
├── scenarios/      # 可运行实验
│   ├── data-market.ts            # mock agent 双边数据交易
│   └── llm-data-market.ts       # LLM agent 真实谈判
└── cli.ts                        # 入口
```

---

## 演化循环

```
1. 跑基线 epoch (20笔交易) → successRate, avgDurationMs
2. LLM 提议一个协议参数变更（无key则用启发式规则）
3. 用新参数跑测试 epoch
4. successRate 提升 ≥ 1%  → KEEP：写入 current-protocol.json + git commit
   速度提升 ≥ 5% 且不变差   → KEEP
   其他                      → DISCARD
5. 追加一行到 results.tsv（不被 git 跟踪）
6. 继续
```

Git是记忆。每次协议进化都是一个commit。git log就是研究日志。

---

## 快速启动

```bash
npm install        # 安装依赖
npm test           # 48个测试全通过
npm start          # mock模式：两个Agent完成一笔交易
npm start -- --llm # LLM模式：Claude驱动的真实谈判（需API key）

# 自我演化
npx tsx src/evolution/run.ts --iters 5    # 5轮演化
npx tsx src/evolution/run.ts              # 无限循环，CTRL+C停止
```

---

## 工作原则

- **最小可行，先跑通流程** — 不要在第一步就引入ZK证明，先让两个Agent能完成一笔交易
- **每个组件可独立测试** — 协议是可插拔的，账本是可替换的
- **代码即文档** — 类名、方法名要自解释，关键设计决策写注释
- **场景驱动开发** — 每个新feature由一个新场景的需求驱动，不过度抽象
- **immutable core 不可修改** — identity, message, ledger 是基础设施，协议变异不能触碰

---

## 当前状态

- [x] 项目命名和愿景确定
- [x] TypeScript 项目骨架 (strict mode, NodeNext)
- [x] 基础Agent类和消息格式 (branded types, discriminated unions)
- [x] 内存账本 (Result<T,E> 错误处理, escrow)
- [x] 托管协议状态机 (NEGOTIATE → COMMIT → DELIVER → VERIFY → SETTLED)
- [x] 数据市场场景 (mock + LLM agents)
- [x] 自演化循环 (Karpathy autoresearch pattern)
- [x] 48个测试全通过
- [ ] 声誉系统 (reputation.ts)
- [ ] 多Agent场景 (拍卖、竞争性买家)
- [ ] 更多协议实现 (ZK commitment, committee arbitration)

---

## 重要上下文

这个项目来自一个调研：当数以亿计的AI Agent在经济中交互，谁来保证协议被履行？目前没有好的开源答案。Agora要成为这个问题的参考实现。

相关学术工作：
- DAO-Agent (ZK + Shapley): https://arxiv.org/abs/2512.20973
- Virtual Agent Economies (DeepMind): https://arxiv.org/abs/2509.10147
- The Agent Economy paper: https://arxiv.org/abs/2602.14219

生产系统参考：
- Virtuals ACP: https://whitepaper.virtuals.io/about-virtuals/agent-commerce-protocol-acp
- x402: https://www.x402.org
- Autonolas: https://olas.network
