/**
 * The `todoTree` projection provider: mounting tool-todo-tree beside the
 * registry serves the whole current tree on the history tail page with a
 * consistent asOfSeq (= last event seq); before any write the value is null; a
 * composition without the tool has no `todoTree` key; unmounting the tool
 * removes it (HMR safety). The carrier and framework are exercised unmodified.
 *
 * Distinct from the flat tool's `projection.spec.ts` in what only the tree can
 * assert: a whole nested snapshot survives the fold and the wire schema with
 * its children intact, and the key this package publishes is its own — a
 * deployment mounting the nested tool never gains the flat `todos` key.
 *
 * Snapshots are appended inside an open turn and within the protocol depth cap
 * because this package's invariant companion enforces both on every durable
 * `todo/tree` (see `src/invariant.ts`); those rejections are its own tests'
 * subject, so here they are preconditions, not assertions.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { createApiProxy } from '@deepseek-ai/dsh-host-apiproxy'
import * as ToolTodoTree from '@deepseek-ai/dsh-tool-todo-tree'
import type { TodoTreeItem } from '@deepseek-ai/dsh-tool-todo-tree/types'

let nextRpc = 1
function request<P>(payload: P): RpcRequest<P> {
  return { rpcId: RpcId(`todo-tree-proj-${String(nextRpc++)}`), payload }
}

interface Bench {
  ctx: Context
  session: Session
  tailProjections(): Promise<{ asOfSeq: number; values: Record<string, unknown> } | undefined>
}

async function harness(withTreeTool: boolean): Promise<Bench> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt, { persona: '' })
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SessionProjectionRegistry)
  if (withTreeTool) await ctx.plugin(ToolTodoTree)
  const session = ctx.sessions.create()
  ctx.agents.register({ id: session.id, session, status: 'idle', ctx } as Agent)
  const api = createApiProxy(ctx, { defaultModelSelection: () => ({ provider: 'p', model: 'm' }), cwd: '/tmp' })
  return {
    ctx,
    session,
    async tailProjections() {
      const response = await api.sessions.history(request({ sessionId: session.id }))
      if (!response.result.ok) throw new Error('history failed')
      return response.result.value.projections
    },
  }
}

/**
 * One paginable message so the tail page is non-degenerate, plus the open turn
 * every durable `todo/tree` must sit inside (the package invariant rejects a
 * snapshot appended outside one).
 */
function seedMessage(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'hi' }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('turn/start', { turn: 1 })
}

describe('todoTree projection provider', () => {
  it('serves null before the first todo/tree', async () => {
    const bench = await harness(true)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections?.values.todoTree).toBeNull()
    expect(projections?.asOfSeq).toBe(bench.session.seq - 1)
  })

  it('serves the latest whole tree after writes, asOfSeq = last event seq', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const first: TodoTreeItem[] = [{ content: 'a', status: 'pending' }]
    const second: TodoTreeItem[] = [
      {
        content: 'a',
        status: 'pending',
        children: [
          { content: 'a1', status: 'completed' },
          { content: 'a2', status: 'in_progress' },
        ],
      },
      { content: 'b', status: 'pending' },
    ]
    session.append('todo/tree', { todos: first })
    session.append('todo/tree', { todos: second })
    const projections = await bench.tailProjections()
    // Last-wins: the latest snapshot, whole and still nested.
    expect(projections?.values.todoTree).toEqual(second)
    expect(projections?.asOfSeq).toBe(session.seq - 1)
  })

  it('carries a tree filled to the protocol depth cap across the wire', async () => {
    // The projection schema is recursive (`z.lazy`) rather than the literal
    // expansion the model-facing parameter schema needs, so the deepest tree
    // the invariant admits must survive validation with every level intact.
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const deep: TodoTreeItem[] = [{
      content: 'l1',
      status: 'pending',
      children: [{
        content: 'l2',
        status: 'pending',
        children: [{ content: 'l3', status: 'in_progress' }],
      }],
    }]
    session.append('todo/tree', { todos: deep })
    expect((await bench.tailProjections())?.values.todoTree).toEqual(deep)
  })

  it('clears the standing tree on the next turn/start (turn/end keeps it)', async () => {
    const bench = await harness(true)
    const session = bench.session
    seedMessage(session)
    const tree: TodoTreeItem[] = [{
      content: 'root',
      status: 'completed',
      children: [{ content: 'leaf', status: 'completed' }],
    }]
    session.append('todo/tree', { todos: tree })
    session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    expect((await bench.tailProjections())?.values.todoTree).toEqual(tree)
    session.append('turn/start', { turn: 2 })
    const cleared = await bench.tailProjections()
    expect(cleared?.values.todoTree).toBeNull()
    expect(cleared?.asOfSeq).toBe(session.seq - 1)
  })

  it('publishes only its own key: the nested composition has no flat `todos`', async () => {
    // The two payload types differ, so a flat consumer handed a nested value
    // would render children it has no row for. Mounting the nested tool must
    // not create the flat key.
    const bench = await harness(true)
    seedMessage(bench.session)
    bench.session.append('todo/tree', { todos: [{ content: 'a', status: 'pending' }] })
    const values = (await bench.tailProjections())?.values ?? {}
    expect('todoTree' in values).toBe(true)
    expect('todos' in values).toBe(false)
  })

  it('has no todoTree key when tool-todo-tree is not composed', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const projections = await bench.tailProjections()
    expect(projections).toBeDefined()
    expect('todoTree' in (projections?.values ?? {})).toBe(false)
  })

  it('drops the key when the tool-todo-tree fiber unloads (HMR safety)', async () => {
    const bench = await harness(false)
    seedMessage(bench.session)
    const fiber = await bench.ctx.plugin(ToolTodoTree)
    expect((await bench.tailProjections())?.values.todoTree).toBeNull()
    await fiber.dispose()
    expect('todoTree' in ((await bench.tailProjections())?.values ?? {})).toBe(false)
  })
})
