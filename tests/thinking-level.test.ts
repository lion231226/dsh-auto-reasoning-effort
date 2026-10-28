import { describe, expect, it } from 'vitest'
import {
  classifyDifficulty,
  DEFAULT_DIFFICULTY_CONFIG,
} from '../src/difficulty.ts'
import {
  EFFORT_SLIDER_RANK,
  SIMPLE_TOOL_RE,
  applyHysteresis,
  baseEffortFor,
  clampForAuto,
  decideEffort,
  isEffortId,
  nearestEffortStopIndex,
  orderEffortsForSlider,
  reasoningEffortSupported,
  resolveEffortInjection,
  toolDurationMs,
  type DecidedEffort,
  type DecideEffortInput,
  type EffortInjectionInput,
  type ToolCallSample,
} from '../src/thinking-level.ts'

/* ── fixtures ─────────────────────────────────────────────────────────────── */

/** One tool sample of the current turn; turn/step default to the first one. */
const call = (name: string, argsSize: number, turn = 1, step = 1): ToolCallSample => ({
  name, argsSize, turn, step,
})

/**
 * Neutral padding with no substring that any keyword table matches, so a
 * length-band test measures the length rule and nothing else.
 */
const filler = (length: number): string => 'a'.repeat(length)

const decide = (over: Partial<DecideEffortInput> = {}): DecidedEffort => decideEffort({
  selected: 'auto',
  difficulty: 'moderate',
  recentCalls: [],
  allowDowngrade: true,
  allowUpgrade: true,
  ...over,
})

const injection = (over: Partial<EffortInjectionInput> = {}): EffortInjectionInput => ({
  supportsReasoning: true,
  requested: 'auto',
  seedEffort: undefined,
  recentCalls: [],
  allowDowngrade: true,
  allowUpgrade: true,
  efforts: ['off', 'low', 'high', 'max', 'auto'],
  toggleOnly: false,
  ...over,
})

/* ── difficulty: explicit override ────────────────────────────────────────── */

describe('classifyDifficulty — explicit effort marker', () => {
  it('returns the requested level immediately, whatever the message size', () => {
    const result = classifyDifficulty({ message: `[effort: HIGH] ${'重构'.repeat(100)}` })
    expect(result.difficulty).toBe('explicit')
    expect(result.explicit).toBe('high')
    expect(result.score).toBe(1)
    expect(result.reasons).toEqual(['explicit:high'])
  })

  it('accepts all three bracket styles and both separators', () => {
    expect(classifyDifficulty({ message: '{effort=off}' }).explicit).toBe('off')
    expect(classifyDifficulty({ message: '【EFFORT : MAX】跑一下测试' }).explicit).toBe('max')
    expect(classifyDifficulty({ message: '[ Effort = Low ] 看看日志' }).explicit).toBe('low')
  })

  it('ignores unsupported levels inside a marker and unbracketed mentions', () => {
    const unsupported = classifyDifficulty({ message: '[effort: auto] 看看日志' })
    expect(unsupported.difficulty).not.toBe('explicit')
    expect(unsupported.explicit).toBeUndefined()
    // Prose that merely mentions the syntax must not become a manual pick.
    expect(classifyDifficulty({ message: 'effort: high 是什么意思' }).explicit).toBeUndefined()
  })
})

/* ── difficulty: length base ──────────────────────────────────────────────── */

describe('classifyDifficulty — length base', () => {
  it('scores the six length bands exactly as the SPEC table', () => {
    expect(classifyDifficulty({ message: '' }).score).toBeCloseTo(0.05)
    expect(classifyDifficulty({ message: '你好呀' }).score).toBeCloseTo(0.05)
    expect(classifyDifficulty({ message: filler(8) }).score).toBeCloseTo(0.15)
    expect(classifyDifficulty({ message: filler(29) }).score).toBeCloseTo(0.15)
    expect(classifyDifficulty({ message: filler(30) }).score).toBeCloseTo(0.30)
    expect(classifyDifficulty({ message: filler(79) }).score).toBeCloseTo(0.30)
    expect(classifyDifficulty({ message: filler(80) }).score).toBeCloseTo(0.45)
    expect(classifyDifficulty({ message: filler(199) }).score).toBeCloseTo(0.45)
    expect(classifyDifficulty({ message: filler(200) }).score).toBeCloseTo(0.60)
    expect(classifyDifficulty({ message: filler(499) }).score).toBeCloseTo(0.60)
    expect(classifyDifficulty({ message: filler(500) }).score).toBeCloseTo(0.75)
  })

  it('bands those bases as trivial / simple / moderate / complex', () => {
    expect(classifyDifficulty({ message: '你好呀' }).difficulty).toBe('trivial')
    expect(classifyDifficulty({ message: filler(30) }).difficulty).toBe('simple')
    expect(classifyDifficulty({ message: filler(80) }).difficulty).toBe('moderate')
    expect(classifyDifficulty({ message: filler(500) }).difficulty).toBe('complex')
  })

  it('measures the trimmed message, not the raw paste', () => {
    const result = classifyDifficulty({ message: `\n\n   ${filler(30)}   \n` })
    expect(result.reasons).toContain('len:30')
    expect(result.score).toBeCloseTo(0.30)
  })

  it('reads a non-string message as empty instead of throwing', () => {
    // The projection is host-supplied; a malformed fold must never end a turn.
    const result = classifyDifficulty({ message: undefined as unknown as string })
    expect(result.difficulty).toBe('trivial')
    expect(result.reasons).toEqual(['len:0'])
  })
})

