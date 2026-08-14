// @vitest-environment jsdom
/**
 * Browser-half acceptance: the plan derivation both surfaces share, the strip
 * that lists every depth, and the row that summarizes one call's arguments.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { TodoTreePanel } from '../src/TodoTreePanel.tsx'
import { TodoTreeRow } from '../src/TodoTreeRow.tsx'
import { planRows, rowsFromArgs, summarize } from '../src/plan.ts'
import { zh } from '../src/locales.ts'

afterEach(cleanup)

/** Minimal interpolating translate over this plugin's own zh dictionary. */
const t = ((key: string, vars?: Record<string, string | number>) => {
  const template: string = zh[key as keyof typeof zh] ?? key
  return template.replace(/\{(\w+)\}/g, (_match, name: string) => String(vars?.[name] ?? ''))
}) as never

const NESTED = [{
  content: '实现修复',
  status: 'in_progress',
  children: [
    { content: '读代码', status: 'completed' },
    { content: '改模块', status: 'pending', children: [{ content: '改函数', status: 'pending' }] },
  ],
}]

describe('planRows', () => {
  it('flattens depth-first with each node carrying its depth', () => {
    expect(planRows(NESTED).map(row => [row.content, row.depth])).toEqual([
      ['实现修复', 0], ['读代码', 1], ['改模块', 1], ['改函数', 2],
    ])
  })

  it('treats a flat plan as the depth-0 case', () => {
    expect(planRows([{ content: 'a', status: 'pending' }])).toEqual([
      { content: 'a', status: 'pending', depth: 0 },
    ])
  })

  it('keeps a node whose status this build does not know, marked unknown', () => {
    // A forged or newer status is still a node the model wrote; dropping it would
    // under-report the plan, and guessing a status would misreport it.
    expect(planRows([{ content: 'x', status: 'archived' }])[0]).toEqual({
      content: 'x', status: 'unknown', depth: 0,
    })
  })

  it('ignores a malformed children field without losing its ancestors', () => {
    expect(planRows([
      { content: 'a', status: 'completed', children: 'nope' },
      { content: 'b', status: 'completed', children: [null] },
    ]).map(row => row.content)).toEqual(['a', 'b'])
  })

  it('survives nesting far deeper than the call stack', () => {
    // `execute` rejects over-deep trees, but a rejected call keeps its arguments
    // verbatim and the row still renders them, so the walk must not recurse.
    let node: Record<string, unknown> = { content: 'leaf', status: 'completed' }
    for (let i = 0; i < 200_000; i++) node = { content: `n${String(i)}`, status: 'pending', children: [node] }
    expect(planRows([node])).toHaveLength(200_001)
  })
})

describe('summarize', () => {
  it('counts every depth and names the first active node in display order', () => {
    expect(summarize(planRows(NESTED))).toEqual({
      done: 1, active: 1, pending: 2, total: 4, activeContent: '实现修复', activeExtra: 0,
    })
  })

  it('reports the extra active count beyond the first', () => {
    const rows = planRows([
      { content: '父', status: 'pending', children: [{ content: '子先跑', status: 'in_progress' }] },
      { content: '后面的根', status: 'in_progress' },
    ])
    expect(summarize(rows)).toMatchObject({ activeContent: '子先跑', activeExtra: 1 })
  })

  it('has no active name when the first active node has blank content', () => {
    expect(summarize(planRows([{ content: '   ', status: 'in_progress' }])))
      .toMatchObject({ activeContent: null, activeExtra: 0 })
  })
})

describe('rowsFromArgs', () => {
  it('parses a nested plan out of call arguments', () => {
    expect(rowsFromArgs(JSON.stringify({ todos: NESTED }))).toHaveLength(4)
  })

  it('returns null for a truncated or shapeless value', () => {
    expect(rowsFromArgs('{"todos":[{"content"')).toBeNull()
    expect(rowsFromArgs('null')).toBeNull()
    expect(rowsFromArgs('{"todos":"nope"}')).toBeNull()
  })
})

