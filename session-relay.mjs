/**
 * session-relay — 让同一工作区内的会话互相派工与回报（DSH 插件）
 *
 * ── 解决什么问题 ────────────────────────────────────────────────────────
 * 用 DSH 做多角色协作时，常见分工是：一个**指挥**会话负责拆任务、写派工单
 * （下称"卡"），另开若干**实施窗口**（前端/后端/测试…)各自干活并回报。
 *
 * 这些窗口是**普通 DSH 会话**，彼此之间原本没有任何通道。于是流程退化成人工搬运：
 *
 *     指挥写好卡 → 用户复制 → 切到窗口粘贴 → 窗口干活 → 用户再去各窗口收回报
 *
 * 用户被夹在中间当"人肉消息总线"。本插件就是**把这层人工搬运拿掉**：
 * 指挥直接把卡发给对应窗口，窗口立即开工，回报也直接发回来。
 *
 * ── 为此必须解决的四件事 ────────────────────────────────────────────────
 * 1. **稳定角色寻址**：会话标题由首条消息自动生成，不是稳定角色名，指挥没法可靠地
 *    "发给后端窗口"。故提供 `register_session_role` 让每个窗口自报角色。
 * 2. **发完即开跑**：用 `Agent.followup()`（会 `wakeDriver()`），窗口立即开工。
 * 3. **自动回执**：投递成功后，以**运行时回执**（`form: 'notice'`）写回发送方自己的
 *    会话日志，指挥不必再去各窗口确认"卡到底收到没"。
 * 4. **不误伤长对话**：**不做深度限流**。指挥↔窗口本就该长期往返（发卡→回执→再发卡
 *    →回报），任何"接力链深度上限"都会在第 3 轮把正常流程拦死。环路安全改由一条更强的
 *    不变量保证：**回执永不触发回执**；另有一条"自最近真人消息起连续跳数"的失控保护，
 *    见 {@link MAX_AGENT_HOPS}。
 *
 * ── 复用而非新造 ────────────────────────────────────────────────────────
 *   - 投递      `Agent.followup()` / `Agent.steer()`（浏览器提交消息走的就是这两个）
 *   - 目标解析  `ctx.sessionController.resolveAgent()` —— 公开方法，自带"活会话直取 /
 *               冷会话从持久化恢复 / 子代理拥有的会话拒绝"三件事
 *   - 会话清单  `ctx.sessionQuery.listSessions()`（含冷会话）＋ `ctx.sessions.list()`（兜底）
 *   - 归属标记  `MessageSourceMap` 合并可扩展；`form: 'relay'` / `form: 'notice'`
 *               都是 DSH 既有的语义值，Web UI 有现成渲染（RelayBody / NoticeBody），
 *               客户端零改动
 *
 * ── 为什么是零裸导入的单文件 `.mjs` ──────────────────────────────────────
 * DSH profile 目录常对沙箱只读，故最简单的落地方式是"文件放工作区 ＋ cordis.patch.yml
 * 里用绝对路径引用"。而宿主插件模块的 `import` 按**该文件自身位置**解析：文件放在没有
 * node_modules 的目录里时，任何 `@deepseek-ai/*` 裸导入都会 ERR_MODULE_NOT_FOUND。
 * 因此本文件只依赖 `node:` 内建模块，可放在任意路径加载、也不需要在工作区里装依赖。
 *
 * 若要走 DSH 官方插件形态（`dsh plugin add`），本仓库同时提供 package.json 与
 * cordis.patch.yml，两条安装路径都支持，见 README。
 *
 * ── 工具定义的两个易错点（已按 tools 注册表实测，踩过才知道）────────────
 *   - `parameters` 与 `output.schema` 都是**原始 JSON Schema**，必填项写成顶层
 *     `required: [...]` 数组，**不是** `defineTool` 那种属性级 `required: true`。
 *     写成后者会被 `assertSupportedJsonSchema` 直接拒绝。
 *   - `exec` 上**没有 `ctx`**（只有 agent/signal/arguments）；服务句柄一律取自
 *     `apply(ctx)` 的闭包。
 *
 * ── 安全边界 ────────────────────────────────────────────────────────────
 *   1. 作用域：只允许与调用方 cwd 完全相同的会话（"同一工作区"）。
 *   2. 越权：目标为子代理会话时 `resolveAgent()` 返回错误，本插件原样上抛。
 *   3. 自环：拒绝向自己发送。
 *   4. 角色归属：角色只在**注册它的那个工作区**内可解析，不会被别的工作区借用。
 *   5. 回执不触发回执（唯一的绝对环路保证）。
 *
 * 本插件只读写一个角色名册文件（`$DSH_HOME/session-relay/roles.json`）；
 * 不读环境变量、不发网络请求、不改任何既有工具的行为。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/** Cordis 插件名。 */
export const name = 'session-relay'

/** 只要工具注册表就绪即可激活；其余服务以 `ctx.get()` 可选取用并给出明确报错。 */
export const inject = ['tools']

/** 模型可见的工具名。 */
const TOOL_LIST = 'list_workspace_sessions'
const TOOL_REGISTER = 'register_session_role'
const TOOL_SEND = 'send_session_message'
const TOOL_DISPATCH = 'dispatch_card'

/** 单条正文的字符上限，保护收件方上下文。 */
const MESSAGE_MAX_CHARS = 8000

/** 清单默认/最大条数。 */
const LIST_DEFAULT_LIMIT = 30
const LIST_MAX_LIMIT = 100

/** 本插件写入**转达消息**的 source.kind。 */
const RELAY_SOURCE_KIND = 'session-relay'
/** 本插件写入**运行时回执**的 source.kind（与转达区分，便于日志与 UI 归因）。 */
const RECEIPT_SOURCE_KIND = 'session-relay-receipt'
/** 同时表达两种 form 的 kind 前缀，用于识别"这是本插件写的消息"。 */
const OWN_KINDS = new Set([RELAY_SOURCE_KIND, RECEIPT_SOURCE_KIND])

/**
 * 角色名册文件；按机器保存，按工作区（cwd）分区。
 *
 * **在调用时**才解析路径（而不是模块加载时），这样：
 *   - 宿主可以在 `apply(ctx, { rolesFile })` 里指定别处（见 {@link setRolesFile}）；
 *   - 测试可以先改 `DSH_HOME` 再加载插件，不会写到用户真实的名册上。
 */
