import { describe, expect, it } from 'vitest'
import {
  EFFORT_DIFFICULTY_KEY,
  applyEffortProjection,
  buildEffortProjectionDefinition,
  initEffortProjection,
  readEffortProjection,
  requestedEffortOf,
  type EffortProjectionState,
} from '../src/auto-schedule-projection.ts'
import { TOOL_SAMPLE_WINDOW, USER_TEXT_MAX, extractUserText } from '../src/session-events.ts'

const empty = (): EffortProjectionState => initEffortProjection()

/** A real human prompt: `user/message` whose source declares the human producer. */
const prompt = (text: string) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: text },
})

/** A synthetic `agent.inject()` context: same event type, different producer. */
const synthetic = (kind: string | undefined, text: string) => ({
  type: 'user/message',
  data: { role: 'user', ...(kind === undefined ? {} : { source: { kind } }), content: text },
})

/** The durable user-message form: an array of content blocks. */
const promptBlocks = (...blocks: unknown[]) => ({
  type: 'user/message',
  data: { role: 'user', source: { kind: 'user' }, content: blocks },
})

/** The real wire shape: `{ turn, step, callId, name, arguments }`. */
const toolCall = (name: string, args = '', turn = 1, step = 1) => ({
  type: 'tool/call',
  data: { turn, step, callId: 'c', name, arguments: args },
})

const toolResult = (data: Record<string, unknown> = {}) => ({ type: 'tool/result', data })
const selection = (reasoningEffort?: unknown) => ({
  type: 'model/selection',
  data: { provider: 'deepseek-account', model: 'deepseek-flash', ...(reasoningEffort === undefined ? {} : { reasoningEffort }) },
})

/** Minimal projections service: only the surface the reader duck-types. */
const ctxWith = (service: unknown) => ({ get: (name: string) => (name === 'sessionProjections' ? service : undefined) })

describe('initEffortProjection', () => {
  it('starts cold: no text, no prompt, no turn, no samples, no pick', () => {
    expect(empty()).toEqual({
      latestUserText: '',
      promptSeq: 0,
      currentTurn: 0,
      samples: [],
      errors: 0,
      toolCount: 0,
      userEffort: null,
    })
  })

  it('returns a fresh array per call, so one session cannot fold into another', () => {
    const first = empty()
    const second = empty()
    expect(first.samples).not.toBe(second.samples)
    expect(first.samples).toHaveLength(0)
    expect(second.samples).toHaveLength(0)
  })
})

describe('applyEffortProjection — human prompts', () => {
  it('records the text, bumps the prompt sequence and resets the turn counters', () => {
    let state = empty()
    state = applyEffortProjection(state, toolCall('bash', 'echo hi'))
    state = applyEffortProjection(state, toolResult({ error: { name: 'E', code: 'X' } }))
    expect(state.toolCount).toBe(1)
    expect(state.errors).toBe(1)

    state = applyEffortProjection(state, prompt('帮我重构 index.ts'))
    expect(state.latestUserText).toBe('帮我重构 index.ts')
    expect(state.promptSeq).toBe(1)
    expect(state.samples).toEqual([])
    expect(state.errors).toBe(0)
    expect(state.toolCount).toBe(0)
  })

  it('flattens the block-array form, joining text blocks with one space', () => {
    const state = applyEffortProjection(empty(), promptBlocks(
      { type: 'text', text: 'first part' },
      { type: 'image', uri: 'x.png' },
      { type: 'reasoning', text: 'internal' },
      { type: 'text', text: 'second part' },
    ))
    expect(state.latestUserText).toBe('first part second part')
  })

  it('caps the stored text at USER_TEXT_MAX', () => {
    const state = applyEffortProjection(empty(), prompt('x'.repeat(USER_TEXT_MAX + 250)))
    expect(state.latestUserText).toHaveLength(USER_TEXT_MAX)
  })

  it('ignores a synthetic inject: no reset, no text override, same reference', () => {
    let state = applyEffortProjection(empty(), prompt('真实提问'))
    state = applyEffortProjection(state, toolCall('bash', 'ls'))
    const frozen = state
    // skill body / AGENTS.md / cron notice / goal round — all `user/message`
    // with a non-human source. They must not be mistaken for a prompt.
    state = applyEffortProjection(state, synthetic('skill-invocation', '<skill_content>long body</skill_content>'))
    expect(state).toBe(frozen)
    expect(state.latestUserText).toBe('真实提问')
    expect(state.promptSeq).toBe(1)
    expect(state.samples).toHaveLength(1)
  })

  it('ignores a user/message with no source at all (unknown producer is not human)', () => {
    const state = empty()
    expect(applyEffortProjection(state, synthetic(undefined, 'no source'))).toBe(state)
  })

  it('ignores a malformed user/message without data', () => {
    const state = empty()
    expect(applyEffortProjection(state, { type: 'user/message' })).toBe(state)
    expect(applyEffortProjection(state, { type: 'user/message', data: null })).toBe(state)
  })

  it('keeps the session pick across prompts and counts prompts monotonically', () => {
    let state = applyEffortProjection(empty(), selection('auto'))
    state = applyEffortProjection(state, prompt('第一个问题'))
    state = applyEffortProjection(state, prompt('第二个问题'))
    expect(state.promptSeq).toBe(2)
    expect(state.userEffort).toBe('auto')
  })
})

