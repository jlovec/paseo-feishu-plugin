import { z } from "zod";

/**
 * 飞书按钮回调里携带的 value。只放定位请求与选择所需的最小字段，
 * 完整的问题定义留在服务端内存里，卡片 JSON 不跟着膨胀。
 */
export const permissionValueSchema = z.object({
  /** agent id */
  a: z.string(),
  /** permission request id */
  r: z.string(),
  /** 动作种类 */
  k: z.enum(["option", "submit", "tool", "plan"]),
  /** 题号，option 动作必填 */
  q: z.number().int().nonnegative().optional(),
  /** 选项号，option 动作必填 */
  o: z.number().int().nonnegative().optional(),
  /** tool 动作取 allow / deny / always；plan 动作取 action id */
  x: z.string().optional(),
});

export type PermissionValue = z.infer<typeof permissionValueSchema>;
