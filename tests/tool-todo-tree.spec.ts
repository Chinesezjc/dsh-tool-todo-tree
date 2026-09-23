import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { type Agent } from '@deepseek-ai/dsh-agent'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Scope } from '@deepseek-ai/dsh-scope'
// The flat tool, mounted next to this package in the coexistence test.
import * as ToolTodo from '@deepseek-ai/dsh-tool-todo'

import * as tool from '../src/index.ts'
import type { TodoTreeItem } from '../src/index.ts'

const testToolSignal = new AbortController().signal

/**
 * Drives the REAL plugin body: mounts `dsh-tool-todo-tree` on a real
 * `ToolRegistry` and invokes the registered `todo_tree_write` tool through
 * `ctx.tools.execute`, with a fake parent Agent carrying a real `Session` — so
 * the append the tool makes is observable on a genuine session log (only the
 * agent wrapper is a stand-in; the session and the tool are the shipping code).
 */

/** A parent Agent backed by a real Session — the tool reads `agent.session`. */
function agentWithSession(id = 'parent-1'): Agent & { session: Session } {
  const session = Session.create(SessionId(id))
  return { id: SessionId(id), session } as unknown as Agent & { session: Session }
}

async function setup(config: Partial<tool.Config> = {}): Promise<Context> {
  const full: tool.Config = { allowParallelInProgress: false, ...config }
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRegistry)
  await ctx.plugin(tool, full)
  return ctx
}

let callCounter = 0
function callTodo(ctx: Context, args: unknown, over: { agent?: Agent | undefined } = {}) {
  const agent = 'agent' in over ? over.agent : agentWithSession()
  return ctx.tools.execute({
    signal: testToolSignal,
    callId: ToolCallId(`call-${++callCounter}`),
    name: 'todo_tree_write',
    arguments: args,
    ...agent ? { agent } : {},
  })
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(b => b.type === 'text').map(b => b.text).join('')
}

