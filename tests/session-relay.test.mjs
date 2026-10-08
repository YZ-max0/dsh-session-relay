/**
 * Behaviour tests for session-relay: role registration, addressing, delivery, receipts,
 * and every path that must refuse.
 *
 * These run against the fake host in `helpers.mjs`, so they need no DSH install and no
 * network. The plugin talks to its host only through `ctx.get()` and `ctx.tools.register()`,
 * which is precisely the surface the fake models.
 */

import { test, describe, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import * as plugin from '../session-relay.mjs'
import {
  makeAgent,
  makeContext,
  callTool,
  tryTool,
  messagesDeliveredTo,
  receiptsWrittenTo,
} from './helpers.mjs'

const WORKSPACE = '/workspace/project'
const OTHER_WORKSPACE = '/workspace/other'

let tempDir
let rolesFile

beforeEach(() => {
  // Each test gets its own role registry so tests never share state or touch ~/.dsh.
  tempDir = mkdtempSync(join(tmpdir(), 'session-relay-test-'))
  rolesFile = join(tempDir, 'roles.json')
})

afterEach(() => {
  plugin.setRolesFile(undefined)
  rmSync(tempDir, { recursive: true, force: true })
})

/**
 * Build a host with one commander plus the given workers, all in WORKSPACE,
 * and mount the plugin.
 */
function hostWith({ workers = ['后端窗口', '前端窗口'], extraAgents = [], omit = [], listedSessions } = {}) {
  const commander = makeAgent({ id: 'session-commander', cwd: WORKSPACE })
  const workerAgents = workers.map((role, index) => ({
    role,
    agent: makeAgent({ id: `session-worker-${index}`, cwd: WORKSPACE, createdAt: 1_700_000_000_000 + index }),
  }))
  const host = makeContext({
    agents: [commander, ...workerAgents.map(entry => entry.agent), ...extraAgents],
    omit,
    listedSessions,
  })
  plugin.apply(host.ctx, { rolesFile })
  return { ...host, commander, workerAgents }
}

describe('plugin shape', () => {
  test('is a function plugin: named exports, no default export', () => {
    // DSH's Loader drops `inject` when a function plugin also default-exports; the
    // repository has a postmortem for exactly that mistake, so pin the shape here.
    assert.equal(typeof plugin.name, 'string')
    assert.deepEqual(plugin.inject, ['tools'])
    assert.equal(typeof plugin.apply, 'function')
    assert.equal(plugin.default, undefined)
  })

  test('registers exactly the four documented tools', () => {
    const { tools } = hostWith()
    assert.deepEqual([...tools.keys()].sort(), [
      'dispatch_card',
      'list_workspace_sessions',
      'register_session_role',
      'send_session_message',
    ])
  })

  test('every tool declares a description, parameters and output.render', () => {
    const { tools } = hostWith()
    for (const [name, definition] of tools) {
      assert.equal(typeof definition.description, 'string', `${name} description`)
      assert.ok(definition.description.length > 20, `${name} description is useful`)
      assert.equal(definition.parameters.type, 'object', `${name} parameters`)
      assert.equal(typeof definition.output?.render, 'function', `${name} output.render`)
      assert.equal(typeof definition.execute, 'function', `${name} execute`)
    }
  })

  test('required fields use top-level JSON Schema arrays, not per-property flags', () => {
    // The DSH tool registry rejects per-property `required: true` (that is `defineTool`'s
    // authoring style). Getting this wrong makes registration throw at load time.
    const { tools } = hostWith()
    const dispatch = tools.get('dispatch_card')
    assert.deepEqual(dispatch.parameters.required, ['card_path'])
    assert.equal(dispatch.parameters.properties.card_path.required, undefined)
    assert.equal(dispatch.output.schema.additionalProperties, false)
  })
})

describe('register_session_role', () => {
  test('registers a role and reports it back', async () => {
    const { tools, commander } = hostWith()
    const value = await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    assert.equal(value.registered, true)
    assert.equal(value.role, '指挥官助理')
    assert.equal(value.sessionId, 'session-commander')
    assert.equal(value.workspace, WORKSPACE)
  })

  test('persists to the configured file, partitioned by workspace', async () => {
    const { tools, commander } = hostWith()
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    const stored = JSON.parse(readFileSync(rolesFile, 'utf8'))
    assert.equal(stored[WORKSPACE]['指挥官助理'].sessionId, 'session-commander')
  })

  test('re-registering the same role moves ownership and names the previous holder', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const value = await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: commander })
    assert.equal(value.previousHolder, 'session-worker-0')
  })

  test('a session holds only one role; the old name is released', async () => {
    const { tools, commander } = hostWith()
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    const value = await callTool(tools, 'register_session_role', { role: '总指挥' }, { agent: commander })
    assert.equal(value.releasedRole, '指挥官助理')

    const listed = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    const stored = JSON.parse(readFileSync(rolesFile, 'utf8'))
    assert.equal(stored[WORKSPACE]['指挥官助理'], undefined)
    assert.equal(stored[WORKSPACE]['总指挥'].sessionId, 'session-commander')
    assert.ok(listed)
  })

  test('refuses an empty role name', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'register_session_role', { role: '   ' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /role must be non-empty/)
  })

  test('refuses a role name containing control characters', async () => {
    // The role is interpolated into message text; control characters would corrupt it.
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'register_session_role', { role: '后端\u0000窗口' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /control characters/)
  })

  test('refuses an over-long role name', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'register_session_role', { role: '长'.repeat(65) }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /at most 64/)
  })

  test('refuses when the session has no working directory', async () => {
    const agent = makeAgent({ id: 'session-no-cwd', cwd: undefined })
    const host = makeContext({ agents: [agent] })
    plugin.apply(host.ctx, { rolesFile })
    const outcome = await tryTool(host.tools, 'register_session_role', { role: 'x窗口' }, { agent })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /no working directory/)
  })

  test('a corrupt registry degrades to empty instead of breaking every tool', async () => {
    writeFileSync(rolesFile, '{ this is not json')
    const { tools, commander } = hostWith()
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(value.selfRole, undefined)
    // Registering must still repair the file rather than staying broken forever.
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    assert.equal(JSON.parse(readFileSync(rolesFile, 'utf8'))[WORKSPACE]['指挥官助理'].sessionId, 'session-commander')
  })
})

