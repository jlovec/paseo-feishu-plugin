import type { PluginHookAgent, PluginTurnOutcome } from "@getpaseo/plugin/server";

/** 卡片正文的字符上限，飞书对单条 markdown 有长度限制 */
const MAX_BODY = 1500;
/** 标题里的 agent 名不宜过长，手机上一行放不下 */
const MAX_TITLE = 40;

export function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`;
}

/** 项目名取 cwd 末级目录，完整路径收进底部技术信息 */
export function projectName(cwd: string): string {
  const trimmed = cwd.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || "未知项目";
}

/** 毫秒时长写成「2 分 13 秒」这种短文本 */
export function formatDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

/** 本地时钟的 HH:mm */
export function clockText(timestamp: number): string {
  const date = new Date(timestamp);
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 卡片标题统一成「事件 · agent」，一眼看出是哪个会话 */
export function cardHeader(template: string, event: string, agent: PluginHookAgent) {
  return {
    template,
    title: {
      tag: "plain_text",
      content: `${event} · ${truncate(agent.title ?? "未命名会话", MAX_TITLE)}`,
    },
  };
}

/** 头部两栏：项目名 + 一个随时间变化的字段 */
export function metaRow(agent: PluginHookAgent, label: string, value: string) {
  return {
    tag: "div",
    fields: [
      {
        is_short: true,
        text: {
          tag: "lark_md",
          content: `**项目**\n${truncate(projectName(agent.cwd), 40)}`,
        },
      },
      {
        is_short: true,
        text: { tag: "lark_md", content: `**${label}**\n${value}` },
      },
    ],
  };
}

/** 技术信息统一收进底部，正文只留决策需要的内容 */
export function techNote(agent: PluginHookAgent) {
  return {
    tag: "note",
    elements: [{ tag: "plain_text", content: truncate(`${agent.provider} · ${agent.cwd}`, 400) }],
  };
}

/** 「打开 Paseo」按钮；拿不到深链时返回 null，由调用方过滤 */
export function openPaseoAction(link: string | null | undefined) {
  if (!link) return null;
  return {
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "打开 Paseo" },
        type: "default",
        url: link,
      },
    ],
  };
}

export interface TurnCardOptions {
  summary: string | null;
  turns?: number;
  /** 本轮耗时，拿不到就显示「未知」 */
  durationMs?: number | null;
  /** paseo 深链，拿不到就不渲染按钮 */
  link?: string | null;
}

/** 一轮会话结束（完成 / 失败 / 取消）的卡片。 */
export function buildTurnCard(
  agent: PluginHookAgent,
  outcome: PluginTurnOutcome,
  options: TurnCardOptions,
) {
  const { summary, turns = 1, durationMs, link } = options;
  const duration = durationMs == null ? "未知" : formatDuration(durationMs);
  const linkAction = openPaseoAction(link);

  if (outcome.kind === "completed") {
    return {
      config: { wide_screen_mode: true },
      header: cardHeader("green", "✅ 完成", agent),
      elements: [
        metaRow(agent, "耗时", duration),
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
        ...(linkAction ? [linkAction] : []),
        techNote(agent),
      ],
    };
  }

  if (outcome.kind === "failed") {
    const code = outcome.error.code ? `（${outcome.error.code}）` : "";
    return {
      config: { wide_screen_mode: true },
      header: cardHeader("red", "❌ 失败", agent),
      elements: [
        metaRow(agent, "耗时", duration),
        { tag: "hr" },
        {
          tag: "markdown",
          content: `**错误${code}**\n${truncate(outcome.error.message, MAX_BODY)}`,
        },
        ...(linkAction ? [linkAction] : []),
        techNote(agent),
      ],
    };
  }

  return {
    config: { wide_screen_mode: true },
    header: cardHeader("grey", "⚪️ 取消", agent),
    elements: [
      metaRow(agent, "耗时", duration),
      { tag: "hr" },
      { tag: "markdown", content: `原因：${truncate(outcome.reason, MAX_BODY)}` },
      ...(linkAction ? [linkAction] : []),
      techNote(agent),
    ],
  };
}
