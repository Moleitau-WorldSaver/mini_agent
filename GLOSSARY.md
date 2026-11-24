# Mini Agent Runtime

最小自研 Agent runtime 的词汇表：统一 loop、会话、上下文、工具与测试讨论所用的词。术语随设计轮次增补，定义只描述概念，不描述实现。

## Language

**Runtime（运行时）**：
把一次用户输入变成 Turn、驱动 Step 循环、执行 Tool Call 并持有 Session 的核心组件。
_Avoid_: engine, framework, agent（指代组件时）

**Model Adapter（模型适配器）**：
Runtime 与具体模型提供方之间的边界：把 Runtime 的请求翻译成提供方协议，把响应翻译回 Message 与 Tool Call。
_Avoid_: client, provider, LLM wrapper

**Thinking Mode（思考模式）**：
Session 级开关，决定模型是否产出 Reasoning Content，以及 Context 是否携带并回传它。
_Avoid_: reasoning mode, CoT mode

**Reasoning Content（思考内容）**：
模型在给出最终答复或工具调用之前产生的思考文本，附属于 assistant Message。
_Avoid_: chain-of-thought, thought log, thinking tokens

**Session（会话）**：
彼此隔离的对话容器，拥有自己的历史、待办与状态；任何 Session 都不读取另一个 Session 的内容。
_Avoid_: 窗口（仅作 UI 隐喻）, chat, thread, conversation

**Session Lock（会话锁）**：
防止两个进程同时写同一 Session 的互斥标记。
_Avoid_: mutex file, pid file

**Turn（轮）**：
一次用户输入，加上 Agent 为它执行的全部工作，直到返回最终答复。
_Avoid_: 轮次, request, exchange

**Step（步）**：
Turn 内的一次迭代：一次模型调用，加上随后可能发生的一批 Tool Call。
_Avoid_: 循环轮次, iteration

**Message（消息）**：
Context 中的一条记录，角色为 system、user、assistant 或 tool 之一。
_Avoid_: entry, record, event

**Synthetic Message（合成消息）**：
由 Runtime 而非模型生成、但仍进入 Context 的 Message，用于收尾说明或修补残缺的 Tool Call。
_Avoid_: fake message, system note

**Context（上下文）**：
某次 Step 交给模型的、有序的 Message 列表与工具 schema。
_Avoid_: prompt（指代整个上下文时）, memory, window

**Tool（工具）**：
Agent 可调用的一项具名能力，以名称、描述和参数 schema 呈现给模型。
_Avoid_: function（保留给代码）, action, plugin, skill

**Tool Call（工具调用）**：
模型针对某个 Tool 发出的、带具体参数的一次调用请求，以及它换回的结果。
_Avoid_: function call, invocation

**maxSteps（步数上限）**：
一个 Turn 允许执行的最大 Step 数；超过后 Runtime 终止该 Turn，返回已有的部分结果。
_Avoid_: 最大轮次（在 Turn 与 Step 之间有歧义）

**Compression（压缩）**：
把 Context 中较旧的 Message 替换为更短的摘要，使 Context 保持在预算内。
_Avoid_: summarization, truncation（不生成摘要的丢弃不算压缩）

**Summary（摘要）**：
Compression 的产物，是一段浓缩历史，置于系统消息末尾，替换被丢弃的 Message。
_Avoid_: recap, memo, memory

**Trace（轨迹）**：
一个 Session 的 Step 与 Tool Call 的结构化记录，用于调试与审计。
_Avoid_: console log（控制台输出不是 Trace）, history

**FakeLLM（假模型）**：
测试中替代真实模型的脚本化替身，用来确定性地驱动 Step 循环。
_Avoid_: mock model, stub
