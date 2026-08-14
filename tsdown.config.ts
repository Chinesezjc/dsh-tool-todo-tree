/**
 * Standalone build for dsh-tool-todo-tree. Emits the four entry points plus
 * their type declarations from `src/` alone, with every `@deepseek-ai/*` package
 * left unbundled — the harness profile the plugin is installed into provides them
 * through its own node_modules. `zod` is a real dependency and is bundled,
 * because the projection schema is validated at runtime.
 *
 * `prepare` runs this after a git install, so it must not assume a sibling
 * monorepo checkout, project references, or a type-check pass.
 *
 * `.js`, not tsdown's default `.mjs`: the exports map and the package's own
 * `"type": "module"` name `lib/index.js`, and a profile resolving the bare row
 * `dsh-tool-todo-tree` goes through that map.
 */
import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/invariant.ts',
    'src/types.ts',
    'src/client.ts',
  ],
  outDir: 'lib',
  format: 'esm',
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  platform: 'node',
  target: 'node22',
  dts: true,
  deps: { neverBundle: [/^@deepseek-ai\//] },
  sourcemap: false,
  clean: true,
})
