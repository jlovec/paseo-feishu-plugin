import type { z } from "zod";
import type { brandSchema } from "../shared/rpc";
import type { FeishuSettingsValues } from "../shared/settings";

type Brand = z.infer<typeof brandSchema>;

const OPEN_BASE: Record<Brand, string> = {
  feishu: "https://open.feishu.cn",
  lark: "https://open.larksuite.com",
};

/** tenant_access_token 的无效/过期错误码，命中时清缓存重试一次 */
const TOKEN_INVALID_CODES = new Set([99991661, 99991663, 99991668]);

interface TokenCache {
  key: string;
  token: string;
  expiresAt: number;
}

let tokenCache: TokenCache | null = null;

export async function getTenantAccessToken(
  appId: string,
  appSecret: string,
  brand: Brand,
): Promise<string> {
  const key = `${brand}:${appId}`;
  if (tokenCache && tokenCache.key === key && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }

  const res = await fetch(`${OPEN_BASE[brand]}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const json = (await res.json()) as Record<string, unknown>;

  if (json.code !== 0 || typeof json.tenant_access_token !== "string") {
    throw new Error(`获取 tenant_access_token 失败：code=${String(json.code)} msg=${String(json.msg ?? "")}`);
  }

  // 提前 2 分钟过期，避免边界上用到刚失效的 token
  const ttlSeconds = Number(json.expire) > 0 ? Number(json.expire) : 7200;
  tokenCache = {
    key,
    token: json.tenant_access_token,
    expiresAt: Date.now() + Math.max(60, ttlSeconds - 120) * 1000,
  };
  return tokenCache.token;
}

async function postMessage(
  token: string,
  brand: Brand,
  targetKind: FeishuSettingsValues["targetKind"],
  targetId: string,
  card: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(
    `${OPEN_BASE[brand]}/open-apis/im/v1/messages?receive_id_type=${targetKind}`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({
        receive_id: targetId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );
  return (await res.json()) as Record<string, unknown>;
}

export interface SendCardResult {
  messageId: string;
}

/** 往配置好的会话发一张交互卡片。 */
export async function sendCard(
  values: FeishuSettingsValues,
  card: unknown,
): Promise<SendCardResult> {
  const { appId, appSecret, brand, targetId, targetKind } = values;

  let token = await getTenantAccessToken(appId, appSecret, brand);
  let json = await postMessage(token, brand, targetKind, targetId, card);

  if (typeof json.code === "number" && TOKEN_INVALID_CODES.has(json.code)) {
    tokenCache = null;
    token = await getTenantAccessToken(appId, appSecret, brand);
    json = await postMessage(token, brand, targetKind, targetId, card);
  }

  if (json.code !== 0) {
    throw new Error(`发送卡片失败：code=${String(json.code)} msg=${String(json.msg ?? "")}`);
  }

  const data = json.data !== null && typeof json.data === "object" ? (json.data as Record<string, unknown>) : {};
  return { messageId: typeof data.message_id === "string" ? data.message_id : "" };
}

async function patchMessage(
  token: string,
  brand: Brand,
  messageId: string,
  card: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${OPEN_BASE[brand]}/open-apis/im/v1/messages/${messageId}`, {
    method: "PATCH",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=utf-8",
    },
    body: JSON.stringify({ content: JSON.stringify(card) }),
  });
  return (await res.json()) as Record<string, unknown>;
}

/** 更新一条已发出的交互卡片，用于审批处理后的置灰。 */
export async function patchCard(
  values: FeishuSettingsValues,
  messageId: string,
  card: unknown,
): Promise<void> {
  const { appId, appSecret, brand } = values;

  let token = await getTenantAccessToken(appId, appSecret, brand);
  let json = await patchMessage(token, brand, messageId, card);

  if (typeof json.code === "number" && TOKEN_INVALID_CODES.has(json.code)) {
    tokenCache = null;
    token = await getTenantAccessToken(appId, appSecret, brand);
    json = await patchMessage(token, brand, messageId, card);
  }

  if (json.code !== 0) {
    throw new Error(`更新卡片失败：code=${String(json.code)} msg=${String(json.msg ?? "")}`);
  }
}
