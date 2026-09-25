import { defaultLlmModelParams, normalizeLlmModelParams, type LlmModelParams } from "./llm-params";

/**
 * 统一的大模型客户端（OpenAI 兼容）。
 *
 * 负责按配置组装请求（Chat Completions 或 Responses API）、发送（含流式拼接）、解析响应、
 * 归类错误。调用方只传 messages、是否需要 JSON，以及自己原有的默认超时 / token 预算 / temperature。
 * 纯函数（组装、解析、归类）全部导出，便于单测。
 */

export type LlmContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

export type LlmMessage = {
  role: "system" | "user" | "assistant";
  content: string | LlmContentPart[];
};

export type LlmEndpoint = {
  baseUrl: string;
  model: string;
  apiKey: string;
  params?: LlmModelParams | undefined;
};

/** 调用方原有的默认值；高级参数里未配置（null / default）时使用。 */
export type LlmCallDefaults = {
  timeoutMs: number;
  /** 输出 token 预算；undefined 表示该调用原本就不发送上限 */
  maxTokens?: number | undefined;
  /** temperature；undefined 表示该调用原本就不发送 */
  temperature?: number | undefined;
};

export type LlmCallRequest = {
  messages: LlmMessage[];
  /** 是否需要 JSON 对象输出 */
  json: boolean;
  defaults: LlmCallDefaults;
};

export type LlmUsage = {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  reasoningTokens: number | null;
};

export type LlmErrorKind =
  | "http"
  | "timeout"
  | "network"
  | "length_exhausted"
  | "reasoning_only"
  | "empty"
  | "unrecognized"
  | "invalid_json";

export type LlmCallReport = {
  ok: boolean;
  error: { kind: LlmErrorKind; message: string } | null;
  /** 提取出的正文（不含思考内容） */
  text: string;
  /** json 模式下提取出的第一个完整 JSON 对象 */
  json: Record<string, unknown> | null;
  finishReason: string | null;
  usage: LlmUsage | null;
  httpStatus: number | null;
  latencyMs: number;
  /** 原始响应体前 2KB，已脱敏 */
  rawBody: string;
  apiFormat: LlmModelParams["apiFormat"];
  stream: boolean;
};