/* ── difficulty: keyword weights ──────────────────────────────────────────── */

describe('classifyDifficulty — keyword weights', () => {
  it('raises a short message to the complex-keyword floor and adds 0.10', () => {
    const result = classifyDifficulty({ message: 'debug this' })
    // 0.60 floor + 0.10 lands exactly on the complex band edge.
    expect(result.score).toBeCloseTo(0.70)
    expect(result.difficulty).toBe('complex')
    expect(result.reasons).toContain('kw:debug')
  })

  it('applies the complex weight once even when several words hit', () => {
    const single = classifyDifficulty({ message: '重构一下' })
    const several = classifyDifficulty({ message: '重构并设计一下' })
    expect(several.score).toBeCloseTo(single.score)
    expect(several.reasons).toContain('kw:重构')
    expect(several.reasons).toContain('kw:设计')
  })

  it('adds 0.10 for a heavy keyword', () => {
    const result = classifyDifficulty({ message: '把全部文件都处理掉' })
    expect(result.score).toBeCloseTo(0.25)
    expect(result.reasons).toContain('kw:全部')
  })

  it('multiplies by 0.7 for a simple keyword', () => {
    const result = classifyDifficulty({ message: 'read this file' })
    expect(result.score).toBeCloseTo(0.15 * 0.7)
    expect(result.difficulty).toBe('trivial')
    expect(result.reasons).toContain('kw:read')
  })

  it('suppresses the simple discount once a complex keyword fired', () => {
    // 0.05 → complex floor 0.60 + 0.10 = 0.70; the casual "读取" must not pull
    // the refactor request back down to moderate.
    const result = classifyDifficulty({ message: '重构并读取配置' })
    expect(result.score).toBeCloseTo(0.70)
    expect(result.difficulty).toBe('complex')
    expect(result.reasons).toContain('kw:重构')
    expect(result.reasons).toContain('kw:读取(suppressed)')
  })

  it('collapses acknowledgements on short messages', () => {
    const result = classifyDifficulty({ message: '谢谢' })
    expect(result.score).toBeCloseTo(Math.min(0.05 * 0.3, 0.2))
    expect(result.difficulty).toBe('trivial')
    expect(result.reasons).toContain('kw:谢谢')
  })

  it('keeps trivial words inert on a long message', () => {
    // len 62: the same word is connective tissue in a real request.
    const result = classifyDifficulty({ message: `谢谢${filler(60)}` })
    expect(result.score).toBeCloseTo(0.30)
    expect(result.reasons).not.toContain('kw:谢谢')
  })
})

/* ── difficulty: cheap signals never veto expensive ones ──────────────────── */

describe('classifyDifficulty — cheap signals never veto expensive ones', () => {
  it('sends a short refactor request to complex (0.60 floor + 0.10)', () => {
    const result = classifyDifficulty({ message: '重构这个模块' })
    expect(result.score).toBeCloseTo(0.70)
    expect(result.difficulty).toBe('complex')
    expect(result.reasons).toContain('kw:重构')
  })

  it('keeps a polite prefix from downgrading the refactor', () => {
    const result = classifyDifficulty({ message: '好的，重构一下整个模块' })
    expect(result.reasons).toContain('kw:好的(suppressed)')
    expect(result.difficulty).toBe('complex')
  })

  it('does not let "收到" scale an agent-loop refactor down', () => {
    const result = classifyDifficulty({ message: '收到 重构 agent loop' })
    expect(result.reasons).toContain('kw:收到(suppressed)')
    expect(result.difficulty).toBe('complex')
  })

  it('does not let "看" veto an architecture question', () => {
    const result = classifyDifficulty({ message: '看看这个架构' })
    expect(result.score).toBeCloseTo(0.70)
    expect(result.reasons).toContain('kw:看(suppressed)')
    expect(result.difficulty).toBe('complex')
  })

  it('still applies the simple discount when nothing expensive fired', () => {
    const result = classifyDifficulty({ message: '读一下 README' })
    expect(result.score).toBeCloseTo(0.15 * 0.7)
    expect(result.difficulty).toBe('trivial')
    expect(result.reasons).toContain('kw:读')
    expect(result.reasons).not.toContain('kw:读(suppressed)')
  })

  it('still collapses a bare acknowledgement', () => {
    const result = classifyDifficulty({ message: '继续' })
    expect(result.score).toBeCloseTo(0.05 * 0.3)
    expect(result.difficulty).toBe('trivial')
    expect(result.reasons).toContain('kw:继续')
  })
})

