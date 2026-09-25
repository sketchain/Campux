import { DEFAULT_PRIVATE_POST_PROMPT, PRIVATE_POST_PROMPT_MAX_LENGTH } from "@campux/domain";
import { DbNull, type Prisma } from "@campux/db";
import { prisma } from "../lib/prisma";
import { decryptJson, encryptJson } from "../lib/secret-json";
import { runWithActiveTenantLease } from "../lib/tenant-runtime-lease";
import {
  defaultPostReviewRules,
  normalizePostReviewRules,
  resolveStoredPostReviewSecret,
  stripTransientPostReviewFields,
  type PostReviewRules,
  type PostReviewRulesInput,
} from "./ai-post-review-settings";
import { executeLlmRequest, type LlmCallReport, type LlmEndpoint, type LlmUsage } from "./llm-client";
import { defaultLlmModelParams, normalizeLlmModelParams, type LlmModelParams, type LlmModelParamsInput } from "./llm-params";

export type TenantAiSettingsPayload = {
  enabled: boolean;
  mode: "local" | "llm";
  provider: string;
  baseUrl: string;
  model: string;
  apiKeyConfigured: boolean;
  temperature: number;
  timeoutSeconds: number;
  rules: AiRules;
};

export type AiRules = PostReviewRules & {
  /** 是否启用私聊投稿 AI 语义收稿 */
  privatePostAiEnabled?: boolean | undefined;
  /** 是否启用投稿后的 LLM 自动打标 */
  postTaggingEnabled?: boolean | undefined;
  /** 是否启用 LLM 定期维护标签库 */
  postTagMaintenanceEnabled?: boolean | undefined;
  /** 私聊 AI 聚合收稿等待秒数，0 表示不聚合 */
  privatePostAggregateDelaySeconds?: number | undefined;
  /** 对话投稿额外触发关键词，如 ["发帖", "吐槽", "表白"]，不含 # 前缀 */
  postTriggerKeywords?: string[] | undefined;
  /** 私聊投稿 AI 语义收稿的完整系统提示词，留空使用内置默认提示词 */
  privatePostPrompt?: string | undefined;
  /** 主模型的高级请求参数（接口格式、输出上限、推理强度等） */
  llmParams?: LlmModelParamsInput | undefined;
};

export type TenantAiSettingsUpdate = {
  enabled?: boolean | undefined;
  mode?: "local" | "llm" | undefined;
  provider?: string | undefined;
  baseUrl?: string | undefined;
  model?: string | undefined;
  apiKey?: string | null | undefined;
  clearApiKey?: boolean | undefined;
  temperature?: number | undefined;
  timeoutSeconds?: number | undefined;
  rules?: (AiRules & PostReviewRulesInput) | undefined;
};

/** 测试连接的诊断信息：对照网关实际返回了什么。 */
export type LlmDiagnostics = {
  httpStatus: number | null;
  finishReason: string | null;
  usage: LlmUsage | null;
  /** 提取出的正文（截断到 1000 字） */
  text: string;
  /** 原始响应体前 2KB（已脱敏） */
  rawBody: string;
  errorKind: string | null;
  apiFormat: LlmModelParams["apiFormat"];
  stream: boolean;
};

export type TenantAiSettingsTestResult = {
  ok: boolean;
  mode: "local" | "llm";
  provider: string;
  model: string;
  baseUrl: string;
  latencyMs: number | null;
  message: string;
  diagnostics?: LlmDiagnostics | null;
};

/** 测试连接的默认输出上限：给推理模型的思考过程留足余量。 */
export const llmTestDefaultMaxTokens = 1_024;

export function toLlmDiagnostics(report: LlmCallReport): LlmDiagnostics {
  return {
    httpStatus: report.httpStatus,
    finishReason: report.finishReason,
    usage: report.usage,
    text: report.text.slice(0, 1_000),
    rawBody: report.rawBody,
    errorKind: report.error?.kind ?? null,
    apiFormat: report.apiFormat,
    stream: report.stream,
  };
}

/** 主模型（租户 AI 设置）对应的请求端点。 */
export function buildPrimaryLlmEndpoint(settings: Pick<TenantAiSettingsPayload, "baseUrl" | "model" | "rules">, apiKey: string): LlmEndpoint {
  return {
    baseUrl: normalizeBaseUrl(settings.baseUrl),
    model: settings.model,
    apiKey,
    params: normalizeLlmModelParams(settings.rules.llmParams),
  };
}

