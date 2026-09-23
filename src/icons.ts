/**
 * The shell icons this plugin renders, resolved by whichever name the installed
 * shell exports.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` renamed its icon exports between shell
 * revisions: the `*14` spellings this plugin was written against exist up to the
 * 0.1.6 train, and the 0.1.7 train ships `*Medium` instead. A named import of
 * either spelling fails to build against the other, and the same built bundle
 * runs in both — a plugin cannot pin a shell it does not ship. So the names are
 * looked up at load and the first one the shell provides is used.
 *
 * A shell that provides neither renders the surrounding text without the icon
 * rather than failing the whole browser half: the icons are decoration, and a
 * missing glyph must not take the plan strip down with it.
 * @module
 */
import * as primitives from '@deepseek-ai/dsh-client-ui-primitives'
import type { ReactNode } from 'react'

/** Props both icon generations accept. */
interface IconProps {
  size?: number
  className?: string
}

/** The shape every icon export shares, whichever generation names it. */
export type IconComponent = (props: IconProps) => ReactNode

/**
 * Pick the first provided icon name, or a placeholder that renders nothing.
 *
 * Exported for its own tests: the resolver is the part that has to survive a
 * shell rename, and it can be exercised with plain lookup tables instead of a
 * mounted component tree.
 * @param source - the shell's exports, keyed by export name.
 * @param names - candidate export names, newest generation first.
 * @returns the icon the shell provides, or the placeholder.
 */
export function resolveIcon(source: Record<string, unknown>, ...names: readonly string[]): IconComponent {
  for (const name of names) {
    const candidate = source[name]
    if (typeof candidate === 'function') return candidate as IconComponent
  }
  return () => null
}

/** The installed shell's exports: the shell's generation decides which names exist. */
const exported: Record<string, unknown> = { ...primitives }

/** Plan-strip and row checklist glyph. */
export const ChecklistIcon: IconComponent = resolveIcon(
  exported,
  'IconChecklistOutlineMedium',
  'IconChecklistOutline14',
)

/** Expand control for a collapsed plan strip. */
export const ChevronDownIcon: IconComponent = resolveIcon(
  exported,
  'IconChevronDownOutlineMedium',
  'IconChevronDownOutline14',
)

/** Collapse control for an expanded plan strip. */
export const ChevronUpIcon: IconComponent = resolveIcon(
  exported,
  'IconChevronUpOutlineMedium',
  'IconChevronUpOutline14',
)
