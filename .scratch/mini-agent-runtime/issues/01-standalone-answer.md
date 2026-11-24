# 01: 端到端直答（脚手架与真实模型）

**What to build:** 用户在终端提出一个问题，程序调用真实模型并打印答复；思考内容默认不显示，`--verbose` 时显示。此票建立可运行的 TypeScript CLI、配置读取、模型适配与测试替身，暂不含工具、持久化与多轮 REPL。

**Blocked by:** 无（可立即开始）。

**Status:** ready-for-agent

- [x] 未配置密钥时给出可读错误并以非零码退出；配置后能对真实 DeepSeek 发起一次请求并打印最终答复。
- [x] 思考内容与最终内容分别解析；默认隐藏，`--verbose` 显示思考。
- [x] FakeLLM 能驱动一次直答，测试不访问网络；`npm test` 与 `npm run typecheck` 通过。
- [x] 运行时零依赖；开发依赖仅 TypeScript、tsx、vitest 与 Node 类型。
- [x] 模型名默认 `deepseek-flash` 且可通过环境变量覆盖；接口地址可配置。

## Comments

- 2026-11-24：于集成分支 `feat/mini-agent-runtime` 实现；真实 API 冒烟通过（直答与思考内容）。
