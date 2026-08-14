/**
 * Browser half of dsh-tool-todo-tree: the plan strip and the `todo_write` row
 * that render the NESTED shape this package's host half writes.
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

/**
 * Shadowing rank for the keyed `todo_write` toolview. The built-in flat row
 * registers at the default 0, and a keyed slot rejects a second entry at the
 * SAME priority; a lower number renders instead. -1 is therefore the documented
 * way to replace that row from outside the package that owns it.
 */
const SHADOW_PRIORITY = -1

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
    // After the flat strip's entry so a composition that somehow mounted both
    // tools keeps a stable order; only one of the two ever has data.
    order: 1,
    locale: NS,
  }, TodoTreeDock)), 'tool-todo-tree: plan strip')

  ctx.effect(() => ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'todo_write',
    priority: SHADOW_PRIORITY,
    locale: NS,
  }, TodoTreeRow)), 'tool-todo-tree: todo_write row')
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
