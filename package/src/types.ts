/**
 * Nested todo vocabulary: the tree item type and the `todo/tree` session event.
 * This package owns both — the flat `TodoItem`/`todo/write` pair stays in
 * `dsh-session` untouched, so flat consumers never see tree snapshots and the
 * log records which shape produced each entry.
 * @module @deepseek-ai/dsh-tool-todo-tree/types
 */

/**
 * One node in an agent's nested todo tree — the unit of the `todo/tree`
 * session event's whole-tree snapshot.
 *
 * Same deliberate minimalism as the flat `TodoItem`: a human-readable
 * `content` line and a three-state `status`, plus optional `children` for
 * sub-tasks. No id — the tree is replaced wholesale on every write
 * (last-write-wins), so nodes need no stable identity. A canonical node
 * never carries an empty `children` array: childless nodes omit the field.
 */
export interface TodoTreeItem {
  /** What this task is — a short imperative line shown in the UI. */
  content: string
  /** Lifecycle state. `in_progress` marks the single node being worked now, anywhere in the tree. */
  status: 'pending' | 'in_progress' | 'completed'
  /** Sub-tasks of this node, in display order. Absent (never `[]`) on childless nodes. */
  children?: TodoTreeItem[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /**
     * Whole-tree snapshot; latest write wins on replay. Log-only UI state;
     * never derived history. Distinct from the flat `todo/write` so flat and
     * tree consumers never misread each other's shape.
     */
    'todo/tree': { todos: TodoTreeItem[] }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * The agent's current whole todo tree (the latest `todo/tree` snapshot),
     * or `null` before the first write. Whole-value rule: every `todo/tree`
     * carries the complete replacement tree, so the fold is last-wins.
     *
     * A key of its own rather than the flat tool's `todos`: the two payload
     * types differ (`children` is absent from `TodoItem`), and a deployment
     * mounting the flat tool must not have its `todos` consumers handed a
     * nested value they cannot render. Exactly one of the two keys exists in
     * any composition, because exactly one todo tool mounts.
     */
    todoTree: TodoTreeItem[] | null
  }
}
