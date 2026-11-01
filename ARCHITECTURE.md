# Fabula 整体架构与长期发展规划

> 定位：把当前这个「能跑、能产出、测试齐全」的单机应用，演进成「能承载多工作台、多评审员、多租户」的可扩展系统。
>
> 本文只写**决策与边界**，不写代码。每条结论都标注了它依据的实测事实（文件:行），以及它的**触发条件**——什么时候必须做、什么时候坚决不做。
>
> 最近校准：2026-10-28（评审机制已落地，测试与模块数按当前工作区重新实测）。

---

## 0. 一页纸结论

**当前系统已经具备平台的骨架，缺的不是功能，是三条缝。**

| 已有的好底子 | 还缺的三条缝 |
|---|---|
| 42 个 lib 模块 + `server.js` / 29.6k 行，零第三方依赖，337 个测试 | **执行缝**：长任务跑在 HTTP 进程内，重启即失联 |
| 任务状态机落库（`generation_runs` / `chapter_runs`），天生支持断点续跑 | **接入缝**：写作调用仍用「一个激活渠道」；评审已按评审员显式传渠道，但池化路由、统一审计与预算尚未收敛成 `ModelGateway` |
| 领域逻辑（文档/小说/评审）与页面基本分离，`lib/*-engine.js` 可独立调用 | **边界缝**：页面、用例、领域三层混在一起，`docs-page.js` 3035 行里同时在拼 HTML、解表单、调引擎 |

**演进策略：不重写，先立契约再换实现。** 三个动作按顺序做，做完就能横向扩展：

1. 把「长任务」抽成 `Job`，执行体从请求线程挪到 worker（同进程先跑通，接口先对）；
2. 把「模型调用」收敛成 `ModelGateway`（渠道池 + 能力标签 + 预算 + 审计）——评审机制已经证明了「显式渠道参数」可行（`review-engine.js` 每位评审员带 `channelId`），下一步是把写作侧也收进来；
3. 把「数据访问」从裸调 `q/one/run` 收到 `Repository`，为 SQLite→PostgreSQL 留出唯一改造点。

这三件事都不改变现有产出质量，但它们决定了「加一个工作台」是加 3 个文件还是改 30 处。

---

## 1. 现状基线（实测，不是估计）

| 维度 | 现状 | 证据 |
|---|---|---|
| 进程模型 | 单进程 Node HTTP 服务，`server.listen(PORT)`（默认 17381） | `server.js:357` |
| 入口分发 | 手写五类：IPC、docs、skills、review、status | `server.js:274-328` |
| 持久化 | `node:sqlite` 的 `DatabaseSync`（**同步 API**），单文件库，运行时 40 张表 | `lib/db.js:5,25`、`sqlite_master` 实测 |
| 并发写 | `journal_mode=WAL`（Linux 容器降级 DELETE）、`busy_timeout=5000` | `lib/db.js:28-31` |
| 长任务执行 | 进程内 `setImmediate` 启动，`inflight` 是**内存 Set** | `lib/status-page.js:204-217` |
| 任务状态 | 落库 `generation_runs` / `chapter_runs` / `generation_attempts`，可续跑 | `lib/longform-orchestrator.js` |
| 模型接入 | 写作走 `activeChannel()`（单一激活渠道）；评审按每位评审员的 `channelId` 显式传参 | `lib/llm.js:95-112`、`lib/review-engine.js` |
| 鉴权 | 回环免口令；非回环绑定时强制访问口令（`FABULA_ACCESS_TOKEN` 或启动随机生成），`?access=` 一次性换 HttpOnly Cookie，也接受 `X-Fabula-Access` 头 | `lib/access-gate.js`、`server.js:16,285` |
| 页面渲染 | 字符串模板 SSR，`docs-page.js` 3035 行、`review-page.js` 928 行 | `lib/docs-page.js`、`lib/review-page.js` |
| 规模 | 最大模块 `doc-engine.js` 3688 行 | `wc -l` |

