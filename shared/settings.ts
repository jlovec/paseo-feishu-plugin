import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 飞书连接配置，host 级存一份。
 *
 * App Secret 明文落盘是已知风险，见 PLAN.md「风险」一节；日志里永不打印。
 */
export const feishuSettings = defineSettings({
  id: "feishu",
  scope: "host",
  version: 1,
  schema: z.object({
    appId: z.string().default(""),
    appSecret: z.string().default(""),
    /** 通知落点。targetKind 决定它按 chat_id 还是 open_id 解释 */
    targetId: z.string().default(""),
    targetKind: z.enum(["chat_id", "open_id"]).default("chat_id"),
    brand: z.enum(["feishu", "lark"]).default("feishu"),
    notifyCompleted: z.boolean().default(true),
    notifyFailed: z.boolean().default(true),
    notifyCanceled: z.boolean().default(false),
    notifyPermission: z.boolean().default(true),
  }),
});

export type FeishuSettingsValues = z.infer<typeof feishuSettings.schema>;