export class LlmError extends Error {
  constructor(
    readonly kind: LlmErrorKind,
    message: string,
    readonly report: LlmCallReport,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export const LLM_RAW_BODY_PREVIEW_BYTES = 2_048;
export const LLM_PROMPT_JSON_INSTRUCTION = "只返回一个 JSON 对象，不要 Markdown 代码块，不要任何额外文字。";

// ─── 请求组装 ────────────────────────────────────────────────────────────

export function resolveLlmTimeoutMs(params: LlmModelParams, defaults: LlmCallDefaults) {
  return params.timeoutSeconds !== null ? params.timeoutSeconds * 1_000 : defaults.timeoutMs;
}

export function buildLlmRequest(endpoint: LlmEndpoint, request: LlmCallRequest): { url: string; body: Record<string, unknown> } {
  const params = endpoint.params ?? defaultLlmModelParams;
  const baseUrl = endpoint.baseUrl.trim().replace(/\/+$/, "");
  const messages = request.json && params.jsonMode === "prompt" ? withPromptJsonInstruction(request.messages) : request.messages;
  const maxTokens = params.maxTokens ?? request.defaults.maxTokens;
  const temperature = params.temperatureMode === "omit"
    ? undefined
    : params.temperatureMode === "custom"
      ? params.temperature
      : request.defaults.temperature;
  const wantNativeJson = request.json && params.jsonMode === "native";

  if (params.apiFormat === "responses") {
    const body: Record<string, unknown> = {
      model: endpoint.model,
      input: messages.map(toResponsesInputItem),
    };
    if (temperature !== undefined) body.temperature = temperature;
    if (params.maxTokensField !== "omit" && maxTokens !== undefined) body.max_output_tokens = maxTokens;
    if (params.reasoningEffort !== "omit") body.reasoning = { effort: params.reasoningEffort };
    if (wantNativeJson) body.text = { format: { type: "json_object" } };
    if (params.stream) body.stream = true;
    return { url: `${baseUrl}/responses`, body: { ...body, ...params.extraBody } };
  }

  const body: Record<string, unknown> = {
    model: endpoint.model,
    messages,
  };
  if (temperature !== undefined) body.temperature = temperature;
  if (params.maxTokensField !== "omit" && maxTokens !== undefined) body[params.maxTokensField] = maxTokens;
  if (params.reasoningEffort !== "omit") body.reasoning_effort = params.reasoningEffort;
  if (wantNativeJson) body.response_format = { type: "json_object" };
  if (params.stream) body.stream = true;
  return { url: `${baseUrl}/chat/completions`, body: { ...body, ...params.extraBody } };
}

function withPromptJsonInstruction(messages: LlmMessage[]): LlmMessage[] {
  const index = messages.findIndex((message) => message.role === "system" && typeof message.content === "string");
  if (index < 0) {
    return [{ role: "system", content: LLM_PROMPT_JSON_INSTRUCTION }, ...messages];
  }
  return messages.map((message, i) => i === index ? { ...message, content: `${message.content as string}\n\n${LLM_PROMPT_JSON_INSTRUCTION}` } : message);
}

function toResponsesInputItem(message: LlmMessage) {
  if (typeof message.content === "string") {
    return { role: message.role, content: message.content };
  }
  return {
    role: message.role,
    content: message.content.map((part) => part.type === "text"
      ? { type: message.role === "assistant" ? "output_text" : "input_text", text: part.text }
      : { type: "input_image", image_url: part.image_url.url }),
  };
}

// ─── 响应解析 ────────────────────────────────────────────────────────────

export type ParsedLlmResponse = {
  text: string;
  hasReasoning: boolean;
  finishReason: string | null;
  usage: LlmUsage | null;
};

const reasoningPartTypes = new Set(["reasoning", "thinking", "reasoning_content", "redacted_thinking"]);

/** content 为字符串直接取；为数组时只拼 text 类的片段，跳过思考片段。 */
export function extractContentText(content: unknown): { text: string; hasReasoning: boolean } {
  if (typeof content === "string") {
    return { text: content, hasReasoning: false };
  }
  if (!Array.isArray(content)) {
    return { text: "", hasReasoning: false };
  }
  let text = "";
  let hasReasoning = false;
  for (const part of content) {
    if (typeof part === "string") {
      text += part;
      continue;
    }
    if (!part || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "text";
    if (reasoningPartTypes.has(type)) {
      hasReasoning = true;
      continue;
    }
    if ((type === "text" || type === "output_text") && typeof record.text === "string") {
      text += record.text;
    }
  }
  return { text, hasReasoning };
}

/** 解析 Chat Completions 响应；结构无法识别时返回 null。 */
export function parseChatCompletionResponse(data: unknown): ParsedLlmResponse | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const choices = record.choices;
  if (!Array.isArray(choices) || choices.length === 0) return null;
  const choice = choices[0] as Record<string, unknown> | undefined;
  const message = (choice?.message ?? choice?.delta) as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const content = extractContentText(message.content);
  const reasoningText = firstString(message.reasoning_content, message.reasoning, message.thinking);
  return {
    text: content.text,
    hasReasoning: content.hasReasoning || Boolean(reasoningText?.trim()) || isNonEmptyObject(message.reasoning),
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null,
    usage: parseUsage(record.usage),
  };
}

/** 解析 Responses API 响应（优先 output_text，否则从 output[] 的 message 里提取）。 */
export function parseResponsesApiResponse(data: unknown): ParsedLlmResponse | null {
  if (!data || typeof data !== "object") return null;
  const record = data as Record<string, unknown>;
  const response = record.object !== "response" && record.response && typeof record.response === "object"
    ? record.response as Record<string, unknown>
    : record;
  const output = response.output;
  if (!Array.isArray(output) && typeof response.output_text !== "string") return null;

  let text = "";
  let hasReasoning = false;
  for (const item of Array.isArray(output) ? output : []) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "reasoning") {
      hasReasoning = true;
      continue;
    }
    if (entry.type === "message" || entry.type === undefined) {
      const content = extractContentText(entry.content);
      text += content.text;
      hasReasoning ||= content.hasReasoning;
    }
  }
  if (!text && typeof response.output_text === "string") {
    text = response.output_text;
  }
  const incomplete = response.incomplete_details as Record<string, unknown> | null | undefined;
  const finishReason = response.status === "incomplete"
    ? incomplete?.reason === "max_output_tokens" ? "length" : String(incomplete?.reason ?? "incomplete")
    : typeof response.status === "string" ? response.status : null;
  return { text, hasReasoning, finishReason, usage: parseUsage(response.usage) };
}