let rolesFileOverride

/**
 * 覆盖角色名册路径。供 `apply` 的配置项与测试使用；传 `undefined` 恢复默认。
 * @param path - 名册文件绝对路径，或 `undefined`。
 */
export function setRolesFile(path) {
  rolesFileOverride = typeof path === 'string' && path !== '' ? path : undefined
}

/** 当前生效的角色名册路径。 */
function rolesFile() {
  return rolesFileOverride
    ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'session-relay', 'roles.json')
}

/**
 * 无人介入时允许的 agent↔agent 消息跳数上限。
 *
 * 为什么需要它（且为什么不能简单地"限深"）：本工作流是**指挥官 ↔ 窗口长期往返**
 * （发卡→回执→再发卡→回报），任何"固定接力深度"都会在第 3 轮把正常流程拦死，
 * 所以不能按总深度限流。但另一边，"发完即自动开跑"意味着两个 AI 会话可以互相唤醒、
 * **在无人看着的情况下持续烧 token**——一句「好的」被回一句「收到」就能无限循环。
 *
 * 故采用的判据是：**自最近一条真人消息以来，连续收发的 agent 消息条数**。
 *   - 真人的一次输入**重置**预算 ⇒ 正常的多卡协作完全不受影响；
 *   - 全是 agent 之间的往复才会累积 ⇒ 礼貌性死循环在有限跳数内被掐断。
 * 上限取 16：足够覆盖一整个卡周期的多次往返，又远小于失控循环的规模。
 */
const MAX_AGENT_HOPS = 16

/* ------------------------------------------------------------------ 卡目标推导 */

/**
 * 从卡/回报的文件名推导目标窗口角色。
 *
 * **约定**（本项目默认识别的写法）：把目标写进文件名末尾的括号，角色名以「窗口」结尾。
 *
 *   2026-03-01-派工单-重构解析链（后端窗口）.md        → 后端窗口
 *   2026-03-01-回报-重构解析链（后端窗口·20260302）.md → 后端窗口（剥掉 ·日期）
 *   T-142-派工单-补单测（测试窗口）.md                 → 测试窗口
 *
 * 需要处理的三类输入（决定了本函数必须是"宁可报未知，不要猜"）：
 *   - `（后端窗口·20260302）` —— 复合形态，日期用 `·` 连接，须剥离后缀；
 *   - `（20260302）`         —— 只有日期的回报件，**没有目标**；
 *   - `（某人代跑）`          —— 非窗口目标（不是某个窗口的角色名）。
 *
 * 故规则是：**只取文件名末尾括号内、最后一个 `·` 之前、且以「窗口」结尾的那段**，
 * 其余一律返回 `undefined`，由调用方要求人工指定或改用 `to` 参数覆盖。
 *
 * ⛔ 绝不用"文件名里出现了'前端'"这类模糊匹配：卡号里的缩写（如 `FE`）、卡标题里
 * 提到的其它窗口名，都会把派工单送错窗口。**位置**（末尾括号）是唯一可信信号。
 *
 * 该约定可用 `to` 参数整体绕过；团队若用别的命名法，传 `to` 即可，无需改代码。
 *
 * 导出它有两个用处：**单元测试直接覆盖**这条纯函数逻辑；以及别的脚本（如批量
 * 检查一批卡的命名是否合规）可以复用，而不必复制一份正则。
 * @param filePath - 卡文件路径（可含目录）。
 * @returns 目标角色名，或 `undefined`（无法从文件名确定）。
 */
export function targetRoleFromCardPath(filePath) {
  if (typeof filePath !== 'string' || filePath === '') return undefined
  const base = filePath.replace(/\\/g, '/').split('/').pop() ?? ''
  const stem = base.replace(/\.(md|markdown|txt)$/i, '')
  // 取**最后一个**括号组：目标总在末尾，而正文描述里可能另有括号。
  const groups = stem.match(/[（(]([^（()）]*)[)）]/g)
  if (groups === null || groups.length === 0) return undefined
  const inner = groups[groups.length - 1].slice(1, -1).trim()
  // 复合形态只取 `·` 之前那段（`后端窗口·20260923` → `后端窗口`）。
  const head = inner.split('·')[0].trim()
  // 必须是"…窗口"结尾的短名；排除 `指挥官代跑` 这类非窗口目标与纯日期。
  if (!head.endsWith('窗口')) return undefined
  if (head.length > 32) return undefined
  if (/[\u0000-\u001f\u007f]/.test(head)) return undefined
  return head
}

/**
 * 一个候选目标与某角色的匹配强度。**只做精确或"去空白/全半角"级的归一化比较**，
 * 不做模糊包含判断——避免把 `前端窗口` 的卡投给 `后端窗口`。
 * @param candidate - 从卡文件名推导出的目标。
 * @param role - 名册里登记的角色名。
 * @returns 是否匹配。
 */
function sameRole(candidate, role) {
  const norm = value => value.trim().replace(/\s+/g, '').toLocaleLowerCase()
  return norm(candidate) === norm(role)
}

/* ------------------------------------------------------------------ 工具定义 */

const listTool = {
  name: TOOL_LIST,
  description:
    'List the other sessions in your workspace (same working directory as you), including each one\'s '
    + 'declared role. Use this to discover the exact role name or session id to address. Sessions that '
    + 'registered a role are the ones you can address by that stable name.',
  parameters: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Optional case-insensitive substring; matches session id, title, role, or working directory.',
      },
      limit: {
        type: 'integer',
        description: `Optional maximum number of sessions to return (default ${LIST_DEFAULT_LIMIT}, max ${LIST_MAX_LIMIT}).`,
      },
    },
    required: [],
    // A misspelled argument is rejected outright instead of being silently ignored.
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        selfSessionId: { type: 'string' },
        selfRole: { type: 'string' },
        workspace: { type: 'string' },
        total: { type: 'integer' },
        sessions: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              sessionId: { type: 'string' },
              role: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string', enum: ['running', 'idle', 'cold'] },
              createdAt: { type: 'integer' },
              parentSessionId: { type: 'string' },
            },
            required: ['sessionId', 'status'],
          },
        },
      },
      required: ['selfSessionId', 'total', 'sessions'],
    },
    render: (_args, value) => [{ type: 'text', text: renderSessionList(value) }],
  },
}