/* ── difficulty: bare heavy scope words have no floor ─────────────────────── */

describe('classifyDifficulty — bare heavy scope words have no floor', () => {
  it('adds only 0.10 for a heavy hit', () => {
    const trivial = classifyDifficulty({ message: '全部数据' })
    expect(trivial.score).toBeCloseTo(0.15) // len 4 → 0.05 + 0.10
    expect(trivial.difficulty).toBe('trivial')

    const simple = classifyDifficulty({ message: '把全部文件都处理掉' })
    expect(simple.score).toBeCloseTo(0.25) // len 9 → 0.15 + 0.10
    expect(simple.difficulty).toBe('simple')
  })
})

/* ── difficulty: ASCII keywords match whole words only ────────────────────── */

describe('classifyDifficulty — ASCII keywords match whole words only', () => {
  it('does not read "install" / "allocation" as the heavy "all"', () => {
    for (const message of ['install the package', 'the allocation is wrong']) {
      const result = classifyDifficulty({ message })
      expect(result.reasons, message).not.toContain('kw:all')
      expect(result.score, message).toBeCloseTo(0.15)
    }
  })

  it('does not read "call" / "small" as the heavy "all"', () => {
    for (const message of ['call the API twice', 'small change please']) {
      const result = classifyDifficulty({ message })
      expect(result.reasons, message).not.toContain('kw:all')
      expect(result.score, message).toBeCloseTo(0.15)
    }
  })

  it('still matches the heavy word on its own boundaries', () => {
    const result = classifyDifficulty({ message: 'all files under src' })
    expect(result.reasons).toContain('kw:all')
    expect(result.score).toBeCloseTo(0.25) // len 19 → 0.15 + 0.10
  })

  it('does not match "complete" inside "incomplete"', () => {
    expect(classifyDifficulty({ message: 'incomplete draft' }).reasons).not.toContain('kw:complete')
    expect(classifyDifficulty({ message: 'complete the task' }).reasons).toContain('kw:complete')
  })

  it('does not match "cat" inside "category"', () => {
    const result = classifyDifficulty({ message: 'sort the category list' })
    expect(result.reasons).not.toContain('kw:cat')
  })
})

/* ── difficulty: structural signals ───────────────────────────────────────── */

describe('classifyDifficulty — structural signals', () => {
  it('adds 0.15 for a fenced code block', () => {
    const result = classifyDifficulty({ message: '```ts\nconst a = 1\n```' })
    expect(result.reasons).toContain('code-block')
    expect(result.score).toBeCloseTo(0.15 + 0.15)
  })

  it('adds 0.20 for a stack trace', () => {
    const result = classifyDifficulty({ message: 'Traceback (most recent)' })
    expect(result.reasons).toContain('stack-trace')
    expect(result.score).toBeCloseTo(0.15 + 0.20)
  })

  it('adds 0.10 for a source-file path', () => {
    const result = classifyDifficulty({ message: 'x.ts' })
    expect(result.reasons).toContain('file-path')
    expect(result.score).toBeCloseTo(0.05 + 0.10)
  })

  it('discounts a short question and leaves a long one alone', () => {
    const short = classifyDifficulty({ message: '这个函数是干什么的？' })
    expect(short.reasons).toContain('short-question')
    expect(short.score).toBeCloseTo(0.15 * 0.8)

    const long = classifyDifficulty({ message: `${filler(60)}?` })
    expect(long.reasons).not.toContain('short-question')
    expect(long.score).toBeCloseTo(0.30)
  })

  it('suppresses the question-mark discount once a complex keyword fired', () => {
    // "重构这个模块？" is a refactor with a question mark, not small talk.
    const result = classifyDifficulty({ message: '重构这个模块？' })
    expect(result.score).toBeCloseTo(0.70)
    expect(result.difficulty).toBe('complex')
    expect(result.reasons).toContain('short-question(suppressed)')
  })

  it('still discounts a short question when nothing expensive fired', () => {
    const result = classifyDifficulty({ message: '这样对吗？' })
    expect(result.score).toBeCloseTo(0.05 * 0.8)
    expect(result.difficulty).toBe('trivial')
    expect(result.reasons).toContain('short-question')
    expect(result.reasons).not.toContain('short-question(suppressed)')
  })
})

/* ── difficulty: turn context ─────────────────────────────────────────────── */