const defaultAiSettings: TenantAiSettingsPayload = {
  enabled: true,
  mode: "local",
  provider: "openai_compatible",
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-4.1-mini",
  apiKeyConfigured: false,
  temperature: 0.2,
  timeoutSeconds: 30,
  rules: {
    privatePostAiEnabled: false,
    // 配好 LLM 后不自动打标 / 维护标签库，避免默默烧 token；需要时在 AI 设置页手动开启。
    postTaggingEnabled: false,
    postTagMaintenanceEnabled: false,
    privatePostAggregateDelaySeconds: 8,
    postTriggerKeywords: [],
    privatePostPrompt: DEFAULT_PRIVATE_POST_PROMPT,
    llmParams: defaultLlmModelParams,
    ...defaultPostReviewRules,
  },
};

type TenantAiSettingsClient = Pick<Prisma.TransactionClient, "tenantAiSettings">;

export async function readTenantAiSettings(tenantId: string, client: TenantAiSettingsClient = prisma): Promise<TenantAiSettingsPayload> {
  const settings = await client.tenantAiSettings.findUnique({
    where: { tenantId },
  });
  if (!settings) {
    return defaultAiSettings;
  }

  return {
    enabled: settings.enabled,
    mode: normalizeMode(settings.mode),
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKeyConfigured: Boolean(settings.apiKeySecret),
    temperature: clampNumber(settings.temperature, 0, 1, defaultAiSettings.temperature),
    timeoutSeconds: Math.max(5, Math.min(120, settings.timeoutSeconds)),
    rules: normalizeAiRules(settings.rules),
  };
}

export async function updateTenantAiSettings(
  tenantId: string,
  input: TenantAiSettingsUpdate,
) {
  const existing = await prisma.tenantAiSettings.findUnique({ where: { tenantId } });
  const apiKeySecret =
    input.clearApiKey
      ? DbNull
      : input.apiKey && input.apiKey.trim().length > 0
        ? encryptJson({ apiKey: input.apiKey.trim() })
        : existing?.apiKeySecret ?? DbNull;

  await prisma.tenantAiSettings.upsert({
    where: { tenantId },
    update: {
      ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
      ...(input.mode === undefined ? {} : { mode: normalizeMode(input.mode) }),
      ...(input.provider === undefined ? {} : { provider: input.provider }),
      ...(input.baseUrl === undefined ? {} : { baseUrl: normalizeBaseUrl(input.baseUrl) }),
      ...(input.model === undefined ? {} : { model: input.model.trim() || defaultAiSettings.model }),
      apiKeySecret,
      ...(input.temperature === undefined ? {} : { temperature: clampNumber(input.temperature, 0, 1, defaultAiSettings.temperature) }),
      ...(input.timeoutSeconds === undefined ? {} : { timeoutSeconds: Math.max(5, Math.min(120, input.timeoutSeconds)) }),
      ...(input.rules === undefined ? {} : { rules: buildStoredAiRules(input.rules, existing?.rules) }),
    },
    create: {
      tenantId,
      enabled: input.enabled ?? defaultAiSettings.enabled,
      mode: normalizeMode(input.mode ?? defaultAiSettings.mode),
      provider: input.provider ?? defaultAiSettings.provider,
      baseUrl: normalizeBaseUrl(input.baseUrl ?? defaultAiSettings.baseUrl),
      model: input.model?.trim() || defaultAiSettings.model,
      apiKeySecret,
      temperature: clampNumber(input.temperature ?? defaultAiSettings.temperature, 0, 1, defaultAiSettings.temperature),
      timeoutSeconds: Math.max(5, Math.min(120, input.timeoutSeconds ?? defaultAiSettings.timeoutSeconds)),
      rules: buildStoredAiRules(input.rules ?? defaultAiSettings.rules, existing?.rules),
    },
  });

  return readTenantAiSettings(tenantId);
}

