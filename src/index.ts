/**
 * dsh-auto-reasoning-effort host plugin: injects a user-selected or auto-scheduled
 * `reasoning_effort` into every `agent/request` waterfall (levels: off / on /
 * minimal / low / medium / high / xhigh / max / auto), and records per-tool
 * wall-clock durations for telemetry.
 *
 * Model-aware since v0.5.0:
 * - A model that does not advertise reasoning metadata (custom
 *   openai-completions routes such as Qwen3.6 without `reasoningEfforts`)
 *   NEVER receives a `reasoningEffort` — dsh rejects unsupported efforts per
 *   request (UNSUPPORTED_REASONING_EFFORT). Unsupported fields are stripped.
 * - Manual selections pass through unchanged, including `low` on dsh rc.7+
 *   where the level is native. `on` (the enable-thinking toggle) is never a
 *   wire level: on a toggle-only model it injects the advertised `high`
 *   (serialized as enable_thinking, no reasoning_effort); elsewhere it is
 *   stripped.
 * - The auto scheduler never picks `low` (no surprise low injection).
 * - On rc.6-era adapters (efforts without `low`) a configurer-confirmed model
 *   override may advertise `low` so the selector shows it and the passthrough
 *   is admitted by request validation.
 *
 * Extension points used (verified in deepseek-ai/deepseek-harness):
 * - `agent/request` waterfall (packages/core/agent-loop/src/agent.ts
 *   buildRequest): each listener may return a modified GenerateOptions for
 *   the next listener — the sanctioned way to adjust request config.
 * - `session.events` (agent.session) carried the step's tool/call records up to
 *   host 0.1.0-rc.8 only; from 0.1.2-rc.1 on the log is read through the
 *   projection registry instead (`tlAutoSchedule`, issue #6). The deprecated
 *   synchronous readers (`eventAt/snapshotEvents/ownEvents`) are prohibited for
 *   new production calls by `packages/core/session/README.md:62`.
 * - The session's EXPLICIT effort pick is folded from `model/selection` events:
 *   the host seeds `reasoningEffort` from the previous request header (this
 *   plugin's own output), so the seed must never be read as a manual pick.
 * - declarative settings (DSH 0.1.7+): the runtime-adjustable `Config` fields
 *   are marked `.volatile()`, the host generates the settings form from the
 *   schema alone, and the plugin reads the live values per request.
 */
import type { Context } from '@deepseek-ai/cordis'
import type { Volatile } from '@deepseek-ai/cosmokit'
import z from '@deepseek-ai/schemastery'
import {
  applyHysteresis,
  assertEffortId,
  clampForAuto,
  decideEffort,
  reasoningEffortSupported,
  resolveEffortInjection,
  type AutoEffort,
  type DecidedEffort,
  type EffortId,
  type EffortInjectionDecision,
  type HysteresisState,
  type ToolCallSample,
} from './thinking-level.ts'
import { DEFAULT_DIFFICULTY_CONFIG, classifyDifficulty, type DifficultyConfig, type DifficultyResult } from './difficulty.ts'
import { buildBillingDefinition, type PricingPolicy } from './billing-projection.ts'
import { extractUserText } from './session-events.ts'
import {
  EFFORT_DIFFICULTY_KEY,
  buildEffortProjectionDefinition,
  readEffortProjection,
  requestedEffortOf,
} from './auto-schedule-projection.ts'
import { CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN } from './context-window.ts'
import {
  PI_AI_NAMESPACE,
  TAKEOVER_NAMESPACE_CANDIDATES,
  takeoverPatch,
  takeoverRoutesOf,
  withOfficialCompatFixes,
  type PiAiSection,
} from './takeover-sync.ts'
import { describeSettings, readSection, readSectionOf, resolveNamespaceOf } from './settings-read.ts'

/** One configurer-confirmed capability override for a `provider/model` key. */
export interface ModelCapabilityOverride {
  /** Manual override of the vision-model classification (auto: inputModalities). */
  vision?: boolean
  /** Manual override of the thinking-model classification. */
  thinking?: boolean
  /**
   * Manual confirmation of the supported effort levels. `false` marks a
   * non-reasoning model; a list names the levels the API accepts (rc.6-era
   * adapters may then advertise missing ones, e.g. `low`). Absent keeps the
   * adapter-advertised list.
   */
  efforts?: false | Exclude<EffortId, 'auto'>[]
  /**
   * Declared context-window limit in tokens (2000–1_000_000). Declaration-only:
   * the runtime harness reads it from the llm-pi-ai model entry, so this
   * override is a validated config-surface declaration.
   */
  contextWindow?: number
}

/** Plugin settings. */
export interface ThinkingLevelsConfig {
  /** On a DSH 0.1.7+ host the schema's `.volatile()` fields arrive as live refs — read them through `readVolatile`. */
  enabled: boolean | Volatile<boolean>
  /** User-selected level: off / on / minimal / low / medium / high / xhigh / max fix the wire level; `auto` schedules per step. */
  level: EffortId | Volatile<EffortId>
  /** Scheduler preference: allow dropping below the `high` hub. */
  allowDowngrade: boolean | Volatile<boolean>
  /** Scheduler preference: allow lifting above the `high` hub to `max`. */
  allowUpgrade: boolean | Volatile<boolean>
  /**
   * Master takeover switch: mirrored into the openai-completions transport's
   * own section (`llm-openai-completions.enabled`) when it flips. The
   * transport's dispatch judgment stays single-source in ITS section; this
   * flag is the control-layer UI for it.
   */
  takeover: boolean | Volatile<boolean>
  /**
   * UI takeover switch (issues #3/#4): false (default) keeps the official
   * composer model popup — the `auto` mask still arrives through the adapter
   * advertisement below, and the official popup keeps its native search.
   * true seats the plugin's ModelPanel (which carries its own search box and
   * the intent/resolved effort chip).
   */
  takeoverUi: boolean | Volatile<boolean>
  /** Configurer-confirmed capability overrides, keyed `provider/model`. */
  models: Record<string, ModelCapabilityOverride>
  /**
   * 目录外模型的计价兜底档（price-catalog 未命中时生效）：estimate/cn/global/custom/off。
   * 缺省 estimate（典型价兜底估算，显示「未校准·仅供参考」）；off 才是真不计价；
   * 目录内模型自动按条目地区计价，不受本项影响。
   */
  defaultPricing: PricingPolicy | Volatile<PricingPolicy>
  /** Difficulty keyword tables and the classifier's tuning surface (SPEC §2.3). */
  difficulty?: DifficultyConfig
  /**
   * Consecutive identical scheduler proposals required before the level
   * switches (SPEC §3.1). 1 disables hysteresis.
   */
  hysteresisSteps: number | Volatile<number>
  /**
   * Level injected when the difficulty projection cannot be read (SPEC §5.2).
   * The safe direction is the hub, never `low`.
   */
  safeFallback: AutoEffort | Volatile<AutoEffort>
}

