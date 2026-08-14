// Proves `maxDepth` is real configurability and not a constant: the value is set
// in a cordis.yml booted through the real Loader, and the depth the tool ACCEPTS
// follows it while the advertised schema keeps its fixed SCHEMA_DEPTH expansion.
// Also boots the load-time rejections (out-of-range maxDepth, scoped mount)
// through the same real composition, because both are contracts a deployment
// hits at startup rather than at first call.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolTodoTree from '@deepseek-ai/dsh-tool-todo-tree'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

function agent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('todo-tree-loader-agent')
  const session = Session.create(id)
  const value: Agent = {
    id, options: {}, session, inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle', ctx: scope.ctx,
    followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml carrying the given tool-todo-tree config block.
 * @param configLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(configLines: readonly string[]): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-todo-tree-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-tool-todo-tree'",
    ...configLines.length > 0 ? ['  config:', ...configLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-tool-todo-tree', ToolTodoTree],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

/** Two nodes in progress at different depths — the shape the parallel policy decides. */
const PARALLEL_TREE = [{
  content: 'run the fan-out',
  status: 'in_progress',
  children: [{ content: 'subagent a', status: 'in_progress' }],
}]

/** A depth-2 tree: one root carrying one child. */
const DEPTH_2 = [{
  content: 'implement the fix',
  status: 'in_progress',
  children: [{ content: 'read the code', status: 'pending' }],
}]

function execute(ctx: Context, owner: Agent, todos: unknown, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(callId),
    name: 'todo_write',
    arguments: { todos },
    agent: owner,
  })
}

describe('tool-todo-tree real Loader composition through cordis.yml', () => {
  it('maxDepth: 1 rejects a nested write while the advertised schema keeps its three levels', async () => {
    const ctx = await boot(['    maxDepth: 1', '    allowParallelInProgress: false'])
    // The model contract is the fixed SCHEMA_DEPTH expansion regardless of the
    // configured cap, so the schema still describes children two levels down.
    const schema = ctx.tools.schemas().find(s => s.name === 'todo_write')
    const level1 = (schema?.parameters as { properties?: Record<string, { items?: { properties?: Record<string, unknown> } }> })
      .properties?.todos?.items?.properties
    expect(level1).toHaveProperty('children')

    const owner = agent(ctx)
    const result = await execute(ctx, owner, DEPTH_2, 'too-deep')
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('maximum depth of 1')
    // A rejected call writes nothing.
    expect(owner.session.events.some(e => e.type === 'todo/tree')).toBe(false)
  }, 30_000)

  it('maxDepth: 3 accepts the same nested write end to end', async () => {
    const ctx = await boot(['    maxDepth: 3', '    allowParallelInProgress: false'])
    const owner = agent(ctx)
    const result = await execute(ctx, owner, DEPTH_2, 'nested-ok')
    expect(result.isError).toBe(false)
    expect(owner.session.events.findLast(e => e.type === 'todo/tree')?.data.todos).toEqual(DEPTH_2)
  }, 30_000)

  it('defaults to the schema depth when the config omits maxDepth', async () => {
    const ctx = await boot(['    allowParallelInProgress: false'])
    const owner = agent(ctx)
    // Depth 3 is the protocol cap, so it must be accepted with no config at all.
    const depth3 = [{
      content: 'a',
      status: 'pending',
      children: [{ content: 'b', status: 'pending', children: [{ content: 'c', status: 'pending' }] }],
    }]
    const result = await execute(ctx, owner, depth3, 'default-depth')
    expect(result.isError).toBe(false)
    expect(owner.session.events.findLast(e => e.type === 'todo/tree')?.data.todos).toEqual(depth3)
  }, 30_000)

  it('a maxDepth past the advertised schema fails the entry at load', async () => {
    // Accepting more than the schema advertises would diverge the model contract
    // from enforcement, so the plugin refuses at load. The Loader surfaces that
    // as the boot rejection itself, not as a started-then-broken entry.
    await expect(boot(['    maxDepth: 4', '    allowParallelInProgress: false'])).rejects.toThrow('maxDepth must be an integer between 1 and 3')
  }, 30_000)

  it('allowParallelInProgress: false rejects several in_progress nodes and narrows the description', async () => {
    const ctx = await boot(['    allowParallelInProgress: false'])
    const description = ctx.tools.schemas().find(s => s.name === 'todo_write')?.description ?? ''
    expect(description).toContain('AT MOST ONE todo `in_progress` across the WHOLE tree')
    expect(description).not.toContain('several at once')

    const owner = agent(ctx)
    const result = await execute(ctx, owner, PARALLEL_TREE, 'parallel-denied')
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('at most one task may be in_progress')
    expect(owner.session.events.some(e => e.type === 'todo/tree')).toBe(false)
  }, 30_000)

  it('allowParallelInProgress: true permits in_progress nodes at several depths', async () => {
    // The flat tool ships the same flag, and a deployment that chose parallel
    // work must not lose it by swapping in the nested shape.
    const ctx = await boot(['    allowParallelInProgress: true'])
    const description = ctx.tools.schemas().find(s => s.name === 'todo_write')?.description ?? ''
    expect(description).toContain('several at once when work genuinely runs in parallel')

    const owner = agent(ctx)
    const result = await execute(ctx, owner, PARALLEL_TREE, 'parallel-allowed')
    expect(result.isError).toBe(false)
    expect(owner.session.events.findLast(e => e.type === 'todo/tree')?.data.todos).toEqual(PARALLEL_TREE)
  }, 30_000)
})
