# 05: 会话级 todo

**What to build:** 用户能在当前会话记录、查看、完成待办；待办随会话持久化，重启后仍在；省略主语的追加可以新增；错误 id 可被纠正。

**Blocked by:** 03。

**Status:** ready-for-agent

- [ ] add/list/complete 全流程；id 由 Runtime 生成 `t1`…；结果含完整列表或变更项。
- [ ] 待办随会话文件持久化，重启后仍在。
- [ ] 未知 id 返回 `is_error` 并附当前列表。
- [ ] 省略主语的追加（"再加一个，洗车"）能新增。
- [ ] 测试覆盖 B12–B13 与 T3 追问。
