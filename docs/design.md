# Mini Agent Runtime 设计文档

> 状态：v1（2026-11-24）｜词汇表：[GLOSSARY.md](../GLOSSARY.md)｜ADR：[0001 原生工具调用](adr/0001-native-tool-calling.md)、[0002 思考模式](adr/0002-thinking-and-context.md)

## 1. 目标

- 不使用任何 agent 框架，自研最小可用的 agent runtime。
- 基于 DeepSeek 原生 function calling，LLM 依据工具 schema 自主决策。
- 至少三个工具，其中 `todo` 必选；实现工具注册机制（名称、描述、参数 schema）。
- Session 完全隔离、持久化、可恢复；两个"窗口"互不影响。
- Context 可控：maxSteps、完整历史、追问、基础压缩。
- 基本异常处理与结构化 Trace。
- 用 FakeLLM 构建确定性测试，覆盖上述全部行为。

## 2. 非目标

- Web UI、HTTP 服务、多用户鉴权。
- 流式输出（SSE），MVP 一次性返回。
- RAG、`read_docs`、向量检索。
- 复杂压缩（分层记忆、向量摘要、跨会话记忆）。
- 工具沙箱、工具并行执行（按顺序执行，整批算一个 Step）。
- 中途打断并续跑同一个 Turn（Turn 原子）。

## 3. 技术选型

| 项 | 选择 |
|---|---|
| 语言 / 运行时 | TypeScript 5.x / Node.js ≥ 20（内置 `fetch`） |
| 模型 | DeepSeek `deepseek-flash`（V4.1-Flash，OpenAI 兼容 `/chat/completions`） |
| 模型接入 | 自研 `ModelAdapter` + 原生 `fetch`，不引官方 SDK |
| 持久化 | 每会话一个 JSON 文件；Trace 用 JSONL |
| 参数校验 | 自研约 50 行 JSON Schema 子集校验器 |
| 测试 | vitest + FakeLLM + 注入式假 `fetch` |
| 运行时依赖 | 无 |
| 开发依赖 | `typescript`、`tsx`、`vitest`、`@types/node` |

## 4. 架构总览

```
 ┌──────────┐     ┌────────────────┐     ┌──────────────────────┐
 │  CLI     │────▶│ SessionManager │────▶│ Runtime (Turn/Step)  │
 │ (REPL)   │◀────│ 锁 / 载入 / 落盘│◀────│                      │
 └──────────┘     └────────────────┘     └──────┬───────────────┘
                                                │
                  ┌──────────────┬──────────────┼───────────────┐
                  ▼              ▼              ▼               ▼
            ContextBuilder  ToolRegistry   TraceWriter    ModelAdapter
            (组装/估算/压缩)  (注册/校验/执行)  (JSONL)      (DeepSeek fetch)
                  │              │
                  │              ▼
                  │        calculator / search / weather / todo
                  ▼
              session.json（messages / todos / summary / thinking）
```

- **Runtime** 是唯一知道 Turn/Step 语义的组件；它不关心 HTTP 细节与工具实现。
- **ModelAdapter** 是 provider 边界；FakeLLM 实现同一接口。
- **ContextBuilder** 负责组装、估算、压缩，不直接调用工具。
- **ToolRegistry** 负责 schema 暴露、参数校验、执行与错误封装。
- **TraceWriter** 只追加，不影响主流程；写失败不阻断 Turn（记录到 stderr）。

## 5. 核心概念

术语以 [GLOSSARY.md](../GLOSSARY.md) 为准。要点：

- **Turn**：一次用户输入到最终答复。Turn 是原子的，不支持中途追加。
- **Step**：Turn 内的一次迭代 = 一次可用的模型响应 + 随后的一批工具执行（0 或 N 个）。
- **Message**：Context 中的一条消息，角色为 `system` / `user` / `assistant` / `tool`。
- **maxSteps**：每个 Turn 的 Step 上限，默认 8。只统计"可用的模型响应"，HTTP 重试与空响应重试不额外计步。
- Session 不设硬性 Turn 上限；用 Context 预算触发压缩。

