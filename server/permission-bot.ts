import type { PaseoApi } from "@getpaseo/client";
import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import { Domain, EventDispatcher, LoggerLevel, WSClient } from "@larksuiteoapi/node-sdk";
import { permissionValueSchema } from "../shared/permission-values";
import type { FeishuSettingsValues } from "../shared/settings";
import { patchCard } from "./feishu-client";
import { agentLink } from "./paseo-link";
import {
  buildPermissionCard,
  buildResolvedCard,
  rawQuestions,
  readQuestions,
  type QuestionPicks,
} from "./permission-cards";

type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
type AgentPermissionResponse = PluginLifecycleEvents["agent.permission_resolved"]["resolution"];

interface PendingPermission {
  agent: PluginHookAgent;
  request: AgentPermissionRequest;
  messageId: string;
  values: FeishuSettingsValues;
  picks: QuestionPicks;
  /** 请求到达时间，用于在卡片上展示到达时刻 / 已等待 / 处理用时 */
  requestedAt: number;
  /** 是否由飞书卡片触发处理，置灰卡用它标注来源 */
  handledFromFeishu: boolean;
}

/** 飞书长连接推来的原始卡片回调节点 */
interface CardActionRaw {
  event_id?: string;
  operator?: { open_id?: string };
  action?: { value?: unknown; tag?: string };
  context?: { open_message_id?: string; open_chat_id?: string };
}

interface ToastResult {
  toast: { type: "success" | "error" | "info" | "warning"; content: string };
}

/** 卡片回调响应体：toast 提示 + 可选的新卡片（飞书要求 raw 包装） */
interface CardActionReply {
  toast: ToastResult["toast"];
  card?: { type: "raw"; data: unknown };
}

const pending = new Map<string, PendingPermission>();

/** 飞书可能重投同一个回调，用 event_id 做最近 500 条的去重 */
const seenEvents = new Set<string>();
const seenOrder: string[] = [];

let wsClient: WSClient | null = null;
let fingerprint = "";
let activeValues: FeishuSettingsValues | null = null;
let paseoRef: PaseoApi | null = null;

export function setPaseo(paseo: PaseoApi): void {
  paseoRef = paseo;
}

export function trackPermission(params: {
  agent: PluginHookAgent;
  request: AgentPermissionRequest;
  messageId: string;
  values: FeishuSettingsValues;
  requestedAt: number;
}): void {
  pending.set(params.request.id, {
    agent: params.agent,
    request: params.request,
    messageId: params.messageId,
    values: params.values,
    picks: new Map(),
    requestedAt: params.requestedAt,
    handledFromFeishu: false,
  });
}

/** 审批处理完（不论在哪处理）之后把卡片置灰 */
export async function resolvePermissionCard(
  requestId: string,
  resolution: AgentPermissionResponse,
): Promise<void> {
  const item = pending.get(requestId);
  if (!item) return;
  pending.delete(requestId);

  await patchCard(
    item.values,
    item.messageId,
    buildResolvedCard(item.agent, item.request, resolution, {
      source: item.handledFromFeishu ? "feishu" : "paseo",
      requestedAt: item.requestedAt,
      link: await deepLink(item.agent.id),
    }),
  );
}

/** 深链拿不到就不渲染按钮，卡片其余部分照常工作 */
async function deepLink(agentId: string): Promise<string | null> {
  return paseoRef ? agentLink(paseoRef, agentId) : null;
}

/** 飞书侧点击后立刻回给客户端的结果卡 */
async function resolvedCardFor(
  item: PendingPermission,
  response: AgentPermissionResponse,
): Promise<unknown> {
  return buildResolvedCard(item.agent, item.request, response, {
    source: "feishu",
    requestedAt: item.requestedAt,
    link: await deepLink(item.agent.id),
  });
}

function toast(type: ToastResult["toast"]["type"], content: string): ToastResult {
  return { toast: { type, content } };
}

function rememberEvent(eventId: string): boolean {
  if (seenEvents.has(eventId)) return false;
  seenEvents.add(eventId);
  seenOrder.push(eventId);
  if (seenOrder.length > 500) {
    const oldest = seenOrder.shift();
    if (oldest) seenEvents.delete(oldest);
  }
  return true;
}

