# ADR 0003：agent 时间线的取数结构

状态：已确认（0.14.0 类型 + 编译期实测）

## 背景

功能一要发「会话完成」卡片，正文里放 agent 最后一条回复。Paseo 的
`agent.turn_ended` 事件本身不带历史（`timeline` 字段已废弃、恒为空），
必须自己去取：

```ts
context.paseo.agents.ref(agent.id).timeline.refetch({ direction: "tail", limit: 20 })
```

返回值的形状在类型里叫 `FetchAgentTimelinePayload`，但这个名字没有从
`@getpaseo/client` 导出，只能靠推断。

## 结论

返回对象的条目字段叫 **`entries`**，不是 `items`：

```ts
const payload = await paseo.agents.ref(agentId).timeline.refetch({
  direction: "tail",
  limit: 20,
});

payload.entries // ← 真实字段名
```

`entries` 的每一项是**包装层**，不是裸的时间线条目：

```ts
{
  provider: string;
  item: AgentTimelineItem;      // ← 真正的内容在这里
  timestamp: string;
  seqStart: number;
  seqEnd: number;
  sourceSeqRanges: { startSeq: number; endSeq: number }[];
  collapsed: ("identity" | "assistant_merge" | "reasoning_merge" | "tool_lifecycle")[];
  turnId?: string;
}
```

所以取助手回复要写成 `entry.item.type === "assistant_message"` 和 `entry.item.text`，
不是 `entry.type` / `entry.text`。

`AgentTimelineItem` 的联合类型（`@getpaseo/protocol/agent-types`）：

| type | 关键字段 |
|---|---|
| `user_message` | `text` |
| `assistant_message` | `text` |
| `reasoning` | `text` |
| `tool_call` | 工具调用详情 |
| `todo` | `items` |
| `error` | `message` |
| `notification` | `level`, `message` |
| `compaction` | 压缩记录 |
| `plugin` | 插件条目 |

## 影响

1. `server/notify.ts` 的 `lastAssistantText()` 倒序遍历 `payload.entries`，
   取最后一条非空 `assistant_message` 的 `text`。
2. 取历史失败不阻断通知，卡片正文退化为「这一轮没有文字回复」。
3. 后续做审批卡片时如果要展示上下文，同样按 `entries[].item` 取。

## 实测记录

2026-11-09 21:15 用 `claude-sonnet-5-5` 跑了一轮最小会话，插件日志输出：

```
[paseo-feishu] 已发送会话通知：completed · 通知验证2
```

钩子、取时间线、发卡片三段都执行到了。
