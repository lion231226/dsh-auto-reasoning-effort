# dsh-auto-reasoning-effort

**按任务难度自动调节推理档位的 [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness) 插件。**

在会话的模型选择器里选 **Auto**，插件会为**当前这一次**请求挑一个 `reasoning_effort` 线上档位——
`low` / `high` / `max`——依据是这道题看起来有多难：你刚发出的 prompt，加上本轮的工具活动。
一行 `cat package.json` 这种活不值当开高档；带堆栈的重构则不该省算力。当然，你也可以手动钉死任意档位。

- [English README](./README.md)
- [安装指南](./INSTALL.zh.md) · [Installation guide](./INSTALL.md)
- [更新日志](./CHANGELOG.md)

> **这是 fork，不是改名。** 本项目起步于
> [`dsh-thinking-levels` 4.4.8](https://github.com/drscrewdriver/dsh-thinking-levels)（MIT，
> © 2026 drscrewdriver），并换掉了它的调度信号：上游按整个会话的工具调用历史调度，本 fork 先判断
> **任务难度**，工具活动只作微调。上游版权完整保留——见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。

## 为什么值得折腾

多步 agent 任务里，模型在每次工具调用前都要重新思考一遍，而思考阶段基本就是实际耗时的全部。
固定 `high` 会在读文件这种琐事上烧掉几分钟；固定 `low` 又会在迁移、重构这类活上想得太浅。
真正有用的信号不是「跑过几个工具」，而是「用户这道题有多难」。本插件把它当成主要输入。

## 它到底做了什么

每次 `agent/request`：

1. 取本轮最新一条用户消息，判定难度（`trivial` / `simple` / `moderate` / `complex`，或显式指定）；
2. 难度映射到基准档位（`low` / `high` / `max`）；
3. 用本轮的工具体验做微调（仅当本轮样本 ≥ 2 条）；
4. 过一遍迟滞，避免档位在相邻请求间来回跳；
5. clamp 到模型真正广告的档位——优先往**低**找最近的；
6. 把结果写成 `reasoningEffort` 注入，并把决策理由一并写进日志。

如果用户手动选了档位（模型选择器、插件 `level` 配置，或消息里的 `[effort: …]` 标记），手动选择优先，
调度器直接让路。

## 与上游 dsh-thinking-levels 的关系

本仓库 fork 自
[`drscrewdriver/dsh-thinking-levels` 4.4.8](https://github.com/drscrewdriver/dsh-thinking-levels)
（MIT，© 2026 drscrewdriver），不是它发行线的延续。上游 MIT 原文逐字保留在 [LICENSE](./LICENSE)，并追加了
我们的版权行；[NOTICE](./NOTICE) 写清了哪些文件属于上游、哪些是本仓库新增。4.4.8 及之前的历史留在
[上游 CHANGELOG](https://github.com/drscrewdriver/dsh-thinking-levels/blob/main/CHANGELOG.md)。

改掉的是调度语义：上游按整个会话的工具历史调度，其余管线照旧；我们先把任务难度判出来，把工具历史降级为修正项，
并落地下面的八项修复。客户端 UI、settings/volatile 配置管线与 takeover/定价辅助逻辑都属于上游成果，原样继承。

感谢 drscrewdriver 的原始插件。

## 与 dsh-thinking-levels 的区别

| | `dsh-thinking-levels` 4.4.8（上游） | `dsh-auto-reasoning-effort`（本 fork） |
|---|---|---|
| 主要信号 | 整个会话的工具调用历史 | 当前 prompt 的难度（长度、关键词、结构、报错） |
| 样本窗口 | 全会话共用一个环形缓冲 | 按轮次隔离，新提问即清空 |
| 失败兜底 | 掉到低档 | 落到 `high`（`safeFallback` 可配），不会悄悄降智 |
| 模型不支持该档 | clamp 到已广告的最高档 | clamp 到最近的**更低**档 |
| 抖动 | 无阻尼 | `hysteresisSteps`（默认 2）：连续 N 次同决策才切档 |
| 简单工具识别 | Unix 风格工具名 | 额外认 `pwsh`、`shell`、`powershell`、`apply_patch` |
| 自定义 wire 档位（`ultra` 等） | 可能被 clamp 吞掉 | 模型广告该值时原样透传 |
| 可解释性 | 只有档位 | 每次决策带 `reasons[]`（如 `len:812`、`kw:重构`、`stack-trace`） |

## 安装

前置条件：Node.js 22.19+（或 24+），一个落在 `package.json` peer 范围内的 DSH（截至 `0.2.1-rc.3` 的
14 个 rc 均在内），以及 `dsh` CLI（pnpm 11 随它一起提供）。

**方式一：GitHub 源码（走 `prepare` 现场构建）**

```bash
dsh plugin --profile web add github:lion231226/dsh-auto-reasoning-effort
```

**方式二：npm 包（自带 `lib/`，无需构建）**

```bash
dsh plugin --profile web add dsh-auto-reasoning-effort
```

**方式三：dsh-market（图形界面）**

打开 dsh-market 的插件市场，搜索 `dsh-auto-reasoning-effort` 安装。若条目尚未收录，用上面两种命令行方式即可。

装完必须重启宿主——正在跑的 `dsh web` 不会热加载新的 bundle 层：

```bash
dsh web
```

省点排错时间的几条备注：

- **web** profile 本身是 pnpm workspace 根；`dsh plugin add` 若抱怨 workspace，就在命令末尾加 `-w`。
- GitHub 安装会执行包里的 `prepare` 脚本。pnpm ≥ 10 默认拦截依赖的构建脚本，会要求你在 profile 的
  `pnpm-workspace.yaml`（`allowBuilds`）里放行 `dsh-auto-reasoning-effort`；不想放行就改用 npm 或 tarball。
- 组合行与 npm 包同名，都是 `dsh-auto-reasoning-effort`；profile 覆盖针对的 row id 也是它。
- 装本插件前先卸掉 `dsh-thinking-levels`——两个调度器同时写同一个请求的 `reasoningEffort`，只会互相打架。

完整前置条件、验证步骤与排错：[INSTALL.zh.md](./INSTALL.zh.md)。

## 配置

两个入口共用一份 schema：profile 组合文件（`cordis.yml`）里插件行的 `config:`，以及 Settings → Plugins
里由 `.volatile()` 字段生成的表单（`enabled`、`level`、`allowDowngrade`、`allowUpgrade`、
`hysteresisSteps`、`safeFallback`，改完下个请求生效、无需重启）。关键词表与 `models` 属于配置级，
改组合文件。

| 键 | 类型 | 默认 | 含义 |
|---|---|---|---|
| `enabled` | boolean | `true` | 总开关。关掉后插件不注入任何值。 |
| `level` | `off` \| `on` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `auto` | `auto` | 会话没有手动选择时使用的默认档位；`auto` 表示按请求调度。 |
| `allowDowngrade` | boolean | `true` | 允许调度器在任务简单或本轮以简单工具为主时选 `low`。 |
| `allowUpgrade` | boolean | `false` | 允许对 `complex` 任务和重型工具负载选 `max`；关掉时复杂任务封顶 `high`。 |
| `hysteresisSteps` | 整数 1–10 | `2` | 需要连续多少次相同决策，才真正切换线上档位；`1` 等于关掉阻尼。 |
| `safeFallback` | `low` \| `high` \| `max` | `high` | 会话投影读不到、或难度输入解析失败时使用的档位。 |
| `difficulty.complexKeywords` | string[] | 见下 | 命中后先把分数抬到至少 `0.55`，再 `+0.10`。 |
| `difficulty.heavyKeywords` | string[] | 见下 | 命中 `+0.10`。 |
| `difficulty.simpleKeywords` | string[] | 见下 | 命中后分数 `× 0.7`。 |
| `difficulty.trivialKeywords` | string[] | 见下 | 命中且 `len < 60` 时，分数取 `min(score × 0.3, 0.2)`。 |
| `models` | map | `{}` | 按 `provider/model` 覆盖模型能力；每项可写 `vision`、`thinking`、`efforts`（`false` 或档位数组）、`contextWindow`。 |

关键词默认值：

```yaml
complexKeywords: [重构, 架构, 设计, 调试, 排查, 迁移, 性能, 并发, 安全,
                  refactor, design, debug, migrate, optimize, rewrite,
                  从零, from scratch, 实现, implement]
heavyKeywords:   [全部, 整个, 全量, 端到端, complete, entire, whole, all, full, end-to-end]
simpleKeywords:  [读, 查, 看, 列, 搜, 找, 读取, 显示, read, show, list, print, cat]
trivialKeywords: [谢谢, 好的, 收到, 明白, ok, okay, thanks, 继续, 接着, next, continue]
```

配置示例：

```yaml
config:
  level: auto
  allowDowngrade: true
  allowUpgrade: true          # 复杂任务允许上 max
  hysteresisSteps: 2
  safeFallback: high
  difficulty:
    complexKeywords: [重构, 架构, refactor, 从零, implement]
```

上游原有字段 `takeover`、`takeoverUi`、`defaultPricing` 原样保留；它们与调度正交，文档见上游项目。

### 手动覆盖

模型选择器的选择永远压过调度器：选 `off`、`on`、`minimal`、`low`、`medium`、`high`、`xhigh` 或 `max`，
就用这个线上档位。单条消息也能强制——写 `[effort: low]`、`[effort: high]` 或 `[effort: max]`
（方括号可省，大小写不敏感），该请求直接绕过难度判定。

## 难度算法

### 输入

| 输入 | 来源 | 说明 |
|---|---|---|
| `message` | 本轮最新用户消息 | 截断到 4000 字符；多段 text 拼接 |
| `attachments` | 本轮附件数 | 只计数量，不读内容 |
| `priorErrors` | 本轮工具结果 | 带 `error` / `isError` 的结果 |
| `toolCount` | 本轮工具调用数 | 全部调用，不只是抽样窗口里的 |

### 第一步：显式标记优先

消息里出现带括号的 `effort` 标记——`[effort: high]`、`{effort=max}`、`【EFFORT = low】`——且值是
`off`、`low`、`high`、`max` 之一时，判定立刻结束：难度记为 `explicit`、分数 `1.0`，并采用消息要求的档位。

### 第二步：按消息长度给基础分

`len` 取消息去掉首尾空白后的长度。

| `len` | 基础分 |
|---|---|
| `< 8` | `0.05` |
| `< 30` | `0.15` |
| `< 80` | `0.30` |
| `< 200` | `0.45` |
| `< 500` | `0.60` |
| `≥ 500` | `0.75` |

命中记为 `len:<n>`。

### 第三步：关键词类别

大小写不敏感的子串匹配。权重每类只加一次（「这是个重构任务」是一个信号，不是三个），但命中的每个词都会记进
`reasons[]`。

| 类别 | 效果 | 理由标签 |
|---|---|---|
| complex | `score = max(score, 0.60)`，再 `+0.10` | `kw:<词>` |
| heavy | `+0.10` | `kw:<词>` |
| action | 命中 `≥ 2` 个 → `score = max(score, 0.70)`；恰好 1 个且 `len ≥ 40` → `max(score, 0.50)` | `act:<词>` |
| orchestration | 命中 `≥ 1` 个且 `len ≥ 40` → `score = max(score, 0.70)` | `orch:<词>` |
| simple | `score × 0.7`，仅在没有任何"昂贵"类别命中时生效 | `kw:<词>` |
| trivial | 仅当 `len < 60` 且没有"昂贵"类别命中：`score = min(score × 0.3, 0.2)` | `kw:<词>` |

**动作词（action）** 是一句指令里"要动手做什么"的动词（`新建`、`搭建`、`实现`、`发布`、`迁移`、
`审查`、`修复`、`refactor`、`implement`、`publish`…）；**编排词（orchestration）** 表示多智能体/并行
意图（`subagents`、`并行`、`指导`、`监督`、`编排`、`端到端`…）。它们存在的理由：一句话里出现两个动作
词（"新建仓库…加入能力"、"指导并监督 subagents"）就是几小时的工程，句子再短也不该按闲聊算。两张表随
包内置，暂未暴露到设置表单。

**廉价信号不得否决昂贵信号。** "昂贵"指：complex、heavy、动作词地板、编排词地板任一命中。此时
`simple` 乘 0.7、`trivial` 乘 0.3、短问句乘 0.8 全部跳过，被抑制的命中仍以 `kw:<词>(suppressed)`
留在 `reasons[]` 里。这就是为什么 `好的，重构一下整个模块` 不会被"好的"压成 `trivial`，
`看看这个架构` 也不会被"看"拉下 `complex` 地板。

### 第四步：结构信号

| 信号 | 判定 | 效果 | 理由标签 |
|---|---|---|---|
| 代码块 | 含 ``` 围栏 | `+0.15` | `code-block` |
| 堆栈/报错 | 粘上来的报错指纹（`traceback`、`error:`、`exception`、源码帧、`panic`） | `+0.20` | `stack-trace` |
| 文件路径 | 出现源码扩展名（`ts`、`tsx`、`js`、`jsx`、`py`、`go`、`rs`、`java`、`json`、`yaml`、`toml`、`md`、`sql`） | `+0.10` | `file-path` |
| 多文件路径 | 一条消息里出现 **≥ 2 个不同**路径 | 再 `+0.10` | `paths:<n>` |
| 步骤清单 | ≥ 2 行编号或项目符号 | `+0.15` | `steps:<n>` |
| 短问句 | 以 `?` 或 `？` 结尾且 `len < 60`，仅在无"昂贵"类别命中时生效 | `× 0.8` | `short-question` |

### 第五步：上下文信号

| 信号 | 条件 | 效果 | 理由标签 |
|---|---|---|---|
| 附件 | `attachments > 0` | `+0.05` | `attachments` |
| 工具多 | `toolCount ≥ 6` | `+0.10` | `tool-count` |
| 工具报错 | `priorErrors ≥ 1` | `+0.15` | `tool-error` |
| 反复报错 | `priorErrors ≥ 3` | 再 `+0.10` | `tool-error:repeated` |

### 第六至七步：收敛与分档

分数先 clamp 到 `[0, 1]`，再分档：

| 分数 | 难度 |
|---|---|
| `< 0.25` | `trivial` |
| `< 0.45` | `simple` |
| `< 0.70` | `moderate` |
| `≥ 0.70` | `complex` |

### 难度 → 基准档位

| 难度 | 基准档位 |
|---|---|
| `trivial` | `low` |
| `simple` | `low` |
| `moderate` | `high` |
| `complex` | `allowUpgrade` 打开时 `max`，否则 `high` |
| `explicit` | 直接注入消息要求的档位（绕过调度器） |

### 工具修正（只看本轮）

本轮样本至少 2 条时，基准档位才可能被微调——不会低于 `low`、不会高于 `max`，方向受两个开关约束：

| 条件 | 结果 |
|---|---|
| 简单工具占比 ≥ 75%（参数小）、`allowDowngrade` 打开、基准是 `high` | `low` |
| 最大工具参数 ≥ 3200 字符、`allowUpgrade` 打开 | `max`（与降档同时命中时以它为优先） |
| 样本不足 2 条 | 基准档位不变 |

### 迟滞

调度器记住该会话上一次发出的档位。不同档位要在连续 `hysteresisSteps` 次请求里被提出才会被采纳；与当前
档位一致的一次决策会取消待定候选，所以 `high`/`low` 交替出现时永远不会切档。每个会话的第一次决策直接生效。
想要纯粹的逐请求行为，把 `hysteresisSteps` 设为 `1`。

### 一个算例

`帮我重构 src/auto-schedule-projection.ts 的缓存层，附上报错：TypeError at index.ts:42`

- 长度约 70 → 基础分 `0.30`
- 命中 complex（`重构`）→ `max(0.30, 0.55) + 0.10 = 0.65`
- `file-path` → `0.75`，`stack-trace` → `0.95`
- clamp 后 `0.95` → `complex` → `max`（`allowUpgrade` 打开时），否则 `high`
- 理由：`['len:70', 'kw:重构', 'file-path', 'stack-trace']`

## 本 fork 改了什么

1. **难度来自 prompt。** 分类器先读本轮最新用户消息；工具历史只是修正项，不再当主信号。
2. **按轮次隔离。** 工具样本按 turn 切窗，新提问到来即清空，长会话不会把上一轮的「便宜」或「沉重」带进下一题。
3. **兜底方向安全。** 投影读取失败或解析失败落到 `high`（`safeFallback` 可配），而不是掉到 `low`。
4. **Clamp 就近向下。** 模型没广告目标档位时，AUTO 路径往最近的更低档找，而不是跳到最高档。
5. **迟滞防抖。** `hysteresisSteps`（默认 2）让线上档位不会在相邻请求间来回跳。
6. **工具名适配 Windows。** `pwsh`、`shell`、`powershell`、`apply_patch` 与 Unix 系工具名一样被认作简单工具。
7. **自定义 wire 档位保留。** 用户选的档位若映射到自定义 wire 值（例如 `ultra`），原样透传，不被归一化吞掉。
8. **决策可解释。** 每次决策都把 `reasons[]`（`len:`、`kw:`、`code-block`、`stack-trace`、`tool-error` 等）
   带进日志，档位出乎意料时能追到是哪个信号推高了它。

## 已知限制

- **本质是启发式。** 长度与关键词阈值会把「很长但很简单」的 prompt 读成 `moderate` 或 `complex`。
  猜错时调关键词、钉死档位，或用 `[effort: …]` 标记。
- **默认词表是中英双语。** 其他语言只有在你补充关键词之后才能命中。
- **只看文本。** 附件只贡献 `+0.05`，内容不参与分类。
- **每轮最多 8 条样本。** 工具修正最多看本轮最后 8 次调用；`toolCount` 仍统计全部。
- **迟滞有代价。** `hysteresisSteps: 2` 时，真正该跳的时候（比如报错风暴从 `low` 直上 `max`）要等两次决策才落地。
- **调度器永不选 `off`。** 关思考只能手动选。
- **宿主支持。** 模型完全不广告推理档位时，该字段根本不会发送。投影注册表不服务的会话（最典型的是进程内
  subagent）**仍然会被判定**：插件从 `agent/pre-step` 捕获人类 prompt，只有在两个来源都没有文本时（goal
  续轮、cron 触发）才退回 `safeFallback`。
- **从上游迁移。** 这是独立的包、独立的组合行，不会替换已安装的 `dsh-thinking-levels`；两个同时跑会争抢
  `reasoningEffort`。先卸掉旧的。

## 开发

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build          # tsc -> lib/，tsdown -> lib/client.js
```

静态插件检查（依赖 dsh-plugin-guide，可选）：

```bash
node <path-to>/dsh-plugin-guide/bin/dsh-plugin-dev.js check --cwd .
```

## 许可与致谢

MIT。本仓库 fork 自
[`drscrewdriver/dsh-thinking-levels` 4.4.8](https://github.com/drscrewdriver/dsh-thinking-levels)，
上游 MIT 原文逐字保留在 [LICENSE](./LICENSE)，并追加了我们的版权行；上游代码与本仓库新增部分的分界
记录在 [NOTICE](./NOTICE)。

感谢 drscrewdriver 的原始插件——宿主接线、客户端 UI 与 settings/volatile 配置管线都来自那里。
内联的鲸鱼娘立绘是 `HanaAyane/dsh-reasoning-effort` 的社区二创，保留时标注了出处（见 [NOTICE](./NOTICE)）。