## 6. Turn / Step 循环

```
runTurn(session, userInput):
  turnId = `turn-${++session.turnSeq}`
  append user message(turnId)
  for step in 1..maxSteps:
    if !noCompress: maybeCompress(session, turnId, step)
    resp = adapter.complete(buildRequest(session))       // 含传输重试
    if resp.finishReason == "length" and resp.toolCalls == []:
      append assistant(partial) + trace
      return partial + "（输出达到长度上限，已截断）"
    if resp.toolCalls.length > 0:
      append assistant(content, reasoningContent, toolCalls)
      for call in resp.toolCalls:                        // 顺序执行
        if cancelled: append synthetic tool is_error("已取消")
        else: append tool(execute(call))
      continue
    append assistant(content, reasoningContent)
    return content
  notice = "（已达步数上限 {maxSteps}，本轮停止。以上为已完成的进度。）"
  append synthetic assistant(notice, reasoningContent="")
  return notice
```

终止条件：

| 条件 | 结果 |
|---|---|
| 模型给出最终答复（无 tool_calls） | 返回答复，Turn 结束 |
| 达到 maxSteps | 追加合成收尾消息并返回，Turn 结束 |
| 输出被长度截断（`finish_reason=length`） | 返回已有内容并提示截断 |
| 用户取消（Ctrl+C） | 中止请求，未执行的工具补 `is_error`，Turn 结束 |
| 不可重试的模型错误 | Turn 结束并报错；已产生的消息保留 |

边界说明：

- 用户消息在 Turn 开始时即写入会话。若首个模型调用失败，该消息保留，下次输入会形成连续两条 `user` 消息；DeepSeek 允许连续 user 消息，若实测不允许，则在请求组装时合并。
- 工具按 `toolCalls` 顺序**串行**执行，结果按同一顺序写入；单个工具失败不影响同批其他工具。
- 整批工具调用只消耗 1 个 Step。

## 7. Model Adapter

### 7.1 接口

```ts
interface ModelAdapter {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

interface ModelRequest {
  system: string;                 // 基础提示词 + 摘要小节
  messages: ContextMessage[];     // 不含 system
  tools: ToolDefinition[];        // 无工具时传空数组
  thinking: boolean;              // 会话级
  maxTokens: number;
  signal?: AbortSignal;           // Ctrl+C
}

interface ModelResponse {
  content: string | null;         // 纯工具调用时可能为 null
  reasoningContent: string | null;
  toolCalls: { id: string; name: string; arguments: string }[]; // arguments 为 JSON 字符串
  finishReason: "stop" | "tool_calls" | "length" | string;
  usage?: { promptTokens?: number; completionTokens?: number };
}
```

### 7.2 DeepSeek 映射

请求：

```json
{
  "model": "deepseek-flash",
  "messages": [
    { "role": "system", "content": "…基础提示词 + 摘要小节…" },
    { "role": "user", "content": "北京天气怎么样？" }
  ],
  "tools": [{ "type": "function", "function": { "name": "weather", "description": "…", "parameters": { "type": "object", "…": "…" } } }],
  "tool_choice": "auto",
  "reasoning_effort": "low",
  "max_tokens": 8192,
  "stream": false
}
```

响应按 OpenAI 兼容结构解析：

```json
{
  "choices": [{
    "finish_reason": "tool_calls",
    "message": {
      "role": "assistant",
      "content": null,
      "reasoning_content": "用户想知道天气，需要调用 weather…",
      "tool_calls": [{ "id": "call_0", "type": "function", "function": { "name": "weather", "arguments": "{\"city\":\"北京\"}" } }]
    }
  }],
  "usage": { "prompt_tokens": 300, "completion_tokens": 80 }
}
```

### 7.3 已核实的协议约束（2026-11，实现时用真实 API 复核）

