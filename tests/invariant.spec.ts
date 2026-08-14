import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import * as TodoTreeInvariant from '@deepseek-ai/dsh-tool-todo-tree/invariant'
import InvariantService from '@deepseek-ai/dsh-invariants'

async function setup(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(InvariantService, { enabled: true })
  await ctx.plugin(TodoTreeInvariant)
  return ctx
}

function event(todos: unknown): SessionEvent {
  return { type: 'todo/tree', seq: 0, time: 0, data: { todos } } as SessionEvent
}

/** `turn/start` payload: a tree snapshot is only legal inside an open turn. */
const TURN_START = { turn: 1 } as const

/** A store session inside an open turn — the state `todo_write` appends from. */
function inTurn(ctx: Context, id: string): Session {
  const session = ctx.sessions.create(SessionId(id))
  session.append('turn/start', TURN_START)
  return session
}

/** A real Session inside an open turn — the only state `todo_write` can append from,
 *  and what the companion's enclosure check requires. The companion reads
 *  `session.events`, so the turn must be on the log, not just implied. */
function bare(id = 'bare'): Session {
  const session = Session.create(SessionId(id))
  session.append('turn/start', { turn: 1 })
  return session
}

describe('todo tree snapshot invariants', () => {
  it('accepts a nested whole-tree snapshot with one active node', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', bare(), event([
      {
        content: 'Inspect state',
        status: 'completed',
        children: [{ content: 'Read the log', status: 'completed' }],
      },
      { content: 'Apply fix', status: 'in_progress' },
      { content: 'Run checks', status: 'pending' },
    ])) }).not.toThrow()
  })

  it('accepts repeated content across different sibling groups', async () => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', bare(), event([
      { content: 'review', status: 'pending', children: [{ content: 'review', status: 'pending' }] },
    ])) }).not.toThrow()
  })

  it.each([
    ['not-an-array', /must be an array/],
    [[null], /entries must be objects/],
    [[42], /entries must be objects/],
    [[{ content: 42, status: 'pending' }], /content must be non-empty/],
    [[{ content: '', status: 'pending' }], /content must be non-empty/],
    [[{ content: ' padded ', status: 'pending' }], /already trimmed/],
    [[{ content: 'same', status: 'pending' }, { content: 'same', status: 'completed' }], /repeats sibling content/],
    [[{ content: 'p', status: 'pending', children: [{ content: 's', status: 'pending' }, { content: 's', status: 'pending' }] }], /repeats sibling content/],
    [[{ content: 'task', status: 42 }], /unknown status/],
    [[{ content: 'task', status: 'paused' }], /unknown status/],
    [[{ content: 'one', status: 'in_progress' }, { content: 'two', status: 'in_progress' }], /at most one/],
    [[{ content: 'p', status: 'in_progress', children: [{ content: 'c', status: 'in_progress' }] }], /at most one/],
    [[{ content: 'p', status: 'pending', children: [] }], /children must be a non-empty array or absent/],
    [[{ content: '1', status: 'pending', children: [{ content: '2', status: 'pending', children: [{ content: '3', status: 'pending', children: [{ content: '4', status: 'pending' }] }] }] }], /nests deeper than the protocol cap/],
    [[{ content: 'p', status: 'pending', children: 'nope' }], /children must be a non-empty array or absent/],
    [[{ content: 'p', status: 'pending', children: [{ content: '', status: 'pending' }] }], /content must be non-empty/],
    [[{ content: 'p', status: 'completed', children: [{ content: 'c', status: 'pending' }] }], /completes "p" over an unfinished child/],
    [[{ content: 'p', status: 'completed', children: [{ content: 'c', status: 'in_progress' }] }], /completes "p" over an unfinished child/],
  ])('rejects an incoherent durable tree snapshot', async (todos, message) => {
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', bare(), event(todos)) }).toThrow(message)
  })

  it('ignores unrelated dispatches and session events', async () => {
    const ctx = await setup()
    expect(() => {
      ctx.emit('tools/change')
      ctx.emit('session/event', bare(), {
        type: 'turn/start', seq: 0, time: 0, data: { turn: 1 },
      })
    }).not.toThrow()
  })

  it('enforces the protocol cap, not a narrower tool maxDepth', async () => {
    // The companion validates durable snapshots from any producer, including a
    // log written under a different maxDepth, so a three-level snapshot stays
    // valid even where a maxDepth-1 deployment would refuse to WRITE it.
    const ctx = await setup()
    expect(() => { ctx.emit('session/event', bare(), event([
      {
        content: 'plan',
        status: 'in_progress',
        children: [{ content: 'step', status: 'pending', children: [{ content: 'sub-step', status: 'pending' }] }],
      },
    ])) }).not.toThrow()
  })

  it('accepts a valid snapshot seeded into a session created after installation', async () => {
    const ctx = await setup()
    expect(() => ctx.sessions.create(SessionId('clean'), {
      seed: [
        { type: 'turn/start', seq: 0, time: 0, data: TURN_START },
        { ...event([
          { content: 'parent', status: 'in_progress', children: [{ content: 'child', status: 'pending' }] },
        ]), seq: 1 },
      ],
    })).not.toThrow()
  })

  it('rejects a tree snapshot appended outside any open turn', async () => {
    // `dsh-session`'s companion requires the FLAT todo/write to be turn-enclosed
    // but deliberately ignores merge-extensible variants, so todo/tree falls
    // through its default and this package owns the same rule for its own event.
    const ctx = await setup()
    const session = ctx.sessions.create(SessionId('no-turn'))
    expect(() => {
      session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    }).toThrow(/outside any open turn/)
  })

  it('rejects a tree snapshot appended after the turn closed', async () => {
    const ctx = await setup()
    const session = inTurn(ctx, 'turn-closed')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect(() => {
      session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    }).toThrow(/outside any open turn/)
  })

  it('accepts a tree snapshot in a later turn after an earlier one closed', async () => {
    // The fold tracks the CURRENT open turn, not "a turn was once open".
    const ctx = await setup()
    const session = inTurn(ctx, 'second-turn')
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    session.append('turn/start', { turn: 2 })
    expect(() => {
      session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    }).not.toThrow()
  })

  it('rejects a resumed session seeded with a tree snapshot outside a turn', async () => {
    // Replay checks enclosure at each event's OWN log position, which the
    // incoming-event path cannot do (only the tail position is live there).
    const ctx = await setup()
    expect(() => ctx.sessions.create(SessionId('seeded-no-turn'), {
      seed: [event([{ content: 'tree', status: 'pending' }])],
    })).toThrow(/outside any open turn/)
  })

  it('rejects a session log that carries both todo shapes', async () => {
    // A scoped registration shadows a same-named global instead of colliding
    // with it, so a disposed shadow can return one agent to the other tool.
    // Whichever path produced it, both shapes in one log is unresolvable state.
    const ctx = await setup()
    const session = inTurn(ctx, 'mixed')
    session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    expect(() => {
      session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    }).toThrow(/carries both todo\/tree and todo\/write/)
  })

  it('rejects the mix in the other arrival order too', async () => {
    const ctx = await setup()
    const session = inTurn(ctx, 'mixed-2')
    session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    expect(() => {
      session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    }).toThrow(/carries both todo\/tree and todo\/write/)
  })

  it('accepts a log carrying only the flat shape (the other tool owns its own checks)', async () => {
    const ctx = await setup()
    const session = inTurn(ctx, 'flat-only')
    expect(() => {
      session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    }).not.toThrow()
  })

  it('does not let a rejected append poison the cached shape state', async () => {
    // The rejected event never reaches the log, so recording its shape would make
    // the NEXT tree append fail against a mix the log does not actually hold.
    const ctx = await setup()
    const session = inTurn(ctx, 'rejected-append')
    session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    expect(() => {
      session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    }).toThrow(/carries both todo\/tree and todo\/write/)
    expect(() => {
      session.append('todo/tree', { todos: [{ content: 'tree again', status: 'pending' }] })
    }).not.toThrow()
  })

  it('keeps tracking shapes across appends of unrelated events', async () => {
    // Non-todo events skip the check entirely (one per streamed assistant chunk),
    // which must not lose the shape an earlier append recorded.
    const ctx = await setup()
    const session = inTurn(ctx, 'interleaved')
    session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    session.append('turn/start', { turn: 1 })
    expect(() => {
      session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    }).toThrow(/carries both todo\/tree and todo\/write/)
  })

  it('does not cache a candidate a later dispatch listener vetoes', async () => {
    // `session/event` dispatches BEFORE the log push, so a listener ordered
    // after this companion can still veto the append. Caching the candidate
    // would reject the next legal append against an event the log never got.
    const ctx = await setup()
    ctx.on('internal/dispatch', (_mode, eventName, args) => {
      if (eventName !== 'session/event') return
      const [, event] = args as [Session, SessionEvent]
      if (event.type === 'todo/write') throw new Error('vetoed by another plugin')
    }, { global: true })
    const session = inTurn(ctx, 'vetoed')
    expect(() => {
      session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    }).toThrow(/vetoed by another plugin/)
    // Only the turn/start that opened the turn: the vetoed event never landed.
    expect(session.events.map(e => e.type)).toEqual(['turn/start'])
    expect(() => {
      session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    }).not.toThrow()
  })

  it('folds in events appended while the session was detached from the store', async () => {
    // A detached session emits no dispatch, but its log still grows. Reusing a
    // stale cache entry on re-announcement would accept the mix it gained.
    const ctx = await setup()
    const session = ctx.sessions.prepare(SessionId('reentered'))
    const detach = ctx.sessions.enter(session)
    ctx.sessions.announce(session)
    session.append('turn/start', TURN_START)
    session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    detach()
    session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })

    ctx.sessions.enter(session)
    expect(() => { ctx.sessions.announce(session) }).toThrow(/carries both todo\/tree and todo\/write/)
  })

  it('rejects a resumed session seeded with both shapes', async () => {
    const ctx = await setup()
    expect(() => ctx.sessions.create(SessionId('seeded-mix'), {
      seed: [
        { type: 'turn/start', seq: 0, time: 0, data: TURN_START },
        { ...event([{ content: 'tree', status: 'pending' }]), seq: 1 },
        { type: 'todo/write', seq: 2, time: 0, data: { todos: [{ content: 'flat', status: 'pending' }] } },
      ],
    })).toThrow(/carries both todo\/tree and todo\/write/)
  })

  it('rejects an existing mixed log on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    const session = ctx.sessions.create()
    session.append('turn/start', TURN_START)
    session.append('todo/tree', { todos: [{ content: 'tree', status: 'pending' }] })
    // An unrelated event between the two: the registration-time scan reads the
    // whole log, so it must skip a non-todo event rather than misread its shape.
    session.append('turn/start', { turn: 1 })
    session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    await ctx.plugin(InvariantService, { enabled: true })

    await expect(ctx.plugin(TodoTreeInvariant).then(() => undefined))
      .rejects.toThrow(/carries both todo\/tree and todo\/write/)
  })

  it('rejects an invalid existing snapshot on late registration', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    ctx.sessions.create().append('todo/tree', {
      todos: [
        { content: 'duplicate', status: 'pending' },
        { content: 'duplicate', status: 'completed' },
      ],
    })
    await ctx.plugin(InvariantService, { enabled: true })

    await expect(ctx.plugin(TodoTreeInvariant).then(() => undefined)).rejects.toThrow(/repeats sibling content "duplicate"/)
  })

  it('rejects a session seeded with an invalid snapshot after the companion loads', async () => {
    const ctx = await setup()
    // A resumed session created after load announces its seed through
    // session/created; the companion must scan that seed, not only future appends.
    expect(() => {
      ctx.sessions.create(undefined, {
        seed: [event([
          { content: 'duplicate', status: 'pending' },
          { content: 'duplicate', status: 'completed' },
        ])],
      })
    }).toThrow(/repeats sibling content "duplicate"/)
  })
})