describe('classifyDifficulty — turn context', () => {
  it('adds 0.05 when the turn carries attachments', () => {
    expect(classifyDifficulty({ message: filler(30), attachments: 1 }).score).toBeCloseTo(0.35)
    expect(classifyDifficulty({ message: filler(30), attachments: 0 }).score).toBeCloseTo(0.30)
  })

  it('adds 0.10 once the turn has made six tool calls', () => {
    expect(classifyDifficulty({ message: filler(30), toolCount: 5 }).score).toBeCloseTo(0.30)
    expect(classifyDifficulty({ message: filler(30), toolCount: 6 }).score).toBeCloseTo(0.40)
  })

  it('adds 0.15 for a prior tool error and 0.10 more at three', () => {
    expect(classifyDifficulty({ message: filler(30), priorErrors: 1 }).score).toBeCloseTo(0.45)
    expect(classifyDifficulty({ message: filler(30), priorErrors: 2 }).score).toBeCloseTo(0.45)
    expect(classifyDifficulty({ message: filler(30), priorErrors: 3 }).score).toBeCloseTo(0.55)
  })
})

/* ── difficulty: bands, clamping, config ──────────────────────────────────── */

describe('classifyDifficulty — band edges and clamping', () => {
  it('puts a score of exactly 0.25 in simple, not trivial', () => {
    // 0.15 (len 9) + 0.10 (heavy keyword) = 0.25.
    const result = classifyDifficulty({ message: '把全部文件都处理掉' })
    expect(result.score).toBeCloseTo(0.25)
    expect(result.difficulty).toBe('simple')
  })

  it('puts 0.40 in simple and exactly 0.45 in moderate', () => {
    expect(classifyDifficulty({ message: `${filler(30)} x.ts` }).difficulty).toBe('simple') // 0.30 + 0.10
    expect(classifyDifficulty({ message: filler(80) }).difficulty).toBe('moderate') // 0.45
  })

  it('puts 0.65 in moderate and 0.75 in complex', () => {
    // 0.60 (len 200..499) + 0.05 (attachment) = 0.65 → still moderate.
    expect(classifyDifficulty({ message: filler(200), attachments: 1 }).difficulty).toBe('moderate')
    expect(classifyDifficulty({ message: filler(500) }).difficulty).toBe('complex')
  })

  it('clamps a saturated score to 1', () => {
    const loaded = classifyDifficulty({
      message: `重构${'```'}Traceback (most recent)\n${filler(200)}`,
      toolCount: 9,
      priorErrors: 3,
    })
    expect(loaded.score).toBe(1)
    expect(loaded.difficulty).toBe('complex')
    expect(loaded.reasons).toContain('tool-error')
    expect(loaded.reasons).toContain('tool-error:repeated')
  })

  it('accepts keyword overrides and keeps the other default tables', () => {
    const overridden = classifyDifficulty({ message: 'deploy the cluster' }, { complexKeywords: ['deploy'] })
    expect(overridden.score).toBeCloseTo(0.70)
    expect(overridden.reasons).toContain('kw:deploy')

    const mixed = classifyDifficulty({ message: '把全部东西 deploy 一下' }, { complexKeywords: ['deploy'] })
    expect(mixed.score).toBeCloseTo(0.80)
    expect(mixed.reasons).toContain('kw:全部')
    expect(mixed.reasons).toContain('kw:deploy')

    const disabled = classifyDifficulty({ message: 'debug this' }, { complexKeywords: [] })
    expect(disabled.difficulty).toBe('trivial')
  })

  it('ships a default table that covers the SPEC vocabulary', () => {
    expect(DEFAULT_DIFFICULTY_CONFIG.complexKeywords).toContain('重构')
    expect(DEFAULT_DIFFICULTY_CONFIG.heavyKeywords).toContain('end-to-end')
    expect(DEFAULT_DIFFICULTY_CONFIG.simpleKeywords).toContain('read')
    expect(DEFAULT_DIFFICULTY_CONFIG.trivialKeywords).toContain('谢谢')
  })
})

/* ── baseEffortFor ────────────────────────────────────────────────────────── */

describe('baseEffortFor', () => {
  it('sends trivial and simple turns to low', () => {
    expect(baseEffortFor('trivial', true)).toBe('low')
    expect(baseEffortFor('simple', true)).toBe('low')
  })

  it('sends a moderate turn to the high hub', () => {
    expect(baseEffortFor('moderate', true)).toBe('high')
    expect(baseEffortFor('moderate', false)).toBe('high')
  })

  it('upgrades a complex turn to max only when upgrades are allowed', () => {
    expect(baseEffortFor('complex', true)).toBe('max')
    expect(baseEffortFor('complex', false)).toBe('high')
  })

  it('stays at the hub for explicit (the caller overrides it first)', () => {
    expect(baseEffortFor('explicit', true)).toBe('high')
  })
})

