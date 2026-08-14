/**
 * Pure derivation shared by the two browser surfaces.
 *
 * Both read plans that are NOT validated: the row reads a call's `argsRaw`
 * (arbitrary model JSON, retained verbatim even when `execute` rejected it) and
 * the panel reads a projection that may come from a log this build did not
 * write. Every walk here is therefore iterative — `JSON.parse` accepts nesting
 * far deeper than the call stack survives, and a recursive walk would turn one
 * malformed plan into a RangeError that takes the whole conversation render
 * down.
 * @module
 */

/** One plan node as the browser sees it: any field may be missing or mistyped. */
export interface PlanNodeLike {
  content?: unknown
  status?: unknown
  children?: unknown
}

/** A node paired with the nesting depth it renders at (roots are depth 0). */
export interface PlanRow {
  content: string
  status: 'pending' | 'in_progress' | 'completed' | 'unknown'
  depth: number
}

const STATUSES = new Set(['pending', 'in_progress', 'completed'])

function isNode(value: unknown): value is PlanNodeLike {
  return typeof value === 'object' && value !== null
}

/**
 * Flatten a plan into display-ordered rows carrying their depth.
 *
 * A flat plan has no `children` and yields only depth-0 rows, so the flat tool's
 * snapshots render exactly as they would without this package. A malformed
 * `children` (present but not an array of nodes) contributes nothing rather than
 * discarding its ancestors: a mid-stream `argsRaw` routinely carries a partial
 * tail, and the countable part is still worth showing.
 * @param roots - the top-level nodes, in model order.
 * @returns one row per node, parents before their own children.
 */
export function planRows(roots: readonly PlanNodeLike[]): PlanRow[] {
  const rows: PlanRow[] = []
  // Children push in reverse so the leftmost pops first: display order is what
  // decides which node the summary names.
  const stack: { node: PlanNodeLike, depth: number }[] = [...roots].reverse().map(node => ({ node, depth: 0 }))
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    const { node, depth } = item
    rows.push({
      content: typeof node.content === 'string' ? node.content : '',
      status: typeof node.status === 'string' && STATUSES.has(node.status)
        ? node.status as PlanRow['status']
        : 'unknown',
      depth,
    })
    const children = node.children
    if (Array.isArray(children) && children.every(isNode)) {
      for (const child of [...children].reverse()) stack.push({ node: child, depth: depth + 1 })
    }
  }
  return rows
}

/** Per-status totals over every depth, plus the first active node's name. */
export interface PlanSummary {
  done: number
  active: number
  pending: number
  total: number
  /** First `in_progress` content in display order, or null when none is usable. */
  activeContent: string | null
  /** Active nodes beyond the first; 0 when there is no `activeContent`. */
  activeExtra: number
}

/**
 * Summarize a flattened plan. Counts span every depth, so a nested plan reports
 * its whole tree rather than its roots — a top-level-only count disagrees with
 * what the model wrote and with what the panel lists.
 * @param rows - the flattened plan, in display order.
 * @returns the per-status counts and the active-node summary.
 */
export function summarize(rows: readonly PlanRow[]): PlanSummary {
  const activeRows = rows.filter(row => row.status === 'in_progress')
  const first = activeRows[0]?.content.trim()
  const named = first !== undefined && first !== ''
  return {
    done: rows.filter(row => row.status === 'completed').length,
    active: activeRows.length,
    pending: rows.filter(row => row.status === 'pending').length,
    total: rows.length,
    activeContent: named ? first : null,
    activeExtra: named ? activeRows.length - 1 : 0,
  }
}

/**
 * Parse a tool call's raw arguments into plan rows.
 * @param argsRaw - the call's argument JSON, possibly truncated mid-stream.
 * @returns the flattened rows, or null when the value carries no usable plan.
 */
export function rowsFromArgs(argsRaw: string): PlanRow[] | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(argsRaw)
  } catch {
    // Mid-stream truncation or malformed model JSON.
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const todos = (parsed as { todos?: unknown }).todos
  if (!Array.isArray(todos) || !todos.every(isNode)) return null
  return planRows(todos)
}
