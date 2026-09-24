import {
  DEFAULT_POST_REVIEW_MAX_RETRIES,
  DEFAULT_POST_REVIEW_PROMPT,
  POST_REVIEW_MAX_RETRIES_LIMIT,
  POST_REVIEW_PROMPT_MAX_LENGTH,
} from "@campux/domain";
import type { Prisma } from "@campux/db";
import { decryptJson, encryptJson } from "../lib/secret-json";

/**
 * AI 自动审核的配置项。
 *
 * 不新增表 / 列：全部存进 `TenantAiSettings.rules`（Json）。备用模型的 API Key 以
 * `encryptJson` 信封形式存在 `postReviewFallbackApiKeySecret`，读接口只回 `configured`。
 */

export { DEFAULT_POST_REVIEW_PROMPT, POST_REVIEW_MAX_RETRIES_LIMIT, POST_REVIEW_PROMPT_MAX_LENGTH };
export const defaultPostReviewMaxRetries = DEFAULT_POST_REVIEW_MAX_RETRIES;

/** 固定追加在审核 prompt 之后，管理员改 prompt 也不会破坏输出格式。 */
export const POST_REVIEW_OUTPUT_INSTRUCTION = [
  "只返回一个 JSON 对象，不要 Markdown，不要多余文字：",
  "{\"decision\":\"approve\"|\"reject\",\"category\":\"血腥\"|\"暴力\"|\"恐怖\"|null,\"reason\":\"一句话理由\"}",
  "decision 为 approve 时 category 填 null。",
].join("\n");

/** 读接口返回给前端的形态（不含任何密钥）。 */
export type PostReviewRules = {
  /** 是否启用 AI 自动审核（新稿件由 AI 判定后直接放行 / 拒绝） */
  postReviewEnabled?: boolean | undefined;
  /** 审核提示词；输出格式说明由服务端固定追加 */
  postReviewPrompt?: string | undefined;
  /** 每个模型失败后的重试次数（指数退避） */
  postReviewMaxRetries?: number | undefined;
  /** 备用模型（OpenAI 兼容）接口地址，留空表示不启用备用模型 */
  postReviewFallbackBaseUrl?: string | undefined;
  /** 备用模型名 */
  postReviewFallbackModel?: string | undefined;
  /** 备用模型 API Key 是否已配置（只读） */
  postReviewFallbackApiKeyConfigured?: boolean | undefined;
};

/** 写接口额外接受的字段：明文 Key 只在写入时出现，落库前加密。 */
export type PostReviewRulesInput = PostReviewRules & {
  postReviewFallbackApiKey?: string | undefined;
  postReviewFallbackClearApiKey?: boolean | undefined;
};

export const postReviewFallbackSecretKey = "postReviewFallbackApiKeySecret";

export const defaultPostReviewRules: Required<PostReviewRules> = {
  postReviewEnabled: false,
  postReviewPrompt: DEFAULT_POST_REVIEW_PROMPT,
  postReviewMaxRetries: defaultPostReviewMaxRetries,
  postReviewFallbackBaseUrl: "",
  postReviewFallbackModel: "",
  postReviewFallbackApiKeyConfigured: false,
};

/** 把 rules 里与自动审核相关的字段规整成对外形态。 */
export function normalizePostReviewRules(candidate: Record<string, unknown>): Required<PostReviewRules> {
  return {
    postReviewEnabled: typeof candidate.postReviewEnabled === "boolean" ? candidate.postReviewEnabled : defaultPostReviewRules.postReviewEnabled,
    postReviewPrompt: normalizePostReviewPrompt(candidate.postReviewPrompt),
    postReviewMaxRetries: normalizeRetries(candidate.postReviewMaxRetries),
    postReviewFallbackBaseUrl: normalizeOptionalBaseUrl(candidate.postReviewFallbackBaseUrl),
    postReviewFallbackModel: typeof candidate.postReviewFallbackModel === "string" ? candidate.postReviewFallbackModel.trim().slice(0, 120) : "",
    postReviewFallbackApiKeyConfigured: isStoredSecret(candidate[postReviewFallbackSecretKey]),
  };
}

/**
 * 计算写库时要保留 / 更新的备用模型密钥字段。
 * - 提交了新 Key：加密后写入；
 * - 要求清除：不再写入该字段；
 * - 否则沿用库中原值。
 */
export function resolveStoredPostReviewSecret(
  input: PostReviewRulesInput | undefined,
  existingRules: unknown,
): Record<string, Prisma.InputJsonValue> {
  const newKey = input?.postReviewFallbackApiKey?.trim();
  if (newKey) {
    return { [postReviewFallbackSecretKey]: encryptJson({ apiKey: newKey }) };
  }
  if (input?.postReviewFallbackClearApiKey) {
    return {};
  }
  const existing = readRecord(existingRules)[postReviewFallbackSecretKey];
  return isStoredSecret(existing) ? { [postReviewFallbackSecretKey]: existing as Prisma.InputJsonValue } : {};
}

/** 解出备用模型明文 Key；未配置或解密失败返回空串。 */
export function readPostReviewFallbackApiKey(rules: unknown): string {
  const stored = readRecord(rules)[postReviewFallbackSecretKey];
  if (!isStoredSecret(stored)) {
    return "";
  }
  try {
    const secret = decryptJson(stored as Prisma.JsonValue);
    return secret && typeof secret === "object" && "apiKey" in secret ? String((secret as { apiKey: unknown }).apiKey) : "";
  } catch {
    return "";
  }
}

/** 落库前去掉只读 / 只写的派生字段，避免把明文 Key 或 configured 标记写进 rules。 */
export function stripTransientPostReviewFields<T extends Record<string, unknown>>(rules: T): T {
  const copy: Record<string, unknown> = { ...rules };
  delete copy.postReviewFallbackApiKeyConfigured;
  delete copy.postReviewFallbackApiKey;
  delete copy.postReviewFallbackClearApiKey;
  return copy as T;
}

function normalizePostReviewPrompt(value: unknown) {
  if (typeof value !== "string") {
    return DEFAULT_POST_REVIEW_PROMPT;
  }
  const trimmed = value.trim().slice(0, POST_REVIEW_PROMPT_MAX_LENGTH);
  return trimmed || DEFAULT_POST_REVIEW_PROMPT;
}

function normalizeRetries(value: unknown) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(POST_REVIEW_MAX_RETRIES_LIMIT, Math.max(0, Math.trunc(value)))
    : defaultPostReviewMaxRetries;
}

function normalizeOptionalBaseUrl(value: unknown) {
  return typeof value === "string" ? value.trim().replace(/\/+$/, "") : "";
}

function isStoredSecret(value: unknown) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
