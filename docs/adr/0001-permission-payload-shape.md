# ADR 0001：审批 payload 的真实结构（Paseo 0.14.0）

状态：已确认（源码核验）

## 背景

插件要把 Paseo 的审批请求转成飞书卡片，并且按钮要「对齐会话中的选项」。为此必须知道
`AgentPermissionRequest` 在每种 `kind` 下到底携带什么，尤其是选项在哪个字段。

## 结论

### 权限请求的产生点

Claude provider 在 `handlePermissionRequest(toolName, input, options)` 里构造请求，
`kind` 由 `resolvePermissionKind` 决定：

```js
function resolvePermissionKind(toolName, input) {
  if (toolName === "ExitPlanMode") return "plan";
  if (toolName === "AskUserQuestion" && Array.isArray(input.questions)) return "question";
  return "tool";
}
```

### 只有 plan 有 actions

请求对象的 `actions` 字段赋值是：

```js
actions: kind === "plan" ? buildClaudePlanPermissionActions(this.planResumeMode) : undefined
```

**`question` 与 `tool` 的 `actions` 恒为 `undefined`。**

这意味着「按钮选项对齐会话中的选项」不能依赖 `actions[]`。插件必须自己从
`input.questions[].options[]` 构造按钮，再用 `updatedInput.answers` 回写答案。

### question 类型的 input 结构

```jsonc
{
  "questions": [
    {
      "question": "探针测试：选一个颜色",   // 题干，同时是 answers 的 key
      "header": "颜色",                     // 短标签，多选时也用作 answers 的备用 key
      "options": [
        { "label": "红色", "description": "..." },
        { "label": "绿色", "description": "..." }
      ],
      "multiSelect": false,
      "allowOther": true                    // Paseo 注入，对应 Claude 的 Other 自由输入
    }
  ]
}
```

`title` / `description` 由 `buildClaudeQuestionPermissionSummary` 生成：
第一题的题干做 `title`，选项 label 用 ` / ` 连接做 `description`。

### 答案回写格式

`AgentPermissionResponse` 为 `behavior: "allow"` 时，`updatedInput.answers` 以
**题干全文为 key**，值为选中的 option label 字符串：

```jsonc
{
  "behavior": "allow",
  "updatedInput": {
    "questions": [ /* 原样带回 */ ],
    "answers": { "探针测试：选一个颜色": "绿色" }
  }
}
```

回写前 Paseo 会调用 `normalizeClaudeAskUserQuestionUpdatedInput`，它按题干匹配
`answers`，匹配不到再退回 `header`；两者都匹配不上则该答案不可投递，会被拒绝。
`stripClaudeAskUserQuestionUiMetadata` 会在发给 Claude 前删掉 `allowOther`。

### tool 类型的结构

- `name`：工具名，如 `Bash`、`Write`
- `input`：工具原始入参
- `detail`：由 `mapClaudeRunningToolCall` 生成的 `ToolCallDetail`
- `suggestions`：Claude 给出的权限建议（可用于 allow always）
- `metadata.toolUseId`：工具调用 id

### plan 类型

`actions[]` 固定为 `reject` / `implement`，`resumeMode` 是 `bypassPermissions` 或
`auto` 时追加 `implement_resume`。`metadata.planText` 携带计划全文。

## 影响

1. 审批卡片必须按 `kind` 分三条渲染路径，不能统一按 `actions[]` 处理。
2. question 卡片的按钮值需要携带题干，回写时组装 `updatedInput.answers`。
3. tool 卡片可以展示 `name` + `detail`，按钮提供 allow / deny / allow-always。
4. plan 卡片可以直接用 `actions[]` 映射按钮，`selectedActionId` 即可。

## 实测验证（2026-11-09）

用一个 `modeId: "default"` 的新 agent 调 `AskUserQuestion`，`agent.permission_requested`
钩子真实触发，日志输出与源码分析逐字段一致：

```jsonc
{
  "agent": {
    "id": "c7965a24-656a-464f-ba52-085271f21d4f",
    "workspaceId": "wks_d85bf8af673fa1a2",
    "parentAgentId": "084f308d-ed0a-431d-a3d8-e1ff26029353",
    "provider": "claude",
    "cwd": "/home/joey/dsh",
    "title": "探针测试"
  },
  "request": {
    "id": "permission-e332ee7f-6b03-4937-b63b-5a1dea50df97",
    "provider": "claude",
    "name": "AskUserQuestion",
    "kind": "question",
    "title": "探针测试：选一个颜色",
    "description": "红色 / 绿色 / 蓝色",
    "input": {
      "questions": [{
        "question": "探针测试：选一个颜色",
        "header": "颜色",
        "options": [
          { "label": "红色", "description": "选这个的话，浮浮酱会记下红色喵～" },
          { "label": "绿色", "description": "..." },
          { "label": "蓝色", "description": "..." }
        ],
        "multiSelect": false,
        "allowOther": true
      }]
    },
    "metadata": { "toolUseId": "call_00_utzqkuS54ti0WiyZBQve9414" }
  }
}
```

关键点：

1. `detail`、`suggestions`、`actions` 三个字段在 JSON 序列化后**完全消失**（值为 `undefined`），
   不是 `null`。插件读的时候必须按可选字段处理。
2. `input` 里**没有** `answers` 字段，只有问题定义。答案必须由插件构造后回写。
3. `agent` 对象只有 6 个字段，没有 `status`、`model`、`labels` 等，通知卡片不能指望这些。

### 触发条件

- agent 必须处于 `default`（Always Ask）或 `acceptEdits` 等会询问的模式；
  `bypassPermissions` 下不产生任何 permission 事件。
- `echo`、`touch /tmp/...`、`Write /tmp/...` 这类被判定为安全的操作在 `default`
  模式下也不触发询问，直接执行完成。要触发 `kind: "tool"` 需要真正敏感的
  目标（工作目录之外的系统路径、网络请求、包管理等）。

### 三个钩子都可用

`agent.permission_requested`、`agent.permission_resolved`、`agent.turn_ended`
在 0.14.0 下均实测触发。`agent.permission_resolved` 的事件载荷是：

```jsonc
{
  "agent": { /* 同 requested 的 6 字段 */ },
  "requestId": "permission-36713d9c-...",
  "resolution": {
    "behavior": "allow",
    "updatedInput": { "questions": [ /* 原样 */ ], "answers": { "题干": "二" } }
  }
}
```

这一点很重要：插件可以靠它得知某个请求**已被别处处理**，从而把飞书卡片置灰，
避免重复应答。

### 回写闭环已验证

两次实测都用 `respondToPermission({ requestId, response })` 提交
`updatedInput.answers`，回合随即 `completed`，说明「飞书按钮 → answers → Claude
接受」整条链路成立，不需要额外的中间层。

