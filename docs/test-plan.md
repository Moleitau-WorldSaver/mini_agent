# 测试计划

> 关联：[设计文档](design.md)｜词汇表：[GLOSSARY.md](../GLOSSARY.md)

## 1. 策略

- **不依赖真实模型**：CI 中全部使用 FakeLLM 与注入式假 `fetch`，结果确定、可重复。
- **真实文件系统**：Session 相关测试在 `fs.mkdtemp` 临时目录中运行，不用 mock 文件系统。
- **真实计时器可选**：退避重试通过注入的 `sleep` 与假时钟验证，测试不真实等待。
- **真实 API 只做手动冒烟**：F 组写在 README 清单里，不进入 `npm test`。
- 测试分层：工具/校验器/压缩工具函数/存储为单元测试；loop + Session + Context + CLI 为集成测试。

## 2. 测试替身

### 2.1 FakeLLM

实现 `ModelAdapter`，按脚本依次返回响应，并记录收到的每个请求供断言。

```ts
type FakeStep =
  | { kind: "text"; content: string; reasoning?: string }
  | { kind: "tool_calls"; content?: string | null; reasoning?: string; calls: { name: string; arguments: string }[] }
  | { kind: "length"; content: string }
  | { kind: "empty" }
  | { kind: "http_error"; status: number; retryAfter?: string };

class FakeLLM implements ModelAdapter {
  script: FakeStep[];
  requests: ModelRequest[] = [];
  async complete(req: ModelRequest) { this.requests.push(req); /* 消费脚本 */ }
}
```

脚本耗尽时抛错，防止测试漏配。`requests` 用于断言：历史是否完整、`reasoning_content` 是否逐条回传、压缩后条数与摘要位置、工具 schema 是否随请求发送。

### 2.2 假 fetch

`DeepSeekAdapter` 构造函数接受 `fetchImpl`，测试注入返回固定 JSON / 状态码 / 慢响应的假实现，用于验证请求体映射、错误分类、`Retry-After` 解析与取消。

### 2.3 辅助工具

- `withTempDataDir()`：创建临时 `data/`，结束后清理。
- `fakeSleep()`：记录退避序列并立即返回。
- `buildSession(...)`：构造带历史/待办的会话文件。

## 3. 用例矩阵

### A. Loop / Turn

| ID | 场景 | 输入 / 脚本 | 期望 |
|---|---|---|---|
| A1 | 直接回复 | FakeLLM：`text` | 1 个 Step；返回文本；assistant 消息入历史；无 tool 消息 |
| A2 | 单次工具 | `tool_calls(weather)` → `text` | 2 个 Step；请求数 2；tool 结果进入第二次请求 |
| A3 | 连续三次工具 | `tool_calls` ×3 → `text` | 4 个 Step；工具按顺序执行 |
| A4 | 单步多工具 | 一个响应含 2 个 calls → `text` | 2 个 Step；2 条 tool 消息；顺序与 calls 一致 |
| A5 | 文本 + 工具混合 | `content` 非空且含 calls | assistant 的 content 与 toolCalls 都入历史 |
| A6 | maxSteps 中止 | `maxSteps=3`，脚本持续返回 `tool_calls` | 恰好 3 个 Step；追加合成收尾消息；返回含"步数上限" |
| A7 | 空响应重试成功 | `empty` → `text` | 同一步内重试；Step 计数为 1；Trace 有 error 与 llm |
| A8 | 空响应仍空 | `empty` → `empty` | Turn 报错；不追加 assistant 最终消息 |
| A9 | 输出截断 | `length`（无 calls） | 返回部分内容 + 截断提示；Turn 正常结束 |
| A10 | 取消 Turn | 工具批次执行中触发取消 | 未执行工具补 `is_error("已取消")`；配对完整；Trace 有 `cancelled` |

### B. 工具与注册表

| ID | 场景 | 输入 | 期望 |
|---|---|---|---|
| B1 | 计算器合法表达式 | `1.5*(3+4)-2` | `8.5` |
| B2 | 计算器优先级与一元负号 | `-2+3*4` | `10` |
| B3 | 计算器除零 | `1/0` | `is_error`，含"除零" |
| B4 | 计算器注入 | `process.exit()` / `eval(1)` | 拒绝，`is_error`，不执行代码 |
| B5 | 计算器超长 | 201 字符表达式 | schema 或执行层拒绝 |
| B6 | search 命中 | `query:"runtime"` | 非空 `results`，字段齐全 |
| B7 | search 无结果 | `query:"不存在的词"` | `{results:[],total:0}`，`isError=false` |
| B8 | search topK 越界 | `topK:9` | `is_error`（schema 校验） |
| B9 | weather 默认单位 | `city:"北京"` | 摄氏温度 |
| B10 | weather 华氏 | `unit:"fahrenheit"` | 华氏温度，数值换算正确 |
| B11 | weather 未知城市 | `city:"拉萨"` | `is_error`，列出支持城市 |
| B12 | todo 全流程 | add → list → complete | 生成 `t1`；list 含 `t1`；complete 后 `done=true` |
| B13 | todo 未知 id | `complete id:"t99"` | `is_error`，附当前列表 |
| B14 | 参数 JSON 损坏 | `arguments:"{city:"` | `is_error`；loop 继续 |
| B15 | 缺必填 / 类型错 | `weather {}` / `topK:"三"` | `is_error`，含字段路径 |
| B16 | 未知工具 | `name:"shell"` | `is_error`，列出可用工具 |
| B17 | 工具抛异常 | 注入抛错的工具 | `is_error`；loop 继续 |
| B18 | 结果截断 | 工具返回 6000 字符 | 4000 字符 + `[truncated N chars]` |

