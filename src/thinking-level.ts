/**
 * Pure thinking-level decision for dsh-auto-reasoning-effort.
 *
 * The measured bottleneck of tool calls in dsh is the model's THINKING phase
 * (~90% of the wall-clock time for simple tasks), not the tool execution
 * itself. DeepSeek's API exposes `reasoning_effort` in wire levels
 * (off / low / high / max; low shipped 2026-08-13 in dsh rc.7 — rc.6 and
 * older adapters only accept off / high / max).
 *
 * The plugin offers EIGHT standard levels aligned with dsh-thinking-effort's
 * level set, plus the scheduler sentinel:
 * - `off`     : thinking disabled (manual only — never auto-picked).
 * - `on`      : thinking enabled at the model's default strength. Toggle-only
 *               models (Qwen3.6-style) surface Off/On; `on` lifts to the
 *               advertised `high` (or the highest thinking level the model
 *               takes) instead of an exact wire level.
 * - `minimal` / `low` / `medium` / `high` / `xhigh` / `max` : strength
 *   gradients. Each maps to a wire value via the model's `reasoningEfforts`
 *   table (customizable per model — e.g. `high` → `ultra`); levels the model
 *   does not advertise are clamped to its highest thinking level or stripped.
 * - `auto`    : schedule per request from the turn's DIFFICULTY (the user's
 *               message) plus its tool history, between `low` / `high` / `max`
 *               (never `off`, never `auto` itself).
 *
 * The scheduling policy lives here in three pure pieces so it stays testable
 * without a host:
 * - {@link baseEffortFor} maps a difficulty bucket onto a base level;
 * - {@link decideEffort} applies the tool-history fine-tuning on top;
 * - {@link applyHysteresis} damps level flapping across consecutive requests;
 * - {@link clampForAuto} projects the result onto the levels the model really
 *   advertises, preferring DOWNWARD moves (upstream clamped upward, which is
 *   the wrong direction for a cost-saving feature).
 *
 * A request-level guard decides whether an effort may be injected at all:
 * models that do not advertise reasoning metadata (custom openai-completions
 * routes such as Qwen3.6 with no `reasoningEfforts`) must never receive a
 * `reasoningEffort` — dsh rejects it per request with
 * UNSUPPORTED_REASONING_EFFORT. Unsupported fields are stripped, not sent.
 *
 * Kept dependency-free (pure inputs -> output) so the policy is unit-testable
 * in isolation; the plugin host feeds it the live session's recent calls.
 */

import type { Difficulty } from './difficulty.ts'

/** The user-facing thinking levels: the eight standard levels plus the scheduler sentinel. */
export type EffortId = 'off' | 'on' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'

/** Wire levels the auto scheduler may pick (never `off`, never `auto`). */
export type AutoEffort = 'low' | 'high' | 'max'

/**
 * What {@link decideEffort} may return: the auto trio, plus the manual strength
 * gradient when it is passed through untouched.
 *
 * The manual gradient is deliberately NOT folded into `low`/`high` here: a
 * user who picked `medium` or `xhigh` on a gateway that advertises it must keep
 * that exact wire value, and only the caller knows whether the model takes it.
 */
export type DecidedEffort = Exclude<EffortId, 'off' | 'on' | 'auto'>

/** The three auto levels ordered weakest → strongest; the axis `clampForAuto` walks. */
const AUTO_LADDER: readonly AutoEffort[] = ['low', 'high', 'max'] as const

/** The eight standard levels (excluding the `auto` scheduler sentinel). */
export const STANDARD_LEVELS: readonly EffortId[] = [
  'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max',
] as const

/** Runtime guard: is this a level the plugin understands? */
export function isEffortId(value: unknown): value is EffortId {
  return STANDARD_LEVELS.includes(value as EffortId) || value === 'auto'
}

/**
 * Fail-loud config validation: reject an out-of-band level (e.g. a stray
 * value from an old profile) instead of silently injecting it into the
 * model request, where dsh would throw `UNSUPPORTED_REASONING_EFFORT`.
 */