**结论**：这是一个**设计良好的单机系统**。它的可扩展性瓶颈不在代码风格，在三个架构假设——「一个进程」「一个用户」「一个模型渠道」。评审机制已经用「显式渠道参数 + 并行调用」绕开了第三个假设，但写作链路与统一审计仍建立在它之上。

---

## 2. 规模化失效点（按会先炸的顺序排）

排序依据不是「哪个更优雅」，是「哪个先让用户看到错误」。

### ① 长任务与请求同进程 —— 第一个炸

整篇生成一次跑 10~40 分钟，执行体是 HTTP 进程里的一个 Promise。后果：

- 重启/部署/崩溃 → 任务执行体消失，DB 里 run 仍是 `running`，没人推进；
- 一个 30 分钟的生成期间，该进程的所有页面请求共享同一个事件循环；
- 无法单独扩缩容：想多跑任务就得多开页面服务。

**这不是"以后再说"的问题**——它是当前架构里唯一一个「一次误操作就丢半小时工作」的地方。

**已缓解（2026-10）**：启动时把遗留的 `running/retrying` 标为 `interrupted`（可续跑），`SIGTERM/SIGINT` 走优雅退出（停接新连接 → 等在飞任务到边界 → 关库）；「状态永远卡在 running」和「停容器硬切 SQLite」两条已经堵上。真正把执行体移出 HTTP 进程（jobs 表 + worker）仍列在迁移路径第 1 步。

### ② SQLite 同步 API 阻塞事件循环 —— 第二个炸

`DatabaseSync` 的每次查询都是**同步阻塞**的。当前请求量下感觉不到；一旦并发上来（多用户、或多任务同时写 `chapter_runs`），一个写事务会让整个进程停摆，`busy_timeout=5000` 之后直接报 `SQLITE_BUSY`。

**关键判断**：瓶颈不是 SQLite 的性能，是**同步调用阻塞事件循环**这个模型。

### ③ 单激活渠道 —— 写作链路仍在用（评审侧已绕开）

`activeChannel()` 是**全局唯一激活渠道**：切换渠道是全局副作用，两个写入者并发时必然互相覆盖。

评审机制已经验证了绕开方式：每位评审员在配置里绑定自己的 `channelId`，调用时显式传渠道、并行发起，互不读取全局状态（`review-engine.js`）。**但这只是把问题挡在评审域内**——写作侧、蒸馏、审查仍依赖 `activeChannel()`，且没有统一的调用审计与预算出口。

**下一步不是再造一个渠道池，而是把「显式渠道 + 能力标签 + 审计 + 预算」收敛成 `ModelGateway`**，让评审与写作共用一套入口。

### ④ 没有租户维度 —— 第四个炸（多用户那天）

40 张表没有 `owner_id`，鉴权 token 是进程级的。多用户一开，「谁的数据」无处安放，且这是**回溯成本最高**的一类改造（表结构 + 所有查询 + 所有页面）。

### ⑤ 三层混在页面里 —— 慢性病，不致命但拖慢一切

`docs-page.js` 同时承担：路由分发、表单解析、用例编排（直接 `await docEngine.generateDocProject`）、HTML 渲染。加一个工作台要复制这一整套，改一次 UI 要碰业务代码。

### ⑥ 跨域审计仍不完整

评审机制已经把「谁在第几轮说了什么、哪条被采纳、token 花了多少」落进 `review_rounds` / `review_opinions` / `review_decisions`，评审域内部可回放。但写作侧的改动仍散在各表的 `*_json` 字段里，无法跨工作台、跨类型查询——「可追溯」在写作链路仍只是一句承诺。

---

## 3. 目标架构

### 3.1 分层与职责

