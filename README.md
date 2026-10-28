# dsh-auto-reasoning-effort

**Difficulty-driven reasoning effort for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness).**

Pick **Auto** in the session model selector and the plugin chooses a `reasoning_effort` wire level —
`low`, `high` or `max` — for *this* request, based on how hard the current task actually looks: the
prompt you just sent, plus the tool activity of the current turn. A one-line lookup stays cheap; a
refactor with a stack trace gets the heavy setting. You can still pin any wire level by hand.

- [中文 README](./README.zh.md)
- [Installation guide](./INSTALL.md) · [中文安装指南](./INSTALL.zh.md)
- [Changelog](./CHANGELOG.md)

> **A fork, not a rename.** This project starts from
> [`dsh-thinking-levels` 4.4.8](https://github.com/drscrewdriver/dsh-thinking-levels) (MIT,
> © 2026 drscrewdriver) and replaces its scheduling signal: upstream schedules from the session-wide
> tool-call history, this fork classifies the **task's difficulty** first and uses tool activity only
> as a correction. Upstream copyright is preserved — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).

## Why bother

In a multi-step agent run the model re-thinks before every tool call, and that thinking phase
dominates wall-clock time. A fixed `high` wastes minutes on `cat package.json`; a fixed `low`
under-thinks a migration. The useful signal is not "how many tools ran" but "how hard is what the
user is asking". This plugin makes that the primary input.

## What it does

On every `agent/request` the plugin:

1. takes the latest user message of the current turn and classifies its difficulty
   (`trivial` / `simple` / `moderate` / `complex`, plus an explicit override),
2. maps the difficulty to a base level (`low` / `high` / `max`),
3. optionally nudges it by this turn's tool samples (only when the turn has at least two samples),
4. applies hysteresis so the level does not flap between requests,
5. clamps to a level the model actually advertises — preferring the nearest **lower** one,
6. injects the result as `reasoningEffort`, and logs the decision with its reasons.

If a manual level was chosen (in the model selector, in the plugin's `level` config, or by an
`[effort: …]` marker in the message), that wins and the scheduler is skipped.

## Relationship to upstream `dsh-thinking-levels`

