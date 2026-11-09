# ADR 0004：用长连接接收卡片回调

状态：已确认（2026-11-09 实测，2026-11-09 补充回调响应与置灰时机）

## 背景

审批卡片上的按钮点击要回到插件进程。飞书提供两条路：HTTP webhook 与长连接。
本机没有稳定公网入口，webhook 还要额外配签名校验与事件订阅，因此选长连接。

## 结论

`@larksuiteoapi/node-sdk@1.76.0` 的 `WSClient` 可以用扫码得到的 PersonalAgent 凭据
直接建连，不需要去开发者后台改「订阅方式」。SDK 启动时打印的那条
「receive events or callbacks through persistent connection only available in
self-build & Feishu app…」是通用提示，不代表失败。

```ts
const ws = new WSClient({ appId, appSecret, domain, loggerLevel: LoggerLevel.info });
const dispatcher = new EventDispatcher({}).register({
  "card.action.trigger": (raw) => handleCardAction(raw),
});
ws.start({ eventDispatcher: dispatcher });
```

### 回调载荷

```jsonc
{
  "schema": "2.0",
  "event_id": "015b3e4b…",
  "event_type": "card.action.trigger",
  "operator": { "open_id": "ou_…", "union_id": "on_…", "tenant_key": "…" },
  "action": { "value": { /* 按钮上设置的 value，原样带回 */ }, "tag": "button" },
  "context": {
    "open_message_id": "om_…",
    "open_chat_id": "oc_…"
  }
}
```

- `action.value` 原样往返，400 字符的测试值也没有截断。
- `context.open_message_id` 就是发卡片时返回的 `message_id`，可用于后续更新。
- `context.open_chat_id` 是 P2P 会话 id，配置里用 `chat_id` 当目标时拿它校验。
- `operator.open_id` 与配置里的 targetId 一致，可用来拒绝非本人点击。
- `event_id` 可用于重投去重。

### 更新已发出的卡片

`PATCH /open-apis/im/v1/messages/{message_id}`，body `{ "content": "<卡片 JSON 字符串>" }`，
实测 `code: 0`。审批处理完后用它把按钮替换成结果文字。

### 按钮点击后的新卡片必须走回调响应

回调响应体除了 `toast`，还要带 `card`：

```json
{
  "toast": { "type": "success", "content": "已勾选：苹果" },
  "card": { "type": "raw", "data": { /* 发送时用的卡片 JSON 1.0 */ } }
}
```

只返回 `toast` 时，飞书客户端会用**原始卡片**重新渲染，先前用 PATCH 改上去的
勾选状态与置灰结果会被冲掉。实测现象：多选卡片点「苹果」「香蕉」后 PATCH 生效，
再点「提交选择」，卡片刷新后回退成未勾选的原始态。改成在回调响应里返回新卡片后，
状态稳定保留。卡片是 1.0 结构时，`data` 直接放 1.0 卡片 JSON，不需要转 2.0。

### 置灰时机与 pending 生命周期

`respondToPermission` 之后**不能立即删除**服务端记录的待处理项。卡片置灰依赖
`agent.permission_resolved` 钩子回调 `resolvePermissionCard()` 去查这条记录；
提前删除会让钩子静默返回，灰色结果卡永远补不上。删除动作统一放在
`resolvePermissionCard()` 里，与置灰同一步完成。

### 多选实测序列

```
08:17:52  k=option q=0 o=0   苹果
08:17:53  k=option q=0 o=1   香蕉
08:17:56  k=submit
08:17:59  agent 回复「苹果和香蕉」
```

三次回调无重复、顺序正确，答案 `"苹果, 香蕉"` 被 Paseo 接受。

### 答案必须是字符串

`resolveClaudeAskUserQuestionAnswers` 只接受**非空字符串**作为 `answers` 的值
（源码里的 `readNonEmptyString`）。多选的多个选项要先拼成一个字符串，
插件用 `", "` 连接。这一点没有单独的实测样本，后续用 multiSelect 题目验证。

## 影响

1. 插件 server 端持有 `WSClient` 单例，settings 变化时按凭据指纹重启。
2. 按钮 value 只放 `agentId` / `requestId` / 动作种类 / 题号 / 选项号。
3. 卡片置灰走 `patchCard`，与 `sendCard` 共用 token 缓存。
4. 回调要先返回 toast，再等 Paseo 的 `respondToPermission`，避免飞书 3 秒超时。