const effortId = z.union(['off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])

/** Per-model capability overrides — shared verbatim by both schema faces
 * below (the two must never drift). */
const modelsSchema = z.dict(z.object({
  // schemastery fields are optional unless marked `.required()`.
  vision: z.boolean(),
  thinking: z.boolean(),
  efforts: z.union([z.const(false), z.array(effortId)]),
  contextWindow: z.number().step(1).min(CONTEXT_WINDOW_MIN).max(CONTEXT_WINDOW_MAX),
})).default({})

/** 计价兜底档：schemastery 枚举，两代 schema 共享（the two must never drift）。 */
const defaultPricingSchema = z.union(['estimate', 'cn', 'global', 'custom', 'off']).default('estimate')

/**
 * The difficulty keyword tables (SPEC §2.3), shared by the schema default and
 * `DEFAULT_CONFIG` so the two can never drift.
 *
 * The lists live in `difficulty.ts` (`DEFAULT_DIFFICULTY_CONFIG`) rather than
 * being repeated here: the classifier and the settings surface must show the
 * SAME words, otherwise the status tool would report a table the scorer does
 * not use. Copies are made per call because schemastery may hand one parsed
 * object to several readers, and a caller that sorted a list in place must not
 * reorder the next parse.
 */
const defaultDifficulty = () => ({
  complexKeywords: [...DEFAULT_DIFFICULTY_CONFIG.complexKeywords],
  heavyKeywords: [...DEFAULT_DIFFICULTY_CONFIG.heavyKeywords],
  simpleKeywords: [...DEFAULT_DIFFICULTY_CONFIG.simpleKeywords],
  trivialKeywords: [...DEFAULT_DIFFICULTY_CONFIG.trivialKeywords],
})

/**
 * Module-level fallback handed to `readVolatile` when a host supplies no
 * `difficulty` value at all. Shared on purpose: it is only ever read, and
 * rebuilding four arrays on every `agent/request` would allocate per request
 * for no reason.
 */
const DIFFICULTY_FALLBACK: DifficultyConfig = defaultDifficulty()

/**
 * Difficulty-signal configuration (SPEC §5.3). Deliberately NOT volatile: the
 * keyword tables are a domain-tuning surface, not a per-turn knob, and a live
 * ref would have to be read through on every request for no benefit.
 */
const difficultySchema = z.object({
  complexKeywords: z.array(z.string()).default(DEFAULT_DIFFICULTY_CONFIG.complexKeywords.slice()),
  heavyKeywords: z.array(z.string()).default(DEFAULT_DIFFICULTY_CONFIG.heavyKeywords.slice()),
  simpleKeywords: z.array(z.string()).default(DEFAULT_DIFFICULTY_CONFIG.simpleKeywords.slice()),
  trivialKeywords: z.array(z.string()).default(DEFAULT_DIFFICULTY_CONFIG.trivialKeywords.slice()),
}).default(defaultDifficulty())

/**
 * Hysteresis depth (SPEC §3.1): consecutive proposals a candidate level needs
 * before it takes over. 1 disables hysteresis; 10 is a deliberately slow gear.
 */
const hysteresisStepsSchema = z.number().step(1).min(1).max(10).default(2)

/**
 * Fail-safe level when the projection cannot be read (SPEC §5.2 step 5).
 *
 * `high` (the hub) is the safe direction: a broken projection must not silently
 * downgrade every turn to `low`, which is what upstream did by collapsing an
 * unreadable sampler to "no calls ⇒ low".
 */
const safeFallbackSchema = z.union(['low', 'high', 'max']).default('high')

/**
 * Composition-entry schema: what a dsh profile may configure at assembly
 * time (cordis.yml `config:` of the plugin row). The same schema doubles as
 * the settings surface: DSH 0.1.7 renders the plugin's settings form from the
 * `.volatile()` fields alone (no registration call), and hands `apply` the
 * validated entry with those fields as live `Volatile` refs.
 */
export const Config = z.object({
  enabled: z.boolean().default(true).volatile(),
  level: z.union(['off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']).default('auto').volatile(),
  allowDowngrade: z.boolean().default(true).volatile(),
  allowUpgrade: z.boolean().default(false).volatile(),
  takeover: z.boolean().default(false).volatile(),
  takeoverUi: z.boolean().default(false).volatile(),
  defaultPricing: defaultPricingSchema.volatile(),
  difficulty: difficultySchema,
  hysteresisSteps: hysteresisStepsSchema.volatile(),
  safeFallback: safeFallbackSchema.volatile(),
  models: modelsSchema,
})

/**
 * Legacy (≤0.1.6) settings schema: the same fields WITHOUT the `.volatile()`
 * ref wrappers. The imperative `settings.register` resolver reads schemas
 * literally and rejects the 0.1.7 ref descriptors ("$.enabled expected
 * boolean but got [object Object]", live on cell 0.1.5) — the 3.x compat
 * branches shipped exactly this plain shape.
 */
export const LegacyConfig = z.object({
  enabled: z.boolean().default(true),
  level: z.union(['off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']).default('auto'),
  allowDowngrade: z.boolean().default(true),
  allowUpgrade: z.boolean().default(false),
  takeover: z.boolean().default(false),
  takeoverUi: z.boolean().default(false),
  defaultPricing: defaultPricingSchema,
  difficulty: difficultySchema,
  hysteresisSteps: hysteresisStepsSchema,
  safeFallback: safeFallbackSchema,
  models: modelsSchema,
})

/** Settings defaults, kept in lockstep with the schema defaults above. */
export const DEFAULT_CONFIG: ThinkingLevelsConfig = {
  enabled: true,
  level: 'auto',
  allowDowngrade: true,
  allowUpgrade: false,
  takeover: false,
  takeoverUi: false,
  defaultPricing: 'estimate',
  difficulty: defaultDifficulty(),
  hysteresisSteps: 2,
  safeFallback: 'high',
  models: {},
}

/**
 * The `loader/volatile-update` event is emitted by the DSH 0.1.7+ loader when
 * a `.volatile()` config field changes (no plugin remount). The dev pins
 * predate the event, so the signature is augmented here — mirroring the host
 * runtime, which passes the changed config paths.
 */
declare module '@deepseek-ai/cordis' {
  interface Events {
    'loader/volatile-update': (paths: string[]) => void
  }
}

/**
 * Read a `.volatile()` field: a live `Volatile` ref on a DSH 0.1.7+ host, a
 * plain value otherwise. `get()` may return undefined for an absent value, so
 * the schema default is the fallback.
 */
export function readVolatile<T>(value: T | Volatile<T> | undefined, fallback: T): T {
  if (value !== null && typeof value === 'object' && typeof (value as Volatile<T>).get === 'function') {
    const snapshot = (value as Volatile<T>).get()
    return (snapshot === undefined ? fallback : snapshot) as T
  }
  return (value as T | undefined) ?? fallback
}

/**
 * The live configuration snapshot: the runtime-adjustable fields resolved to
 * plain values (volatile refs read through).
 */
interface LiveConfig {
  enabled: boolean
  level: EffortId
  allowDowngrade: boolean
  allowUpgrade: boolean
  takeover: boolean
  takeoverUi: boolean
  defaultPricing: PricingPolicy
  difficulty: DifficultyConfig
  hysteresisSteps: number
  safeFallback: AutoEffort
  models: Record<string, ModelCapabilityOverride>
}

/**
 * Resolve the live configuration snapshot: the runtime-adjustable fields are
 * read through their (possibly volatile) composition-entry values on every
 * call, so a committed settings change applies to the next request without a
 * plugin remount.
 */
function resolveLiveConfig(config: ThinkingLevelsConfig): LiveConfig {
  return {
    enabled: readVolatile(config.enabled, true),
    level: readVolatile(config.level, 'auto'),
    allowDowngrade: readVolatile(config.allowDowngrade, true),
    allowUpgrade: readVolatile(config.allowUpgrade, false),
    takeover: readVolatile(config.takeover, false),
    takeoverUi: readVolatile(config.takeoverUi, false),
    defaultPricing: readVolatile(config.defaultPricing, 'estimate'),
    difficulty: config.difficulty ?? DIFFICULTY_FALLBACK,
    hysteresisSteps: readVolatile(config.hysteresisSteps, 2),
    safeFallback: readVolatile(config.safeFallback, 'high'),
    models: config.models,
  }
}

/**
 * The `auto` mask shown in the model directory: a user-facing level that is
 * never sent to the API — the plugin resolves it to a wire level per request.
 * It is injected into the adapter's `reasoning.efforts` so the model selector
 * offers it, and `resolveCallFor` accepts it until this plugin's request
 * interceptor substitutes the resolved wire level.
 */
const AUTO_EFFORT: { id: 'auto'; name: 'Auto' } = { id: 'auto', name: 'Auto' }

/**
 * The `low` level, advertised only for configurer-confirmed models whose
 * adapter predates dsh rc.7 (efforts list without `low`). Advertising it makes
 * the selector show Low and the harness request validation admit the
 * passthrough; the adapter must serialize it (pi-ai openai-completions does,
 * e.g. via `thinkingFormat: qwen` → enable_thinking + thinking_budget).
 */
const LOW_EFFORT: { id: 'low'; name: 'Low' } = { id: 'low', name: 'Low' }

/** Minimal face of the llm service's adapter registrations (typed locally to avoid a host-package value import). */
interface LlmRegistration {
  adapter: {
    resolveModel: (provider: string, model: string, signal?: unknown) => Promise<{
      reasoning?: { efforts?: { id: string; name: string }[] }
    }>
  }
}

/**
 * Adapters whose `resolveModel` is already wrapped — the per-adapter
 * idempotence issue #4 proves was missing: re-running the advertisement on
 * every `llm/adapters-updated` stacked a new wrapper per pass, and every
 * stacked layer re-ran the post-processing on each resolveModel call.
 * Keyed on the adapter object itself, so a genuinely new adapter is wrapped
 * once and retired ones need no cleanup.
 */
const advertisedAdapters = new WeakSet<object>()

/**
 * Advertise `auto` (and, for configurer-confirmed rc.6-era models, `low`) in
 * the model directory: wrap every registered adapter's `resolveModel` so the
 * returned `reasoning.efforts` include the extra levels. Idempotent per
 * adapter. `auto` is a mask the plugin resolves per request; `low` is only
 * added when the model override confirms the level, so rc.7+ models (which
 * already advertise low) and unconfirmed models stay untouched.
 *
 * A thinking model WITHOUT effort support (Qwen3.6-style, per the llm-pi-ai
 * config: `reasoningEfforts` present but `compat.supportsReasoningEffort` not
 * true) gets its selector collapsed to a plain On/Off toggle: `off` disables
 * thinking, `on` maps to the `high` level, which pi-ai serializes as
 * `enable_thinking: true` under `thinkingFormat: qwen`. No auto/low masks are
 * offered for these — there is nothing to schedule.
 * @param llm - the resolved `llm` service, when present.
 * @param overrideFor - model override lookup, keyed `provider/model`.
 * @param piAiFor - llm-pi-ai config capability lookup, keyed `provider/model`.
 * (exported for the idempotence regression test, issue #4 — same precedent as
 * `installLegacySection`)
 */
export function advertiseModelCapability(
  llm: { adapters?: Map<string, LlmRegistration> } | undefined,
  overrideFor: (provider: string, model: string) => ModelCapabilityOverride | undefined,
  piAiFor: (provider: string, model: string) => { thinkingOn: boolean; supportsEffort: boolean } | undefined,
): void {
  for (const registration of llm?.adapters?.values() ?? []) {
    const adapter = registration.adapter
    // Issue #4: the re-run on every `llm/adapters-updated` must NOT stack
    // wrappers — each stacked layer re-ran the post-processing (and a full
    // describeSettings) on every resolveModel call. This WeakSet is the
    // idempotence the JSDoc has always promised.
    if (advertisedAdapters.has(adapter)) continue
    advertisedAdapters.add(adapter)
    const original = adapter.resolveModel.bind(adapter)
    adapter.resolveModel = async (provider, model, signal) => {
      const info = await original(provider, model, signal)
      const reasoning = info.reasoning
      if (reasoning === undefined) return info
      const piCap = piAiFor(provider, model)
      if (piCap?.thinkingOn === true && piCap.supportsEffort === false) {
        // Toggle-only model (Qwen3.6 / mimo-v2.5 style): the selector shows
        // Off/On. The On pick MUST be a level the provider's own request path
        // accepts — pi-ai resolves only its fixed seven levels and rejects
        // anything else per stream (`UNSUPPORTED_REASONING_EFFORT`). `high` is
        // that level: because the model declares supportsReasoningEffort:
        // false, pi-ai serializes a non-off effort as enable_thinking only —
        // no reasoning_effort is sent, which is exactly the toggle semantics.
        info.reasoning = {
          ...reasoning,
          efforts: [
            { id: 'off', name: 'Off' },
            { id: 'high', name: 'On' },
          ],
        }
        return info
      }
      const efforts = [...(reasoning.efforts ?? [])]
      if (!efforts.some(effort => effort.id === 'auto')) efforts.push(AUTO_EFFORT)
      const override = overrideFor(provider, model)
      if (
        override?.efforts !== undefined
        && override.efforts !== false
        && override.efforts.includes('low')
        && !efforts.some(effort => effort.id === 'low')
      ) {
        efforts.push(LOW_EFFORT)
      }
      info.reasoning = { ...reasoning, efforts }
      return info
    }
  }
}

/* ───────────────── difficulty-driven request planning ───────────────── */

/**
 * Narrow a scheduler decision onto the auto trio.
 *
 * {@link decideEffort} returns the wider `DecidedEffort` because the manual
 * branch can pass `minimal` / `medium` / `xhigh` through. The `selected: 'auto'`
 * path — the only one used here — returns `baseEffortFor` / tool tuning
 * results, i.e. always one of `low` / `high` / `max`; the fallback keeps the
 * function total instead of casting the type system away.
 */
function asAutoEffort(level: DecidedEffort): AutoEffort {
  return level === 'low' || level === 'high' || level === 'max' ? level : 'high'
}

/** Where one step's human prompt came from. */
export type PromptSource = 'projection' | 'pre-step' | 'no-prompt'

/** The human prompt of one step plus its provenance (for logs and the status tool). */
export interface StepPrompt {
  /** The prompt text; `''` when no source had any. */
  prompt: string
  /** Which source supplied {@link prompt}. */
  source: PromptSource
}

/**
 * Last human prompt of one `agent/pre-step` message batch.
 *
 * `agent/pre-step` runs once per STEP, and a turn has several steps: only the
 * first one carries the human prompt, later ones carry tool results (and
 * synthetic `agent.inject()` context). Hence:
 * - the LAST `source.kind === 'user'` message wins, because a batch may hold
 *   several queued messages and the freshest one is what this request is about;
 * - `undefined` means "this batch has no human message at all" — the caller
 *   must then KEEP the prompt captured at the turn's first step;
 * - a human message with no text yields `''` (an image-only prompt), which is
 *   deliberately different from `undefined`: it must REPLACE the cached prompt
 *   so a previous turn's text cannot leak into this one.
 *
 * Synthetic producers (`skill-invocation`, `tool-registry`, `model-selection`,
 * `user-approval`, …) are skipped: a skill body is thousands of characters of
 * prose and would classify as `complex`, turning every injected context into a
 * `max` request.
 *
 * @param messages - the `messages` field of the `agent/pre-step` payload (any shape).
 * @returns the prompt text (possibly `''`), or undefined when no human message exists.
 */
export function humanPromptOf(messages: unknown): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (typeof message !== 'object' || message === null) continue
    const source = (message as { source?: unknown }).source
    if (typeof source !== 'object' || source === null) continue
    if ((source as { kind?: unknown }).kind !== 'user') continue
    // `extractUserText` handles both `content` wire forms and owns the 4000 cap.
    return extractUserText(message)
  }
  return undefined
}