describe('applyEffortProjection — turn switch', () => {
  it('records the turn and clears the per-turn window', () => {
    let state = applyEffortProjection(empty(), prompt('做点事'))
    state = applyEffortProjection(state, toolCall('bash', 'ls'))
    state = applyEffortProjection(state, toolResult({ message: { isError: true } }))
    state = applyEffortProjection(state, { type: 'turn/start', data: { turn: 4 } })
    expect(state.currentTurn).toBe(4)
    expect(state.samples).toEqual([])
    expect(state.errors).toBe(0)
    expect(state.toolCount).toBe(0)
    // The human prompt survives a turn switch: it is what the next request scores.
    expect(state.latestUserText).toBe('做点事')
  })

  it('keeps the known turn when the switch carries no numeric turn, still resetting', () => {
    let state = applyEffortProjection(empty(), { type: 'turn/start', data: { turn: 2 } })
    state = applyEffortProjection(state, toolCall('bash', 'ls', 2))
    state = applyEffortProjection(state, { type: 'turn/start', data: {} })
    expect(state.currentTurn).toBe(2)
    expect(state.toolCount).toBe(0)
  })
})

describe('applyEffortProjection — tool calls', () => {
  it('appends a sample with its turn/step and counts the call', () => {
    const state = applyEffortProjection(empty(), toolCall('fs_read', 'x'.repeat(20), 3, 7))
    expect(state.samples).toEqual([{ name: 'fs_read', argsSize: 20, turn: 3, step: 7 }])
    expect(state.toolCount).toBe(1)
  })

  it('skips a malformed call instead of inventing one (same reference)', () => {
    let state = empty()
    for (const event of [{ type: 'tool/call' }, { type: 'tool/call', data: null }]) {
      const next = applyEffortProjection(state, event)
      expect(next).toBe(state)
      state = next
    }
    expect(state.toolCount).toBe(0)
  })

  it('caps the ring at TOOL_SAMPLE_WINDOW while toolCount keeps counting', () => {
    let state = empty()
    for (let index = 0; index < TOOL_SAMPLE_WINDOW + 4; index += 1) {
      state = applyEffortProjection(state, toolCall(`tool_${index}`, `${index}`))
    }
    expect(state.samples).toHaveLength(TOOL_SAMPLE_WINDOW)
    // 12 calls happened; only 8 are sampled. The count is its own difficulty
    // signal, so the window must not truncate it.
    expect(state.toolCount).toBe(TOOL_SAMPLE_WINDOW + 4)
    expect(state.samples[0]?.name).toBe('tool_4')
    expect(state.samples.at(-1)?.name).toBe(`tool_${TOOL_SAMPLE_WINDOW + 3}`)
  })

  it('drops a stale call belonging to an earlier turn of the same session', () => {
    let state = applyEffortProjection(empty(), { type: 'turn/start', data: { turn: 3 } })
    const frozen = state
    state = applyEffortProjection(state, toolCall('bash', 'ls', 1))
    expect(state).toBe(frozen)
    expect(state.toolCount).toBe(0)
  })

  it('still accepts calls before the first turn/start (unknown current turn)', () => {
    const state = applyEffortProjection(empty(), toolCall('bash', 'ls', 1))
    expect(state.samples).toHaveLength(1)
    expect(state.toolCount).toBe(1)
  })
})

