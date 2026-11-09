import { randomUUID } from "node:crypto";
import { toQrDataUri } from "./qr";
import type { z } from "zod";
import type { brandSchema } from "../shared/rpc";

type Brand = z.infer<typeof brandSchema>;

const FEISHU_ACCOUNTS = "https://accounts.feishu.cn";
const LARK_ACCOUNTS = "https://accounts.larksuite.com";
const REGISTRATION_PATH = "/oauth/v1/app/registration";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRE_SECONDS = 600;

interface RegistrationSession {
  deviceCode: string;
  brand: Brand;
  intervalSeconds: number;
  expiresAt: number;
  /** 已因 tenant_brand=lark 切过一次域名，避免反复切 */
  domainSwitched: boolean;
}

/** 未完成的扫码会话。单用户场景，内存里存够用；进程重启后自然过期。 */
const sessions = new Map<string, RegistrationSession>();

function accountsBaseUrl(brand: Brand): string {
  return brand === "lark" ? LARK_ACCOUNTS : FEISHU_ACCOUNTS;
}

async function postRegistration(
  body: Record<string, string>,
  brand: Brand,
): Promise<Record<string, unknown>> {
  // 用 Promise.race 做超时：AbortSignal 在 @types/node 与 react-native 的全局声明间有冲突
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const res = await Promise.race([
      fetch(`${accountsBaseUrl(brand)}${REGISTRATION_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(body).toString(),
      }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("注册接口请求超时")),
          REQUEST_TIMEOUT_MS,
        );
      }),
    ]);
    const json = (await res.json()) as unknown;
    if (json === null || typeof json !== "object") {
      throw new Error("注册接口返回了非对象内容");
    }
    return json as Record<string, unknown>;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function positiveSeconds(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * 探测环境 + 发起 device-code 注册，返回二维码。
 * 流程与字段名照 openclaw 的实现（飞书官方 CLI 注册协议）。
 */
export async function beginRegistration(brand: Brand) {
  const init = await postRegistration({ action: "init" }, brand);
  const methods = init.supported_auth_methods;
  if (!Array.isArray(methods) || !methods.includes("client_secret")) {
    throw new Error("当前飞书环境不支持 client_secret 授权方式");
  }

  const res = await postRegistration(
    {
      action: "begin",
      archetype: "PersonalAgent",
      auth_method: "client_secret",
      request_user_info: "open_id",
    },
    brand,
  );

  const verificationUri = res.verification_uri_complete;
  const deviceCode = res.device_code;
  if (typeof verificationUri !== "string" || typeof deviceCode !== "string") {
    throw new Error("注册接口未返回二维码地址或 device_code");
  }

  const qrUrl = new URL(verificationUri);
  qrUrl.searchParams.set("from", "paseo_feishu_plugin");
  qrUrl.searchParams.set("tp", "ob_cli_app");

  const sessionId = randomUUID();
  const intervalSeconds = positiveSeconds(res.interval, DEFAULT_INTERVAL_SECONDS);
  // 实测返回字段叫 expires_in；openclaw 源码里的 expire_in 是错的，保留两者兜底
  const expireInSeconds = positiveSeconds(
    res.expires_in ?? res.expire_in,
    DEFAULT_EXPIRE_SECONDS,
  );

  sessions.set(sessionId, {
    deviceCode,
    brand,
    intervalSeconds,
    expiresAt: Date.now() + expireInSeconds * 1000,
    domainSwitched: false,
  });

  return {
    sessionId,
    qrDataUri: await toQrDataUri(qrUrl.toString()),
    qrUrl: qrUrl.toString(),
    userCode: typeof res.user_code === "string" ? res.user_code : "",
    intervalSeconds,
    expireInSeconds,
  };
}

export type RegistrationPollResult =
  | { status: "pending" }
  | { status: "success"; appId: string; appSecret: string; openId: string; brand: Brand }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; message: string };

/**
 * 轮询一次。客户端按 begin 返回的 intervalSeconds 自己排节奏；
 * slow_down 时把间隔加 5 秒并要求客户端重新取（下一轮 begin 之外的会话内生效）。
 */
export async function pollRegistration(sessionId: string): Promise<RegistrationPollResult> {
  const session = sessions.get(sessionId);
  if (!session) return { status: "expired" };
  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    return { status: "expired" };
  }

  const res = await postRegistration(
    { action: "poll", device_code: session.deviceCode },
    session.brand,
  );

  const userInfo =
    res.user_info !== null && typeof res.user_info === "object"
      ? (res.user_info as Record<string, unknown>)
      : undefined;

  // 用户实际用的是 Lark 国际版时，注册结果只在国际版域名下有效，切一次重试
  if (!session.domainSwitched && userInfo?.tenant_brand === "lark") {
    session.brand = "lark";
    session.domainSwitched = true;
    return { status: "pending" };
  }

  if (typeof res.client_id === "string" && typeof res.client_secret === "string") {
    sessions.delete(sessionId);
    return {
      status: "success",
      appId: res.client_id,
      appSecret: res.client_secret,
      openId: typeof userInfo?.open_id === "string" ? userInfo.open_id : "",
      brand: session.brand,
    };
  }

  if (typeof res.error === "string" && res.error !== "authorization_pending") {
    if (res.error === "slow_down") {
      session.intervalSeconds += 5;
      return { status: "pending" };
    }
    sessions.delete(sessionId);
    if (res.error === "access_denied") return { status: "denied" };
    if (res.error === "expired_token") return { status: "expired" };
    const description = typeof res.error_description === "string" ? res.error_description : "unknown";
    return { status: "error", message: `${res.error}: ${description}` };
  }

  return { status: "pending" };
}
