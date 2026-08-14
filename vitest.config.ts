import { defineConfig } from 'vitest/config'

// The host specs import this package by its own name (the same specifiers a
// consumer uses), so map those to source instead of the built lib.
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@deepseek-ai\/dsh-tool-todo-tree$/, replacement: new URL('src/index.ts', import.meta.url).pathname },
      { find: /^@deepseek-ai\/dsh-tool-todo-tree\/invariant$/, replacement: new URL('src/invariant.ts', import.meta.url).pathname },
      { find: /^@deepseek-ai\/dsh-tool-todo-tree\/types$/, replacement: new URL('src/types.ts', import.meta.url).pathname },
      { find: /^@deepseek-ai\/dsh-tool-todo-tree\/client$/, replacement: new URL('src/client.tsx', import.meta.url).pathname },
      // `ui-primitives` imports katex's plain stylesheet for its math renderer.
      // Node cannot load a `.css` specifier, and nothing under test reads those
      // styles, so the import resolves to an empty module.
      // Plain stylesheets only (NOT `*.module.css`, which Vite compiles to the
      // class map the components read): `ui-primitives` imports katex's sheet for
      // its math renderer, and Node cannot load a `.css` specifier.
      { find: /^katex\/.*\.css$/, replacement: new URL('tests/empty-style.ts', import.meta.url).pathname },
    ],
  },
  test: {
    // `ui-primitives` ships ESM that imports katex's plain stylesheet. Vitest
    // externalizes node_modules by default, so Node resolves that `.css`
    // specifier and throws; inlining routes the package through Vite, where the
    // alias above turns the stylesheet into an empty module.
    server: { deps: { inline: [/@deepseek-ai\/dsh-client-/] } },
  },
  css: {
    // The browser specs render components that import a CSS Module; Vite hands
    // them the class map so assertions can address rows by their data
    // attributes rather than by hashed class names.
    modules: { classNameStrategy: 'non-scoped' },
  },
})
