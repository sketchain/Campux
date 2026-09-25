import { Buffer } from "node:buffer";
import { z } from "zod";
import { compressImageBuffer } from "../lib/attachments";
import { POST_REVIEW_OUTPUT_INSTRUCTION } from "./ai-post-review-settings";
import { buildLlmRequest, callLlm, extractFirstJsonObject, type LlmMessage } from "./llm-client";
import type { LlmModelParams } from "./llm-params";

/**
 * AI 自动审核的模型调用层：请求构造、输出校验、重试 / 备用模型回退、图片预处理。
 * 与数据库无关，便于单测。
 */

export type PostReviewDecision = {
  decision: "approve" | "reject";
  category: string | null;
  reason: string;
};

export type PostReviewModelEndpoint = {
  /** 日志 / 审计里区分主备：primary | fallback */
  label: "primary" | "fallback";
  baseUrl: string;
  model: string;
  apiKey: string;
  /** 默认超时；高级参数里配置了超时则以其为准 */
  timeoutMs: number;
  params?: LlmModelParams | undefined;
};

export type PostReviewImage = {
  mimeType: string;
  base64: string;
};

export type PostReviewCallAttempt = {
  label: PostReviewModelEndpoint["label"];
  model: string;
  attempt: number;
  error: string;
};

export type PostReviewRunResult =
  | { ok: true; decision: PostReviewDecision; endpoint: PostReviewModelEndpoint; attempts: PostReviewCallAttempt[] }
  | { ok: false; attempts: PostReviewCallAttempt[] };

const decisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  category: z.string().trim().max(40).nullable().optional(),
  reason: z.string().trim().max(500).optional(),
});

/** 单张图片压缩后的目标上限；超过则再降一档分辨率。 */
export const postReviewImageMaxBytes = 1_500_000;
/** 一条稿件所有图片（base64 前）总大小上限；超过则判定本次 AI 审核失败、转人工。 */
export const postReviewImagesTotalMaxBytes = 8_000_000;
const postReviewImageSteps = [
  { maxDimension: 1_280, quality: 75 },
  { maxDimension: 896, quality: 65 },
  { maxDimension: 640, quality: 55 },
];
export const postReviewTextMaxChars = 2_000;

export class PostReviewOutputError extends Error {}

/**
 * 解析并校验模型输出。允许外层包了 ```json 代码块或前后夹带文字（取第一个完整 JSON 对象）；
 * 字段不合规（decision 缺失 / 取值不对）一律视为本次调用失败。
 */
export function parsePostReviewDecision(raw: string): PostReviewDecision {
  const parsed = extractFirstJsonObject(raw);
  if (!parsed) {
    throw new PostReviewOutputError("模型输出不是 JSON");
  }
  const result = decisionSchema.safeParse(parsed);
  if (!result.success) {
    throw new PostReviewOutputError(`模型输出不符合格式：${result.error.issues.map((issue) => issue.path.join(".") || issue.message).join(", ")}`);
  }
  const category = result.data.category?.trim() || null;
  return {
    decision: result.data.decision,
    category: result.data.decision === "approve" ? null : category,
    reason: result.data.reason?.trim() || (result.data.decision === "approve" ? "未发现血腥暴力恐怖内容" : category ?? "不符合发布规范"),
  };
}

/** 第 attempt 次重试前的等待时间（attempt 从 1 开始）：base, 2*base, 4*base…，上限 30 秒。 */
export function postReviewBackoffMs(attempt: number, baseDelayMs = 1_000) {
  return Math.min(30_000, baseDelayMs * 2 ** Math.max(0, attempt - 1));
}

/**
 * 依次尝试每个模型：每个模型先调一次，失败后按指数退避重试 `retries` 次；
 * 全部失败返回 ok=false 及每次失败原因。
 */
export async function runPostReviewWithFallback(options: {
  endpoints: PostReviewModelEndpoint[];
  retries: number;
  call: (endpoint: PostReviewModelEndpoint) => Promise<PostReviewDecision>;
  sleep?: (ms: number) => Promise<void>;
  baseDelayMs?: number;
  shouldContinue?: () => boolean | Promise<boolean>;
}): Promise<PostReviewRunResult> {
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const attempts: PostReviewCallAttempt[] = [];
  const retries = Math.max(0, Math.trunc(options.retries));
  for (const endpoint of options.endpoints) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      if (attempt > 0) {
        await sleep(postReviewBackoffMs(attempt, options.baseDelayMs));
      }
      if (options.shouldContinue && !await options.shouldContinue()) {
        return { ok: false, attempts };
      }
      try {
        const decision = await options.call(endpoint);
        return { ok: true, decision, endpoint, attempts };
      } catch (error) {
        attempts.push({
          label: endpoint.label,
          model: endpoint.model,
          attempt: attempt + 1,
          error: describeError(error),
        });
      }
    }
  }
  return { ok: false, attempts };
}