const registerTool = {
  name: TOOL_REGISTER,
  description:
    'Declare this session\'s stable role in its workspace (for example "后端窗口" or "指挥官助理"), '
    + 'so other sessions can address it by that name instead of an opaque session id. Registration is '
    + 'scoped to this workspace. Re-registering the same role replaces the previous owner; registering a '
    + 'different role for this session replaces this session\'s previous one.',
  parameters: {
    type: 'object',
    properties: {
      role: {
        type: 'string',
        description: 'The stable role name other sessions should use to address this session.',
      },
      description: {
        type: 'string',
        description: 'Optional human-readable note about this role (shown in the workspace listing).',
      },
    },
    required: ['role'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        registered: { type: 'boolean' },
        role: { type: 'string' },
        sessionId: { type: 'string' },
        workspace: { type: 'string' },
        previousHolder: { type: 'string' },
        releasedRole: { type: 'string' },
      },
      required: ['registered', 'role', 'sessionId'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: `this session is now addressable as role ${JSON.stringify(value.role)} in workspace ${value.workspace}`
        + (value.previousHolder === undefined
          ? ''
          : ` (that role previously belonged to ${value.previousHolder})`)
        + (value.releasedRole === undefined
          ? ''
          : `; the previous role ${JSON.stringify(value.releasedRole)} was released`),
    }],
  },
}

const sendTool = {
  name: TOOL_SEND,
  description:
    'Send a message to another session in your workspace, addressing it by its declared role or by its '
    + 'exact session id. The receiving session immediately starts a new turn (or is steered at its next '
    + 'step if you pass mode="steer") and sees your message attributed to you, so it can reply. Use '
    + 'card_path to hand over a dispatch card (派工单) by file reference instead of pasting its text: the '
    + 'recipient is told to read that file first. This call returns as soon as the message is accepted — '
    + 'it does NOT wait for the other session to finish, and its substantive reply will arrive later as a '
    + 'new message to you. A runtime delivery receipt is written into your own transcript on success. A '
    + 'failure means the message was NOT delivered. A message that is itself a delivery receipt never '
    + 'triggers another receipt.',
  parameters: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description: `Target: a role name registered via ${TOOL_REGISTER}, or an exact session id from ${TOOL_LIST}.`,
      },
      message: {
        type: 'string',
        description:
          'The message body. Make it self-contained: the other session does not see your transcript, '
          + 'tool output, or reasoning, only this text (plus any card_path you name).',
      },
      card_path: {
        type: 'string',
        description:
          'Optional path to a dispatch card (派工单) or report file the recipient must read first. '
          + 'Strongly preferred over pasting a long card into `message`, because it keeps the message '
          + 'small and keeps the file as the single source of truth.',
      },
      mode: {
        type: 'string',
        enum: ['queue', 'steer'],
        description:
          'queue (default) starts a fresh turn for the target, so it begins work immediately; steer '
          + 'delivers at the target\'s nearest step boundary instead.',
      },
      expect_receipt: {
        type: 'boolean',
        description:
          'Whether to write a runtime delivery receipt into your own transcript (default true). '
          + 'Ignored for receipts themselves, which never produce a receipt.',
      },
    },
    required: ['to'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delivered: { type: 'boolean' },
        messageId: { type: 'string' },
        targetSessionId: { type: 'string' },
        targetRole: { type: 'string' },
        mode: { type: 'string', enum: ['queue', 'steer'] },
        receiptWritten: { type: 'boolean' },
      },
      required: ['delivered', 'messageId', 'targetSessionId', 'mode', 'receiptWritten'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: `message delivered to ${value.targetRole === undefined ? '' : `role ${JSON.stringify(value.targetRole)} (`}`
        + `session ${value.targetSessionId}) via ${value.mode}; `
        + 'the receiving session starts now and its substantive reply, if any, will arrive later as a new message to you.',
    }],
  },
}

/**
 * 一键派卡：目标由**卡文件名**推导，指挥官不必指定窗口。
 *
 * 这是本插件的主推用法——把"派工单下发"从一个需要人工选目标的操作，变成
 * 一句"把这张卡派出去"。
 */
const dispatchTool = {
  name: TOOL_DISPATCH,
  description:
    'Dispatch a card (派工单) or report to the right window in one call, deriving the target from the '
    + 'filename. The default convention is that a card ends with "（<角色>窗口）" — for example '
    + '"2026-03-01-派工单-重构解析链（后端窗口）.md" targets the role "后端窗口". Pass just card_path '
    + 'and the tool reads the target off the filename; pass "to" to override it when the file does not '
    + 'follow that convention. The recipient is told to read the file first and starts working '
    + 'immediately. Use this instead of send_session_message whenever you are handing over a card.',
  parameters: {
    type: 'object',
    properties: {
      card_path: {
        type: 'string',
        description:
          'Path to the card or report file. Its trailing "（<角色>窗口）" is used as the target unless '
          + '"to" is given. Example: "cards/2026-03-01-派工单-重构解析链（后端窗口）.md".',
      },
      to: {
        type: 'string',
        description:
          'Optional explicit target (a role name or session id). Overrides the target derived from the '
          + 'filename. Needed only for files that do not follow the naming convention.',
      },
      message: {
        type: 'string',
        description:
          'Optional extra instruction to accompany the card (for example "按卡执行" or a specific '
          + 'correction). Keep it short — the card file itself is the authoritative task description.',
      },
      mode: {
        type: 'string',
        enum: ['queue', 'steer'],
        description: 'queue (default) starts a fresh turn for the target immediately; steer interrupts it at its next step.',
      },
      expect_receipt: {
        type: 'boolean',
        description: 'Whether to write a runtime delivery receipt into your own transcript (default true).',
      },
    },
    required: ['card_path'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        delivered: { type: 'boolean' },
        messageId: { type: 'string' },
        targetSessionId: { type: 'string' },
        targetRole: { type: 'string' },
        targetRoleFromFilename: { type: 'string' },
        cardReadableFromHere: { type: 'boolean' },
        mode: { type: 'string', enum: ['queue', 'steer'] },
        receiptWritten: { type: 'boolean' },
      },
      required: ['delivered', 'messageId', 'targetSessionId', 'mode', 'receiptWritten'],
    },
    render: (_args, value) => [{
      type: 'text',
      text: `card dispatched to ${value.targetRole === undefined ? '' : `role ${JSON.stringify(value.targetRole)} (`}`
        + `session ${value.targetSessionId}) via ${value.mode}; the window starts now`
        + `${value.cardReadableFromHere === false
          ? '. NOTE: this card is not readable from your side of the filesystem — do not try to quote it, and expect the window to read it from its own side'
          : ''}.`,
    }],
  },
}