export function assertEffortId(value: unknown, where: string): asserts value is EffortId {
  if (!isEffortId(value)) {
    throw new TypeError(
      `${where}: invalid thinking level ${JSON.stringify(value)} `
      + '(expected off | on | minimal | low | medium | high | xhigh | max | auto)',
    )
  }
}

/** One observed tool call of the current turn. */
export interface ToolCallSample {
  /** Tool name, e.g. 'bash', 'fs_write', 'pwsh', 'mcp__...'. */
  name: string
  /** Approximate argument size in characters (payload heft). */
  argsSize: number
  /**
   * 1-based conversation turn the call belongs to. The projection filters on
   * it so a new prompt starts from an empty window instead of inheriting the
   * previous turn's history (upstream kept one ring across the whole session).
   */
  turn: number
  /** 1-based step within that turn (one model request = one step). */
  step: number
}

/**
 * Tool names that are cheap to reason about: plain file/interpreter plumbing.
 *
 * Windows hosts surface `pwsh`, `shell` and `powershell` where POSIX hosts say
 * `bash`, and dsh's own editor uses `apply_patch` — omitting either family
 * would make the downgrade path unreachable on half the supported hosts.
 * Anchored on a delimiter so look-alikes are not misread: `code` matches
 * `code_read` but not `codebase_search`, `job` matches `job_status` but not
 * `jobs_board`. Kept exported so the rule can be asserted directly.
 */
export const SIMPLE_TOOL_RE = /^(?:fs|bash|terminal|pwsh|shell|powershell|code|text|todo|job|skill|read|list|search|write|grep|glob|edit|ls|cat|rm|mv|cp|touch|mkdir|pwd|head|tail|apply_patch)(?:_|$)/i

/** Above this argument size even a "simple" tool call is real work. */
const SIMPLE_ARGS_LIMIT = 800

/** A single payload this large means the model is digesting/writing a lot. */
const HEAVY_ARGS_LIMIT = 3200

/**
 * Minimum samples before tool history may move the level.
 *
 * One call is noise: the first tool of a turn is almost always a cheap probe,
 * and letting it downgrade the whole turn reintroduces the "everything is
 * simple" defect the difficulty signal was added to fix.
 */
const MIN_TUNE_SAMPLES = 2

/**
 * Base level a difficulty bucket asks for, before tool history is considered.
 *
 * `explicit` never reaches this function in production — the caller overrides
 * with the level the user typed, because a text override is a manual choice.
 * It is mapped to `high` here only so the mapping stays total: a future caller
 * that forgets to branch gets the hub level rather than `undefined`.
 *
 * @param difficulty - the bucket from {@link classifyDifficulty}.
 * @param allowUpgrade - whether `max` is allowed (user preference).
 * @returns the base auto level.
 */
export function baseEffortFor(difficulty: Difficulty, allowUpgrade: boolean): AutoEffort {
  if (difficulty === 'trivial' || difficulty === 'simple') return 'low'
  if (difficulty === 'moderate') return 'high'
  if (difficulty === 'complex') return allowUpgrade ? 'max' : 'high'
  return 'high'
}

/** Everything the scheduler needs to decide one request's level. */
export interface DecideEffortInput {
  /** The user-selected level: a fixed wire level, or `auto` for scheduling. */
  selected: EffortId
  /**
   * Level asked for in the user's message (`[effort: max]`), already mapped
   * from the classifier's `explicit`. `off` is not accepted: it would turn the
   * scheduler into a manual off switch, which the host handles itself.
   */
  explicit?: AutoEffort
  /** Difficulty of this turn (from {@link classifyDifficulty}). */
  difficulty: Difficulty
  /** Tool samples of THIS turn, oldest first (may be empty). */
  recentCalls: readonly ToolCallSample[]
  /** Scheduler preference: may drop below `high`. */
  allowDowngrade: boolean
  /** User preference: may lift above `high` to `max`. */
  allowUpgrade: boolean
}