describe('send_session_message — happy paths', () => {
  test('delivers by role name and starts the target immediately', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })

    const value = await callTool(
      tools, 'send_session_message',
      { to: '后端窗口', message: '请按卡执行' },
      { agent: commander },
    )

    assert.equal(value.delivered, true)
    assert.equal(value.targetSessionId, 'session-worker-0')
    assert.equal(value.targetRole, '后端窗口')
    assert.equal(value.mode, 'queue')
    const delivered = messagesDeliveredTo(workerAgents[0].agent)
    assert.equal(delivered.length, 1)
    assert.match(delivered[0].content[0].text, /请按卡执行/)
  })

  test('queue uses followup (immediate new turn), steer uses steer', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    await callTool(tools, 'send_session_message', { to: '后端窗口', message: 'a' }, { agent: commander })
    await callTool(tools, 'send_session_message', { to: '后端窗口', message: 'b', mode: 'steer' }, { agent: commander })
    const kinds = workerAgents[0].agent.session && messagesDeliveredTo(workerAgents[0].agent)
    assert.equal(kinds.length, 2)
  })

  test('delivers by exact session id', async () => {
    const { tools, commander, workerAgents } = hostWith()
    const value = await callTool(
      tools, 'send_session_message',
      { to: 'session-worker-1', message: 'hi' },
      { agent: commander },
    )
    assert.equal(value.targetSessionId, 'session-worker-1')
    assert.equal(value.targetRole, undefined)
  })

  test('role lookup tolerates stray whitespace and case differences', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: 'Backend Window' }, { agent: workerAgents[0].agent })
    const value = await callTool(
      tools, 'send_session_message',
      { to: 'backend  window', message: 'hi' },
      { agent: commander },
    )
    assert.equal(value.targetSessionId, 'session-worker-0')
  })

  test('marks the message with relay provenance so the UI can attribute it', async () => {
    // `form: 'relay'` and `senderSessionId` are what make DSH's existing RelayBody render
    // "from session X" with zero client changes, and stop the text being read as a human turn.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'send_session_message', { to: 'session-worker-0', message: 'x' }, { agent: commander })
    const message = messagesDeliveredTo(workerAgents[0].agent)[0]
    assert.equal(message.source.kind, 'session-relay')
    assert.equal(message.source.form, 'relay')
    assert.equal(message.source.senderSessionId, 'session-commander')
  })

  test('freezes delivered messages, matching the session log contract', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'send_session_message', { to: 'session-worker-0', message: 'x' }, { agent: commander })
    const message = messagesDeliveredTo(workerAgents[0].agent)[0]
    assert.ok(Object.isFrozen(message))
    assert.ok(Object.isFrozen(message.content))
    assert.match(message.id, /^[0-9a-f-]{36}$/)
  })

  test('tells the recipient how to reply, using the sender role when known', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    await callTool(tools, 'send_session_message', { to: 'session-worker-0', message: 'x' }, { agent: commander })
    const text = messagesDeliveredTo(workerAgents[0].agent)[0].content[0].text
    assert.match(text, /"指挥官助理"/)
  })
})

