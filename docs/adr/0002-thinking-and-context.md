# 开启思考模式，并在 Context 中回传 reasoning_content

状态：已接受（2026-11-24）

需求要求提取模型的思考过程。DeepSeek 当前模型默认开启思考并返回 `reasoning_content`，且官方文档（经镜像核实，待真实 API 复核）要求：请求带 `tools` 时，必须回传历史中每条 assistant 消息的 `reasoning_content`，否则 HTTP 400。因此我们放弃最初"思考只进日志、不进 Context"的做法：新会话默认开启思考（`reasoning_effort: low`），每条 assistant 消息持久化并回传思考内容；思考模式是 Session 级属性，创建后不可切换，`--no-think` 只作用于新会话。

**考虑过的选项**

- 关闭思考：Context 最干净，但"提取思考过程"无从演示。
- 默认关闭、手动开启：演示要多一步，Trace 默认没有思考，价值打折。

**后果**

- Session 文件与每次请求的体积变大，思考模式不可中途切换。
- 被压缩或丢弃的旧消息不再回传；摘要放在 system 消息内，避免新增 assistant turn 而触发回传规则。
- 运行时合成的消息（步数上限提示等）没有真实思考，回传空字符串，需在真实 API 上验证；若失败，回退为一行合成说明文本。