### C. Session

| ID | 场景 | 步骤 | 期望 |
|---|---|---|---|
| C1 | 双会话隔离 | 会话 w1 记待办；会话 w2 问待办 | w2 的 `todos` 为空；w2 请求不含 w1 历史 |
| C2 | 重启恢复 | 写完会话后新建 Manager 载入 | 消息、待办、摘要、thinking、标题一致 |
| C3 | 会话列表 | 建两个会话后 `--list` | 输出 id、标题、更新时间、消息数 |
| C4 | 损坏文件 | 写入非法 JSON 后载入 | 报错；原文件内容不变 |
| C5 | 并发锁 | 持锁进程存在时二次获取 | 第二次失败并提示"会话正在使用" |
| C6 | 陈旧锁 | 锁 mtime 改为 11 分钟前 | 自动清理并成功获取 |
| C7 | 非法 id | `--session ../x` | 拒绝，退出码非 0，不创建文件 |
| C8 | 残缺配对修复 | 构造 assistant(tool_calls) 缺少 tool 结果 | 载入后自动补 `is_error("运行时恢复…")` |

### D. Context / 追问 / 压缩

| ID | 场景 | 步骤 | 期望 |
|---|---|---|---|
| D1 | T1 换参数重调 | 历史含"北京天气"；用户"上海呢？" | 第二次请求含完整历史；脚本返回上海 calls；结果正确 |
| D2 | T2 基于上一结果加工 | 历史含温度；用户"换算成华氏度" | 请求含上一条 tool 结果；模型可引用 |
| D3 | T3 省略主语追加 | 已 add 待办；用户"再加一个，洗车" | 请求含 todo 历史；新增 `t2` |
| D4 | 压缩触发 | `contextTokens` 设为低值、`keepRecent=4`；构造 12 条消息 | 触发压缩；保留 4 条；摘要非空 |
| D5 | 压缩不拆配对 | 切点附近有 assistant(tool_calls)+tool | 切点落在 user 之前；保留部分无孤立 tool |
| D6 | 压缩失败回退 | 摘要调用抛错 | 丢弃最旧、保留 4 条；`summary` 不变；Trace `compression_fallback` |
| D7 | 二次压缩合并 | 连续两次触发 | 摘要只有一份；新摘要包含旧摘要信息 |
| D8 | 思考回传 | thinking=true、历史含 3 条 assistant | 每次请求的每条 assistant 都带 `reasoningContent`；合成消息为空字符串 |
| D9 | 摘要位置 | 压缩后构建请求 | 摘要只在 system 内出现一次；无新增 assistant 摘要消息 |
| D10 | 关闭压缩 | `noCompress=true`、超预算 | 不触发压缩；请求包含全部消息 |

### E. 错误、重试与 Trace

| ID | 场景 | 输入 | 期望 |
|---|---|---|---|
| E1 | 429 重试成功 | 429 → 429 → 成功 | 3 次请求；退避序列 `[1s,2s]`（假 sleep）；Turn 成功 |
| E2 | 401 不重试 | 401 | 1 次请求；Turn 报错；Trace `error` |
| E3 | 尊重 Retry-After | 429 + `Retry-After: 3` | 等待 3s（假 sleep 记录） |
| E4 | 504 重试 | 504 → 成功 | 2 次请求；成功 |
| E5 | 重试耗尽 | 500 ×3 | Turn 报错；错误信息可读 |
| E6 | Trace 字段 | 跑一个含工具的 Turn | 每 Step 一行 llm；每个工具一行 tool；turn_end 存在 |
| E7 | 密钥不落盘 | 检查 session 与 trace 全文 | 不含 apiKey |
| E8 | Trace 写失败 | 注入写入异常 | Turn 正常完成；stderr 警告 |

### F. 真实模型冒烟（手动，不进 CI）

| ID | 场景 | 期望 |
|---|---|---|
| F1 | "杭州天气怎么样？" | 调用 weather，回答含温度 |
| F2 | "记个待办：周五交周报" → "我有哪些待办？" | 调用 todo，两轮均正确 |
| F3 | 两个终端分别 `--session w1` / `w2` | 待办与历史互不可见 |
| F4 | 带思考的一轮对话 | 终端 `--verbose` 能看到思考内容；无 HTTP 400 |

## 4. 需求覆盖映射

| 需求 | 用例 |
|---|---|
| Loop 四步（输入 / 判定 / 调工具 / 继续或返回） | A1–A6 |
| 三个以上工具、todo 必选、注册机制 | B1–B18 |
| LLM 输出解析（思考 / 工具 / 最终答案） | A2、A5、D8、F4 |
| Session 隔离与恢复 | C1–C3、C7 |
| 最大轮次限制 | A6 |
| 记住状态与追问 | D1–D3 |
| Context 压缩 | D4–D7、D9–D10 |
| 基础异常处理 | A7–A10、B14–B17、C4–C6、E1–E5 |
| Trace / 执行日志 | E6–E8 |
| 测试要求本身 | 本文档全部 A–E |

## 5. 运行

```powershell
npm test
npm run typecheck
```

- `npm test` 只跑 A–E，不访问网络、不读真实 API key。
- 测试数据写入临时目录，不污染 `data/`。
- 每个用例独立创建 FakeLLM 与会话，避免顺序依赖。

## 6. 非目标

- 真实模型的输出质量评估。
- 性能与压力测试。
- 多进程真实并发压力（仅验证锁的互斥语义）。
- 前端/UI 自动化测试（MVP 无 UI）。
