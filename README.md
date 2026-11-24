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

## 密钥

优先读取 `DEEPSEEK_API_KEY`。如果没有设置，启动时会先说明配置方式，并在终端里交互式要求输入密钥：输入不会回显，仅本次运行有效，不会写入磁盘。输入后继续本次运行，不需要重启。

## 运行方式

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

## 系统设计

### 架构

```text
CLI（REPL / 单次提问）
  └─ SessionManager（载入、落盘、锁、修复）
       └─ AgentRuntime（Turn / Step 循环）
            ├─ ContextBuilder（估算、压缩、系统提示词）
            ├─ ToolRegistry（schema、校验、执行、截断）
            ├─ TraceWriter（JSONL）
            └─ ModelAdapter ── DeepSeek（OpenAI 兼容）
```

Runtime 完全自研，模型侧只依赖一个 `ModelAdapter` 接口；工具、上下文、会话、Trace 都是普通 TypeScript 模块，没有 agent 框架。

### Turn 与 Step

- 一次用户输入 = 一个 **Turn**；Turn 内最多 `maxSteps`（默认 8）次 **Step**。
- 一个 Step = 一次模型调用 + 随后的一批工具执行（0 个或多个）。整批工具只计 1 个 Step，按顺序串行执行。
- 结束条件：模型给出最终答复、达到 maxSteps、输出被长度截断、用户取消、不可重试错误。

```text
runTurn(userInput):
  append user message; persist
  for step in 1..maxSteps:
    maybe compress
    response = model(system + history + tools)
    if response.toolCalls:
      execute each tool in order; append tool results
      continue
    else:
      append assistant answer; return
  append synthetic max-steps notice; return
```

### 模块

| 模块 | 职责 |
|---|---|
| `src/model/deepseek.ts` | 请求映射、思考回传、错误分类、可中止的退避重试 |
| `src/runtime/loop.ts` | Turn/Step 循环、工具批次、maxSteps、空响应、截断、取消 |
| `src/runtime/context.ts` | token 估算、压缩切点、摘要生成、系统提示词拼装 |
| `src/tools/` | calculator（无 eval）、search/weather（mock）、todo、schema 校验器 |
| `src/session/` | 会话管理、原子写、锁与心跳、损坏保护、残缺工具配对修复 |
| `src/telemetry/trace.ts` | 每 Step 的 JSONL 记录，密钥永不落盘 |
| `src/cli/` | 参数解析、REPL、单次提问、密钥提示、输出格式化 |

### 工具与错误处理

- 每个工具注册名称、描述、参数 JSON Schema；Runtime 在执行前再校验一次，参数不合法返回 `is_error` 工具结果，由模型自行纠正。
- 未知工具、非法 JSON、缺必填、工具抛异常都转成 `is_error`，不中断 Turn。
- 网络/限流错误（429、5xx、超时）在同一 Step 内重试 2 次，退避 1s/2s，尊重 `Retry-After`；400/401/403/404 不重试。
- 空响应重试一次；`finish_reason=length` 返回部分内容并提示截断。
- Ctrl+C 取消当前 Turn，未执行的工具补 `is_error`，历史配对保持合法。

## 上下文记忆（Memory）

这里的“记忆”指**会话内、会被模型看到的上下文**，不是跨会话长期记忆。跨会话不共享任何内容。

| 记忆 | 存放位置 | 召回时机 | 在 Context 中的位置 | 生命周期 |
|---|---|---|---|---|
| 会话历史 | `data/sessions/<id>.json` 的 `messages` | 每个 Step 调用模型前；重启载入后 | system 之后，按原顺序 | 全量保留；超预算时旧消息被压缩 |
| 摘要 | 会话文件的 `summary` | 每个 Step；压缩后 | system 末尾 `## 早前对话摘要` | 只有一份；再次压缩时与旧摘要合并 |
| 思考内容 | assistant 消息的 `reasoningContent` | 仅 `thinking` 开启时，每个 Step | 对应 assistant 消息内 | 关闭思考时不带；被压缩丢弃后不再回传 |
| 工具结果 | `tool` 消息 | 工具执行后的下一步，以及后续轮次 | 对应 tool 消息 | 单条超过 4000 字符截断；压缩后可能只保留摘要 |
| 待办 | 会话文件的 `todos` | **不自动注入**；模型调用 `todo list` 时以工具结果进入；历史 tool 结果也会被看到 | tool 消息 / 摘要 | 随会话持久化；`/todos` 只本地打印，不经过模型 |
| Trace | `data/traces/<id>.jsonl` | 不召回 | — | 仅用于审计与调试 |
| 其他会话 | 各自的会话文件 | 不召回 | — | 完全隔离 |

**召回时机与顺序**

1. 每个 Turn 开始：把用户消息追加到 `messages` 并落盘。
2. 每个 Step 调模型前：检查是否需要压缩；然后用「基础系统提示词 +（若有）摘要小节」作为 system，后接全部历史消息，随请求携带工具 schema。
3. 工具批次执行完：结果写入 `messages`，下一个 Step 立即能看到。
4. 进程重启：载入会话文件，先补齐残缺的工具配对，再按上述规则组装。
5. 触发压缩时：旧消息被移除，摘要写入 system 末尾；被丢弃的思考与工具结果不再回传。
6. 压缩触发条件：估算 token 超过 `MINI_AGENT_CONTEXT_TOKENS`（默认 32768）或消息数超过 48；保留最近 `MINI_AGENT_KEEP_RECENT`（默认 8）条，切点落在用户消息边界，绝不拆开工具调用与结果。
7. Token 估算为 `字符数 / 3`，只用于触发压缩，不追求精确。

注意：待办状态不会每轮自动塞进 system。模型要么在历史里看到之前的 `todo` 工具结果，要么主动再调用一次 `todo list`；压缩后摘要会尽量保留待办状态，但不保证逐条保留。

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
- [AI 开发过程记录：提示词、工作流与问题排查](AI-PROMPT-AND-TROUBLESHOOTING.md)
- [词汇表](GLOSSARY.md)
- [ADR-0001：原生工具调用](docs/adr/0001-native-tool-calling.md)
- [ADR-0002：思考模式与 Context](docs/adr/0002-thinking-and-context.md)