/** 把卡片 JSON 包成回调响应要求的 raw 结构 */
function rawCard(card: unknown): { type: "raw"; data: unknown } {
  return { type: "raw", data: card };
}

function buildAnswers(item: PendingPermission): Record<string, string> | null {
  const questions = readQuestions(item.request);
  const answers: Record<string, string> = {};

  questions.forEach((question, index) => {
    const picked = item.picks.get(index);
    if (!picked || picked.size === 0) return;
    const labels = [...picked]
      .sort((a, b) => a - b)
      .map((optionIndex) => question.options[optionIndex]?.label)
      .filter((label): label is string => Boolean(label));
    if (labels.length > 0) {
      // 多选答案也必须是字符串：Paseo 只接受非空字符串，多个选项用逗号连接
      answers[question.question] = labels.join(", ");
    }
  });

  return Object.keys(answers).length === questions.length && questions.length > 0 ? answers : null;
}

async function submitResponse(
  item: PendingPermission,
  response: AgentPermissionResponse,
): Promise<void> {
  if (!paseoRef) throw new Error("Paseo 连接尚未就绪");
  // 先标来源，permission_resolved 钩子靠它区分飞书处理还是 Paseo 处理
  item.handledFromFeishu = true;
  await paseoRef.agents.ref(item.agent.id).respondToPermission({
    requestId: item.request.id,
    response,
  });
  // pending 交给 permission_resolved 钩子里的 resolvePermissionCard 删除，
  // 否则钩子找不到记录，灰色结果卡永远补不上
}

async function submitAnswers(item: PendingPermission): Promise<CardActionReply> {
  const answers = buildAnswers(item);
  if (!answers) return toast("warning", "还有题目没有选择");

  const response: AgentPermissionResponse = {
    behavior: "allow",
    updatedInput: { ...(item.request.input ?? {}), questions: rawQuestions(item.request), answers },
  };
  await submitResponse(item, response);
  return {
    ...toast("success", "已提交选择"),
    card: rawCard(await resolvedCardFor(item, response)),
  };
}

async function handleOption(
  item: PendingPermission,
  questionIndex: number,
  optionIndex: number,
): Promise<CardActionReply> {
  const questions = readQuestions(item.request);
  const question = questions[questionIndex];
  const option = question?.options[optionIndex];
  if (!question || !option) return toast("warning", "这个选项已经失效了");

  const picked = item.picks.get(questionIndex) ?? new Set<number>();

  if (question.multiSelect) {
    if (picked.has(optionIndex)) picked.delete(optionIndex);
    else picked.add(optionIndex);
    item.picks.set(questionIndex, picked);
    return {
      ...toast("success", picked.has(optionIndex) ? `已勾选：${option.label}` : `已取消：${option.label}`),
      card: rawCard(
        buildPermissionCard(item.agent, item.request, {
          picks: item.picks,
          requestedAt: item.requestedAt,
          link: await deepLink(item.agent.id),
        }),
      ),
    };
  }

  item.picks.set(questionIndex, new Set([optionIndex]));
  if (questions.length === 1) {
    return submitAnswers(item);
  }

  return {
    ...toast("success", `已选择：${option.label}`),
    card: rawCard(
      buildPermissionCard(item.agent, item.request, {
        picks: item.picks,
        requestedAt: item.requestedAt,
        link: await deepLink(item.agent.id),
      }),
    ),
  };
}

async function handleTool(item: PendingPermission, action: string | undefined): Promise<CardActionReply> {
  let response: AgentPermissionResponse;
  let message: string;
  if (action === "deny") {
    response = { behavior: "deny", message: "已拒绝" };
    message = "已拒绝";
  } else if (action === "always") {
    response = { behavior: "allow", updatedPermissions: item.request.suggestions ?? [] };
    message = "已允许并记住";
  } else {
    response = { behavior: "allow" };
    message = "已允许";
  }

  await submitResponse(item, response);
  return {
    ...toast("success", message),
    card: rawCard(await resolvedCardFor(item, response)),
  };
}