describe('applyEffortProjection — tool errors', () => {
  it('counts the error identity form', () => {
    const state = applyEffortProjection(empty(), toolResult({ error: { name: 'ToolError', code: 'E_BAD' } }))
    expect(state.errors).toBe(1)
  })

  it('counts the message.isError form', () => {
    let state = empty()
    state = applyEffortProjection(state, toolResult({ message: { role: 'tool', isError: true } }))
    expect(state.errors).toBe(1)
  })

  it('counts one failing result once even when both forms are present', () => {
    const state = applyEffortProjection(empty(), toolResult({
      message: { isError: true },
      error: { name: 'E', code: 'X' },
    }))
    expect(state.errors).toBe(1)
  })

  it('leaves a clean result untouched (same reference)', () => {
    const state = empty()
    for (const data of [{ message: { isError: false } }, { error: null }, { error: false }, {}]) {
      expect(applyEffortProjection(state, toolResult(data))).toBe(state)
    }
  })

  it('ignores a malformed result', () => {
    const state = empty()
    expect(applyEffortProjection(state, { type: 'tool/result' })).toBe(state)
  })
})

describe('applyEffortProjection — explicit pick', () => {
  it('records a non-empty reasoningEffort', () => {
    expect(applyEffortProjection(empty(), selection('auto')).userEffort).toBe('auto')
    expect(applyEffortProjection(empty(), selection('high')).userEffort).toBe('high')
  })

  it('clears to null for an empty or non-string pick', () => {
    const picked = applyEffortProjection(empty(), selection('high'))
    expect(applyEffortProjection(picked, selection('')).userEffort).toBeNull()
    expect(applyEffortProjection(picked, selection(42)).userEffort).toBeNull()
    expect(applyEffortProjection(picked, selection()).userEffort).toBeNull()
  })

  it('keeps the same reference when the pick did not change', () => {
    const picked = applyEffortProjection(empty(), selection('auto'))
    expect(applyEffortProjection(picked, selection('auto'))).toBe(picked)
  })
})

describe('applyEffortProjection — inert and malformed events', () => {
  it('returns the same reference for unrelated events', () => {
    const state = empty()
    for (const event of [
      { type: 'assistant/chunk', data: {} },
      { type: 'request/header', data: {} },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'model/selection', data: null },
      null,
      undefined,
      'nope',
      42,
    ]) {
      expect(applyEffortProjection(state, event)).toBe(state)
    }
  })

  it('never throws on hostile payloads', () => {
    const state = empty()
    const hostile: unknown[] = [
      { type: 'user/message', data: { source: 'user', content: 42 } },
      { type: 'user/message', data: { source: { kind: 'user' }, content: [null, 7, { type: 'text', text: 9 }] } },
      { type: 'tool/call', data: { name: 9, arguments: {}, turn: 'x' } },
      { type: 'tool/result', data: { message: 'str', error: 0 } },
      { type: 'turn/start', data: { turn: Number.NaN } },
      { type: 'model/selection', data: { reasoningEffort: { nested: true } } },
    ]
    for (const event of hostile) {
      expect(() => applyEffortProjection(state, event)).not.toThrow()
    }
    // The human-shaped one with no usable text block folds to an empty prompt,
    // not to `[object Object]`.
    const folded = hostile.slice(0, 2).reduce<EffortProjectionState>(
      (current, event) => applyEffortProjection(current, event),
      state,
    )
    expect(folded.latestUserText).toBe('')
  })
})

describe('buildEffortProjectionDefinition', () => {
  it('declares the new key at stateVersion 2 with a parseable schema', () => {
    const definition = buildEffortProjectionDefinition()
    expect(definition.key).toBe(EFFORT_DIFFICULTY_KEY)
    // Version 1 was upstream's `{ samples, userEffort }` shape: a persisted v1
    // row cannot be folded forward, so the bump makes the registry re-fold.
    expect(definition.stateVersion).toBe(2)
    const initial = definition.init()
    expect(initial).toEqual(empty())
    expect(definition.stateSchema.parse(initial)).toEqual(initial)
  })

  it('accepts a persisted row and strips unknown keys', () => {
    const definition = buildEffortProjectionDefinition()
    const parsed = definition.stateSchema.parse({
      latestUserText: 'hi',
      promptSeq: 3,
      currentTurn: 2,
      samples: [{ name: 'bash', argsSize: 3, turn: 2, step: 1 }],
      errors: 1,
      toolCount: 4,
      userEffort: 'auto',
      // a field a future version might drop — must not poison the cache row
      legacyField: true,
    })
    expect(parsed).toEqual({
      latestUserText: 'hi',
      promptSeq: 3,
      currentTurn: 2,
      samples: [{ name: 'bash', argsSize: 3, turn: 2, step: 1 }],
      errors: 1,
      toolCount: 4,
      userEffort: 'auto',
    })
  })
})