```
┌─────────────────────────────────────────────────────────────┐
│ L1 接入层  Edge                                              │
│   HTTP / SSE · 鉴权与租户解析 · 限流 · 幂等键 · 静态资源        │
│   职责：把外部请求变成内部 Command/Query，不含业务判断          │
├─────────────────────────────────────────────────────────────┤
│ L2 应用层  Use Cases（每个工作台一组编排）                      │
│   novel-app · doc-app · review-app · skill-app                │
│   职责：事务边界、任务编排、权限校验；不写 SQL、不拼 HTML        │
├─────────────────────────────────────────────────────────────┤
│ L3 领域层  Domain（纯逻辑，可单测，不依赖 IO）                  │
│   narrative · document · review · skill · model-gateway       │
│   职责：规则与算法（段落计划、质量基准、评审打分、Skill 匹配）    │
├─────────────────────────────────────────────────────────────┤
│ L4 基础设施层  Infra                                         │
│   Repository · JobQueue · ObjectStore · ModelGateway(实现)     │
│   Telemetry · Clock                                          │
│   职责：所有 IO 的唯一出口                                    │
└─────────────────────────────────────────────────────────────┘
```

**现有模块的归属映射**（不重写，只归位）：

| 层 | 现有模块 |
|---|---|
| L1 | `server.js`（拆分后）、`status-page.js` 的 HTTP 部分、静态资源 |
| L2 | `docs-page.js` / `skills-page.js` / `review-page.js` 中的**用例部分**、`handlers-*.js` 的编排部分 |
| L3 | `doc-engine.js`、`doc-craft.js`、`doc-benchmark.js`、`doc-quality.js`、`doc-layout.js`、`doc-figure.js`、`review-engine.js`、`longform-orchestrator.js`（状态机部分）、`registry.js` |
| L4 | `db.js`、`llm.js`、`zip.js`、`fs-safe.js`、`vector-store.js` |

> 注意：`doc-engine.js` 3688 行里同时有领域逻辑和 SQL。它是最需要拆的模块，但**不是现在拆**——先抽 Repository，它自然变薄（见 §5 P0-3）。

### 3.2 五个契约（可扩展性的真正来源）

架构能否扩展，不取决于分了几层，取决于**层与层之间传什么**。以下五个结构一旦定下来，加工作台、加评审员、换存储都不动上层。

```ts
// 1. 任务信封：一切长任务的统一形态（执行、续跑、取消、计费都靠它）
JobEnvelope {
  id, kind: 'doc.generate' | 'novel.write' | 'review.round' | 'skill.distill',
  tenantId, payload, budgetTokens, deadlineAt,
  attempt, traceId, idempotencyKey
}

// 2. 模型请求：渠道池、能力路由、预算都在这一层解决
ModelRequest {
  tenantId, capability: 'longform' | 'review' | 'distill' | 'chat',
  messages, temperature, maxTokens, budgetTokens, priority
}
ModelResult { text, usage, channelId, latencyMs, finishReason, costEstimate }

// 3. 产物引用：导出/图表/蒸馏样本统一指向对象存储
Artifact { id, kind, mime, ref, sha256, bytes, producedBy, createdAt }

// 4. 评审结论：多厂商评审的结构化出口（对应评审机制第六节）
ReviewVerdict {
  reviewerId, workType, round,
  scores: Record<string, number>, total,
  highlights[], issues[], mustFix[], unsupported[], unanswered[],
  verdict: 'pass' | 'revise' | 'reject'
}

// 5. 技能清单：评审库/写作技能共用一套描述（对应评审机制第七节）
SkillManifest {
  id, kind: 'method' | 'style' | 'focus',
  appliesTo: string[],      // 小说 / 论文 / 申报书 / 通用
  version, source: 'builtin' | 'distilled' | 'user',
  body, compatibility
}
```

**为什么是这五个**：它们分别对应「执行」「模型」「产物」「评审」「能力」——正好是未来 18 个月里唯一会横向长出来的五个维度。其余结构（项目、章节、素材）已经是稳定的业务实体，不需要提前抽象。

