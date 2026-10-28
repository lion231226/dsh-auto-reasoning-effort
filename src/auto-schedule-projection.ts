/**
 * TL difficulty projection unit (`tlEffortDifficulty`).
 *
 * Upstream (`tlAutoSchedule`) folded only two things: an unbounded-by-turn ring
 * of `tool/call` samples and the session's explicit effort pick. That was
 * enough to schedule from tool history alone, and it produced the two defects
 * this fork exists to fix:
 * - a fresh prompt carried the PREVIOUS turn's history, so the level drifted
 *   for reasons that had nothing to do with the message the user just typed;
 * - the scheduler had no idea how hard the turn was, because the text of the
 *   prompt was not folded at all.
 *
 * This unit therefore folds the turn's difficulty inputs instead:
 * - `user/message` (only when a HUMAN authored it) → the prompt text, the
 *   prompt sequence, and a reset of the per-turn counters;
 * - `turn/start` → the turn switch and the same per-turn reset;
 * - `tool/call` → a bounded sample ring (last {@link TOOL_SAMPLE_WINDOW}) plus a
 *   total that is NOT window-capped, because "did this turn already run 12
 *   tools" is itself a difficulty signal;
 * - `tool/result` → the error count, which lifts the score;
 * - `model/selection` → the session's explicit pick. That event has exactly one
 *   production writer, the user-facing selection command
 *   (`api/session-controller/src/agent.ts:340` ← `commands.ts:176`), so the
 *   plugin's own injection can never pollute it — the host echo of this
 *   plugin's output (`request/header`) is a different event entirely.
 *
 * Projections are the sanctioned read path ("reads the projection"), are folded
 * lazily over the in-memory log on first read (so resumed/forked sessions are
 * complete), and cost O(1) per request afterwards.
 *
 * @module dsh-auto-reasoning-effort/auto-schedule-projection
 */
import { z } from 'zod'
import { TOOL_SAMPLE_WINDOW, extractUserText, toolSampleOf } from './session-events.ts'
import type { EffortId, ToolCallSample } from './thinking-level.ts'

/**
 * Projection key.
 *
 * Registered under a NEW key rather than reusing `tlAutoSchedule`: the folded
 * state shape and its meaning changed, and two plugin versions writing the same
 * key with different `stateVersion`s would fight over one persisted row.
 */
export const EFFORT_DIFFICULTY_KEY = 'tlEffortDifficulty'

/**
 * Folded state: everything the difficulty classifier and the scheduler need for
 * the CURRENT turn of one session.
 *
 * Every per-turn field is reset by a human prompt or a turn switch; only
 * `promptSeq` and `userEffort` are session-scoped.
 */
export interface EffortProjectionState {
  /** Text of the latest human prompt (already capped at `USER_TEXT_MAX`). */
  latestUserText: string
  /**
   * Monotonic counter of human prompts. Lets a reader tell "a new question
   * started" apart from a mid-turn event without diffing the text.
   */
  promptSeq: number
  /** Current conversation turn (`turn/start`). 0 before the first turn. */
  currentTurn: number
  /** Tool samples of the current turn, oldest first, at most {@link TOOL_SAMPLE_WINDOW}. */
  samples: readonly ToolCallSample[]
  /** Tool results of the current turn that failed. */
  errors: number
  /** Total tool calls of the current turn (NOT capped by the sample window). */
  toolCount: number
  /** Effort explicitly picked in this session, or null when never picked. */
  userEffort: string | null
}

const stateSchema = z.object({
  latestUserText: z.string(),
  promptSeq: z.number(),
  currentTurn: z.number(),
  samples: z.array(z.object({
    name: z.string(),
    argsSize: z.number(),
    turn: z.number(),
    step: z.number(),
  })),
  errors: z.number(),
  toolCount: z.number(),
  userEffort: z.string().nullable(),
})

/**
 * Initial folded state (also the shape every cold read starts from).
 *
 * Built fresh on every call: the arrays are part of the state, and a shared
 * empty array would let one session's fold append into every other session's
 * first state.
 */
export function initEffortProjection(): EffortProjectionState {
  return {
    latestUserText: '',
    promptSeq: 0,
    currentTurn: 0,
    samples: [],
    errors: 0,
    toolCount: 0,
    userEffort: null,
  }
}

/** Narrow a raw event to a record with an object `data` field. */
function dataOf(event: unknown): Record<string, unknown> | undefined {
  if (typeof event !== 'object' || event === null) return undefined
  const data = (event as { data?: unknown }).data
  return typeof data === 'object' && data !== null ? data as Record<string, unknown> : undefined
}

