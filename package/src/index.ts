/**
 * Model-facing whole-tree replacement. Each call appends a `todo/tree` snapshot to the calling
 * agent's session; replay is last-write-wins, and UIs render from session events. A non-agent
 * caller has no owning tree and is rejected. This package is the nested ALTERNATIVE to
 * `@deepseek-ai/dsh-tool-todo`: both register `todo_write`, so a deployment picks exactly one.
 * Two mounts at the same registry layer collide on the name and the registry rejects whichever
 * mounts second (silently, until boot audits FAILED fibers). A SCOPED mount does not collide —
 * scoped registrations shadow globals by design — so {@link apply} rejects it outright; see
 * {@link apply} for why shadowing is not an acceptable form of selection here.
 * Named exports preserve loader injection metadata.
 * @module @deepseek-ai/dsh-tool-todo-tree
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ObjectValueSchemaSpec } from '@deepseek-ai/dsh-tools'
import type { TodoTreeItem } from './types.ts'

export type { TodoTreeItem } from './types.ts'

export const name = 'tool-todo-tree'
export const inject = ['tools']

/** The valid {@link TodoTreeItem} statuses, as a runtime set for input narrowing. */
const STATUSES = ['pending', 'in_progress', 'completed'] as const

/**
 * Nesting depth the advertised parameter schema spells out. The schema DSL has
 * no recursion, so the tool's JSON schema is a literal expansion to exactly
 * this many levels; it is a protocol constant of the model contract, not a
 * tunable. `Config.maxDepth` narrows the depth this tool ACCEPTS to at or
 * below it. The invariant companion enforces this constant, not `maxDepth`: it
 * validates durable snapshots from any producer, including logs written under a
 * different `maxDepth`, so it rejects only nesting past the protocol cap.
 */
export const SCHEMA_DEPTH = 3

/** Plugin config (all optional — `Config` supplies the defaults). */
export interface Config {
  /** Maximum accepted nesting depth (root nodes are depth 1). At most {@link SCHEMA_DEPTH}. */
  maxDepth?: number
}

export const Config: z<Config> = z.object({
  maxDepth: z.number().default(SCHEMA_DEPTH),
})

const DESCRIPTION =
  'Record and update a structured task tree for the current work. Send the ENTIRE '
  + 'tree every call — it REPLACES the previous tree (there are no partial updates, '
  + 'no per-item edits). Use it to plan multi-step work and show progress: one todo '
  + 'per concrete step, with `children` breaking a step into sub-steps. Keep AT MOST '
  + 'ONE todo `in_progress` across the WHOLE tree at a time; while work remains, '
  + 'exactly one node should be `in_progress`. Mark a todo `completed` the moment it '
  + 'is done (do not batch completions); a parent is `completed` only when all its '
  + 'children are. Skip the tree for trivial single-step tasks. Statuses: `pending` '
  + '(not started), `in_progress` (being worked on now), `completed` (finished).'

/** Shared leaf property specs. The compiler's circularity check tracks the
 * current ancestor path only, so reusing these consts across levels is legal;
 * sharing keeps the three literal levels from drifting apart. */
const CONTENT_PROP = {
  type: 'string', required: true, description: 'What the task is — a short imperative line.',
} as const
const STATUS_PROP = {
  type: 'string',
  required: true,
  enum: STATUSES,
  description: 'pending (not started) | in_progress (now) | completed (done).',
} as const
const CHILDREN_DESCRIPTION = 'Sub-tasks of this node, in display order. Omit when there are none.'
const LEAF_CHILDREN_DESCRIPTION = 'Must be empty or omitted: this is the deepest level the schema advertises.'

