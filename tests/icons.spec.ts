/**
 * The icon-name lookup, exercised as a plain table: this is the part that has to
 * survive a shell that renames its icon exports, and the three outcomes are
 * "current name", "the 0.1.6 name", and "neither, render nothing".
 */
import { describe, expect, it } from 'vitest'
import { resolveIcon } from '../src/icons.ts'

const current = () => 'current'
const previous = () => 'previous'

describe('resolveIcon', () => {
  it('prefers the current generation name', () => {
    expect(resolveIcon({ IconChecklistOutlineMedium: current, IconChecklistOutline14: previous },
      'IconChecklistOutlineMedium', 'IconChecklistOutline14')).toBe(current)
  })

  it('falls back to the name a 0.1.6 shell ships', () => {
    expect(resolveIcon({ IconChecklistOutline14: previous },
      'IconChecklistOutlineMedium', 'IconChecklistOutline14')).toBe(previous)
  })

  it('renders nothing when the shell provides neither name', () => {
    const placeholder = resolveIcon({}, 'IconChecklistOutlineMedium', 'IconChecklistOutline14')
    expect(placeholder({})).toBeNull()
  })

  it('ignores a non-function export of the wanted name', () => {
    expect(resolveIcon({ IconChecklistOutlineMedium: 'not-an-icon', IconChecklistOutline14: previous },
      'IconChecklistOutlineMedium', 'IconChecklistOutline14')).toBe(previous)
  })
})