/**
 * Resolve the human prompt for one request from the two available sources.
 *
 * The projection is the authoritative per-turn view: it also carries the tool
 * counters, and it is the ONLY source that knows about a session's explicit
 * effort pick. The `agent/pre-step` cache is the fallback for sessions the
 * projection registry does not serve — most importantly a subagent session
 * created in-process by `subagent-spawn-in-process`, whose `request/header` used
 * to go out at `safeFallback` because the projection was `undefined`.
 *
 * A projection that exists but holds no text (a goal continuation round, a cron
 * trigger, an entirely synthetic turn) is treated the same as an absent one:
 * the pre-step cache gets its chance before the hub fallback.
 *
 * @param projectionText - `latestUserText` of the folded state, `''` when absent.
 * @param preStepText - the cached prompt from `agent/pre-step`, when any.
 * @returns the prompt to classify plus where it came from.
 */
export function resolveStepPrompt(projectionText: string, preStepText: string | undefined): StepPrompt {
  if (projectionText.trim().length > 0) return { prompt: projectionText, source: 'projection' }
  if (typeof preStepText === 'string' && preStepText.trim().length > 0) {
    return { prompt: preStepText, source: 'pre-step' }
  }
  return { prompt: '', source: 'no-prompt' }
}

/** What one `agent/request` should try to inject, and why. */
export interface RequestEffortDecision {
  /**
   * The original intent: `'auto'` when the request is to be scheduled, or the
   * id the user/config asked for. Kept verbatim — a gateway's custom wire id
   * (`ultra`) is a real user choice, not an unknown level to discard — so it is
   * `string` rather than {@link EffortId}.
   */
  intent: string
  /**
   * The level to hand to {@link resolveEffortInjection} as its `requested`
   * (manual) input — already clamped onto the model's advertised levels.
   * `undefined` means the auto path found no advertised level at all, so the
   * caller must strip `reasoningEffort`.
   */
  requested: string | undefined
  /** Post-hysteresis auto level, before the capability clamp (logging only). */
  autoLevel?: AutoEffort
  /** Classifier output, when the auto path ran (logging + status tool). */
  result?: DifficultyResult
  /** Hysteresis memo to persist for this session (auto scheduling path only). */
  hysteresis?: HysteresisState
  /** The decision came from a manual intent: session pick, config lock, or `[effort: x]`. */
  manual: boolean
  /**
   * No usable evidence drove the level: neither the projection nor the
   * `pre-step` cache held a human prompt. The level is then the safe hub,
   * deliberately NOT `low`.
   */
  fallback: boolean
}

/**
 * Everything {@link decideRequestEffort} reads.
 *
 * Deliberately source-agnostic: `prompt` arrives already resolved by
 * {@link resolveStepPrompt}, so the scheduler can run on a projection-backed
 * session and on a `pre-step`-only session (subagents) with the same code path.
 */
