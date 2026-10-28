import { describe, expect, it } from 'vitest'
import {
  applyEffortProjection,
  initEffortProjection,
  readEffortProjection,
  type EffortProjectionState,
} from '../src/auto-schedule-projection.ts'
import { DEFAULT_DIFFICULTY_CONFIG } from '../src/difficulty.ts'
import { STATUS_TOOL_NAME, buildStatusTool, decideRequestEffort } from '../src/index.ts'
import { resolveEffortInjection, type AutoEffort, type EffortId, type EffortInjectionDecision, type HysteresisState } from '../src/thinking-level.ts'

/**
 * End-to-end simulation of the `agent/request` handler without cordis.
 *
 * The projection is advanced by hand the way the host registry would, the
 * decision is produced by the SAME pure planner the plugin uses
 * (`decideRequestEffort`), and the injected level is fed back as the next
 * request's seed — the exact loop that froze `auto` after the first request
 * upstream (issue #6, bug 2).
 *
 * This is the automatable form of the runtime proof: the level follows the
 * message AND the turn's tool history, `[effort: x]` and a manual pick override
 * both, and no host echo can stop the scheduler.
 */
const EFFORTS = ['off', 'low', 'high', 'max', 'auto']

/** A human prompt (only `source.kind === 'user'` advances the projection). */
const prompt = (text: string) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: text },
})

const toolCall = (name: string, args = '', turn = 1) => ({
  type: 'tool/call',
  data: { turn, step: 1, callId: 'c', name, arguments: args },
})

const selection = (reasoningEffort: string) => ({
  type: 'model/selection',
  data: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort },
})

/** Long, structural work: the classifier lands it in `complex`. */
const COMPLEX_PROMPT = '重构 src/index.ts 的注入逻辑'
/** A cheap lookup: the classifier lands it in `trivial`. */
const SIMPLE_PROMPT = '读一下 README'

interface Host {
  projection: EffortProjectionState | undefined
  /** Per-session hysteresis memo (the plugin keeps it in a WeakMap). */
  hysteresis?: HysteresisState
  /** `request/header` = what the host persists, i.e. this plugin's own output. */
  lastHeaderEffort?: string
  efforts: readonly string[]
  steps: number
  allowUpgrade: boolean
  supportsReasoning: boolean
  toggleOnly: boolean
  safeFallback: AutoEffort
}

const makeHost = (patch: Partial<Host> = {}): Host => ({
  projection: initEffortProjection(),
  efforts: EFFORTS,
  steps: 1,
  allowUpgrade: true,
  supportsReasoning: true,
  toggleOnly: false,
  safeFallback: 'high',
  ...patch,
})

/** Fold events the way the host registry would, before the request is prepared. */
const fold = (host: Host, ...events: unknown[]): void => {
  if (host.projection === undefined) return
  for (const event of events) host.projection = applyEffortProjection(host.projection, event)
}

/** One `agent/request`, mirroring the handler minus capability resolution. */
const request = (host: Host, configuredLevel: EffortId = 'auto') => {
  const plan = decideRequestEffort({
    projection: host.projection,
    configuredLevel,
    difficulty: DEFAULT_DIFFICULTY_CONFIG,
    hysteresisSteps: host.steps,
    safeFallback: host.safeFallback,
    allowDowngrade: true,
    allowUpgrade: host.allowUpgrade,
    efforts: host.efforts,
    previous: host.hysteresis,
  })
  if (plan.hysteresis !== undefined) host.hysteresis = plan.hysteresis
  const decision: EffortInjectionDecision = plan.requested === undefined
    ? { inject: false }
    : resolveEffortInjection({
      supportsReasoning: host.supportsReasoning,
      // A session pick may be a custom gateway wire id (`ultra`): the manual
      // branch of `resolveEffortInjection` passes it through when advertised
      // and strips it otherwise — it never falls back to scheduling.
      requested: plan.requested,
      seedEffort: host.lastHeaderEffort,
      recentCalls: host.projection?.samples ?? [],
      allowDowngrade: true,
      allowUpgrade: host.allowUpgrade,
      efforts: host.efforts,
      toggleOnly: host.toggleOnly,
    })
  // buildRequest persists the post-waterfall config into request/header.
  host.lastHeaderEffort = decision.level
  return { plan, decision }
}

