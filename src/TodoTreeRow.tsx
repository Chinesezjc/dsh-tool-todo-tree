/**
 * The `todo_write` tool row, registered on the keyed toolview slot at a lower
 * priority than the built-in flat row so it shadows it (lowest renders).
 *
 * It reads the call's own `argsRaw` rather than the projection: a row belongs to
 * one call in the transcript, including calls that were rejected or superseded,
 * and the projection only carries the latest accepted tree.
 * @module
 */
import { IconChecklistOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import { rowsFromArgs, summarize } from './plan.ts'
import css from './todo-tree.module.css'

import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Pulls the SlotMap merge declaring the keyed toolview slot, and the
// LocaleNamespaceMap merge naming this plugin's namespace. Both are type-only.
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from './locales.ts'

/**
 * Full props of the registered row: the keyed slot's owner share plus the locale
 * seat. Derived rather than hand-written, so the row accepts exactly what the
 * slot runtime passes; the type edge is type-only, which is what the client
 * bundle allows for a non-platform package.
 */
export type TodoTreeRowProps = PropsRuntime<'tool.call.toolview', 'todo_write'> & PropsLocale<'todoTree'>

/**
 * One-line summary of the tree a call wrote: completion counts over every depth,
 * then the first active node's name.
 * @param props - the tool call block and the locale seat.
 * @returns the row.
 */
export function TodoTreeRow({ block, t }: TodoTreeRowProps) {
  const argsRaw = ('call' in block ? block.call?.argsRaw : block.argsRaw) ?? ''
  const rows = rowsFromArgs(argsRaw)
  const summary = rows === null ? null : summarize(rows)
  const head = summary === null ? '' : t('row.completed', { done: summary.done, total: summary.total })
  const tail = summary?.activeContent === null || summary === null ? '' : ` · ${summary.activeContent}`

  return (
    <div className={css.row} data-testid="todo-tree-row">
      <span className={css.lead} aria-hidden><IconChecklistOutline14 /></span>
      <span className={css.title}>{t('row.title')}</span>
      <span className={css.progress}>
        {head}
        {tail}
      </span>
      {summary !== null && summary.activeExtra > 0 && (
        <span className={css.chevron} data-testid="todo-tree-row-extra">{`+${String(summary.activeExtra)}`}</span>
      )}
    </div>
  )
}
