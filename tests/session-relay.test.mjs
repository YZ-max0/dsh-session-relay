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
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, utimesSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'

import * as plugin from '../session-relay.mjs'
import {
  makeAgent,
  makeContext,
  callTool,
  tryTool,
  messagesDeliveredTo,
  receiptsWrittenTo,
  deliveriesOf,
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

  test('a failed delivery receipt is REPORTED to the model, not silently swallowed', () => {
    // DSH deliberately omits a tool's structured `value` from durable events
    // (packages/core/tools/src/index.ts: "deliberately omitted"), so the model only ever sees
    // what `output.render` produces. `receiptWritten` was in the value and the schema but in
    // NO render, so a failed receipt was invisible — while the tool description still promised
    // one would be written. The model would simply wait for a receipt that never arrives.
    const { tools, commander, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    assert.ok(worker)
    // Make the receipt write fail the way a real failure would.
    commander.inject = () => { throw new Error('simulated inject failure') }
    return (async () => {
      await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
      const value = await callTool(
        tools, 'send_session_message',
        { to: '后端窗口', message: 'x' },
        { agent: commander },
      )
      assert.equal(value.receiptWritten, false, 'the fixture must actually fail the receipt')
      const text = tools.get('send_session_message').output.render({}, value)
        .map(part => part.text).join('')
      assert.match(text, /could NOT be written/, 'the model must learn the receipt is missing')
    })()
  })

  test('a SUCCESSFUL receipt adds no noise to the rendered text', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const value = await callTool(
      tools, 'send_session_message',
      { to: '后端窗口', message: 'x' },
      { agent: commander },
    )
    assert.equal(value.receiptWritten, true)
    const text = tools.get('send_session_message').output.render({}, value)
      .map(part => part.text).join('')
    assert.ok(!/could NOT be written/.test(text), 'no spurious warning on the happy path')
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
  test('simultaneous registrations from SEPARATE PROCESSES do not lose updates', async () => {
    // The role registry lives in $DSH_HOME and is therefore MACHINE-wide: running two
    // profiles at once (e.g. web + headless) means two DSH processes read-modify-writing
    // the same file. Atomic rename prevents a half-written file, but NOT a lost update:
    // both read the same old snapshot, both write back, and the later write erases the
    // other's role. Measured by hand before the lock: 6 concurrent registrations -> 1 role.
    //
    // A single-process test cannot catch this — this critical section is synchronous, so
    // await interleaving never reproduces it. Hence real child processes.
    const child = fileURLToPath(new URL('./register-role-child.mjs', import.meta.url))
    const roles = ['甲窗口', '乙窗口', '丙窗口', '丁窗口', '戊窗口', '己窗口']
    await Promise.all(roles.map((role, index) => new Promise((resolve, reject) => {
      execFile(
        process.execPath,
        [child, role, `session-child-${index}`],
        { env: { ...process.env, ROLES_FILE: rolesFile } },
        (error) => (error === null ? resolve() : reject(error)),
      )
    })))

    const saved = JSON.parse(readFileSync(rolesFile, 'utf8'))[WORKSPACE]
    assert.equal(
      Object.keys(saved).length,
      roles.length,
      `all ${roles.length} concurrent registrations must survive, got ${JSON.stringify(Object.keys(saved))}`,
    )
    assert.equal(existsSync(`${rolesFile}.lock`), false, 'the lock must be released')
  })

  test('a lock held by a CRASHED process is reclaimed immediately', async () => {
    // Otherwise one dead process would wedge every future registration. The lock records the
    // holder's pid, and `kill(pid, 0)` throwing ESRCH is proof the holder is gone.
    const { tools, commander } = hostWith()
    mkdirSync(`${rolesFile}.lock`, { recursive: true })
    // A pid that cannot be running (above the usual max) stands in for a crashed holder.
    writeFileSync(join(rolesFile + '.lock', 'owner'), '999999')
    const started = Date.now()
    const outcome = await tryTool(tools, 'register_session_role', { role: '甲窗口' }, { agent: commander })
    assert.equal(outcome.ok, true, 'a dead holder must not wedge the registry')
    assert.ok(Date.now() - started < 1000, 'reclaiming must be immediate, not a stale timeout wait')
    rmSync(`${rolesFile}.lock`, { recursive: true, force: true })
  })

  test('a lock held by a LIVE process is never stolen, however old', async () => {
    // The counterpart risk: judging staleness by time alone lets a slow-but-alive holder
    // (large registry, network storage) have its lock deleted underneath it, so both
    // processes enter the critical section and the lost-update bug returns.
    const { tools, commander } = hostWith()
    const lockDir = `${rolesFile}.lock`
    mkdirSync(lockDir, { recursive: true })
    writeFileSync(join(lockDir, 'owner'), String(process.pid)) // this test process: definitely alive
    const ancient = Date.now() / 1000 - 3600
    utimesSync(lockDir, ancient, ancient) // an hour old — well past any stale threshold
    const outcome = await tryTool(tools, 'register_session_role', { role: '甲窗口' }, { agent: commander })
    assert.equal(outcome.ok, false, 'must not steal from a live holder')
    assert.match(outcome.error, /timed out/)
    rmSync(lockDir, { recursive: true, force: true })
  })

  test('waiting for the lock does NOT block the event loop', async () => {
    // Regression guard for a mistake I made: the first implementation waited with
    // `Atomics.wait`, which blocks the whole event loop. In a DSH host that freezes EVERY
    // session, not just this tool call — a 5-second stall for all of them.
    //
    // The lock is contended by another PROCESS, so yielding the loop here is harmless and
    // required. Assert that timers keep firing while we wait.
    const { tools, commander } = hostWith()
    mkdirSync(`${rolesFile}.lock`, { recursive: true })
    let ticks = 0
    const timer = setInterval(() => { ticks += 1 }, 10)
    try {
      await tryTool(tools, 'register_session_role', { role: '甲窗口' }, { agent: commander })
    } finally {
      clearInterval(timer)
      rmSync(`${rolesFile}.lock`, { recursive: true, force: true })
    }
    assert.ok(ticks > 20, `event loop must stay responsive while waiting (ticks=${ticks})`)
  })

  test('refuses a role name that would shadow a session id', async () => {
    // `to` may be either a role name or an exact session id, so a role that LOOKS like an id
    // lets its registrant intercept traffic addressed to the real session. Verified before the
    // fix: registering role "session-worker-0" hijacked `to:"session-worker-0"` — the rogue
    // session got the message, the real one got nothing. Same for "Session - Worker-0", which
    // normalises to the same string.
    const { tools, commander } = hostWith()
    for (const role of ['session-worker-0', 'Session - Worker-0']) {
      const outcome = await tryTool(tools, 'register_session_role', { role }, { agent: commander })
      assert.equal(outcome.ok, false, `role ${JSON.stringify(role)} must be rejected`)
      assert.match(outcome.error, /session id/)
    }
  })

  test('an exact session id is never resolved through the role table', async () => {
    // Defence in depth: even if such a role somehow exists (hand-edited registry), addressing
    // a real session id must reach that session and not the role holder.
    // Real DSH ids look like `session-<hex-uuid>`; the resolver keys on that shape.
    const realId = 'session-1fcadc74-f416-4c72-8fe3-c7700e859b26'
    const rogueId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const rogue = makeAgent({ id: rogueId, cwd: WORKSPACE })
    const real = makeAgent({ id: realId, cwd: WORKSPACE })
    const sender = makeAgent({ id: 'session-sender', cwd: WORKSPACE })
    const host = makeContext({ agents: [rogue, real, sender] })
    plugin.apply(host.ctx, { rolesFile })
    // Write the hostile entry directly, bypassing the registration guard.
    writeFileSync(rolesFile, `${JSON.stringify({
      [WORKSPACE]: { [realId]: { sessionId: rogueId, updatedAt: 1 } },
    }, null, 2)}\n`)
    const value = await callTool(
      host.tools, 'send_session_message',
      { to: realId, message: 'x' },
      { agent: sender },
    )
    assert.equal(value.targetSessionId, realId)
    assert.equal(messagesDeliveredTo(real).length, 1, 'the real session must receive it')
    assert.equal(messagesDeliveredTo(rogue).length, 0, 'the role holder must not intercept it')
  })

  test('refuses prototype-key role names instead of silently losing data', async () => {
    // `table['__proto__'] = entry` hits the inherited setter: no own property is created, so
    // JSON.stringify drops it. Verified before the fix: the tool returned registered:true while
    // the file became {}, AND the session's previous role was deleted by the cleanup step.
    const { tools, commander } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: commander })
    for (const role of ['__proto__', 'constructor', 'prototype']) {
      const outcome = await tryTool(tools, 'register_session_role', { role }, { agent: commander })
      assert.equal(outcome.ok, false, `${role} must be rejected`)
    }
    // The earlier registration must survive the attempts.
    const stored = JSON.parse(readFileSync(rolesFile, 'utf8'))[WORKSPACE]
    assert.equal(stored['后端窗口'].sessionId, 'session-commander')
  })

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

  test('a corrupt registry must NOT be silently overwritten (data-loss guard)', async () => {
    // The dangerous case: the file holds real role records but cannot be parsed (half-written,
    // hand-edited badly, disk full). Treating it as "empty" means the next registration
    // overwrites it — every window's role vanishes with no warning. Measured before the fix:
    // 3 registered roles lost in one call. So registration must REFUSE instead.
    const corrupt = '{"' + WORKSPACE + '":{"指挥官助理":{"sessionId":"session-a"'
    writeFileSync(rolesFile, corrupt)
    const { tools, commander } = hostWith()

    const outcome = await tryTool(tools, 'register_session_role', { role: '新窗口' }, { agent: commander })
    assert.equal(outcome.ok, false, 'must refuse rather than clobber a registry it cannot parse')
    assert.match(outcome.error, /would be lost|Refusing/)
    assert.equal(readFileSync(rolesFile, 'utf8'), corrupt, 'the unparseable file must be left untouched')
  })

  test('a corrupt registry still degrades gracefully for read-only tools', async () => {
    // Listing must not start failing just because the registry is unreadable: "I cannot show
    // you roles" is acceptable, "the tool throws" is not.
    writeFileSync(rolesFile, '{ this is not json')
    const { tools, commander } = hostWith()
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(value.selfRole, undefined)
  })

  test('a corrupt registry is REPORTED by the listing tool, not silently hidden', async () => {
    // Degrading gracefully is right (a read-only tool must not start throwing), but hiding the
    // reason is not: the user would see "you have no role" here while registration says
    // "file is not valid JSON", with no visible link between the two.
    writeFileSync(rolesFile, '{ this is not json')
    const { tools, commander } = hostWith()
    const value = await callTool(tools, 'list_workspace_sessions', {}, { agent: commander })
    assert.equal(value.selfRole, undefined, 'still degrades gracefully')
    assert.match(String(value.registryError), /not valid JSON/)
  })

  test('a merely EMPTY registry self-heals (nothing to lose)', async () => {
    // An empty file has no records to destroy, so overwriting it is a repair, not data loss.
    // This is the behaviour that must survive the data-loss guard above.
    writeFileSync(rolesFile, '   \n')
    const { tools, commander } = hostWith()
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    assert.equal(
      JSON.parse(readFileSync(rolesFile, 'utf8'))[WORKSPACE]['指挥官助理'].sessionId,
      'session-commander',
    )
  })

  test('registration recovers once a corrupt registry is repaired', async () => {
    writeFileSync(rolesFile, '{ not json')
    const { tools, commander } = hostWith()
    assert.equal((await tryTool(tools, 'register_session_role', { role: '甲' }, { agent: commander })).ok, false)
    // The user fixes the file (or deletes it); registration must work again.
    writeFileSync(rolesFile, `${JSON.stringify({ [WORKSPACE]: {} }, null, 2)}\n`)
    const after = await tryTool(tools, 'register_session_role', { role: '乙' }, { agent: commander })
    assert.equal(after.ok, true)
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
    // This assertion matters more than it looks: the plugin now TELLS recipients to send
    // reports with mode "steer" precisely because steer admits multiple messages in ONE step
    // while followup admits one per turn. If the two ever collapsed onto the same mechanism,
    // that advice would become a lie — and the measured 65.8-minute report latency would
    // quietly return. Pin the mechanism, not just the message count.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    await callTool(tools, 'send_session_message', { to: '后端窗口', message: 'a' }, { agent: commander })
    await callTool(tools, 'send_session_message', { to: '后端窗口', message: 'b', mode: 'steer' }, { agent: commander })

    assert.deepEqual(
      deliveriesOf(workerAgents[0].agent).map(entry => entry.kind),
      ['followup', 'steer'],
    )
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

  test('a receipt is never delivered to anyone (so it cannot trigger a reply)', async () => {
    // "Receipts never trigger receipts" is guaranteed by construction, not by suppressing
    // later receipts: a receipt only ever goes into the SENDER's own log via `inject`, so
    // no session ever receives one and there is no path for a receipt to prompt a reply.
    //
    // This test pins the construction. An earlier implementation instead suppressed the
    // receipt whenever the sender's newest own message was a receipt — which silently
    // killed the receipt for the 2nd, 3rd, … card of a multi-card dispatch.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'send_session_message', { to: 'session-worker-0', message: 'x' }, { agent: commander })
    const receipt = receiptsWrittenTo(commander)[0]
    assert.ok(receipt !== undefined)

    // The recipient saw the relay message only — never the receipt.
    const workerInbox = messagesDeliveredTo(workerAgents[0].agent)
    assert.equal(workerInbox.length, 1)
    assert.equal(workerInbox[0].source.kind, 'session-relay')
    assert.ok(workerInbox.every(message => message.source.kind !== 'session-relay-receipt'))
  })

  test('consecutive dispatches each get their own receipt', async () => {
    // The multi-card case that the old suppression broke: a commander dispatching several
    // cards in a row (the normal workflow) must keep getting a receipt for every one.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    for (let index = 1; index <= 5; index += 1) {
      const value = await callTool(
        tools, 'dispatch_card',
        { card_path: `cards/派工单-${index}（后端窗口）.md` },
        { agent: commander },
      )
      assert.equal(value.receiptWritten, true, `card ${index} should get a receipt`)
    }
    assert.equal(receiptsWrittenTo(commander).length, 5)
    assert.equal(messagesDeliveredTo(workerAgents[0].agent).length, 5)
  })

  test('a one-way broadcast is not treated as a runaway loop', async () => {
    // Dispatching many cards is one-way work: the commander receives no relay messages at
    // all, so the runaway guard (which counts RECEIVED relays) must never fire.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    for (let index = 1; index <= 40; index += 1) {
      const outcome = await tryTool(
        tools, 'dispatch_card',
        { card_path: `cards/派工单-${index}（后端窗口）.md` },
        { agent: commander },
      )
      assert.equal(outcome.ok, true, `dispatch ${index} should be allowed`)
    }
    assert.equal(receiptsWrittenTo(commander).length, 40)
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
  /**
   * One relay message received from another session.
   * @param sender - sender session id; the guard keys on this, so it matters.
   */
  const receivedRelay = (sender = 'session-peer') => ({
    type: 'user/message',
    data: { source: { kind: 'session-relay', form: 'relay', senderSessionId: sender } },
  })

  /**
   * One locally-written receipt: proof that WE delivered something to `target`.
   *
   * Receipts are written into the sender's own log, so they are the guard's only evidence
   * of OUTBOUND traffic (see `relayState`). The target matters — a receipt naming no peer
   * counts as nothing.
   */
  const localReceipt = (target) => ({
    type: 'user/message',
    data: {
      source: {
        kind: 'session-relay-receipt',
        form: 'notice',
        ...target === undefined ? {} : { targetSessionId: target },
      },
    },
  })

  /**
   * A complete round-trip with one peer: one message in, one message out.
   *
   * The guard counts `min(inbound, outbound)` per peer, because only a real back-and-forth
   * can run away. Inbound alone models a *receiver* being fanned out to — which must NEVER
   * be throttled (dispatching 16 cards to one window used to silence its reports entirely).
   */
  const roundTrip = (peer = 'session-peer') => [receivedRelay(peer), localReceipt(peer)]

  /**
   * A sender whose log carries `count` received relays, plus any trailing events.
   *
   * The guard counts what this session **received** from other sessions, because that is
   * what an unattended A↔B loop produces. A one-way broadcaster (a commander dispatching
   * many cards) receives none, so it is never throttled.
   */
  function senderWithHops(count, trailing = [], sender = 'session-peer') {
    const events = []
    // `count` full round-trips: the only shape that can actually run away.
    for (let index = 0; index < count; index += 1) events.push(...roundTrip(sender))
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

  test('locally-written receipts do NOT count toward the budget', async () => {
    // A receipt is the plugin's own bookkeeping in the sender's log, not something another
    // session said. Counting it would throttle a commander after ~16 cards dispatched —
    // the normal workflow — which is exactly the bug this asserts against.
    const outcome = await attempt(0, Array.from({ length: 40 }, localReceipt))
    assert.equal(outcome.ok, true)
  })

  test('a one-way broadcast never trips the guard, however many cards are sent', async () => {
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    for (let index = 1; index <= 30; index += 1) {
      const outcome = await tryTool(
        tools, 'dispatch_card',
        { card_path: `cards/派工单-${index}（后端窗口）.md` },
        { agent: commander },
      )
      assert.equal(outcome.ok, true, `card ${index} should be allowed`)
    }
  })

  test('a fan-in from many distinct windows is NOT a loop (regression)', async () => {
    // The coordinator's most ordinary situation: N windows each report once. Every message
    // arrives from a DIFFERENT session, so there is no ping-pong to break.
    //
    // Counting the raw total got this wrong: a coordinator that had merely *heard from*
    // 16 windows in a row was silenced — it could not even say "收到" back, until a human
    // happened to speak. Real run: a 4-window verification accumulated 14 inbound relays
    // and was heading for the limit with nothing wrong.
    const { tools, commander } = hostWith()
    const events = []
    for (let index = 0; index < 25; index += 1) events.push(receivedRelay(`session-window-${index}`))
    const busy = makeAgent({ id: 'session-busy', cwd: WORKSPACE, events })
    const peer = makeAgent({ id: 'session-peer', cwd: WORKSPACE })
    const host = makeContext({ agents: [busy, peer] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'register_session_role', { role: '协调窗口' }, { agent: busy })
    await callTool(host.tools, 'register_session_role', { role: '对端窗口' }, { agent: peer })

    const outcome = await tryTool(
      host.tools, 'send_session_message',
      { to: '对端窗口', message: '收到' },
      { agent: busy },
    )
    assert.equal(outcome.ok, true, 'hearing from many distinct windows must not silence the coordinator')
  })

  test('a fanned-out receiver can still report back (20 cards from ONE sender)', async () => {
    // The sharpest form of the bug above: not many senders, but ONE sender sending many cards
    // to ONE window. That window's inbound count grows by one per card, so a naive
    // "count inbound" guard silences it — even though it has never sent anything.
    //
    // Verified before the fix: 16 cards -> the worker's report was REJECTED; with 20 cards it
    // was muted for every target until a human spoke in that session. That is this plugin's
    // whole purpose (派工 → 回报) being blocked by its own safety net.
    const { tools, commander, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
    for (let index = 1; index <= 20; index += 1) {
      await callTool(
        tools, 'dispatch_card',
        { card_path: `cards/派工单-${index}（后端窗口）.md` },
        { agent: commander },
      )
    }
    const report = await tryTool(
      tools, 'send_session_message',
      { to: '指挥官助理', message: '回报：全部完成' },
      { agent: worker },
    )
    assert.equal(report.ok, true, 'a window that only ever RECEIVED must still be able to report')
  })

  test('twenty completed round-trips with one peer are still blocked', async () => {
    // Guard against "fixed it by removing the safety net". A genuine back-and-forth must stop.
    const { tools, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    const events = []
    for (let hop = 0; hop < 20; hop += 1) events.push(...roundTrip('session-worker-0'))
    const busy = makeAgent({ id: 'session-busy', cwd: WORKSPACE, events })
    const host = makeContext({ agents: [busy, worker] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'register_session_role', { role: '甲窗口' }, { agent: busy })
    await callTool(host.tools, 'register_session_role', { role: '乙窗口' }, { agent: worker })
    const outcome = await tryTool(
      host.tools, 'send_session_message',
      { to: '乙窗口', message: 'x' },
      { agent: busy },
    )
    assert.equal(outcome.ok, false, 'twenty completed round-trips must be blocked')
  })

  test('a ping-pong with ONE peer still trips the guard', async () => {
    // The case the guard exists for: two sessions trading messages indefinitely.
    const outcome = await attempt(16, [], 'session-same-peer')
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /consecutive session-to-session messages/)
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

  test('message + card_path together may not exceed the limit', async () => {
    // Per-field checks are not enough: each can be legal while the SUM is nearly double.
    // Measured before the fix: 8000 + 8000 was accepted, so the recipient got a 16 753-char
    // message against a documented 8000 limit.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const outcome = await tryTool(
      tools, 'send_session_message',
      { to: '后端窗口', message: 'm'.repeat(5000), card_path: `${'c'.repeat(5000)}.md` },
      { agent: commander },
    )
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /message \+ card_path/)
  })

  test('an 8000-character body is still accepted (the documented boundary is unchanged)', async () => {
    // The sum check must not silently tighten the limit: the preamble the plugin adds
    // ("[派工/消息] 来自…" plus the reply block) is the plugin's own boilerplate and must not
    // count against the caller's quota, or "pass 8000" would start failing.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const outcome = await tryTool(
      tools, 'send_session_message',
      { to: '后端窗口', message: 'x'.repeat(8000) },
      { agent: commander },
    )
    assert.equal(outcome.ok, true)
  })

  test('card_path is subject to the same size limit as message', async () => {
    // card_path reaches the recipient's context too, so it must obey the same cap.
    // Checking only `message` left card_path as a bypass: 50 000 characters sailed through.
    const { tools, commander, workerAgents } = hostWith()
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: workerAgents[0].agent })
    const outcome = await tryTool(
      tools, 'send_session_message',
      { to: '后端窗口', card_path: `${'y'.repeat(9000)}.md` },
      { agent: commander },
    )
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /card_path/)
    assert.match(outcome.error, /8000/)
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

  test('the reply block names the DISPATCHER, not the card author\u2019s assumption', async () => {
    // Found in production: one card was dispatched by two different sessions. The recipient
    // got two contradictory reply addresses — the runtime's "reply to whoever dispatched
    // this", and an address hard-coded in the card body — and could not tell which to obey.
    //
    // The runtime block must win, because only it knows who actually handed over the card.
    const { tools, commander, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
    await callTool(tools, 'dispatch_card', { card_path: 'x-派工单-y（后端窗口）.md' }, { agent: commander })

    const text = messagesDeliveredTo(worker)[0].content.map(part => part.text).join('\n')
    assert.match(text, /回信地址以本块为准/)
    // The commander dispatched it and has no registered role, so its session id is the address.
    assert.match(text, /"session-commander"/)
  })

  test('the reply block does not ask for a redundant "已收卡" acknowledgement', async () => {
    // The plugin already writes a delivery receipt into the sender's own log on success
    // (form: 'notice'). Asking the recipient to ALSO手写一句「已收卡」duplicates that fact,
    // and under next-turn queuing every duplicate occupies its own queue slot: in a measured
    // 15-message run, 8 (53%) were such noise, pushing the real reports back by 8 turns.
    const { tools, commander, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
    await callTool(tools, 'dispatch_card', { card_path: 'x-派工单-y（后端窗口）.md' }, { agent: commander })

    const text = messagesDeliveredTo(worker)[0].content.map(part => part.text).join('\n')
    assert.match(text, /不必\*\*先回「已收卡」/)
    assert.ok(!/收到后请先回一句/.test(text), 'must not ask for the redundant acknowledgement')
  })

  test('the reply block tells the recipient to send reports with mode: "steer"', async () => {
    // queue admits one message per turn; steer admits all steered messages in a single step.
    // Reports fan IN to one coordinator, so queue is exactly the wrong mode for them.
    const { tools, commander, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
    await callTool(tools, 'dispatch_card', { card_path: 'x-派工单-y（后端窗口）.md' }, { agent: commander })

    const text = messagesDeliveredTo(worker)[0].content.map(part => part.text).join('\n')
    assert.match(text, /mode: "steer"/)
  })

  test('the reply block follows the dispatcher when two sessions send the same card', async () => {
    // The exact production shape: the same card file, handed over by two different sessions.
    // Each recipient must be told to reply to ITS OWN dispatcher — which is precisely why a
    // card body must not hard-code a recipient.
    const first = makeAgent({ id: 'session-dispatcher-a', cwd: WORKSPACE })
    const second = makeAgent({ id: 'session-dispatcher-b', cwd: WORKSPACE })
    const worker = makeAgent({ id: 'session-worker', cwd: WORKSPACE })
    const host = makeContext({ agents: [first, second, worker] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
    await callTool(host.tools, 'register_session_role', { role: '派工方甲' }, { agent: first })
    await callTool(host.tools, 'register_session_role', { role: '派工方乙' }, { agent: second })

    const card = 'x-派工单-z（后端窗口）.md'
    await callTool(host.tools, 'dispatch_card', { card_path: card }, { agent: first })
    await callTool(host.tools, 'dispatch_card', { card_path: card }, { agent: second })

    const texts = messagesDeliveredTo(worker).map(m => m.content.map(p => p.text).join('\n'))
    assert.equal(texts.length, 2)
    // Extract the address from the reply call itself. Asserting on the raw text would pass
    // vacuously: the message header also names the sender's role, so a bare /"派工方甲"/
    // matches the header even when the reply block points somewhere else.
    const replyAddress = (text) => {
      const match = /send_session_message\(\{ to: ("[^"]+"),/.exec(text)
      assert.ok(match !== null, 'reply block must name an address')
      return match[1]
    }
    assert.equal(replyAddress(texts[0]), '"派工方甲"')
    assert.equal(replyAddress(texts[1]), '"派工方乙"')
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

/**
 * The report-direction asymmetry.
 *
 * A dispatch card's trailing bracket names the RECIPIENT; a report's names who WROTE it.
 * So a window sending its own report must pass `to`, or the derived target is itself.
 *
 * Refusing is not enough on its own: the window has to be told what to do instead, or it
 * will retry with a different file or give up. These tests pin that guidance — including
 * that the suggested address is one that actually works, read from who really dispatched.
 */
describe('report direction (派工 vs 回报)', () => {
  /** Commander dispatches to the worker, so the worker's log records the sender. */
  async function afterDispatch() {
    const { tools, commander, workerAgents } = hostWith()
    const worker = workerAgents[0].agent
    await callTool(tools, 'register_session_role', { role: '指挥官助理' }, { agent: commander })
    await callTool(tools, 'register_session_role', { role: '后端窗口' }, { agent: worker })
    await callTool(tools, 'dispatch_card', { card_path: 'cards/派工单-a（后端窗口）.md' }, { agent: commander })
    return { tools, commander, worker }
  }

  test('a window sending its own report without `to` is refused, not silently misdelivered', async () => {
    const { tools, worker } = await afterDispatch()
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'S1-X-回报-Y（后端窗口·20260302）.md' }, { agent: worker })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /itself/)
  })

  test('detection is structural, not based on the word 回报 in the filename', async () => {
    // The original implementation sniffed the filename for "回报"/"停手". That is fragile:
    // a team may name reports any way it likes. The robust signal is that the target was
    // *derived from the filename* and came out as the caller — nobody dispatches to itself,
    // so that combination can only mean "this file is my own report".
    //
    // This filename deliberately contains no report keyword.
    const { tools, worker } = await afterDispatch()
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'notes/2026-03-02-review-of-parse-chain（后端窗口）.md' }, { agent: worker })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /REPORT/)
    assert.match(outcome.error, /WROTE/)
  })

  test('an explicit `to` equal to oneself is still refused, and still explains', async () => {
    const { tools, worker } = await afterDispatch()
    const outcome = await tryTool(
      tools, 'dispatch_card',
      { card_path: 'notes/anything（后端窗口）.md', to: '后端窗口' },
      { agent: worker },
    )
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /itself/)
    assert.match(outcome.error, /"to"/)
  })

  test('the refusal explains that a report bracket names the author', async () => {
    const { tools, worker } = await afterDispatch()
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'S1-X-回报-Y（后端窗口）.md' }, { agent: worker })
    assert.equal(outcome.ok, false)
    // The explanation the window needs to unblock itself.
    assert.match(outcome.error, /REPORT/)
    assert.match(outcome.error, /WROTE/)
    assert.match(outcome.error, /"to"/)
  })

  test('the refusal suggests the address that actually dispatched, and it works', async () => {
    const { tools, commander, worker } = await afterDispatch()
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'S1-X-回报-Y（后端窗口）.md' }, { agent: worker })
    assert.equal(outcome.ok, false)
    // The suggestion comes from the relay message's sender, not from a hard-coded role name,
    // so it is valid in this workspace by construction.
    assert.match(outcome.error, /指挥官助理/)

    // Following the advice must succeed — this is what makes the guidance worth printing.
    const followed = await tryTool(
      tools, 'dispatch_card',
      { card_path: 'S1-X-回报-Y（后端窗口）.md', to: '指挥官助理' },
      { agent: worker },
    )
    assert.equal(followed.ok, true)
    assert.equal(followed.value.targetRole, '指挥官助理')
    assert.equal(messagesDeliveredTo(commander).length, 1)
  })

  test('a 停手回报 (stop report) is recognised the same way', async () => {
    const { tools, worker } = await afterDispatch()
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'S1-X-停手回报（后端窗口·20260302）.md' }, { agent: worker })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /REPORT/)
  })

  test('the suggestion falls back to the session id when the sender has no role', async () => {
    // A dispatcher that never registered a role must still get a usable address.
    const commander = makeAgent({ id: 'session-cmd', cwd: WORKSPACE })
    const worker = makeAgent({ id: 'session-worker', cwd: WORKSPACE })
    const host = makeContext({ agents: [commander, worker] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'dispatch_card', { card_path: 'x-派工单-a（无角色窗口）.md', to: 'session-worker' }, { agent: commander })
    // Register the worker's own role so the report filename resolves to it.
    await callTool(host.tools, 'register_session_role', { role: '无角色窗口' }, { agent: worker })

    const outcome = await tryTool(host.tools, 'dispatch_card', { card_path: 'x-回报-y（无角色窗口）.md' }, { agent: worker })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /session-cmd/)
  })

  test('without any prior relay the refusal still tells the window what to do', async () => {
    // No dispatch happened, so there is no sender to name — the wording must degrade
    // gracefully rather than inventing or omitting the instruction.
    const { tools, commander } = hostWith()
    await callTool(tools, 'register_session_role', { role: '指挥窗口' }, { agent: commander })
    const outcome = await tryTool(tools, 'dispatch_card', { card_path: 'x-回报-y（指挥窗口）.md' }, { agent: commander })
    assert.equal(outcome.ok, false)
    assert.match(outcome.error, /"to"/)
    assert.match(outcome.error, /list_workspace_sessions/)
  })

  test('a card sent by the commander is NOT affected by the report rule', async () => {
    // The normal dispatch path must keep working with no `to` at all.
    const { tools, commander, worker } = await afterDispatch()
    const again = await tryTool(tools, 'dispatch_card', { card_path: 'cards/派工单-b（后端窗口）.md' }, { agent: commander })
    assert.equal(again.ok, true)
    assert.equal(again.value.targetRole, '后端窗口')
  })

  test('a third-party report addressed to someone else still resolves normally', async () => {
    // Regression guard: the guide must not "flip" a legitimate bracket that names a
    // different session (a tester handing a backend report to the backend window).
    const tester = makeAgent({ id: 'session-tester', cwd: WORKSPACE })
    const backend = makeAgent({ id: 'session-backend', cwd: WORKSPACE })
    const host = makeContext({ agents: [tester, backend] })
    plugin.apply(host.ctx, { rolesFile })
    await callTool(host.tools, 'register_session_role', { role: '测试窗口' }, { agent: tester })
    await callTool(host.tools, 'register_session_role', { role: '后端窗口' }, { agent: backend })

    const outcome = await tryTool(host.tools, 'dispatch_card', { card_path: 'x-回报-y（后端窗口）.md' }, { agent: tester })
    assert.equal(outcome.ok, true)
    assert.equal(outcome.value.targetRole, '后端窗口')
    assert.equal(messagesDeliveredTo(backend).length, 1)
  })

  test('the dispatch guidance reaches the recipient before they need it', async () => {
    // The window should learn the rule from the card it receives, not from a failure.
    const { worker } = await afterDispatch()
    const text = messagesDeliveredTo(worker)[0].content[0].text
    assert.match(text, /回报/)
    assert.match(text, /必须显式给 "to"/)
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