### 3.3 请求与任务两条路径（关键分离）

```
同步路径（页面/API）                        异步路径（长任务）
─────────────────────                     ─────────────────────
浏览器 ──▶ L1 鉴权/限流                     L2 用例 ──▶ 入队 JobEnvelope
        ──▶ L2 用例（短事务）                          │
        ──▶ L3 领域（纯计算）                          ▼
        ──▶ Repository ──▶ DB                    JobQueue（持久）
        ──▶ 返回 / SSE 推事件                          │
                                                  ▼
                                            Worker 进程（可多实例）
                                              ├─ 取任务（幂等键去重）
                                              ├─ L3 领域 + ModelGateway
                                              ├─ 写检查点（可续跑）
                                              └─ 发事件 / 落审计
```

**这条分界线是整个演进里最重要的一条**：同步路径要求「快、无状态、可水平复制」；异步路径要求「慢、有状态、可恢复」。把两者塞在一个进程里，就必然两头都做不好——这正是现状。

---

## 4. 五个关键决策（ADR 摘要）

### ADR-1 长任务执行：进程内 → 外置 worker

| 选项 | 评价 |
|---|---|
| A. 保持进程内 | 零成本，但重启即失联；无法单独扩容 |
| **B. 持久文件队列 + 独立 worker 进程（同机）** | **选它**。零新增依赖（SQLite 表即队列），能验证「重启不丢任务」这个核心命题 |
| C. Redis / BullMQ | 需要引入外部服务；等 B 撑不住再上 |

**结论**：先做 B。队列就用现有 SQLite 建一张 `jobs` 表（`status`、`lease_until`、`attempt`、`idempotency_key` 唯一索引），worker 用独立进程 `node worker.js`，通过租约（lease）防止重复执行。
**升级触发条件**：需要多机部署，或单机 worker 吞吐 < 任务到达速率。
**代价**：多一个进程要管；页面上的「运行中」状态要从内存 Set 改成查库（这本身是好事——现在刷新页面就看不出任务是否还活着）。

### ADR-2 存储：SQLite 保持默认，但先抽出 Repository

| 选项 | 评价 |
|---|---|
| A. 一直 SQLite | 单机足够；同步 API 阻塞事件循环是真问题，但可先靠「写少读多 + 批量事务」缓解 |
| **B. 抽 Repository 层，实现仍用 SQLite** | **选它**。改造点收敛到一个目录，将来换 PG 只换实现 |
| C. 立刻换 PostgreSQL | 现在换 = 为了一个还没发生的并发问题，付出全部测试重写 |

**结论**：Repository 只做一件事——把 `q/one/run` 的裸 SQL 收进按聚合划分的模块（`projectRepo`、`sectionRepo`、`runRepo`、`jobRepo`）。
**升级触发条件**（满足任一）：需要多实例共享库 / 写 QPS 持续 > 200 / 单库 > 5 GB / 需要行级权限。
**代价**：短期多一层转发；`doc-engine.js` 里的 SQL 要逐段搬，约 60 处（可分批，不必一次做完）。

### ADR-3 模型网关：从「一个激活渠道」到「渠道池 + 能力路由」

现状 `activeChannel()` 是全局单值。评审机制已经用「每位评审员绑定 `channelId`、调用时显式传参」绕开了它，证明这条路可行；但写作侧仍是全局状态，且没有统一审计。

**结论**：新增 `ModelGateway`（L4 实现，L3 定接口），把评审侧已验证的模式推广到全部调用：

- **渠道池**：多个渠道并存，按 `capability` 打标签（长文 / 评审 / 蒸馏 / 对话）；
- **路由策略**：能力匹配 → 预算余量 → 失败率 → 延迟，四级排序；
- **并发隔离**：每次调用带 `channelId` 显式传参，不再读全局状态（这是修掉「评审员互相覆盖」的关键）；
- **统一审计**：每次调用落 `model_calls`（tenant、capability、channel、tokens、latency、jobId）；
- **预算硬门禁**：`budgetTokens` 超限即抛 `BUDGET_EXCEEDED`，由 Job 层决定暂停还是放弃。