export interface RequestEffortDecisionInput {
  /**
   * The level the request was asked for: `'auto'` to schedule, or the concrete
   * id the session/config picked (see `requestedEffortOf`).
   */
  intent: string
  /** Human prompt of this step (from {@link resolveStepPrompt}). */
  prompt: string
  /** Tool samples of this turn, oldest first; empty on the `pre-step` path. */
  samples?: readonly ToolCallSample[]
  /** Tool calls already seen in this turn. */
  toolCount?: number
  /** Failed tool results already seen in this turn. */
  errors?: number
  /** Difficulty keyword tables. */
  difficulty: DifficultyConfig
  /** Consecutive proposals a candidate level needs before it takes over. */
  hysteresisSteps: number
  /** Level used when no prompt is available. */
  safeFallback: AutoEffort
  /** Scheduler preference: may drop below the hub. */
  allowDowngrade: boolean
  /** User preference: may lift above the hub to `max`. */
  allowUpgrade: boolean
  /** The model's advertised effort ids (including plugin masks like `auto`). */
  efforts: readonly string[]
  /** Hysteresis memo from the previous request of this session. */
  previous?: HysteresisState
}

/**
 * Decide one request's effort target, without touching any host service.
 *
 * Order (SPEC §5.2, Lead-confirmed): manual intent → difficulty → scheduler →
 * hysteresis → capability clamp. The clamp happens HERE rather than inside
 * {@link resolveEffortInjection} so the level the request carries is a decided
 * value; `resolveEffortInjection` is then only the "is this model allowed to
 * receive it at all" gate (advertisement, `toggleOnly`, no-reasoning models).
 *
 * Three ways a level can be manual:
 * 1. the session's `model/selection` pick (or the configured default when the
 *    session never picked) is a concrete level — a user choice always wins over
 *    scheduling;
 * 2. the message itself asks for one (`[effort: max]`) — a per-turn user intent
 *    with the same passthrough/strip contract;
 * 3. nothing else: the request is scheduled.
 *
 * A missing prompt is NOT "the easiest task": with no text the classifier would
 * score 0.05 → `trivial` → `low`, silently downgrading every unattended turn
 * (goal rounds, cron triggers, hosts whose `user/message` has no `source`). That
 * case fails SAFE at the hub instead, with a synthetic `moderate` result so the
 * log and the status tool say `reasons=no-prompt` rather than pretending the
 * request was a manual pick.
 *
 * @param input - resolved prompt, turn counters, config knobs and model capability.
 * @returns the decision; `requested === undefined` means strip.
 */
export function decideRequestEffort(input: RequestEffortDecisionInput): RequestEffortDecision {
  const { intent } = input

  // 1. A concrete pick (session or config) is manual intent — including a
  //    gateway-specific wire id such as `ultra`. Passing it through untouched
  //    is what keeps the plugin from overriding an explicit user choice; the
  //    advertisement gate downstream decides pass-through vs strip.
  if (intent !== 'auto') return { intent, requested: intent, manual: true, fallback: false }

  // 2. No usable human text: this is "no evidence", not "the easiest task".
  //    Stay at the hub (same direction as `safeFallback`) with a synthetic
  //    `moderate` result so the log/status stay readable.
  if (input.prompt.trim().length === 0) {
    return {
      intent,
      requested: clampForAuto('high', input.efforts),
      autoLevel: 'high',
      result: { difficulty: 'moderate', score: 0.45, reasons: ['no-prompt'] },
      manual: false,
      fallback: true,
    }
  }

  // 3. Score the turn from the user's own words plus this turn's counters.
  //    `attachments` is a fixed 0 rather than a folded count: the host records
  //    attachments as content blocks inside the message, and the classifier
  //    already sees their text, so counting again would double the signal.
  const result = classifyDifficulty({
    message: input.prompt,
    attachments: 0,
    priorErrors: input.errors ?? 0,
    toolCount: input.toolCount ?? 0,
  }, input.difficulty)

  // 4. An in-message override is the user asking for that exact level this
  //    turn: hand it through untouched (advertisement decides), never schedule.
  if (result.explicit !== undefined) {
    return { intent, requested: result.explicit, result, manual: true, fallback: false }
  }

  // 5. Schedule: difficulty base, tool-history nudge, then hysteresis so one
  //    anomalous sample cannot flap the level for a single request.
  const decided = decideEffort({
    selected: 'auto',
    difficulty: result.difficulty,
    recentCalls: input.samples ?? [],
    allowDowngrade: input.allowDowngrade,
    allowUpgrade: input.allowUpgrade,
  })
  const hysteresis = applyHysteresis(input.previous, asAutoEffort(decided), input.hysteresisSteps)
  return {
    intent,
    requested: clampForAuto(hysteresis.level, input.efforts),
    autoLevel: hysteresis.level,
    result,
    hysteresis,
    manual: false,
    fallback: false,
  }
}

/* ─────────────────────── diagnostics tool ─────────────────────── */

/** One text block of the diagnostic tool's model-facing content. */
interface StatusContentBlock {
  type: 'text'
  text: string
}

/**
 * A hand-built `ToolDefinition` (the host contract `@deepseek-ai/dsh-tools`
 * validates). Built by hand instead of via `defineTool` because this plugin
 * deliberately ships no new runtime dependency (SPEC §8: only `schemastery` and
 * `zod`), and the host resolves nothing for it — `dsh-tools` is not installed
 * in a profile's node_modules, so a value import would make the whole plugin
 * fail to load.
 */
interface StatusToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render: (args: unknown, value: unknown) => StatusContentBlock[]
  }
  execute: (args: unknown, exec: unknown) => Promise<unknown>
}

/** The diagnostic tool's name. No other tool in this plugin uses the registry. */
export const STATUS_TOOL_NAME = 'auto_reasoning_effort_status'

/** The last decision of this process, as the status tool reports it. */
export interface DecisionSnapshot {
  /** Injected wire level, or `'none'` when the field was stripped. */
  level: string
  /** Difficulty bucket, `'manual'` for a user pick, `'fallback'` for safe mode. */
  difficulty: string
  /** Classifier score (0 when no classification ran). */
  score: number
  /** Classifier reasons, e.g. `['len:45', 'kw:重构']`. */
  reasons: string[]
  /**
   * Where the classified prompt came from — the first field to look at when a
   * subagent (or any projection-less session) behaves unexpectedly.
   */
  source: PromptSource
  /** ISO timestamp of the decision. */
  at: string
}

/**
 * Build the `auto_reasoning_effort_status` definition over a live snapshot
 * supplier.
 *
 * The output schema is intentionally open (`additionalProperties: true`): the
 * payload mirrors the config surface, and pinning it would turn every future
 * config field into a hard `ToolOutputError` at call time. The value is
 * human/model-readable JSON, so the text render is the whole contract.
 */
export function buildStatusTool(describe: () => unknown): StatusToolDefinition {
  return {
    name: STATUS_TOOL_NAME,
    description: 'Report the live auto-reasoning-effort configuration and the most recent '
      + 'difficulty-driven decision (level, difficulty score, reasons, timestamp). '
      + 'Use it when the injected reasoning effort looks wrong, or to confirm which '
      + 'difficulty signals the scheduler saw for the last request.',
    parameters: { type: 'object', properties: {}, required: [], additionalProperties: false },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    execute: async () => describe(),
  }
}

/**
 * Hysteresis memos keyed by the live session object.
 *
 * A `WeakMap` (not a `Map` keyed by session id): the memo must die with the
 * session, and a reloaded plugin must not resurrect a stale streak. Sessions
 * are plain objects on every supported host line, so the object key is stable
 * for the life of the session.
 */
const hysteresisBySession = new WeakMap<object, HysteresisState>()

/**
 * Last human prompt per AGENT, captured by the `agent/pre-step` waterfall.
 *
 * Why an agent-keyed cache exists at all: the difficulty projection is served by
 * `sessionProjections.stateOf`, which does not cover every session — a subagent
 * session created in-process by `subagent-spawn-in-process` is the measured
 * case. For those, the projection read returns `undefined` and the plugin used
 * to fall back to `safeFallback` on EVERY request, so a subagent's reasoning
 * effort was never difficulty-driven at all (a 114-character simple prompt went
 * out at `high`).
 *
 * Keyed by the agent object (a `WeakMap`, so a finished agent's prompt does not
 * outlive it) rather than by session id: the pre-step payload carries the agent,
 * and the request payload is expected to carry the same live object.
 */
const promptByAgent = new WeakMap<object, string>()

/**
 * Memo key for a request whose payload carries no session object (a synthetic
 * subagent step, a host line that hands the loop a detached agent). Sharing one
 * slot is better than dropping hysteresis entirely: such requests are ordered,
 * so a shared streak still damps flapping.
 */
