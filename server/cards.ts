import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";

/** 卡片正文的字符上限，飞书对单条 markdown 有长度限制 */
const MAX_BODY = 1500;

export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/** agent 的两个短字段：标题与目录 */
export function agentFields(agent: PluginHookAgent) {
  return {
    tag: "div",
    fields: [
      {
        is_short: true,
        text: {
          tag: "lark_md",
          content: `**Agent**\n${truncate(agent.title ?? "未命名", 60)}`,
        },
      },
      {
        is_short: true,
        text: {
          tag: "lark_md",
          content: `**目录**\n${truncate(agent.cwd, 120)}`,
        },
      },
    ],
  };
}

function footer(agent: PluginHookAgent) {
  return {
    tag: "note",
    elements: [{ tag: "plain_text", content: `Paseo · ${agent.provider}` }],
  };
}

/** 一轮会话结束（完成 / 失败 / 取消）的卡片。 */
export function buildTurnCard(
  agent: PluginHookAgent,
  outcome: PluginTurnOutcome,
  summary: string | null,
  turns = 1,
) {
  if (outcome.kind === "completed") {
    return {
      config: { wide_screen_mode: true },
      header: {
        template: "green",
        title: { tag: "plain_text", content: "✅ 会话完成" },
      },
      elements: [
        agentFields(agent),
        { tag: "hr" },
        {
          tag: "markdown",
          content: summary ? truncate(summary, MAX_BODY) : "_这一轮没有文字回复_",
        },
        ...(turns > 1
          ? [
              {
                tag: "note",
                elements: [{ tag: "plain_text", content: `30 秒内合并 ${turns} 轮` }],
              },
            ]
          : []),
        footer(agent),
      ],
    };
  }

  if (outcome.kind === "failed") {
    const code = outcome.error.code ? `（${outcome.error.code}）` : "";
    return {
      config: { wide_screen_mode: true },
      header: {
        template: "red",
        title: { tag: "plain_text", content: "❌ 会话失败" },
      },
      elements: [
        agentFields(agent),
        { tag: "hr" },
        {
          tag: "markdown",
          content: `**错误${code}**\n${truncate(outcome.error.message, MAX_BODY)}`,
        },
        footer(agent),
      ],
    };
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      template: "grey",
      title: { tag: "plain_text", content: "⚪️ 会话取消" },
    },
    elements: [
      agentFields(agent),
      { tag: "hr" },
      { tag: "markdown", content: `原因：${truncate(outcome.reason, MAX_BODY)}` },
      footer(agent),
    ],
  };
}
