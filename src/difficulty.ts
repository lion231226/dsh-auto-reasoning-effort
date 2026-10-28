/**
 * Difficulty classification for dsh-auto-reasoning-effort.
 *
 * The upstream plugin (dsh-auto-reasoning-effort) scheduled `reasoning_effort` from
 * the recent tool-call history alone: a fresh prompt was "simple" because no
 * tool had run yet, and a long architectural question looked exactly like a
 * one-line lookup. That is the defect this module fixes — the difficulty of the
 * turn is read from the USER'S MESSAGE first, and tool history only nudges the
 * score afterwards.
 *
 * Deliberately a pure function of its input:
 * - no clock, no randomness, no I/O, no host imports — the same inputs must
 *   produce the same score on every host line, so the decision is unit-testable
 *   and replayable from a debug log;
 * - no zod either. The projection schemas own wire validation; the scoring
 *   policy owns judgment, and mixing the two would make the thresholds depend
 *   on a serialization library.
 *
 * The score is a coarse heuristic, not a model call: it exists to move the
 * default from `high` down for chatty turns and up for structural work, and
 * every decision comes with `reasons[]` so a surprising level can be explained
 * from the log without re-running the turn.
 * @module dsh-auto-reasoning-effort/difficulty
 */

/**
 * The five difficulty buckets. `explicit` is not a measure of the message: it
 * means the user asked for a level in the text (`[effort: high]`), which
 * overrides scoring entirely.
 */
export type Difficulty = 'trivial' | 'simple' | 'moderate' | 'complex' | 'explicit'

/**
 * Everything the classifier reads about the current turn. All fields are
 * optional except the message, because a turn may have no attachments, no tool
 * activity and no failures yet.
 */
export interface DifficultyInput {
  /** Raw text of the latest user message of this turn (may be empty). */
  message: string
  /** Attachment count of this turn (default 0). */
  attachments?: number
  /** Tool errors already seen in this turn, from `tool/result` (`default 0`). */
  priorErrors?: number
  /** Tool calls already seen in this turn (`default 0`). */
  toolCount?: number
}

/** One classification result: the bucket, the continuous score and why. */
export interface DifficultyResult {
  difficulty: Difficulty
  /** 0..1 continuous score, kept for debug logs and status output. */
  score: number
  /** Human-readable hits, e.g. `['len:45', 'kw:重构', 'code-block']`. */
  reasons: string[]
  /** Present only when `difficulty === 'explicit'`: the level asked for in the text. */
  explicit?: 'off' | 'low' | 'high' | 'max'
}

/**
 * The keyword tables. Exposed as a config surface so an operator can teach the
 * classifier their domain vocabulary (e.g. add `迁移` synonyms) without a code
 * change. ASCII keywords match on word boundaries, CJK keywords by substring.
 */
export interface DifficultyConfig {
  /** Work that needs real reasoning: raises the floor to 0.60 and adds 0.10. */
  complexKeywords: readonly string[]
  /** Work that spans a whole surface: +0.10. */
  heavyKeywords: readonly string[]
  /** Cheap lookups: the score is multiplied by 0.7 (unless an expensive hit fired). */
  simpleKeywords: readonly string[]
  /** Acknowledgements / continuations: on short messages, scale to at most 0.2. */
  trivialKeywords: readonly string[]
}

/**
 * Defaults from the SPEC. The list order only decides the order `reasons[]`
 * reports hits in; scoring is unaffected. `重构` appears twice in the spec text
 * and is de-duplicated here so a message cannot earn the same reason twice.
 */
export const DEFAULT_DIFFICULTY_CONFIG: DifficultyConfig = Object.freeze({
  complexKeywords: Object.freeze([
    '重构', '架构', '设计', '调试', '排查', '迁移', '性能', '并发', '安全',
    'refactor', 'design', 'debug', 'migrate', 'optimize', 'rewrite',
    '从零', 'from scratch', '实现', 'implement',
  ] as const),
  heavyKeywords: Object.freeze([
    '全部', '整个', '全量', '端到端', 'complete', 'entire', 'whole', 'all',
    'full', 'end-to-end',
  ] as const),
  simpleKeywords: Object.freeze([
    '读', '查', '看', '列', '搜', '找', '读取', '显示',
    'read', 'show', 'list', 'print', 'cat',
  ] as const),
  trivialKeywords: Object.freeze([
    '谢谢', '好的', '收到', '明白', 'ok', 'okay', 'thanks', '继续', '接着',
    'next', 'continue',
  ] as const),
})

