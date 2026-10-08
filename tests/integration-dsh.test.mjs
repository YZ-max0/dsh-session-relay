/**
 * Integration tests against a **real** DSH installation.
 *
 * These verify the contracts the fake host cannot: that the tool definitions are accepted
 * by the real `ToolRuntime` registry, that they survive its JSON-Schema validation, and
 * that the message and receipt our plugin builds pass DSH's own session-log validation
 * (`adoptSessionEvent`).
 *
 * DSH's npm releases lag this repository's API surface, so the DSH packages are resolved
 * from a local installation rather than declared as dependencies. When no installation is
 * found, every test **skips** instead of failing — the suite must stay green for
 * contributors who only want to run the unit tests.
 *
 * To run them, point `DSH_MODULE_ROOT` at a directory that can resolve `@deepseek-ai/*`:
 *
 *     DSH_MODULE_ROOT=~/.dsh/profiles/web npm test
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

import * as plugin from '../session-relay.mjs'
import { makeAgent, makeContext, callTool } from './helpers.mjs'

/**
 * Locate a module root that can resolve DSH packages.
 *
 * Resolution is probed with `createRequire` **relative to each candidate** rather than by
 * checking for a `node_modules/@deepseek-ai` directory: Node walks ancestor directories, so
 * a profile like `~/.dsh/profiles/web` legitimately resolves DSH from
 * `~/.dsh/profiles/node_modules` and has no `@deepseek-ai` directory of its own. A
 * directory-existence check would wrongly report "DSH not installed" there.
 * @returns an absolute directory path, or undefined when DSH is not available.
 */
function findDshRoot() {
  const candidates = [
    process.env.DSH_MODULE_ROOT,
    join(process.env.HOME ?? '', '.dsh', 'profiles', 'web'),
    join(process.env.HOME ?? '', '.dsh', 'profiles'),
    join(process.env.HOME ?? '', 'dsh-new'),
  ].filter(candidate => typeof candidate === 'string' && candidate !== '')

  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const require = createRequire(pathToFileURL(join(candidate, 'noop.mjs')).href)
      require.resolve('@deepseek-ai/dsh-tools')
      return candidate
    } catch {
      // Not resolvable from here; try the next candidate.
    }
  }
  return undefined
}

const dshRoot = findDshRoot()
const skip = dshRoot === undefined
  ? 'DSH is not installed here; set DSH_MODULE_ROOT to run integration tests'
  : false

/** Resolve and import one DSH package from the located root. */
async function loadDsh(name) {
  const require = createRequire(pathToFileURL(join(dshRoot, 'noop.mjs')).href)
  const resolved = require.resolve(`@deepseek-ai/${name}`)
  return import(pathToFileURL(resolved).href)
}

let tempDir
before(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'session-relay-integration-'))
})

describe('integration: real DSH tool registry', { skip }, () => {
  test('all four tool definitions are accepted by the real registry', async () => {
    const { Context } = await loadDsh('cordis')
    const ToolRuntime = (await loadDsh('dsh-tools')).default
    const SystemPrompt = (await loadDsh('dsh-system-prompt')).default

    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)

    // Registration throws on an unsupported schema, so this is the real gate.
    plugin.apply({
      get: () => undefined,
      effect: factory => {
        const disposer = factory()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      logger: { warn() {}, info() {}, error() {} },
      tools: { register: definition => ctx.tools.register(definition) },
      on: () => () => {},
      emit() {},
    })

    const names = ctx.tools.schemas().map(schema => schema.name).sort()
    assert.deepEqual(names, [
      'dispatch_card',
      'list_workspace_sessions',
      'register_session_role',
      'send_session_message',
    ])
  })

  test('the registry rejects the per-property `required: true` mistake', async () => {
    // Documents *why* the manifest check exists: this mistake is invisible to
    // `node --check` and to schema-free unit tests.
    const { assertSupportedJsonSchema } = await loadDsh('dsh-tools')
    const broken = {
      type: 'object',
      additionalProperties: false,
      properties: { a: { type: 'string', required: true } },
    }
    assert.throws(() => assertSupportedJsonSchema(broken), /required is not supported/)
  })

  test('a misspelled argument is rejected rather than silently ignored', async () => {
    const { validateJsonSchemaValue } = await loadDsh('dsh-tools')
    const definition = new Map()
    plugin.apply({
      get: () => undefined,
      effect: factory => {
        const disposer = factory()
        return typeof disposer === 'function' ? disposer : () => {}
      },
      logger: { warn() {}, info() {}, error() {} },
      tools: { register: d => { definition.set(d.name, d); return () => {} } },
      on: () => () => {},
      emit() {},
    })
    const dispatch = definition.get('dispatch_card')
    const violations = validateJsonSchemaValue(dispatch.parameters, { cardPath: 'x.md' }, '')
    assert.ok(violations.length > 0)
    assert.ok(violations.some(v => v.includes('card_path')))
  })
})

describe('integration: real DSH session-log validation', { skip }, () => {
  test('a relay message passes `adoptSessionEvent`', async () => {
    const { adoptSessionEvent } = await loadDsh('dsh-session')
    const commander = makeAgent({ id: 'session-commander', cwd: '/workspace' })
    const target = makeAgent({ id: 'session-target', cwd: '/workspace' })
    const host = makeContext({ agents: [commander, target] })
    plugin.apply(host.ctx, { rolesFile: join(tempDir, 'roles.json') })

    await callTool(host.tools, 'send_session_message', { to: 'session-target', message: 'hello' }, { agent: commander })

    // Read the message the fake host recorded, then hand it to DSH's own validator.
    const { messagesDeliveredTo } = await import('./helpers.mjs')
    const relay = messagesDeliveredTo(target)[0]
    assert.ok(relay !== undefined, 'a message should have been delivered')

    const event = adoptSessionEvent({ type: 'user/message', seq: 0, time: Date.now(), data: relay })
    assert.equal(event.data.source.kind, 'session-relay')
    assert.equal(event.data.source.form, 'relay')
  })

  test('a delivery receipt passes `adoptSessionEvent`', async () => {
    const { adoptSessionEvent } = await loadDsh('dsh-session')
    const { receiptsWrittenTo } = await import('./helpers.mjs')
    const commander = makeAgent({ id: 'session-commander', cwd: '/workspace' })
    const target = makeAgent({ id: 'session-target', cwd: '/workspace' })
    const host = makeContext({ agents: [commander, target] })
    plugin.apply(host.ctx, { rolesFile: join(tempDir, 'roles.json') })

    await callTool(host.tools, 'send_session_message', { to: 'session-target', message: 'hello' }, { agent: commander })

    const receipt = receiptsWrittenTo(commander)[0]
    assert.ok(receipt !== undefined, 'a receipt should have been written')
    const event = adoptSessionEvent({ type: 'user/message', seq: 0, time: Date.now(), data: receipt })
    assert.equal(event.data.source.form, 'notice')
  })
})