/**
 * Decide the wire level for the next model request.
 *
 * Rules, in order:
 * 1. An explicit in-message request wins — the user typed it for this turn.
 * 2. A manual selection wins over everything else: `off` / `on` are not wire
 *    levels, so both map to `high` (thinking enabled at the hub); the strength
 *    gradient is returned untouched and left to the caller's clamp.
 * 3. `auto`: start from the difficulty base, then let tool history nudge it.
 *    Fine-tuning needs at least two samples; heavy payloads lift to `max`
 *    before simple payloads may drop to `low` (heavy wins a tie).
 *
 * The result is never `off` and never `auto`.
 *
 * @param input - selection, difficulty, tool samples and the user toggles.
 * @returns the level to inject (before the capability clamp).
 */
export function decideEffort(input: DecideEffortInput): DecidedEffort {
  const { selected, explicit, difficulty, recentCalls, allowDowngrade, allowUpgrade } = input
  if (explicit !== undefined) return explicit
  if (selected !== 'auto') {
    if (selected === 'off' || selected === 'on') return 'high'
    // A manual gradient pick (`low` / `medium` / `xhigh` / `max`) passes
    // through: the caller's clamp decides whether the model can take it.
    // Collapsing `medium` to `high` here would silently drop the user's pick.
    return selected
  }

  const base = baseEffortFor(difficulty, allowUpgrade)
  if (recentCalls.length < MIN_TUNE_SAMPLES) return base

  let simpleCount = 0
  let heaviest = 0
  for (const call of recentCalls) {
    if (SIMPLE_TOOL_RE.test(call.name) && call.argsSize < SIMPLE_ARGS_LIMIT) simpleCount += 1
    if (call.argsSize > heaviest) heaviest = call.argsSize
  }

  // Heavy first: a turn that just produced a 4 KB payload is not "simple"
  // even if most of its calls were listings.
  if (heaviest >= HEAVY_ARGS_LIMIT && allowUpgrade) return 'max'
  if (simpleCount / recentCalls.length >= 0.75 && allowDowngrade && base === 'high') return 'low'
  return base
}

/** Per-session hysteresis memo: the level in force and any pending candidate. */
export interface HysteresisState {
  /** The level currently in force (what the next request keeps using). */
  level: AutoEffort
  /** Candidate waiting to take over; null when there is no candidate. */
  pending: AutoEffort | null
  /** How many consecutive requests have proposed {@link pending}. */
  pendingCount: number
}

/**
 * Damp level flapping between consecutive requests.
 *
 * A single anomalous tool call (one `web_search` in a mostly-cheap turn) used
 * to flip the level for exactly one request and back — the model then paid the
 * higher level once and the user saw the slider jump. A candidate must be
 * proposed on `steps` CONSECUTIVE requests before it takes over.
 *
 * The candidate is tracked explicitly (rather than with a single streak
 * counter) for two reasons:
 * - a decision that agrees with the current level CANCELS the candidate, so
 *   alternating H, L, H, L never switches — a plain counter would keep
 *   accumulating and eventually cross the threshold;
 * - the counter belongs to the candidate, not to the session, so ten stable
 *   requests do not prime a switch that one different request could trigger.
 *
 * `steps <= 1` degenerates to "the first different decision wins", i.e. no
 * hysteresis.
 *
 * @param previous - memo from the previous request, or undefined on the first one.
 * @param next - the decision for this request (from {@link decideEffort}).
 * @param steps - how many consecutive proposals a candidate needs to take over.
 * @returns the memo to store for the next request; its `level` is what to use.
 */
export function applyHysteresis(
  previous: HysteresisState | undefined,
  next: AutoEffort,
  steps: number,
): HysteresisState {
  // First request of a session: adopt immediately. Waiting `steps` requests to
  // pick a level would leave the first one unscheduled (upstream's hub).
  if (previous === undefined) return { level: next, pending: null, pendingCount: 0 }
  // Agreeing with the level in force clears any candidate: a proposal that was
  // interrupted is not "almost adopted".
  if (next === previous.level) return { level: next, pending: null, pendingCount: 0 }

  // A candidate for a different level counts only its own consecutive run; a
  // proposal for yet another level restarts the count at 1.
  const pendingCount = previous.pending === next ? previous.pendingCount + 1 : 1
  if (pendingCount >= steps) return { level: next, pending: null, pendingCount: 0 }
  return { level: previous.level, pending: next, pendingCount }
}