| 约束 | 处理 |
|---|---|
| `arguments` 是 JSON 字符串 | adapter 原样保留；工具层解析，失败按工具错误处理 |
| 纯工具调用时 `content` 为 `null` | 归一化为空字符串存储 |
| 并发工具调用始终开启，`parallel_tool_calls` 被忽略 | 支持一次响应含 N 个调用 |
| 思考模式默认开启，返回 `reasoning_content` | 新会话默认开启，`reasoning_effort: "low"` |
| 带 `tools` 时必须回传历史每条 assistant 的 `reasoning_content` | 请求组装时逐条带上；合成消息回传空字符串 |
| 思考模式下 `tool_choice` 仅支持 `none` / `auto` | 固定使用 `auto` |
| 上下文 1,048,576 tokens，最大输出 384K | 仍使用 32K 预算压缩，控制成本与延迟 |
| 429 = 并发限制；500/503 稍后重试；504 超时 | 见第 11 节重试策略 |
| 模型已换代：`deepseek-chat` / `deepseek-reasoner` 于 2026-07-24 下线 | 默认 `deepseek-flash`，可用环境变量覆盖 |

### 7.4 思考模式与请求组装

- 当 `session.thinking == true`：每条 assistant 消息都把 `reasoning_content` 放回请求；没有真实思考的合成消息放空字符串。
- 当 `session.thinking == false`：请求中一律不带 `reasoning_content`，并发送关闭思考的参数。
- 思考模式与模型名在会话创建时写入会话文件；恢复会话沿用记录值。命令行 `--no-think` 仅作用于新会话；与已有会话不一致时打印警告并沿用会话记录值。
- 摘要调用使用同一 adapter，但 `tools: []`、思考关闭、`max_tokens: 1024`。

## 8. 工具系统

### 8.1 注册机制

```ts
interface ToolDefinition {
  name: string;
  description: string;
  parameters: JSONSchema;          // 直接交给模型
  execute(args: unknown, ctx: ToolContext): Promise<ToolResult>;
}

interface ToolContext { session: Session; }        // 有状态工具用
interface ToolResult { content: string; isError: boolean; }
```

- 注册表在进程启动时装配四个工具，按名称查找。
- schema 是唯一事实来源：既交给模型，也交给自研校验器。
- 工具结果统一序列化为 JSON 字符串；超过 4000 字符截断并追加 `[truncated N chars]`。

### 8.2 参数校验器（约 50 行）

仅支持本项目的 schema 子集：`type`（`object` / `string` / `number` / `integer` / `boolean` / `array`）、`properties`、`required`、`enum`、`minimum`、`maximum`、`minLength`、`maxLength`、`items`、`additionalProperties: false`。不支持的字段直接报错（防止误以为被校验）。校验失败返回具体路径与原因，作为 `is_error` 工具结果回给模型。

### 8.3 工具规格

**calculator**

```json
{ "type": "object", "properties": { "expression": { "type": "string", "minLength": 1, "maxLength": 200 } }, "required": ["expression"], "additionalProperties": false }
```

- 手写递归下降解析；支持 `+ - * /`、一元负号、括号、小数。
- **禁止 `eval` / `new Function`**；非法字符、语法错误、除零 → `is_error`。
- 超长（>200 字符）由 schema 与执行层双重拒绝。

**search（mock）**

```json
{ "type": "object", "properties": { "query": { "type": "string", "minLength": 1 }, "topK": { "type": "integer", "minimum": 1, "maximum": 5 } }, "required": ["query"], "additionalProperties": false }
```

- 5 篇固定虚构文档作 fixture，按关键词命中；`topK` 默认 3。
- 返回 `{ "results": [{ "id": "d1", "title": "…", "snippet": "…" }], "total": 0 }`。
- 无结果返回空数组，**不算错误**。

**weather（mock）**

```json
{ "type": "object", "properties": { "city": { "type": "string", "minLength": 1 }, "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] } }, "required": ["city"], "additionalProperties": false }
```

