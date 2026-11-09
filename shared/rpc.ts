import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

export const brandSchema = z.enum(["feishu", "lark"]);

/** 发起扫码注册，返回二维码与轮询所需的会话号。 */
export const registrationBeginRpc = defineRpc({
  name: "feishu.registration.begin",
  input: z.object({ brand: brandSchema.default("feishu") }),
  output: z.object({
    sessionId: z.string(),
    /** data:image/png;base64,... */
    qrDataUri: z.string(),
    /** 二维码里的完整 URL，渲染失败时可当文本兜底 */
    qrUrl: z.string(),
    userCode: z.string(),
    intervalSeconds: z.number(),
    expireInSeconds: z.number(),
  }),
});

/**
 * 轮询注册结果。成功分支带回 appSecret，由客户端写入 settings ——
 * server 侧的 PluginSettings 只有 read/subscribe，没有 write。
 */
export const registrationPollRpc = defineRpc({
  name: "feishu.registration.poll",
  input: z.object({ sessionId: z.string() }),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("pending") }),
    z.object({
      status: z.literal("success"),
      appId: z.string(),
      appSecret: z.string(),
      openId: z.string(),
      brand: brandSchema,
    }),
    z.object({ status: z.literal("denied") }),
    z.object({ status: z.literal("expired") }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});

/** 用当前配置往目标会话发一条测试卡片。 */
export const notifyTestRpc = defineRpc({
  name: "feishu.notify.test",
  input: z.object({}),
  output: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), messageId: z.string() }),
    z.object({ status: z.literal("error"), message: z.string() }),
  ]),
});
