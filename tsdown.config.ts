/**
 * Standalone build for dsh-tool-todo-tree.
 *
 * Two artifact families with different rules:
 *
 * - Host half (`index`, `invariant`, `types`): plain Node ESM. Every
 *   `@deepseek-ai/*` package stays unbundled — the harness profile provides them.
 * - Browser half (`client`): the plugin the web shell loads. React, cordis, and
 *   the client packages come from the shell's module table, so they stay
 *   unbundled too; the CSS Module compiles to a class map plus a self-injecting
 *   style tag, because the shell serves one JS artifact per plugin and fetches no
 *   sidecar stylesheet.
 *
 * `zod` is bundled: it is a real dependency and the projection schema validates
 * at runtime.
 *
 * `prepare` runs this after a git install, so it must not assume a sibling
 * monorepo checkout, project references, or a type-check pass.
 *
 * `.js`, not tsdown's default `.mjs`: the exports map and the package's own
 * `"type": "module"` name `lib/index.js`, and a profile resolving the bare row
 * `dsh-tool-todo-tree` goes through that map.
 */
import { readFileSync } from 'node:fs'
import { basename, dirname, resolve } from 'node:path'
import { defineConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Plugin id: the loader handoff key and the style-tag marker. Must equal the package name the shell rosters. */
const PLUGIN_ID = 'dsh-tool-todo-tree'

/** Packages the harness or the web shell provides at runtime. */
const PROVIDED = [/^@deepseek-ai\//, /^react(\/|$)/, /^react-dom(\/|$)/]

/**
 * Compile `*.module.css` to a hashed class map plus a self-injecting style tag.
 *
 * tsdown runs no CSS pipeline here, and the browser bundle must carry its own
 * styles because the shell loads exactly one module per plugin.
 *
 * The resolved id is wrapped so it does NOT end in `.css`: tsdown's own
 * css-guard matches that suffix and fails the build demanding `@tsdown/css`,
 * before this plugin's `load` ever runs.
 * @returns the rolldown plugin.
 */
function cssModules() {
  const SUFFIX = '.module.css'
  const VIRTUAL_PREFIX = '\0todo-tree-css:'
  const VIRTUAL_SUFFIX = '.mjs'
  return {
    name: 'todo-tree-css-modules',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(SUFFIX) || importer === undefined) return null
      return VIRTUAL_PREFIX + resolve(dirname(importer), source) + VIRTUAL_SUFFIX
    },
    load(virtualId: string) {
      if (!virtualId.startsWith(VIRTUAL_PREFIX)) return null
      const id = virtualId.slice(VIRTUAL_PREFIX.length, -VIRTUAL_SUFFIX.length)
      const { code, exports } = transform({
        filename: basename(id),
        code: readFileSync(id),
        cssModules: true,
        minify: true,
      })
      const classes = Object.fromEntries(
        Object.entries(exports ?? {}).map(([local, value]) => [local, value.name]),
      )
      // Idempotent by tag id: a re-import (HMR, a second entry) must not stack
      // duplicate style tags.
      return `const id = ${JSON.stringify(PLUGIN_ID)}
if (typeof document !== 'undefined' && !document.querySelector('style[data-plugin="' + id + '"]')) {
  const tag = document.createElement('style')
  tag.setAttribute('data-plugin', id)
  tag.textContent = ${JSON.stringify(code.toString())}
  document.head.append(tag)
}
export default ${JSON.stringify(classes)}
`
    },
  }
}

export default defineConfig([
  {
    entry: ['src/index.ts', 'src/invariant.ts', 'src/types.ts'],
    outDir: 'lib',
    format: 'esm',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
    platform: 'node',
    target: 'node22',
    dts: true,
    deps: { neverBundle: [/^@deepseek-ai\//] },
    sourcemap: false,
    clean: true,
  },
  {
    // The web shell fetches this bundle OUTSIDE its own module graph and requires
    // a closure-factory artifact: the file calls `__ModuleLoader__.load` with a
    // factory that resolves every external through the injected `require` (the
    // loader's module table). A plain ESM output is rejected at boot with
    // "loaded without registering ... via __ModuleLoader__.load", so the format
    // is CJS wrapped by the banner/intro/footer below.
    entry: { client: 'src/client.tsx' },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    target: 'es2022',
    // Types come from the host face's `tsc`; emitting them here would wrap the
    // banner into the declaration and break parsing.
    dts: false,
    deps: { neverBundle: PROVIDED },
    plugins: [cssModules()],
    sourcemap: false,
    // The host config owns `clean`; clearing again would delete its output.
    clean: false,
    outputOptions: {
      entryFileNames: 'client.js',
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  },
])