/**
 * The in-text override: `[effort: high]`, `{effort=max}`, `【EFFORT = low】`.
 *
 * Anchored on bracket pairs so prose that merely mentions the word "effort"
 * (this README-adjacent plugin attracts a lot of it) never flips the level.
 */
const EXPLICIT_RE = /[\[{【]\s*effort\s*[:=]\s*(off|low|high|max)\s*[\]}】]/i

/**
 * Error/stack fingerprints. `at .+:\d+` covers both JS stack frames
 * (`at foo (file.ts:12:3)`) and Python (`File "x.py", line 3`) style payloads
 * once the path/regex variants are combined.
 */
const STACK_TRACE_RE = /traceback|error:|exception|at .+:\d+|\bpanic\b/i

/** A source-file path: the user is pointing at code, not chatting. */
const FILE_PATH_RE = /[\w./\\-]+\.(ts|tsx|js|jsx|py|go|rs|java|json|ya?ml|toml|md|sql)\b/i

/** Marks that the message carries a fenced code block. */
const CODE_FENCE = '```'

/**
 * A complex-keyword hit lifts the score to this floor before adding its bonus.
 *
 * 0.60 (not 0.55) is deliberate: 0.60 + 0.10 lands exactly on the `complex`
 * band edge, so "重构这个模块" — six characters, no code block, no stack trace —
 * still reaches the highest level. At 0.55 the same message scored 0.65 and
 * stayed `moderate`: the user typed "refactor" and got the default hub.
 */
const COMPLEX_FLOOR = 0.60

/** Bonus added on top of the complex floor. */
const COMPLEX_BONUS = 0.10

/**
 * Scope words ("全部" / "end-to-end") widen the task, but they only add — they
 * never floor. "全部" is ordinary Chinese ("全部文件" = the files), and the
 * English table matches `includes`, so `install` / `allocation` would otherwise
 * turn every such message into a complex task.
 */
const HEAVY_BONUS = 0.10

/** Discount for a cheap lookup, applied only when no expensive signal fired. */
const SIMPLE_FACTOR = 0.7

/** Cap for an acknowledgement, applied only when no expensive signal fired. */
const TRIVIAL_FACTOR = 0.3

/** Ceiling of the acknowledgement discount. */
const TRIVIAL_CAP = 0.2

/**
 * Reason suffix for a hit that matched but was NOT applied.
 *
 * The rules are "cheap signals must not veto expensive ones": a polite
 * "好的，重构一下整个模块" is a refactor instruction, and letting the
 * acknowledgement scale it to 0.2 would systematically send Chinese users to
 * `low`; "重构这个模块？" is a refactor with a question mark, not a clarification.
 * The hit still lands in `reasons[]` — silently dropping it would make the
 * debug log claim the classifier never saw the word.
 */
const SUPPRESSED = '(suppressed)'

/**
 * Base score from the trimmed message length (SPEC §2.3 step 2).
 *
 * Length is the cheapest honest proxy for task size: a 6-character "继续" and
 * a 600-character failure report cannot plausibly need the same level. The
 * bands are deliberately non-linear (0.05 → 0.15 → 0.30 → 0.45 → 0.60 → 0.75)
 * so no single length can reach the `complex` band on its own.
 */
function baseScoreForLength(length: number): number {
  if (length < 8) return 0.05
  if (length < 30) return 0.15
  if (length < 80) return 0.30
  if (length < 200) return 0.45
  if (length < 500) return 0.60
  return 0.75
}

/** Map a 0..1 score onto the four scored buckets (SPEC §2.3 step 7). */
function bandOf(score: number): Difficulty {
  if (score < 0.25) return 'trivial'
  if (score < 0.45) return 'simple'
  if (score < 0.70) return 'moderate'
  return 'complex'
}