**代价**：`llm.activeChannel()` 的调用点要逐个改成显式传渠道（约 20 处），但这是一次性且机械的。

### ADR-4 评审子系统：独立成域，不做成「文档引擎的一个功能」

**状态：已落地（2026-10）。** `lib/review-engine.js` 独立于文档/小说引擎，工作台通过 `{ workbench, workId, sectionIdx, target, type, title, text, intent, apply }` 适配层接入；评审团、轮次、意见、决策、Skill 绑定各自落表。

评审机制（多评审员、Skill 库、蒸馏、交叉验证）与写作引擎的耦合点只有两个：**读作品**、**写回修改**。它自己的生命周期（评审员档案、Skill 版本、轮次、采纳记录）比写作复杂得多。

**结论**：`review` 独立成域，对外只暴露：
- `review.submit(workRef, panelConfig) → roundId`
- `review.verdicts(roundId) → ReviewVerdict[]`
- `review.applyDecisions(roundId, decisions) → patchSet`

**剩余缺口**：还没有统一的 `works` 表。当前「作品」靠适配层临时解析成 `doc_sections.content` 或小说章节正文；**建议在 P1 补 `works` 表**（id、tenant、workbench、type、version、artifactRef），评审、导出、蒸馏三处都受益。

### ADR-5 前端：SSR 保留，但把「渲染」从「用例」里剥出来

不引入前端框架（当前字符串 SSR 零依赖、首屏快、部署简单，这些优点不该丢）。

**结论**：每个页面拆成 `controller`（解析请求、调用例、组装 view model）与 `view`（纯函数，view model → HTML）。`view` 不允许 require 任何 engine。

**代价**：`docs-page.js` 要拆成 2~3 个文件，纯机械工作。

---

## 5. 长期发展规划

四个阶段。每阶段都有**完成标志**（可验证）和**明确不做**（防止过度设计）。

### P0 稳态与可测（0~2 个月）

**目标**：让系统「不怕重启」「成本可见」。

| 交付 | 完成标志 |
|---|---|
| P0-1 `jobs` 表 + worker 进程（ADR-1 B） | 生成到一半 `kill` worker，重启后任务**自动继续**，不重复写已提交小节 |
| P0-2 `ModelGateway`（ADR-3） | 两个并发调用用不同渠道，互不影响；`model_calls` 可按 job 查 token |
| P0-3 `Repository` 抽层，先抽 `runRepo` + `jobRepo` | 新代码不再出现裸 `run(` / `one(` |
| P0-4 结构化日志 + traceId 贯穿 | 任一任务可凭 traceId 串出「请求→计划→每节→评审→导出」 |
| P0-5 契约文件落地（§3.2 五个类型） | 有 `lib/contracts.js`（JSDoc 类型 + 运行时校验），上层按它写 |

**不做**：不拆 `doc-engine.js`、不换数据库、不动前端结构。理由是这三件事都不解决「重启丢任务」。

**决策门**：若 P0 结束时单机仍只有 1 个用户，**P1 的租户改造推迟**。评审域已在 P2 之前提前交付，接下来优先补 `works` 统一作品抽象与写作侧 `ModelGateway`。

### P1 多实例与多租户（2~5 个月）

**目标**：两个实例同时跑不打架；数据知道属于谁。

