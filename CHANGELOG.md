# Changelog

本项目的所有重要变更都记录在这里。
格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [0.1.0] — 2026-03-01

首个可用版本。

### 新增

- **跨会话投递**：同一工作区内的会话可以互相发送消息。基于 DSH 既有的
  `Agent.followup()` / `Agent.steer()` 与 `ctx.sessionController.resolveAgent()`，
  不引入任何新传输。
- **`dispatch_card`（一键派卡）**：目标由卡文件名末尾的 `（<角色>窗口）` 推导，
  无需手工指定窗口；推导不出时明确报错而非猜测；`to` 参数可覆盖。
- **`register_session_role`**：把会话登记为工作区内的稳定角色名，使指挥会话可以
  按「后端窗口」这类名字寻址，而不是凭一串 session id。角色按 `cwd` 分区，
  跨工作区不泄漏。
- **`list_workspace_sessions`**：列出同工作区会话（含已持久化但未激活的冷会话），
  标注各自角色与 `running | idle | cold` 状态；有角色的排在前面。
- **`send_session_message`**：底层发信，支持按角色名或 session id 寻址，
  可附带 `card_path` 让对方先读文件。
- **自动投递回执**：投递成功后以 `form: 'notice'` 写回**发送方自己**的会话日志，
  用 `inject` 注入（不唤醒、不额外消耗模型轮次）。
- **消息归属标记**：转达消息使用 DSH 既有的 `form: 'relay'` 语义值，
  Web 端因此能用现成的 `RelayBody` 渲染"来自会话 X"，**客户端零改动**。

### 安全

- 作用域限于同一 `cwd`；`cwd` 缺失一律拒绝（无法证明同源）。
- 拒绝向自己发送。
- 拒绝子代理会话（判别只用 `origin === 'subagent'`，因为 fork 会话同样带
  `parentSession` 血缘，用它判别会误伤 fork）。
- 角色名拒绝空值、控制字符与超长名称。
- 角色名册原子写入（临时文件 + `rename`），避免并发写者留下半截 JSON。

### 环路与失控保护

- **回执永不触发回执**：唯一的绝对环路不变量。
- **连续跳数上限 16**：自最近一条真人消息以来累积的会话间消息条数；真人输入
  重置预算，因此正常的多卡协作不受影响，而无人看着的"收到/好的"死循环会在
  有限跳数内被掐断。
- 刻意**不做**接力链深度限流：指挥 ↔ 窗口的长期往返是正常协作，
  深度上限会在第 3 轮就拦死流程。

### 修复

- 修正 `dispatch_card` 的 `card_path` 参数上残留的属性级 `required: true`
  （`defineTool` 的写法，DSH 的 schema 校验会拒绝），并加入静态检查防止复发。
- 四个工具的 `parameters` 全部补上 `additionalProperties: false`，
  使模型拼错参数名时得到明确的拒绝，而不是被静默忽略。

[Unreleased]: https://github.com/YZ-max0/dsh-session-relay/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/YZ-max0/dsh-session-relay/releases/tag/v0.1.0
