# 贡献指南

**dsh-session-relay · 驿传** —— 让 DSH 里同一工作区的会话互相派工与回报。

感谢有兴趣改进这个项目。它很小，规则也很简单。

> 命名约定：`驿传` 是中文显示名；npm 包名（`dsh-session-relay`）、cordis 插件 id
> （`session-relay`）、工具名一律保持 **ASCII** —— 它们要进 npm registry、YAML 配置、
> 模型请求与 JSON Schema，非 ASCII 会带来不必要的编码风险。新增文档时请沿用此约定。

## 开发环境

**不需要 `npm install`** —— 本项目运行时零依赖，测试只用 Node 内置的 `node:test`。

```bash
node --version        # 需要 >= 20
npm test              # 单元测试
npm run check         # 静态一致性检查 + 私有信息扫描
```

若本机装了 DSH，可以让集成测试也跑起来（否则它们自动跳过）：

```bash
DSH_MODULE_ROOT=~/.dsh/profiles/web npm test
```

## 改代码前请先读

1. **`README.md` 的「设计要点」** —— 特别是"环路安全：为什么不是限深"。
   这里有两个方向相反的要求（长期往返必须通畅 / 无人循环必须掐断），
   改动前请先理解现有判据为什么长这样。
2. **`session-relay.mjs` 顶部的模块注释** —— 记录了复用而非新造的清单，
   以及两个容易踩的 DSH API 坑。

## 硬性约定

### 保持零依赖

运行时不得引入任何 npm 依赖。插件通过**文件绝对路径**加载时，其所在目录不一定有
`node_modules`，任何裸导入都会 `ERR_MODULE_NOT_FOUND`。只用 `node:` 内建模块。

### 工具 schema 是手写的，必须实际验证

`parameters` 与 `output.schema` 是**原始 JSON Schema**：

- 必填项写成顶层 `required: [...]` 数组；
- **不要**用 `defineTool` 那种属性级 `required: true`（DSH 会拒绝）；
- 每个 object 都要显式声明 `additionalProperties`。

`npm run check` 会静态校验这些。**这类错误过得了 `node --check`，也过得了不建真实
注册表的单元测试**，只在用户装载时才炸——所以请务必跑 `check`。

### 插件必须是"函数插件"形态

命名导出 `name` / `inject` / `apply`，并且**不能有 default export**。
DSH 的 Loader 在两者并存时会丢掉 `inject`。`npm run check` 会检查这一点。

### 新增行为要带测试

测试用 `tests/helpers.mjs` 里的假宿主（模拟插件真正接触的那几个面）。
对于"必须拒绝"的路径（越权、作用域、自相矛盾输入），请**同时**写下拒绝的断言——
这类 bug 静默且危险。

## 提交前

```bash
npm run check && npm test
```

若改了用户可见的行为，请更新：

- `README.md`（如果影响用法或限制）
- `CHANGELOG.md`（在 `[Unreleased]` 下加一条）

## 提交信息

用一句话说清"**为什么**改"，而不只是"改了什么"。若修了 bug，请说明它原本会造成什么后果。

## 不要提交

`.private/` 目录（已在 `.gitignore` 中）用于记录**特定部署**的真实用法，
里面的项目名、卡号与内网路径不应公开。CI 会检查它未被追踪。

## 报告问题

请附上：

- DSH 版本与 profile（`dsh --version`，profile 名）
- 复现步骤，最好是最小的
- 实际结果与期望结果
- 相关工具的原始返回值或错误文本

若涉及"消息发错窗口"，请**同时给出卡的文件名**——目标是从文件名推导的，
文件名本身就是关键证据。