/**
 * 注册四个工具。服务句柄在这里一次取到闭包里：工具的 `exec` 上没有 `ctx`。
 * @param ctx - 插件上下文。
 * @param config - 可选配置 `{ rolesFile? }`；`rolesFile` 覆盖角色名册位置
 *   （默认 `$DSH_HOME/session-relay/roles.json`），多套部署共用一台机器时可借它隔离。
 */
export function apply(ctx, config) {
  if (config?.rolesFile !== undefined) setRolesFile(config.rolesFile)

  const services = {
    get sessionController() { return ctx.get('sessionController') },
    get sessionQuery() { return ctx.get('sessionQuery') },
    get sessions() { return ctx.get('sessions') },
    get agents() { return ctx.get('agents') },
    get sessionProjections() { return ctx.get('sessionProjections') },
    get sessionProjectionCache() { return ctx.get('sessionProjectionCache') },
  }

  ctx.effect(
    () => ctx.tools.register({ ...listTool, execute: (args, exec) => listWorkspaceSessions(services, exec, args) }),
    'session-relay:list_workspace_sessions',
  )
  ctx.effect(
    () => ctx.tools.register({ ...registerTool, execute: (args, exec) => registerSessionRole(services, exec, args) }),
    'session-relay:register_session_role',
  )
  ctx.effect(
    () => ctx.tools.register({ ...sendTool, execute: (args, exec) => sendSessionMessage(services, exec, args) }),
    'session-relay:send_session_message',
  )
  ctx.effect(
    () => ctx.tools.register({ ...dispatchTool, execute: (args, exec) => dispatchCard(services, exec, args) }),
    'session-relay:dispatch_card',
  )
}

/* ------------------------------------------------------------------ 角色名册 */