describe('readEffortProjection — capability gate', () => {
  const folded = () => {
    let state = applyEffortProjection(empty(), prompt('修一下这个 bug'))
    state = applyEffortProjection(state, toolCall('bash', 'ls'))
    return state
  }

  it('reads the folded state when the registry serves stateOf', () => {
    const service = { stateOf: (_session: unknown, key: string) => (key === EFFORT_DIFFICULTY_KEY ? folded() : undefined) }
    expect(readEffortProjection(ctxWith(service), {})).toEqual(folded())
  })

  it('returns undefined when the service is absent', () => {
    expect(readEffortProjection(ctxWith(undefined), {})).toBeUndefined()
    expect(readEffortProjection({}, {})).toBeUndefined()
  })

  it('returns undefined on the 0.1.0-rc.8 registry, which has no stateOf', () => {
    expect(readEffortProjection(ctxWith({ register: () => {} }), {})).toBeUndefined()
  })

  it('never throws when the registry does', () => {
    const service = { stateOf: () => { throw new Error('boom') } }
    expect(readEffortProjection(ctxWith(service), {})).toBeUndefined()
  })

  it('returns undefined without a session', () => {
    const service = { stateOf: () => folded() }
    expect(readEffortProjection(ctxWith(service), undefined)).toBeUndefined()
    expect(readEffortProjection(ctxWith(service), null)).toBeUndefined()
  })

  it('normalizes a partial/legacy row instead of propagating undefined', () => {
    const service = { stateOf: () => ({ samples: [{ name: 'bash', argsSize: 4 }], userEffort: 'auto' }) }
    const state = readEffortProjection(ctxWith(service), {})
    expect(state).toEqual({
      latestUserText: '',
      promptSeq: 0,
      currentTurn: 0,
      samples: [{ name: 'bash', argsSize: 4, turn: 0, step: 0 }],
      errors: 0,
      toolCount: 0,
      userEffort: 'auto',
    })
  })
})

describe('requestedEffortOf', () => {
  it('prefers the session pick over the configured default', () => {
    expect(requestedEffortOf({ ...empty(), userEffort: 'high' }, 'auto')).toBe('high')
    expect(requestedEffortOf({ ...empty(), userEffort: 'auto' }, 'low')).toBe('auto')
  })

  it('falls back when the session never picked', () => {
    expect(requestedEffortOf(undefined, 'auto')).toBe('auto')
    expect(requestedEffortOf(empty(), 'low')).toBe('low')
    expect(requestedEffortOf({ ...empty(), userEffort: null }, 'high')).toBe('high')
  })

  it('passes a custom gateway wire id through verbatim (user intent beats scheduling)', () => {
    // `ultra` is not one of this plugin's levels, but it IS what the user picked
    // in the model panel. Discarding it would let the scheduler override an
    // explicit choice — the advertisement gate downstream decides pass/strip.
    expect(requestedEffortOf({ ...empty(), userEffort: 'ultra' }, 'auto')).toBe('ultra')
    expect(requestedEffortOf({ ...empty(), userEffort: 'reasoning' }, 'auto')).toBe('reasoning')
  })
})

describe('extractUserText', () => {
  it('returns string content as-is', () => {
    expect(extractUserText({ content: 'hello' })).toBe('hello')
  })

  it('joins text blocks and skips every other block type', () => {
    expect(extractUserText({
      content: [
        { type: 'text', text: 'a' },
        { type: 'image', uri: 'x' },
        { type: 'text', text: 'b' },
      ],
    })).toBe('a b')
  })

  it('caps the flattened text at USER_TEXT_MAX', () => {
    expect(extractUserText({ content: 'y'.repeat(USER_TEXT_MAX + 5) })).toHaveLength(USER_TEXT_MAX)
    expect(extractUserText({ content: [{ type: 'text', text: 'z'.repeat(USER_TEXT_MAX + 5) }] })).toHaveLength(USER_TEXT_MAX)
  })

  it('reads every unreadable shape as the empty string', () => {
    for (const data of [undefined, null, 'text', 42, {}, { content: 42 }, { content: [null] }]) {
      expect(extractUserText(data)).toBe('')
    }
  })
})