/* ── decideEffort ─────────────────────────────────────────────────────────── */

describe('decideEffort — explicit and manual branches', () => {
  it('lets the in-message level win over the selection and the difficulty', () => {
    expect(decide({ explicit: 'low', selected: 'max', difficulty: 'complex' })).toBe('low')
    expect(decide({ explicit: 'max', difficulty: 'trivial' })).toBe('max')
    expect(decide({ explicit: 'high', difficulty: 'trivial', allowUpgrade: false })).toBe('high')
  })

  it('maps the off / on toggles onto the high hub', () => {
    expect(decide({ selected: 'off' })).toBe('high')
    expect(decide({ selected: 'on' })).toBe('high')
  })

  it('passes a manual gradient pick through untouched', () => {
    expect(decide({ selected: 'low' })).toBe('low')
    expect(decide({ selected: 'max' })).toBe('max')
    // Custom gradients survive to the caller's clamp instead of being flattened.
    expect(decide({ selected: 'medium' })).toBe('medium')
    expect(decide({ selected: 'xhigh' })).toBe('xhigh')
  })
})

describe('decideEffort — difficulty base', () => {
  it('maps the auto difficulty buckets onto base levels', () => {
    expect(decide({ difficulty: 'trivial' })).toBe('low')
    expect(decide({ difficulty: 'simple' })).toBe('low')
    expect(decide({ difficulty: 'moderate' })).toBe('high')
    expect(decide({ difficulty: 'complex' })).toBe('max')
    expect(decide({ difficulty: 'complex', allowUpgrade: false })).toBe('high')
  })
})

describe('decideEffort — tool-history fine-tuning', () => {
  it('leaves the base alone below two samples', () => {
    expect(decide({ difficulty: 'moderate', recentCalls: [call('mcp__docs', 5000)] })).toBe('high')
    expect(decide({ difficulty: 'complex', recentCalls: [call('mcp__docs', 5000)] })).toBe('max')
  })

  it('downgrades a high base when the tool work is cheap', () => {
    const cheap = [call('bash', 40), call('fs_read', 20)]
    expect(decide({ difficulty: 'moderate', recentCalls: cheap })).toBe('low')
  })

  it('respects the downgrade toggle', () => {
    const cheap = [call('bash', 40), call('fs_read', 20)]
    expect(decide({ difficulty: 'moderate', recentCalls: cheap, allowDowngrade: false })).toBe('high')
  })

  it('downgrades at exactly the 0.75 simple ratio, not below it', () => {
    const atBoundary = [call('bash', 40), call('fs_read', 20), call('grep', 100), call('web_search', 900)]
    expect(decide({ difficulty: 'moderate', recentCalls: atBoundary })).toBe('low')

    const below = [call('bash', 40), call('fs_read', 20), call('web_search', 900), call('mcp__docs', 500)]
    expect(decide({ difficulty: 'moderate', recentCalls: below })).toBe('high')
  })

  it('treats a simple tool with 800+ argument bytes as real work', () => {
    expect(decide({ difficulty: 'moderate', recentCalls: [call('bash', 799), call('bash', 799)] })).toBe('low')
    expect(decide({ difficulty: 'moderate', recentCalls: [call('bash', 800), call('bash', 800)] })).toBe('high')
  })

  it('lifts to max on a heavy payload when upgrades are allowed', () => {
    const heavy = [call('mcp__docs', 3200), call('bash', 40)]
    expect(decide({ difficulty: 'trivial', recentCalls: heavy })).toBe('max')
    expect(decide({ difficulty: 'trivial', recentCalls: heavy, allowUpgrade: false })).toBe('low')
  })

  it('does not call 3199 bytes heavy', () => {
    const almost = [call('mcp__docs', 3199), call('bash', 40)]
    expect(decide({ difficulty: 'moderate', recentCalls: almost })).toBe('high')
  })

  it('lets a heavy payload beat the simple-ratio downgrade', () => {
    const mixed = [call('bash', 40), call('fs_read', 20), call('grep', 100), call('mcp__docs', 4000)]
    expect(decide({ difficulty: 'moderate', recentCalls: mixed })).toBe('max')
  })

  it('never downgrades a max base, even for an all-cheap turn', () => {
    const cheap = [call('bash', 40), call('fs_read', 20)]
    expect(decide({ difficulty: 'complex', recentCalls: cheap })).toBe('max')
  })

  it('never returns off or auto', () => {
    const inputs: DecideEffortInput[] = [
      { selected: 'auto', difficulty: 'trivial', recentCalls: [], allowDowngrade: true, allowUpgrade: true },
      { selected: 'auto', difficulty: 'moderate', recentCalls: [call('bash', 1), call('bash', 1)], allowDowngrade: true, allowUpgrade: true },
      { selected: 'auto', difficulty: 'complex', recentCalls: [call('mcp__docs', 9000), call('bash', 1)], allowDowngrade: true, allowUpgrade: true },
      { selected: 'off', difficulty: 'trivial', recentCalls: [], allowDowngrade: true, allowUpgrade: true },
    ]
    for (const input of inputs) expect(['low', 'high', 'max']).toContain(decideEffort(input))
  })
})