describe('difficulty-driven scheduling across a session', () => {
  it('keeps scheduling after the first request instead of freezing on the echo', () => {
    const host = makeHost()
    fold(host, prompt(SIMPLE_PROMPT))

    // Request #1 — a cheap lookup: the difficulty base is `low`.
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
    // The host now echoes `low` back as the next seed. Upstream read that echo
    // as a manual pick and stayed frozen for the rest of the session.
    expect(host.lastHeaderEffort).toBe('low')

    // Request #2 — the turn turns out to be heavy work: two 4 KB tool payloads.
    fold(
      host,
      toolCall('mcp__docs', 'x'.repeat(4000)),
      toolCall('mcp__docs', 'x'.repeat(4000)),
    )
    expect(request(host).decision).toEqual({ inject: true, level: 'max' })
  })

  it('scores a fresh, cheap prompt as low and a structural one at the hub', () => {
    const simple = makeHost()
    fold(simple, prompt(SIMPLE_PROMPT))
    expect(request(simple).decision).toEqual({ inject: true, level: 'low' })

    const complexNoUpgrade = makeHost({ allowUpgrade: false })
    fold(complexNoUpgrade, prompt(COMPLEX_PROMPT))
    expect(request(complexNoUpgrade).decision).toEqual({ inject: true, level: 'high' })

    const complexUpgrade = makeHost({ allowUpgrade: true })
    fold(complexUpgrade, prompt(COMPLEX_PROMPT))
    expect(request(complexUpgrade).decision).toEqual({ inject: true, level: 'max' })
  })

  it('honours an explicit pick, and returns to scheduling when auto is re-picked', () => {
    const host = makeHost()
    fold(host, selection('auto'), prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })

    // User picks high mid-session (only `model/selection` records this).
    fold(host, selection('high'))
    expect(request(host).decision).toEqual({ inject: true, level: 'high' })
    fold(host, toolCall('mcp__docs', 'x'.repeat(4000)), toolCall('mcp__docs', 'x'.repeat(4000)))
    expect(request(host).decision).toEqual({ inject: true, level: 'high' })

    // Back to auto: the turn's heavy history lifts it again.
    fold(host, selection('auto'))
    expect(request(host).decision).toEqual({ inject: true, level: 'max' })
  })

  it('does not let a manual pick equal to the echoed level get re-scheduled', () => {
    // The WeakMap-based upstream patch failed exactly here: a manual `low` that
    // happened to equal the last injected level was mistaken for an echo.
    const host = makeHost()
    fold(host, selection('auto'), prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })

    fold(host, selection('low'))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
    // Heavy history must NOT lift the level while `low` is explicitly picked.
    fold(host, toolCall('mcp__docs', 'x'.repeat(4000)), toolCall('mcp__docs', 'x'.repeat(4000)))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
  })

  it('lets an in-message [effort: max] override the score for that turn', () => {
    const host = makeHost({ allowUpgrade: false })
    fold(host, prompt('[effort: max] 读一下 README'))
    const { plan, decision } = request(host)
    expect(plan.manual).toBe(true)
    expect(plan.result?.explicit).toBe('max')
    expect(decision).toEqual({ inject: true, level: 'max' })
  })

  it('falls back to the configured level when the session never picked', () => {
    const host = makeHost()
    fold(host, prompt(COMPLEX_PROMPT))
    // No `model/selection` at all: the config level is the manual intent.
    expect(request(host, 'high').decision).toEqual({ inject: true, level: 'high' })
  })
})