async function handlePlan(item: PendingPermission, actionId: string | undefined): Promise<CardActionReply> {
  const action = (item.request.actions ?? []).find((entry) => entry.id === actionId);
  if (!action) return toast("warning", "这个选项已经失效了");

  const response: AgentPermissionResponse =
    action.behavior === "deny"
      ? { behavior: "deny", selectedActionId: action.id }
      : { behavior: "allow", selectedActionId: action.id };
  await submitResponse(item, response);
  return {
    ...toast("success", `已选择：${action.label}`),
    card: rawCard(await resolvedCardFor(item, response)),
  };
}

async function act(
  item: PendingPermission,
  value: ReturnType<typeof permissionValueSchema.parse>,
): Promise<CardActionReply> {
  if (value.k === "option") {
    if (value.q === undefined || value.o === undefined) return toast("warning", "按钮参数不完整");
    return handleOption(item, value.q, value.o);
  }
  if (value.k === "submit") {
    return submitAnswers(item);
  }
  if (value.k === "plan") {
    return handlePlan(item, value.x);
  }
  return handleTool(item, value.x);
}

async function handleCardAction(raw: unknown): Promise<CardActionReply | undefined> {
  const event = (raw ?? {}) as CardActionRaw;

  if (event.event_id && !rememberEvent(event.event_id)) return undefined;

  const parsed = permissionValueSchema.safeParse(event.action?.value);
  if (!parsed.success) return toast("warning", "无法识别的操作，请在 Paseo 里处理");

  console.log(
    `[paseo-feishu] 卡片回调：k=${parsed.data.k} q=${parsed.data.q ?? "-"} o=${parsed.data.o ?? "-"} x=${parsed.data.x ?? "-"}`,
  );

  const values = activeValues;
  if (!values) return toast("error", "插件配置未就绪");

  const fromOwner =
    values.targetKind === "open_id"
      ? event.operator?.open_id === values.targetId
      : event.context?.open_chat_id === values.targetId;
  if (!fromOwner) return toast("warning", "这个操作不属于你");

  const item = pending.get(parsed.data.r);
  if (!item) return toast("warning", "请求已处理或已过期");
  if (item.agent.id !== parsed.data.a) return toast("warning", "请求与 agent 不匹配");

  try {
    return await act(item, parsed.data);
  } catch (error) {
    console.error(
      "[paseo-feishu] 处理审批回调失败:",
      error instanceof Error ? error.message : String(error),
    );
    return toast("error", error instanceof Error ? error.message : "处理失败");
  }
}

/** 配置变化时重启长连接；凭据没变就什么都不做 */
export function ensurePermissionBot(values: FeishuSettingsValues): void {
  const next = `${values.brand}:${values.appId}:${values.appSecret}`;
  if (wsClient && fingerprint === next) {
    activeValues = values;
    return;
  }

  stopPermissionBot();
  fingerprint = next;
  activeValues = values;

  const client = new WSClient({
    appId: values.appId,
    appSecret: values.appSecret,
    domain: values.brand === "lark" ? Domain.Lark : Domain.Feishu,
    loggerLevel: LoggerLevel.info,
    onReady: () => console.log("[paseo-feishu] 审批长连接已就绪"),
    // 断线重连由 SDK 按服务端下发的参数自动完成，这里只留可观测日志
    onReconnecting: () => console.log("[paseo-feishu] 审批长连接断开，正在重连…"),
    onReconnected: () => console.log("[paseo-feishu] 审批长连接已重连"),
    onError: (error: unknown) =>
      console.error(
        "[paseo-feishu] 审批长连接出错:",
        error instanceof Error ? error.message : String(error),
      ),
  });

  const dispatcher = new EventDispatcher({}).register({
    "card.action.trigger": (data: unknown) => handleCardAction(data),
  });

  wsClient = client;
  void client.start({ eventDispatcher: dispatcher }).catch((error: unknown) => {
    console.error(
      "[paseo-feishu] 审批长连接启动失败:",
      error instanceof Error ? error.message : String(error),
    );
  });
  console.log("[paseo-feishu] 审批长连接启动中…");
}

export function stopPermissionBot(): void {
  if (wsClient) {
    wsClient.close({ force: true });
    wsClient = null;
  }
  fingerprint = "";
  activeValues = null;
  pending.clear();
}
