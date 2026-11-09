# Paseo 飞书插件实施方案

## 目标

让 Paseo 的 agent 会话通过飞书通知用户，并把会话里挂起的审批搬到飞书上点。

三个功能：

1. 会话完成、失败、需要审批时，往飞书发消息
2. 审批卡片带按钮，按钮选项对齐会话里的选项，点了之后 Paseo 按选择执行
3. Paseo 里有界面，可以扫码创建飞书机器人并自动对接

## 已确认的决定

| 项 | 结论 |
|---|---|
| 通知粒度 | 单会话。所有 agent 的通知发到同一个飞书会话（DM 或某个群） |
| `question` 型审批 | 先实测 AskUserQuestion 的真实 payload，再决定是否渲染成按钮 |
| 代码位置 | `/home/joey/code/paseo-feishu-plugin/`，已 `git init` |

## 实施现状（2026-11-09）

第 1–6 步全部完成并在真机验证：扫码建机器人、会话完成/失败通知、
`question` / `tool` / `plan` 三类审批的飞书应答、30 秒通知合并、
断线重连观测。真实 agent 流量下长连接稳定运行。

第 7 步（2026-11-09）完成卡片内容优化：统一骨架、项目名与耗时、
工具入参人话摘要、置灰卡来源标注、`paseo:` 深链按钮。深链已在客户端实测可唤起。

关键实测结论见 `docs/adr/0004`（卡片回调）、`docs/adr/0005`（通知合并）、
`docs/adr/0006`（卡片字段与深链）与 `docs/adr/0007`（Git 源安装约束）。

## 技术基础（已调研验证）

### Paseo 插件系统（本机 0.14.0，`pluginsEnabled: true`）

用到的贡献点：

| 用途 | 注册方法 |
|---|---|
| 审批与完成事件 | `server.addHook("agent.turn.after" / "agent.permission.before" / "agent.permission.after")` |
| 后端 RPC | `server.handle(contract, handler)` |
| 配置存储 | `server.registerSettings(defineSettings(...))` |
| 扫码界面 | `client.addScreen` + `client.addSidebarHeaderItem` |

审批数据结构（`AgentPermissionRequest`）：

```ts
{
  id, provider, name,
  kind: "tool" | "plan" | "question" | "mode" | "other",
  title?, description?,
  detail?: ToolCallDetail,
  actions?: AgentPermissionAction[]
}
AgentPermissionAction = { id, label, behavior: "allow"|"deny",
                          variant?: "primary"|"secondary"|"danger" }
```

回传：`paseo.agents.ref(agentId).respondToPermission({ requestId, response })`，把 `actions[].id` 填进 `response.selectedActionId`，选项一一对齐。

客户端模块限制：只能用 `react`、`react-native`、`@tanstack/react-query`、`zod`、`@getpaseo/plugin/*`。不能用 DOM、不能用 `react-native-svg`。`react-native` 的 `Image` 可用，二维码走 data URI PNG。

### 飞书扫码建机器人（实测可用）

飞书官方 device-code 注册流程：

```
POST https://accounts.feishu.cn/oauth/v1/app/registration
  action=init   → 探测 supported_auth_methods
  action=begin  → {archetype:"PersonalAgent", auth_method:"client_secret",
                   request_user_info:"open_id"}
                ← {device_code, verification_uri_complete, user_code, interval, expire_in}
  QR URL 追加 from=oc_onboard&tp=ob_cli_app
  action=poll   → 每 interval 秒轮询
                ← 成功 {client_id: appId, client_secret, user_info.open_id}
                ← 失败 authorization_pending / slow_down / access_denied / expired_token
                ← tenant_brand=="lark" 时切 accounts.larksuite.com
```

本机已用 `curl POST action=init` 验证返回 `supported_auth_methods: ["client_secret", ...]`。

### 飞书消息与卡片

- 长连接（WebSocket）接收事件，不需要公网 IP、不需要配回调地址
- 卡片 2.0 按钮支持 `behaviors: [{type:"callback", value:{...}}]`
- 按钮回调事件为 `card.action.trigger`

## 架构

```
┌─────────── Paseo App（client 端）───────────┐
│  侧栏项「飞书」 → 设置屏                      │
│    ├─ 扫码创建机器人（二维码 + 轮询状态）      │
│    ├─ 手动填 App ID / Secret                 │
│    ├─ 选择通知目标（DM open_id / 群 chat_id）  │
│    └─ 开关：完成通知 / 审批通知 / 失败通知     │
└─────────────────┬───────────────────────────┘
                  │ plugin RPC（Zod 双向校验）
┌─────────────────┴───────────────────────────┐
│        Paseo Daemon 子进程（server 端）       │
│  feishu-client.ts   token 缓存、发消息、改卡片 │
│  ws.ts              长连接收 card.action.trigger│
│  app-registration.ts 扫码 init/begin/poll     │
│  notify.ts          turn.after → 结果卡片      │
│  approval.ts        permission.before/after   │
│  store.ts           settings + requestId 映射 │
│  qr.ts              qrcode → PNG base64       │
└─────────────────┬───────────────────────────┘
                  │ HTTPS + WebSocket
             ┌────┴─────┐
             │ 飞书开放平台 │
             └──────────┘
```

选长连接不选 webhook：不用公网入口，扫码建完 app 立刻能用。webhook 留作以后的可选项。

## 文件结构

