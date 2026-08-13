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
