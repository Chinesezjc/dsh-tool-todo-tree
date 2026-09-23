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
 * Full-loop integration: a scripted mock model drives the REAL tree
 * `todo_tree_write` tool through the agent loop, exercising the same seams a live
 * model would — the tool/call + tool/result session events AND the todo/tree
 * event the tool appends. Only the model is mocked; the tool and the session log
 * are real.
 */
async function harness(adapter: MockAdapter): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(ToolTodoTree, { allowParallelInProgress: false })
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

describe('tree todo_tree_write tool through the agent loop', () => {
  it('model calls todo_tree_write: a tool/call, a non-error tool/result, and a todo/tree snapshot land', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_tree_write', {
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
    expect(findEvent(log, 'tool/call').data.name).toBe('todo_tree_write')
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

  it('a second todo_tree_write replaces the tree (last-write-wins on the log)', async () => {
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_tree_write', { todos: [{ content: 'step one', status: 'in_progress' }] }),
      toolCallResponse('call-2', 'todo_tree_write', {
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

  it('a preset-mounted flat tool does not displace the tree tool: both shapes land in one log', async () => {
    // The composition that used to make this plugin unusable: every shipped agent
    // preset mounts the flat tool at agent scope, over this package's host-scope
    // registration. Distinct tool names make that a coexistence instead of a
    // shadow, so the model keeps `todo_tree_write` and gains `todo_write`.
    // Through the real loop, so what the MODEL reaches is what is asserted.
    const adapter = new MockAdapter([
      toolCallResponse('call-1', 'todo_tree_write', {
        todos: [{ content: 'tree first', status: 'in_progress' }],
      }, 'Tree plan.'),
      toolCallResponse('call-2', 'todo_write', {
        todos: [{ content: 'flat second', status: 'in_progress' }],
      }, 'Flat plan.'),
      toolCallResponse('call-3', 'todo_tree_write', {
        todos: [{ content: 'tree again', status: 'completed' }],
      }, 'Tree again.'),
      textResponse('Done.'),
    ])
    const ctx = await harness(adapter)
    const agent = ctx.agentLoop.create(SessionId('it-both-shapes'), { provider: 'mock', model: 'mock' })
    // Exactly what a shipped preset does: mount the flat tool inside the agent's
    // own scope, over this package's host-scope tree tool.
    await agent.ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'plan' }], source: { kind: 'user' } }))
    await waitForIdle(ctx, agent)

    const log = agent.session.events
    expect(log.filter(e => e.type === 'todo/tree')).toHaveLength(2)
    expect(log.filter(e => e.type === 'todo/write')).toHaveLength(1)
    // Every call reached its own tool: no refusal, no shadowing.
    expect(log.filter(e => e.type === 'tool/result').map(e => e.data.message.content[0]?.isError))
      .toEqual([false, false, false])
  })
})