/** 读角色名册；缺失或损坏一律当作空名册（不阻断任何工具）。 */
function loadRoles() {
  const file = rolesFile()
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 原子写角色名册：先写同目录临时文件再 `rename`，避免并发写者或中途崩溃留下半截 JSON
 * （半个文件会让下一次 `loadRoles` 整份丢弃，等于所有窗口的角色一起消失）。
 */
function saveRoles(roles) {
  const file = rolesFile()
  const dir = dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(roles, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/** 某个工作区（cwd）的角色表：`{ 角色名: { sessionId, description?, updatedAt } }`。 */
function rolesForWorkspace(cwd) {
  const all = loadRoles()
  const bucket = all[cwd]
  return bucket !== null && typeof bucket === 'object' ? { ...bucket } : {}
}

/** 反查某个会话在本工作区注册的角色名。 */
function roleOfSession(cwd, sessionId) {
  const table = rolesForWorkspace(cwd)
  for (const [role, entry] of Object.entries(table)) {
    if (entry?.sessionId === sessionId) return role
  }
  return undefined
}

/* ------------------------------------------------------------------ 角色注册 */

/**
 * 把一个会话登记为工作区内的某个稳定角色。
 * @param services - 插件作用域的服务句柄。
 * @param exec - 工具执行上下文。
 * @param args - 模型参数 `{ role, description? }`。
 * @returns 注册回执，含被顶替者与新释放的角色（若有）。
 */
async function registerSessionRole(services, exec, args) {
  const caller = requireCallerAgent(exec)
  const sessionId = String(caller.id)
  const cwd = caller.session.header.cwd
  if (cwd === undefined) {
    throw new Error(
      `${TOOL_REGISTER}: this session has no working directory, so it cannot register a workspace-scoped role.`,
    )
  }

  const role = typeof args?.role === 'string' ? args.role.trim() : ''
  if (role === '') throw new Error(`${TOOL_REGISTER}: role must be non-empty text`)
  if (role.length > 64) throw new Error(`${TOOL_REGISTER}: role must be at most 64 characters`)
  // 角色名会被拼进提示文本，禁止控制字符以免破坏收件方的消息结构。
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(role)) throw new Error(`${TOOL_REGISTER}: role must not contain control characters`)

  const description = typeof args?.description === 'string' ? args.description.trim() : undefined

  const all = loadRoles()
  const table = { ...(all[cwd] ?? {}) }

  const previousHolder = table[role]?.sessionId
  // 一个会话只保留一个角色：先把它旧的角色释放掉，避免同一会话挂多个名字。
  const releasedRole = (() => {
    for (const [name, entry] of Object.entries(table)) {
      if (entry?.sessionId === sessionId && name !== role) {
        delete table[name]
        return name
      }
    }
    return undefined
  })()

  table[role] = {
    sessionId,
    ...description === undefined ? {} : { description },
    updatedAt: Date.now(),
  }
  all[cwd] = table
  saveRoles(all)

  return {
    registered: true,
    role,
    sessionId,
    workspace: cwd,
    ...previousHolder !== undefined && previousHolder !== sessionId ? { previousHolder } : {},
    ...releasedRole === undefined ? {} : { releasedRole },
  }
}

/* ------------------------------------------------------------------ 发现实现 */

/**
 * 列出与调用方同工作区的其它会话（含冷会话），并标注各自注册的角色。
 * @param services - 插件作用域的服务句柄。
 * @param exec - 工具执行上下文，提供调用方 Agent 与取消信号。
 * @param args - 模型参数 `{ query?, limit? }`。
 * @returns 结构化清单，交给 `output.schema` 校验。
 */
async function listWorkspaceSessions(services, exec, args) {
  const caller = requireCallerAgent(exec)
  const callerId = String(caller.id)
  const callerCwd = caller.session.header.cwd

  const limit = normalizeLimit(args?.limit)
  const needle = typeof args?.query === 'string' ? args.query.trim().toLocaleLowerCase() : ''

  const records = await collectWorkspaceSessions(services, callerCwd, exec.signal)
  const table = callerCwd === undefined ? {} : rolesForWorkspace(callerCwd)
  const selfRole = callerCwd === undefined ? undefined : roleOfSession(callerCwd, callerId)

  const sessions = []
  for (const record of records) {
    const id = String(record.header.id)
    if (id === callerId) continue
    const role = callerCwd === undefined ? undefined : roleOfSession(callerCwd, id)
    const title = projectedTitle(services, record.header)
    if (needle !== '') {
      const haystack = [id, role ?? '', title ?? '', record.header.cwd ?? ''].join('\u0000').toLocaleLowerCase()
      if (!haystack.includes(needle)) continue
    }
    sessions.push({
      sessionId: id,
      ...role === undefined ? {} : { role },
      ...title === undefined ? {} : { title },
      status: liveStatus(services, id, record.live),
      ...Number.isSafeInteger(record.header.createdAt) ? { createdAt: record.header.createdAt } : {},
      ...record.header.parentSession === undefined
        ? {}
        : { parentSessionId: String(record.header.parentSession) },
    })
  }

  // 有角色的排前面（它们是可稳定寻址的目标），其次按创建时间倒序。
  sessions.sort((a, b) => (a.role === undefined ? 1 : 0) - (b.role === undefined ? 1 : 0)
    || (b.createdAt ?? 0) - (a.createdAt ?? 0))

  return {
    selfSessionId: callerId,
    ...selfRole === undefined ? {} : { selfRole },
    ...callerCwd === undefined ? {} : { workspace: callerCwd },
    total: sessions.length,
    sessions: sessions.slice(0, limit),
  }
}

/**
 * 收集同工作区的会话记录。优先用 sessionQuery（覆盖已持久化但未激活的冷会话），
 * 该服务缺席时退回只含活会话的 sessions 存储。
 * @param services - 插件作用域的服务句柄。
 * @param callerCwd - 调用方会话的工作目录；未定义时无法判定同工作区，返回空。
 * @param signal - 调用方取消信号。
 * @returns 会话记录列表（同 id 去重）。
 */
async function collectWorkspaceSessions(services, callerCwd, signal) {
  if (callerCwd === undefined) return []

  const byId = new Map()

  const sessionQuery = services.sessionQuery
  if (sessionQuery !== undefined) {
    const listed = await sessionQuery.listSessions(signal)
    for (const record of listed) {
      if (record?.header?.cwd !== callerCwd) continue
      byId.set(String(record.header.id), { header: record.header, live: record.live === true })
    }
    return [...byId.values()]
  }

  // 兜底：只有活会话。
  const store = services.sessions
  if (store !== undefined) {
    for (const session of store.list()) {
      if (session.header.cwd !== callerCwd) continue
      byId.set(String(session.id), { header: session.header, live: true })
    }
  }
  return [...byId.values()]
}

/**
 * 读取一个会话的标题。活会话从其投影热读；冷会话读持久化检查点，读不到就省略。
 * @param services - 插件作用域的服务句柄。
 * @param header - 会话头。
 * @returns 标题文本，或 `undefined`。
 */
function projectedTitle(services, header) {
  const id = String(header.id)
  try {
    const attached = services.sessions?.get(id)
    const projections = services.sessionProjections
    if (attached !== undefined && projections !== undefined) {
      const title = projections.snapshot(attached, ['title'])?.values?.title
      if (typeof title === 'string' && title !== '') return title
    }
    // 冷会话：只有持久化检查点能零 I/O 回答标题；fork 出来的会话没有可用检查点。
    if (header.isSeeded === true) return undefined
    const cached = services.sessionProjectionCache?.cachedSnapshot(header, 0, ['title'])?.values?.title
    if (typeof cached === 'string' && cached !== '') return cached
  } catch {
    // 投影读取是纯增强：任何失败都退化为"无标题"，不影响清单可用性。
  }
  return undefined
}

/**
 * 把一个会话的实时状态归类。
 * @param services - 插件作用域的服务句柄。
 * @param id - 会话 id。
 * @param live - 会话存储是否持有它。
 * @returns `running` / `idle` / `cold`。
 */
function liveStatus(services, id, live) {
  const agent = services.agents?.get(id)
  if (agent !== undefined) return agent.status === 'running' ? 'running' : 'idle'
  return live === true ? 'idle' : 'cold'
}

/* ------------------------------------------------------------------ 投递实现 */

/**
 * 把一条消息投递给同工作区的另一个会话（按角色或精确 id 寻址）。
 * @param services - 插件作用域的服务句柄。
 * @param exec - 工具执行上下文，提供调用方 Agent 与取消信号。
 * @param args - 模型参数 `{ to, message?, card_path?, mode?, expect_receipt? }`。
 * @returns 接受回执；对方的实质回复会作为新消息回到调用方。
 */
async function sendSessionMessage(services, exec, args) {
  const to = typeof args?.to === 'string' ? args.to.trim() : ''
  if (to === '') throw new Error(`${TOOL_SEND}: "to" is required (a role name or an exact session id)`)

  const text = typeof args?.message === 'string' ? args.message : ''
  const cardPath = typeof args?.card_path === 'string' ? args.card_path.trim() : ''
  if (text.trim() === '' && cardPath === '') {
    throw new Error(`${TOOL_SEND}: provide a non-empty "message", a "card_path", or both`)
  }

  return deliverMessage(services, exec, {
    to,
    text,
    cardPath,
    mode: args?.mode === 'steer' ? 'steer' : 'queue',
    expectReceipt: args?.expect_receipt !== false,
    tool: TOOL_SEND,
  })
}

/**
 * 派一张卡：**目标由卡文件名推导**，指挥官不必手工指定窗口。
 *
 * 这是"一键派卡"的封装。它只做三件额外的事，然后复用 {@link deliverMessage} 的
 * 全部校验与投递路径（作用域、越权、子代理、防失控、回执）：
 *   1. 从文件名推导目标角色（`…（后端窗口）.md` → `后端窗口`）；
 *   2. 推导不出时**明确报错**并要求人工指定，而不是猜一个窗口；
 *   3. 顺带探测卡在本机是否可读，把结论附在结果里（本工作区存在 DLP/双文件系统的
 *      "同一张卡在两侧可读性不同"的实际情况，这个提示能省掉一轮试错）。
 * @param services - 插件作用域的服务句柄。
 * @param exec - 工具执行上下文。
 * @param args - 模型参数 `{ card_path, message?, to?, mode?, expect_receipt? }`。
 * @returns 投递结果，另附 `targetRoleFromFilename` 与 `cardReadableFromHere`。
 */
async function dispatchCard(services, exec, args) {
  const caller = requireCallerAgent(exec)
  const callerCwd = caller.session.header.cwd

  const cardPath = typeof args?.card_path === 'string' ? args.card_path.trim() : ''
  if (cardPath === '') {
    throw new Error(`${TOOL_DISPATCH}: "card_path" is required (path to the 派工单/回报 file)`)
  }

  const explicitTo = typeof args?.to === 'string' ? args.to.trim() : ''
  const derived = targetRoleFromCardPath(cardPath)

  // 目标选择：显式指定优先；否则用文件名推导出的角色。两者都没有 ⇒ 报错，不猜。
  let to = explicitTo !== '' ? explicitTo : derived
  if (to === undefined || to === '') {
    const available = callerCwd === undefined ? [] : Object.keys(rolesForWorkspace(callerCwd))
    throw new Error(
      `${TOOL_DISPATCH}: cannot tell which window this card is for. The filename "${cardPath}" has no `
      + 'trailing "（<角色>窗口）" target, which is this workspace\'s convention. '
      + `Either rename the card to end with "（<角色>窗口）.md", or pass "to" explicitly. `
      + `Registered roles in this workspace: ${available.length === 0 ? '<none yet — each window must call ' + TOOL_REGISTER + ' once>' : available.join(', ')}.`,
    )
  }

  const text = typeof args?.message === 'string' ? args.message : ''

  // 卡若已在本工作区登记过角色，就直接按角色投——这是"一键"的常态路径。
  const result = await deliverMessage(services, exec, {
    to,
    text,
    cardPath,
    mode: args?.mode === 'steer' ? 'steer' : 'queue',
    expectReceipt: args?.expect_receipt !== false,
    tool: TOOL_DISPATCH,
  })

  return {
    ...result,
    ...derived === undefined ? {} : { targetRoleFromFilename: derived },
    cardReadableFromHere: cardIsReadable(callerCwd, cardPath),
  }
}

/**
 * 探测卡文件在**调用方这一侧**是否可读。
 *
 * 只当作**提示**而不是硬失败：多文件系统/容器环境里，同一份卡在不同侧的可读性可能不同
 * （一侧是密文或未挂载、另一侧是明文），卡真正的权威副本也可能在对面。返回 `false`
 * 只表示"发送方自己读不到这张卡，别指望它复述卡内容，让收件方从自己那侧读"。
 * @param cwd - 调用方工作区（相对路径的解析基准）。
 * @param cardPath - 卡路径，可能是相对路径，也可能是别的平台的绝对路径（如 `D:\…`）。
 * @returns 是否可读。
 */
function cardIsReadable(cwd, cardPath) {
  // Windows 绝对路径（带盘符）在 Linux 侧无法按原样解析，直接判不可读。
  if (/^[a-zA-Z]:[\\/]/.test(cardPath)) return false
  try {
    const absolute = isAbsolute(cardPath) ? cardPath : join(cwd ?? process.cwd(), cardPath)
    return existsSync(absolute)
  } catch {
    return false
  }
}

/**
 * 投递核心：所有校验与副作用都在这里，保证"发消息"与"派卡"走完全相同的路径。
 * @param services - 插件作用域的服务句柄。
 * @param exec - 工具执行上下文。
 * @param spec - 已归一化的投递规格 `{ to, text, cardPath, mode, expectReceipt, tool }`。
 * @returns 投递结果。
 */
async function deliverMessage(services, exec, spec) {
  const { to, text, cardPath, mode, expectReceipt, tool } = spec
  const caller = requireCallerAgent(exec)
  const callerId = String(caller.id)
  const callerCwd = caller.session.header.cwd

  if (text.length > MESSAGE_MAX_CHARS) {
    throw new Error(
      `${tool}: message is ${text.length} characters; the limit is ${MESSAGE_MAX_CHARS}. `
      + 'Hand over a long document by putting it in a file and passing "card_path" instead.',
    )
  }

  // 环路与失控保护（替代"接力深度"——那个会拦死本工作流的正常往返，见 MAX_AGENT_HOPS 注释）。
  const relay = relayState(caller)
  if (relay.agentHops >= MAX_AGENT_HOPS) {
    throw new Error(
      `${tool}: this workspace has exchanged ${relay.agentHops} consecutive session-to-session messages `
      + `without a human message in between (limit ${MAX_AGENT_HOPS}); refusing to continue automatically. `
      + 'This usually means two sessions are politely acknowledging each other in a loop. Report to the user '
      + 'and wait for their next instruction instead of sending another message.',
    )
  }

  // 回执永不触发回执：这是本插件唯一的绝对环路不变量。
  const itselfIsReceipt = relay.fromReceipt
  const wantReceipt = !itselfIsReceipt && expectReceipt

  // 子代理会话不得绕过父代理直接跨会话投递：仓库的既定原则是"子代理会话归
  // subagent 路由所有"（见 hasApiSessionSubagentOwner），其对外沟通应当走
  // send_message 回报父代理，由父代理决定是否转达。
  //
  // 判别只用 `origin === 'subagent'`：fork（分叉）出来的普通会话同样带 parentSession
  // 血缘，用它会把 fork 会话误判成子代理。本工作流的"实施窗口"都是用户手开的普通
  // 会话（已实测：origin 与 parentSession 均无），故不受此拦截影响。
  const header = caller.session.header
  if (header.origin === 'subagent') {
    const parentId = header.parentSession ?? '<parent id>'
    throw new Error(
      `${tool}: this session is a delegated subagent session, so it may not deliver to arbitrary `
      + `workspace sessions. Report to your parent with send_message({ agent_id: "${parentId}", ... }) instead.`,
    )
  }

  const sessionController = services.sessionController
  if (sessionController === undefined) {
    throw new Error(
      `${tool}: this deployment mounts no session controller, so cross-session delivery is `
      + 'unavailable. The web profile (@deepseek-ai/dsh-api-session-controller) provides it.',
    )
  }

  // 解析目标：先按角色在本工作区里查名册，查不到再当作精确 session id 处理。
  const resolved = resolveTarget(services, callerCwd, to)
  const targetId = resolved.sessionId
  if (targetId === callerId) {
    throw new Error(`${tool}: refusing to send a message to the calling session itself ("${callerId}")`)
  }

  exec.signal?.throwIfAborted()

  // resolveAgent 一次性完成：活会话直取 / 冷会话从持久化恢复 / 子代理会话拒绝。
  const found = await sessionController.resolveAgent(targetId)
  if (found.error !== undefined) {
    // 解析失败时**补一条更有用的线索**：若这个串既不是登记过的角色、也不像会话 id，
    // 那多半是把角色名写错了，而不是会话真的不存在。
    //
    // 注意顺序：这里**只增强错误信息，绝不据此提前拒绝**。先前版本用正则先判
    // "是不是 session id"，那会在遇到未预料到的 id 形态时**误拦合法投递**——
    // 让权威的 resolveAgent 先说话，才不会有假阴性。
    const hints = []
    if (resolved.viaRole === undefined && callerCwd !== undefined) {
      const available = Object.keys(rolesForWorkspace(callerCwd))
      if (!looksLikeSessionId(to)) {
        hints.push(`"${to}" is not a role registered in this workspace either.`)
      }
      hints.push(`Registered roles: ${available.length === 0
        ? `<none yet — each window must call ${TOOL_REGISTER} once>`
        : available.join(', ')}.`)
    }
    throw new Error(
      `${tool}: cannot deliver to session "${targetId}"${resolved.viaRole === undefined ? '' : ` (role ${JSON.stringify(resolved.viaRole)})`}: ${found.error.message}`
      + (hints.length === 0 ? '' : ` ${hints.join(' ')}`),
    )
  }
  const target = found.agent

  // 作用域：只允许同一工作区。cwd 缺失时无法证明同源，一律拒绝。
  const targetCwd = target.session.header.cwd
  if (callerCwd === undefined || targetCwd !== callerCwd) {
    throw new Error(
      `${tool}: session "${targetId}" is not in your workspace `
      + `(yours: ${callerCwd ?? '<unset>'}, target: ${targetCwd ?? '<unset>'}); cross-workspace delivery is not permitted.`,
    )
  }

  // 解析期间目标可能已被销毁——与 session/prompt 的同类检查一致。
  if (services.agents?.get(target.id) !== target) {
    throw new Error(
      `${tool}: session "${targetId}" was disposed during delivery admission; the message was not delivered.`,
    )
  }

  const message = createRelayMessage(services, caller, {
    text,
    cardPath,
    targetRole: resolved.viaRole,
  })
  if (mode === 'steer') target.steer(message)
  else target.followup(message)

  // 自动回执：以运行时回执写回**调用方自己的**会话日志。用 `inject`（不唤醒），
  // 因此不会打断调用方正在进行的这一轮，也不会引发新的模型轮次。
  let receiptWritten = false
  if (wantReceipt) {
    try {
      caller.inject(createReceiptMessage(target, resolved.viaRole, headLine(text, cardPath)))
      receiptWritten = true
    } catch {
      // 回执是增强项：写不进去不影响"消息已送达"这一事实，工具结果里如实反映。
      receiptWritten = false
    }
  }

  return {
    delivered: true,
    messageId: String(message.id),
    targetSessionId: targetId,
    ...resolved.viaRole === undefined ? {} : { targetRole: resolved.viaRole },
    mode,
    receiptWritten,
  }
}

/**
 * 粗判一个寻址串像不像 session id（`session-<uuid>` 或裸 uuid）。
 * 只用于区分"用户/模型写错了角色名"与"这是一个精确会话 id"，不做严格校验。
 * @param value - 寻址串。
 * @returns 是否像 session id。
 */
function looksLikeSessionId(value) {
  return /^session-[0-9a-f-]{8,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(value)
}


/**
 * 解析寻址串：优先当本工作区的角色名，其次当精确 session id。
 *
 * 角色匹配先试精确查表，再用 {@link sameRole} 做"去空白/大小写"级的归一化比较——
 * 因为文件名推导出的角色与名册里登记的写法可能有空格/全半角差异（实测卡名用
 * `（后端窗口）`，而登记时可能写成 `后端 窗口`）。
 * @param services - 插件作用域的服务句柄。
 * @param cwd - 调用方工作区。
 * @param to - 模型给出的寻址串。
 * @returns 目标 session id 与（若按角色命中）命中的角色名。
 */
function resolveTarget(services, cwd, to) {
  if (cwd !== undefined) {
    const table = rolesForWorkspace(cwd)
    const exact = table[to]
    if (exact?.sessionId !== undefined) return { sessionId: String(exact.sessionId), viaRole: to }
    for (const [role, entry] of Object.entries(table)) {
      if (entry?.sessionId !== undefined && sameRole(to, role)) {
        return { sessionId: String(entry.sessionId), viaRole: role }
      }
    }
  }
  return { sessionId: to }
}

/**
 * 构造一条带归属标记的转达消息。
 *
 * `form: 'relay'` 是仓库既有的 `ContextForm` 语义值——"一条别的 agent 发给这个 agent
 * 的消息"；`senderSessionId` 让 Web 端的 RelayBody 渲染出"来自会话 X"。这两点使消息
 * 在收件方的转录里既对模型可见，又不会被误记成用户发言。
 * @param services - 插件作用域的服务句柄。
 * @param caller - 发送方会话所属的活 Agent。
 * @param options - 正文、可选卡文件路径、目标角色（如有）、是否需要回执。
 * @returns 可直接交给 `followup`/`steer` 的不可变 user 消息。
 */
function createRelayMessage(services, caller, options) {
  const callerId = String(caller.id)
  const title = projectedTitle(services, caller.session.header)
  const callerRole = caller.session.header.cwd === undefined
    ? undefined
    : roleOfSession(caller.session.header.cwd, callerId)
  const label = [callerId, callerRole === undefined ? undefined : `role ${JSON.stringify(callerRole)}`,
    title === undefined ? undefined : `title ${JSON.stringify(title)}`]
    .filter(part => part !== undefined).join(', ')

  const blocks = [
    `[派工/消息] 来自同一工作区的会话 ${label}。`,
    '',
  ]
  if (options.cardPath !== '') {
    blocks.push(
      `🔴 先完整读取这张卡/文件，它是本次任务的唯一依据：\n    ${options.cardPath}`,
      '',
    )
  }
  if (options.text.trim() !== '') blocks.push(options.text, '')

  const reply = `send_session_message({ to: ${JSON.stringify(callerRole ?? callerId)}, ... })`
  blocks.push(
    '── 回信方式 ──',
    `收到后请先回一句「已收卡」（用 ${reply}），让我知道卡已经到你手上；`,
    '干完后把回报也发回同一个地址。回复是可选的，但本工作区的既有约定是「开工前先回报一句」。',
  )

  return freezeMessage({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: blocks.join('\n') }],
    source: {
      kind: RELAY_SOURCE_KIND,
      form: 'relay',
      senderSessionId: callerId,
      ...options.targetRole === undefined ? {} : { targetRole: options.targetRole },
      ...options.cardPath === '' ? {} : { cardPath: options.cardPath },
    },
  })
}

/**
 * 构造一条**运行时回执**：由插件撰写、写回发送方自己的日志。
 *
 * 刻意用 `form: 'notice'` 而不是 `relay`——回执不是收件方说的话，而是运行时对"投递
 * 已发生"这一事实的记录。仓库对这两者本就区分（见 `subagent-settled` 的注释：
 * "an Agent message is content the sender chose, while this message is the manager
 * stating what became of the child"）。Web 端会用 NoticeBody 折叠呈现。
 * @param target - 收件方 Agent。
 * @param targetRole - 收件方角色名（若有）。
 * @param summary - 一行摘要。
 * @returns 写入调用方日志的不可变 user 消息。
 */
function createReceiptMessage(target, targetRole, summary) {
  const targetId = String(target.id)
  return freezeMessage({
    id: randomUUID(),
    role: 'user',
    content: [{
      type: 'text',
      text: `[回执] 消息已送达${targetRole === undefined ? '' : `角色 ${JSON.stringify(targetRole)}（`}会话 ${targetId}`
        + `${targetRole === undefined ? '' : '）'}，对方已收到并开始处理。${summary === '' ? '' : `\n摘要：${summary}`}`,
    }],
    source: {
      kind: RECEIPT_SOURCE_KIND,
      form: 'notice',
      summary: `已送达 ${targetRole ?? targetId}`.slice(0, 120),
      targetSessionId: targetId,
      ...targetRole === undefined ? {} : { targetRole },
    },
  })
}

/**
 * 读取调用方的"转达状态"，一次扫描回答两个问题：
 *   - `fromReceipt`：日志里最后一条 user 消息是否是一条**运行时回执**（回执永不触发回执）；
 *   - `agentHops`：自最近一条**真人消息**以来，连续的 agent 之间消息条数（含回执）。
 * @param agent - 调用方 Agent。
 * @returns 转达状态；日志读不到时保守返回"非回执、0 跳"。
 */
function relayState(agent) {
  const fallback = { fromReceipt: false, agentHops: 0 }
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    let fromReceipt
    let hops = 0
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const kind = event.data?.source?.kind
      if (kind === 'user') break // 真人输入：预算到此重置。
      if (!OWN_KINDS.has(kind)) continue
      fromReceipt ??= kind === RECEIPT_SOURCE_KIND
      hops += 1
    }
    return { fromReceipt: fromReceipt === true, agentHops: hops }
  } catch {
    // 读不到日志就按"不是回执、不计数"处理：宁可少拦一次，也不要误拦正常协作。
    return fallback
  }
}