/**
 * The advertised node schema, spelled out literally to {@link SCHEMA_DEPTH}
 * levels. The schema DSL has no recursion ($ref), so the shape stops
 * describing nodes after the innermost level: its `children` is declared as an
 * untyped array, which documents the cap to the model and still accepts the
 * empty array every other level accepts. Enforcement of the cap is
 * {@link toTodoTree}'s depth check, not the schema. Literal consts (not a
 * builder function) so `defineTool` inference types `args.todos` as the real
 * node shape instead of collapsing to the wide spec type.
 */
/* jscpd:ignore-start -- the levels are deliberately identical: the DSL has no
   $ref, so the expansion IS the repetition, and clone detection cannot tell
   it apart from an accidental copy-paste */
const NODE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    content: CONTENT_PROP,
    status: STATUS_PROP,
    children: {
      type: 'array',
      description: CHILDREN_DESCRIPTION,
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          content: CONTENT_PROP,
          status: STATUS_PROP,
          children: {
            type: 'array',
            description: CHILDREN_DESCRIPTION,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                content: CONTENT_PROP,
                status: STATUS_PROP,
                // Declared, so `children: []` parses here as it does at every
                // other level — canonicalization strips an empty array, and
                // omitting the property only at the innermost level would make
                // the same leaf spelling depth-dependent. No `items`, because
                // there is no depth-4 node shape to describe; a non-empty array
                // here is rejected by `toTodoTree`'s depth check.
                children: { type: 'array', description: LEAF_CHILDREN_DESCRIPTION },
              },
            },
          },
        },
      },
    },
  },
} as const satisfies ObjectValueSchemaSpec
/* jscpd:ignore-end */

/** The raw node shape after registry validation of the literal schema. */
interface RawNode {
  content: string
  status: string
  children?: RawNode[]
}

/**
 * Validate the value constraints the ParameterSchemaSpec can't express and
 * build the canonical {@link TodoTreeItem}[]: trimmed non-empty content unique
 * within its sibling group, at most one in-progress node across the whole
 * tree, depth at most `maxDepth`, and empty `children` canonicalized to an
 * absent field. The registry has already enforced the status enum and the
 * schema-level depth cap; the cast below records that guarantee.
 */
function toTodoTree(raw: RawNode[], maxDepth: number): TodoTreeItem[] {
  let inProgress = 0
  const convert = (nodes: RawNode[], depth: number): TodoTreeItem[] => {
    if (depth > maxDepth) {
      throw new Error(`invalid todos: tree exceeds the configured maximum depth of ${maxDepth}`)
    }
    const seen = new Set<string>()
    const out: TodoTreeItem[] = []
    for (const node of nodes) {
      const content = node.content.trim()
      if (content.length === 0) {
        throw new Error('invalid todo: `content` must be a non-empty string')
      }
      if (seen.has(content)) {
        throw new Error(`invalid todos: duplicate sibling content ${JSON.stringify(content)}`)
      }
      seen.add(content)
      const status = node.status as TodoTreeItem['status']
      if (status === 'in_progress') inProgress++
      const children = node.children !== undefined && node.children.length > 0
        ? convert(node.children, depth + 1)
        : undefined
      if (status === 'completed' && children?.some(child => child.status !== 'completed')) {
        // The tool contract says a parent is completed only when all its
        // children are; accepting a completed parent over unfinished children
        // would make the returned counts and any UI progress disagree.
        throw new Error(
          `invalid todos: completed task ${JSON.stringify(content)} has unfinished children`,
        )
      }
      out.push({ content, status, ...children ? { children } : {} })
    }
    return out
  }
  const todos = convert(raw, 1)
  if (inProgress > 1) {
    throw new Error(`invalid todos: at most one task may be in_progress, got ${inProgress}`)
  }
  return todos
}

/** Count every node in the tree carrying `status`, at any depth. */
function countStatus(todos: TodoTreeItem[], status: TodoTreeItem['status']): number {
  let total = 0
  for (const todo of todos) {
    if (todo.status === status) total++
    if (todo.children) total += countStatus(todo.children, status)
  }
  return total
}