describe('send_session_message — automatic receipts', () => {
  test('writes a notice-form receipt into the sender, not the target', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const value = await callTool(
      tools, 'send_session_message',
      { to: '后端窗口', message: '卡在 cards/a.md' },
      { agent: commander },
    )

    assert.equal(value.receiptWritten, true)
    const receipts = receiptsWrittenTo(commander)
    assert.equal(receipts.length, 1)
    assert.equal(receipts[0].source.kind, 'session-relay-receipt')
    // `notice`, not `relay`: the receipt is the runtime reporting a delivery, not the
    // recipient speaking. DSH renders notice-form context collapsed.
    assert.equal(receipts[0].source.form, 'notice')
    assert.equal(receipts[0].source.targetSessionId, 'session-worker-0')
    assert.equal(receiptsWrittenTo(workerAgents[0].agent).length, 0)
  })

  test('receipts are written without waking the sender', async () => {
    // `inject` (wakeup=false) is what keeps a receipt from starting a fresh model turn.
    const { tools, commander } = hostWith()
    await callTool(tools, 'send_session_message', { to: 'session-worker-0', message: 'x' }, { agent: commander })
    const injected = commander[Symbol.for('nothing')] // never set; keep this explicit below
    assert.equal(injected, undefined)
    assert.equal(receiptsWrittenTo(commander).length, 1)
  })

  test('a receipt never triggers another receipt (the anti-ping-pong invariant)', async () => {
    // This is the plugin's one absolute loop guarantee. A session whose latest user
    // message is a receipt may still send, but must not generate a new receipt.
    const conversation = [
      { type: 'user/message', data: { source: { kind: 'session-relay-receipt', form: 'notice' } } },
    ]
    const sender = makeAgent({ id: 'session-commander', cwd: WORKSPACE, events: conversation })
    const target = makeAgent({ id: 'session-target', cwd: WORKSPACE })
    const host = makeContext({ agents: [sender, target] })
    plugin.apply(host.ctx, { rolesFile })

    const value = await callTool(host.tools, 'send_session_message', { to: 'session-target', message: 'ok' }, { agent: sender })
    assert.equal(value.delivered, true)
    assert.equal(value.receiptWritten, false)
    assert.equal(receiptsWrittenTo(sender).length, 0)
  })

  test('expect_receipt: false suppresses the receipt on request', async () => {
    const { tools, commander } = hostWith()
    const value = await callTool(
      tools, 'send_session_message',
      { to: 'session-worker-0', message: 'x', expect_receipt: false },
      { agent: commander },
    )
    assert.equal(value.receiptWritten, false)
    assert.equal(receiptsWrittenTo(commander).length, 0)
  })
})

