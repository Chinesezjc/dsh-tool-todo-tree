/** Package-owned durable tree-snapshot invariants. @module @deepseek-ai/dsh-tool-todo-tree/invariant */

import type { Context } from '@deepseek-ai/cordis'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type { InvariantFailure, InvariantInstaller } from '@deepseek-ai/dsh-invariants'
import { SCHEMA_DEPTH } from './index.ts'

const PACKAGE_NAME = '@deepseek-ai/dsh-tool-todo-tree'
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed'])

/** Cordis companion plugin name. */
export const name = 'tool-todo-tree-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** Validate one whole-tree todo snapshot before it reaches the durable log. */
function validateTodos(value: unknown, fail: InvariantFailure): void {
  if (!Array.isArray(value)) fail('todo/tree todos must be an array')
  let active = 0
  const walk = (nodes: unknown[], depth: number): void => {
    // The tool schema caps trees at SCHEMA_DEPTH levels, so a deeper durable
    // snapshot (hand-authored or corrupted) is state the tool can never
    // produce; the bound also keeps this recursion finite on hostile input.
    if (depth > SCHEMA_DEPTH) {
      fail(`todo/tree nests deeper than the protocol cap of ${SCHEMA_DEPTH} levels`)
    }
    const seen = new Set<string>()
    for (const node of nodes) {
      if (typeof node !== 'object' || node === null) fail('todo/tree entries must be objects')
      const { content, status, children } = node as Record<string, unknown>
      if (typeof content !== 'string' || content.length === 0 || content.trim() !== content) {
        fail('todo/tree content must be non-empty and already trimmed')
      }
      if (seen.has(content)) fail(`todo/tree repeats sibling content ${JSON.stringify(content)}`)
      seen.add(content)
      if (typeof status !== 'string' || !TODO_STATUSES.has(status)) {
        fail(`todo/tree carries unknown status ${JSON.stringify(status)}`)
      }
      if (status === 'in_progress') active += 1
      if (children !== undefined) {
        if (!Array.isArray(children) || children.length === 0) {
          fail('todo/tree children must be a non-empty array or absent')
        }
        walk(children as unknown[], depth + 1)
        // A completed parent over an unfinished child is state the tool can
        // never produce (`toTodoTree` rejects it); validating durable snapshots
        // independently, reject the same contradiction here.
        if (status === 'completed'
          && (children as { status?: unknown }[]).some(child => child.status !== 'completed')) {
          fail(`todo/tree completes ${JSON.stringify(content)} over an unfinished child`)
        }
      }
    }
  }
  walk(value as unknown[], 1)
  if (active > 1) fail(`todo/tree contains ${active} in-progress entries; at most one is allowed`)
}

/** What one session's committed log establishes about its todo events. */
interface LogFacts {
  /** Whether a `todo/tree` snapshot has been recorded. */
  tree: boolean
  /** Whether a flat `todo/write` snapshot has been recorded. */
  flat: boolean
  /** The turn number currently open, or `null` between `turn/end` and the next `turn/start`. */
  openTurn: number | null
}

/**
 * {@link LogFacts} folded up to `seq` events of a session's log.
 *
 * `seq` makes the entry a watermark over COMMITTED log positions rather than a
 * running total, which is what keeps the two skipped paths correct: a candidate
 * event a later listener vetoes never advances it, and events appended while the
 * session was detached from the store (no dispatch reaches this companion) are
 * folded in by the next check that reads the log.
 */
interface LogMark extends LogFacts { seq: number }

/** Per-session watermark, so a check folds new events instead of rescanning the log. */
type LogCache = WeakMap<Session, LogMark>

/** Fold one event into a copy of `facts`. */
function noteEvent(event: SessionEvent, facts: LogFacts): LogFacts {
  if (event.type === 'todo/tree') return { ...facts, tree: true }
  if (event.type === 'todo/write') return { ...facts, flat: true }
  if (event.type === 'turn/start') return { ...facts, openTurn: event.data.turn }
  if (event.type === 'turn/end') return { ...facts, openTurn: null }
  return facts
}

/** Whether an event can change what this companion asserts — the only reason to run the checks. */
function isTodoEvent(event: SessionEvent): boolean {
  return event.type === 'todo/tree' || event.type === 'todo/write'
}

/**
 * Fold every committed event past the cached watermark and store the result.
 *
 * Reads `session.events`, the authoritative committed log, so it is correct
 * whether the gap is one ordinary append or a batch that arrived while the
 * session was detached.
 * @param cache - accumulated per-session watermarks.
 * @param session - the session whose committed log is folded.
 * @returns what the committed log establishes.
 */
