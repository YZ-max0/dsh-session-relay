/**
 * session-relay（中文名：**驿传**）— 让同一工作区内的会话互相派工与回报（DSH 插件）
 *
 * 名字取自中国古代的接力传书体系：文书逐站传递、每站交接须回执。与本插件机制逐点
 * 对应——会话之间接力传递任务卡、每次投递自动写回执、按稳定"站名"（角色）寻址。
 * `relay` 本身也是"接力传递"，中英两名语义一致。
 *
 * 注：`session-relay` 是插件 id / npm 包名，必须保持 ASCII；`驿传` 是中文显示名。
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
 *    不变量保证：**回执永不触发回执**（回执只写本地、不发给任何人，故由构造保证）；
 *    另有一条失控保护：统计"自最近真人消息起、**与同一个对端**往复了多少条转达"，
 *    见 {@link MAX_AGENT_HOPS} 与 {@link relayState}。
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
 *   5. 回执不触发回执（由构造保证：回执只写本地日志，不投递给任何人）。
 *   6. 单方广播（指挥连派多张卡）不计入失控保护——保护只看**收到**多少条转达。
 *
 * 本插件只读写一个角色名册文件（`$DSH_HOME/session-relay/roles.json`）；
 * 不读环境变量、不发网络请求、不改任何既有工具的行为。
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

/**
 * Cordis 插件 id（必须 ASCII）。中文显示名为「驿传」，见模块顶部注释；
 * 它在 `cordis.patch.yml` 的 `id:` 与 npm 包名 `dsh-session-relay` 中都要保持一致。
 */
export const name = 'session-relay'

/** 只要工具注册表就绪即可激活；其余服务以 `ctx.get()` 可选取用并给出明确报错。 */
export const inject = ['tools']