describe('TodoTreePanel', () => {
  it('renders nothing while the plan is empty', () => {
    render(<TodoTreePanel todos={[]} t={t} />)
    expect(screen.queryByTestId('todo-tree-panel')).toBeNull()
  })

  it('starts collapsed with the per-status counts over every depth', () => {
    render(<TodoTreePanel todos={NESTED} t={t} />)
    expect(screen.getByRole('button', { expanded: false })).toBeTruthy()
    // A top-level-only count would read "1 进行中" alone and hide the children.
    // Matched by segment because Testing Library normalizes the en-space joiner.
    expect(screen.getByText(/1 已完成.*1 进行中.*2 待处理/)).toBeTruthy()
    expect(screen.queryByText('读代码')).toBeNull()
  })

  it('expands to one indented row per node', () => {
    render(<TodoTreePanel todos={NESTED} t={t} />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByRole('listitem').map(row => [row.textContent, row.dataset.depth])).toEqual([
      ['实现修复', '0'], ['读代码', '1'], ['改模块', '1'], ['改函数', '2'],
    ])
  })

  it('keeps repeated child names as separate rows', () => {
    // Content is unique only among siblings, so the same name recurs across groups.
    render(<TodoTreePanel
      todos={[
        { content: 'A', status: 'pending', children: [{ content: '跑测试', status: 'pending' }] },
        { content: 'B', status: 'pending', children: [{ content: '跑测试', status: 'pending' }] },
      ]}
      t={t}
    />)
    fireEvent.click(screen.getByRole('button'))
    expect(screen.getAllByText('跑测试')).toHaveLength(2)
    expect(screen.getAllByRole('listitem')).toHaveLength(4)
  })

  it('omits zero-count segments and keeps the done count alone', () => {
    render(<TodoTreePanel todos={[{ content: '都完了', status: 'completed' }]} t={t} />)
    expect(screen.getByText('1 已完成')).toBeTruthy()
    expect(screen.queryByText(/进行中|待处理/)).toBeNull()
  })
})

/** The row reads whichever of the two block forms the transcript supplies. */
function rowProps(argsRaw: string, settled = true) {
  const block = settled ? { call: { argsRaw } } : { argsRaw }
  return { block, t } as unknown as Parameters<typeof TodoTreeRow>[0]
}

describe('TodoTreeRow', () => {
  it('summarizes counts over every depth and names the active node', () => {
    render(<TodoTreeRow {...rowProps(JSON.stringify({ todos: NESTED }))} />)
    expect(screen.getByTestId('todo-tree-row').textContent).toContain('1/4 已完成')
    expect(screen.getByTestId('todo-tree-row').textContent).toContain('实现修复')
  })

  it('reads a running call\u2019s own args form', () => {
    render(<TodoTreeRow {...rowProps(JSON.stringify({ todos: NESTED }), false)} />)
    expect(screen.getByTestId('todo-tree-row').textContent).toContain('1/4 已完成')
  })

  it('carries the extra active count in its own element', () => {
    render(<TodoTreeRow {...rowProps(JSON.stringify({
      todos: [
        { content: 'a', status: 'in_progress' },
        { content: 'b', status: 'in_progress', children: [{ content: 'c', status: 'in_progress' }] },
      ],
    }))} />)
    expect(screen.getByTestId('todo-tree-row-extra').textContent).toBe('+2')
  })

  it('renders the title with no counts when the args carry no usable plan', () => {
    render(<TodoTreeRow {...rowProps('{"todos":[{"content"')} />)
    const row = screen.getByTestId('todo-tree-row')
    expect(row.textContent).toContain('更新任务树')
    expect(row.textContent).not.toContain('已完成')
    expect(screen.queryByTestId('todo-tree-row-extra')).toBeNull()
  })
})