/**
 * Project an auto level onto the levels the model actually advertises.
 *
 * The adapter rejects unadvertised values per request
 * (UNSUPPORTED_REASONING_EFFORT), so a scheduled level has to be remapped.
 * Upstream `clampToEfforts` always took the model's HIGHEST level, which turns
 * a scheduled `low` on an off/high model into `high` — acceptable — but turns
 * `low` on an off/high/max model into `max`, i.e. the cost-saving feature
 * silently buys the most expensive level. This walks the ladder DOWNWARD from
 * the requested level first and only then upward.
 *
 * @param level - the scheduled level.
 * @param efforts - the model's advertised effort ids (any order).
 * @returns the level to inject, or `undefined` when no auto level is offered
 *   (the caller then strips `reasoningEffort` entirely).
 */
export function clampForAuto(level: AutoEffort, efforts: readonly string[]): EffortId | undefined {
  if (efforts.includes(level)) return level
  const index = AUTO_LADDER.indexOf(level)
  for (let lower = index - 1; lower >= 0; lower -= 1) {
    const candidate = AUTO_LADDER[lower]
    if (efforts.includes(candidate)) return candidate
  }
  for (let higher = index + 1; higher < AUTO_LADDER.length; higher += 1) {
    const candidate = AUTO_LADDER[higher]
    if (efforts.includes(candidate)) return candidate
  }
  return undefined
}

/** Narrow a decided level onto the auto trio, for the clamp's type. */
function isAutoEffort(level: DecidedEffort): level is AutoEffort {
  return level === 'low' || level === 'high' || level === 'max'
}

/**
 * Whether a model's resolved metadata advertises reasoning-effort support.
 * dsh resolves `reasoning` to `undefined` for non-reasoning models (e.g. a
 * hand-declared openai-completions route without `reasoningEfforts`), and
 * rejects any requested effort for them per request. An empty efforts list is
 * equally incapable and is treated as unsupported.
 * @param reasoning - the `reasoning` field of a resolved model info.
 * @returns true when the model advertises at least one effort level.
 */
export function reasoningEffortSupported(reasoning: unknown): boolean {
  if (typeof reasoning !== 'object' || reasoning === null) return false
  const efforts = (reasoning as { efforts?: unknown }).efforts
  return Array.isArray(efforts) && efforts.length > 0
}

/** One request-level injection decision. */
export interface EffortInjectionInput {
  /** Whether the target model advertises reasoning-effort support. */
  supportsReasoning: boolean
  /**
   * The level this request was ASKED for: the session's explicit pick (folded
   * from `model/selection`) when present, else the plugin-configured default.
   *
   * Typed `string`, not `EffortId`: a session pick may be a gateway's own wire
   * value (`ultra`) that this plugin does not enumerate, and such an id must be
   * treated as an explicit choice — passed through when the model advertises
   * it, stripped when it does not, never handed to the scheduler. A narrow
   * `EffortId` here forced the call site into a lying cast.
   *
   * Never derive this from the request seed. From dsh 0.1.2-rc.1 on, the host
   * seeds `reasoningEffort` from the previous `request/header` — which is this
   * plugin's own output (`core/agent-loop/src/agent.ts:573-581`). Reading it as
   * a manual pick made `auto` resolve once and then stay frozen for the rest of
   * the session (issue #6, bug 2).
   */
  requested: string
  /**
   * The `reasoningEffort` already present on the request seed (host echo of a
   * previous header, or route inheritance). Used ONLY to recognise the `on`
   * toggle and to strip an inherited effort from a model that cannot take one —
   * never as a manual-pick signal.
   */
  seedEffort: unknown
  /** Tool samples of the current turn, for the auto scheduler. */
  recentCalls: readonly ToolCallSample[]
  /** Scheduler preference: allow the scheduler to drop below `high`. */
  allowDowngrade: boolean
  /** User preference: allow lifting above `high` to `max`. */
  allowUpgrade: boolean
  /** The model's advertised effort ids (including plugin masks like `auto`). */
  efforts: readonly string[]
  /**
   * The model takes only an on/off thinking toggle (Qwen3.6 / mimo-v2.5
   * style): `off` must be stripped (pi-ai expresses it by omitting the effort,
   * not by sending an `off` value), and `on` maps to the advertised `high`
   * level (pi-ai serializes it as enable_thinking, no reasoning_effort).
   */
  toggleOnly: boolean
  /**
   * Difficulty of this turn, used by the auto branch. Defaults to `moderate`
   * (the hub) so an older call site that does not pass it keeps the previous
   * "stay at high unless the user chose otherwise" behaviour.
   */
  difficulty?: Difficulty
  /**
   * In-message request (`[effort: high]`), `off` excluded. Treated like a
   * manual pick: an exact request, passed through when advertised and stripped
   * when not — never clamped to a different strength.
   */
  explicit?: AutoEffort
  /**
   * A level the caller already decided (it ran {@link decideEffort} and
   * {@link applyHysteresis} itself, because the hysteresis memo is per session
   * and this function is stateless). When present the auto branch uses it
   * instead of scheduling again, so the two never disagree.
   */
  autoLevel?: AutoEffort
}