/**
 * 模型可见的工具名。
 *
 * 一律用小写 ASCII 蛇形：工具名要进模型请求、进 JSON Schema、进 session log，
 * 保持 ASCII 可避免不同 provider/客户端在编码上的意外差异。**中文名只用于文档。**
 */
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
 * 无人介入时，允许**与同一个对端**完成的「往返」次数上限。
 *
 * ── 为什么要防 ──────────────────────────────────────────────────────────
 * "发完即自动开跑"意味着两个 AI 会话可以互相唤醒、**在无人看着的情况下持续烧 token**——
 * 一句「好的」被回一句「收到」就能无限循环。
 *
 * ── 为什么"收到多少条"不能当判据 ────────────────────────────────────────
 * 本工作流有三类**正常**的集中通信，按"收到量"计都会误伤（前两类已修，第三类最难发现）：
 *   ① 单方广播：指挥连派 N 张卡（自己的日志里 0 条转达）
 *   ② 扇形汇聚：N 个窗口各回报一次（每条来自**不同**会话，没有往复）
 *   ③ 🔴 **连派 N 张卡给同一个窗口**：该窗口"收到"N 条来自同一发送方的转达，
 *      按收到量计它就被禁言——**而它只是收，从未回过**。实测连派 16 张卡后，
 *      该窗口的回报被拒；派 20 张时它对任何目标都发不出话，直到真人在它那里说话。
 *      这恰好把本插件存在的意义（派工 → 回报）拦死了。
 *
 * ── 采用的判据：数「往返」，而不是数「收到」 ────────────────────────────
 * 对每个对端取 `min(我收到它几条, 我发给它几条)`，再取各对端的最大值。
 *   - 真人一次输入 ⇒ 重置预算
 *   - 本地写的**回执** ⇒ 提供"我发给了谁"的证据（回执写在发送方自己的日志里）
 *   - 只收不发（②③）⇒ `min(...) = 0` ⇒ **永不被拦**
 *   - 只发不收（①）⇒ 同上
 *   - 真正的 A↔B 乒乓 ⇒ 收与发同步增长 ⇒ 有限步内被掐断
 *
 * 上限取 16：足够覆盖一个卡周期内的多次往返，又远小于失控循环的规模。
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
          'queue (default) gives the message its own new turn for the target — right for handing over '
          + 'a dispatch card ("go do this now"). steer delivers at the target\'s next step boundary, '
          + 'where ALL steered messages enter context together in one step — right for reports, since '
          + 'with queue several windows reporting to one coordinator are admitted only one per turn '
          + '(measured: up to 65.8 minutes for the last one). steer does NOT interrupt work in '
          + 'progress; the target picks it up at its next step boundary.',
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
    'Hand over a file — a dispatch card (派工单) or a report (回报) — to the right window in one call, '
    + 'deriving the target from the filename. The convention is that such a file ends with '
    + '"（<角色>窗口）", for example "2026-03-01-派工单-重构解析链（后端窗口）.md". '
    + '⚠️ That bracket has two opposite meanings: on a DISPATCH CARD it names the RECIPIENT (pass just '
    + 'card_path), but on a REPORT it names who WROTE the file — so when you send your own report you '
    + 'MUST pass "to" (for example to: "指挥官助理") or the tool would address it back to you. '
    + 'The recipient is told to read the file first and starts working immediately. '
    + 'Use this instead of send_session_message whenever you are handing over a card or a report file.',
  parameters: {
    type: 'object',
    properties: {
      card_path: {
        type: 'string',
        description:
          'Path to the card or report file. For a DISPATCH CARD its trailing "（<角色>窗口）" names the '
          + 'recipient and is used as the target. Example: "cards/2026-03-01-派工单-重构解析链（后端窗口）.md". '
          + '⚠️ For a REPORT (回报) that bracket names who WROTE the file, so you must pass "to" yourself.',
      },
      to: {
        type: 'string',
        description:
          'Explicit target (a role name or session id). Overrides whatever the filename suggests. '
          + 'Required when sending a REPORT (回报/停手回报): a report filename\'s bracket names its '
          + 'author (probably you), not its destination — pass to: "指挥官助理" to send it back to '
          + 'whoever dispatched to you. Also use it for files that do not follow the naming convention.',
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
          description:
            'queue (default) gives the card its own new turn for the target — right here, because a '
            + 'dispatch should start a dedicated turn. steer delivers at the next step boundary, where '
            + 'all steered messages enter context together in one step — prefer it when the same '
            + 'message goes to several recipients and you want them to be seen together. steer does '
            + 'not interrupt work in progress.',
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

/**
 * 读角色名册。
 *
 * ⚠️ 关键区分：**"文件不存在"与"文件损坏"必须分开对待。**
 * 两者都读不出角色，但后果完全不同——
 *   - 不存在 ⇒ 全新环境，返回空名册，随后写入是**创建**。
 *   - 损坏   ⇒ 名册仍在磁盘上、只是这次读不出来。若也当成空名册，下一次
 *              `register_session_role` 就会把整份名册**覆盖掉**，所有窗口的角色
 *              一起消失，而且**没有任何提示**（实测：3 个角色一次性全丢）。
 * 所以损坏时抛错，让写路径**拒绝覆盖**、让读路径能如实告知用户。
 *
 * @returns 解析后的名册对象。
 * @throws 当文件存在但无法解析/不是对象时。
 */
function loadRoles() {
  const file = rolesFile()
  if (!existsSync(file)) return {}
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch (error) {
    throw new Error(`cannot read the role registry at ${file}: ${error.message}`)
  }
  // 空文件（或只有空白）**没有任何内容可丢** ⇒ 当作空名册，让下次写入直接把它修好。
  // 这与"损坏"不同：损坏的文件里可能存着全部角色的记录，覆盖它就是数据丢失。
  if (raw.trim() === '') return {}
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(
      `the role registry at ${file} is not valid JSON (${error.message}). `
      + 'Refusing to treat it as empty, because the next registration would overwrite it '
      + 'and all registered roles would be lost. Fix or delete the file, then retry.',
    )
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      `the role registry at ${file} is not a JSON object. Refusing to treat it as empty, `
      + 'because the next registration would overwrite it and all registered roles would be lost.',
    )
  }
  return parsed
}


/**
 * 读角色名册，**读不出来就当作空**——只给"能优雅降级"的只读路径用。
 *
 * 与 {@link loadRoles} 的区别：这里不抛错。用于**列清单/查角色名**这类场景——
 * 名册坏了顶多显示不出角色，绝不该让一个只读工具整体失败。
 * ⛔ **绝不可用于写路径**：那正是"静默清空名册"缺陷的成因。
 * @returns 名册对象；读不出时返回空对象，并附带失败原因供调用方提示。
 */
function loadRolesLenient() {
  try {
    return { roles: loadRoles(), error: undefined }
  } catch (error) {
    return { roles: {}, error: error.message }
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
  // 临时名带上 pid 与随机后缀：同一进程并发写、或多进程同时写，都不会互相踩到对方的临时文件。
  const tmp = `${file}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`
  try {
    writeFileSync(tmp, `${JSON.stringify(roles, null, 2)}\n`, 'utf8')
    renameSync(tmp, file)
  } catch (error) {
    // 写失败时清掉临时文件，别在目录里留垃圾（rename 成功则临时名已不存在）。
    try { rmSync(tmp, { force: true }) } catch { /* 清理失败无所谓，不影响正确性 */ }
    throw error
  }
}

  /**
   * 锁目录的陈旧阈值：超过此时长视为持有者已崩溃，允许抢占。
   *
   * ⚠️ 它必须 **明显大于** 正常临界段时长，又 **必须小于** {@link ROLES_LOCK_TIMEOUT_MS}：
   *  - 太大 ⇒ 持有者崩溃后要等很久才能自愈
   *  - 不小于等待上限 ⇒ 等待方在自己的时限内**永远等不到**那把锁变陈旧，
   *    自愈就成了空话（实测：刚创建的锁会让登记在 5s 后直接失败退出）
   * 临界段是一次 JSON 读 + 一次写，正常在毫秒级，2 秒已是极宽裕的余量。
   */
  const ROLES_LOCK_STALE_MS = 2_000

  /**
   * 等锁的最长时间；超过就放弃（宁可报错，也不要无限阻塞模型轮次）。
   * 必须 **大于** {@link ROLES_LOCK_STALE_MS}，否则一次调用内无法回收陈旧锁。
   */
  const ROLES_LOCK_TIMEOUT_MS = 10_000

/**
 * 判断一把锁是否可以安全抢占（持有者已崩溃）。
 *
 * 判据优先看**持有者进程是否还活着**（锁目录里记了 pid）：
 *   - `kill(pid, 0)` 抛 `ESRCH` ⇒ 进程不存在 ⇒ 持有者已死，可抢占。
 *   - 进程仍在 ⇒ **不抢占**，无论锁已经握了多久。只看时长会误伤"还活着但临界段偏慢"的
 *     持有者（大文件、网络盘），删掉它的锁等于让两个进程同时进临界段，丢失更新又回来了。
 *   - 读不到 pid（旧版本留下的锁、权限问题、pid 复用等无法判定）⇒ 退回 mtime 超时判断，
 *     保证一个崩溃的旧锁最终仍能自愈。
 *
 * 注意 pid 复用会让"进程还活着"成为假阳性——那只是让抢占更保守（宁可多等），
 * 不会破坏正确性；配合外层超时，最坏情况是明确报错而非静默错写。
 *
 * @param lockDir - 锁目录。
 * @param ownerFile - 记录持有者 pid 的文件。
 * @returns 是否可抢占。
 */
function isLockStealable(lockDir, ownerFile) {
  try {
    const raw = readFileSync(ownerFile, 'utf8').trim()
    const pid = Number.parseInt(raw, 10)
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0) // 只探测，不发信号。
        return false // 持有者活着。
      } catch (error) {
        if (error?.code === 'ESRCH') return true // 进程不存在 ⇒ 崩溃了。
        // EPERM 等：进程存在但不属于我们 ⇒ 保守起见不抢占。
        return false
      }
    }
  } catch { /* 读不到 pid：落到 mtime 判断 */ }
  try {
    return Date.now() - statSync(lockDir).mtimeMs > ROLES_LOCK_STALE_MS
  } catch {
    return false // 锁已经没了，下一轮直接拿。
  }
}