describe('dsh-tool-todo-tree', () => {
  it('registers a `todo_tree_write` tool whose schema nests children to exactly SCHEMA_DEPTH levels', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(s => s.name === 'todo_tree_write')
    expect(schema).toBeDefined()
    const props = (schema!.parameters as { properties?: Record<string, unknown> }).properties ?? {}
    expect(Object.keys(props)).toEqual(['todos'])

    // Walk the literal expansion: every level has {content,status,children},
    // and only the innermost level's children carries no element shape.
    type Node = { properties?: Record<string, { type?: string; enum?: string[]; items?: Node }> }
    let level = (props.todos as { type: string; items?: Node }).items
    for (let depth = 1; depth <= tool.SCHEMA_DEPTH; depth++) {
      expect(level).toBeDefined()
      const levelProps = level!.properties ?? {}
      expect(levelProps.status?.enum).toEqual(['pending', 'in_progress', 'completed'])
      expect(Object.keys(levelProps).sort()).toEqual(['children', 'content', 'status'])
      expect(levelProps.children?.type).toBe('array')
      if (depth < tool.SCHEMA_DEPTH) {
        level = levelProps.children?.items
      } else {
        expect(levelProps.children?.items).toBeUndefined()
      }
    }
  })

  it('appends a todo/tree event carrying the whole tree to the calling session', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer')
    const todos: TodoTreeItem[] = [
      {
        content: 'plan',
        status: 'in_progress',
        children: [
          { content: 'read the code', status: 'completed' },
          { content: 'sketch the fix', status: 'pending' },
        ],
      },
      { content: 'build', status: 'pending' },
    ]
    const result = await callTodo(ctx, { todos }, { agent })
    expect(result.isError).toBe(false)
    if (result.isError) throw new Error('expected todo_tree_write success')
    expect(result.value).toEqual({
      todos,
      counts: { pending: 2, inProgress: 1, completed: 1 },
    })
    expect(text(result)).toContain('2 pending, 1 in progress, 1 completed')

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'todo/tree')!
    expect(event.data.todos).toEqual(todos)
  })

  it('stores trimmed content and canonicalizes empty children arrays to an absent field', async () => {
    const ctx = await setup()
    const agent = agentWithSession('trim')
    const result = await callTodo(ctx, { todos: [
      { content: '  plan the work  ', status: 'pending', children: [] },
    ] }, { agent })
    expect(result.isError).toBe(false)

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'todo/tree')!
    expect(event.data.todos).toEqual([{ content: 'plan the work', status: 'pending' }])
  })

  it('canonicalizes an empty children array at the deepest schema level too', async () => {
    const ctx = await setup()
    const agent = agentWithSession('deep-leaf')
    const leaf = { content: 'c', status: 'pending', children: [] }
    const result = await callTodo(ctx, { todos: [
      { content: 'a', status: 'pending', children: [{ content: 'b', status: 'pending', children: [leaf] }] },
    ] }, { agent })
    expect(result.isError).toBe(false)

    const event = agent.session.snapshotEvents().findLast(e => e.type === 'todo/tree')!
    expect(event.data.todos).toEqual([
      { content: 'a', status: 'pending', children: [
        { content: 'b', status: 'pending', children: [{ content: 'c', status: 'pending' }] },
      ] },
    ])
  })

  it('rejects a node nested past the deepest schema level', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [
      { content: 'a', status: 'pending', children: [
        { content: 'b', status: 'pending', children: [
          { content: 'c', status: 'pending', children: [{ content: 'd', status: 'pending' }] },
        ] },
      ] },
    ] })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(`maximum depth of ${tool.SCHEMA_DEPTH}`)
  })

  it('appends over a flat list already in the session log (the two tools coexist)', async () => {
    // A preset mounts the flat tool at agent scope; this package's tool is at
    // host scope. The names differ, so both may be called in one session and each
    // shape lands under its own event type. Refusing here would make the tree
    // tool unusable in every shipped preset.
    const ctx = await setup()
    const agent = agentWithSession('already-flat')
    agent.session.append('todo/write', { todos: [{ content: 'flat', status: 'pending' }] })
    const result = await callTodo(ctx, { todos: [{ content: 'tree', status: 'pending' }] }, { agent })
    expect(result.isError).toBe(false)
    expect(agent.session.snapshotEvents().map(e => e.type)).toEqual(['todo/write', 'todo/tree'])
  })

  it('replaces the tree on a second call (last-write-wins on the log)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('writer-2')
    await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent })
    await callTodo(ctx, { todos: [
      { content: 'a', status: 'completed', children: [{ content: 'a.1', status: 'completed' }] },
      { content: 'b', status: 'in_progress' },
    ] }, { agent })

    const current = agent.session.snapshotEvents().findLast(e => e.type === 'todo/tree')!.data.todos
    expect(current).toEqual([
      { content: 'a', status: 'completed', children: [{ content: 'a.1', status: 'completed' }] },
      { content: 'b', status: 'in_progress' },
    ])
  })

  it('rejects a malformed status before execute runs (registry arg-validation)', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [{ content: 'x', status: 'doing' }] })
    expect(result.isError).toBe(true)
  })

  it('rejects a nested status the same way (the literal schema covers every level)', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [
      { content: 'x', status: 'pending', children: [{ content: 'y', status: 'doing' }] },
    ] })
    expect(result.isError).toBe(true)
  })

  it('rejects a fourth nesting level at the schema boundary (children is not a valid leaf key)', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [
      { content: '1', status: 'pending', children: [
        { content: '2', status: 'pending', children: [
          { content: '3', status: 'pending', children: [
            { content: '4', status: 'pending' },
          ] },
        ] },
      ] },
    ] })
    expect(result.isError).toBe(true)
  })

  it('rejects a non-array todos argument', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: 'nope' })
    expect(result.isError).toBe(true)
  })

  it.each([
    { label: 'empty content', todos: [{ content: '   ', status: 'pending' }], fragment: 'non-empty' },
    { label: 'nested empty content', todos: [{ content: 'a', status: 'pending', children: [{ content: ' ', status: 'pending' }] }], fragment: 'non-empty' },
    { label: 'duplicate sibling content', todos: [{ content: 'dup', status: 'pending' }, { content: 'dup', status: 'completed' }], fragment: 'duplicate sibling' },
    { label: 'duplicate nested siblings', todos: [{ content: 'a', status: 'pending', children: [{ content: 'dup', status: 'pending' }, { content: 'dup', status: 'pending' }] }], fragment: 'duplicate sibling' },
    { label: 'two in_progress across levels', todos: [{ content: 'a', status: 'in_progress', children: [{ content: 'b', status: 'in_progress' }] }], fragment: 'in_progress' },
    { label: 'completed parent over a pending child', todos: [{ content: 'a', status: 'completed', children: [{ content: 'b', status: 'pending' }] }], fragment: 'unfinished children' },
    { label: 'completed parent over an in_progress child', todos: [{ content: 'a', status: 'completed', children: [{ content: 'b', status: 'in_progress' }] }], fragment: 'unfinished children' },
  ])('rejects $label as an isError result', async ({ todos, fragment }) => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain(fragment)
  })

  it('allows the same content on different levels (dedup is per sibling group)', async () => {
    const ctx = await setup()
    const agent = agentWithSession('cross-level')
    const result = await callTodo(ctx, { todos: [
      { content: 'review', status: 'pending', children: [{ content: 'review', status: 'pending' }] },
    ] }, { agent })
    expect(result.isError).toBe(false)
  })

  it('enforces a configured maxDepth below the schema depth at execute time', async () => {
    const ctx = await setup({ maxDepth: 1 })
    const flat = await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] })
    expect(flat.isError).toBe(false)
    const nested = await callTodo(ctx, { todos: [
      { content: 'a', status: 'pending', children: [{ content: 'b', status: 'pending' }] },
    ] })
    expect(nested.isError).toBe(true)
    expect(text(nested)).toContain('maximum depth of 1')
  })

  it.each([
    { label: 'zero', maxDepth: 0 },
    { label: 'negative', maxDepth: -2 },
    { label: 'fractional', maxDepth: 1.5 },
    { label: 'above SCHEMA_DEPTH', maxDepth: tool.SCHEMA_DEPTH + 1 },
  ])('fails loud at load on a $label maxDepth', async ({ maxDepth }) => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await expect(ctx.plugin(tool, { maxDepth, allowParallelInProgress: false }).then(() => undefined))
      .rejects.toThrow(/maxDepth must be an integer between 1 and/)
  })

  it('rejects a non-agent caller (the tree has no owning session)', async () => {
    const ctx = await setup()
    const result = await callTodo(ctx, { todos: [{ content: 'a', status: 'pending' }] }, { agent: undefined })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('owning agent session')
  })

  it('presents the call with a stable title and the tree as raw input', async () => {
    const ctx = await setup()
    const def = ctx.tools.get('todo_tree_write')!
    const todos = [{ content: 'a', status: 'pending' }]
    expect(def.presentCall?.({ todos })).toEqual({ card: 'generic', title: 'Update todo tree', kind: 'other', rawInput: todos })
  })

  it('unregisters the tool when its contributing fiber is disposed (HMR-safety)', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    const fiber = await ctx.plugin(tool, { allowParallelInProgress: false })
    expect(ctx.tools.schemas().some(s => s.name === 'todo_tree_write')).toBe(true)
    await fiber.dispose()
    expect(ctx.tools.schemas().some(s => s.name === 'todo_tree_write')).toBe(false)
  })

  it('mounts alongside the flat tool: the two registrations never collide', async () => {
    // This is the property the distinct name buys. Reverting the tool name to
    // `todo_write` makes the second registration collide and this test fail.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    // The flat tool injects `sessionProjections`; without that seam its apply
    // never runs and the coexistence assertion would pass vacuously.
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(ToolTodo, { allowParallelInProgress: true })
    await ctx.plugin(tool, { allowParallelInProgress: true })
    const names = ctx.tools.schemas().map(s => s.name)
    expect(names).toContain('todo_write')
    expect(names).toContain('todo_tree_write')
  })

  it('mounts on a scoped context: the name is this package\'s own, so a scoped instance is an ordinary variant', async () => {
    // Nothing here competes for the flat tool's registration, so a scoped mount
    // shadows THIS package's global row by name the same way any per-agent tool
    // variant does, and disposing the scope leaves the global row in place.
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRegistry)
    await ctx.plugin(tool, { allowParallelInProgress: false })
    let scope!: Scope
    await ctx.plugin(Object.assign((inner: Context) => {
      scope = createScope(inner, { id: SessionId('a1') })
    }, { inject: ['tools', 'systemPrompt'] }))

    const fiber = await scope.ctx.plugin(tool, { allowParallelInProgress: false })
    expect(scope.ctx.tools.schemas().some(s => s.name === 'todo_tree_write')).toBe(true)
    await fiber.dispose()
    // The host-scope registration is untouched by the scope's disposal.
    expect(ctx.tools.schemas().some(s => s.name === 'todo_tree_write')).toBe(true)
  })

  it('has the namespace-plugin export shape (no stray default) so the Loader keeps name/inject/apply', () => {
    // A default export would make Loader unwrap only apply and drop `inject`.
    expect('default' in tool).toBe(false)
    expect(tool.name).toBe('tool-todo-tree')
    expect(tool.inject).toEqual(['tools'])

    const loader = Object.create(Loader.prototype) as Loader
    const unwrapped = loader.unwrapExports(tool) as Record<string, unknown>
    expect(unwrapped).toBe(tool)
    expect(unwrapped.name).toBe('tool-todo-tree')
    expect(unwrapped.inject).toEqual(['tools'])
    expect(typeof unwrapped.apply).toBe('function')
  })
})