/**
 * Whether one `user/message` event was authored by a human.
 *
 * `user/message` is the shared carrier for three very different producers
 * (`dsh-session/lib/types/types.d.ts`: "a direct human prompt …, a synthetic
 * `agent.inject()` context (file-change notices, subdir AGENTS.md, skill
 * content, cron notifications, …), or an entered goal continuation round … all
 * three project their `content` verbatim; `source` tells them apart").
 *
 * Treating a synthetic inject as a prompt would be actively harmful here: one
 * skill body is a few thousand characters of prose, which the classifier scores
 * as `complex` — the plugin would jump to `max` and wipe the tool window on
 * every injected context, i.e. become a constant-high switch that also loses
 * history. So only `source.kind === 'user'` (a direct prompt, or a browser
 * prompt through the `user-rpc` source, which also declares `kind: 'user'`)
 * advances the state; an absent source counts as NOT human.
 */
function isHumanMessage(data: Record<string, unknown>): boolean {
  const source = data.source
  if (typeof source !== 'object' || source === null) return false
  return (source as { kind?: unknown }).kind === 'user'
}

/**
 * Fold one committed Session event into the difficulty state.
 *
 * Unrelated events return the SAME reference — the projection registry gates
 * its change feed on `Object.is`, so rebuilding state for every streamed chunk
 * would wake every client-visible unit on each append.
 *
 * Malformed records are skipped rather than thrown on: `apply` runs inside the
 * session's append path, where a throw would poison the whole session log.
 *
 * @param state - state before the event.
 * @param event - next committed Session event (raw wire shape; narrowed below).
 * @returns the original or advanced state.
 */
export function applyEffortProjection(state: EffortProjectionState, event: unknown): EffortProjectionState {
  if (typeof event !== 'object' || event === null) return state
  const type = (event as { type?: unknown }).type

  if (type === 'user/message') {
    const data = dataOf(event)
    // Synthetic context (skill bodies, AGENTS.md, cron notices, goal rounds):
    // keep the human prompt and the turn's tool history exactly as they are.
    if (data === undefined || !isHumanMessage(data)) return state
    return {
      ...state,
      latestUserText: extractUserText(data),
      promptSeq: state.promptSeq + 1,
      // A new question starts a new scheduling window: the previous turn's
      // calls say nothing about how hard THIS one is (upstream's shared ring
      // was the source of the drift).
      samples: [],
      errors: 0,
      toolCount: 0,
    }
  }

  if (type === 'turn/start') {
    const data = dataOf(event)
    if (data === undefined) return state
    const turn = data.turn
    return {
      ...state,
      // A turn switch without a numeric turn (synthetic event, future format)
      // keeps the known turn rather than writing NaN into the row.
      currentTurn: typeof turn === 'number' && Number.isFinite(turn) ? turn : state.currentTurn,
      samples: [],
      errors: 0,
      toolCount: 0,
    }
  }

  if (type === 'tool/call') {
    const sample = toolSampleOf(event)
    // A `tool/call` record without an object `data` has no name and no turn:
    // counting it would inflate `toolCount` with a phantom call.
    if (sample === undefined) return state
    // Stale call from an earlier turn (out-of-order replay, fork seed): it does
    // not belong to the window the scheduler reads. Turn 0 means "unknown"
    // (legacy fixture), which is appended rather than dropped.
    if (sample.turn > 0 && state.currentTurn > 0 && sample.turn !== state.currentTurn) return state
    const grown = [...state.samples, sample]
    return {
      ...state,
      samples: grown.length > TOOL_SAMPLE_WINDOW ? grown.slice(grown.length - TOOL_SAMPLE_WINDOW) : grown,
      toolCount: state.toolCount + 1,
    }
  }

  if (type === 'tool/result') {
    const data = dataOf(event)
    if (data === undefined) return state
    // Two wire forms carry failure: `error` (present only when the tool failed,
    // `dsh-session` types: "allowed only when the message has isError: true")
    // and the message's own `isError` flag. Either one counts the call once; a
    // falsey `error` (false / null / 0 / '') is not a failure identity.
    const error = data.error
    const message = data.message
    const failedByMessage = typeof message === 'object' && message !== null
      && (message as { isError?: unknown }).isError === true
    const failedByError = Boolean(error)
    if (!failedByMessage && !failedByError) return state
    return { ...state, errors: state.errors + 1 }
  }

  if (type === 'model/selection') {
    const data = dataOf(event)
    if (data === undefined) return state
    const raw = data.reasoningEffort
    const userEffort = typeof raw === 'string' && raw.length > 0 ? raw : null
    return userEffort === state.userEffort ? state : { ...state, userEffort }
  }

  return state
}

