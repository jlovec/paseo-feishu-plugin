# ADR 0006：卡片字段收敛与 Paseo 深链

状态：已确认（2026-11-09 实测）

## 背景

早期卡片直接暴露实现细节：完整 `cwd`、`provider`、`request.id` 都印在正文里，
手机上又长又难扫；结果是每张卡都缺**项目名**、**耗时**和**回到 Paseo 的入口**。
工具授权卡的入参是整段 JSON，MCP 和 shell 一视同仁，读不出要批准什么。

## 结论

### 1. 所有卡片用同一骨架

```
[状态 emoji + 事件] · [agent 标题]      ← header
项目：<cwd 末级目录> | <时间字段>        ← div.fields 两栏
──────────────
核心内容（回复 / 错误 / 选项 / 工具摘要 / 计划）
[打开 Paseo]                            ← 深链按钮，拿不到就不渲染
note：provider · 完整路径                ← 技术信息收到底部
```

时间字段按卡片类型取不同值：

| 卡片 | 字段 | 取值 |
|---|---|---|
| 完成 / 失败 / 取消 | 耗时 | `turn_ended - turn_started` |
| 审批（首次发送） | 到达 | 请求到达的本地时刻 `HH:mm` |
| 审批（勾选后重绘） | 已等待 | 距请求到达的时长 |
| 审批（已处理） | 处理用时 | 距请求到达的时长 |

### 2. 项目名替代完整路径

`path.basename(cwd)` 足够区分会话，完整路径移到底部 note。

### 3. 来源标注

置灰卡区分处理位置：飞书点击 → `来源：飞书`，Paseo 界面处理 → `来源：Paseo`。
判断依据是 `submitResponse` 在回写前打上的 `handledFromFeishu` 标记。

### 4. 工具入参压成一句人话

按 `request.detail.type` 分支：`shell` 显示命令、`read`/`write`/`edit` 显示文件路径、
`search` 显示关键词、`fetch` 显示 URL，只有 `unknown`（多为 MCP）才回退 JSON。
「总是允许」按钮带上工具短名（`mcp__server__tool` 取末段），超过 10 字符就只写「总是允许」。

### 5. Paseo 深链

格式 `paseo:/h/<serverId>/agent/<agentId>`，与 `@getpaseo/protocol` 的
`buildAgentDeepLink` 一致。`serverId` 来自 `paseo.hosts.list().self.serverId`，
首次解析后缓存；`hosts.list` 2 秒不返回就降级为「不渲染按钮」，不拖慢通知。

## 实测

- 飞书服务端接受 `paseo:` 协议的按钮：发送返回 `code: 0`，消息正常投递。
- 客户端点击后能唤起 Paseo 并跳转到对应 agent（2026-11-09 主人确认）。
- `serverId` 在插件进程内解析成功：日志 `深链前缀已就绪：srv_3Qzzm0zMAt5i`。
- 带新骨架的完成卡与审批卡均正常发送，飞书点击「咖啡」后回调与置灰卡无报错。

## 影响

1. `server/cards.ts` 提供 `metaRow` / `techNote` / `cardHeader` / `openPaseoAction` 等公共件。
2. `server/permission-cards.ts` 的 `buildPermissionCard` / `buildResolvedCard` 改为接收选项对象。
3. `server/permission-bot.ts` 的待处理项新增 `requestedAt` 与 `handledFromFeishu`。
4. `server/notify.ts` 新增 `turnStartedAt` 计时表；合并窗口内保留最新一轮耗时。
5. `server/paseo-link.ts` 负责 `serverId` 解析与深链生成。
