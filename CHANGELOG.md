# Changelog

All notable changes to `dsh-auto-reasoning-effort` are recorded here. Entries are one line each
unless a behavioral detail needs a second sentence.

Upstream history (4.4.8 and earlier) lives in the project this fork started from:
<https://github.com/drscrewdriver/dsh-thinking-levels/blob/main/CHANGELOG.md>.

## [0.1.1] — 2026-10-28

Calibration release: real prompts showed the classifier reading multi-hour build instructions as
`simple`/`low`, and subagent sessions were never classified at all.

### Added

- **Action keywords** (`actionKeywords`): build/change verbs (`新建`, `搭建`, `实现`, `发布`, `迁移`,
  `审查`, `修复`, `refactor`, `implement`, `publish`, …). Two hits floor the score at 0.70; one hit
  with `len ≥ 40` floors it at 0.50.
- **Orchestration keywords** (`orchestrationKeywords`): multi-agent/parallel intent (`subagents`,
  `并行`, `指导`, `监督`, `编排`, `端到端`, …). One hit with `len ≥ 40` floors the score at 0.70.
- **Structural signals**: a step list (≥ 2 numbered/bulleted lines) adds `+0.15`; two or more distinct
  file paths add another `+0.10`.
- **Subagent sessions are classified.** `agent/pre-step` captures the human prompt per agent, so a
  session the projection registry does not serve still gets a difficulty decision instead of the hub.
- **Regression fixture** `tests/fixtures/prompts.zh.json`: 16 real prompts with expected bands,
  asserted by the scheduler suite (16/16).

### Changed

- complex-keyword floor `0.55` → `0.60`, so a short `重构这个模块` reaches `complex` (0.70) instead of
  `moderate`.
- Cheap signals (`simple` ×0.7, `trivial` ×0.3, short-question ×0.8) are skipped whenever an expensive
  class fired; suppressed hits stay in `reasons[]` as `<tag>(suppressed)`.
- `planRequestEffort` takes a prompt plus optional turn counters instead of requiring the projection.
- Prompt provenance is logged as `src=projection` / `src=pre-step` / `src=no-prompt`.

### Fixed

- Subagent requests went out at `safeFallback` regardless of their own instruction; they now follow
  the same difficulty policy as the main agent.

## [0.1.0] — 2026-10-28

First release of this fork. The package, the repository and the composition row are
`dsh-auto-reasoning-effort`; the scheduler signal is task difficulty instead of tool history.

### Forked from

- `dsh-thinking-levels` 4.4.8 (MIT, © 2026 drscrewdriver) — upstream copyright and MIT text kept in
  `LICENSE`; the authorship split is recorded in `NOTICE`.

### Added

- Difficulty classifier (`src/difficulty.ts`): explicit `[effort: …]` marker, six-bucket length
  score, four keyword classes, structural signals (code fence, stack trace, file path, short
  question), context signals (attachments, tool count, tool errors), and the
  `trivial` / `simple` / `moderate` / `complex` bands at 0.25 / 0.45 / 0.70.
- Difficulty-to-base-level mapping (`trivial`/`simple` → `low`, `moderate` → `high`,
  `complex` → `max` when upgrades are allowed, else `high`).
- New config fields: `difficulty.*` keyword lists, `hysteresisSteps` (1–10, default 2) and
  `safeFallback` (`low`/`high`/`max`, default `high`); the latter two are volatile and render in the
  host-generated settings form.
- New package entry `./difficulty` exporting the classifier types.
- `NOTICE`, `icon.svg` (difficulty gauge), CI workflow (typecheck / test / build on Node 22).

### Changed (behavior relative to upstream)

- Scheduling signal is the current prompt's difficulty; per-turn tool samples only nudge the result.
- Tool samples are windowed per turn and cleared on a new prompt instead of using a session-wide ring
  buffer.
- A failed projection read or parse falls back to `safeFallback` (`high`) instead of a low level.
- The auto path clamps to the nearest **lower** advertised level instead of the highest one.
- `hysteresisSteps` requires N consecutive identical decisions before the wire level moves.
- The simple-tool matcher also recognizes `pwsh`, `shell`, `powershell` and `apply_patch`.
- Custom wire ids picked by the user (e.g. `ultra`) pass through instead of being normalized away.
- Every decision logs its `reasons[]` (`len:`, `kw:`, `code-block`, `stack-trace`, `tool-error`, …).

### Kept from upstream

- Client UI half (model panel card, effort slider, family tab, context ring), the settings/volatile
  config plumbing, the takeover/pricing helpers, and the build layout.
- The 14-term DSH host enumeration and the wire-level set — no new levels, no dropped ones.

### Compatibility and migration

- Requires a DSH build from the declared peer enumeration (up to `0.2.1-rc.3`) and Node 22.19+/24+.
- This is a separate package and composition row: uninstall `dsh-thinking-levels` before installing
  this one, otherwise both inject `reasoningEffort` for the same request.