const SESSIONLESS_AGENT_KEY: object = Object.freeze({})

/**
 * Sessions (or agents) already warned about having no prompt at all.
 *
 * The warning is a host-log line, not a user-facing error: emitting it per
 * request would flood the log of every session on a host without the projection
 * registry. It fires only when BOTH the projection and the `agent/pre-step`
 * cache came up empty — a subagent served by the cache is working correctly and
 * must not look like a failure.
 */
const warnedSessions = new WeakSet<object>()

/**
 * Most recent decision of this process, for {@link STATUS_TOOL_NAME}.
 *
 * Module-level rather than per-`apply`: the diagnostics tool is registered by
 * the `tools` service, which outlives a plugin remount, and "the last decision"
 * is a property of the process's request traffic, not of one fiber.
 */
let lastDecision: DecisionSnapshot | null = null

/**
 * Snapshot reported by {@link STATUS_TOOL_NAME}.
 *
 * Field names mirror the config surface one-to-one (`hysteresisSteps`,
 * `safeFallback`, …) so an operator can diff the tool output against the
 * settings form without a translation table.
 */
function statusSnapshot(cfg: LiveConfig, last: DecisionSnapshot | null): Record<string, unknown> {
  return {
    plugin: 'dsh-auto-reasoning-effort',
    enabled: cfg.enabled,
    level: cfg.level,
    allowDowngrade: cfg.allowDowngrade,
    allowUpgrade: cfg.allowUpgrade,
    hysteresisSteps: cfg.hysteresisSteps,
    safeFallback: cfg.safeFallback,
    defaultPricing: cfg.defaultPricing,
    difficulty: {
      complexKeywords: [...cfg.difficulty.complexKeywords],
      heavyKeywords: [...cfg.difficulty.heavyKeywords],
      simpleKeywords: [...cfg.difficulty.simpleKeywords],
      trivialKeywords: [...cfg.difficulty.trivialKeywords],
    },
    models: cfg.models,
    lastDecision: last,
  }
}

/** One resolved model's capability snapshot, cached per `provider/model`. */
interface ModelCapability {
  /** The model advertises at least one reasoning-effort level. */
  supportsReasoning: boolean
  /** The advertised effort ids, in selector order. */
  efforts: readonly string[]
  /** The model accepts image input (from `inputModalities`). */
  vision: boolean
  /**
   * The model takes only an on/off thinking toggle (Qwen3.6-style, per the
   * llm-pi-ai config): any effort level would be rejected, so the selector
   * shows Off/On and `off` means "omit the effort" (enable_thinking false).
   */
  toggleOnly: boolean
}

/** Minimal face of the llm service's model-info query (typed locally). */
interface LlmServiceLike {
  resolveModelInfo: (provider: string, model: string, signal?: unknown) => Promise<{
    reasoning?: { efforts?: { id: string }[] }
    inputModalities?: string[]
  }>
}

/** Minimal face of the settings service's write channel (typed locally). */
interface SettingsWriteLike {
  update?: (ns: string, patch: unknown) => Promise<unknown>
}

/**
 * One `describe()` pass, two namespaces: the taken-over routes (transport
 * section judgment) and the llm-pi-ai section for the posture lookup.
 * `describe()` replaces the dead `settings?.get?.()` soft reads —
 * `SettingsForms` has no `get`.
 */
function takeoverReadout(ctx: Context): { routes: string[] | null; piAi: PiAiSection | undefined } {
  const descriptors = describeSettings(ctx)
  // The transport's composition entry id changed shape across its packaging
  // history — settle on whichever namespace the describe document carries.
  const section = resolveNamespaceOf<{ enabled?: unknown; providers?: unknown }>(
    descriptors,
    TAKEOVER_NAMESPACE_CANDIDATES,
  )?.value
  const piAi = readSectionOf<PiAiSection>(descriptors, PI_AI_NAMESPACE)?.value
  return { routes: takeoverRoutesOf(section), piAi }
}

/**
 * The llm-pi-ai posture of one model, from the live llm-pi-ai section
 * (the capability card writes `reasoningEfforts` and `compat` there). Absent
 * when the route/model is not configured.
 *
 * A model is toggle-only (Off/On, no effort levels) only when ALL THREE hold:
 * the model declares a thinking toggle (reasoningEfforts table, no
 * supportsReasoningEffort), the route is taken over by the transport (it is in
 * the takeover judgment), AND the route speaks the openai-completions wire
 * protocol. The Off/On fold exists because a completions toggle model rejects
 * any `reasoning_effort` string pi-ai does not resolve to its fixed seven
 * levels; that physical reason does NOT apply to a Responses/Anthropic route,
 * whose levels pi-ai maps natively (thinking budget / reasoning-effort enum)
 * and whose `supportsReasoningEffort` compat field the host refuses to write
 * at all (4.4.4). Folding such a route would silently strip the configured
 * level set down to Off/On. A route OUTSIDE the takeover judgment is likewise
 * served by pi-ai with its native reasoning semantics and is NOT folded here.
 * (exported for the protocol-gate regression, issue #9 — same precedent as
 * `advertiseModelCapability`)
 */
export function piAiPosture(
  piAi: PiAiSection | undefined,
  provider: string,
  model: string,
  takeover: string[] | null,
): { thinkingOn: boolean; supportsEffort: boolean } | undefined {
  const profile = piAi?.providers?.[provider]
  const rows = Array.isArray(profile?.models)
    ? profile!.models as Array<Record<string, unknown>>
    : []
  const entry = rows.find(candidate => candidate['id'] === model)
  if (entry === undefined) return undefined
  const efforts = entry['reasoningEfforts']
  const compat = entry['compat']
  const thinkingOn = typeof efforts === 'object' && efforts !== null && !Array.isArray(efforts)
  const supportsEffort = typeof compat === 'object' && compat !== null
    && (compat as Record<string, unknown>)['supportsReasoningEffort'] === true
  // Toggle folding is a takeover-judgment concern AND an openai-completions
  // concern: only a taken-over completions route gets the Off/On treatment.
  // The transport is named `dsh-llm-openai-completions` but since the 4.4.x
  // line fronts three protocols; a Responses/Anthropic route keeps its native
  // effort levels (the table drives pi-ai's thinkingLevelMap). An absent `api`
  // keeps pi-ai's openai-completions default, so it stays foldable — the same
  // predicate as the card's `completionsCompatConfigurable`.
  const api = profile?.api
  const isCompletions = typeof api !== 'string' || api === 'openai-completions'
  const toggled = takeover !== null && takeover.includes(provider)
  return { thinkingOn: thinkingOn && toggled && isCompletions, supportsEffort }
}

const CAPABILITY_CACHE_KEY_SEPARATOR = '\u0000'

/** A model that cannot be resolved is treated as non-reasoning: never inject. */
const UNRESOLVABLE_CAPABILITY: ModelCapability = { supportsReasoning: false, efforts: [], vision: false, toggleOnly: false }

/** Runtime model-capability lookup with a per-route cache. */
function capabilityResolver(ctx: Context): {
  resolve: (provider: unknown, model: unknown) => Promise<ModelCapability>
  clear: () => void
} {
  const cache = new Map<string, ModelCapability>()
  return {
    async resolve(provider, model) {
      if (typeof provider !== 'string' || typeof model !== 'string') return UNRESOLVABLE_CAPABILITY
      const key = `${provider}${CAPABILITY_CACHE_KEY_SEPARATOR}${model}`
      const cached = cache.get(key)
      if (cached !== undefined) return cached
      const llm = ctx.get('llm') as LlmServiceLike | undefined
      let capability: ModelCapability
      try {
        const info = await llm?.resolveModelInfo?.(provider, model)
        const efforts = info?.reasoning?.efforts?.map(effort => effort.id) ?? []
        const readout = takeoverReadout(ctx)
        const posture = piAiPosture(readout.piAi, provider, model, readout.routes)
        capability = {
          supportsReasoning: reasoningEffortSupported(info?.reasoning),
          efforts,
          vision: Array.isArray(info?.inputModalities) && info.inputModalities.includes('image'),
          toggleOnly: posture?.thinkingOn === true && posture.supportsEffort === false,
        }
      } catch {
        capability = UNRESOLVABLE_CAPABILITY
      }
      cache.set(key, capability)
      return capability
    },
    clear() {
      cache.clear()
    },
  }
}

interface LegacySettingsSctx {
  settings: {
    register?: (
      ns: string,
      schema: unknown,
      options?: { base?: unknown },
    ) => { get(): unknown; watch?(callback: () => void): () => void }
    describe?: unknown
  }
  effect(cleanup: () => (() => void) | void, label?: string): void
}