/** 取正文首行作为回执摘要。 */
function headLine(text, cardPath) {
  const source = text.trim() !== '' ? text.trim() : cardPath
  const first = source.split('\n', 1)[0] ?? ''
  return first.length > 100 ? `${first.slice(0, 99)}…` : first
}

/* ------------------------------------------------------------------ 小工具 */

/** 取调用方 Agent，缺失时报错（模型工具必须在 Agent 作用域内调用）。 */
function requireCallerAgent(exec) {
  const agent = exec?.agent
  if (agent === undefined) throw new Error('this tool requires a calling agent (exec.agent was undefined)')
  return agent
}

/** 归一化 limit 参数。 */
function normalizeLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) return LIST_DEFAULT_LIMIT
  return Math.min(value, LIST_MAX_LIMIT)
}

/** 深度冻结一个纯 JSON 消息（与会话日志的不可变约定一致）。 */
function freezeMessage(message) {
  const clone = structuredClone(message)
  deepFreeze(clone)
  return clone
}

/** 递归冻结普通对象/数组。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const key of Object.keys(value)) deepFreeze(value[key])
  return Object.freeze(value)
}

/** 把清单渲染成模型可读文本。 */
function renderSessionList(value) {
  const lines = [
    `Your session id: ${value.selfSessionId}`,
    value.selfRole === undefined
      ? `Your role: <none registered — call ${TOOL_REGISTER} so others can address you by name>`
      : `Your role: ${JSON.stringify(value.selfRole)}`,
    value.workspace === undefined ? 'Workspace: <unset>' : `Workspace: ${value.workspace}`,
    `Sessions in this workspace (excluding you): ${value.total}`,
  ]
  if (value.sessions.length === 0) {
    lines.push('', 'No other session in this workspace is reachable. Ask the user to open one, or use a subagent instead.')
    return lines.join('\n')
  }
  for (const session of value.sessions) {
    const parts = [`- ${session.sessionId}`]
    parts.push(session.role === undefined ? 'role=<none>' : `role=${JSON.stringify(session.role)}`)
    parts.push(`status=${session.status}`)
    if (session.title !== undefined) parts.push(`title=${JSON.stringify(session.title)}`)
    lines.push(parts.join('  '))
  }
  lines.push('', `Address one with ${TOOL_SEND}({ to: <role or session id>, message | card_path }).`)
  return lines.join('\n')
}