/**
 * 用 `mkdir` 的原子性做**跨进程**互斥，执行一次"读-改-写"。
 *
 * 为什么需要：`register_session_role` 是 read-modify-write，而 `$DSH_HOME` 是**机器级**的
 * ——同时开两个 profile（例如 web + headless）就是两个进程读写同一个 roles.json。
 * 两边各读到同一份旧内容、再各写回去，**后写的会覆盖先写的**（实测：两个进程各登记
 * 一个角色，最后只剩一个）。原子 rename 只能防"半截文件"，防不了"丢失更新"。
 *
 * 用目录而不是文件做锁：`mkdirSync` 在**已存在时会抛 EEXIST**，这是内核保证的原子判定，
 * 不需要 `O_EXCL` 之外的花招，且所有平台行为一致。
 *
 * 崩溃自愈：锁目录里写一个时间戳；若发现锁已过期（超过 {@link ROLES_LOCK_STALE_MS}），
 * 说明持有者已死，直接抢占——避免一个崩溃的进程把名册永久锁死。
 *
 * @param job - 持锁期间执行的函数；返回值原样传出。
 * @returns `job` 的返回值的 Promise。
 * @throws 等锁超时，或 `job` 自身抛错。
 */
async function withRolesLock(job) {
  const lockDir = `${rolesFile()}.lock`
  const ownerFile = join(lockDir, 'owner')
  const dir = dirname(lockDir)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const deadline = Date.now() + ROLES_LOCK_TIMEOUT_MS
  // ⚠️ 等待必须**异步**（`await` 定时器），绝不能用 `Atomics.wait` 之类的同步小睡：
  // 那是阻塞整个事件循环的——在一个 DSH 宿主里会连带冻住**所有**会话，而不只是这一次
  // 工具调用。锁的争用方是另一个**进程**，本进程让出事件循环完全无害。
  const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })
  for (;;) {
    try {
      mkdirSync(lockDir)
      // 记下持有者 pid：抢占判断以"持有者是否还活着"为主，而不是只看时长——
      // 只看 mtime 会把**还活着但临界段偏慢**的持有者（大文件/网络盘）误判成崩溃，
      // 删掉它的锁并双双进入临界段，丢失更新又回来了。
      try { writeFileSync(ownerFile, `${process.pid}\n`, 'utf8') } catch { /* 写不进就退回 mtime 判断 */ }
      break
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (isLockStealable(lockDir, ownerFile)) {
        try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* 别人先删了 */ }
        continue
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `timed out waiting for the role registry lock at ${lockDir}. `
          + 'Another DSH process may be holding it; if none is running, delete that directory.',
        )
      }
      await sleep(25)
    }
  }
  try {
    return await job()
  } finally {
    try { rmSync(lockDir, { recursive: true, force: true }) } catch { /* 释放失败由陈旧阈值兜底 */ }
  }
}