export function parseUsage(value: unknown): LlmUsage | null {
  if (!value || typeof value !== "object") return null;
  const usage = value as Record<string, unknown>;
  const completionDetails = (usage.completion_tokens_details ?? usage.output_tokens_details) as Record<string, unknown> | undefined;
  return {
    promptTokens: numberOrNull(usage.prompt_tokens ?? usage.input_tokens),
    completionTokens: numberOrNull(usage.completion_tokens ?? usage.output_tokens),
    totalTokens: numberOrNull(usage.total_tokens),
    reasoningTokens: numberOrNull(completionDetails?.reasoning_tokens ?? usage.reasoning_tokens),
  };
}

// ─── 流式拼接 ────────────────────────────────────────────────────────────

/** 把 SSE 文本拆成 data: 事件的 JSON 列表（忽略 [DONE] 与无法解析的行）。 */
export function parseSseEvents(raw: string): unknown[] {
  const events: unknown[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n")
      .trim();
    if (!data || data === "[DONE]") continue;
    try {
      events.push(JSON.parse(data));
    } catch {
      // 忽略心跳等非 JSON 行
    }
  }
  return events;
}

/** Chat Completions 流：把 delta 拼成一个完整的非流式响应。 */
export function assembleChatCompletionStream(raw: string): Record<string, unknown> | null {
  const events = parseSseEvents(raw);
  if (events.length === 0) return null;
  let content = "";
  let reasoning = "";
  let finishReason: string | null = null;
  let usage: unknown = null;
  let error: unknown = null;
  for (const event of events) {
    const record = event as Record<string, unknown>;
    if (record.error) error = record.error;
    if (record.usage) usage = record.usage;
    const choice = Array.isArray(record.choices) ? record.choices[0] as Record<string, unknown> | undefined : undefined;
    if (!choice) continue;
    const delta = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
    if (delta) {
      content += extractContentText(delta.content).text;
      reasoning += firstString(delta.reasoning_content, delta.reasoning, delta.thinking) ?? "";
    }
    if (typeof choice.finish_reason === "string") finishReason = choice.finish_reason;
  }
  if (error && !content) return { error };
  return {
    choices: [{ message: { role: "assistant", content, ...(reasoning ? { reasoning_content: reasoning } : {}) }, finish_reason: finishReason }],
    ...(usage ? { usage } : {}),
  };
}

/** Responses API 流：优先取 response.completed / incomplete 事件里的完整 response，否则按 delta 拼接。 */
export function assembleResponsesStream(raw: string): Record<string, unknown> | null {
  const events = parseSseEvents(raw);
  if (events.length === 0) return null;
  let final: Record<string, unknown> | null = null;
  let text = "";
  for (const event of events) {
    const record = event as Record<string, unknown>;
    if ((record.type === "response.completed" || record.type === "response.incomplete" || record.type === "response.failed")
      && record.response && typeof record.response === "object") {
      final = record.response as Record<string, unknown>;
    }
    if (record.type === "response.output_text.delta" && typeof record.delta === "string") {
      text += record.delta;
    }
    if (record.type === "error" || record.error) {
      return { error: record.error ?? record };
    }
  }
  if (final) {
    const parsed = parseResponsesApiResponse(final);
    return parsed && !parsed.text && text ? { ...final, output_text: text } : final;
  }
  return text ? { object: "response", status: "completed", output_text: text, output: [] } : null;
}