describe('hysteresis', () => {
  it('needs two consecutive proposals before switching gears', () => {
    const host = makeHost({ steps: 2, allowUpgrade: false })
    fold(host, prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })

    // One complex turn is not enough: a single anomalous request must not flap
    // the level (the candidate is pending, the level in force stays `low`).
    fold(host, prompt(COMPLEX_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })

    // A second consecutive complex turn takes over.
    fold(host, prompt(COMPLEX_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'high' })
  })

  it('cancels the pending candidate when the in-force level is proposed again', () => {
    const host = makeHost({ steps: 2, allowUpgrade: false })
    fold(host, prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })

    fold(host, prompt(COMPLEX_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
    expect(host.hysteresis?.pending).toBe('high')

    // Back to a simple prompt: the candidate is dropped, not accumulated.
    fold(host, prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
    expect(host.hysteresis?.pending).toBeNull()

    // One complex turn later still cannot switch.
    fold(host, prompt(COMPLEX_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
  })
})

describe('capability handling', () => {
  it('falls back safely when the projection cannot be read', () => {
    const host = makeHost({ projection: undefined })
    const { plan, decision } = request(host)
    expect(plan.fallback).toBe(true)
    expect(plan.result).toBeUndefined()
    expect(plan.autoLevel).toBe('high')
    expect(decision).toEqual({ inject: true, level: 'high' })
  })

  it('clamps the fallback DOWNWARD before going up', () => {
    // The model takes low/high/max but not the hub? It advertises low + max.
    // Downward from `high` reaches `low` first — never `max`.
    const host = makeHost({ projection: undefined, efforts: ['off', 'low', 'max'] })
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
    // Without a lower advertised level the clamp may go up.
    const upOnly = makeHost({ projection: undefined, efforts: ['off', 'max'] })
    expect(request(upOnly).decision).toEqual({ inject: true, level: 'max' })
  })

  it('strips when the model advertises none of the auto trio', () => {
    const host = makeHost({ efforts: ['off', 'on'] })
    fold(host, prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: false })
  })

  it('strips for a model that advertises no reasoning effort at all', () => {
    const host = makeHost({ efforts: [] })
    fold(host, prompt(COMPLEX_PROMPT))
    expect(request(host).decision).toEqual({ inject: false })
  })

  it('folds a toggle-only model into Off/On semantics', () => {
    const host = makeHost({ efforts: ['off', 'high'], toggleOnly: true })
    fold(host, prompt(SIMPLE_PROMPT))
    // Scheduled `low`, clamped to the toggle level `high`, then the toggle maps
    // a non-off request onto `high` (enable_thinking without an effort string).
    expect(request(host).decision).toEqual({ inject: true, level: 'high' })
  })

  it('injects a custom gateway wire id the user picked, when the model advertises it', () => {
    const host = makeHost({ efforts: ['off', 'high', 'ultra'] })
    fold(host, selection('ultra'), prompt(SIMPLE_PROMPT))
    const { plan, decision } = request(host)
    expect(plan.intent).toBe('ultra')
    expect(plan.manual).toBe(true)
    // No clamping and no scheduling: the user's exact id reaches the wire.
    expect(decision).toEqual({ inject: true, level: 'ultra' })
  })

  it('strips a custom wire id the model does not advertise instead of scheduling', () => {
    const host = makeHost({ efforts: ['off', 'high'] })
    fold(host, selection('ultra'), prompt(SIMPLE_PROMPT))
    const { plan, decision } = request(host)
    expect(plan.manual).toBe(true)
    // Never falls back to `low`/`high` scheduling: an unadvertised manual pick
    // is stripped (the user asked for that exact level).
    expect(decision).toEqual({ inject: false })
  })

  it('still falls back to the configured level when the pick is null', () => {
    const host = makeHost()
    fold(host, prompt(SIMPLE_PROMPT))
    expect(host.projection?.userEffort).toBeNull()
    // No pick: the config default is `auto`, so the turn is scheduled (`low`).
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
  })

  it('passes a custom gateway wire id through on a manual pick', () => {
    // `ultra` is not a plugin level, but a manual selection stored as one is
    // still the user's pick and must reach the model when it is advertised.
    const host = makeHost({ efforts: ['off', 'low', 'high', 'max', 'ultra'] })
    fold(host, selection('auto'), prompt(SIMPLE_PROMPT))
    expect(request(host).decision).toEqual({ inject: true, level: 'low' })
  })
})

describe('no usable human prompt', () => {
  it('keeps the empty-prompt turn at the hub instead of downgrading it', () => {
    // A goal continuation round or cron trigger has no human prompt at all: the
    // projection exists, but `latestUserText` is empty. "Unknown difficulty" is
    // the hub, not "the easiest task ever".
    const host = makeHost()
    expect(host.projection?.latestUserText).toBe('')
    const { plan, decision } = request(host)
    expect(plan.fallback).toBe(true)
    expect(plan.autoLevel).toBe('high')
    expect(plan.result?.difficulty).toBe('moderate')
    expect(plan.result?.reasons).toContain('no-prompt')
    expect(decision).toEqual({ inject: true, level: 'high' })
  })

  it('treats a whitespace-only prompt as no prompt', () => {
    const host = makeHost()
    fold(host, prompt('   \n\t '))
    const { plan, decision } = request(host)
    expect(plan.fallback).toBe(true)
    expect(decision).toEqual({ inject: true, level: 'high' })
  })

  it('still scores a real one-word human prompt as trivial', () => {
    // The hub guard must not swallow genuine human text: "继续" really is cheap.
    const host = makeHost()
    fold(host, prompt('继续'))
    const { plan, decision } = request(host)
    expect(plan.fallback).toBe(false)
    expect(plan.result?.difficulty).toBe('trivial')
    expect(decision).toEqual({ inject: true, level: 'low' })
  })
})

describe('projection read path', () => {
  it('reads the folded state through the registry when available', () => {
    const host = makeHost()
    fold(host, prompt('修一下 src/index.ts 的注入'), toolCall('bash', 'ls'))
    const ctx = {
      get: () => ({
        stateOf: (_session: unknown, key: string) => (key === 'tlEffortDifficulty' ? host.projection : undefined),
      }),
    }
    const read = readEffortProjection(ctx, {})
    expect(read?.latestUserText).toBe('修一下 src/index.ts 的注入')
    expect(read?.samples).toEqual([{ name: 'bash', argsSize: 2, turn: 1, step: 1 }])
  })
})

describe('diagnostics tool', () => {
  it('exposes the host tool contract and renders the live snapshot as JSON text', async () => {
    const snapshot = { plugin: 'dsh-auto-reasoning-effort', hysteresisSteps: 2, lastDecision: null }
    const tool = buildStatusTool(() => snapshot)

    expect(tool.name).toBe(STATUS_TOOL_NAME)
    expect(tool.name).toBe('auto_reasoning_effort_status')
    // No model-supplied arguments; the registry validates this parameter shape.
    expect(tool.parameters).toMatchObject({ type: 'object', properties: {}, additionalProperties: false })
    expect(tool.output.schema).toMatchObject({ type: 'object' })

    const value = await tool.execute(undefined, undefined)
    expect(value).toEqual(snapshot)
    const blocks = tool.output.render(undefined, value)
    expect(blocks).toHaveLength(1)
    expect(blocks[0].type).toBe('text')
    expect(JSON.parse(blocks[0].text)).toEqual(snapshot)
  })
})
