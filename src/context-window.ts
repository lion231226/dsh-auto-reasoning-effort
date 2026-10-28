/**
 * Pure context-window helpers for the dsh-thinking-levels plugin.
 *
 * The context-window limit of a custom gateway model is declared in the
 * llm-pi-ai model entry (`contextWindow`, a positive integer). The harness
 * consumes it through `resolveModelInfo(...).context.contextWindow` for
 * compaction thresholds, context-overflow detection and context-pressure
 * projections — a settings write takes effect on the next request without a
 * restart. This module centralizes the legal range, the common presets and
 * the display formatting shared by the config schema, the settings card and
 * the tests. Kept dependency-free (pure inputs -> output).
 */

/** Smallest accepted context window (tokens), aligned with dsh-thinking-effort. */
export const CONTEXT_WINDOW_MIN = 2000
/** Largest accepted context window (tokens), e.g. third-party DeepSeek 1M. */
export const CONTEXT_WINDOW_MAX = 1_000_000

/** One selectable context-window preset. */
export interface ContextWindowPreset {
  /** Human-readable label shown on the card button and the model badge. */
  label: string
  /** The token count written to the llm-pi-ai model entry. */
  value: number
}

/** The multi-level context-window presets, in ascending order. */
export const CONTEXT_WINDOW_PRESETS: readonly ContextWindowPreset[] = [
  { label: '64K', value: 64_000 },
  { label: '128K', value: 131_072 },
  { label: '256K', value: 256_000 },
  { label: '400K', value: 400_000 },
  { label: '512K', value: 524_288 },
  { label: '1M', value: 1_000_000 },
] as const

/** Format a token count as a readable label (exact presets keep their label). */
export function formatContextWindow(value: number): string {
  const preset = CONTEXT_WINDOW_PRESETS.find(candidate => candidate.value === value)
  if (preset !== undefined) return preset.label
  if (value >= CONTEXT_WINDOW_MAX) return '1M'
  if (value >= 1024) return `${Math.round(value / 1024)}K`
  return String(value)
}

/** The result of validating a context-window value. */
export type ContextWindowValidation =
  | { ok: true; value: number }
  | { ok: false; reason: 'integer' | 'range' }

/**
 * Validate a context-window candidate (number or numeric string). Accepts only
 * base-10 integers inside [CONTEXT_WINDOW_MIN, CONTEXT_WINDOW_MAX]; anything
 * else (float, 'abc', '1e3', out-of-range) is rejected with a reason.
 */
export function validateContextWindow(value: unknown): ContextWindowValidation {
  const raw = typeof value === 'string' ? value.trim() : value
  const asString = typeof raw === 'string' ? raw : String(raw)
  if (!/^\d+$/.test(asString)) return { ok: false, reason: 'integer' }
  const numeric = Number(asString)
  if (!Number.isSafeInteger(numeric)) return { ok: false, reason: 'integer' }
  if (numeric < CONTEXT_WINDOW_MIN || numeric > CONTEXT_WINDOW_MAX) {
    return { ok: false, reason: 'range' }
  }
  return { ok: true, value: numeric }
}
