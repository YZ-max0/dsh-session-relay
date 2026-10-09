/**
 * 子进程夹具：登记**一个**角色，然后退出。
 *
 * 由 `session-relay.test.mjs` 的跨进程并发测试 `spawn` 多次，用来验证角色名册的
 * 「读-改-写」是否真的被跨进程互斥保护住。
 *
 * 为什么非要用真子进程：丢失更新（lost update）只在**两个独立的进程**各自持有旧快照时
 * 才发生。单个进程内的 `await` 交错无法复现它，因为本插件的关键段是同步完成的——
 * 也就是说，用假宿主测不出来，必须真的起进程。
 *
 * 用法：`node register-role-child.mjs <角色名> <会话 id>`
 * 环境：`ROLES_FILE` 指向名册文件（必填）。
 *
 * ⚠️ 文件名**不含** `.test.mjs`：它不是测试套件，而是被测试拉起的辅助进程；
 * 否则 `node --test` 会把它当成一个测试文件直接执行。
 */
import { makeAgent, makeContext, callTool } from './helpers.mjs'
import * as plugin from '../session-relay.mjs'

const [role, sessionId] = process.argv.slice(2)
const rolesFile = process.env.ROLES_FILE
if (role === undefined || sessionId === undefined || rolesFile === undefined) {
  console.error('usage: ROLES_FILE=... node register-role-child.mjs <role> <sessionId>')
  process.exit(2)
}

const agent = makeAgent({ id: sessionId, cwd: '/workspace/project' })
const host = makeContext({ agents: [agent] })
plugin.apply(host.ctx, { rolesFile })
await callTool(host.tools, 'register_session_role', { role }, { agent })
