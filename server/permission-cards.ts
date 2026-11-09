import type { PluginHookAgent, PluginLifecycleEvents } from "@getpaseo/plugin/server";
import {
  cardHeader,
  clockText,
  formatDuration,
  metaRow,
  openPaseoAction,
  techNote,
  truncate,
} from "./cards";

type AgentPermissionRequest = PluginLifecycleEvents["agent.permission_requested"]["request"];
type AgentPermissionResponse = PluginLifecycleEvents["agent.permission_resolved"]["resolution"];
type ToolDetail = NonNullable<AgentPermissionRequest["detail"]>;

/** 卡片正文上限，飞书对单条 markdown 有长度限制 */
const MAX_BODY = 1200;
/** 飞书按钮文字不宜过长，超出会换行难看 */
const MAX_BUTTON_LABEL = 26;

/** 服务端记录的勾选状态：题号 → 选项号集合 */
export type QuestionPicks = Map<number, Set<number>>;

interface QuestionOption {
  label: string;
  description?: string;
}

interface Question {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect: boolean;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** 从 request.input.questions 里提取问题定义，字段缺失的题目直接跳过 */
export function readQuestions(request: AgentPermissionRequest): Question[] {
  const raw = request.input?.questions;
  if (!Array.isArray(raw)) return [];

  const questions: Question[] = [];
  for (const item of raw) {
    const record = readRecord(item);
    const text = record ? readString(record.question) : null;
    if (!record || !text) continue;

    const options: QuestionOption[] = [];
    if (Array.isArray(record.options)) {
      for (const option of record.options) {
        const opt = readRecord(option);
        const label = opt ? readString(opt.label) : null;
        if (!label) continue;
        options.push({ label, description: (opt ? readString(opt.description) : null) ?? undefined });
      }
    }

    questions.push({
      question: text,
      header: readString(record.header) ?? undefined,
      options,
      multiSelect: record.multiSelect === true,
    });
  }
  return questions;
}

/** 把原始 input 里的 questions 原样取出来，回写答案时一并带上 */
export function rawQuestions(request: AgentPermissionRequest): unknown[] {
  const raw = request.input?.questions;
  return Array.isArray(raw) ? raw : [];
}

function questionBlock(
  agent: PluginHookAgent,
  request: AgentPermissionRequest,
  question: Question,
  index: number,
  picks?: QuestionPicks,
) {
  const picked = picks?.get(index);
  return {
    tag: "action",
    actions: question.options.map((option, optionIndex) => {
      const chosen = picked?.has(optionIndex) === true;
      return {
        tag: "button",
        text: {
          tag: "plain_text",
          content: `${chosen ? "✅ " : ""}${truncate(option.label, MAX_BUTTON_LABEL)}`,
        },
        type: chosen ? "primary" : "default",
        value: {
          a: agent.id,
          r: request.id,
          k: "option" as const,
          q: index,
          o: optionIndex,
        },
      };
    }),
  };
}

function questionElements(
  agent: PluginHookAgent,
  request: AgentPermissionRequest,
  picks?: QuestionPicks,
) {
  const questions = readQuestions(request);
  const elements: unknown[] = [];

  questions.forEach((question, index) => {
    const picked = picks?.get(index);
    const progress = questions.length > 1 ? `第 ${index + 1}/${questions.length} 题 · ` : "";
    const pickedText = question.multiSelect && picked?.size ? `，已选 ${picked.size} 项` : "";
    elements.push({
      tag: "div",
      text: {
        tag: "lark_md",
        content: `**${progress}${question.question}**${
          question.multiSelect ? `（可多选${pickedText}）` : ""
        }`,
      },
    });

    const descriptions = question.options
      .filter((option) => option.description)
      .map((option) => `**${option.label}** · ${option.description}`)
      .join("\n");
    if (descriptions) {
      elements.push({
        tag: "div",
        text: { tag: "lark_md", content: truncate(descriptions, 800) },
      });
    }

    if (question.options.length > 0) {
      elements.push(questionBlock(agent, request, question, index, picks));
    }
  });

  const needsSubmit = questions.length > 1 || questions.some((question) => question.multiSelect);
  if (needsSubmit) {
    elements.push({
      tag: "action",
      actions: [
        {
          tag: "button",
          text: { tag: "plain_text", content: "提交选择" },
          type: "primary",
          value: { a: agent.id, r: request.id, k: "submit" as const },
        },
      ],
    });
  }

  return elements;
}

/** 把结构化工具入参压成一句人话，只有拿不到详情时才回退 JSON */
function toolBody(request: AgentPermissionRequest): string {
  const detail: ToolDetail | undefined = request.detail;
  if (detail) {
    switch (detail.type) {
      case "shell":
        return "```bash\n" + truncate(detail.command, 800) + "\n```";
      case "read":
        return `读取文件 \`${truncate(detail.filePath, 300)}\``;
      case "write":
        return `写入文件 \`${truncate(detail.filePath, 300)}\``;
      case "edit":
        return `编辑文件 \`${truncate(detail.filePath, 300)}\``;
      case "search":
        return `搜索 \`${truncate(detail.query, 200)}\``;
      case "fetch":
        return `请求 \`${truncate(detail.url, 300)}\``;
      case "worktree_setup":
        return `创建 worktree \`${truncate(detail.worktreePath, 200)}\``;
      case "sub_agent":
        return `子代理：${truncate(detail.description ?? detail.subAgentType ?? "未命名", 200)}`;
      case "plain_text": {
        const text = readString(detail.text) ?? readString(detail.label);
        return text ? truncate(text, MAX_BODY) : "_没有可展示的入参_";
      }
      case "plan":
        return truncate(detail.text, MAX_BODY);
      case "unknown":
        break;
    }
  }

  const raw = detail?.type === "unknown" ? detail.input : request.input;
  if (raw === undefined || raw === null) return "_没有可展示的入参_";
  if (typeof raw === "object" && !Array.isArray(raw) && Object.keys(raw).length === 0) {
    return "_没有可展示的入参_";
  }
  return "```json\n" + truncate(JSON.stringify(raw, null, 2), 600) + "\n```";
}

function toolElements(agent: PluginHookAgent, request: AgentPermissionRequest) {
  const canRemember = Array.isArray(request.suggestions) && request.suggestions.length > 0;
  const buttons = [
    {
      tag: "button",
      text: { tag: "plain_text", content: "允许" },
      type: "primary",
      value: { a: agent.id, r: request.id, k: "tool" as const, x: "allow" },
    },
    {
      tag: "button",
      text: { tag: "plain_text", content: "拒绝" },
      type: "danger",
      value: { a: agent.id, r: request.id, k: "tool" as const, x: "deny" },
    },
  ];
  if (canRemember) {
    // MCP 工具名形如 mcp__server__tool，按钮上只带末段短名
    const shortName = request.name.split("__").pop() ?? request.name;
    buttons.push({
      tag: "button",
      text: {
        tag: "plain_text",
        content: truncate(shortName.length <= 10 ? `总是允许 ${shortName}` : "总是允许", MAX_BUTTON_LABEL),
      },
      type: "default",
      value: { a: agent.id, r: request.id, k: "tool" as const, x: "always" },
    });
  }

  return [
    { tag: "div", text: { tag: "lark_md", content: `**工具** \`${truncate(request.name, 60)}\`` } },
    { tag: "div", text: { tag: "lark_md", content: toolBody(request) } },
    { tag: "action", actions: buttons },
  ];
}

function planBody(request: AgentPermissionRequest): string {
  const planText = readString(request.metadata?.planText);
  return truncate(planText ?? request.description ?? "_计划内容为空_", MAX_BODY);
}

function planElements(agent: PluginHookAgent, request: AgentPermissionRequest) {
  const actions = request.actions ?? [];
  if (actions.length === 0) {
    return toolElements(agent, request);
  }

  return [
    { tag: "div", text: { tag: "lark_md", content: planBody(request) } },
    {
      tag: "action",
      actions: actions.map((action) => ({
        tag: "button",
        text: { tag: "plain_text", content: truncate(action.label, MAX_BUTTON_LABEL) },
        type: action.variant === "danger" ? "danger" : action.variant === "primary" ? "primary" : "default",
        value: { a: agent.id, r: request.id, k: "plan" as const, x: action.id },
      })),
    },
  ];
}

export interface PermissionCardOptions {
  /** 有值时渲染成「当前勾选状态」的草稿卡片 */
  picks?: QuestionPicks;
  /** 请求到达时间，用于展示到达时刻或已等待时长 */
  requestedAt?: number;
  /** paseo 深链，拿不到就不渲染按钮 */
  link?: string | null;
}

/** 按 kind 生成审批卡片 */
export function buildPermissionCard(
  agent: PluginHookAgent,
  request: AgentPermissionRequest,
  options: PermissionCardOptions = {},
) {
  let template = "blue";
  let event = "🔐 需要审批";
  let elements: unknown[];

  if (request.kind === "question") {
    template = "blue";
    event = "❓ 需要选择";
    elements = questionElements(agent, request, options.picks);
  } else if (request.kind === "plan") {
    template = "orange";
    event = "📋 计划待确认";
    elements = planElements(agent, request);
  } else if (request.kind === "tool") {
    template = "orange";
    event = "🔧 工具授权";
    elements = toolElements(agent, request);
  } else {
    elements = toolElements(agent, request);
  }

  if (request.title) {
    elements.unshift({ tag: "div", text: { tag: "lark_md", content: truncate(request.title, 300) } });
  }

  const requestedAt = options.requestedAt ?? Date.now();
  const meta = options.picks
    ? metaRow(agent, "已等待", formatDuration(Date.now() - requestedAt))
    : metaRow(agent, "到达", clockText(requestedAt));
  const linkAction = openPaseoAction(options.link);

  return {
    config: { wide_screen_mode: true },
    header: cardHeader(template, event, agent),
    elements: [
      meta,
      { tag: "hr" },
      ...elements,
      ...(linkAction ? [linkAction] : []),
      techNote(agent),
    ],
  };
}

/** 把一次已完成的审批描述成一句话 */
function describeResolution(
  request: AgentPermissionRequest,
  resolution: AgentPermissionResponse,
): string {
  if (resolution.behavior === "deny") {
    return resolution.message ? `已拒绝：${truncate(resolution.message, 200)}` : "已拒绝";
  }

  if (request.kind === "question") {
    const answers = readRecord(resolution.updatedInput?.answers);
    if (answers) {
      const parts = Object.values(answers)
        .map((value) => readString(value))
        .filter((value): value is string => value !== null);
      if (parts.length > 0) return `已选择：${parts.join("；")}`;
    }
    return "已作答";
  }

  if (request.kind === "plan" && resolution.selectedActionId) {
    const action = (request.actions ?? []).find((item) => item.id === resolution.selectedActionId);
    return action ? `已选择：${action.label}` : `已选择：${resolution.selectedActionId}`;
  }

  const remembered =
    Array.isArray(resolution.updatedPermissions) && resolution.updatedPermissions.length > 0;
  return remembered ? "已允许，并记住该权限" : "已允许";
}

export interface ResolvedCardOptions {
  /** 在哪个界面处理：飞书卡片还是 Paseo 客户端 */
  source: "feishu" | "paseo";
  requestedAt?: number;
  link?: string | null;
}

/** 审批处理完之后的置灰卡片，替换掉原来的按钮 */
export function buildResolvedCard(
  agent: PluginHookAgent,
  request: AgentPermissionRequest,
  resolution: AgentPermissionResponse,
  options: ResolvedCardOptions,
) {
  const waited =
    options.requestedAt == null ? "未知" : formatDuration(Date.now() - options.requestedAt);
  const linkAction = openPaseoAction(options.link);

  return {
    config: { wide_screen_mode: true },
    header: cardHeader("grey", "✅ 已处理", agent),
    elements: [
      metaRow(agent, "处理用时", waited),
      { tag: "hr" },
      {
        tag: "div",
        text: { tag: "lark_md", content: describeResolution(request, resolution) },
      },
      {
        tag: "note",
        elements: [
          { tag: "plain_text", content: `来源：${options.source === "feishu" ? "飞书" : "Paseo"}` },
        ],
      },
      ...(linkAction ? [linkAction] : []),
      techNote(agent),
    ],
  };
}
