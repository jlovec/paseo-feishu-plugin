import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";
import type { FeishuSettingsValues } from "../shared/settings";
import { buildTurnCard } from "./cards";
import { patchCard, sendCard } from "./feishu-client";
import { agentLink } from "./paseo-link";

/** 同一 agent 在这个窗口内再次完成，就更新上一条消息而不是新发 */
const MERGE_WINDOW_MS = 30_000;

/** agent → 本轮开始时间，用于在结果卡片上展示耗时 */
const turnStartedAt = new Map<string, number>();

/** 记录一轮会话开始，turn_ended 时算耗时 */
export function markTurnStarted(agentId: string): void {
  turnStartedAt.set(agentId, Date.now());
}

interface TurnMessage {
  messageId: string;
  /** 窗口起点，合并期间不更新，保证一个窗口最多一条新消息 */
  windowStart: number;
  /** 本窗口内已合并的轮数 */
  turns: number;
}

const lastTurnMessage = new Map<string, TurnMessage>();

/** 从时间线末尾往前找最后一条有内容的助手回复 */
async function lastAssistantText(paseo: PaseoApi, agentId: string): Promise<string | null> {
  try {
    const payload = await paseo.agents
      .ref(agentId)
      .timeline.refetch({ direction: "tail", limit: 20 });

    for (let i = payload.entries.length - 1; i >= 0; i -= 1) {
      const { item } = payload.entries[i];
      if (item.type === "assistant_message" && item.text.trim()) {
        return item.text.trim();
      }
    }
  } catch {
    // 取不到历史不影响通知本身，卡片退化成「没有文字回复」
  }
  return null;
}

export interface NotifyTurnParams {
  paseo: PaseoApi;
  agent: PluginHookAgent;
  outcome: PluginTurnOutcome;
  values: FeishuSettingsValues;
}

/** 一轮会话结束时按开关发结果卡片。返回是否真的发了。 */
export async function notifyTurnEnded(params: NotifyTurnParams): Promise<boolean> {
  const { paseo, agent, outcome, values } = params;

  if (outcome.kind === "completed" && !values.notifyCompleted) return false;
  if (outcome.kind === "failed" && !values.notifyFailed) return false;
  if (outcome.kind === "canceled" && !values.notifyCanceled) return false;

  const startedAt = turnStartedAt.get(agent.id);
  const durationMs = startedAt == null ? null : Date.now() - startedAt;
  turnStartedAt.delete(agent.id);

  const link = await agentLink(paseo, agent.id);

  // 失败/取消不合并，独立发一条，并断开该 agent 的合并链
  if (outcome.kind !== "completed") {
    lastTurnMessage.delete(agent.id);
    await sendCard(values, buildTurnCard(agent, outcome, { summary: null, durationMs, link }));
    return true;
  }

  const summary = await lastAssistantText(paseo, agent.id);
  const previous = lastTurnMessage.get(agent.id);
  const now = Date.now();

  if (previous && now - previous.windowStart < MERGE_WINDOW_MS) {
    const turns = previous.turns + 1;
    try {
      await patchCard(
        values,
        previous.messageId,
        buildTurnCard(agent, outcome, { summary, turns, durationMs, link }),
      );
      lastTurnMessage.set(agent.id, { ...previous, turns });
      console.log(
        `[paseo-feishu] 合并会话通知：${agent.title ?? agent.id} 第 ${turns} 轮`,
      );
      return true;
    } catch {
      // 就地更新失败就退回新发一条，通知不能丢
      lastTurnMessage.delete(agent.id);
    }
  }

  const { messageId } = await sendCard(
    values,
    buildTurnCard(agent, outcome, { summary, durationMs, link }),
  );
  lastTurnMessage.set(agent.id, { messageId, windowStart: now, turns: 1 });
  return true;
}