```
paseo-feishu-plugin/
  paseo-plugin.json        id + requirements.paseo ">=0.14.0"
  OVERVIEW.md              插件页展示文案
  package.json
  tsconfig.json
  index.client.tsx         侧栏项 + 屏幕注册
  index.server.ts          hooks + RPC + 长连接生命周期
  shared/
    rpc.ts                 defineRpc 契约
    settings.ts            defineSettings schema
    types.ts               卡片/回调载荷的 Zod schema
  server/
    feishu-client.ts
    ws.ts
    app-registration.ts
    notify.ts
    approval.ts
    qr.ts
  client/
    setup-screen.tsx       扫码 + 手动配置 + 开关
```

服务端依赖：`@larksuiteoapi/node-sdk`、`qrcode`、`zod`。

## 功能一：发送消息

| 触发点 | 卡片内容 | 默认开关 |
|---|---|---|
| `agent.turn.after` completed | agent 标题、workspace、provider/model、末条回复摘要、「打开 Paseo」按钮 | 开 |
| `agent.turn.after` failed | 错误码 + 错误信息 + 「重试」按钮 | 开 |
| `agent.turn.after` canceled | 一行提示 | 关 |
| `agent.permission.before` | 见功能二 | 开 |

摘要取 `timeline.refetch({direction:"tail", limit:20})` 的末条输出，截断到卡片可读长度。

降噪（已实现，见 `docs/adr/0005`）：同一 agent 的连续完成通知按 30 秒窗口合并，
窗口从第一张卡发出时开始计时；窗口内更新同一条消息并标注「30 秒内合并 N 轮」。
失败/取消不合并，独立发卡。

## 功能二：审批卡片

### 卡片生成

`request.actions` 非空时逐个生成按钮：

```
variant "primary"   → primary_filled
variant "danger"    → danger
variant "secondary" → default
```

无 `actions` 时降级成「允许」「拒绝」两枚按钮，`behavior` 直接给 allow / deny。

按钮 value：

```json
{ "paseo": "approve", "agentId": "...", "requestId": "...", "actionId": "..." }
```

### 回调处理

```
飞书按钮点击
  → card.action.trigger（长连接推送）
  → permission-bot.ts 校验载荷（event_id 去重、点击者、requestId）
  → 仍 pending 时 respondToPermission({requestId, response})
  → 回调响应体返回 { toast, card: {type:"raw", data:<新卡片>} }
       ├─ option 点击 → 带勾选状态的草稿卡
       └─ 提交/允许/拒绝 → 灰色结果卡
  → agent.permission_resolved 钩子 → patch 卡片置灰并删除 pending
```

回调响应必须携带 `card`，只回 `toast` 会被客户端用原始卡片覆盖（见 `docs/adr/0004`）。
`respondToPermission` 之后不立即删除 pending，否则置灰钩子找不到记录。

### kind 分型（已实测确认，见 `docs/adr/0001`）

- `tool` / `mode` / `other`：标准按钮组，`actions` 为 `undefined`，按钮自己造
- `plan`：正文放 plan 全文，截断 3000 字，按钮组直接映射 `actions[]`，
  回传 `selectedActionId`
- `question`：**已实测**。选项在 `input.questions[].options[].label`，逐题渲染按钮组。
  点击后组装 `updatedInput: { questions: <原样>, answers: { <题干全文>: <label> } }`，
  `behavior` 给 `allow`。多题时一次性收集所有答案再提交。
  `allowOther: true` 时追加一个「其他」自由输入入口。

### 时效

待处理项只存在插件进程内存里，Paseo 侧超时或插件重启后，旧卡片再点会提示
「请求已处理或已过期」。`agent.permission_resolved` 一触发就把卡片置灰；
无论审批是在飞书点按钮还是在 Paseo 界面处理，都会走同一条置灰路径。

## 功能三：扫码建机器人

```
[ 扫码创建飞书机器人 ]
      ↓ RPC feishu.registration.begin
  server 调 action=begin，用 qrcode 编成 PNG base64
      ↓
  ← { qrPngBase64, userCode, interval, expireIn }
      ↓ client 渲染二维码 + userCode + 倒计时
      ↓ client 每 interval 秒 RPC feishu.registration.poll
  server 调 action=poll
      ├─ pending  → 继续轮询
      ├─ success  → { appId, appSecret, openId }
      │             写入 settings，拉起长连接
      │             显示「已连接」
      └─ expired / denied → 显示原因 + 重试按钮
```

同屏提供「手动配置」折叠区，填 App ID / App Secret / 目标会话，写入同一份 settings。

扫码成功后，如果 app 缺 scope，屏上给开放平台的授权跳转链接。

## 落地顺序（全部完成）

1. ✅ 骨架：`paseo-plugin.json`、tsconfig、两个入口、`defineSettings`、一个测试 RPC
2. ✅ payload 实测：`question` / `tool` / `plan` 三类真实 request 结构已记录
3. ✅ 扫码：`app-registration.ts` + 设置屏，真实扫码拿到 appId/secret 并能发消息
4. ✅ 发消息：`feishu-client.ts` + `notify.ts`，完成卡片端到端验证
5. ✅ 审批：`permission-bot.ts` 长连接 + 回调，三类审批都在飞书上点通过
6. ✅ 打磨：30 秒通知合并、重连观测日志、回调响应携带卡片

## 风险

| 风险 | 应对 |
|---|---|
| 插件是 trusted unsandboxed | OVERVIEW.md 写清楚；安装时用户知情 |
| App Secret 明文落盘 | 文档提示；不写进日志 |
| 扫码 app 权限不足 | 第 3 步实测；缺了给补授权链接 |
| `question` 结构未知 | 第 2 步实测后再定 |
| 长连接断线 | SDK 自带 `autoReconnect`，重连参数由服务端下发；插件只记 `onReconnecting` / `onReconnected` 日志，不自行调参 |
| 多主机 | 插件按 daemon 安装，各管各的 |

## 待确认

- 无。
