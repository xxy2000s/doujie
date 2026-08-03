# 文档生命周期

状态：生效中
最后更新：2026-08-02

豆姐把不同类型的知识放在不同位置，避免稳定事实、历史证据、待开发事项和单次实现方案互相竞争“唯一事实来源”。

## 文档分类

| 位置 | 用途 | 更新规则 |
|---|---|---|
| `README.md` | 帮助人最快理解和运行项目 | 保持简洁、准确 |
| `AGENTS.md` | Agent 维护项目时不可违反的运行与安全规则 | 系统约束变化时更新 |
| `docs/architecture/` | 已交付系统当前如何工作 | 功能正式交付后更新 |
| `docs/decisions/` | 为什么作出重要长期决策 | 新增 ADR；用 superseded 表示替代，不改写历史 |
| `docs/deployment/` | 当前支持的部署流程 | 部署行为变化时更新 |
| `docs/operations/` | 当前可执行的检查、恢复和 E2E 流程 | 保持可执行；历史原因链接 Incident |
| `docs/incidents/` | 有证据的生产或运维事故 | 除事实纠正外保留历史原貌 |
| `docs/security/` | 信任边界、权限和敏感信息规则 | 权限或暴露面变化时复核 |
| `docs/ai-governance/` | AI 权限、证据、模型/工具策略和生命周期治理 | Agent 自主范围或开发政策变化时复核 |
| `backlog/confirmed-limitations/` | 已确认但尚未交付的问题 | 聚焦问题；实现开始后链接 Trellis task |
| `.trellis/tasks/` | 单次迭代的需求、设计、实现、Review 和验证 | 任务进行期间是实现规格的唯一事实来源 |
| `.trellis/spec/` | 项目级、可复用的开发规范 | 只有产生可复用知识时更新 |
| `brainstorm/` | 尚未确认的本地想法 | Git 忽略；确认后再主动晋升 |

## 知识流转

```text
brainstorm
  -> confirmed limitation 或 ADR 候选
  -> 用户批准实现后创建 Trellis task
  -> 代码 + 稳定文档 + ADR 更新
  -> Trellis 任务归档和验证证据
```

事故走独立路径：

```text
真实事故
  -> docs/incidents 复盘
  -> runbook 当前安全规则
  -> confirmed limitation
  -> Trellis 修复任务
```

## 唯一事实来源规则

1. 已交付运行行为以代码、测试、`AGENTS.md` 和稳定架构/运维文档为准。
2. ADR 记录决策及其后果，不证明功能已经实现。
3. Backlog 记录未解决问题，不能声称功能已经存在。
4. Trellis task 启动后，详细实现设计放在该任务中，不在 Backlog 复制第二份规格。
5. 验证证据放在活动或归档的 Trellis task 中；稳定文档只总结行为，不复制临时 ID 和日志。
6. 当前 PID、分支领先数、CLI 更新提示、OAuth 到期时间、远程 daemon 状态等快变信息必须实时查询，不手工写入长期文档。
7. 任何文档都不得保存凭证、Token、事件 ticket、真实聊天/用户 ID、完整 Prompt 或会话正文。

## 必要元信息

ADR 和 Incident 应在标题后标明状态与日期。Backlog 必须明确标注“尚未交付”。决策发生变化时新增 ADR，并把旧 ADR 标记为 `Superseded by ADR-NNNN`，不要改写当时的决策历史。

## 任务完成检查

关闭非简单 Trellis task 前检查：

- 稳定架构或运维文档是否需要更新；
- 是否产生需要 ADR 的重要决策；
- 是否发生需要复盘的真实事故；
- 对应 Backlog 能否关闭、缩减或链接归档任务；
- 是否产生应写入 `.trellis/spec/` 的可复用规则；
- 所有链接是否有效，敏感信息扫描是否通过。
