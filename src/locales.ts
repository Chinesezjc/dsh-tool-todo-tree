/** Copy owned by this plugin, in the two locales the shell ships. */

export const zh = {
  'row.title': '更新任务树',
  'row.completed': '{done}/{total} 已完成',
  'panel.title': '任务树',
  'panel.progress.done': '{done} 已完成',
  'panel.progress.active': '{active} 进行中',
  'panel.progress.pending': '{pending} 待处理',
} as const

export const en = {
  'row.title': 'Update todo tree',
  'row.completed': '{done}/{total} completed',
  'panel.title': 'Todo tree',
  'panel.progress.done': '{done} completed',
  'panel.progress.active': '{active} in progress',
  'panel.progress.pending': '{pending} pending',
} as const

/** Dictionary key domain of this plugin's namespace. */
export type TodoTreeKey = keyof typeof zh

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Nested todo plan copy. */
    todoTree: TodoTreeKey
  }
}
