import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import type { FeishuSettingsValues } from "../shared/settings";
import { sendCard } from "./feishu-client";
import { agentLink } from "./paseo-link";
import { buildPermissionCard } from "./permission-cards";
import { resolvePermissionCard, trackPermission } from "./permission-bot";

type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
type AgentPermissionResponse = PluginLifecycleEvents["agent.permission_resolved"]["resolution"];

export interface NotifyPermissionParams {
  paseo: PaseoApi;
  agent: PluginHookAgent;
  request: AgentPermissionRequest;
  values: FeishuSettingsValues;
}

/** 审批请求到达时发卡片。返回是否真的发了。 */
export async function notifyPermissionRequested(params: NotifyPermissionParams): Promise<boolean> {
  const { paseo, agent, request, values } = params;
  if (!values.notifyPermission) return false;

  const requestedAt = Date.now();
  const card = buildPermissionCard(agent, request, {
    requestedAt,
    link: await agentLink(paseo, agent.id),
  });
  const { messageId } = await sendCard(values, card);

  trackPermission({ agent, request, messageId, values, requestedAt });
  return true;
}

/** 审批被处理（无论在飞书还是 Paseo 界面）后把卡片置灰。 */
export async function markPermissionResolved(params: {
  requestId: string;
  resolution: AgentPermissionResponse;
}): Promise<void> {
  await resolvePermissionCard(params.requestId, params.resolution);
}