/* ── SIMPLE_TOOL_RE ───────────────────────────────────────────────────────── */

describe('SIMPLE_TOOL_RE', () => {
  it('matches the Windows and patch tools this fork adds', () => {
    for (const name of ['pwsh', 'shell', 'powershell', 'apply_patch', 'apply_patch_file', 'terminal_run', 'bash_run']) {
      expect(SIMPLE_TOOL_RE.test(name), name).toBe(true)
    }
  })

  it('matches upstream cheap tools on a delimiter boundary', () => {
    for (const name of ['bash', 'fs', 'fs_read', 'read', 'grep', 'glob', 'todo_write', 'job_status', 'code_read']) {
      expect(SIMPLE_TOOL_RE.test(name), name).toBe(true)
    }
  })

  it('does not match tools that merely start with a cheap prefix', () => {
    for (const name of ['web_search', 'subagent', 'mcp__docs', 'codebase_search', 'jobs_board', 'shellcheck_deep']) {
      expect(SIMPLE_TOOL_RE.test(name), name).toBe(false)
    }
  })
})

/* ── applyHysteresis ──────────────────────────────────────────────────────── */

describe('applyHysteresis', () => {
  it('adopts the first decision immediately', () => {
    expect(applyHysteresis(undefined, 'low', 2)).toEqual({ level: 'low', pending: null, pendingCount: 0 })
    expect(applyHysteresis(undefined, 'max', 5)).toEqual({ level: 'max', pending: null, pendingCount: 0 })
  })

  it('treats steps = 1 as no hysteresis', () => {
    expect(applyHysteresis({ level: 'high', pending: null, pendingCount: 0 }, 'low', 1))
      .toEqual({ level: 'low', pending: null, pendingCount: 0 })
    expect(applyHysteresis({ level: 'low', pending: null, pendingCount: 0 }, 'max', 1))
      .toEqual({ level: 'max', pending: null, pendingCount: 0 })
  })

  it('needs two consecutive proposals at steps = 2', () => {
    let state = applyHysteresis(undefined, 'high', 2)
    state = applyHysteresis(state, 'low', 2)
    // One different decision only records the candidate.
    expect(state).toEqual({ level: 'high', pending: 'low', pendingCount: 1 })
    state = applyHysteresis(state, 'low', 2)
    expect(state).toEqual({ level: 'low', pending: null, pendingCount: 0 })
  })

  it('lets an agreeing decision cancel the candidate', () => {
    // H, H, L, H, L — the two L decisions are never consecutive.
    let state = applyHysteresis(undefined, 'high', 2)
    state = applyHysteresis(state, 'high', 2)
    state = applyHysteresis(state, 'low', 2)
    expect(state.pending).toBe('low')
    state = applyHysteresis(state, 'high', 2)
    expect(state).toEqual({ level: 'high', pending: null, pendingCount: 0 })
    state = applyHysteresis(state, 'low', 2)
    expect(state.level).toBe('high')
    expect(state.pending).toBe('low')
    expect(state.pendingCount).toBe(1)
  })

  it('does not prime a switch with a long stable run', () => {
    let state = applyHysteresis(undefined, 'high', 2)
    for (let index = 0; index < 10; index += 1) state = applyHysteresis(state, 'high', 2)
    expect(state).toEqual({ level: 'high', pending: null, pendingCount: 0 })
    // The single different decision is still just a candidate.
    state = applyHysteresis(state, 'low', 2)
    expect(state.level).toBe('high')
    expect(state.pendingCount).toBe(1)
  })

  it('restarts the count when a third level is proposed', () => {
    let state = applyHysteresis(undefined, 'high', 2)
    state = applyHysteresis(state, 'low', 2) // candidate low, 1
    state = applyHysteresis(state, 'max', 2) // candidate changes → count restarts at 1
    expect(state).toEqual({ level: 'high', pending: 'max', pendingCount: 1 })
    state = applyHysteresis(state, 'max', 2) // 2 → switch
    expect(state).toEqual({ level: 'max', pending: null, pendingCount: 0 })
  })

  it('holds the level longer for a larger step count', () => {
    let state = applyHysteresis(undefined, 'high', 3)
    state = applyHysteresis(state, 'low', 3)
    state = applyHysteresis(state, 'low', 3)
    expect(state).toEqual({ level: 'high', pending: 'low', pendingCount: 2 })
    state = applyHysteresis(state, 'low', 3)
    expect(state).toEqual({ level: 'low', pending: null, pendingCount: 0 })
  })
})

