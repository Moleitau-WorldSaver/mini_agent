# Mini Agent

一个不依赖任何 agent 框架的最小可用 agent runtime：自研 Turn/Step 循环、工具注册与执行、Session 隔离与持久化、Context 压缩、异常处理与结构化 Trace，模型侧使用 DeepSeek 原生 function calling。

## 特性

- **原生工具调用**：LLM 依据工具 schema 自主决策，Runtime 解析思考、工具调用与最终答案。
- **四个工具**：`calculator`、`search`（mock）、`weather`（mock）、`todo`（会话级状态）。
- **Session 隔离**：不同窗口互不影响，JSON 文件持久化，可随时恢复。
- **Context 管理**：步数上限、token 预算、摘要式压缩、多轮追问。
- **可观测**：每会话 JSONL Trace，记录每一步的模型与工具调用；`--verbose` 查看思考过程。
- **确定性测试**：FakeLLM 驱动，CI 不访问真实模型。

## 环境要求

- Node.js ≥ 20
- DeepSeek API Key

## 快速开始

```powershell
npm install
$env:DEEPSEEK_API_KEY = "sk-..."
npm run dev
```

恢复或指定会话：

```powershell
npm run dev -- --session w1
```

列出会话：

```powershell
npm run dev -- --list
```

## 命令与参数

| 命令 / 参数 | 说明 |
|---|---|
| `agent` | 新建会话 |
| `agent --session w1` | 恢复或新建会话 `w1` |
| `agent --list` | 列出会话 |
| `agent --no-think` | 新会话关闭思考模式 |
| `agent --no-compress` | 关闭摘要压缩触发 |
| `agent --verbose` | 显示思考内容、工具参数与结果 |
| `agent --help` | 帮助 |

会话内命令：`/help`、`/exit`、`/new`、`/switch <id>`、`/todos`。

## 会话与交互

- `--session <id>` 恢复或新建；id 只允许 1–32 位字母、数字、下划线或连字符。
- `/new [id]` 新建并切换，`/switch <id>` 切换；切换后历史与待办只属于目标会话。
- 轮次进行中按 Ctrl+C 取消当前轮并回到提示符；提示符处按 Ctrl+C 退出。
- 同一会话被另一个进程占用时会提示"会话正在使用"；陈旧锁会在 10 分钟后自动接管。
- `--list` 只读本地会话文件，不需要 API 密钥。

## 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 无（必填） | API 密钥 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 兼容端点 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 模型名 |
| `MINI_AGENT_MAX_STEPS` | `8` | 每轮步数上限 |
| `MINI_AGENT_CONTEXT_TOKENS` | `32768` | 压缩触发预算 |
| `MINI_AGENT_KEEP_RECENT` | `8` | 压缩后保留原文条数 |
| `MINI_AGENT_THINKING` | `on` | 新会话是否开启思考 |
| `MINI_AGENT_MAX_TOKENS` | `8192` | 单次输出上限 |
| `MINI_AGENT_DATA_DIR` | `./data` | 数据根目录 |
| `MINI_AGENT_LOCK_STALE_MS` | `600000` | 锁过期时间 |

## 数据位置

- 会话：`data/sessions/<id>.json`
- 轨迹：`data/traces/<id>.jsonl`
- 锁：`data/sessions/<id>.lock`

会话文件包含消息、待办、摘要、模型与思考模式；Trace 只追加，不回流 Context。`DEEPSEEK_API_KEY` 不会写入任何文件。

## 测试

```powershell
npm test
npm run typecheck
```

测试使用 FakeLLM 与假 `fetch`，不需要 API Key，也不会访问网络。用例矩阵见 [docs/test-plan.md](docs/test-plan.md)。

## 手动冒烟清单（需要真实 API）

1. 问"杭州天气怎么样？"——应调用 `weather` 并回答温度。
2. 说"记个待办：周五交周报"，再问"我有哪些待办？"——两轮都应调用 `todo`。
3. 开两个终端分别使用 `--session w1` 与 `--session w2`——待办与历史互不可见。
4. 加 `--verbose` 运行一轮——终端应显示思考内容，且不出现 HTTP 400。

## 故障排查

- **会话正在使用**：另一个进程持有 `data/sessions/<id>.lock`。确认无进程运行后删除该锁文件，或等待 10 分钟自动过期。
- **会话文件损坏**：程序不会覆盖损坏文件。请换一个新的 `--session` id，或手动修复 JSON。
- **HTTP 400 且与思考相关**：说明 provider 的回传规则与文档不一致，参见 [ADR-0002](docs/adr/0002-thinking-and-context.md)；可先用 `--no-think`（新会话）规避。
- **401 / 403**：检查 `DEEPSEEK_API_KEY` 与 `DEEPSEEK_BASE_URL`。

## 文档

- [设计文档](docs/design.md)
- [测试计划](docs/test-plan.md)
- [词汇表](GLOSSARY.md)
- [ADR-0001：原生工具调用](docs/adr/0001-native-tool-calling.md)
- [ADR-0002：思考模式与 Context](docs/adr/0002-thinking-and-context.md)