/**
 * Register the tree-shaped `todo_write` tool on `ctx.tools`.
 *
 * Refuses a scoped context. Shape selection between this package and
 * `@deepseek-ai/dsh-tool-todo` relies on the registry rejecting a duplicate
 * name, and that rejection is per layer: a scoped registration deliberately
 * SHADOWS a same-named global instead of colliding with it. Shadowing is a
 * legitimate mechanism for per-agent tool variants, but not for these two,
 * because the shape is not confined to the tool surface — each writes a
 * different durable session event. A shadow that is later disposed or
 * HMR-unloaded silently returns the agent to the global flat tool, so one
 * session's log ends up carrying both `todo/tree` and `todo/write` snapshots
 * with no record of which shape was authoritative when. Rejecting at load
 * keeps "exactly one shape per session" a property of the composition rather
 * than of registration order and fiber lifetime.
 * @param ctx - Cordis context carrying `ctx.tools`; must be unscoped.
 * @param config - validated plugin config (schemastery has filled every default).
 */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) !== undefined) {
    throw new Error('tool-todo-tree must mount on an unscoped context: a scoped registration shadows a global `todo_write` instead of colliding with it, so disposing it would silently return the agent to the flat tool and mix `todo/tree` and `todo/write` in one session log — disable the flat tool at the composition root instead')
  }
  // schemastery (Config) has already filled every defaulted field.
  const maxDepth = config.maxDepth as number
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > SCHEMA_DEPTH) {
    // The advertised schema spells out SCHEMA_DEPTH levels; accepting more
    // than it advertises (or a non-counting depth) would silently diverge the
    // model contract from enforcement. Fail at load, not at first call.
    throw new Error(`tool-todo-tree: maxDepth must be an integer between 1 and ${SCHEMA_DEPTH}`)
  }
  ctx.tools.register(defineTool({
    name: 'todo_write',
    description: DESCRIPTION,
    parameters: {
      todos: {
        type: 'array',
        required: true,
        description: 'The COMPLETE task tree, replacing any previous tree.',
        items: NODE_SCHEMA,
      },
    },
    /* jscpd:ignore-start -- the counts result shape deliberately mirrors the flat tool's model contract */
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          todos: { type: 'array', required: true, items: NODE_SCHEMA },
          counts: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              pending: { type: 'integer', required: true },
              inProgress: { type: 'integer', required: true },
              completed: { type: 'integer', required: true },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Updated todo tree: ${value.counts.pending} pending, ${value.counts.inProgress} in progress, ${value.counts.completed} completed.`,
      }],
    },
    /* jscpd:ignore-end */
    execute(args, exec) {
      const todos = toTodoTree(args.todos, maxDepth)
      if (!exec.agent) {
        // The tree is per-agent-session state; a non-agent caller (no owning
        // session) has nowhere to write it. Reject rather than silently no-op.
        throw new Error('todo_write requires an owning agent session')
      }
      const session = exec.agent.session
      // The load-time scoped-mount guard cannot see the mirror composition: the
      // FLAT tool mounted scoped over a global tree shadows this one, and
      // disposing that scope hands the agent back here mid-session. The
      // `./invariant` companion catches the mix too, but companions are opt-in
      // diagnostics that no shipped composition mounts, so refusing the append
      // here is what actually holds "one shape per session log" in production.
      if (session.events.some(event => event.type === 'todo/write')) {
        throw new Error('session already carries a flat todo/write list; a deployment must mount exactly one todo tool')
      }
      session.append('todo/tree', { todos })
      return Promise.resolve({
        todos,
        counts: {
          pending: countStatus(todos, 'pending'),
          inProgress: countStatus(todos, 'in_progress'),
          completed: countStatus(todos, 'completed'),
        },
      })
    },
    presentCall: args => ({ card: 'generic', title: 'Update todo tree', kind: 'other', rawInput: args.todos }),
  }))
}