/* ── clampForAuto ─────────────────────────────────────────────────────────── */

describe('clampForAuto', () => {
  it('passes an advertised level through untouched', () => {
    expect(clampForAuto('low', ['off', 'low', 'high', 'max'])).toBe('low')
    expect(clampForAuto('max', ['off', 'high', 'max'])).toBe('max')
  })

  it('steps down before up when the exact level is missing', () => {
    expect(clampForAuto('max', ['off', 'low', 'high'])).toBe('high')
    expect(clampForAuto('high', ['off', 'low', 'max'])).toBe('low')
  })

  it('falls back upward only when no lower level is advertised', () => {
    expect(clampForAuto('low', ['off', 'high', 'max'])).toBe('high')
    expect(clampForAuto('high', ['off', 'max'])).toBe('max')
  })

  it('returns undefined when the model offers no auto level', () => {
    expect(clampForAuto('high', ['off', 'on', 'auto'])).toBeUndefined()
    expect(clampForAuto('low', [])).toBeUndefined()
    expect(clampForAuto('max', ['off', 'on'])).toBeUndefined()
  })

  it('keeps custom wire ids out of the auto ladder', () => {
    expect(clampForAuto('low', ['off', 'ultra'])).toBeUndefined()
  })
})

/* ── resolveEffortInjection ───────────────────────────────────────────────── */

describe('resolveEffortInjection — capability guard', () => {
  it('strips the effort entirely for a model without reasoning support', () => {
    expect(resolveEffortInjection(injection({ supportsReasoning: false, requested: 'low', seedEffort: 'low' })))
      .toEqual({ inject: false })
  })

  it('passes a manual pick through and strips one the model does not advertise', () => {
    expect(resolveEffortInjection(injection({ requested: 'low' }))).toEqual({ inject: true, level: 'low' })
    expect(resolveEffortInjection(injection({ requested: 'max', efforts: ['off', 'high'] }))).toEqual({ inject: false })
  })

  it('maps a stray On to a strip on an effort-capable model', () => {
    expect(resolveEffortInjection(injection({ requested: 'on' }))).toEqual({ inject: false })
    expect(resolveEffortInjection(injection({ requested: 'auto', seedEffort: 'on' }))).toEqual({ inject: false })
  })

  it('keeps the toggle-only off / high semantics', () => {
    const toggleOnly = { efforts: ['off', 'high'], toggleOnly: true }
    expect(resolveEffortInjection(injection({ ...toggleOnly, requested: 'off' }))).toEqual({ inject: true, level: 'off' })
    expect(resolveEffortInjection(injection({ ...toggleOnly, requested: 'on' }))).toEqual({ inject: true, level: 'high' })
    expect(resolveEffortInjection(injection({ ...toggleOnly, requested: 'auto', difficulty: 'complex' })))
      .toEqual({ inject: true, level: 'high' })
  })
})

describe('resolveEffortInjection — auto branch', () => {
  it('schedules from the turn difficulty', () => {
    expect(resolveEffortInjection(injection({ difficulty: 'trivial' }))).toEqual({ inject: true, level: 'low' })
    expect(resolveEffortInjection(injection({ difficulty: 'moderate' }))).toEqual({ inject: true, level: 'high' })
    expect(resolveEffortInjection(injection({ difficulty: 'complex' }))).toEqual({ inject: true, level: 'max' })
    expect(resolveEffortInjection(injection({ difficulty: 'complex', allowUpgrade: false })))
      .toEqual({ inject: true, level: 'high' })
  })

  it('defaults to the moderate hub when the caller passes no difficulty', () => {
    expect(resolveEffortInjection(injection())).toEqual({ inject: true, level: 'high' })
  })

  it('clamps a scheduled level down rather than buying the top level', () => {
    // Old upstream clamp lifted `low` to the highest advertised level (max).
    expect(resolveEffortInjection(injection({ difficulty: 'trivial', efforts: ['off', 'high', 'max'] })))
      .toEqual({ inject: true, level: 'high' })
    expect(resolveEffortInjection(injection({ difficulty: 'trivial', efforts: ['off', 'low', 'high', 'max'] })))
      .toEqual({ inject: true, level: 'low' })
  })

  it('strips when the model advertises no auto level at all', () => {
    expect(resolveEffortInjection(injection({ difficulty: 'moderate', efforts: ['off', 'on'] })))
      .toEqual({ inject: false })
  })

  it('treats an explicit marker as an exact pick, not a clamp target', () => {
    expect(resolveEffortInjection(injection({ explicit: 'low', efforts: ['off', 'high', 'max'] })))
      .toEqual({ inject: false })
    expect(resolveEffortInjection(injection({ explicit: 'max', efforts: ['off', 'high', 'max'] })))
      .toEqual({ inject: true, level: 'max' })
  })

  it('honours a level the caller already ran through hysteresis', () => {
    const decided = injection({ autoLevel: 'max', difficulty: 'trivial' })
    expect(resolveEffortInjection(decided)).toEqual({ inject: true, level: 'max' })
  })
})

