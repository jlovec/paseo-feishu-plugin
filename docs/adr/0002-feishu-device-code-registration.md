# ADR 0002：飞书 device-code 扫码注册的实测结果

状态：已确认（2026-11-09 实测）

## 背景

功能三要求「在 Paseo 里扫码创建飞书机器人」。飞书没有公开的「扫码建应用」文档，
这条路是从 openclaw 的 `@openclaw/feishu` 实现里读出来的（`dist/.setup/app-registration.mjs`）。
读源码只能拿到它**以为**的字段名，必须实测确认服务端到底返回什么。

## 结论

接口：`POST https://accounts.feishu.cn/oauth/v1/app/registration`
（国际版主机 `accounts.larksuite.com`，`Content-Type: application/x-www-form-urlencoded`）

### action=begin

请求：

```
action=begin
archetype=PersonalAgent
auth_method=client_secret
request_user_info=open_id
```

实测响应字段（HTTP 200）：

```
device_code
user_code              // 9 位
verification_uri
verification_uri_complete
expires_in             // 实测 3600
interval               // 实测 5
```

**关键差异**：实际字段是 `expires_in`，而 openclaw 源码读的是 `res.expire_in`。
openclaw 因此永远读不到值、回落到它自己的默认 600 秒。本插件优先读 `expires_in`，
再回退 `expire_in`，最后回退 600。

`verification_uri_complete` 的主机是 `open.feishu.cn`，路径 `/page/launcher`，
不是 accounts 域。二维码要编码的是这个 URL。

### action=poll

pending 时实测响应：

```jsonc
{
  "error": "authorization_pending",
  "error_description": "...",
  "code": ...
}
```

**没有** `client_id` / `client_secret` 字段。成功时才出现这两个（openclaw 源码的判据一致）。

因此判据为：拿到 `client_id` + `client_secret` 即成功；否则看 `error`：

| error | 处理 |
|---|---|
| `authorization_pending` | 继续轮询 |
| `slow_down` | 轮询间隔 +5 秒 |
| `access_denied` | 用户拒绝，终止 |
| `expired_token` | 过期，终止 |
| 其它 | 报错终止 |

### tenant_brand=lark

`poll` 响应的 `user_info.tenant_brand === "lark"` 时，注册结果只在国际版域名下有效，
需要把主机切到 `accounts.larksuite.com` 再继续轮询。本插件只切一次，避免来回抖。

## 影响

1. `server/app-registration.ts` 按实测字段解析，不照抄 openclaw。
2. 二维码有效期用服务端给的值（约 60 分钟），不写死。
3. 会话状态（device_code 等）只存服务端内存，不下发客户端；客户端只拿 `sessionId`。

## 未验证

- 真实扫码后的成功响应结构（`client_id` / `client_secret` / `user_info.open_id`）尚未跑到，
  目前依据 openclaw 源码。等第一次真实扫码时补测。
- `PersonalAgent` 预置的权限范围是否够发消息 + 收卡片回调，扫码后要用测试消息验证。