/**
 * Build the `tlEffortDifficulty` projection definition.
 *
 * `stateVersion: 2` — the upstream unit shipped version 1 with a different
 * shape (`{ samples, userEffort }`). A persisted v1 row cannot be folded
 * forward, so the version bump makes the registry discard it and re-fold from
 * the event log instead of handing the scheduler `undefined` fields.
 *
 * Registered soft-coupled (runtime inject), exactly like `tlCacheBilling`:
 * hosts whose registry cannot serve `stateOf` simply never register it and the
 * injection path falls back to `safeFallback`.
 */
export function buildEffortProjectionDefinition() {
  return {
    key: EFFORT_DIFFICULTY_KEY,
    stateVersion: 2,
    stateSchema,
    init: initEffortProjection,
    apply: applyEffortProjection,
  }
}

/** The one service surface this unit needs (duck-typed to stay version-agnostic). */
interface ProjectionReader {
  stateOf?: (session: unknown, key: string) => unknown
}

/** A finite, non-negative number, or the given fallback. */
function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/**
 * Coerce a registry value into a complete state.
 *
 * The scheduler reads `latestUserText`, `errors`, `toolCount` and `samples`
 * unconditionally (a `undefined` message would throw inside the classifier,
 * and an `agent/request` throw silently ends the turn). A registry that hands
 * back an older/partial row — or a third-party unit that registered this key
 * without this schema — therefore gets field-by-field defaults instead of
 * `undefined` propagation.
 */
function normalizeState(raw: unknown): EffortProjectionState | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const record = raw as Record<string, unknown>
  const samples: ToolCallSample[] = []
  if (Array.isArray(record.samples)) {
    for (const entry of record.samples) {
      if (typeof entry !== 'object' || entry === null) continue
      const sample = entry as Record<string, unknown>
      samples.push({
        name: typeof sample.name === 'string' && sample.name.length > 0 ? sample.name : 'tool',
        argsSize: numberOr(sample.argsSize, 0),
        turn: numberOr(sample.turn, 0),
        step: numberOr(sample.step, 0),
      })
    }
  }
  return {
    latestUserText: typeof record.latestUserText === 'string' ? record.latestUserText : '',
    promptSeq: numberOr(record.promptSeq, 0),
    currentTurn: numberOr(record.currentTurn, 0),
    samples: samples.length > TOOL_SAMPLE_WINDOW
      ? samples.slice(samples.length - TOOL_SAMPLE_WINDOW)
      : samples,
    errors: numberOr(record.errors, 0),
    toolCount: numberOr(record.toolCount, 0),
    userEffort: typeof record.userEffort === 'string' && record.userEffort.length > 0
      ? record.userEffort
      : null,
  }
}

/**
 * Read the folded difficulty state for a session.
 *
 * Returns `undefined` — never throws — when the host cannot serve it: the
 * service is absent, or the registry predates `stateOf` (0.1.0-rc.8 is the
 * legacy plane-contract registry with `schema`/`view` and no `stateOf`). A
 * thrown error here would take down the whole turn
 * (`agent-loop/README.md:128`: "plugin failure ends the turn").
 *
 * @param ctx - plugin context (only `get` is used).
 * @param session - the live session owning the state.
 * @returns the folded state, or undefined when unavailable.
 */
export function readEffortProjection(
  ctx: { get?: (name: string) => unknown },
  session: unknown,
): EffortProjectionState | undefined {
  if (typeof session !== 'object' || session === null) return undefined
  try {
    const service = ctx.get?.('sessionProjections') as ProjectionReader | undefined
    if (typeof service?.stateOf !== 'function') return undefined
    return normalizeState(service.stateOf(session, EFFORT_DIFFICULTY_KEY))
  } catch {
    return undefined
  }
}

/**
 * The level this request was asked for: the session's explicit pick when the
 * user made one, else the plugin-configured default.
 *
 * A pick is passed through VERBATIM, including ids this plugin does not know.
 * The model directory is per-route: a gateway may advertise its own wire values
 * (`ultra`, `reasoning`, …), and folding them away as "no pick" is the
 * user-intent defect this fork fixes — the plugin would then schedule a level
 * of its own over a choice the user made in the model panel. Whether the model
 * actually accepts the id is decided later, by
 * `resolveEffortInjection`/`clampForAuto` against the advertised list: a
 * custom id that IS advertised is passed through, one that is NOT is stripped
 * (never silently replaced by a scheduled level).
 *
 * @param state - folded state, when the host could serve it.
 * @param fallback - configured default level.
 * @returns the requested level id (plugin level, `auto`, or a custom wire id).
 */
export function requestedEffortOf(
  state: EffortProjectionState | undefined,
  fallback: EffortId,
): string {
  const user = state?.userEffort
  // `normalizeState` already collapses absent/empty picks to null; the second
  // guard keeps a hand-built state object honest.
  return typeof user === 'string' && user.length > 0 ? user : fallback
}
