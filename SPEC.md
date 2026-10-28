# SPEC v1 — dsh-auto-reasoning-effort

> 本文件是**唯一权威契约**。三个执行 agent 只能在自己的 write scope 内改文件；跨 scope 的需求写进 `# 待裁决` 段落交给 Lead，不得自行越界。
> 基线：`dsh-thinking-levels` 4.4.8（MIT，© 2026 drscrewdriver）。我们的产物同为 MIT，保留上游版权声明。

## 0. 产品身份

| 项 | 值 |
|---|---|
| 包名 / 插件 id | `dsh-auto-reasoning-effort` |
| 仓库 | `https://github.com/lion231226/dsh-auto-reasoning-effort` |
| License | MIT（上游版权 + 我们的版权并列，写入 `NOTICE`） |
| 目标宿主 | DSH `0.2.1-rc.3`（peer 枚举沿用上游 14 档，不新增） |
| 一句话 | 按**任务难度**实时智能调节推理档位；上游只按工具调用历史调度 |

## 1. 与上游的差异（必须全部实现）

1. **难度信号来自用户消息**（本轮 prompt 文本），不是只看工具历史。
2. **轮次隔离**：工具样本按 `turn` 切窗，新轮清空（上游是全会话环形缓冲）。
3. **兜底方向安全**：投影/解析失败 → `high`（可配 `safeFallback`），不是 `low`。
4. **clamp 就近向下**：AUTO 路径遇到模型不支持该档时，优先降档而不是取最高档。
5. **迟滞防抖**：`hysteresisSteps`（默认 2）——连续 N 次相同决策才切档。
6. **工具名适配 Windows**：`pwsh` / `shell` / `powershell` / `apply_patch` 算简单工具。
7. **自定义 wire 档位保留**：用户在模型面板选的 `ultra` 之类不被吞。
8. **难度可解释**：每次决策产出 `reasons[]`，写进 debug 日志与 `auto_reasoning_effort_status` 工具输出。

## 2. 难度算法（scheduler-core 必须逐条实现，含单测）

### 2.1 输入

```ts
export interface DifficultyInput {
  /** 本轮最新用户消息原文（可能为空字符串）。 */
  message: string
  /** 本轮附件数，缺省 0。 */
  attachments?: number
  /** 本轮已发生的工具错误数（tool/result.isError / data.error），缺省 0。 */
  priorErrors?: number
  /** 本轮已发生的工具调用数，缺省 0。 */
  toolCount?: number
}
```

### 2.2 输出

```ts
export type Difficulty = 'trivial' | 'simple' | 'moderate' | 'complex' | 'explicit'

export interface DifficultyResult {
  difficulty: Difficulty
  /** 0..1 连续分数，供调试与日志。 */
  score: number
  /** 人类可读的命中理由，例如 ['len:45', 'kw:重构', 'code-block']。 */
  reasons: string[]
  /** 仅 difficulty === 'explicit' 时存在：消息里显式要求的档位。 */
  explicit?: 'off' | 'low' | 'high' | 'max'
}

export function classifyDifficulty(
  input: DifficultyInput,
  cfg?: Partial<DifficultyConfig>,
): DifficultyResult
```

### 2.3 打分规则（顺序执行，后置规则可覆盖前置）

1. **显式标记优先**：消息匹配
   `/[\[{【]\s*effort\s*[:=]\s*(off|low|high|max)\s*[\]}】]/i`（大小写不敏感）
   → 立即返回 `{ difficulty: 'explicit', score: 1, reasons: ['explicit:<值>'], explicit: <值> }`。
2. **基础分（消息长度）**：`len = message.trim().length`

   | len | base |
   |---|---|
   | < 8 | 0.05 |
   | < 30 | 0.15 |
   | < 80 | 0.30 |
   | < 200 | 0.45 |
   | < 500 | 0.60 |
   | ≥ 500 | 0.75 |

   记录 `reasons.push('len:' + len)`。
