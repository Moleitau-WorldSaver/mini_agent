# Issue Tracker：本地 Markdown

本仓库的 Issue 与 Spec 以 Markdown 文件存放在 `.scratch/` 下，不使用外部 Issue Tracker。

## 约定

- 每个特性一个目录：`.scratch/<feature-slug>/`
- Spec：`.scratch/<feature-slug>/spec.md`
- 实现 Issue：一 ticket 一文件，`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号；不要写成单个合并的 tickets 文件。
- triage 状态记录在每个 issue 文件靠上的 `Status:` 行（角色字符串见 `triage-labels.md`）。
- 评论与对话历史追加到文件末尾的 `## Comments` 标题下。

## 当技能要求"发布到 Issue Tracker"

在 `.scratch/<feature-slug>/` 下创建新文件；必要时创建目录。Spec 发布为 `spec.md`，实现 Issue 发布到 `issues/`。

## 当技能要求"读取相关 ticket"

读取给定路径的文件；用户通常会直接提供路径或编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**地图**是一个文件，每个子 ticket 一个文件。

- **地图**：`.scratch/<effort>/map.md`，包含 Notes / Decisions-so-far / Fog 正文。
- **子 ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文放问题。`Type:` 行记录类型（`research` / `prototype` / `grilling` / `task`）；`Status:` 行记录 `claimed` / `resolved`。
- **阻塞**：靠上的 `Blocked by: NN, NN` 行。所列文件全部 `resolved` 时该 ticket 解锁。
- **Frontier**：扫描 `issues/` 中开放、未阻塞、未认领的文件，编号最小者优先。
- **认领**：开工前把 `Status` 设为 `claimed` 并保存。
- **解决**：在 `## Answer` 标题下追加答案，把 `Status` 设为 `resolved`，并向 `map.md` 的 Decisions-so-far 追加一条上下文指针（摘要 + 链接）。
