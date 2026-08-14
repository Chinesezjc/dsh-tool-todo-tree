import { defineConfig } from 'vitest/config'

// The specs import this package by its own name (the same specifiers a consumer
// uses), so map those to source instead of the built lib.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-tool-todo-tree$/, replacement: new URL('src/index.ts', import.meta.url).pathname },
      { find: /^@deepseek-ai\/dsh-tool-todo-tree\/invariant$/, replacement: new URL('src/invariant.ts', import.meta.url).pathname },
      { find: /^@deepseek-ai\/dsh-tool-todo-tree\/types$/, replacement: new URL('src/types.ts', import.meta.url).pathname },
      { find: /^@deepseek-ai\/dsh-tool-todo-tree\/client$/, replacement: new URL('src/client.ts', import.meta.url).pathname },
    ],
  },
})
