# 10: 端到端验收与演示

**What to build:** 用完整测试套件与手动冒烟证明所有用户故事成立；确认密钥不落盘、数据目录正确、README 与实际行为一致。

**Blocked by:** 04、07、08、09。

**Status:** ready-for-agent

- [x] `npm test` 全绿；`npm run typecheck` 通过。
- [x] 手动冒烟通过：天气查询、待办追问、双窗口隔离、`--verbose` 显示思考且无 HTTP 400。
- [x] 检查会话与 Trace 不含 apiKey；数据目录结构符合约定。
- [x] README 的命令、环境变量与默认值和实现一致，修正漂移。
- [x] 测试计划中的 A–F 组均标明通过或手动记录结果。

## Comments

- 2026-11-24：`npm test` 103 个用例通过；`tsc --noEmit` 通过。
- 手动冒烟（真实 DeepSeek）：weather 杭州 24°C；todo 新增/查询；w1/w2 隔离；`--verbose` 显示 `[思考]` 与 `[工具]`；带工具与历史思考的请求未出现 400。
- 会话与 Trace 检查不含密钥；`--list` 无需密钥可用；默认输出不含工具明细。
- 代码审阅：Standards 轴无硬性规范违规，已修复重复、职责过载与命名问题；Spec 轴 5 项行为问题已修复（Trace 字段、maxSteps 进度、默认输出、取消传播、锁心跳），单轮超预算的压缩切点已加保护。
- 未包含：LICENSE（待选择）、CI 配置（未要求）。
