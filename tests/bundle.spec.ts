/**
 * Contract of the BUILT browser artifact, asserted on `lib/client.js` rather than
 * on the source.
 *
 * The component specs import source modules, so they pass regardless of output
 * format. The web shell fetches this file outside its own module graph and
 * requires a closure-factory artifact; a plain ESM build satisfies every source
 * test and still fails at boot with "loaded without registering ... via
 * __ModuleLoader__.load". These assertions are what catch that.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

describe('built client bundle', () => {
  it('hands a factory to the shell module loader under this package id', () => {
    expect(bundle).toContain('window.__ModuleLoader__.load(')
    expect(bundle).toContain('"dsh-tool-todo-tree"')
    expect(bundle).toMatch(/factory:\s*\(require\)\s*=>/)
  })

  it('is not an ESM artifact', () => {
    // A top-level `import`/`export` means the format regressed to ESM, which the
    // shell rejects at boot.
    expect(bundle).not.toMatch(/^\s*import\s/m)
    expect(bundle).not.toMatch(/^\s*export\s/m)
  })

  it('resolves every shell-provided package through the injected require', () => {
    for (const provided of ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives']) {
      expect(bundle).toContain(`require("${provided}")`)
    }
  })

  it('carries its own stylesheet, injected once and keyed by the plugin id', () => {
    expect(bundle).toContain('data-plugin')
    expect(bundle).toContain('--dsw-todo-tree-depth')
  })
})
