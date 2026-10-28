/**
 * Session event extraction for dsh-auto-reasoning-effort.
 *
 * Three readers, three different jobs:
 * - {@link toolSampleOf} normalizes ONE raw Session event into a tool-call
 *   sample and is shared with the `tlEffortDifficulty` projection
 *   (`auto-schedule-projection.ts`), so the `tool/call` wire shape lives in
 *   exactly one place.
 * - {@link extractUserText} flattens a `user/message` payload into the plain
 *   text the difficulty classifier reads. It owns the 4000-character cap for
 *   the same reason: one wire shape, one normalization point.
 * - {@link recentToolCalls} is the LEGACY pull path. `session.events` only ever
 *   existed on hosts up to 0.1.0-rc.8 (verified: `get events()` present at
 *   `dsh-v0.1.0-rc.8`, zero hits from `dsh-v0.1.2-rc.1` on), so on every newer
 *   line it returns `[]`. It survives only as the 0.1.0-rc.8 fallback for
 *   hosts whose projection registry predates `stateOf`, and as a source of
 *   turn-scoped history for call sites that cannot read a projection at all.
 */

import type { ToolCallSample } from './thinking-level.ts'

/** How many recent tool calls to sample for one decision. */
export const TOOL_SAMPLE_WINDOW = 8

/**
 * Upper bound on the folded user-message text, in characters.
 *
 * The classifier only looks at length bands up to 500 characters and at
 * keyword/structure hits, so a pasted 200 KB log adds nothing but memory to a
 * projection row that the host persists with every session. 4000 is far above
 * every threshold and still small enough to keep the durable row cheap.
 */
export const USER_TEXT_MAX = 4000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Guard: one session event shaped like a tool/call record. */
function isToolCallEvent(event: unknown): event is { data: Record<string, unknown> } {
  if (!isRecord(event) || event.type !== 'tool/call') return false
  return isRecord(event.data)
}

/** Approximate argument size in characters (payload heft); unknown shapes read as 0. */
export function argsSizeOf(argumentsValue: unknown): number {
  return typeof argumentsValue === 'string' ? argumentsValue.length : 0
}

/**
 * A non-negative integer field, or 0.
 *
 * `turn` / `step` are structural position markers, not payload: a record that
 * lost them (a hand-written fixture, a future format) must still produce a
 * usable sample rather than `NaN`, which would poison every `===` comparison
 * the projection does on them.
 */
function positionOf(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/**
 * Normalize one raw Session event into a tool-call sample.
 *
 * The wire shape is `{ turn, step, callId, name, arguments }`
 * (`dsh-session/lib/types/types.d.ts`); `turn` and `step` travel with the
 * sample because the projection narrows its window to the CURRENT turn —
 * upstream kept one ring across the whole session, so a new prompt inherited
 * the previous turn's (cheap or heavy) history and the level drifted for
 * reasons the user could not see.
 *
 * @param event - any committed Session event.
 * @returns the sample, or undefined for any other event / malformed record.
 */
export function toolSampleOf(event: unknown): ToolCallSample | undefined {
  if (!isToolCallEvent(event)) return undefined
  const data = event.data
  const name = typeof data.name === 'string' && data.name.length > 0 ? data.name : 'tool'
  return {
    name,
    argsSize: argsSizeOf(data.arguments),
    turn: positionOf(data.turn),
    step: positionOf(data.step),
  }
}

/**
 * Flatten a `user/message` payload into plain text.
 *
 * Two wire forms are accepted because both occur in practice:
 * - `content` is a plain string (hand-built fixtures, synthetic injects);
 * - `content` is a block array — the durable form (`UserMessage.content:
 *   readonly ContentBlock[]`, `dsh-llm/lib/types/message.d.ts`) — of which only
 *   `{ type: 'text', text }` blocks are user words. Reasoning and image blocks
 *   carry no message text and are skipped instead of stringified.
 *
 * Blocks are joined with a single space so two abutting text blocks do not fuse
 * into one word (which would defeat keyword matching), and the result is capped
 * at {@link USER_TEXT_MAX} BEFORE it is stored in the projection.
 *
 * @param data - the `data` of a `user/message` event (any shape).
 * @returns the flattened, capped text; `''` for anything unreadable.
 */
export function extractUserText(data: unknown): string {
  if (!isRecord(data)) return ''
  const content = data.content
  if (typeof content === 'string') return content.slice(0, USER_TEXT_MAX)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    if (block.type !== 'text') continue
    if (typeof block.text !== 'string' || block.text.length === 0) continue
    parts.push(block.text)
  }
  return parts.join(' ').slice(0, USER_TEXT_MAX)
}

/**
 * LEGACY: recent tool calls off `agent.session.events`, oldest first.
 *
 * Only 0.1.0-rc.8 carries that array property; every host from 0.1.2-rc.1 on
 * drops it in favour of `eventAt()/snapshotEvents()/ownEvents()`, so this
 * returns `[]` there. Callers must treat `[]` as "no samples available" and
 * prefer the projection read.
 *
 * @param agent - the `payload.agent` value from the `agent/request` waterfall.
 * @returns the sampled tool calls, or `[]` for a fresh prompt / unknown shape.
 */
export function recentToolCalls(agent: unknown): ToolCallSample[] {
  if (!isRecord(agent)) return []
  const session = agent.session
  if (!isRecord(session) || !Array.isArray(session.events)) return []

  const samples: ToolCallSample[] = []
  for (let index = session.events.length - 1; index >= 0 && samples.length < TOOL_SAMPLE_WINDOW; index -= 1) {
    const sample = toolSampleOf(session.events[index])
    if (sample !== undefined) samples.push(sample)
  }
  return samples.reverse()
}