/** The resolved action for one `agent/request`. */
export interface EffortInjectionDecision {
  /** Keep/inject a `reasoningEffort` on the request (false = strip it). */
  inject: boolean
  /**
   * The wire value to set, present when `inject` is true.
   *
   * `string` rather than `EffortId`: a manual session pick may be a gateway's
   * custom id (`ultra`) that the plugin does not enumerate, and it must reach
   * the request unchanged when the model advertises it.
   */
  level?: string
}

/**
 * Decide what one model request should do with `reasoningEffort`.
 *
 * - A model without reasoning support never receives the field: dsh would
 *   throw UNSUPPORTED_REASONING_EFFORT, so the seed's inherited effort (from a
 *   previous route or session header) is stripped.
 * - A manual wire selection (`requested`) passes through unchanged when the
 *   model advertises it; an unsupported manual pick is stripped rather than
 *   clamped (the user asked for that exact level).
 * - `on` is the enable-thinking toggle, never a wire level: on a toggle-only
 *   model it injects the advertised thinking level (`high`), which the wire
 *   serializes as enable_thinking without a reasoning_effort; an
 *   effort-capable model does not advertise `on`, so it is stripped.
 * - `auto` resolves through the difficulty-aware scheduler; the result is
 *   clamped DOWNWARD-first to the model's advertised levels, so a scheduled
 *   `low` on a model that only takes off/high (Qwen3.6) becomes `high`, while
 *   a scheduled `low` on an off/low/high/max model stays `low` instead of
 *   being lifted to `max`.
 *
 * The manual/auto branch reads `requested` only. The seed no longer influences
 * it, so a header echoed back by the host cannot masquerade as a user pick.
 *
 * @param input - model capability plus the requested level and the seed's effort.
 * @returns whether to inject and the level to set.
 */