function committedFacts(cache: LogCache, session: Session): LogFacts {
  const mark = cache.get(session) ?? { tree: false, flat: false, openTurn: null, seq: 0 }
  const events = session.events
  let facts: LogFacts = mark
  for (const event of events.slice(mark.seq)) facts = noteEvent(event, facts)
  cache.set(session, { ...facts, seq: events.length })
  return facts
}

/**
 * Reject a log that carries both todo shapes, and a tree snapshot outside an open turn.
 *
 * SHAPE. The two todo packages select a shape by colliding on the `todo_write`
 * tool name, which the registry only enforces within one layer: a scoped
 * registration shadows a same-named global, and disposing that shadow returns
 * the agent to the other tool. `tool-todo-tree`'s `apply` refuses to mount
 * scoped, but the mirror composition (the flat tool mounted scoped over a
 * global tree) is not this package's to reject at load. This check is the
 * durable backstop: whichever registration path produced the mix, a session
 * log holding both event types is state no single-shape deployment can
 * produce, and consumers deriving the current todo state from it would
 * disagree about which shape is authoritative.
 *
 * TURN ENCLOSURE. `dsh-session`'s companion requires the flat `todo/write` to
 * sit inside an open turn, but it deliberately ignores merge-extensible
 * variants, so `todo/tree` falls through its default and this package owns the
 * same rule for its own event. The rule holds because `todo_write` is the only
 * producer and it appends from `execute`, which the agent loop only reaches
 * inside a turn — so a snapshot outside one is a corrupted or hand-authored
 * history rather than anything the tool can write.
 *
 * Only the COMMITTED log advances the cached state; `incoming` is tested and
 * discarded. It has to work that way because `session/event` dispatches before
 * the log push, so a listener ordered after this one can still veto the append:
 * caching the candidate would judge the next append against an event the log
 * never received. The candidate is folded in for real by the next check, which
 * reads it off the log.
 * @param cache - accumulated per-session watermarks.
 * @param session - the session whose committed log is inspected.
 * @param incoming - an event dispatched but not yet pushed, when validating an append.
 * @param fail - the invariant failure reporter.
 */
function validateTodoRelations(cache: LogCache, session: Session, incoming: SessionEvent | undefined, fail: InvariantFailure): void {
  const committed = committedFacts(cache, session)
  if (incoming?.type === 'todo/tree' && committed.openTurn === null) {
    fail('todo/tree appended outside any open turn; todo_write only appends from inside a turn')
  }
  const merged = incoming === undefined ? committed : noteEvent(incoming, committed)
  if (merged.tree && merged.flat) {
    fail('session log carries both todo/tree and todo/write; a deployment must mount exactly one todo tool')
  }
}

/* jscpd:ignore-start -- package companions share replay and dispatch plumbing */
/** Validate the package-owned event shape and ignore unrelated events. */
function validateEvent(event: SessionEvent, fail: InvariantFailure): void {
  if (event.type === 'todo/tree') validateTodos(event.data.todos, fail)
}

/** Validate every whole-tree snapshot already present in one session's log. */
function validateSession(cache: LogCache, session: Session, fail: InvariantFailure): void {
  let facts: LogFacts = { tree: false, flat: false, openTurn: null }
  for (const event of session.events) {
    validateEvent(event, fail)
    // Replay checks enclosure per event against the turn state at THAT position;
    // the incoming-event path cannot, since only the tail position is live there.
    if (event.type === 'todo/tree' && facts.openTurn === null) {
      fail('todo/tree recorded outside any open turn; todo_write only appends from inside a turn')
    }
    facts = noteEvent(event, facts)
  }
  validateTodoRelations(cache, session, undefined, fail)
}

/** Install validation for loaded, seeded, and newly appended whole-tree todo snapshots. */
const install: InvariantInstaller = Object.assign((ctx: Context, fail: InvariantFailure) => {
  const facts: LogCache = new WeakMap()
  for (const session of ctx.sessions.list()) validateSession(facts, session, fail)
  // A session created with `seed` (resume/fork) enters its whole log through the
  // constructor without emitting `session/event`, so scanning `list()` once and
  // watching future appends would let a corrupted persisted snapshot escape.
  ctx.on('session/created', (session) => { validateSession(facts, session, fail) }, { global: true })
  ctx.on('internal/dispatch', (_mode, eventName, args) => {
    if (eventName !== 'session/event') return
    const [session, event] = args as [Session, SessionEvent]
    validateEvent(event, fail)
    // Only a todo event can violate either relation, and every other event type
    // is far more frequent (one per streamed assistant chunk).
    if (isTodoEvent(event)) validateTodoRelations(facts, session, event, fail)
  }, { global: true })
}, { inject: ['sessions'] })
/* jscpd:ignore-end */

/**
 * Register the tree todo invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
