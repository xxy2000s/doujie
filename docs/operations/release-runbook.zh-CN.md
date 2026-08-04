# 豆姐发布手册

状态：生效中

本文档是豆姐版本与发布流程的事实来源。非发布型检查脚本负责机械验证；AI 或运维人员仍负责授权确认、生产判断、部署和回滚。该脚本不安装依赖、不修改受 Git 跟踪的文件或引用、不推送、不切换分支，也不重启服务；其中的构建门禁可能刷新已被忽略的 `dist/` 输出。

## 发布模型

- `master` 是完整开发主线；
- `release` 精确指向获准部署的生产提交；
- `vX.Y.Z` 是不可变 annotated tag；
- `CHANGELOG.md` 保存长期版本变化；
- GitHub Release 是可选展示层，tag 才是版本身份；
- Trellis QA 保存本次迭代的审查和 E2E 证据。

版本遵循语义化版本：不兼容变化升 major，向后兼容能力升 minor，向后兼容修复或部署兼容调整升 patch。

## 硬规则

1. 工作区不干净、代码未审查时禁止打 tag；
2. 生产同构的依赖安装、测试和构建预检通过前，禁止创建不可变 tag；
3. `package.json`、`CHANGELOG.md` 与目标 tag 的版本必须一致；
4. 使用 Node 20 和仓库固定的 pnpm。必须先调整 `PATH`，只调用 Corepack 绝对路径不能保证其 shebang 使用 Node 20；
5. 存在主控回合或 Codex 子进程时禁止重启；
6. 禁止覆盖服务器未跟踪文件。先识别和保留；只有证实为工具生成冲突后，才能备份到带时间戳的临时文件；
7. push、推进 `release`、生产重启和回滚必须取得用户明确授权；
8. 任一门禁失败即停止，不能把部分部署报告为成功。

## 第一阶段：准备发布提交

1. 完成并归档 Trellis 任务，QA 证据必须脱敏；
2. 根据兼容性影响选择版本号；
3. 更新 `package.json` 和带日期的 `CHANGELOG.md`；
4. 确认 `pnpm-workspace.yaml` 只授权必要的依赖构建脚本；
5. 提交发布元数据，此时暂不打 tag。

在干净的发布提交上运行：

```bash
pnpm release:check -- --version X.Y.Z
```

可选的服务器只读环境检查：

```bash
pnpm release:check -- --version X.Y.Z --remote seed
```

远程检查不会 fetch、安装依赖、构建、切分支或重启服务。

## 第二阶段：生产同构预检

打 tag 前，必须在隔离 checkout 或服务器临时 worktree 中验证目标提交，不能在在线服务目录中预检。

要求：

```text
Node 20
仓库固定版本的 pnpm
frozen-lockfile 安装成功
原生依赖构建成功
typecheck/test/build 全部通过
在线服务未被修改或重启
```

Linux 必须先设置 PATH：

```bash
export PATH=/opt/node20/bin:$PATH
node --version
pnpm --version
CI=true pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
```

把提交、Node/pnpm 版本、测试数量、构建结果和临时目录清理结果写入 Trellis QA。

## 第三阶段：审查与授权

1. 对发布 diff 做独立代码审查；
2. 扫描凭证、真实飞书 ID、token、私钥、数据库、日志和本地配置；
3. 向用户报告版本、提交、Changelog 摘要、预检证据、部署目标和回滚提交；
4. 获取针对具体 push 和部署动作的明确授权。

## 第四阶段：发布

annotated tag 应包含变更摘要和验证结果：

```bash
git tag -a vX.Y.Z -m "Doujie vX.Y.Z

Highlights:
- <主要变化>

Verification:
- typecheck passed
- tests passed
- production preflight passed

See CHANGELOG.md for details."
```

只推送用户批准的引用：

```bash
DOUJIE_ALLOW_PUSH=1 git push origin master
DOUJIE_ALLOW_PUSH=1 git push origin vX.Y.Z
git branch -f release master
DOUJIE_ALLOW_PUSH=1 git push origin release
```

发布后运行：

```bash
pnpm release:check -- --phase published --version X.Y.Z
```

本机 `gh` 已登录时，再根据对应 Changelog 创建 GitHub Release；不要为了自动化暴露凭证。

## 第五阶段：部署

操作在线目录前必须确认：

1. 没有活动 Codex 子进程或未终态主控任务；
2. 在线分支为 `release`；
3. 已检查 `git status --short` 并保留无关文件；
4. `PATH` 中优先解析 Node 20 和固定 pnpm；
5. 已登记上一生产提交作为回滚点。

随后从独立运维 shell 执行 fast-forward、依赖安装、测试、构建和重启。遵守[重启安全](./runbook.md#restart-safety)，禁止让豆姐当前回合重启自己。

## 第六阶段：验证

必须验证：

- 生产 HEAD、`origin/release` 和 tag 一致；
- package 版本与 tag 一致；
- daemon 的用户、目录和状态正确；
- 只有一个事件 listener；
- startup doctor 和 WebSocket 连接成功；
- `/status` 正常；
- 普通 Codex 冒烟回复准确且不包含 `/detail` 工具噪声；
- 输出模式符合预期；
- 日志没有新增未捕获异常、双 listener 或身份泄露。

如果 user OAuth 无法主动发送测试消息，必须把真实飞书 E2E 标记为未完成并要求人工发送；bot 自发自收不能作为证据。

## 回滚

回滚是新的授权部署动作，不是临时 reset：

1. 找到上一已验证 tag/提交；
2. 证明运行数据和 schema 兼容；
3. 经授权后把 `release` 指向回滚提交；
4. 重跑安装、测试和构建；
5. 从外部 shell 重启；
6. 验证 daemon、listener、日志、`/status` 和 Codex；
7. 在事故或发布任务中记录原因和证据。

禁止使用 `git reset --hard`、删除运行数据或按命令名批量杀进程来替代回滚。