/** The registered settings namespace of the ≤0.1.6 era. */
const THINKING_LEVELS_SETTINGS_NAMESPACE = 'thinking-levels'

/**
 * The settings namespaces whose commits can move the takeover judgment
 * (issue #4): the transport's `enabled` mirror must not be re-synced through
 * a full describeSettings on EVERY unrelated commit — boot fires many.
 * Includes both transport packaging ids and both own namespaces, so the
 * mirror still re-checks whenever its own inputs move.
 */
const TAKEOVER_SYNC_NAMESPACES: readonly string[] = [
  PI_AI_NAMESPACE,
  ...TAKEOVER_NAMESPACE_CANDIDATES,
  'dsh-auto-reasoning-effort',
  THINKING_LEVELS_SETTINGS_NAMESPACE,
]

/**
 * Legacy (≤0.1.6) settings registration: on hosts whose settings service
 * carries the imperative face (`register` present, `describe` absent), install
 * this plugin's section so its config is runtime-editable and the live values
 * feed `current()`. On 0.1.7+ the composition entry IS the section (the
 * `.volatile()` fields arrive as live refs) and `register` no longer exists —
 * the install is a no-op there. Shape-detected, never version-guessed.
 */
export function installLegacySection(
  ctx: Context,
  config: ThinkingLevelsConfig,
  hooks: { setSource: (source: () => ThinkingLevelsConfig) => void },
): void {
  const inject = (ctx as unknown as { inject?: (deps: string[], fn: (sctx: LegacySettingsSctx) => void) => void }).inject
  if (typeof inject !== 'function') return
  inject.call(ctx, ['settings'], (sctx) => {
    const settings = sctx.settings as
      | { register?: unknown; describe?: unknown; installSection?: unknown }
      | undefined
    console.log(`[auto-reasoning-effort] settings service face: register=${typeof settings?.register} installSection=${typeof settings?.installSection} describe=${typeof settings?.describe}`)
    // `register`'s presence IS the imperative face (≤0.1.6). `describe` must
    // NOT be read as a declarative-generation marker: the webServer mirror
    // carries describe/mutate on EVERY generation (三代腰 finding —
    // mutate/describe 四代全在), so the old `describe → skip` clause silently
    // disabled this install on 0.1.2/0.1.5 too, leaving the namespace
    // unregistered and every settingsScope.bind('thinking-levels') read
    // `unavailable` forever.
    if (typeof settings?.register !== 'function') return
    try {
      // The loader hands `apply` its config through the entry schema — the
      // volatile-shaped `Config` on EVERY generation — so the runtime values
      // sit behind live refs even on hosts taking the imperative register
      // path. Flatten to plain values for the legacy resolver's base layer
      // ("$.enabled expected boolean but got [object Object]", live on cell
      // 0.1.5, was the ref riding in as the base).
      const plainBase = {
        enabled: readVolatile(config.enabled, true),
        level: readVolatile(config.level, 'auto'),
        allowDowngrade: readVolatile(config.allowDowngrade, true),
        allowUpgrade: readVolatile(config.allowUpgrade, false),
        takeover: readVolatile(config.takeover, false),
        takeoverUi: readVolatile(config.takeoverUi, false),
        // The difficulty knobs ride the same base layer as the rest: on a
        // ≤0.1.6 host the registered section is what `current()` reads, so a
        // composition-entry keyword table that is not carried here would be
        // silently replaced by the schema defaults.
        difficulty: config.difficulty ?? DIFFICULTY_FALLBACK,
        hysteresisSteps: readVolatile(config.hysteresisSteps, 2),
        safeFallback: readVolatile(config.safeFallback, 'high'),
        models: config.models,
      }
      const scope = settings.register(THINKING_LEVELS_SETTINGS_NAMESPACE, LegacyConfig, { base: plainBase }) as {
        get(): unknown
        watch?(cb: () => void): void
      }
      console.log('[auto-reasoning-effort] settings via settings.register (≤0.1.6 imperative face)')
      hooks.setSource(() => scope.get() as ThinkingLevelsConfig)
      sctx.effect(() => () => {
        hooks.setSource(() => config)
      })
      scope.watch?.(() => {})
    } catch (error) {
      console.log(`[auto-reasoning-effort] settings.register FAILED: ${error instanceof Error ? error.message : String(error)}`)
    }
  })
}

/**
 * Plugin body.
 * @param ctx - host context carrying the agent-event dispatch.
 * @param config - resolved plugin configuration.
 */