This repository is a fork of
[`drscrewdriver/dsh-thinking-levels` 4.4.8](https://github.com/drscrewdriver/dsh-thinking-levels)
(MIT, © 2026 drscrewdriver), not a continuation of its release line. The upstream MIT text is kept
verbatim in [LICENSE](./LICENSE) with our copyright line appended, and [NOTICE](./NOTICE) spells out
which files are upstream work and which are ours. Upstream history through 4.4.8 stays in the
[upstream changelog](https://github.com/drscrewdriver/dsh-thinking-levels/blob/main/CHANGELOG.md).

What changed is the scheduling semantics: upstream schedules from the session-wide tool history and
leaves the rest of the pipeline alone; we classify the task's difficulty first, demote tool history
to a correction, and land the eight fixes listed below. The client UI, the settings/volatile-config
plumbing and the takeover/pricing helpers are upstream work, carried over unchanged.

Thanks to drscrewdriver for the original plugin.

## How it differs from dsh-thinking-levels

| | `dsh-thinking-levels` 4.4.8 (upstream) | `dsh-auto-reasoning-effort` (this fork) |
|---|---|---|
| Primary signal | session-wide tool-call history | difficulty of the current prompt (length, keywords, structure, errors) |
| Sample window | one ring buffer for the whole session | isolated per turn; a new prompt clears the window |
| Failure behavior | falls back to a low level | falls back to `high` (`safeFallback`), never silently cheapens the task |
| Unsupported level | clamps to the highest advertised level | clamps to the nearest **lower** advertised level |
| Flapping | no damping | `hysteresisSteps` (default 2): the level moves only after N consecutive identical decisions |
| Simple tool matcher | Unix-flavored names | adds `pwsh`, `shell`, `powershell`, `apply_patch` |
| Custom wire ids (`ultra`, …) | can be swallowed by clamping | preserved when the model advertises them |
| Explainability | level only | `reasons[]` per decision (e.g. `len:812`, `kw:重构`, `stack-trace`) |

## Installation

Requirements: Node.js 22.19+ (or 24+), a DSH build from the peer range declared in
`package.json` (the 14 rc terms up to `0.2.1-rc.3`), and the `dsh` CLI (pnpm 11 ships with it).

**1. From GitHub (source; runs the build through `prepare`)**

```bash
dsh plugin --profile web add github:lion231226/dsh-auto-reasoning-effort
```

**2. From npm (prebuilt `lib/`, no build step)**

```bash
dsh plugin --profile web add dsh-auto-reasoning-effort
```

**3. From dsh-market (GUI)**

Open the dsh-market plugin browser, search `dsh-auto-reasoning-effort` and install it. If the
entry is not listed yet, use one of the CLI channels above.

Then restart the host — a running `dsh web` process does not hot-load a new bundle layer:

```bash
dsh web
```

Notes that save time:

- The **web** profile is a pnpm workspace root; if `dsh plugin add` complains about the workspace,
  append `-w` to the command.
- A GitHub install executes the package's `prepare` script. pnpm ≥ 10 blocks dependency build
  scripts by default and asks you to approve `dsh-auto-reasoning-effort` in the profile's
  `pnpm-workspace.yaml` (`allowBuilds`). Install from npm or a packed tarball if you would rather not
  grant that.
- The composition row and the npm package share the name `dsh-auto-reasoning-effort`; a profile
  override targets the row id `dsh-auto-reasoning-effort`.
- Remove an installed `dsh-thinking-levels` before installing this one — two schedulers writing
  `reasoningEffort` on the same request will fight.

Full prerequisites, verification and troubleshooting: [INSTALL.md](./INSTALL.md).

## Configuration

Two surfaces share one schema: the plugin row's `config:` in the profile composition
(`cordis.yml`), and the Settings → Plugins form generated from the plugin's `.volatile()` schema
fields (`enabled`, `level`, `allowDowngrade`, `allowUpgrade`, `hysteresisSteps`, `safeFallback`) —
those apply to the next request without a restart. Keyword lists and `models` are configurer-level:
edit the composition.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Master switch. When off, the plugin injects nothing. |
| `level` | `off` \| `on` \| `minimal` \| `low` \| `medium` \| `high` \| `xhigh` \| `max` \| `auto` | `auto` | Default level when the session picks nothing. `auto` means "schedule per request". |
| `allowDowngrade` | boolean | `true` | Let the scheduler pick `low` when the task is easy or the turn is dominated by simple tools. |
| `allowUpgrade` | boolean | `false` | Let the scheduler pick `max` for `complex` tasks and heavy tool payloads. Off caps complex work at `high`. |
| `hysteresisSteps` | integer 1–10 | `2` | Number of consecutive identical decisions required before the wire level actually moves. `1` disables damping. |
| `safeFallback` | `low` \| `high` \| `max` | `high` | Level used when the session projection cannot be read or the difficulty input fails to parse. |
| `difficulty.complexKeywords` | string[] | see below | A hit raises the score to at least `0.55`, then adds `+0.10`. |
| `difficulty.heavyKeywords` | string[] | see below | A hit adds `+0.10`. |
| `difficulty.simpleKeywords` | string[] | see below | A hit multiplies the score by `0.7`. |
| `difficulty.trivialKeywords` | string[] | see below | A hit with `len < 60` sets the score to `min(score × 0.3, 0.2)`. |
| `models` | map | `{}` | Per-model capability overrides keyed `provider/model`; each entry may set `vision`, `thinking`, `efforts` (`false` or a level array) and `contextWindow`. |

Keyword defaults:

```yaml
complexKeywords: [重构, 架构, 设计, 调试, 排查, 迁移, 性能, 并发, 安全,
                  refactor, design, debug, migrate, optimize, rewrite,
                  从零, from scratch, 实现, implement]
heavyKeywords:   [全部, 整个, 全量, 端到端, complete, entire, whole, all, full, end-to-end]
simpleKeywords:  [读, 查, 看, 列, 搜, 找, 读取, 显示, read, show, list, print, cat]
trivialKeywords: [谢谢, 好的, 收到, 明白, ok, okay, thanks, 继续, 接着, next, continue]
```

Example composition:

```yaml
config:
  level: auto
  allowDowngrade: true
  allowUpgrade: true          # allow `max` on complex tasks
  hysteresisSteps: 2
  safeFallback: high
  difficulty:
    complexKeywords: [重构, 架构, refactor, 从零, implement]
```

The upstream fields `takeover`, `takeoverUi` and `defaultPricing` are retained unchanged; they are
orthogonal to scheduling and documented by the upstream project.

### Manual override

The model-selector pick always outranks the scheduler: choose `off`, `on`, `minimal`, `low`,
`medium`, `high`, `xhigh` or `max` and that wire level is used as-is. A single message can also
force a level — write `[effort: low]`, `[effort: high]` or `[effort: max]` (brackets optional,
case-insensitive) and that request bypasses difficulty classification.

## Difficulty algorithm

### Inputs

| Input | Source | Notes |
|---|---|---|
| `message` | latest user message of the current turn | truncated to 4000 chars; text parts concatenated |
| `attachments` | current turn | count only — attachment contents are not read |
| `priorErrors` | current turn's tool results | tool results carrying `error` / `isError` |
| `toolCount` | current turn | all tool calls, not just the sampled window |

### Step 1 — explicit marker wins

If the message matches a bracketed `effort` marker — `[effort: high]`, `{effort=max}`, `【EFFORT =
low】` — with one of `off`, `low`, `high`, `max`, the classification stops immediately with difficulty
`explicit`, score `1.0` and the requested level.

### Step 2 — base score from message length

`len` is the trimmed length of the message.

| `len` | Base score |
|---|---|
| `< 8` | `0.05` |
| `< 30` | `0.15` |
| `< 80` | `0.30` |
| `< 200` | `0.45` |
| `< 500` | `0.60` |
| `≥ 500` | `0.75` |

The hit is recorded as `len:<n>`.

### Step 3 — keyword classes

Case-insensitive substring match. The weight is applied once per class (being "about refactoring" is
one signal, not three), while every matched word is recorded in `reasons[]`.

| Class | Effect | Reason tag |
|---|---|---|
| complex | `score = max(score, 0.60)`, then `+0.10` | `kw:<word>` |
| heavy | `+0.10` | `kw:<word>` |
| action | `≥ 2` hits → `score = max(score, 0.70)`; exactly 1 hit with `len ≥ 40` → `max(score, 0.50)` | `act:<word>` |
| orchestration | `≥ 1` hit with `len ≥ 40` → `score = max(score, 0.70)` | `orch:<word>` |
| simple | `score × 0.7`, only when no expensive class fired | `kw:<word>` |
| trivial | only when `len < 60` and no expensive class fired: `score = min(score × 0.3, 0.2)` | `kw:<word>` |

**Action** words are the build/change verbs an instruction is made of (`新建`, `搭建`, `实现`, `发布`,
`迁移`, `审查`, `修复`, `refactor`, `implement`, `publish`, …); **orchestration** words signal
multi-agent or parallel intent (`subagents`, `并行`, `指导`, `监督`, `编排`, `端到端`, …). They exist
because two such verbs in one sentence ("新建仓库…加入能力", "指导并监督 subagents") is a multi-hour
job no matter how short the sentence is. Both tables ship as defaults; they are not exposed in the
settings form yet.

**Cheap words never veto expensive ones.** "Expensive" means any of: complex, heavy, an action floor,
an orchestration floor. When one fired, the `simple` multiplier, the `trivial` multiplier and the
short-question penalty are all skipped, and the suppressed hits stay visible in `reasons[]` as
`kw:<word>(suppressed)`. This is why `好的，重构一下整个模块` stays `complex` instead of collapsing to
`trivial`, and why `看看这个架构` keeps its `complex` floor.

### Step 4 — structural signals

| Signal | Detection | Effect | Reason tag |
|---|---|---|---|
| code block | contains a ``` fence | `+0.15` | `code-block` |
| stack trace | a pasted failure fingerprint (`traceback`, `error:`, `exception`, a source frame, `panic`) | `+0.20` | `stack-trace` |
| file path | a source-file extension (`ts`, `tsx`, `js`, `jsx`, `py`, `go`, `rs`, `java`, `json`, `yaml`, `toml`, `md`, `sql`) | `+0.10` | `file-path` |
| several paths | two or more *distinct* paths in one message | another `+0.10` | `paths:<n>` |
| step list | two or more numbered/bulleted lines | `+0.15` | `steps:<n>` |
| short question | ends with `?` or `？` and `len < 60`, only when no expensive class fired | `× 0.8` | `short-question` |

### Step 5 — context signals

| Signal | Condition | Effect | Reason tag |
|---|---|---|---|
| attachments | `attachments > 0` | `+0.05` | `attachments` |
| many tools | `toolCount ≥ 6` | `+0.10` | `tool-count` |
| tool errors | `priorErrors ≥ 1` | `+0.15` | `tool-error` |
| repeated errors | `priorErrors ≥ 3` | another `+0.10` | `tool-error:repeated` |

### Step 6–7 — clamp and bands

The score is clamped to `[0, 1]`, then banded:

| Score | Difficulty |
|---|---|
| `< 0.25` | `trivial` |
| `< 0.45` | `simple` |
| `< 0.70` | `moderate` |
| `≥ 0.70` | `complex` |

### Difficulty → base level

| Difficulty | Base level |
|---|---|
| `trivial` | `low` |
| `simple` | `low` |
| `moderate` | `high` |
| `complex` | `max` when `allowUpgrade`, otherwise `high` |
| `explicit` | the requested level, injected directly (scheduler bypassed) |

### Tool correction (current turn only)

With at least two tool samples in the turn, the base level can be nudged — never below `low`,
never above `max`, and only in directions the two toggles allow:

| Condition | Result |
|---|---|
| ≥ 75% simple tools (small args) and `allowDowngrade` and base is `high` | `low` |
| largest tool args ≥ 3200 chars and `allowUpgrade` | `max` (this wins over the downgrade) |
| fewer than two samples | base level unchanged |

### Hysteresis

The scheduler remembers the last level it emitted for the session. A different level must be proposed
on `hysteresisSteps` consecutive requests before it is adopted; a decision that agrees with the level
in force cancels the pending candidate, so an alternating `high` / `low` pattern never switches. The
first decision of a session is adopted immediately. Set `hysteresisSteps: 1` for pure per-request
behavior.

### Worked example

`帮我重构 src/auto-schedule-projection.ts 的缓存层，附上报错：TypeError at index.ts:42`

- length ≈ 70 → base `0.30`
- complex keyword (`重构`) → `max(0.30, 0.55) + 0.10 = 0.65`
- `file-path` → `0.75`, `stack-trace` → `0.95`
- clamped `0.95` → `complex` → `max` (when `allowUpgrade`), otherwise `high`
- reasons: `['len:70', 'kw:重构', 'file-path', 'stack-trace']`

## What changed in this fork

1. **Difficulty comes from the prompt.** The classifier reads the latest user message first; tool
   history is a correction, not the primary signal.
2. **Turn isolation.** Tool samples are windowed per turn and cleared when a new prompt arrives, so
   a long session does not carry stale cheapness (or stale heaviness) into the next question.
3. **Safe fallback direction.** A failed projection read or a parse failure falls back to `high`
   (configurable via `safeFallback`) instead of degrading to `low`.
4. **Clamp downward.** When the model does not advertise the chosen level, the auto path picks the
   nearest lower level rather than jumping to the highest one.
5. **Hysteresis.** `hysteresisSteps` (default 2) prevents the wire level from flapping between
   adjacent requests.
6. **Windows-aware tool names.** `pwsh`, `shell`, `powershell` and `apply_patch` are recognized as
   simple tools alongside the Unix names.
7. **Custom wire ids survive.** A level the user picked that maps to a custom wire value (for
   example `ultra`) is passed through instead of being normalized away.
8. **Explainable decisions.** Every decision carries `reasons[]` (`len:`, `kw:`, `code-block`,
   `stack-trace`, `tool-error`, …) into the log line, so a surprising level can be traced back to
   the signal that caused it.

## Known limitations

- **It is a heuristic.** Length and keyword thresholds read a long but trivial prompt as `moderate`
  or `complex`. Tune the keyword lists, pin a level, or use an `[effort: …]` marker when the guess
  is wrong.
- **Defaults are Chinese + English.** Substring matching works for other languages only if you add
  your own keywords.
- **Text only.** Attachments contribute `+0.05`; their contents are not classified.
- **Eight samples per turn.** The tool correction sees at most the last eight tool calls of the
  turn; `toolCount` still counts all of them.
- **Hysteresis has a cost.** With `hysteresisSteps: 2`, a genuine jump (say `low` → `max` for an
  error storm) takes two decisions to land.
- **The scheduler never picks `off`.** Disabling thinking is a manual choice only.
- **Host support.** Models that advertise no reasoning effort never receive the field. Sessions the
  projection registry does not serve — in-process subagents, most notably — are still classified: the
  plugin captures the human prompt from `agent/pre-step` and only falls back to `safeFallback` when
  neither source carries text (a goal-continuation round, a cron trigger).
- **Upgrading from upstream.** This is a separate package and a separate composition row; it does
  not replace an installed `dsh-thinking-levels`, and running both would fight over
  `reasoningEffort`. Remove the old one first.

## Development

```bash
pnpm install
pnpm run typecheck
pnpm run test
pnpm run build          # tsc -> lib/, tsdown -> lib/client.js
```

Static plugin check (guidance package, optional):

```bash
node <path-to>/dsh-plugin-guide/bin/dsh-plugin-dev.js check --cwd .
```

## License and acknowledgements

MIT. This repository is a fork of
[`drscrewdriver/dsh-thinking-levels` 4.4.8](https://github.com/drscrewdriver/dsh-thinking-levels);
the upstream MIT text is kept verbatim in [LICENSE](./LICENSE), with our copyright line added, and
[NOTICE](./NOTICE) records the split between upstream code and our additions.

Thanks to drscrewdriver for the original plugin — the host wiring, the client UI and the
settings/volatile-config plumbing come from there. The inlined whale-girl mascot is community
artwork from `HanaAyane/dsh-reasoning-effort`, kept with attribution (see [NOTICE](./NOTICE)).