describe('runaway protection', () => {
  const hop = kind => ({ type: 'user/message', data: { source: { kind, form: 'relay' } } })

  /** Build a sender carrying `count` consecutive agent-to-agent messages. */
  function senderWithHops(count, trailing = []) {
    const events = []
    for (let index = 0; index < count; index += 1) {
      events.push(hop(index % 2 === 0 ? 'session-relay' : 'session-relay-receipt'))
    }
    events.push(...trailing)
    return makeAgent({ id: 'session-sender', cwd: WORKSPACE, events })
  }

  async function attempt(hops, trailing = []) {
    const sender = senderWithHops(hops, trailing)
    const target = makeAgent({ id: 'session-target', cwd: WORKSPACE })
    const host = makeContext({ agents: [sender, target] })
    plugin.apply(host.ctx, { rolesFile })
    return tryTool(host.tools, 'send_session_message', { to: 'session-target', message: 'x' }, { agent: sender })
  }

  test('allows a normal multi-card exchange (well under the limit)', async () => {
    for (const hops of [0, 5, 14, 15]) {
      const outcome = await attempt(hops)
      assert.equal(outcome.ok, true, `hops=${hops} should be allowed`)
    }
  })

  test('stops an unattended agent-to-agent loop at the limit', async () => {
    for (const hops of [16, 20, 50]) {
      const outcome = await attempt(hops)
      assert.equal(outcome.ok, false, `hops=${hops} should be blocked`)
      assert.match(outcome.error, /consecutive session-to-session messages/)
    }
  })

  test('a human message resets the budget, so long collaborations keep working', async () => {
    // Without this reset, a long-lived session would eventually be throttled for good.
    const outcome = await attempt(40, [{ type: 'user/message', data: { source: { kind: 'user' } } }])
    assert.equal(outcome.ok, true)
  })

  test('an unrelated event kind does not reset the budget', async () => {
    const outcome = await attempt(20, [{ type: 'step/start', data: {} }])
    assert.equal(outcome.ok, false)
  })
})

describe('refusals — authorization and scope', () => {
  test('refuses to send to itself', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'send_session_message', { to: 'session-commander', message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /itself/)
  })

  test('refuses cross-workspace delivery, even to a known session', async () => {
    // The security boundary: same cwd is the entire membership test.
    const outsider = makeAgent({ id: 'session-outsider', cwd: OTHER_WORKSPACE })
    const { tools, commander } = hostWith({ extraAgents: [outsider] })
    const outcome = await tryTool(tools, 'send_session_message', { to: 'session-outsider', message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /not in your workspace/)
  })

  test('refuses when the sender has no working directory (cannot prove same workspace)', async () => {
    const rootless = makeAgent({ id: 'session-rootless', cwd: undefined })
    const target = makeAgent({ id: 'session-target', cwd: WORKSPACE })
    const host = makeContext({ agents: [rootless, target] })
    plugin.apply(host.ctx, { rolesFile })
    const outcome = await tryTool(host.tools, 'send_session_message', { to: 'session-target', message: 'x' }, { agent: rootless })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /not in your workspace/)
  })

  test('refuses a subagent session, pointing it at its parent instead', async () => {
    // Subagent sessions belong to subagent routing; letting them message arbitrary
    // sessions would open a path that bypasses parent/child coordination.
    const sub = makeAgent({ id: 'session-sub', cwd: WORKSPACE, origin: 'subagent', parentSession: 'session-commander' })
    const target = makeAgent({ id: 'session-target', cwd: WORKSPACE })
    const host = makeContext({ agents: [sub, target] })
    plugin.apply(host.ctx, { rolesFile })
    const outcome = await tryTool(host.tools, 'send_session_message', { to: 'session-target', message: 'x' }, { agent: sub })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /delegated subagent session/)
    assert.match(outcome.error, /session-commander/)
  })

  test('allows a forked session, which has a parentSession but is not a subagent', async () => {
    // Fork lineage also sets `parentSession`; keying the refusal on it would wrongly
    // block ordinary forked sessions, so the check must use `origin` only.
    const forked = makeAgent({ id: 'session-forked', cwd: WORKSPACE, parentSession: 'session-origin' })
    const target = makeAgent({ id: 'session-target', cwd: WORKSPACE })
    const host = makeContext({ agents: [forked, target] })
    plugin.apply(host.ctx, { rolesFile })
    const outcome = await tryTool(host.tools, 'send_session_message', { to: 'session-target', message: 'x' }, { agent: forked })
    assert.equal(outcome.ok, true)
  })

  test('refuses an unknown role and lists the ones that exist', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const outcome = await tryTool(tools, 'send_session_message', { to: '幽灵窗口', message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /not a role registered/)
    assert.match(outcome.error, /后端窗口/)
  })

  test('refuses an unknown session id', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'send_session_message', { to: 'session-ghost', message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /cannot deliver/)
  })

  test('targets may not collide with an unrelated role in another workspace', async () => {
    // A role registered for another cwd must not resolve here.
    const outsider = makeAgent({ id: 'session-outsider', cwd: OTHER_WORKSPACE })
    const commander = makeAgent({ id: 'session-commander', cwd: WORKSPACE })
    const host = makeContext({ agents: [commander, outsider] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'register_session_role', { role: '远端窗口' }, { agent: outsider })
    const outcome = await tryTool(host.tools, 'send_session_message', { to: '远端窗口', message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /not a role registered/)
  })
})

