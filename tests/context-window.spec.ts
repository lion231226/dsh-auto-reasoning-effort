import { describe, expect, it } from 'vitest'
import {
  CONTEXT_WINDOW_MAX, CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_PRESETS,
  formatContextWindow, validateContextWindow,
} from '../src/context-window.ts'

describe('context-window constants', () => {
  it('exposes the legal range aligned with dsh-thinking-effort', () => {
    expect(CONTEXT_WINDOW_MIN).toBe(2000)
    expect(CONTEXT_WINDOW_MAX).toBe(1_000_000)
  })

  it('lists the presets in ascending order with expected values', () => {
    const values = CONTEXT_WINDOW_PRESETS.map(preset => preset.value)
    expect(values).toEqual([64_000, 131_072, 256_000, 400_000, 524_288, 1_000_000])
    expect([...values]).toEqual([...values].sort((a, b) => a - b))
    expect(CONTEXT_WINDOW_PRESETS[CONTEXT_WINDOW_PRESETS.length - 1].label).toBe('1M')
  })
})

describe('formatContextWindow', () => {
  it('formats exact presets with their label', () => {
    expect(formatContextWindow(1_000_000)).toBe('1M')
    expect(formatContextWindow(256_000)).toBe('256K')
    expect(formatContextWindow(131_072)).toBe('128K')
    expect(formatContextWindow(400_000)).toBe('400K')
  })

  it('formats non-preset values as binary K or the raw value', () => {
    expect(formatContextWindow(3000)).toBe('3K')
    expect(formatContextWindow(300)).toBe('300')
  })
})

describe('validateContextWindow', () => {
  it('accepts in-range integers (number or numeric string)', () => {
    expect(validateContextWindow(256_000)).toEqual({ ok: true, value: 256_000 })
    expect(validateContextWindow('1000000')).toEqual({ ok: true, value: 1_000_000 })
    expect(validateContextWindow(' 64000 ')).toEqual({ ok: true, value: 64_000 })
  })

  it('rejects non-integer input', () => {
    expect(validateContextWindow('abc')).toEqual({ ok: false, reason: 'integer' })
    expect(validateContextWindow('128k')).toEqual({ ok: false, reason: 'integer' })
    expect(validateContextWindow('12.5')).toEqual({ ok: false, reason: 'integer' })
    expect(validateContextWindow('1e3')).toEqual({ ok: false, reason: 'integer' })
    expect(validateContextWindow(undefined)).toEqual({ ok: false, reason: 'integer' })
  })

  it('rejects out-of-range values', () => {
    expect(validateContextWindow(1)).toEqual({ ok: false, reason: 'range' })
    expect(validateContextWindow(1999)).toEqual({ ok: false, reason: 'range' })
    expect(validateContextWindow(2_000_000)).toEqual({ ok: false, reason: 'range' })
  })
})