export async function testTenantAiSettings(
  tenantId: string,
  input: TenantAiSettingsUpdate,
): Promise<TenantAiSettingsTestResult> {
  const current = await readTenantAiSettings(tenantId);
  const mode = normalizeMode(input.mode ?? current.mode);
  const provider = input.provider?.trim() || current.provider;
  const baseUrl = normalizeBaseUrl(input.baseUrl ?? current.baseUrl);
  const model = input.model?.trim() || current.model;
  const timeoutSeconds = Math.max(5, Math.min(120, input.timeoutSeconds ?? current.timeoutSeconds));

  if (mode !== "llm") {
    return {
      ok: true,
      mode,
      provider,
      model,
      baseUrl,
      latencyMs: null,
      message: "当前是本地模式，不需要连接 LLM。",
    };
  }

  const apiKey = await resolveTenantAiApiKey(tenantId, input);
  if (!apiKey) {
    return {
      ok: false,
      mode,
      provider,
      model,
      baseUrl,
      latencyMs: null,
      message: "未配置 LLM API Key。",
    };
  }

  const params = normalizeLlmModelParams(input.rules?.llmParams ?? current.rules.llmParams);
  const leased = await runWithActiveTenantLease(prisma, tenantId, () => executeLlmRequest(
    { baseUrl, model, apiKey, params },
    {
      messages: [
        { role: "system", content: "只返回 JSON。" },
        { role: "user", content: "请返回 {\"ok\":true,\"message\":\"ready\"}" },
      ],
      json: true,
      defaults: { timeoutMs: timeoutSeconds * 1_000, maxTokens: llmTestDefaultMaxTokens, temperature: 0 },
    },
  ));
  if (!leased.active) {
    return { ok: false, mode, provider, model, baseUrl, latencyMs: null, message: "校园墙已暂停或归档。" };
  }
  const report = leased.value;
  return {
    ok: report.ok,
    mode,
    provider,
    model,
    baseUrl,
    latencyMs: report.latencyMs,
    message: report.ok ? "LLM 配置可用。" : report.error?.message ?? "LLM 测试失败。",
    diagnostics: toLlmDiagnostics(report),
  };
}

export async function resolveTenantAiApiKey(
  tenantId: string,
  input: Pick<TenantAiSettingsUpdate, "apiKey" | "clearApiKey">,
  client: TenantAiSettingsClient = prisma,
) {
  if (input.apiKey && input.apiKey.trim().length > 0) {
    return input.apiKey.trim();
  }
  if (input.clearApiKey) {
    return "";
  }
  const settings = await client.tenantAiSettings.findUnique({ where: { tenantId } });
  const secret = settings?.apiKeySecret ? decryptJson(settings.apiKeySecret) : null;
  return secret && typeof secret === "object" && "apiKey" in secret ? String(secret.apiKey) : "";
}

export function normalizeAiRules(value: unknown): AiRules {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return defaultAiSettings.rules;
  }
  const candidate = value as Record<string, unknown>;
  return {
    privatePostAiEnabled: typeof candidate.privatePostAiEnabled === "boolean" ? candidate.privatePostAiEnabled : defaultAiSettings.rules.privatePostAiEnabled,
    postTaggingEnabled: typeof candidate.postTaggingEnabled === "boolean" ? candidate.postTaggingEnabled : defaultAiSettings.rules.postTaggingEnabled,
    postTagMaintenanceEnabled: typeof candidate.postTagMaintenanceEnabled === "boolean" ? candidate.postTagMaintenanceEnabled : defaultAiSettings.rules.postTagMaintenanceEnabled,
    privatePostAggregateDelaySeconds: normalizeNumber(candidate.privatePostAggregateDelaySeconds, 0, 120, defaultAiSettings.rules.privatePostAggregateDelaySeconds ?? 8),
    postTriggerKeywords: normalizeStringArray(candidate.postTriggerKeywords ?? defaultAiSettings.rules.postTriggerKeywords),
    privatePostPrompt: normalizePrivatePostPrompt(candidate.privatePostPrompt),
    llmParams: normalizeLlmModelParams(candidate.llmParams),
    ...normalizePostReviewRules(candidate),
  };
}

function buildStoredAiRules(input: AiRules & PostReviewRulesInput, existingRules: unknown): Prisma.InputJsonValue {
  return {
    ...stripTransientPostReviewFields(normalizeAiRules(input)),
    ...resolveStoredPostReviewSecret(input, existingRules),
  } as Prisma.InputJsonValue;
}

function normalizeStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean) : [];
}

function normalizePrivatePostPrompt(value: unknown) {
  if (typeof value !== "string") {
    return defaultAiSettings.rules.privatePostPrompt;
  }
  const trimmed = value.trim().slice(0, PRIVATE_POST_PROMPT_MAX_LENGTH);
  return trimmed || defaultAiSettings.rules.privatePostPrompt;
}

function normalizeNumber(value: unknown, min: number, max: number, fallback: number) {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, Math.trunc(value))) : fallback;
}

function normalizeMode(value: unknown): "local" | "llm" {
  return value === "llm" ? "llm" : "local";
}

export function normalizeBaseUrl(value: string) {
  return (value.trim() || defaultAiSettings.baseUrl).replace(/\/+$/, "");
}

function clampNumber(value: unknown, min: number, max: number, fallback: number) {
  const numeric = typeof value === "number" ? value : typeof value === "string" ? Number(value) : fallback;
  if (!Number.isFinite(numeric)) {
    return fallback;
  }
  return Math.max(min, Math.min(max, numeric));
}
