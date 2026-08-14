/**
 * The plan strip: one indented row per node at every depth, above the composer.
 * Reads the `todoTree` projection this package's host half publishes, so it
 * renders the DURABLE tree rather than one call's arguments.
 * @module
 */
import { useState } from 'react'
import {
  IconChecklistOutline14,
  IconChevronDownOutline14,
  IconChevronUpOutline14,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PlanRow } from './plan.ts'
import { planRows, summarize, type PlanNodeLike } from './plan.ts'
import css from './todo-tree.module.css'

import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
// Pulls the LocaleNamespaceMap merge that names this plugin's namespace.
import type {} from './locales.ts'

/** Translate seat for this plugin's namespace, derived from its dictionary. */
type Translate = TranslateNS<'todoTree'>

export interface TodoTreePanelProps {
  /** The session's standing plan; empty renders nothing. */
  todos: readonly PlanNodeLike[]
  t: Translate
}

function StatusGlyph({ status }: { status: PlanRow['status'] }) {
  if (status === 'completed') {
    return (
      <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.completed}>
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" />
        <path d="M3.6 7.2 5.9 9.4l4.5-4.6" stroke="currentColor" strokeWidth="1.3" fill="none" />
      </svg>
    )
  }
  if (status === 'in_progress') {
    return (
      <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.active}>
        <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" opacity="0.35" />
        <path d="M7 0.6a6.4 6.4 0 0 1 6.4 6.4" stroke="currentColor" strokeWidth="1.3" fill="none" />
      </svg>
    )
  }
  // `pending` and the unknown arm share the unstarted ring: a status this build
  // does not know is still a node the model wrote, so it is listed rather than
  // dropped or guessed into another state.
  return (
    <svg width={14} height={14} viewBox="0 0 14 14" fill="none" aria-hidden="true" className={css.pending}>
      <circle cx="7" cy="7" r="6.4" stroke="currentColor" strokeWidth="1.2" strokeDasharray="2.4 2.4" />
    </svg>
  )
}

/** Per-status counts joined with a separator; zero-count segments are omitted. */
function progressLabel(rows: readonly PlanRow[], t: Translate): string {
  const { done, active, pending } = summarize(rows)
  return [
    ...done > 0 ? [t('panel.progress.done', { done })] : [],
    ...active > 0 ? [t('panel.progress.active', { active })] : [],
    ...pending > 0 ? [t('panel.progress.pending', { pending })] : [],
  ].join('\u2002·\u2002')
}

/**
 * The strip. Collapsed by default so a long tree cannot push the composer down;
 * the header always carries the counts.
 * @param props - the standing plan and the locale seat.
 * @returns the strip, or null while the plan is empty.
 */
export function TodoTreePanel({ todos, t }: TodoTreePanelProps) {
  const [collapsed, setCollapsed] = useState(true)
  if (todos.length === 0) return null
  const rows = planRows(todos)

  return (
    <section className={css.strip} data-testid="todo-tree-panel" aria-label={t('panel.title')}>
      <button
        type="button"
        className={css.header}
        aria-expanded={!collapsed}
        onClick={() => { setCollapsed(value => !value) }}
      >
        <span className={css.lead} aria-hidden><IconChecklistOutline14 /></span>
        <span className={css.title}>{t('panel.title')}</span>
        <span className={css.progress}>{progressLabel(rows, t)}</span>
        <span className={css.chevron} aria-hidden>
          {collapsed ? <IconChevronUpOutline14 /> : <IconChevronDownOutline14 />}
        </span>
      </button>
      {!collapsed && (
        <ul className={css.list}>
          {rows.map((row, index) => (
            // Content is unique only among siblings, so the index carries the
            // identity a repeated child name would otherwise collide on.
            <li
              key={`${String(index)}:${row.content}`}
              className={row.status === 'completed' ? `${css.item} ${css.done}` : css.item}
              data-status={row.status}
              data-depth={row.depth}
              style={{ '--dsw-todo-tree-depth': row.depth } as React.CSSProperties}
            >
              <span className={css.glyph} aria-hidden><StatusGlyph status={row.status} /></span>
              <span className={css.content}>{row.content}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