3. **关键词**（大小写不敏感 `includes`；同一类命中只加一次，`reasons` 记 `kw:<词>`）：
   - `complexKeywords`（默认：重构, 架构, 设计, 调试, 排查, 迁移, 重构, 性能, 并发, 安全, refactor, design, debug, migrate, optimize, rewrite, 从零, from scratch, 实现, implement）命中 → `score = max(score, 0.55)`，再 `+0.10`。
   - `heavyKeywords`（默认：全部, 整个, 全量, 端到端, complete, entire, whole, all, full, end-to-end）命中 → `+0.10`。
   - `simpleKeywords`（默认：读, 查, 看, 列, 搜, 找, 读取, 显示, read, show, list, print, cat）命中 → `score *= 0.7`。
   - `trivialKeywords`（默认：谢谢, 好的, 收到, 明白, ok, okay, thanks, 继续, 接着, next, continue）命中且 `len < 60` → `score = min(score * 0.3, 0.2)`。
4. **结构信号**（各 +一次）：
   - 含 ``` 围栏代码块 → `+0.15`，reason `code-block`
   - 含报错/堆栈特征（`/traceback|error:|exception|at .+:\d+|\bpanic\b/i`）→ `+0.20`，reason `stack-trace`
   - 含文件路径（`/[\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|json|ya?ml|toml|md|sql)\b/i`）→ `+0.10`，reason `file-path`
   - 以 `?`/`？` 结尾且 `len < 60` → `score *= 0.8`，reason `short-question`
5. **上下文信号**：
   - `(attachments ?? 0) > 0` → `+0.05`，reason `attachments`
   - `(toolCount ?? 0) >= 6` → `+0.10`，reason `tool-count`
   - `(priorErrors ?? 0) >= 1` → `+0.15`，reason `tool-error`；`>= 3` 再 `+0.10`
6. **收敛**：`score = clamp(score, 0, 1)`。
7. **分档**：`score < 0.25 → trivial`；`< 0.45 → simple`；`< 0.70 → moderate`；否则 `complex`。

### 2.4 难度 → 基准档位

```ts
export function baseEffortFor(d: Difficulty, allowUpgrade: boolean): 'low' | 'high' | 'max'
```
- `trivial` / `simple` → `low`
- `moderate` → `high`
- `complex` → `allowUpgrade ? 'max' : 'high'`
- `explicit` → 由调用方先用 `result.explicit` 覆盖，不进本函数

## 3. 调度器（scheduler-core）

```ts
export interface DecideEffortInput {
  selected: EffortId            // 用户选择（model/selection 折叠值或配置默认）
  explicit?: 'off' | 'low' | 'high' | 'max'
  difficulty: Difficulty
  /** 本轮工具样本（已按 turn 过滤）。 */
  recentCalls: readonly ToolCallSample[]
  allowDowngrade: boolean
  allowUpgrade: boolean
}

export function decideEffort(input: DecideEffortInput): 'low' | 'high' | 'max'
```

规则（按顺序）：
1. `explicit` 存在 → 返回它（`off` 视为 `low`？**不**：`off` 返回 `'low'` 会改变语义，因此 `explicit === 'off'` 时由调用方走 manual 分支，本函数不接收 `off`；签名里的 `explicit` 只允许 `'low' | 'high' | 'max'`）。
2. `selected !== 'auto'`：`off`/`on` → `'high'`；其余原样返回（`minimal/medium/xhigh` 也原样，由 clamp 处理）。
3. `base = baseEffortFor(difficulty, allowUpgrade)`。
4. 工具微调（只在**本轮样本 ≥ 2** 时生效，样本不足直接返回 `base`）：
   - `simpleRatio = 简单工具数 / 样本数`；简单 = `SIMPLE_TOOL_RE` 命中 **且** `argsSize < 800`。
   - `simpleRatio >= 0.75 && allowDowngrade && base === 'high'` → `'low'`（reason `tools:simple`）。
   - `maxArgs >= 3200 && allowUpgrade` → `'max'`（reason `tools:heavy`）。
   - 两者都命中时 heavy 优先。
5. 返回结果永不为 `off`/`auto`。

`SIMPLE_TOOL_RE`：
```ts
/^(?:fs|bash|terminal|pwsh|shell|powershell|code|text|todo|job|skill|read|list|search|write|grep|glob|edit|ls|cat|rm|mv|cp|touch|mkdir|pwd|head|tail|apply_patch)(?:_|$)/i
```

### 3.1 迟滞（纯函数，plumbing 调用）

> 曾用"streak 累加 / `>= steps` 切换"的写法，实测有两个缺陷：`steps=2` 时一次不同决策就切（等于 steps=1）；同档决策也累加 streak，长稳定后一次噪声就被击穿。改为显式的「候选档位 + 候选计数」。

```ts
export interface HysteresisState {
  level: 'low' | 'high' | 'max'
  /** 待切换的候选档位；null 表示当前没有候选。 */
  pending: 'low' | 'high' | 'max' | null
  /** 该候选连续出现的次数。 */
  pendingCount: number
}