// ─── JSON 提取 ───────────────────────────────────────────────────────────

/**
 * 从模型输出里提取第一个完整的 JSON 对象：容忍 ```json 代码块与前后夹带的文字，
 * 按括号配对（跳过字符串里的括号）找出第一个能解析的对象。
 */
export function extractFirstJsonObject(raw: string): Record<string, unknown> | null {
  const text = raw.replace(/```(?:json|JSON)?/g, "").trim();
  for (let start = text.indexOf("{"); start >= 0; start = text.indexOf("{", start + 1)) {
    const end = findMatchingBrace(text, start);
    if (end < 0) continue;
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // 继续尝试下一个 {
    }
  }
  return null;
}

function findMatchingBrace(text: string, start: number) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const char = text.charAt(i);
    if (inString) {
      if (char === "\\") i += 1;
      else if (char === "\"") inString = false;
      continue;
    }
    if (char === "\"") inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ─── 结果归类 ────────────────────────────────────────────────────────────

export function classifyParsedResponse(
  parsed: ParsedLlmResponse | null,
  json: boolean,
): { error: { kind: LlmErrorKind; message: string } | null; json: Record<string, unknown> | null } {
  if (!parsed) {
    return { error: { kind: "unrecognized", message: "响应结构无法识别：没有找到 choices 或 output，请检查接口格式（Chat Completions / Responses API）是否与网关一致。" }, json: null };
  }
  if (!parsed.text.trim()) {
    if (parsed.finishReason === "length") {
      const reasoning = parsed.usage?.reasoningTokens;
      return {
        error: {
          kind: "length_exhausted",
          message: `输出上限被思考过程耗尽，请调大输出上限或降低推理强度${reasoning !== null && reasoning !== undefined ? `（reasoning_tokens: ${reasoning}）` : ""}。`,
        },
        json: null,
      };
    }
    if (parsed.hasReasoning) {
      return { error: { kind: "reasoning_only", message: "模型只返回了思考内容，没有正文。请调大输出上限、降低推理强度，或确认网关会返回正文。" }, json: null };
    }
    return { error: { kind: "empty", message: `模型已响应，但没有返回正文${parsed.finishReason ? `（finish_reason: ${parsed.finishReason}）` : ""}。` }, json: null };
  }
  if (!json) {
    return { error: null, json: null };
  }
  const object = extractFirstJsonObject(parsed.text);
  if (!object) {
    return { error: { kind: "invalid_json", message: "模型返回的正文里没有可解析的 JSON 对象。" }, json: null };
  }
  return { error: null, json: object };
}

export function describeHttpError(status: number, bodyText: string) {
  let detail = "";
  try {
    const data = JSON.parse(bodyText) as Record<string, unknown>;
    const error = data.error;
    detail = typeof error === "string"
      ? error
      : error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string"
        ? String((error as Record<string, unknown>).message)
        : typeof data.message === "string" ? data.message : "";
  } catch {
    detail = bodyText.trim().slice(0, 200);
  }
  return `HTTP ${status}${detail ? `：${detail}` : ""}`;
}

/** 脱敏：去掉原始响应里出现的密钥与常见 key 形态，再截取前 2KB。 */
export function redactRawBody(raw: string, secrets: string[]) {
  let text = raw;
  for (const secret of secrets) {
    if (secret && secret.length >= 4) {
      text = text.split(secret).join("***");
    }
  }
  text = text
    .replace(/\b(sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g, "$1-***")
    .replace(/(Bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1***")
    .replace(/("(?:api[_-]?key|authorization|access[_-]?token|secret)"\s*:\s*")[^"]*"/gi, "$1***\"");
  return text.length > LLM_RAW_BODY_PREVIEW_BYTES ? `${text.slice(0, LLM_RAW_BODY_PREVIEW_BYTES)}…` : text;
}

// ─── 发送 ────────────────────────────────────────────────────────────────

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 发送一次请求并返回完整诊断报告；从不抛出。 */
export async function executeLlmRequest(
  endpoint: LlmEndpoint,
  request: LlmCallRequest,
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
): Promise<LlmCallReport> {
  const params = normalizeLlmModelParams(endpoint.params ?? defaultLlmModelParams);
  const { url, body } = buildLlmRequest({ ...endpoint, params }, request);
  const timeoutMs = resolveLlmTimeoutMs(params, request.defaults);
  const report: LlmCallReport = {
    ok: false,
    error: null,
    text: "",
    json: null,
    finishReason: null,
    usage: null,
    httpStatus: null,
    latencyMs: 0,
    rawBody: "",
    apiFormat: params.apiFormat,
    stream: params.stream,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  let rawText = "";
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Accept: params.stream ? "text/event-stream" : "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    report.httpStatus = response.status;
    rawText = await response.text();
    report.latencyMs = Date.now() - startedAt;
    report.rawBody = redactRawBody(rawText, [endpoint.apiKey]);
    if (!response.ok) {
      report.error = { kind: "http", message: describeHttpError(response.status, rawText) };
      return report;
    }
    const data = decodeResponseBody(rawText, params.apiFormat);
    if (data && typeof data === "object" && "error" in data && (data as Record<string, unknown>).error) {
      report.error = { kind: "http", message: describeHttpError(response.status, JSON.stringify(data)) };
      return report;
    }
    const parsed = params.apiFormat === "responses" ? parseResponsesApiResponse(data) : parseChatCompletionResponse(data);
    report.text = parsed?.text.trim() ?? "";
    report.finishReason = parsed?.finishReason ?? null;
    report.usage = parsed?.usage ?? null;
    const classified = classifyParsedResponse(parsed, request.json);
    report.json = classified.json;
    report.error = classified.error;
    report.ok = !classified.error;
    return report;
  } catch (error) {
    report.latencyMs = Date.now() - startedAt;
    report.rawBody = redactRawBody(rawText, [endpoint.apiKey]);
    report.error = error instanceof Error && error.name === "AbortError"
      ? { kind: "timeout", message: `请求超时（${Math.round(timeoutMs / 1000)} 秒）。` }
      : { kind: "network", message: `网络请求失败：${error instanceof Error ? error.message : String(error)}` };
    return report;
  } finally {
    clearTimeout(timer);
  }
}

/** 发送请求，失败时抛出 LlmError（带中文说明与完整报告）。 */
export async function callLlm(endpoint: LlmEndpoint, request: LlmCallRequest, fetchImpl?: FetchLike): Promise<LlmCallReport> {
  const report = await executeLlmRequest(endpoint, request, fetchImpl);
  if (!report.ok) {
    throw new LlmError(report.error?.kind ?? "unrecognized", report.error?.message ?? "调用失败", report);
  }
  return report;
}

/** 响应体既可能是普通 JSON，也可能是 SSE（开了流式，或网关只支持流式）。 */
export function decodeResponseBody(rawText: string, apiFormat: LlmModelParams["apiFormat"]): unknown {
  const trimmed = rawText.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return null;
    }
  }
  return apiFormat === "responses" ? assembleResponsesStream(rawText) : assembleChatCompletionStream(rawText);
}

function firstString(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

function isNonEmptyObject(value: unknown) {
  return Boolean(value) && typeof value === "object" && Object.keys(value as object).length > 0;
}

function numberOrNull(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