| 交付 | 完成标志 |
|---|---|
| P1-1 `tenant_id` 贯穿（40 张表 + Repository + 页面） | 两个租户的数据互不可见，测试覆盖越权访问 |
| P1-2 SQLite → PostgreSQL（ADR-2 触发后） | 双实例连同一库，`jobs` 租约不重复执行 |
| P1-3 `works` 表（作品抽象，ADR-4 前置） | 评审/导出/蒸馏三处都通过 `workRef` 取作品 |
| P1-4 SSE 事件推送替代轮询 | 任务进度实时可见，页面不再刷新查状态 |
| P1-5 幂等键 + 重试策略统一 | 同一 `idempotencyKey` 提交两次只产生一个任务 |

**不做**：不做计费、不做插件沙箱、不做开放 API。

**决策门**：若 P1 后并发仍 < 20 QPS，**不要**拆服务，继续单体 + 多 worker。单体不是债，过早微服务才是。

### P2 评审与技能生态（核心已交付，2026-10）

**目标已基本达成**：评审从「提示词文档」变成可运行子系统，且没有侵入写作引擎。

| 交付 | 状态 |
|---|---|
| P2-1 `review` 域（评审员档案、评审团配置、轮次、交叉验证） | **已完成**。3 位评审员并行独立评审、交叉验证、平票复投/仲裁、暂停/续跑、决策落库；`test/review.test.js` 47 条 |
| P2-2 `skill` 域（SkillManifest、库归属、组合校验） | **已完成**。三类 Skill、共享/按评审员绑定、冲突提示、启停与编辑；版本回滚尚未做 |
| P2-3 蒸馏流水线（样本 → 特征 → 抽象 → Skill → 入库校验） | **已完成**。优劣甄别为硬性门槛，重复度 ≥0.72 拒绝入库 |
| P2-4 评审成本护栏 | **已完成**。每次调用 token 落库、可按轮次查看；评审团可设每轮硬上限，按人数切分单次 `maxTokens`，低于「人数 × 600」拒绝开跑；连接类失败重试一次，预算模式下不重试解析失败（那次调用已花满 token）；自动评审另有跨轮次总预算，闸门按整轮最坏开销预留（评审员 + 组长仲裁 + 可行性评估），不够一轮就在两轮之间收手 |

**剩余**：`works` 统一作品抽象（见 ADR-4）、Skill 版本回滚。

**不做**：不做评审员之间的自动辩论（成本高、收益未验证）。

### P3 平台化（9~18 个月）

**目标**：从「一个应用」变成「一个平台」。

- 开放 API + Webhook（`JobEnvelope` 已是天然的对外契约）；
- 插件沙箱（当前 `server.js:183` 的 `pluginStub` 是桩，需要真实权限模型）；
- 配额与计费（`model_calls` 已具备计费原始数据）；
- SLA 与容量规划（有 SLO 才有容量目标）。

**不做**：不做多区域部署、不自研模型推理。

---

## 6. 质量与可观测性（架构的一部分，不是附属品）

| 指标 | 目标 | 采集点 |
|---|---|---|
| 单节生成 p95 | < 90s | `model_calls` 按 job 聚合 |
| 任务恢复时间 | < 30s（worker 重启到续跑） | `jobs.lease_until` 超时扫描 |
| 页面 p95 | < 300ms | L1 埋点 |
| 任务成功率 | > 95%（不含用户取消） | `generation_runs` 状态迁移 |
| 单篇成本偏差 | 实际/预估 < ±20% | `budgetTokens` vs `model_calls` 汇总 |

**三个必须有的告警**：任务租约反复超时（worker 卡死）、`SQLITE_BUSY` 突增（写并发到顶）、单任务 token 超预算 3 倍（提示词退化或死循环）。

### 单机运行保障（2026-10 已落地）

