// 必须在任何第三方 Node 包之前执行，见文件内注释
import "./server/runtime-shim";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { beginRegistration, pollRegistration } from "./server/app-registration";
import { sendCard } from "./server/feishu-client";
import { notifyTurnEnded } from "./server/notify";
import { ensurePermissionBot, setPaseo, stopPermissionBot } from "./server/permission-bot";
import { markPermissionResolved, notifyPermissionRequested } from "./server/permission-notify";
import { notifyTestRpc, registrationBeginRpc, registrationPollRpc } from "./shared/rpc";
import { feishuSettings } from "./shared/settings";

/** 连接自检用的最小卡片，走卡片 1.0 格式，兼容性最好。 */
function buildTestCard() {
  return {
    config: { wide_screen_mode: true },
    header: {
      template: "blue",
      title: { tag: "plain_text", content: "Paseo 连接测试" },
    },
    elements: [
      { tag: "markdown", content: "插件已连上飞书，后续的会话通知与审批卡片会发到这个会话。" },
      {
        tag: "note",
        elements: [{ tag: "plain_text", content: "来自 Paseo 飞书插件" }],
      },
    ],
  };
}

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(feishuSettings);

  /** 审批开关或凭据变化时维持/关闭长连接 */
  function applySettings(state: Awaited<ReturnType<typeof settings.read>>): void {
    if (state.status !== "ready") {
      stopPermissionBot();
      return;
    }
    const values = state.values;
    if (!values.notifyPermission || !values.appId || !values.appSecret || !values.targetId) {
      stopPermissionBot();
      return;
    }
    ensurePermissionBot(values);
  }

  settings.subscribe((state) => applySettings(state));
  void settings.read().then(applySettings).catch(() => stopPermissionBot());

  server.handle(registrationBeginRpc, async (input) => beginRegistration(input.brand));

  server.handle(registrationPollRpc, async (input) => pollRegistration(input.sessionId));

  console.log("[paseo-feishu] 插件已就绪：settings + 3 个 RPC 注册完成");

  server.on("agent.created", async (_event, context) => {
    setPaseo(context.paseo);
  });

  server.on("agent.permission_requested", async (event, context) => {
    setPaseo(context.paseo);

    const state = await settings.read();
    if (state.status !== "ready") return;

    const values = state.values;
    if (!values.notifyPermission) return;
    if (!values.appId || !values.appSecret || !values.targetId) return;

    try {
      const sent = await notifyPermissionRequested({
        agent: event.agent,
        request: event.request,
        values,
      });
      if (sent) {
        console.log(
          `[paseo-feishu] 已发送审批卡片：${event.request.kind} · ${event.agent.title ?? event.agent.id}`,
        );
      }
    } catch (error) {
      console.error(
        "[paseo-feishu] 审批卡片发送失败:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  server.on("agent.permission_resolved", async (event, context) => {
    setPaseo(context.paseo);
    try {
      await markPermissionResolved({
        requestId: event.requestId,
        resolution: event.resolution,
      });
    } catch (error) {
      console.error(
        "[paseo-feishu] 审批卡片置灰失败:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  server.on("agent.turn_ended", async (event, context) => {
    const state = await settings.read();
    if (state.status !== "ready") return;

    const values = state.values;
    if (!values.appId || !values.appSecret || !values.targetId) return;

    try {
      const sent = await notifyTurnEnded({
        paseo: context.paseo,
        agent: event.agent,
        outcome: event.outcome,
        values,
      });
      if (sent) {
        console.log(
          `[paseo-feishu] 已发送会话通知：${event.outcome.kind} · ${event.agent.title ?? event.agent.id}`,
        );
      }
    } catch (error) {
      console.error(
        "[paseo-feishu] 会话通知发送失败:",
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  server.handle(notifyTestRpc, async (_input, context) => {
    setPaseo(context.paseo);
    const state = await settings.read();
    if (state.status !== "ready") {
      return { status: "error" as const, message: "配置尚未就绪，请稍后再试" };
    }

    const values = state.values;
    if (!values.appId || !values.appSecret) {
      return { status: "error" as const, message: "请先配置 App ID 与 App Secret" };
    }
    if (!values.targetId) {
      return { status: "error" as const, message: "请先填写通知目标" };
    }

    try {
      const { messageId } = await sendCard(values, buildTestCard());
      return { status: "ok" as const, messageId };
    } catch (error) {
      return {
        status: "error" as const,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  });

  return () => {
    stopPermissionBot();
  };
}
