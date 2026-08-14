#!/usr/bin/env node
/**
 * Assemble this plugin into a DeepSeek Harness source tree.
 *
 * The published package and the in-tree package are the same sources under two
 * identities, and the difference is not cosmetic:
 *
 * - Published: unscoped `dsh-tool-todo-tree`, peers resolved from the registry
 *   at `^0.1.0-rc.6`, built by tsdown into `lib/*.js`.
 * - In-tree: scoped `@deepseek-ai/dsh-tool-todo-tree`, peers as `workspace:^`,
 *   built by the harness's own `tsc -b` into `lib/types/`.
 *
 * The Web patches import `@deepseek-ai/dsh-tool-todo-tree/client` and add a
 * tsconfig project reference to it, so applying them WITHOUT this step leaves
 * the harness tree unable to typecheck or lint. This script writes the in-tree
 * identity, adds the two tsconfig wirings the patches expect, and points the
 * integration spec at the harness's own mock adapter (no published artifact
 * exposes it, so the standalone copy vendors one).
 *
 * Usage: node scripts/assemble-into-harness.mjs <path-to-harness-checkout>
 */
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const harness = process.argv[2]
if (harness === undefined) {
  console.error('usage: node scripts/assemble-into-harness.mjs <path-to-harness-checkout>')
  process.exit(2)
}
const target = join(resolve(harness), 'packages/todo/tool-todo-tree')
if (!existsSync(join(resolve(harness), 'tsconfig.host.json'))) {
  console.error(`not a harness checkout (no tsconfig.host.json): ${resolve(harness)}`)
  process.exit(2)
}

const WORKSPACE = 'workspace:^'
const PEERS = [
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-agent',
  '@deepseek-ai/dsh-invariants',
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-session-projection',
  '@deepseek-ai/dsh-tools',
]
const DEV = [
  ...PEERS,
  '@deepseek-ai/cordis-plugin-include',
  '@deepseek-ai/cordis-plugin-loader',
  '@deepseek-ai/dsh-agent-loop',
  '@deepseek-ai/dsh-agent-loop-testkit',
  '@deepseek-ai/dsh-host-apiproxy',
  '@deepseek-ai/dsh-llm',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tool-todo',
  '@deepseek-ai/dsh-user-questions',
]
const fromList = list => Object.fromEntries([...list].sort().map(name => [name, WORKSPACE]))

await rm(target, { recursive: true, force: true })
await mkdir(target, { recursive: true })
for (const entry of ['src', 'tests']) {
  await cp(join(root, entry), join(target, entry), { recursive: true })
}
// Only the English README is carried. The harness gates in-tree documentation
// bilingually (`verify-translation-pairing`: every non-excluded `**/*.md` needs
// a `.zh.md` plus an `.i18n.yaml` record), so a tree that runs that gate needs
// the counterpart authored there — this standalone repo does not keep one.
for (const doc of ['README.md']) {
  await cp(join(root, doc), join(target, doc))
}

const published = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
await writeFile(join(target, 'package.json'), `${JSON.stringify({
  name: '@deepseek-ai/dsh-tool-todo-tree',
  description: published.description,
  version: '0.1.0-rc.6',
  private: true,
  type: 'module',
  main: 'lib/index.js',
  types: 'lib/types/index.d.ts',
  exports: {
    '.': { types: './lib/types/index.d.ts', default: './lib/index.js' },
    './invariant': { types: './lib/types/invariant.d.ts', default: './lib/invariant.js' },
    './types': { types: './lib/types/types.d.ts', default: './lib/types/types.js' },
    './client': { types: './lib/types/client.d.ts', default: './lib/types/client.js' },
    './src/*': './src/*',
    './package.json': './package.json',
  },
  files: ['lib/index.js', 'lib/invariant.js', 'lib/types/**/*.js', 'lib/types/**/*.d.ts', 'src'],
  license: 'MIT',
  dependencies: { '@deepseek-ai/schemastery': WORKSPACE, zod: published.dependencies.zod },
  peerDependencies: fromList(PEERS),
  devDependencies: fromList(DEV),
}, null, 2)}\n`)

await writeFile(join(target, 'tsconfig.json'), `${JSON.stringify({
  extends: '../../../tsconfig.base.json',
  compilerOptions: { rootDir: 'src', outDir: 'lib/types' },
  include: ['src'],
  references: [
    '../../../vendor/cosmokit',
    '../../../vendor/cordis',
    '../../../vendor/schemastery',
    '../../core/scope',
    '../../core/tools',
    '../../core/agent',
    '../../core/session',
    '../../session/session-projection',
    '../../runtime-diagnostics/invariants',
  ].map(path => ({ path })),
}, null, 2)}\n`)

// The harness ships the scripted adapter in its own test directory; the
// standalone copy exists only because no published artifact exposes it.
await rm(join(target, 'tests/mock-adapter.ts'), { force: true })
const specPath = join(target, 'tests/integration.spec.ts')
const spec = await readFile(specPath, 'utf8')
await writeFile(specPath, spec.replace(
  "from './mock-adapter.ts'",
  "from '../../../core/agent-loop/tests/mock-adapter.ts'",
))

/** Insert `addition` after `anchor` in a repository file, once. */
async function wire(relative, anchor, addition) {
  const path = join(resolve(harness), relative)
  const text = await readFile(path, 'utf8')
  if (text.includes(addition.trim())) return `${relative}: already wired`
  if (!text.includes(anchor)) throw new Error(`${relative}: anchor not found: ${anchor}`)
  await writeFile(path, text.replace(anchor, anchor + addition))
  return `${relative}: wired`
}

console.log(await wire(
  'tsconfig.host.json',
  '{ "path": "./packages/todo/tool-todo" },',
  '\n    { "path": "./packages/todo/tool-todo-tree" },',
))
console.log(await wire(
  'tsconfig.base.json',
  '"@deepseek-ai/dsh-tool-todo/client": ["./packages/todo/tool-todo/src/client.ts"],',
  '\n      "@deepseek-ai/dsh-tool-todo-tree/types": ["./packages/todo/tool-todo-tree/src/types.ts"],'
  + '\n      "@deepseek-ai/dsh-tool-todo-tree/client": ["./packages/todo/tool-todo-tree/src/client.ts"],',
))
console.log(`assembled into ${target}`)
