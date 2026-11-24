# 10: 端到端验收与演示

**What to build:** 用完整测试套件与手动冒烟证明所有用户故事成立；确认密钥不落盘、数据目录正确、README 与实际行为一致。

**Blocked by:** 04、07、08、09。

**Status:** ready-for-agent

- [ ] `npm test` 全绿；`npm run typecheck` 通过。
- [ ] 手动冒烟通过：天气查询、待办追问、双窗口隔离、`--verbose` 显示思考且无 HTTP 400。
- [ ] 检查会话与 Trace 不含 apiKey；数据目录结构符合约定。
- [ ] README 的命令、环境变量与默认值和实现一致，修正漂移。
- [ ] 测试计划中的 A–F 组均标明通过或手动记录结果。