/** Clamp into `[0, 1]`; the caller only ever sees a legal score. */
function clamp01(score: number): number {
  if (!Number.isFinite(score)) return 0
  if (score < 0) return 0
  if (score > 1) return 1
  return score
}

/** Resolve a partial config against the defaults, field by field. */
function resolveConfig(override?: Partial<DifficultyConfig>): DifficultyConfig {
  if (override === undefined) return DEFAULT_DIFFICULTY_CONFIG
  return {
    complexKeywords: override.complexKeywords ?? DEFAULT_DIFFICULTY_CONFIG.complexKeywords,
    heavyKeywords: override.heavyKeywords ?? DEFAULT_DIFFICULTY_CONFIG.heavyKeywords,
    simpleKeywords: override.simpleKeywords ?? DEFAULT_DIFFICULTY_CONFIG.simpleKeywords,
    trivialKeywords: override.trivialKeywords ?? DEFAULT_DIFFICULTY_CONFIG.trivialKeywords,
  }
}

/**
 * Which of `keywords` appear in the already-lowercased message.
 *
 * Returns the keywords as configured (original casing) so `reasons[]` matches
 * the config the operator can see; duplicates are collapsed because two
 * spellings of the same word are one signal, not two.
 */
function matchedKeywords(loweredMessage: string, keywords: readonly string[]): string[] {
  const hits: string[] = []
  const seen = new Set<string>()
  for (const keyword of keywords) {
    const needle = keyword.toLowerCase()
    if (needle.length === 0 || seen.has(needle)) continue
    if (!keywordOccurs(loweredMessage, keyword)) continue
    seen.add(needle)
    hits.push(keyword)
  }
  return hits
}

/** Keywords made purely of ASCII characters; everything else is treated as CJK. */
const ASCII_ONLY_RE = /^[\x00-\x7F]+$/

/** Escape a literal so it can be embedded in a RegExp source. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Does one keyword occur in the message?
 *
 * ASCII keywords must respect word boundaries. The default tables contain
 * `all`, `cat`, `read`, `ok`, and a plain `includes` makes `install`,
 * `allocation`, `category` and `token` fire them — a message like "install the
 * package" would earn the whole-scope boost, and "category" would be read as a
 * request to `cat` something. The boundary set is `[a-z0-9]` on both sides, so
 * `all` matches "all files" and "--all" but not "install"; underscore and
 * punctuation count as separators, which is what flag and identifier forms
 * need (`all_files`).
 *
 * Non-ASCII keywords (Chinese) keep substring semantics: CJK has no word
 * boundaries, and `重构` must fire inside `重构这个模块`.
 */
function keywordOccurs(loweredMessage: string, keyword: string): boolean {
  if (!ASCII_ONLY_RE.test(keyword)) return loweredMessage.includes(keyword)
  const pattern = new RegExp(`(?<![a-z0-9])${escapeRegExp(keyword)}(?![a-z0-9])`, 'i')
  return pattern.test(loweredMessage)
}

/**
 * Score one turn's difficulty.
 *
 * Rules run in the SPEC order and later rules can override earlier ones:
 * explicit marker → length base → keyword weights → structural signals →
 * turn context → clamp → band. The score is continuous on purpose: hysteresis
 * downstream compares decisions, but the debug log can show how close a turn
 * was to the next band.
 *
 * A per-category keyword hit applies its weight exactly once (the message is
 * either about refactoring or it is not); every matched word still lands in
 * `reasons[]` so the log can show which word fired.
 *
 * When a complex or heavy keyword fires, the simple/trivial discounts and the
 * short-question discount are skipped: a cheap signal must never veto an
 * expensive one. Those hits remain in `reasons[]` with a `(suppressed)` suffix.
 *
 * @param input - the latest user message plus this turn's context counters.
 * @param cfg - partial keyword overrides; omitted fields fall back to the defaults.
 * @returns the bucket, the clamped score and the hit reasons.
 */
