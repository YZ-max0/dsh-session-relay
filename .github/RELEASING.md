# 发布前检查清单（维护者用）

本文件面向仓库维护者，记录发版流程。

## 一次性准备

```bash
git init
git add -A
git commit -m "chore: initial commit"
git branch -M main
git remote add origin git@github.com:YZ-max0/dsh-session-relay.git
git push -u origin main
```

推送前**务必**先跑一次：

```bash
npm run check     # 含私有信息扫描：本机绝对路径 / 内网地址 / 硬编码凭据
npm test
git ls-files | grep -i private    # 应为空（.private/ 不得入库）
```

## 发版

1. 更新 `CHANGELOG.md`：把 `[Unreleased]` 的内容移到新的版本号下，补上日期，
   并更新文末的比较链接。
2. 同步版本号（两处必须一致）：

   ```bash
   # package.json 的 "version"
   # CHANGELOG.md 的版本标题
   grep -n '"version"' package.json
   head -20 CHANGELOG.md
   ```

3. 跑全套检查并提交：

   ```bash
   npm run check && npm test
   git add -A
   git commit -m "chore(release): vX.Y.Z"
   ```

4. 打标签并推送：

   ```bash
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin main --follow-tags
   ```

5. 在 GitHub 上基于该标签创建 Release，正文直接引用 `CHANGELOG.md` 对应小节。

## 版本号怎么定

- **patch**：修 bug、改文案、补测试。
- **minor**：新增工具或参数、放宽限制（如把 `MAX_AGENT_HOPS` 做成可配）。
- **major**：改动既有工具的参数或返回结构、收紧安全边界、变更角色名册格式。
  注意 DSH 会按工具名与参数 schema 与模型交互，**改参数名等于破坏性变更**。

## 需要注意的兼容性

- `dsh.engines.dsh`（`package.json`）声明所需的最低 DSH 版本。若用到了新的
  DSH API，请同步抬高它。
- 插件依赖 `ctx.sessionController.resolveAgent()`。若某个 DSH 版本没有装载
  `@deepseek-ai/dsh-api-session-controller`，投递会给出明确错误而非静默失败——
  这一点有测试覆盖，发版时不必重复验证。