- 支持：北京、上海、广州、深圳、杭州；`unit` 默认 `celsius`。
- 未知城市 → `is_error`，内容列出支持的城市。

**todo（有状态）**

```json
{ "type": "object", "properties": { "action": { "type": "string", "enum": ["add", "list", "complete"] }, "content": { "type": "string", "minLength": 1 }, "id": { "type": "string" } }, "required": ["action"], "additionalProperties": false }
```

- `add` 需要 `content`；`complete` 需要 `id`；`list` 无额外参数。
- id 由 Runtime 生成（`t1`、`t2`…），结果包含完整列表或变更项。
- `complete` 未知 id → `is_error`，附当前列表。
- 待办状态存于所属 Session，随会话文件持久化。

### 8.4 执行与错误语义

| 情况 | 处理 |
|---|---|
| `arguments` 不是合法 JSON | `is_error`：`参数不是合法 JSON`，loop 继续 |
| schema 校验失败 | `is_error`：带字段路径与原因 |
| 未知工具名 | `is_error`：`未知工具 xxx`，列出可用工具 |
| 工具抛异常 | 捕获为 `is_error`，附错误消息（不含堆栈给模型） |
| 执行超时 | 工具层不设超时；由取消信号控制 |
| 结果过大 | 截断到 4000 字符并标记 |

所有工具错误都作为正常的 `tool` 消息回给模型，由模型决定重试或如实告知用户；均计入 Step。

## 9. Session

### 9.1 生命周期

- `agent` → 新建会话，id 形如 `s-20261124-153000`。
- `agent --session w1` → 载入或新建 `w1`。
- `agent --list` → 列出 id、标题、更新时间、消息数、待办数、思考模式。
- 会话内 `/new` 新建、`/switch <id>` 切换、`/todos` 查看待办。

id 规则：`^[A-Za-z0-9_-]{1,32}$`（同时防路径穿越）。标题取首条用户消息前 30 字（压缩空白），空则"未命名会话"。

### 9.2 持久化格式

`data/sessions/<id>.json`：

```json
{
  "version": 1,
  "id": "w1",
  "title": "北京天气怎么样并记个待办",
  "createdAt": "2026-11-24T10:00:00.000Z",
  "updatedAt": "2026-11-24T10:02:00.000Z",
  "model": "deepseek-flash",
  "thinking": true,
  "turnSeq": 1,
  "summary": null,
  "todos": [{ "id": "t1", "content": "周五交周报", "done": false, "createdAt": "2026-11-24T10:01:00.000Z" }],
  "messages": [
    { "role": "user", "content": "北京天气怎么样？顺便记个待办：周五交周报", "turnId": "turn-1" },
    { "role": "assistant", "content": null, "reasoningContent": "需要先查天气…", "toolCalls": [{ "id": "call_0", "name": "weather", "arguments": "{\"city\":\"北京\"}" }], "turnId": "turn-1", "step": 1 },
    { "role": "tool", "toolCallId": "call_0", "name": "weather", "content": "{\"city\":\"北京\",\"temperature\":26,\"unit\":\"celsius\"}", "isError": false, "turnId": "turn-1", "step": 1 },
    { "role": "assistant", "content": "北京现在 26°C…", "reasoningContent": "…", "turnId": "turn-1", "step": 2 }
  ]
}
```

写入策略：先写临时文件再 `rename`（原子替换），写入成功后更新 `updatedAt`。

### 9.3 隔离保证

- `SessionManager` 以 id 为键，各会话独立载入内存；任何操作只读写当前会话对象。
- 工具只能通过 `ToolContext.session` 触达所属会话，无法枚举或读取其他会话。
- 待办、摘要、思考模式、模型名都属于 Session，不共享。

### 9.4 并发与锁