export function apply(ctx: Context, config: ThinkingLevelsConfig = DEFAULT_CONFIG): void {
  // Fail-loud: a stray config value (e.g. `medium` from an old profile) must
  // not ride through into the model request, where dsh throws
  // UNSUPPORTED_REASONING_EFFORT per request.
  assertEffortId(resolveLiveConfig(config).level, 'dsh-auto-reasoning-effort config.level')

  // Runtime-adjustable configuration: volatile refs on 0.1.7+, the registered
  // section before that — both re-read per request, so a committed settings
  // change needs no re-registration. The ≤0.1.6 registered section (user edits
  // layered over the entry base) wins when installed.
  let source: () => ThinkingLevelsConfig = () => config
  installLegacySection(ctx, config, { setSource: (next) => { source = next } })

  // Cache-billing projection (0.1.7-alpha+ hosts): soft-coupled runtime inject
  // ONLY — a top-level export inject would make the whole plugin refuse to
  // load where the sessionProjections service is absent (<=0.1.6), killing the
  // takeover on old lines for one optional surface. Where absent, the callback
  // never fires and the ring's billing section stays hidden.
  ;(ctx as unknown as {
    inject?: (deps: string[], cb: (scope: {
      sessionProjections?: { register: (definition: unknown) => void }
    }) => void) => void
  }).inject?.(['sessionProjections'], (scope) => {
    // 注册失败只掉账单面（warn + 隐藏），不得毒化整个插件 fiber（takeover 主面）。
    try {
      const def = buildBillingDefinition(() => ({ defaultPricing: resolveLiveConfig(source()).defaultPricing })) as {
      key: string
      stateVersion: number
      init: () => unknown
      apply: (state: unknown, event: unknown) => unknown
      stateSchema?: unknown
      wire?: { viewSchema?: unknown; view?: unknown }
      schema?: unknown
      view?: unknown
    }
    // 0.1.0-rc.8 是唯一的旧平面契约 registry（snapshot 走 def.schema.parse(def.view(state))，
    // 0.1.1+ 全线是 stateSchema/wire 新契约）。旧 registry 对缺 schema 的单元直接
    // 「Cannot read properties of undefined (reading 'parse')」——一颗单元毒化全部
    // 冷会话历史加载（2026-10-08 五格实证）。镜像 wire 形状为平面键，两代 registry
    // 各取所需；新契约线多出的两个键无人消费，行为不变。
    const wire = (def as { wire?: { viewSchema?: unknown; view?: unknown } }).wire
    if (wire && def.schema === undefined) {
      def.schema = wire.viewSchema
      def.view = wire.view
    }
      scope.sessionProjections?.register(def)
    } catch (error) {
      console.warn(`[auto-reasoning-effort] tlCacheBilling register failed (billing section stays hidden): ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  const current: () => LiveConfig = () => resolveLiveConfig(source())
  // Difficulty projection (`tlEffortDifficulty`): folds the human prompt text,
  // the turn switch, the per-turn tool samples and the session's explicit pick.
  // Same soft coupling and same "never poison the fiber" rule as the billing
  // unit above — a registry that cannot serve `stateOf` is skipped outright
  // rather than registered blind:
  // - 0.1.0-rc.8 is the legacy plane-contract registry (`schema`/`view`, no
  //   `stateOf`), and a unit missing `schema` there poisons every cold session
  //   load.
  // - where it is skipped, the injection path falls back to `safeFallback`.
  ;(ctx as unknown as {
    inject?: (deps: string[], cb: (scope: { sessionProjections?: unknown }) => void) => void
  }).inject?.(['sessionProjections'], (scope) => {
    const registry = scope.sessionProjections as
      | { register?: (definition: unknown) => void; stateOf?: unknown }
      | undefined
    if (typeof registry?.stateOf !== 'function' || typeof registry.register !== 'function') return
    try {
      registry.register(buildEffortProjectionDefinition())
    } catch (error) {
      console.warn(`[auto-reasoning-effort] ${EFFORT_DIFFICULTY_KEY} register failed (auto falls back to safeFallback): ${error instanceof Error ? error.message : String(error)}`)
    }
  })
  ctx.on('loader/volatile-update', () => {
    assertEffortId(resolveLiveConfig(config).level, 'dsh-auto-reasoning-effort config.level')
    // A flipped takeover switch mirrors immediately (identity-gated).
    syncTakeover()
  })

  // Official-compat bridge (check branch): write the OFFICIAL compat surface
  // into the llm-pi-ai namespace for every provider that targets a custom
  // openai-completions gateway AND declares thinking (reasoningEfforts table):
  // route-level `supportsDeveloperRole: false` plus model-level
  // `thinkingFormat: qwen` on toggle-style thinking rows. This replaces the
  // retired short-circuit route (maintaining the dsh-llm-openai-completions
  // takeover list): since dsh v0.1.0-rc.8 the declarative compat fixes the
  // developer-role 400 AND drives enable_thinking at the pi-ai adapter itself,
  // so pi-ai keeps serving the route and no transport takeover is needed.
  // Storage pattern follows
  // hytime/dsh-thinking-effort's host side: read → pure transform (identity
  // when nothing to change) → whole-section update, so dsh's llm-pi-ai schema
  // validator gates the write where it is WRITTEN; an installed dsh predating
  // rc.8 rejects the unknown field and we log and keep the previous section.
  // The read is lazy and writes are queued by the service, so no race with a
  // concurrent Settings → Models edit.
  let syncTail: Promise<unknown> = Promise.resolve()
  const syncDeveloperRole = (): void => {
    syncTail = syncTail.then(async () => {
      const settings = ctx.get('settings') as SettingsWriteLike | undefined
      // describe() is the only read channel on 0.1.7+ (SettingsForms has no
      // `get`); the section value is the schema-projected live config.
      const piAi = readSection<PiAiSection>(ctx, PI_AI_NAMESPACE)?.value
      const next = withOfficialCompatFixes(piAi)
      if (next === undefined || next === piAi) return
      await settings?.update?.(PI_AI_NAMESPACE, { providers: next.providers })
      ctx.logger?.info?.(
        '[auto-reasoning-effort] official-compat: supportsDeveloperRole=false (route) and thinkingFormat=qwen (toggle-style models) written to llm-pi-ai for custom thinking routes',
      )
    }).catch((error) => {
      ctx.logger?.warn?.('[auto-reasoning-effort] developer-role compat sync rejected (schema gate); kept previous section', error)
    })
  }

  // Takeover mirror: this plugin's `takeover` switch (settings UI) is the
  // control-layer master; the write lands in the transport's OWN section
  // (`llm-openai-completions.enabled`), whose judgment stays single-source.
  // Cross-plugin writes are schema-gated at the write site (the transport's
  // `enabled` is volatile) and never touch its other fields. Writes fire only
  // on divergence (transport absent = nothing to drive), so a manual edit of
  // the transport section survives until the switch is actually flipped again.
  const syncTakeover = (): void => {
    syncTail = syncTail.then(async () => {
      // Resolve the transport's LIVE namespace from the describe document
      // (the entry id changed shape across its packaging history) — the read
      // and the mirror write land on the same settled id.
      const transport = resolveNamespaceOf<{ enabled?: unknown }>(
        describeSettings(ctx),
        TAKEOVER_NAMESPACE_CANDIDATES,
      )
      const patch = takeoverPatch(transport?.value, current().takeover)
      if (patch === undefined || transport === undefined) return
      const settings = ctx.get('settings') as SettingsWriteLike | undefined
      await settings?.update?.(transport.ns, patch)
      ctx.logger?.info?.('[auto-reasoning-effort] takeover switch %s written to %s.enabled', String(current().takeover), transport.ns)
    }).catch((error) => {
      ctx.logger?.warn?.('[auto-reasoning-effort] takeover mirror write rejected (schema gate); kept previous section', error)
    })
  }

  // Initial sync (adapters may register later; re-run on every adapters update
  // and every llm-pi-ai settings update so a Settings → Models edit propagates.
  // The write is identity-gated, so the re-entry triggered by our own update
  // settles immediately).
  syncDeveloperRole()
  syncTakeover()
  const onSyncAny = ctx.on as unknown as (event: string, listener: (...args: never[]) => unknown) => void
  onSyncAny('llm/adapters-updated', () => {
    syncDeveloperRole()
    syncTakeover()
  })
  onSyncAny('settings/document-updated', (ns: string) => {
    if (ns === PI_AI_NAMESPACE) syncDeveloperRole()
    // The mirror re-checks only where a commit can move the takeover
    // judgment (issue #4); the write it just made re-enters here and
    // settles (identity-gated) without a second write.
    if (TAKEOVER_SYNC_NAMESPACES.includes(ns)) syncTakeover()
  })

  // Inject the level decision into every model request of a step.
  // The 'agent/request' event key is augmented onto cordis Events by the
  // dsh-agent runtime's generated scope types; the npm package does not
  // re-export that augmentation, so the emitter is widened at the boundary.
  //
  // prepend: the host's model-selection assembly also listens on this event and
  // overwrites `reasoningEffort` with the session's selection after `next()`;
  // registering first keeps this plugin's decision OUTERMOST so it runs last.
  const on = ctx.on as unknown as (
    event: string,
    handler: (payload: Record<string, unknown>, next: () => unknown) => unknown | Promise<unknown>,
    options?: { prepend?: boolean },
  ) => void

  // Model capability snapshots, cached per provider/model and cleared whenever
  // the adapter registry changes (a route's reasoning metadata can move).
  const capability = capabilityResolver(ctx)

  // Capture each step's human prompt, keyed by agent.
  //
  // Why this listener exists: the difficulty projection is served by
  // `sessionProjections.stateOf`, which does not cover every session. Measured
  // case — a session created in-process by `subagent-spawn-in-process` logs its
  // human `user/message` (`source.kind === 'user'`, zero `model/selection`) yet
  // the projection read returns `undefined`, so before this listener every
  // subagent request took the `safeFallback` branch and went out at `high`
  // regardless of a 114-character simple prompt.
  //
  // `agent/pre-step` is a waterfall: `next()` must be called exactly once or the
  // step never runs. The capture is wrapped so a malformed payload can never
  // break a turn; the plugin context disposes the listener with the fiber, like
  // every other `ctx.on` in this file.
  const onPreStep = ctx.on as unknown as (
    event: string,
    handler: (payload: Record<string, unknown>, next: () => Promise<unknown>) => Promise<unknown>,
  ) => void
  onPreStep('agent/pre-step', async (payload, next) => {
    try {
      const agent = payload.agent
      if (typeof agent === 'object' && agent !== null) {
        const prompt = humanPromptOf(payload.messages)
        // `undefined` = this batch carries no human message at all (a later
        // step of the same turn): keep the prompt captured at the turn's first
        // step. `''` = a human message with no text, which deliberately
        // REPLACES the cache so the previous turn's prompt cannot leak in.
        if (prompt !== undefined) promptByAgent.set(agent, prompt)
      }
    } catch {
      // Never let the capture break the step; `next()` runs below either way.
    }
    return next()
  })

  on('agent/request', async (payload, next) => {
    const seed = await next() as { provider?: unknown; model?: unknown; reasoningEffort?: unknown }
    const cfg = current()
    // `enabled` may flip at runtime through the settings namespace.
    if (!cfg.enabled) return seed

    // Model-aware guard: never send a reasoning effort to a model that does
    // not advertise one (custom openai-completions routes such as Qwen3.6).
    // Unsupported fields are stripped, not sent; a resolved low/auto schedule
    // only ever reaches models whose metadata admits the level.
    const capabilityFor = await capability.resolve(seed.provider, seed.model)
    // Folded difficulty state: human prompt text, current turn, this turn's
    // tool samples/errors/count and the session's explicit pick. `undefined` on
    // registries without `stateOf` (0.1.0-rc.8), on sessions the registry does
    // not serve (in-process subagents), or before the first fold.
    const agent = payload.agent
    const session = (agent as { session?: unknown } | undefined)?.session
    const projection = readEffortProjection(ctx, session)
    // The prompt, in precedence order: the projection's folded human message,
    // then the `agent/pre-step` capture (the subagent path), then nothing. The
    // counters/samples are taken from the projection ONLY when it supplied the
    // prompt: on the pre-step path there is no per-turn view to trust, and the
    // task is to classify the TEXT, not to invent tool history.
    const cachedPrompt = typeof agent === 'object' && agent !== null ? promptByAgent.get(agent) : undefined
    const resolved = resolveStepPrompt(projection?.latestUserText ?? '', cachedPrompt)
    const fromProjection = resolved.source === 'projection'
    // Hysteresis is per session; a step without a session object (subagent
    // step) falls back to a per-agent key so two agents never share a streak.
    const sessionKey = typeof session === 'object' && session !== null
      ? session
      : typeof agent === 'object' && agent !== null ? agent : SESSIONLESS_AGENT_KEY
    // The requested intent comes from the session pick (only the projection can
    // hold one) shadowed over the configured default; a custom wire id stays
    // verbatim (see `requestedEffortOf`).
    const intent = requestedEffortOf(projection, cfg.level)
    // Warn ONCE per session, only when BOTH sources came up empty AND the level
    // actually has to be scheduled: a subagent served by the pre-step cache is
    // working correctly, and a manual lock never needed a prompt at all.
    if (resolved.source === 'no-prompt' && intent === 'auto' && !warnedSessions.has(sessionKey)) {
      warnedSessions.add(sessionKey)
      ctx.logger?.warn?.(
        '[auto-reasoning-effort] agent/request: no human prompt from the projection or agent/pre-step; using safeFallback=%s',
        cfg.safeFallback,
      )
    }
    const plan = decideRequestEffort({
      intent,
      prompt: resolved.prompt,
      samples: fromProjection ? projection?.samples ?? [] : [],
      toolCount: fromProjection ? projection?.toolCount ?? 0 : 0,
      errors: fromProjection ? projection?.errors ?? 0 : 0,
      difficulty: cfg.difficulty,
      hysteresisSteps: cfg.hysteresisSteps,
      safeFallback: cfg.safeFallback,
      allowDowngrade: cfg.allowDowngrade,
      allowUpgrade: cfg.allowUpgrade,
      efforts: capabilityFor.efforts,
      previous: hysteresisBySession.get(sessionKey),
    })
    if (plan.hysteresis !== undefined) hysteresisBySession.set(sessionKey, plan.hysteresis)

    // The plan already picked and clamped the level; `resolveEffortInjection` is
    // only the "may this model receive it at all" gate now — advertisement,
    // `toggleOnly` folding and the no-reasoning strip. It is deliberately fed a
    // CONCRETE level (never `auto`), so the upstream tool-history scheduler
    // cannot run a second, different decision behind our back. `requested` is a
    // plain string there, which is what lets a gateway's custom wire id
    // (`ultra`) travel as the user's explicit pick.
    const manualRequested = plan.requested
    const decision: EffortInjectionDecision = manualRequested === undefined
      ? { inject: false }
      : resolveEffortInjection({
        supportsReasoning: capabilityFor.supportsReasoning,
        requested: manualRequested,
        seedEffort: seed.reasoningEffort,
        recentCalls: projection?.samples ?? [],
        allowDowngrade: cfg.allowDowngrade,
        allowUpgrade: cfg.allowUpgrade,
        efforts: capabilityFor.efforts,
        toggleOnly: capabilityFor.toggleOnly,
      })

    // Log/status fields: the classifier's own vocabulary, so a surprising level
    // can be explained from the host log without re-running the turn.
    const difficultyLabel = plan.result?.difficulty ?? (plan.fallback ? 'fallback' : 'manual')
    const scoreLabel = plan.result === undefined ? '-' : plan.result.score.toFixed(2)
    const reasonsLabel = plan.result === undefined || plan.result.reasons.length === 0
      ? '-'
      : plan.result.reasons.join(',')
    const levelLabel = decision.inject ? String(decision.level) : 'none'
    lastDecision = {
      level: levelLabel,
      difficulty: difficultyLabel,
      score: plan.result?.score ?? 0,
      reasons: plan.result?.reasons ?? [],
      source: resolved.source,
      at: new Date().toISOString(),
    }

    if (!decision.inject) {
      // The model cannot take any effort (or advertises none of the auto trio):
      // drop an inherited one so dsh does not reject the request
      // (UNSUPPORTED_REASONING_EFFORT).
      const stripped = { ...seed }
      delete (stripped as { reasoningEffort?: unknown }).reasoningEffort
      ctx.logger?.info?.(
        '[auto-reasoning-effort] agent/request: model=%s/%s user=%s seed=%s difficulty=%s score=%s reasons=%s src=%s => stripped',
        String(seed.provider), String(seed.model), plan.intent,
        String(seed.reasoningEffort), difficultyLabel, scoreLabel, reasonsLabel, resolved.source,
      )
      return stripped
    }
    // Summary-only log: individual tool names/arg sizes are workflow metadata
    // that need not land in the host log; the counters and the decision suffice.
    // `user=` is the ORIGINAL intent (`auto` when scheduling, the picked id
    // otherwise), never the resolved level: a support log has to make "this
    // request was scheduled" distinguishable from "the user locked a level".
    // `src=projection|pre-step|no-prompt` answers the other support question:
    // which source supplied the text the level was derived from.
    ctx.logger?.info?.(
      '[auto-reasoning-effort] agent/request: model=%s/%s user=%s seed=%s difficulty=%s score=%s reasons=%s tools=%d errors=%d => level=%s src=%s',
      String(seed.provider), String(seed.model), plan.intent,
      String(seed.reasoningEffort), difficultyLabel, scoreLabel, reasonsLabel,
      fromProjection ? projection?.samples.length ?? 0 : 0,
      fromProjection ? projection?.errors ?? 0 : 0,
      String(decision.level), resolved.source,
    )
    return { ...seed, reasoningEffort: decision.level }
  }, { prepend: true })

  // Diagnostics: what the plugin is configured to do and what it decided last.
  // Registered through the `tools` service with a hand-built definition (see
  // `buildStatusTool`); a registry that rejects it must not poison the fiber —
  // the injection path above is the product, this tool is an observability aid.
  ;(ctx as unknown as {
    inject?: (deps: string[], cb: (scope: {
      tools?: { register?: (definition: unknown) => unknown }
      effect?: (cleanup: () => void) => void
    }) => void) => void
  }).inject?.(['tools'], (scope) => {
    if (typeof scope.tools?.register !== 'function') return
    try {
      const dispose = scope.tools.register(buildStatusTool(() => statusSnapshot(current(), lastDecision)))
      if (typeof dispose === 'function') scope.effect?.(() => { (dispose as () => void)() })
    } catch (error) {
      ctx.logger?.warn?.(
        '[auto-reasoning-effort] %s registration failed (diagnostic tool unavailable): %s',
        STATUS_TOOL_NAME,
        error instanceof Error ? error.message : String(error),
      )
    }
  })

  // Advertise the `auto` mask (and, for configurer-confirmed rc.6-era models,
  // `low`) in the model directory so the session model selector offers them
  // alongside the adapter's native levels. Adapters may register after this
  // plugin's apply (the load order differs between the CLI and DSH Desktop),
  // so the wrapper also re-runs on every `llm/adapters-updated`.
  const llm = ctx.get('llm') as { adapters?: Map<string, LlmRegistration> } | undefined
  const overrideFor = (provider: string, model: string): ModelCapabilityOverride | undefined =>
    current().models[`${provider}/${model}`]
  // Read the live llm-pi-ai config for the thinking/effort posture the card
  // wrote there: a model with `reasoningEfforts` but without effort support
  // (Qwen3.6) is collapsed to an On/Off toggle in the selector — but ONLY when
  // the route is taken over by the openai-completions transport. A pi-ai-served
  // route (e.g. mimo via xiaomi) keeps its native off/high levels.
  // Readout cache (issue #4): the resolveModel wrapper runs piAiFor on EVERY
  // model resolution, and a full describeSettings per call made the model
  // page cost O(models × adapters). One readout per generation, invalidated
  // with the capability cache on every settings commit below.
  let readoutCache: { routes: string[] | null; piAi: PiAiSection | undefined } | undefined
  const cachedReadout = (): { routes: string[] | null; piAi: PiAiSection | undefined } => {
    if (readoutCache === undefined) readoutCache = takeoverReadout(ctx)
    return readoutCache
  }
  const piAiFor = (provider: string, model: string): { thinkingOn: boolean; supportsEffort: boolean } | undefined => {
    const readout = cachedReadout()
    return piAiPosture(readout.piAi, provider, model, readout.routes)
  }
  advertiseModelCapability(llm, overrideFor, piAiFor)
  const onAny = ctx.on as unknown as (event: string, listener: (...args: never[]) => unknown) => void
  onAny('llm/adapters-updated', () => {
    capability.clear()
    advertiseModelCapability(
      ctx.get('llm') as { adapters?: Map<string, LlmRegistration> } | undefined,
      overrideFor,
      piAiFor,
    )
  })
  // A settings commit can flip the takeover judgment (the transport's enabled
  // flag or the llm-pi-ai routes): drop the cached capability snapshots so
  // toggle folding follows the new posture on the next request.
  onAny('settings/document-updated', () => {
    capability.clear()
    readoutCache = undefined
  })
}