export function buildPostReviewSystemPrompt(prompt: string) {
  return `${prompt.trim()}\n\n${POST_REVIEW_OUTPUT_INSTRUCTION}`;
}

/** AI 审核调用原有的 token 预算与 temperature（高级参数未配置时使用）。 */
export const postReviewMaxTokens = 300;
export const postReviewTemperature = 0;

export function buildPostReviewMessages(options: { prompt: string; text: string; images: PostReviewImage[] }): LlmMessage[] {
  const text = options.text.trim().slice(0, postReviewTextMaxChars);
  const intro = options.images.length > 0
    ? `稿件正文如下（另附 ${options.images.length} 张图片，请逐张查看）：`
    : "稿件正文如下（纯文字稿，无图片）：";
  return [
    { role: "system", content: buildPostReviewSystemPrompt(options.prompt) },
    {
      role: "user",
      content: [
        { type: "text", text: `${intro}\n${text || "（无正文）"}` },
        ...options.images.map((image) => ({
          type: "image_url" as const,
          image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
        })),
      ],
    },
  ];
}

/** 默认参数下的请求体（与迁移前的 Chat Completions 请求一致），供测试与排查对照。 */
export function buildPostReviewRequestBody(options: {
  model: string;
  prompt: string;
  text: string;
  images: PostReviewImage[];
}) {
  return buildLlmRequest(
    { baseUrl: "", model: options.model, apiKey: "" },
    {
      messages: buildPostReviewMessages(options),
      json: true,
      defaults: { timeoutMs: 0, maxTokens: postReviewMaxTokens, temperature: postReviewTemperature },
    },
  ).body;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 通过统一 LLM 客户端调一次审核模型并校验输出。任何异常都抛出，由重试层处理。 */
export async function callPostReviewModel(
  endpoint: PostReviewModelEndpoint,
  request: { prompt: string; text: string; images: PostReviewImage[] },
  fetchImpl?: FetchLike,
): Promise<PostReviewDecision> {
  const report = await callLlm(
    { baseUrl: endpoint.baseUrl, model: endpoint.model, apiKey: endpoint.apiKey, params: endpoint.params },
    {
      messages: buildPostReviewMessages(request),
      json: true,
      defaults: { timeoutMs: endpoint.timeoutMs, maxTokens: postReviewMaxTokens, temperature: postReviewTemperature },
    },
    fetchImpl,
  );
  return parsePostReviewDecision(report.text);
}

/**
 * 把原图压成模型可接受的大小：统一转 JPEG 并逐档缩小，直到单张不超过上限。
 * sharp 不可用时 compressImageBuffer 会原样返回，此时保留原始 MIME。
 */
export async function preparePostReviewImage(
  bytes: Uint8Array,
  contentType: string,
  compress: typeof compressImageBuffer = compressImageBuffer,
): Promise<PostReviewImage> {
  const source = Buffer.from(bytes);
  let output: Buffer = source;
  let mimeType = normalizeImageMime(contentType);
  for (const step of postReviewImageSteps) {
    const compressed = await compress(source, "image/jpeg", { enabled: true, quality: step.quality, maxDimension: step.maxDimension });
    if (compressed === source) {
      // sharp 缺失或压缩失败：无法缩小，只能用原图。
      break;
    }
    output = compressed;
    mimeType = "image/jpeg";
    if (output.byteLength <= postReviewImageMaxBytes) {
      break;
    }
  }
  return { mimeType, base64: output.toString("base64") };
}

/** 汇总图片大小是否超过总上限（按 base64 解码前字节估算）。 */
export function exceedsPostReviewImageBudget(images: PostReviewImage[]) {
  const total = images.reduce((sum, image) => sum + Math.floor(image.base64.length * 3 / 4), 0);
  return total > postReviewImagesTotalMaxBytes;
}

function normalizeImageMime(contentType: string) {
  const lower = contentType.toLowerCase();
  return lower.startsWith("image/") ? lower : "image/jpeg";
}

function describeError(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(0, 300);
}