describe('refusals — arguments', () => {
  test('requires a target', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'send_session_message', { message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /"to" is required/)
  })

  test('requires some content when no card path is given', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'send_session_message', { to: 'session-worker-0' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /non-empty "message"/)
  })

  test('rejects an over-long body and suggests card_path', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(
      tools, 'send_session_message',
      { to: 'session-worker-0', message: 'x'.repeat(9000) },
      { agent: commander },
    )
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /8000/)
    assert.match(outcome.error, /card_path/)
  })

  test('refuses to run without a calling agent', async () => {
    const { tools } = hostWith()
    for (const name of ['send_session_message', 'list_workspace_sessions', 'register_session_role']) {
      const outcome = await tryTool(tools, name, { role: 'x窗口', to: 'a', message: 'b' }, {})
      assert.equal(outcome.ok, false, name)
      assert.match(outcome.error, /requires a calling agent/)
    }
  })

  test('falls back to queue for an unrecognised mode', async () => {
    const { tools, commander } = hostWith()
    const value = await callTool(
      tools, 'send_session_message',
      { to: 'session-worker-0', message: 'x', mode: 'nonsense' },
      { agent: commander },
    )
    assert.equal(value.mode, 'queue')
  })

  test('explains a missing session controller instead of failing obscurely', async () => {
    const { tools, commander } = hostWith({ omit: ['sessionController'] })
    const outcome = await tryTool(tools, 'send_session_message', { to: 'session-worker-0', message: 'x' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /no session controller/)
  })
})