/** 某个工作区（cwd）的角色表：`{ 角色名: { sessionId, description?, updatedAt } }`。 */
function rolesForWorkspace(cwd) {
  // 只读路径：名册坏了顶多查不出角色，不该让整个工具失败。
  const { roles: all } = loadRolesLenient()
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
  // 拒绝"看起来像会话 id"的角色名：寻址时 `to` 既可能是角色名、也可能是精确 session id，
  // 若允许角色名长得像 id，就会**遮蔽**别人——实测登记角色 "session-worker-0" 后，
  // 发给 `session-worker-0` 的消息会被劫持到登记者那里，真正的那个会话一条都收不到。
  // 从源头禁止，比在解析时猜更安全，也更容易向用户解释。
  // 用**与寻址相同的归一化**来判断（去空白 + 小写），否则 "Session - Worker-0" 这种写法
  // 能绕过检查，却在 `sameRole` 里归一化成同一个串，照样遮蔽别人的 id。
  if (/^session-/.test(role.replace(/\s+/g, '').toLocaleLowerCase())) {
    throw new Error(
      `${TOOL_REGISTER}: role must not look like a session id (after removing spaces it starts `
      + 'with "session-"). Pick a human-readable window name instead, so addressing cannot be shadowed.',
    )
  }
  // `__proto__` 之类的原型键名：`table[role] = …` 会命中继承来的 setter，既不写入 own 属性、
  // 又让 JSON 少一个键 ⇒ 工具返回"登记成功"但文件里什么都没有（实测还会连带把该会话的
  // 旧角色删掉）。直接拒绝。
  if (role === '__proto__' || role === 'constructor' || role === 'prototype') {
    throw new Error(`${TOOL_REGISTER}: role must not be a JavaScript prototype key name ("${role}")`)
  }

  const description = typeof args?.description === 'string' ? args.description.trim() : undefined

  // 整个「读 → 改 → 写」都在跨进程锁内完成。若在锁外先读、只在写时加锁，两个进程仍会
  // 各持一份旧快照，后写的覆盖先写的（丢失更新）——那正是加锁要解决的问题。
  return await withRolesLock(() => {
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
  })
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

/**
 * 找出"最近给本会话派过工"的会话，作为回报的默认去向。
 *
 * 回报报错里如果说一个硬编码的角色名（如「指挥官助理」），在别的部署里可能根本不存在，
 * 等于把用户往第二次失败上引。而本插件其实**已经知道**是谁派工过来的——那条转达消息的
 * `senderSessionId` 就写在会话日志里。所以直接读出来，给出一个**当下一定可用**的地址。
 *
 * 先试 `senderSessionId`（精确、不依赖角色名册），再退回发送方登记的角色名（更好读）。
 * @param services - 插件作用域的服务句柄。
 * @param agent - 当前（要回报的）会话所属 Agent。
 * @returns 建议的 `to` 取值，以及它是不是一个角色名；找不到则为 undefined。
 */
function suggestReportTarget(services, agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      if (source?.kind !== RELAY_SOURCE_KIND) continue
      const senderId = source.senderSessionId
      if (typeof senderId !== 'string' || senderId === '') continue
      // 发送方登记过角色名的话，用角色名更好读，也更稳定（会话重建后仍可用）。
      const cwd = agent.session.header.cwd
      const role = cwd === undefined ? undefined : roleOfSession(cwd, senderId)
      return role === undefined
        ? { to: senderId, isRole: false }
        : { to: role, isRole: true }
    }
  } catch {
    // 读不到就退化为"不给出具体地址"，报错文案仍会说明该做什么。
  }
  return undefined
}

