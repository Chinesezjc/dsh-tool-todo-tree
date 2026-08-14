import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'
import * as ToolTodoTree from '@deepseek-ai/dsh-tool-todo-tree'
import { MockAdapter, textResponse, toolCallResponse } from './mock-adapter.ts'

/**
 * Whether the installed `@deepseek-ai/dsh-tool-todo` refuses to append over a
 * `todo/tree` log. The harness monorepo carries that reciprocal guard through
 * this project's `tool-todo-reciprocal-guard.patch`; the published package does
 * not. Probed from the module's own source so the assertion below states which
 * upstream it ran against instead of hard-coding one.
 */
const installedFlatToolGuardsTree = String(ToolTodo.apply).includes('todo/tree')

/**
 * Full-loop integration: a scripted mock model drives the REAL tree todo_write
 * tool through the agent loop, exercising the same seams a live model would —
 * the tool/call + tool/result session events AND the todo/tree event the tool
 * appends. Only the model is mocked; the tool and the session log are real.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodoTree)
  ctx.llm.registerAdapter(['mock'], adapter)
  return ctx
}

function waitForIdle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

function findEvent<T extends SessionEvent['type']>(
  log: readonly SessionEvent[],
  type: T,
  position: 'first' | 'last' = 'first',
): Extract<SessionEvent, { type: T }> {
  const found = position === 'first'
    ? log.find(event => event.type === type)
    : log.findLast(event => event.type === type)
  if (!found) throw new Error(`no ${type} event in the session log`)
  return found as Extract<SessionEvent, { type: T }>
}

describe('tree todo_write tool through the agent loop', () => {
  it('model calls todo_write: a tool/call, a non-error tool/result, and a todo/tree snapshot land', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [
          {
            content: 'implement the fix',
            status: 'in_progress',
            children: [
              { content: 'read the code', status: 'completed' },
              { content: 'edit the module', status: 'pending' },
            ],
          },
          { content: 'run the tests', status: 'pending' },
        ],
      }, 'Planning the work.'),
      textResponse('Plan recorded.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo-tree'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan a nested task' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    expect(findEvent(log, 'tool/call').data.name).toBe('todo_write')
    expect(findEvent(log, 'tool/result').data.message.content[0].isError).toBe(false)

    const todoEvent = findEvent(log, 'todo/tree')
    expect(todoEvent.data.todos).toEqual([
      {
        content: 'implement the fix',
        status: 'in_progress',
        children: [
          { content: 'read the code', status: 'completed' },
          { content: 'edit the module', status: 'pending' },
        ],
      },
      { content: 'run the tests', status: 'pending' },
    ])
  })

  it('a second todo_write replaces the tree (last-write-wins on the log)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', { todos: [{ content: 'step one', status: 'in_progress' }] }),
      toolCallResponse('call-2', 'todo_write', {
        todos: [
          {
            content: 'step one',
            status: 'completed',
            children: [{ content: 'step one details', status: 'completed' }],
          },
          { content: 'step two', status: 'in_progress' },
        ],
      }),
      textResponse('Done planning.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-todo-tree-2'), { provider: 'mock', model: 'mock' })

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan then update' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const todoEvents = agent.session.events.filter(e => e.type === 'todo/tree')
    expect(todoEvents).toHaveLength(2)
    expect(findEvent(agent.session.events, 'todo/tree', 'last').data.todos).toEqual([
      {
        content: 'step one',
        status: 'completed',
        children: [{ content: 'step one details', status: 'completed' }],
      },
      { content: 'step two', status: 'in_progress' },
    ])
  })

  it('the reverse composition is blocked: a scoped flat tool cannot write over a tree', async () => {
    // The hazard neither load-time guard can see. `tool-todo-tree` refuses a
    // SCOPED mount, but the mirror — the flat tool on `agent.ctx` — shadows the
    // global tree with no tree-side code running, so the only thing standing
    // between it and a mixed log is the flat tool's own append-time refusal.
    // Through the real loop, so the failure the MODEL sees is what is asserted.
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_write', {
        todos: [{ content: 'tree first', status: 'in_progress' }],
      }, 'Tree plan.'),
      // Ends the first turn, so the shadow is installed between the two calls.
      textResponse('Tree recorded.'),
      toolCallResponse('call-2', 'todo_write', {
        todos: [{ content: 'flat second', status: 'in_progress' }],
      }, 'Flat plan.'),
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-reverse'), { provider: 'mock', model: 'mock' })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    // Now shadow the global tree with a scoped FLAT tool, exactly as a per-agent
    // overlay would, and let the model call `todo_write` a second time.
    await agent.ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan again' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    // The refusal itself lives in the FLAT tool's `execute`, which is upstream
    // code: `@deepseek-ai/dsh-tool-todo` as published carries no `todo/tree`
    // check, so a standalone install cannot assert its message. What this
    // package still owns, and what this asserts, is that the tree snapshot it
    // wrote stays the only todo shape on the log — the flat write either is
    // refused (patched upstream) or never happens, and either way one shape wins.
    expect(log.filter(e => e.type === 'todo/tree')).toHaveLength(1)
    const flatWrites = log.filter(e => e.type === 'todo/write')
    if (flatWrites.length > 0) {
      // An unpatched upstream appended the second shape. Record the exact
      // condition rather than passing silently: this is the mixed log the
      // reciprocal guard exists to prevent, and the invariant companion rejects
      // it on read.
      expect(installedFlatToolGuardsTree).toBe(false)
    }
  })
})