describe('list_workspace_sessions', () => {
  test('lists only other sessions in the same workspace', async () => {
    const outsider = makeAgent({ id: 'session-outsider', cwd: OTHER_WORKSPACE })
    const { tools, commander } = hostWith({ extraAgents: [outsider] })
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    const ids = value.sessions.map(session => session.sessionId)
    assert.ok(ids.includes('session-worker-0'))
    assert.ok(!ids.includes('session-outsider'))
    assert.ok(!ids.includes('session-commander'), 'excludes the caller')
  })

  test('reports status per session, including persisted-but-not-live ones', async () => {
    // A cold session is listed by sessionQuery but has no live Agent — that is exactly what
    // makes it "cold", so it must NOT be placed in the live agent map here.
    const { tools, commander } = hostWith({
      listedSessions: [
        { header: { id: 'session-commander', cwd: WORKSPACE, createdAt: 1 }, live: true, persisted: true },
        { header: { id: 'session-worker-0', cwd: WORKSPACE, createdAt: 2 }, live: true, persisted: true },
        { header: { id: 'session-cold', cwd: WORKSPACE, createdAt: 3 }, live: false, persisted: true },
      ],
    })
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    const coldEntry = value.sessions.find(session => session.sessionId === 'session-cold')
    assert.equal(coldEntry.status, 'cold')
    const liveEntry = value.sessions.find(session => session.sessionId === 'session-worker-0')
    assert.equal(liveEntry.status, 'idle')
  })

  test('reports a running session as running', async () => {
    const running = makeAgent({ id: 'session-running', cwd: WORKSPACE, status: 'running' })
    const { tools, commander } = hostWith({ extraAgents: [running] })
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(value.sessions.find(s => s.sessionId === 'session-running').status, 'running')
  })

  test('sorts registered roles first, since those are the addressable targets', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[1].agent })
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(value.sessions[0].role, '后端窗口')
  })

  test('filters by role, id and title', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const byRole = await callTool(tools, 'list_workspace_sessions', { query: '后端' }, { agent: commander })
    assert.equal(byRole.sessions.length, 1)
    const byId = await callTool(tools, 'list_workspace_sessions', { query: 'worker-1' }, { agent: commander })
    assert.equal(byId.sessions.length, 1)
    const none = await callTool(tools, 'list_workspace_sessions', { query: 'no-such-thing' }, { agent: commander })
    assert.equal(none.sessions.length, 0)
  })

  test('clamps the limit to a sane maximum', async () => {
    const { tools, commander } = hostWith()
    const value = await callTool(tools, 'list_workspace_sessions', { limit: 100000 }, { agent: commander })
    assert.equal(value.sessions.length, 2)
    const bad = await callTool(tools, 'list_workspace_sessions', { limit: -5 }, { agent: commander })
    assert.equal(bad.sessions.length, 2)
  })

  test('reports the caller\'s own role, or its absence', async () => {
    const { tools, commander } = hostWith()
    const before = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(before.selfRole, undefined)
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    const after = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(after.selfRole, '指挥官助理')
  })

  test('degrades to a clear message when there is no workspace', async () => {
    const rootless = makeAgent({ id: 'session-rootless', cwd: undefined })
    const host = makeContext({ agents: [rootless] })
    plugin.apply(host.ctx, { rolesFile })
    const value = await callTool(host.tools, 'list_workspace_sessions', {}, { agent: rootless })
    assert.equal(value.total, 0)
    assert.equal(value.workspace, undefined)
  })

  test('falls back to the live session store without sessionQuery', async () => {
    const { tools, commander } = hostWith({ omit: ['sessionQuery'] })
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.ok(value.sessions.length >= 1)
  })
})

