/**
 * Contract of the stylesheet's custom-property usage.
 *
 * A CSS custom property that no theme defines is not an error anywhere in the
 * toolchain: the declaration using it is dropped by the browser and the element
 * simply renders without that border or background. Typecheck, the component
 * specs and the bundle assertions all stay green, because none of them resolves
 * a token against a live theme. This file is the only place that can catch it,
 * so it pins the token names to the set read back from a running page.
 *
 * Shipped revisions styled the card with `--dsw-alias-line-secondary` and
 * `--dsw-alias-fill-surface-l2`; ui-theme defines neither, so the strip rendered
 * with no border and a transparent background while its labels kept their color.
 * Both names are listed as forbidden below so the regression cannot come back.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('../src/todo-tree.module.css', import.meta.url), 'utf8')

/** Every custom property this stylesheet may read, verified to resolve on a live
 *  page's composer dock (the seat this plugin's strip mounts into). Adding a
 *  token here requires reading it back from a running page first. */
const ALLOWED = new Set([
  // Theme aliases (ui-theme).
  '--dsw-alias-border-l1',
  '--dsw-specific-tip',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-label-caption',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-scrollbar-bg-l2',
  '--dsw-alias-scrollbar-hover-l2',
  // Composer dock geometry, published by the shell's conversation skeleton.
  '--dsh-composer-side-clearance',
  '--dsh-composer-dock-inset',
  '--dsh-composer-card-max-width',
  // Scrollbar rebinding contract: declared BY this sheet, read by the shell.
  '--dsh-scrollbar-thumb',
  '--dsh-scrollbar-thumb-hover',
  // This plugin's own depth variable, set inline per row by the panel.
  '--dsw-todo-tree-depth',
])

/** Names that shipped broken; a theme defines none of them. */
const FORBIDDEN = ['--dsw-alias-line-secondary', '--dsw-alias-fill-surface-l2', '--dsw-alias-fill-l2']

describe('todo-tree stylesheet custom properties', () => {
  it('reads only custom properties verified to resolve on a live page', () => {
    const used = [...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].flatMap(m => m[1] ?? [])
    expect(used.length).toBeGreaterThan(0)
    const unknown = [...new Set(used)].filter(name => !ALLOWED.has(name))
    expect(unknown).toEqual([])
  })

  it('declares every custom property it defines for the shell', () => {
    // The scrollbar contract is a declaration, not a read; keep it spelled out
    // so removing it fails here rather than silently dropping the thumb styling.
    expect(css).toContain('--dsh-scrollbar-thumb:')
    expect(css).toContain('--dsh-scrollbar-thumb-hover:')
  })

  it('never uses a token this project shipped broken', () => {
    // Whole-name match: `--dsw-alias-fill-l2` is a prefix of
    // `--dsw-alias-fill-surface-l2`, so a substring check would conflate the two
    // and report a hit for a name the sheet does not actually read.
    const used = new Set([...css.matchAll(/var\(\s*(--[a-z0-9-]+)/g)].flatMap(m => m[1] ?? []))
    for (const name of FORBIDDEN) expect(used.has(name)).toBe(false)
  })

  it('carries the card surface the flat strip uses, so the two align', () => {
    // The strip must be a card: border + radius + an opaque surface. Losing any
    // of the three is exactly how the broken revision read as loose text.
    expect(css).toMatch(/border:\s*1px solid var\(--dsw-alias-border-l1\)/)
    expect(css).toMatch(/border-radius:\s*12px/)
    expect(css).toMatch(/background:\s*var\(--dsw-specific-tip\)/)
  })

  it('keeps the depth inset that is this plugin whole reason to exist', () => {
    expect(css).toMatch(/padding-inline-start:\s*calc\(var\(--dsw-todo-tree-depth,\s*0\)\s*\*\s*18px\)/)
  })

  it('does not rely on `composes`, which this bundler does not expand', () => {
    // Verified against the built artifact: a composed class ships without the
    // borrowed declarations, so the rule silently loses its layout.
    expect(css).not.toContain('composes:')
  })
})