export function classifyDifficulty(
  input: DifficultyInput,
  cfg?: Partial<DifficultyConfig>,
): DifficultyResult {
  const config = resolveConfig(cfg)
  // Hosts hand us strings, but a malformed projection must not end the turn
  // (`agent/request` failures are silent and total), so a non-string reads as
  // an empty message — the safest bucket, never a crash.
  const message = typeof input.message === 'string' ? input.message : ''

  const explicitMatch = EXPLICIT_RE.exec(message)
  if (explicitMatch !== null) {
    const explicit = explicitMatch[1].toLowerCase() as 'off' | 'low' | 'high' | 'max'
    return {
      difficulty: 'explicit',
      score: 1,
      reasons: [`explicit:${explicit}`],
      explicit,
    }
  }

  // Only trimmed length counts: trailing newlines from a pasted log are not
  // extra work, and the user cannot see them.
  const text = message.trim()
  const length = text.length
  const reasons: string[] = [`len:${length}`]
  let score = baseScoreForLength(length)
  const lowered = text.toLowerCase()

  const complexHits = matchedKeywords(lowered, config.complexKeywords)
  if (complexHits.length > 0) {
    // `max` first: a long message already scores above the floor, and the
    // wording should lift a short one, never lower a long one.
    score = Math.max(score, COMPLEX_FLOOR) + COMPLEX_BONUS
    for (const word of complexHits) reasons.push(`kw:${word}`)
  }

  const heavyHits = matchedKeywords(lowered, config.heavyKeywords)
  if (heavyHits.length > 0) {
    score += HEAVY_BONUS
    for (const word of heavyHits) reasons.push(`kw:${word}`)
  }

  // Cheap signals must not veto an expensive one. A polite "好的，重构一下整个
  // 模块" is still a refactor instruction, and "看看这个架构" is still an
  // architecture question; letting the acknowledgement/casual-lookup discount
  // decide would systematically under-schedule exactly the requests that need
  // the top level. Suppressed hits stay in `reasons[]` marked `(suppressed)`,
  // so the debug log never pretends the word was absent.
  const expensive = complexHits.length > 0 || heavyHits.length > 0
  const suppression = expensive ? SUPPRESSED : ''

  const simpleHits = matchedKeywords(lowered, config.simpleKeywords)
  if (simpleHits.length > 0) {
    if (!expensive) score *= SIMPLE_FACTOR
    for (const word of simpleHits) reasons.push(`kw:${word}${suppression}`)
  }

  const trivialHits = matchedKeywords(lowered, config.trivialKeywords)
  if (trivialHits.length > 0 && length < 60) {
    // Acknowledgements are short by nature; on a long message the same words
    // ("收到，继续把剩下的重构做完") are connective tissue, not the task.
    if (!expensive) score = Math.min(score * TRIVIAL_FACTOR, TRIVIAL_CAP)
    for (const word of trivialHits) reasons.push(`kw:${word}${suppression}`)
  }

  if (text.includes(CODE_FENCE)) {
    score += 0.15
    reasons.push('code-block')
  }
  if (STACK_TRACE_RE.test(text)) {
    // A pasted failure is the strongest cheap signal: someone is debugging.
    score += 0.20
    reasons.push('stack-trace')
  }
  if (FILE_PATH_RE.test(text)) {
    score += 0.10
    reasons.push('file-path')
  }
  // Trailing question mark on a short message: a clarification, not a task.
  // Same cheap-vs-expensive rule as the keyword discounts — "重构这个模块？" is
  // still a refactor with a question mark, not a small talk turn.
  if (length < 60 && /[?？]$/.test(text)) {
    if (!expensive) score *= 0.8
    reasons.push(`short-question${suppression}`)
  }

  if ((input.attachments ?? 0) > 0) {
    score += 0.05
    reasons.push('attachments')
  }
  if ((input.toolCount ?? 0) >= 6) {
    // Six calls without finishing means the turn is not a one-shot lookup.
    score += 0.10
    reasons.push('tool-count')
  }
  const priorErrors = input.priorErrors ?? 0
  if (priorErrors >= 1) {
    score += 0.15
    reasons.push('tool-error')
  }
  if (priorErrors >= 3) {
    // Repeated failures are their own signal: the first attempt did not work,
    // so the next request deserves more thinking than the first one got.
    score += 0.10
    reasons.push('tool-error:repeated')
  }

  const finalScore = clamp01(score)
  return { difficulty: bandOf(finalScore), score: finalScore, reasons }
}