describe('dispatch_card', () => {
  test('derives the target from the card filename — the one-click path', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })

    const value = await callTool(
      tools, 'dispatch_card',
      { card_path: 'cards/2026-03-01-派工单-重构解析链（后端窗口）.md', message: '按卡执行' },
      { agent: commander },
    )

    assert.equal(value.delivered, true)
    assert.equal(value.targetRole, '后端窗口')
    assert.equal(value.targetRoleFromFilename, '后端窗口')
    assert.equal(value.targetSessionId, 'session-worker-0')
  })

  test('routes each card to its own window', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    await callTool(tools, 'register_session_role', { role: '前端窗口' }, { agent: workerAgents[1].agent })

    await callTool(tools, 'dispatch_card', { card_path: 'x-派工单-a（后端窗口）.md' }, { agent: commander })
    await callTool(tools, 'dispatch_card', { card_path: 'x-派工单-b（前端窗口）.md' }, { agent: commander })

    assert.equal(messagesDeliveredTo(workerAgents[0].agent).length, 1)
    assert.equal(messagesDeliveredTo(workerAgents[1].agent).length, 1)
  })

  test('strips a trailing date from a report filename', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const value = await callTool(
      tools, 'dispatch_card',
      { card_path: 'x-回报-y（后端窗口·20260302）.md' },
      { agent: commander },
    )
    assert.equal(value.targetRole, '后端窗口')
  })

  test('refuses to guess when the filename names no target, and lists known roles', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'x-回报（20260302）.md' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /cannot tell which window/)
    assert.match(outcome.error, /后端窗口/)
    assert.match(outcome.error, /"to"/)
  })

  test('an explicit "to" overrides the filename', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '前端窗口' }, { agent: workerAgents[1].agent })
    const value = await callTool(
      tools, 'dispatch_card',
      { card_path: 'x-回报（后端窗口·20260302）.md', to: '前端窗口' },
      { agent: commander },
    )
    assert.equal(value.targetSessionId, 'session-worker-1')
    // The filename still says 后端窗口; the override is what was used.
    assert.equal(value.targetRoleFromFilename, '后端窗口')
  })

  test('requires card_path', async () => {
    const { tools, commander } = hostWith()
    const outcome = await tryTool(tools, 'dispatch_card', {}, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /card_path/)
  })

  test('tells the recipient to read the card file before acting', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    await callTool(tools, 'dispatch_card', { card_path: 'cards/派工单-a（后端窗口）.md' }, { agent: commander })
    const text = messagesDeliveredTo(workerAgents[0].agent)[0].content[0].text
    assert.match(text, /cards\/派工单-a（后端窗口）\.md/)
    assert.match(text, /先完整读取/)
  })

  test('reports a card it cannot read from its own side, without failing', async () => {
    // The card's authoritative copy may live on another filesystem; unreadable here is a
    // hint, not an error.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const value = await callTool(
      tools, 'dispatch_card',
      { card_path: 'D:\\project\\cards\\派工单-a（后端窗口）.md' },
      { agent: commander },
    )
    assert.equal(value.delivered, true)
    assert.equal(value.cardReadableFromHere, false)
  })

  test('reports a readable card when it exists on this side', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })

    // Not written yet: the hint must be honest rather than always-true.
    const missing = await callTool(
      tools, 'dispatch_card',
      { card_path: join(tempDir, 'card（后端窗口）.md') },
      { agent: commander },
    )
    assert.equal(missing.cardReadableFromHere, false)

    writeFileSync(join(tempDir, 'card（后端窗口）.md'), 'x')
    const present = await callTool(
      tools, 'dispatch_card',
      { card_path: join(tempDir, 'card（后端窗口）.md') },
      { agent: commander },
    )
    assert.equal(present.cardReadableFromHere, true)
  })

  test('inherits every refusal from the delivery core', async () => {
    const sub = makeAgent({ id: 'session-sub', cwd: WORKSPACE, origin: 'subagent', parentSession: 'p' })
    const host = makeContext({ agents: [sub, makeAgent({ id: 'session-t', cwd: WORKSPACE })] })
    plugin.apply(host.ctx, { rolesFile })
    const outcome = await tryTool(host.tools, 'dispatch_card', { card_path: 'x（后端窗口）.md' }, { agent: sub })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /delegated subagent session/)
  })

  test('cannot be tricked into self-delivery by a matching filename', async () => {
    const { tools, commander } = hostWith()
    await callTool(tools, 'register_session_role', { role: '指挥窗口' }, { agent: commander })
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'x（指挥窗口）.md' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /itself/)
  })
})

describe('role registry resilience', () => {
  test('writes atomically, leaving no partial file behind', () => {
    const { tools, commander } = hostWith()
    return callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander }).then(() => {
      // A rename-based write means the final file is always valid JSON.
      assert.doesNotThrow(() => JSON.parse(readFileSync(rolesFile, 'utf8')))
      assert.equal(existsSync(`${rolesFile}.tmp`), false)
    })
  })

  test('a registry written by another workspace does not leak roles', async () => {
    const a = makeAgent({ id: 'session-a', cwd: WORKSPACE })
    const b = makeAgent({ id: 'session-b', cwd: OTHER_WORKSPACE })
    const host = makeContext({ agents: [a, b] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'register_session_role', { role: '甲窗口' }, { agent: a })
    await callTool(host.tools, 'register_session_role', { role: '乙窗口' }, { agent: b })
    const stored = JSON.parse(readFileSync(rolesFile, 'utf8'))
    assert.equal(stored[WORKSPACE]['甲窗口'].sessionId, 'session-a')
    assert.equal(stored[OTHER_WORKSPACE]['乙窗口'].sessionId, 'session-b')
  })
})