- 单进程内不并发；跨进程用锁文件 `data/sessions/<id>.lock`（内容 `{pid, startedAt}`，`wx` 创建）。
- 获取失败：打印"会话正在使用"，退出码 1。
- 锁文件超过 10 分钟未更新视为陈旧，自动清理后重试一次。
- 正常退出（含 Ctrl+C）在 `finally` 中删除锁。

### 9.5 损坏与残缺修复

- JSON 解析失败或结构不合法：**不覆盖**，报错并提示用新 session id。
- 载入时若发现 assistant 的 `toolCalls` 缺少对应 `tool` 消息（进程崩溃残留），自动补 `is_error` 的合成 tool 消息（`运行时恢复：该工具调用未完成`），使历史重新合法。
- 载入时若发现消息角色顺序非法（如 tool 出现在 user 之前），按损坏处理。

## 10. Context 管理

### 10.1 组装顺序

每次 Step 请求：

1. **system**：`prompts/system.md` 原文 +（若有摘要）`\n\n## 早前对话摘要\n<summary>`。
2. 会话 `messages` 中的全部 user / assistant / tool 消息，按原顺序。
3. `tools` 数组随请求携带（不占 system 文本）。

包含/不包含：

| 内容 | 是否进入 Context | 说明 |
|---|---|---|
| 用户输入 | 是 | 完整保留 |
| assistant 文本 | 是 | 含工具调用前的说明文本 |
| assistant tool_calls | 是 | 与 tool 结果成对保留 |
| tool 结果 | 是 | 单条截断到 4000 字符 |
| 思考内容 | 是（仅思考模式） | 每条 assistant 都回传；关闭思考时不带 |
| 摘要 | 是 | 放在 system 内，只有一份 |
| Trace / 日志 | 否 | 不回流 |
| `--verbose` 输出 | 否 | 只影响终端显示 |

追问不依赖任何特判：T1 换参数重调、T2 基于上一结果加工、T3 省略主语追加，全部靠完整历史与带 id 的工具结果。T4（"第二条"这类顺序引用）不写进验收承诺。

### 10.2 token 估算

`estimate = ceil((Σ content.length + reasoning.length + arguments.length + 20 × 消息数 + 500) / 3)`。仅用于触发压缩，不追求精确。

### 10.3 压缩

- **触发**：每次 Step 前检查；`estimate > MINI_AGENT_CONTEXT_TOKENS`（默认 32768）或 `messages.length > 48`；若 `messages.length <= KEEP_RECENT + 2` 则跳过。
- **切点**：保留最近 `KEEP_RECENT`（默认 8）条，切点必须落在 user 消息之前，且绝不拆开 `assistant(tool_calls)` 与其 `tool` 结果。
- **摘要**：用独立模型调用把被移除的消息压缩为文本；输入包含旧摘要与逐条内容（单条截断 4000 字符）；`tools: []`、思考关闭、`max_tokens: 1024`。摘要调用不计入 Step，Trace 记 `compression`。
- **替换**：成功后 `messages = 保留部分`，`summary = 新摘要`，落盘；旧摘要被新摘要合并覆盖。
- **失败回退**：丢弃最旧部分、保留最近 8 条，`summary` 保持原值，Trace 记 `compression_fallback`。
- **注入**：摘要只进入 system，不新增 assistant 消息，因此不触发 `reasoning_content` 回传规则。
- `--no-compress` 关闭触发（调试用）。

## 11. 错误处理与重试