/**
 * 构造"你大概是要发回报"的那段指引。
 * @param services - 插件作用域的服务句柄。
 * @param agent - 回报的发出方（也就是自己）。
 * @returns 可直接拼进报错的指引文本。
 */
function reportHint(services, agent) {
  const suggestion = suggestReportTarget(services, agent)
  const tail = suggestion === undefined
    ? `Pass "to" explicitly with the role or session id of whoever dispatched to you `
    : `Pass "to": ${JSON.stringify(suggestion.to)} to send it back to the session that dispatched this task `
  return 'This looks like a REPORT (回报): a report filename\'s trailing bracket names who WROTE it '
    + '(you), not who receives it. '
    + tail
    + `(see ${TOOL_LIST}). `
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
    // 关键信号：目标是否**由文件名推导**而来。
    //
    // 这比"文件名里有没有『回报』二字"可靠得多：**只要推导出的目标恰好是调用方自己**，
    // 就一定是"这是一份回报"的情形——因为正常工作流里，没有人会把派工单发给自己。
    // （曾用文件名字符串嗅探，但文件名写法千变万化，靠不住；这条判据是结构性的。）
    targetDerivedFromFilename: explicitTo === '' && derived !== undefined,
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
  // `card_path` 同样进收件方的上下文，因此必须受同一个上限约束。
  // 早先只查了 `message`，于是 `card_path` 成了绕过上限的后门：实测传入 5 万字符的
  // 路径会被原样接受。虽然正常路径都很短，但"限额只管一半"本身就是漏洞。
  if (cardPath.length > MESSAGE_MAX_CHARS) {
    throw new Error(
      `${tool}: card_path is ${cardPath.length} characters; the limit is ${MESSAGE_MAX_CHARS}.`,
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

  // 回执永不触发回执 —— **由构造保证，无需代码抑制**。
  //
  // 回执只经 `caller.inject()` 写进**发送方自己的**会话日志（不唤醒、不产生新轮次），
  // 从不作为消息投递给任何人。收件方根本收不到回执，因此不存在"回执引发回执"的路径。
  //
  // 早先这里用「日志里最新一条自家消息是不是回执」来抑制后续回执，那是**错的**：
  // 回执是写在发送方本地的记录，于是**第一条回执一写下，闸门就永久 SUPPRESS**——
  // 之后每一次发送都被误判成"在响应回执"，静默地不再写回执。
  // 症状**不是固定值**：连派 N 张卡时是 **0~1 条**，取决于发送方此前有没有先回过话
  // （先回过「已收卡」⇒ 0 条；从未回过 ⇒ 至少第 1 条有）。
  const wantReceipt = expectReceipt

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
    // 这条报错最常见的成因**不是**"想发给自己"，而是"这是一份*回报*"：
    // 派工单文件名的括号标的是**收件人**（这卡给谁），而回报文件名的括号标的是
    // **作者**（谁写的）——同一个位置，两个相反的含义（见 README 的"回报方向"一节）。
    // 于是窗口回报时若只给 card_path，目标会被推导成它自己。
    //
    // 所以这里必须把"该怎么发回报"直接说出来：只说"不能发给自己"会让窗口一头雾水，
    // 它更可能换个文件重试或干脆放弃，而不是想到要补一个 `to`。
    //
    // 判定用两个信号，优先结构性信号：
    //   ① 目标**由文件名推导**且等于调用方自己 ⇒ 这必然是"我发的回报"（没人会派工给自己）；
    //   ② 否则退回文件名词嗅探（覆盖 send_session_message 里直接把回报文件名当 to 传的情况）。
    const derivedSelf = spec.targetDerivedFromFilename === true
    const looksLikeReport = derivedSelf
      || /回报|停手|report/i.test(String(to))
      || /回报|停手|report/i.test(String(cardPath ?? ''))
    throw new Error(
      `${tool}: refusing to send a message to the calling session itself ("${callerId}"). `
      + (looksLikeReport
        ? reportHint(services, caller)
        : 'A dispatch card\'s trailing bracket names the RECIPIENT, so if the file you are sending is '
          + 'your own report, that bracket is your own role and you must pass "to" explicitly instead. ')
    )
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
  // 形如 session id 的 `to` 一律**当字面 id 处理，不查角色表**。
  //
  // 否则角色名可以遮蔽别人的 id：实测登记一个叫 "session-worker-0" 的角色后，
  // `send_session_message({to:"session-worker-0"})` 会被投给登记者，真正的会话一条都收不到。
  // 归一化匹配尤其危险——"Session - Worker-0" 去掉空白并小写后也是 "session-worker-0"。
  // （注册侧同样禁止这类角色名，见 registerSessionRole；两处一起才既安全又好解释。）
  if (looksLikeSessionId(to)) return { sessionId: to }
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

  // 回信地址以**本块**为准：它由运行时在派工那一刻生成，反映"谁把这张卡派给你的"。
  // 卡片正文里若写死了别的收件人（例如"回报给指挥官助理"），那是卡作者的假设——
  // 卡被转发/转派后就不再成立。实测踩过：同一张卡被两个不同会话派发时，
  // 收件方拿到两个互相矛盾的回信地址，不知该听谁的。
  const replyTarget = JSON.stringify(callerRole ?? callerId)
  blocks.push(
    '── 回信方式 ──',
    // 刻意**不要求**收件方先回一句「已收卡」：插件在投递成功时已经自动写了一条
    // `form: 'notice'` 的运行时回执给发送方（见 createReceiptMessage）。再让收件方
    // 手工回一句，是**同一信息的第二份**。实测代价：一次 15 条的验证里，「已收卡」类
    // 占了 8 条（53%），而 P0 下每一条都要独占一个队列位、推迟真正的回报。
    `干完后把**结果**回报到 ${replyTarget}——**回报请带 mode（见下）**。`,
    `**不必**先回「已收卡」：投递成功时本插件已自动给你回执，再手工回一句是重复信息，`,
    '而每条重复消息都会独占收件方的一个队列位、推迟真正的回报。',
    '',
    '🔴 **回报请加 `mode: "steer"`**：',
    `    send_session_message({ to: ${replyTarget}, message: "…回报…", mode: "steer" })`,
    '原因：多条回报投给同一个会话时，默认的 `queue` 是**一轮只进一条**（DSH 的 `next-turn`',
    '语义），N 个窗口回报就要 N 轮，实测最慢 65.8 分钟才收到；`steer`（`next-step`）会让',
    '**多条在同一步一次性进入对方上下文**。`steer` 不会打断对方正在做的事——它只在对方',
    '下一个 step 边界被取走。',
    '',
    `（若这张卡需要中途同步进度，同样用上述写法；只是想打个招呼就不必发。）`,
    '',
    `🔴 **回信地址以本块为准**：${replyTarget} 就是**把这张卡派给你的那个会话**。`,
    '若卡片正文里写了别的收件人，那是卡作者原来的假设——卡可能被转派，所以以本块为准。',
    '',
    `⚠️ 若你改用 ${TOOL_DISPATCH} 发回报文件，**必须显式给 "to"**（例如 to: ${replyTarget}）：`,
    '回报文件名的括号标的是**谁写的**（也就是你自己），不像派工单那样标收件人——',
    '只给 card_path 会被解析成发给你自己。',
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
 * 读取调用方的"转达状态"：自最近一条**真人消息**以来，**与同一个对端**往复了多少条转达消息。
 *
 * 口径说明（三个反直觉但重要的选择，每一个都由真实故障换来）：
 *
 * 1. **只数 `session-relay`（别人发给我的转达），不数 `session-relay-receipt`（本地回执）。**
 *    回执是插件写进发送方自己日志的记账，不是任何一方的发言、也不发给任何人。
 *    若把回执也计入，**指挥连派 17 张卡就会被误拦**——而单方广播恰恰是本工作流的常态。
 *
 * 2. **只取"单个对端的最大条数"，不取总条数。**（真实故障：见下）
 *    要防的是"A 与 B 互相来回、无人看着烧 token"。但**扇形汇聚**——N 个窗口各回报一次——
 *    每条来自**不同**会话，根本没有往复。按总数计会把最正常的协作判成失控：
 *    实测一个 4 窗口的验证累计 14 条入站转达、正在逼近上限，而其中没有任何环路；
 *    一个协调方只要"连续听到 16 个窗口说话"就被禁言，**连回一句「收到」都做不到**，
 *    必须等真人开口才解封。故按发送方分组，只看**同一对端**的最大往复次数。
 *
 * 3. 因此计的是**收件量**，不是发包量。指挥派 100 张卡：自己日志里 0 条转达 ⇒ 不会被拦。
 *
 * @param agent - 调用方 Agent。
 * @returns `{ agentHops }`（最大单方往复数）；日志读不到时保守返回 0
 *   （宁可少拦一次，也不误拦正常协作）。
 */
function relayState(agent) {
  try {
    const events = agent?.session?.snapshotEvents?.() ?? []
    /** 自最近真人消息起，每个对端各发来多少条。 */
    const inbound = new Map()
    /** 自最近真人消息起，我各发给每个对端多少条（由本地回执反查）。 */
    const outbound = new Map()
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]
      if (event?.type !== 'user/message') continue
      const source = event.data?.source
      const kind = source?.kind
      if (kind === 'user') break // 真人输入：预算到此重置。
      if (kind === RELAY_SOURCE_KIND) {
        // 认不出发送方时退化成一个共享桶，仍能被计数（宁可保守，也不要漏计）。
        const sender = typeof source.senderSessionId === 'string' && source.senderSessionId !== ''
          ? source.senderSessionId
          : '<unknown>'
        inbound.set(sender, (inbound.get(sender) ?? 0) + 1)
      } else if (kind === RECEIPT_SOURCE_KIND) {
        // 回执是**我自己**的投递记录（写在发送方自己的日志里），因此它是"我发给了谁"的
        // 可靠来源，且不依赖任何外部状态。
        const peer = typeof source.targetSessionId === 'string' ? source.targetSessionId : undefined
        if (peer !== undefined) outbound.set(peer, (outbound.get(peer) ?? 0) + 1)
      }
    }
    // ⚠️ 只数"收到"是不够的——那会误伤**最正常的扇出**：指挥连派 N 张卡给**同一个**窗口时，
    // 该窗口自己就"收到"了 N 条来自同一发送方的转达，于是它**再也无法回报**
    // （实测：派 16 张卡 ⇒ 该窗口被禁言，而这正是本插件存在的意义）。
    //
    // 真正的失控环路必然是**往复**：收到它一条、又回它一条，如此反复。
    // 所以取 `min(收到, 发出)`——"只收不发"的收件方永不被拦，乒乓循环仍会在有限步内被掐断。
    let agentHops = 0
    for (const [peer, received] of inbound) {
      const sent = outbound.get(peer) ?? 0
      agentHops = Math.max(agentHops, Math.min(received, sent))
    }
    return { agentHops }
  } catch {
    return { agentHops: 0 }
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
