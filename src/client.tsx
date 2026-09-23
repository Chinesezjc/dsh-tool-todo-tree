/**
 * Browser half of dsh-tool-todo-tree: the plan strip and the `todo_tree_write`
 * row that render the NESTED shape this package's host half writes.
 *
 * Both contributions go through `ctx.slots.inject`, which waits for the owning
 * declaration instead of assuming apply order, and both ride `ctx.effect` so a
 * fiber dispose removes them. Nothing here imports another plugin's internals:
 * the components are this package's own, and the only framework imports are
 * platform modules.
 * @module @deepseek-ai/dsh-tool-todo-tree/client
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the two slots this plugin contributes to are declared by these
// packages' SlotMap merges. Importing the types costs no runtime edge, which is
// what the client-bundle purity rule constrains — neither package is a platform
// module, so a VALUE import of either would be rejected.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
// Type-only: the `todoTree` projection-key merge this package's host half
// declares. The panel reads that key, so the browser program needs the merge
// without importing any host value.
import type {} from './types.ts'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { TodoTreePanel } from './TodoTreePanel.tsx'
import { TodoTreeRow } from './TodoTreeRow.tsx'
import { en, zh } from './locales.ts'

export { TodoTreePanel } from './TodoTreePanel.tsx'
export { TodoTreeRow } from './TodoTreeRow.tsx'
export { planRows, rowsFromArgs, summarize } from './plan.ts'
export type { PlanNodeLike, PlanRow, PlanSummary } from './plan.ts'
export type { TodoTreeKey } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'todoTree'

/** Full props of the dock entry: the slot's owner share plus the locale seat. */
type TodoTreeDockProps = PropsRuntime<'conversation.input.dock'> & PropsLocale<'todoTree'>

/** Services this plugin reads. */
export const inject = ['slots', 'locale']

/**
 * Register the strip and the row.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'tool-todo-tree: dictionaries')

  ctx.effect(() => ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'todo-tree',
    // After the flat strip's entry so a deployment mounting both todo tools
    // keeps a stable order; each strip renders only from its own tool's data.
    order: 1,
    locale: NS,
  }, TodoTreeDock)), 'tool-todo-tree: plan strip')

  // The key is this package's own tool name, so the row occupies its own keyed
  // cell: nothing shadows the built-in flat row, and the default priority keeps
  // a second mount of this plugin loud instead of silently replacing the first.
  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'todo_tree_write',
    locale: NS,
  }, TodoTreeRow)), 'tool-todo-tree: todo_tree_write row')
}

/**
 * Dock adapter: reads the `todoTree` projection the host half publishes. A
 * composition without that half has no such key, and the strip renders nothing.
 * @param props - the dock owner share plus the locale seat.
 * @returns the strip.
 */
function TodoTreeDock({ useProjection, t }: TodoTreeDockProps) {
  const todos = useProjection('todoTree')
  return <TodoTreePanel todos={todos ?? []} t={t} />
}
