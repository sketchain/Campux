/**
 * 大模型请求参数（「高级参数」）。
 *
 * 主模型（租户 AI 设置）存在 TenantAiSettings.rules.llmParams，审核备用模型存在
 * rules.postReviewFallbackParams。每一项都允许「不发送」，以兼容一收到陌生参数就报错的网关。
 * 默认值与迁移前的请求完全一致：Chat Completions、max_tokens、各调用自己的 token 预算、
 * 各调用自己的 temperature 与 response_format。
 */

export const llmApiFormats = ["chat_completions", "responses"] as const;
export const llmMaxTokensFields = ["max_tokens", "max_completion_tokens", "omit"] as const;
export const llmReasoningEfforts = ["omit", "minimal", "low", "medium", "high"] as const;
export const llmTemperatureModes = ["default", "custom", "omit"] as const;
export const llmJsonModes = ["native", "prompt"] as const;

export type LlmApiFormat = (typeof llmApiFormats)[number];
export type LlmMaxTokensField = (typeof llmMaxTokensFields)[number];
export type LlmReasoningEffort = (typeof llmReasoningEfforts)[number];
export type LlmTemperatureMode = (typeof llmTemperatureModes)[number];
export type LlmJsonMode = (typeof llmJsonModes)[number];

export type LlmModelParams = {
  /** 接口格式：Chat Completions（/chat/completions）或 Responses API（/responses） */
  apiFormat: LlmApiFormat;
  /** 输出上限字段；Responses API 下统一发 max_output_tokens，选 omit 则不发送 */
  maxTokensField: LlmMaxTokensField;
  /** 输出上限；null 表示用各调用自己的默认预算 */
  maxTokens: number | null;
  /** 推理强度；Responses API 下对应 reasoning.effort */
  reasoningEffort: LlmReasoningEffort;
  /** default：用各调用自己的 temperature；custom：用下面的值；omit：不发送 */
  temperatureMode: LlmTemperatureMode;
  temperature: number;
  /** native：response_format / text.format 的 json_object；prompt：不发送，改在提示词里要求 JSON */
  jsonMode: LlmJsonMode;
  /** 以 stream: true 请求，由客户端把流拼成完整响应 */
  stream: boolean;
  /** 原样合并进请求体的额外参数 */
  extraBody: Record<string, unknown>;
  /** 请求超时秒数；null 表示用各调用自己的默认超时 */
  timeoutSeconds: number | null;
};

export const LLM_MAX_TOKENS_LIMIT = 200_000;
export const LLM_TIMEOUT_SECONDS_MIN = 5;
export const LLM_TIMEOUT_SECONDS_MAX = 600;
export const LLM_EXTRA_BODY_MAX_BYTES = 8_192;

export const defaultLlmModelParams: LlmModelParams = {
  apiFormat: "chat_completions",
  maxTokensField: "max_tokens",
  maxTokens: null,
  reasoningEffort: "omit",
  temperatureMode: "default",
  temperature: 0,
  jsonMode: "native",
  stream: false,
  extraBody: {},
  timeoutSeconds: null,
};

export function normalizeLlmModelParams(value: unknown): LlmModelParams {
  const candidate = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    apiFormat: pickEnum(candidate.apiFormat, llmApiFormats, defaultLlmModelParams.apiFormat),
    maxTokensField: pickEnum(candidate.maxTokensField, llmMaxTokensFields, defaultLlmModelParams.maxTokensField),
    maxTokens: optionalInteger(candidate.maxTokens, 1, LLM_MAX_TOKENS_LIMIT),
    reasoningEffort: pickEnum(candidate.reasoningEffort, llmReasoningEfforts, defaultLlmModelParams.reasoningEffort),
    temperatureMode: pickEnum(candidate.temperatureMode, llmTemperatureModes, defaultLlmModelParams.temperatureMode),
    temperature: typeof candidate.temperature === "number" && Number.isFinite(candidate.temperature)
      ? Math.min(2, Math.max(0, candidate.temperature))
      : defaultLlmModelParams.temperature,
    jsonMode: pickEnum(candidate.jsonMode, llmJsonModes, defaultLlmModelParams.jsonMode),
    stream: candidate.stream === true,
    extraBody: normalizeExtraBody(candidate.extraBody),
    timeoutSeconds: optionalInteger(candidate.timeoutSeconds, LLM_TIMEOUT_SECONDS_MIN, LLM_TIMEOUT_SECONDS_MAX),
  };
}

/** 额外请求体必须是 JSON 对象，且序列化后不超过上限；否则丢弃。 */
export function normalizeExtraBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  try {
    const serialized = JSON.stringify(value);
    if (serialized.length > LLM_EXTRA_BODY_MAX_BYTES) {
      return {};
    }
    return JSON.parse(serialized) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : fallback;
}

function optionalInteger(value: unknown, min: number, max: number): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }
  return Math.min(max, Math.max(min, Math.trunc(value)));
}