| 能力 | 行为 | 位置 |
|---|---|---|
| 探活 | `GET /healthz` 返回 `{ok,uptime,db}`，`no-store`，不受访问口令限制；Docker `HEALTHCHECK` 用它 | `server.js:314` |
| 访问门禁 | 回环免口令；非回环未带有效口令一律 401 登录页（不泄露页面内容与 IPC token）；`?access=` 换 HttpOnly Cookie 后 303 去参 | `lib/access-gate.js` |
| 孤儿恢复 | 启动时 `running/retrying` → `interrupted`（可续跑）、文档项目 → `failed`、评审轮次有意见 → `paused` | `lib/recovery.js` |
| 优雅退出 | `SIGTERM/SIGINT`：停接新连接，等待在飞请求与任务到边界（`FABULA_SHUTDOWN_GRACE_MS`，默认 10s），再 `closeAllConnections`、关库、exit 0 | `server.js:430` |
| 迁移安全 | `PRAGMA user_version` 记录 schema 版本；升级前 `VACUUM INTO` 快照（保留 5 份），备份失败拒绝启动 | `lib/db.js:64-100` |
| 取消任务 | 文档全托管可在小节边界停止，已完成小节保留；无进程内循环时直接改库 | `doc-engine.js` `cancelDocRun` |

对应的回归：`test/access-gate.test.js`、`test/access-gate-server.test.js`（真服务非回环）、`test/recovery.test.js`、`test/migration.test.js`、`test/graceful-shutdown.test.js`（POSIX）。

---

## 7. 风险登记册

| 风险 | 概率 | 影响 | 对策 |
|---|---|---|---|
| 过早微服务化，把 29.6k 行拆成 8 个服务 | 中 | 高（交付速度腰斩） | P0/P1 明确「单体 + 多 worker」，拆分门槛写在决策门里 |
| 契约先行但无人使用，变成文档垃圾 | 中 | 中 | 每个契约必须有一个**真实调用方**才算完成；无调用方不进主干 |
| SQLite→PG 迁移数据不一致 | 中 | 高 | 双写 + 校验脚本 + 只读切换演练；迁移前必须有全量备份与回滚路径 |
| 评审机制成本失控（3 评审员 × N 轮） | 高 | 中 | **已落地**：团级每轮 token 上限按人数切分、过低预算拒绝开跑；Job 层统一硬门禁仍待 `ModelGateway` |
| `doc-engine.js` 越拆越乱 | 中 | 中 | 只在 Repository 抽层后按「领域/IO」切，不按行数切 |
| 页面与用例长期不分离 | 高 | 低（慢性） | 新增页面必须 controller/view 分离；老页面随改随拆 |

---

## 8. 迁移路径（不推翻现有代码的最小顺序）

```
第 1 步  jobs 表 + worker 进程         ← 不动任何现有逻辑，只换「谁执行」
第 2 步  ModelGateway（渠道显式传参）   ← 评审侧已落地，写作侧 ~20 处调用点待替换
第 3 步  Repository（先 run/job）      ← 新代码不写裸 SQL，老代码随改随搬
第 4 步  contracts.js                  ← 五个契约 + 运行时校验
第 5 步  tenant_id（P1）               ← 加列 + 查询加过滤，可灰度
第 6 步  works 表（P1）                ← 评审/导出/蒸馏统一入口
第 7 步  review / skill 域（P2）        ← 已完成（2026-10）；剩余 Skill 版本回滚
```

**每一步都可独立上线、可回滚**。任何一步如果需要「停下来改一个月」，说明这一步切大了，应再拆。

---

## 9. 明确不做的事（Non-goals）

1. **不做微服务**：29.6k 行、单团队、单区域，微服务只会把「函数调用」变成「网络调用」。
2. **不做自研前端框架/构建链**：SSR 字符串模板零依赖、部署简单，这个优点不要换。
3. **不做多模型自动投票择优**：成本高且质量提升未验证，先用「评审团 + 交叉验证」。
4. **不在 P1 之前做计费**：没有 `tenant_id` 的计费是伪需求。
5. **不为「可能的并发」提前优化**：每个改造都必须对应一个已经发生或明确将发生的场景。

---

*本文档的每条结论都可被推翻——但推翻它需要给出新的实测数据，而不是「感觉应该这样」。*