/* ── capability probe and telemetry ───────────────────────────────────────── */

describe('reasoningEffortSupported', () => {
  it('accepts a reasoning metadata object with efforts', () => {
    expect(reasoningEffortSupported({ efforts: [{ id: 'off' }, { id: 'low' }] })).toBe(true)
  })

  it('rejects absent, empty, and malformed metadata', () => {
    expect(reasoningEffortSupported(undefined)).toBe(false)
    expect(reasoningEffortSupported(null)).toBe(false)
    expect(reasoningEffortSupported({})).toBe(false)
    expect(reasoningEffortSupported({ efforts: [] })).toBe(false)
    expect(reasoningEffortSupported({ efforts: 'off' })).toBe(false)
  })
})

describe('toolDurationMs', () => {
  it('reports the wall-clock delta and never negative jitter', () => {
    expect(toolDurationMs(1000, 2400)).toBe(1400)
    expect(toolDurationMs(2400, 1000)).toBe(0)
  })
})

/* ── slider ordering & placement (adapted from the upstream suite) ────────── */

describe('orderEffortsForSlider', () => {
  it('pins auto leftmost even when off is offered alongside', () => {
    const ordered = orderEffortsForSlider([{ id: 'off' }, { id: 'high' }, { id: 'auto' }])
    expect(ordered.map(stop => stop.id)).toEqual(['auto', 'off', 'high'])
  })

  it('pins auto leftmost when thinking cannot be disabled at all', () => {
    const ordered = orderEffortsForSlider([{ id: 'high' }, { id: 'auto' }, { id: 'max' }])
    expect(ordered.map(stop => stop.id)).toEqual(['auto', 'high', 'max'])
  })

  it('sorts the full standard gradient after off/on', () => {
    const ids = ['max', 'low', 'auto', 'off', 'medium', 'on', 'minimal', 'xhigh', 'high']
    const ordered = orderEffortsForSlider(ids.map(id => ({ id })))
    expect(ordered.map(stop => stop.id))
      .toEqual(['auto', 'off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  })

  it('keeps unknown wire values right-most in arrival order', () => {
    const ordered = orderEffortsForSlider([{ id: 'ultra' }, { id: 'off' }, { id: 'mega' }, { id: 'auto' }])
    expect(ordered.map(stop => stop.id)).toEqual(['auto', 'off', 'ultra', 'mega'])
  })

  it('returns an empty track untouched', () => {
    expect(orderEffortsForSlider([])).toEqual([])
  })

  it('exposes the rank table the ordering is built on', () => {
    expect(EFFORT_SLIDER_RANK.auto).toBe(0)
    expect(EFFORT_SLIDER_RANK.max).toBe(8)
  })
})

describe('nearestEffortStopIndex', () => {
  const stops = [{ id: 'auto' }, { id: 'off' }, { id: 'low' }, { id: 'high' }, { id: 'max' }]

  it('matches an advertised id exactly', () => {
    expect(nearestEffortStopIndex(stops, 'low')).toBe(2)
    expect(nearestEffortStopIndex(stops, 'max')).toBe(4)
  })

  it('parks an unadvertised value on the rank-nearest stop, ties toward the stronger level', () => {
    expect(nearestEffortStopIndex(stops, 'medium')).toBe(3)
    expect(nearestEffortStopIndex(stops, 'minimal')).toBe(2)
    expect(nearestEffortStopIndex([{ id: 'low' }, { id: 'high' }], 'medium')).toBe(1)
  })

  it('lands unknown ids at the right end and absence at the left end', () => {
    expect(nearestEffortStopIndex(stops, 'ultra')).toBe(4)
    expect(nearestEffortStopIndex(stops, undefined)).toBe(0)
  })

  it('degenerate tracks always yield 0', () => {
    expect(nearestEffortStopIndex([], 'high')).toBe(0)
    expect(nearestEffortStopIndex([], undefined)).toBe(0)
  })
})

/* ── effort-id validation (kept from upstream) ────────────────────────────── */

describe('effort-level validation', () => {
  it('accepts the eight standard levels plus auto', () => {
    for (const level of ['off', 'on', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto']) {
      expect(isEffortId(level)).toBe(true)
    }
  })

  it('rejects out-of-band values that dsh would reject per request', () => {
    for (const bad of ['ultra', 'reasoning', 3, null, undefined, {}]) {
      expect(isEffortId(bad)).toBe(false)
    }
  })
})