export function applyHysteresis(
  previous: HysteresisState | undefined,
  next: 'low' | 'high' | 'max',
  steps: number,
): HysteresisState
```
规则（按顺序）：
1. `previous === undefined` → `{ level: next, pending: null, pendingCount: 0 }`（首次直接采纳，不拖第一轮）。
2. `next === previous.level` → `{ level: next, pending: null, pendingCount: 0 }`（回到当前档 = 撤销候选，计数清零）。
3. 否则 `pendingCount = previous.pending === next ? previous.pendingCount + 1 : 1`：
   - `pendingCount >= steps` → `{ level: next, pending: null, pendingCount: 0 }`
   - 否则 → `{ level: previous.level, pending: next, pendingCount }`
4. `steps <= 1` 自然退化为"第一个不同决策立即切"。

> 语义：**不同档位连续出现 `steps` 次才切**；`steps=1` 等价于无迟滞。必须覆盖"同档打断候选"与"长稳定不被累积计数击穿"两类用例。

## 4. clamp（scheduler-core 提供，plumbing 调用）

```ts
export function clampForAuto(level: 'low' | 'high' | 'max', efforts: readonly string[]): EffortId | undefined
```
- `efforts` 含该档 → 原样。
- 否则在 `['low','high','max']` 中**先向下、再向上**找最近的已广告档位。
- 一个可用档都没有（只剩 `off`/`on`/`auto`）→ `undefined`（调用方剥离）。
- 与上游 `clampToEfforts` 的区别：绝不"取最高档"。

## 5. 数据管道（plumbing）

### 5.1 会话投影 `tlEffortDifficulty`

```ts
export interface EffortProjectionState {
  /** 本轮最新用户消息文本（截断 4000 字符）。 */
  latestUserText: string
  /** 单调递增的 prompt 序号，用于判断"新的一轮提问"。 */
  promptSeq: number
  /** 当前轮次。 */
  currentTurn: number
  /** 本轮工具样本（最多 8 条，按 turn 过滤）。 */
  samples: ToolCallSample[]
  /** 本轮工具错误数。 */
  errors: number
  /** 本轮工具调用总数（不受 8 条窗口限制）。 */
  toolCount: number
  /** 用户显式选择的档位（model/selection 折叠值）。 */
  userEffort: string | null
}
```

`apply` 折叠规则：
- `user/message` **仅当 `data.source?.kind === 'user'`**（真人类提问，即队列里本轮被认领的那条 prompt）→ `latestUserText = extractText(data).slice(0, 4000)`，`promptSeq++`，`samples = []`，`errors = 0`，`toolCount = 0`。
  **合成上下文必须忽略**：`agent.inject()` 注入的文件变更提示 / 子目录 AGENTS.md / skill 正文 / cron 通知 / goal 续轮同样记成 `user/message`，但 `source.kind !== 'user'` —— 它们**不重置窗口、不覆盖 `latestUserText`**，直接返回同一引用。否则一次 skill 正文注入就会把难度判成 complex、把工具窗口清空（实测威胁：`dsh-session` types.d.ts:287-294 明确说明三者共用该事件）。
- `turn/start` → `currentTurn = data.turn`，清空 `samples`/`errors`/`toolCount`。
- `tool/call` → 追加样本（保留最后 8 条），`toolCount++`。
- `tool/result` → `data.error` 存在或 `data.message.isError === true` → `errors++`。
- `model/selection` → `userEffort = data.reasoningEffort`（字符串且非空才算，否则 `null`）。
- 无关事件**必须返回同一引用**（投影注册表用 `Object.is` 判变更）。

`extractText(UserMessage)` 需兼容：`data.content` 为 string、或 `[{type:'text', text}]` 数组；取所有 text 拼接，空格分隔。

### 5.2 `agent/request` 注入（index.ts）

- `prepend: true`，`await next()` 后改写 `reasoningEffort`（上游同款语义，不要改）。
- 能力守卫：模型不广告任何 effort → 删除 `reasoningEffort`（不要发）。
- `toggleOnly` 模型：`off` → `off`，其余 → `high`。
- manual 选择：广告则透传；不广告则**剥离**（自定义 wire id 只要在 `efforts` 里就算广告，必须透传）。
- `auto`：
  1. 从投影取 `DifficultyInput { message: latestUserText, attachments: 0, priorErrors: errors, toolCount }`。
  2. `classifyDifficulty` → `result`。
  3. 若 `result.explicit` → 走 manual 分支（直接注入该值，clamp 用 `clampForAuto`? **不**：显式即 manual，按 manual 规则透传/剥离）。
  4. 否则 `decideEffort` → `applyHysteresis`（按 session 的 `WeakMap` 保存上次状态）→ `clampForAuto`。
  5. 投影读取失败（`readEffortProjection === undefined`）→ 直接用 `safeFallback`（默认 `'high'`），并 `logger.warn` 一次（每会话只警告一次，避免刷屏）。
- 每次决策写 `logger.info`：`model, user, seed, difficulty, score, reasons, => level`。
- 保留上游的 `agent/request` 日志前缀改为 `[auto-reasoning-effort]`。

### 5.3 配置（index.ts 内的 `Config` schema）

在上游 `Config` 上**新增**（不得删改上游字段）：

```ts
difficulty: z.object({
  complexKeywords: z.array(z.string()).default([...]),
  heavyKeywords: z.array(z.string()).default([...]),
  simpleKeywords: z.array(z.string()).default([...]),
  trivialKeywords: z.array(z.string()).default([...]),
}).default({ /* 同默认值 */ }),
hysteresisSteps: z.number().step(1).min(1).max(10).default(2).volatile(),
safeFallback: z.union(['low', 'high', 'max']).default('high').volatile(),
```

`DEFAULT_CONFIG` / `ThinkingLevelsConfig` / `LegacyConfig` 三处同步（上游有"两代 schema 不得漂移"的注释，必须遵守）。

## 6. 验收（Lead 执行，agent 自测后报告）

| 检查 | 命令 | 通过标准 |
|---|---|---|
| 类型 | `pnpm typecheck` | 0 error |
| 单测 | `pnpm test` | 全绿，且新增 ≥ 25 个用例 |
| 构建 | `pnpm build` | 产出 `lib/index.js` 等 |
| 静态检查 | `node <plugin-guide>/bin/dsh-plugin-dev.js check --cwd .` | 无 P0 |
| 打包 | `pnpm pack --dry-run` | 含 `lib/`、`cordis.patch.yml`、`README*` |

## 7. 文件所有权（write scope，越界即冲突）

| Agent | 可写文件 |
|---|---|
| **scheduler-core** | `src/difficulty.ts`（新建）、`src/thinking-level.ts`、`tests/thinking-level.test.ts` |
| **plumbing** | `src/auto-schedule-projection.ts`、`src/session-events.ts`、`src/index.ts`、`tests/auto-schedule-projection.test.ts` |
| **packaging** | `package.json`、`dsh.plugin.json`、`README.md`、`README.zh.md`、`INSTALL.md`、`INSTALL.zh.md`、`CHANGELOG.md`、`LICENSE`、`NOTICE`（新建）、`icon.svg`、`.github/**`、`tsconfig*.json`、`tsdown.config.ts`、`eslint.config.js`、`.gitignore`、`pnpm-workspace.yaml`（删除） |
| **Lead** | `SPEC.md`、`cordis.patch.yml`、`src/client/**`（如需）、其余未列文件 |

### 删除清单（packaging 负责）
`README.{ja,ko,fr,de,it,ru,es}.md`、`INSTALL.{ja,ko,fr,de,it,ru,es}.md`、`CHANGELOG.{ja,ko,fr,de,it,ru,es}.md`、`BUGFIX-LOG.md`、`assets/`（README 不再引用截图）、`tools/`（鲸鱼娘生成脚本）、`screenshots.json`。
> 保留 `assets/` 与否由 packaging 判断：只要 `src/client/**` 没有 import 它，就可以删。删除前必须 `grep -r "assets/" src/` 证明无引用。

## 8. 禁止

- 不得改 `vendor/`、不得改宿主源码、不得手写 profile 的 `package.json`。
- 不得引入新的运行时依赖（上游只有 `schemastery` + `zod`，保持）。
- 不得删除上游的 i18n / 客户端 UI 代码，除非 packaging 明确处理并说明。
- 不得让 `apply()` 抛错（宿主插件抛错可能完全静默）。
- 不得在 `agent/request` 之外的位置改写 `reasoningEffort`。

## 9. 待裁决（agent 遇到就停手并上报 Lead）

- 上游 `src/index.ts` 里 `advertiseAutoEffort` 的 adapter 包装是否需要同步改（若 `resolveCallFor` 会校验 efforts，需放行 `auto`）。
- 上游 `session-events.ts` 的 legacy 读法是否保留（我倾向于保留，只加新逻辑）。
- `takeover` / `defaultPricing` / `billing-projection` 是否保留（我倾向于保留，它们与难度调度正交，但**不得**因此扩大改动范围）。

## 10. v0.1.1 追加（上线实测后的校准，覆盖 §2.3/§5.2 中相冲突的数值）

实测：16 条真实 prompt 里，「我们改成自己发布的插件…新建仓库…加入能力」= 0.300/simple→low，
「作为 lead…指导并监督 subagents 执行」= 0.300/simple→low。结论是词表只认名词型难词，缺动作/编排信号。

### 10.1 难度信号扩展
- `DifficultyConfig` 新增**可选** `actionKeywords` / `orchestrationKeywords`（有冻结默认表；
  目前不从 settings 暴露，保持 schema 兼容）。
- 地板规则（在 §2.3 关键词之后、结构信号之前）：
  - `actionHits ≥ 2` → `score = max(score, 0.70)`，reasons `act:<词>`；
  - `actionHits === 1 && len ≥ 40` → `max(score, 0.50)`；
  - `orchHits ≥ 1 && len ≥ 40` → `max(score, 0.70)`，reasons `orch:<词>`。
- 结构信号新增：步骤清单（≥2 行 `^\S*?(?:\d+[.、)]|[-*])\s+`）→ `+0.15`（`steps:<n>`）；
  去重后 ≥2 个文件路径 → 再 `+0.10`（`paths:<n>`）。
- complex 地板由 0.55 调整为 **0.60**（`0.60 + 0.10 = 0.70` → complex）。
- 抑制范围：`expensive = complex || heavy || action 地板 || orch 地板`；命中时跳过
  simple ×0.7、trivial ×0.3、short-question ×0.8，reasons 标 `(suppressed)`。

### 10.2 prompt 来源三级兜底（覆盖 §5.2 的"投影失败即 safeFallback"）
`agent/pre-step`（waterfall，必须 `next()`）捕获每股 agent 的最后一条 `source.kind === 'user'` 消息文本，
存 `WeakMap<agent, string>`；之后每个请求按顺序取：
1. `projection.latestUserText`（非空）→ `src=projection`；
2. pre-step 缓存（非空）→ `src=pre-step`（子代理会话走这条）；
3. 都没有 → `safeFallback`，reasons `no-prompt`，`src=no-prompt`，每会话 warn 一次。

`humanPromptOf` 的三态语义必须保持：`undefined`（本批无人类消息）→ 沿用上一轮缓存；
`''`（有人类消息但无文本，如纯图片）→ **覆盖**缓存，避免上一轮文本泄漏。

### 10.3 验收基准
`tests/fixtures/prompts.zh.json` 16 条，**必须 16/16 命中**；分布 trivial 9 / simple 2 / complex 5。
该 fixture 是回归门禁：任何改动导致分布变化都要先解释，再决定是否改靶子。
