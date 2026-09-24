import { Buffer } from "node:buffer";
import { z } from "zod";
import { compressImageBuffer } from "../lib/attachments";
import { POST_REVIEW_OUTPUT_INSTRUCTION } from "./ai-post-review-settings";

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
  timeoutMs: number;
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
 * 解析并校验模型输出。允许外层包了 ```json 代码块；
 * 字段不合规（decision 缺失 / 取值不对）一律视为本次调用失败。
 */
export function parsePostReviewDecision(raw: string): PostReviewDecision {
  const text = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new PostReviewOutputError("模型输出不是 JSON");
    }
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
    } catch {
      throw new PostReviewOutputError("模型输出不是 JSON");
    }
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

export function buildPostReviewRequestBody(options: {
  model: string;
  prompt: string;
  text: string;
  images: PostReviewImage[];
}) {
  const text = options.text.trim().slice(0, postReviewTextMaxChars);
  const intro = options.images.length > 0
    ? `稿件正文如下（另附 ${options.images.length} 张图片，请逐张查看）：`
    : "稿件正文如下（纯文字稿，无图片）：";
  return {
    model: options.model,
    temperature: 0,
    max_tokens: 300,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: buildPostReviewSystemPrompt(options.prompt) },
      {
        role: "user",
        content: [
          { type: "text", text: `${intro}\n${text || "（无正文）"}` },
          ...options.images.map((image) => ({
            type: "image_url",
            image_url: { url: `data:${image.mimeType};base64,${image.base64}` },
          })),
        ],
      },
    ],
  };
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** 调一次 OpenAI 兼容 /chat/completions 并校验输出。任何异常都抛出，由重试层处理。 */
export async function callPostReviewModel(
  endpoint: PostReviewModelEndpoint,
  request: { prompt: string; text: string; images: PostReviewImage[] },
  fetchImpl: FetchLike = fetch,
): Promise<PostReviewDecision> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), endpoint.timeoutMs);
  try {
    const response = await fetchImpl(`${endpoint.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${endpoint.apiKey}`,
      },
      body: JSON.stringify(buildPostReviewRequestBody({ model: endpoint.model, ...request })),
    });
    const data = (await response.json().catch(() => null)) as
      | { choices?: Array<{ message?: { content?: string | null } }>; error?: { message?: string } }
      | null;
    if (!response.ok) {
      throw new Error(data?.error?.message || `HTTP ${response.status}`);
    }
    const content = data?.choices?.[0]?.message?.content;
    if (!content) {
      throw new PostReviewOutputError("模型没有返回内容");
    }
    return parsePostReviewDecision(content);
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`请求超时（${Math.round(endpoint.timeoutMs / 1000)} 秒）`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
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