| 场景 | 处理 | Turn 是否继续 | 重试 | Trace |
|---|---|---|---|---|
| 网络错误 / 超时 / 429 / 500 / 502 / 503 / 504 | 同一 Step 内重试 2 次，退避 1s、2s，尊重 `Retry-After` | 是（成功则继续） | 最多 2 次 | `error` + `llm` |
| 400 / 401 / 403 / 404 | 不重试，结束 Turn，输出可读错误 | 否 | 无 | `error` |
| 空响应（无 content 无 tool_calls） | 同一 Step 内重试 1 次 | 是 | 1 次 | `error` |
| 空响应重试后仍空 | 结束 Turn 并报错 | 否 | 无 | `error` |
| `finish_reason=length` 且无工具调用 | 返回部分内容 + 截断提示 | 否（正常结束） | 无 | `turn_end` |
| `finish_reason=length` 且有工具调用 | 视为协议错误，结束 Turn | 否 | 无 | `error` |
| 未知工具 / 参数非法 JSON / schema 失败 / 工具抛异常 | `is_error` 工具结果回给模型 | 是 | 由模型决定 | `tool` |
| 达到 maxSteps | 合成收尾消息，返回已有进度 | 否 | 无 | `turn_end` |
| 用户取消 | 中止请求；未执行工具补 `is_error` 并结束 Turn | 否 | 无 | `cancelled` |
| 会话文件损坏 | 报错，不覆盖，提示新 id | 否（不进入 Turn） | 无 | — |
| 会话被其他进程锁定 | 报错"会话正在使用" | 否 | 无 | — |
| 载入时发现残缺工具配对 | 自动补合成 `is_error` 结果 | 是 | — | `repair` |

补充：

- 传输重试与空响应重试都发生在同一个 Step 内，不增加 Step 计数。
- 重试退避的 sleep 可通过依赖注入替换，测试不真实等待。
- 取消信号通过 `AbortController` 传给 `fetch`；工具批次中每次执行前检查取消标志。

## 12. Trace

`data/traces/<sessionId>.jsonl`，每行一个 JSON 对象，追加写入：

```json
{"ts":"2026-11-24T10:00:01.000Z","sessionId":"w1","turnId":"turn-1","step":1,"kind":"llm","model":"deepseek-flash","request":{"messages":2,"contextChars":780,"tools":4,"thinking":true},"response":{"finishReason":"tool_calls","content":null,"reasoningContent":"…","toolCalls":[{"id":"call_0","name":"weather","arguments":"{\"city\":\"北京\"}"}]},"usage":{"promptTokens":512,"completionTokens":96},"durationMs":1230,"attempt":1}
{"ts":"2026-11-24T10:00:01.004Z","sessionId":"w1","turnId":"turn-1","step":1,"kind":"tool","toolCallId":"call_0","name":"weather","args":{"city":"北京"},"result":"{\"city\":\"北京\",\"temperature\":26}","isError":false,"durationMs":2}
{"ts":"2026-11-24T10:00:02.500Z","sessionId":"w1","turnId":"turn-1","step":2,"kind":"turn_end","reason":"final","steps":2}
```

- 记录种类：`llm`、`tool`、`compression`、`compression_fallback`、`error`、`cancelled`、`repair`、`turn_end`。
- 内容完整保留（单条截断 4000 字符）；`Authorization`、apiKey 永不落盘。
- `--verbose` 向 stderr 打印人类可读版本（思考内容、工具参数与结果、重试）。
- Trace 写失败只警告，不阻断 Turn。

## 13. CLI

| 命令 / 参数 | 说明 |
|---|---|
| `agent` | 新建会话 |
| `agent --session w1` | 恢复或新建 w1 |
| `agent --list` | 列出会话 |
| `agent --no-think` | 新会话关闭思考（恢复会话时仅警告） |
| `agent --no-compress` | 关闭压缩触发 |
| `agent --verbose` | 显示思考、工具参数与结果 |
| `agent --help` | 帮助 |

会话内命令：`/help`、`/exit`（等价 `/quit`）、`/new`、`/switch <id>`、`/todos`。未知命令打印提示。

交互细节：

- 提示符 `你> `；助手回复以 `助手> ` 开头。
- 默认打印紧凑工具行：`[工具] weather {"city":"北京"} → 26°C`。
- Ctrl+C：提示符处退出；Turn 中取消当前请求并回到提示符。
- Turn 进行中输入的内容由终端缓冲，Turn 结束后按顺序处理。
- 所有界面文案中文。

示例：