export function resolveEffortInjection(input: EffortInjectionInput): EffortInjectionDecision {
  const { supportsReasoning, requested, efforts, toggleOnly } = input
  if (!supportsReasoning) return { inject: false }
  if (toggleOnly) {
    // Toggle-only model (Qwen3.6 / mimo-v2.5 style): thinking is an on/off
    // switch expressed through the provider's enable_thinking semantics.
    // - Off → inject `off`: the provider maps it to thinking disabled.
    // - On / any other request → inject `high` (the advertised toggle level):
    //   the short-circuit adapter serializes a non-off effort as
    //   enable_thinking true — an explicit "thinking on" signal the wire needs.
    //   (A request with NO effort at all is the ambiguous case: leaving it
    //   absent relies on the provider default, which some gateways read as off.)
    return { inject: true, level: requested === 'off' ? 'off' : 'high' }
  }
  if (requested === 'on' || input.seedEffort === 'on') {
    // A stray On on an effort-capable model: never a wire level, stripped.
    return { inject: false }
  }
  if (requested !== 'auto') {
    // A manual pick is the user asking for that exact level: pass it through
    // only when the model advertises it, strip it otherwise (no clamping of an
    // explicit choice).
    return efforts.includes(requested)
      ? { inject: true, level: requested }
      : { inject: false }
  }
  if (input.explicit !== undefined) {
    // The message itself asked for a level: same contract as a manual pick —
    // exact when advertised, stripped when not.
    return efforts.includes(input.explicit)
      ? { inject: true, level: input.explicit }
      : { inject: false }
  }
  const scheduled = input.autoLevel ?? decideEffort({
    selected: 'auto',
    difficulty: input.difficulty ?? 'moderate',
    recentCalls: input.recentCalls,
    allowDowngrade: input.allowDowngrade,
    allowUpgrade: input.allowUpgrade,
  })
  // A scheduled level is always one of the trio; the guard only satisfies the
  // type system (the wider `DecidedEffort` exists for the manual passthrough).
  const clamped = isAutoEffort(scheduled) ? clampForAuto(scheduled, efforts) : undefined
  return clamped === undefined ? { inject: false } : { inject: true, level: clamped }
}

/** Wall-clock delta of one tool call, for the timing telemetry. */
export function toolDurationMs(startedAt: number, finishedAt: number): number {
  return Math.max(0, finishedAt - startedAt)
}

/* ── effort slider ordering & placement (client face, kept pure for tests) ── */

/**
 * Display rank of the effort slider stops: `auto` is the scheduler sentinel and
 * sits LEFTMOST regardless of whether the model allows disabling thinking;
 * `off` / `on` follow, then the strength gradient. Ids outside the standard set
 * (custom gateway wire values such as `ultra`) rank last, in arrival order.
 */
export const EFFORT_SLIDER_RANK: Readonly<Record<string, number>> = {
  auto: 0, off: 1, on: 2, minimal: 3, low: 4, medium: 5, high: 6, xhigh: 7, max: 8,
} as const

/** Fallback rank for ids outside the standard table. */
const EFFORT_SLIDER_RANK_TAIL = 100

/**
 * Order a model's advertised efforts for the slider track (left → right).
 * Stable sort: unknown ids keep their relative arrival order after the known
 * ranks, so a gateway's custom wire values are never dropped or reordered
 * against each other.
 */
export function orderEffortsForSlider<T extends { id: string }>(efforts: readonly T[]): T[] {
  return [...efforts].sort((a, b) => {
    const rankA = EFFORT_SLIDER_RANK[a.id] ?? EFFORT_SLIDER_RANK_TAIL
    const rankB = EFFORT_SLIDER_RANK[b.id] ?? EFFORT_SLIDER_RANK_TAIL
    return rankA - rankB
  })
}

/**
 * Map the line's effective effort to a stop index of the ordered track: exact
 * id match wins; an unmatched id (e.g. a defaultEffort the track does not
 * advertise) parks on the nearest stop by display rank, ties resolving to the
 * stronger level (higher index); an absent value parks on stop 0 (the neutral
 * left end — `auto` when advertised) and an empty track always yields 0, so the
 * caller never faces an out-of-range thumb.
 */
export function nearestEffortStopIndex(
  stops: readonly { id: string }[],
  value: string | undefined,
): number {
  if (stops.length === 0) return 0
  if (value === undefined) return 0
  const exact = stops.findIndex(stop => stop.id === value)
  if (exact >= 0) return exact
  const rank = EFFORT_SLIDER_RANK[value] ?? EFFORT_SLIDER_RANK_TAIL
  let best = 0
  let bestDistance = Number.POSITIVE_INFINITY
  stops.forEach((stop, index) => {
    const stopRank = EFFORT_SLIDER_RANK[stop.id] ?? EFFORT_SLIDER_RANK_TAIL
    const distance = Math.abs(stopRank - rank)
    // `<=` resolves ties toward the stronger (right-most) level.
    if (distance <= bestDistance) {
      bestDistance = distance
      best = index
    }
  })
  return best
}