```
$ npm run dev -- --session w1
会话 w1 已恢复（4 条消息，1 个待办）
你> 上海呢？
[工具] weather {"city":"上海"} → 28°C
助手> 上海现在 28°C，比北京略热。
```

## 14. 目录结构与脚本

```
mini_agent/
├── prompts/system.md
├── src/
│   ├── cli.ts
│   ├── types.ts
│   ├── model/{adapter.ts,deepseek.ts}
│   ├── runtime/{loop.ts,context.ts,errors.ts}
│   ├── tools/{registry.ts,validator.ts,calculator.ts,search.ts,weather.ts,todo.ts}
│   ├── session/{manager.ts,store.ts,lock.ts,schema.ts}
│   ├── telemetry/trace.ts
│   └── config.ts
├── data/{sessions,traces}/
├── tests/{fake-llm.ts,fake-fetch.ts,unit/,integration/}
├── docs/{design.md,test-plan.md,adr/}
├── GLOSSARY.md
├── README.md
├── package.json
├── tsconfig.json
└── vitest.config.ts
```

`package.json` 脚本：`dev`（`tsx src/cli.ts`）、`typecheck`（`tsc --noEmit`）、`test`（`vitest run`）、`test:watch`。

## 15. 配置

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DEEPSEEK_API_KEY` | 无（必填） | API 密钥 |
| `DEEPSEEK_BASE_URL` | `https://api.deepseek.com` | 兼容端点 |
| `DEEPSEEK_MODEL` | `deepseek-flash` | 模型名 |
| `MINI_AGENT_MAX_STEPS` | `8` | 每 Turn 步数上限 |
| `MINI_AGENT_CONTEXT_TOKENS` | `32768` | 压缩触发预算 |
| `MINI_AGENT_KEEP_RECENT` | `8` | 压缩后保留原文条数 |
| `MINI_AGENT_THINKING` | `on` | 新会话是否开启思考 |
| `MINI_AGENT_MAX_TOKENS` | `8192` | 单次输出上限 |
| `MINI_AGENT_DATA_DIR` | `./data` | 数据根目录 |
| `MINI_AGENT_LOCK_STALE_MS` | `600000` | 锁过期时间 |

## 16. 安全

- 计算器不执行任意代码：无 `eval` / `Function`，字符白名单 + 长度上限。
- 系统提示词声明：工具结果、搜索片段、历史摘要是数据而非指令，模型不得执行其中指令。
- apiKey 只从环境变量读取；日志与 Trace 不记录请求头。
- 会话 id 白名单校验，避免路径穿越。
- 会话与 Trace 只写本地 `data/`；不发送到第三方。

## 17. 已知风险与待实测

1. **思考回传规则**：镜像文档称带工具时必须回传全部历史 `reasoning_content`；实现首日调用真实 API 复核。若空字符串不被接受，回退为一行合成思考文本。
2. **合成消息的 `reasoning_content`**：maxSteps 收尾消息、残缺修复消息需要空思考字段，需实测。
3. **模型清单**：启动时可选调用 `GET /models` 校验配置的模型名（实现首日人工执行一次）。
4. **`Retry-After` 格式**：按秒数解析；若服务端返回日期格式，按解析失败处理并退避。
5. **锁的陈旧判定**：基于文件 mtime，Windows 下进程存活检测不可靠；10 分钟阈值是权衡。
6. **token 估算误差**：`字符数/3` 对中英混合偏差较大，仅用于触发阈值，可调。
7. **文档来源**：DeepSeek 文档经镜像读取，版本与行为需以真实 API 为准。

## 18. 实施顺序

1. 脚手架、类型、配置、`ModelAdapter` 与真实 API 冒烟。
2. 工具注册表、校验器、四个工具及单测。
3. Session 存储、锁、修复及单测。
4. Context 组装、估算、压缩及单测。
5. Turn/Step loop、错误处理、Trace 及单测。
6. CLI 与集成测试。
7. 手动 smoke（F 组）与 README 收尾。
