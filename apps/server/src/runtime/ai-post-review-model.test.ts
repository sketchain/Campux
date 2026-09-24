import { Buffer } from "node:buffer";
import { describe, expect, test } from "bun:test";
import {
  PostReviewOutputError,
  buildPostReviewRequestBody,
  callPostReviewModel,
  exceedsPostReviewImageBudget,
  parsePostReviewDecision,
  postReviewBackoffMs,
  postReviewImagesTotalMaxBytes,
  preparePostReviewImage,
  runPostReviewWithFallback,
  type PostReviewModelEndpoint,
} from "./ai-post-review-model";
import { POST_REVIEW_OUTPUT_INSTRUCTION } from "./ai-post-review-settings";

const primary: PostReviewModelEndpoint = { label: "primary", baseUrl: "https://a.example/v1", model: "main", apiKey: "k1", timeoutMs: 1_000 };
const fallback: PostReviewModelEndpoint = { label: "fallback", baseUrl: "https://b.example/v1", model: "spare", apiKey: "k2", timeoutMs: 1_000 };

describe("parsePostReviewDecision", () => {
  test("accepts a well-formed approve decision and drops category", () => {
    expect(parsePostReviewDecision('{"decision":"approve","category":"暴力","reason":"日常分享"}')).toEqual({
      decision: "approve",
      category: null,
      reason: "日常分享",
    });
  });

  test("accepts reject with category and tolerates code fences", () => {
    expect(parsePostReviewDecision('```json\n{"decision":"reject","category":"血腥","reason":"伤口特写"}\n```')).toEqual({
      decision: "reject",
      category: "血腥",
      reason: "伤口特写",
    });
  });

  test("extracts the JSON object from surrounding text", () => {
    expect(parsePostReviewDecision('结果如下：{"decision":"reject","category":"恐怖","reason":"x"} 以上').decision).toBe("reject");
  });

  test("fills a default reason when the model omits it", () => {
    expect(parsePostReviewDecision('{"decision":"reject","category":"暴力"}').reason).toBe("暴力");
    expect(parsePostReviewDecision('{"decision":"approve","category":null}').reason).not.toBe("");
  });

  test("rejects invalid decision values", () => {
    expect(() => parsePostReviewDecision('{"decision":"maybe","reason":"?"}')).toThrow(PostReviewOutputError);
    expect(() => parsePostReviewDecision('{"reason":"no decision"}')).toThrow(PostReviewOutputError);
  });

  test("rejects non-JSON output", () => {
    expect(() => parsePostReviewDecision("我觉得可以通过")).toThrow(PostReviewOutputError);
    expect(() => parsePostReviewDecision("{broken")).toThrow(PostReviewOutputError);
  });
});

describe("postReviewBackoffMs", () => {
  test("doubles per retry and caps at 30s", () => {
    expect(postReviewBackoffMs(1, 1_000)).toBe(1_000);
    expect(postReviewBackoffMs(2, 1_000)).toBe(2_000);
    expect(postReviewBackoffMs(3, 1_000)).toBe(4_000);
    expect(postReviewBackoffMs(20, 1_000)).toBe(30_000);
  });
});

describe("runPostReviewWithFallback", () => {
  test("returns the first successful primary result without retries", async () => {
    const sleeps: number[] = [];
    const result = await runPostReviewWithFallback({
      endpoints: [primary, fallback],
      retries: 2,
      call: async () => ({ decision: "approve", category: null, reason: "ok" }),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.endpoint.label).toBe("primary");
    expect(sleeps).toEqual([]);
  });

  test("retries the primary with exponential backoff before succeeding", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const result = await runPostReviewWithFallback({
      endpoints: [primary, fallback],
      retries: 2,
      baseDelayMs: 100,
      call: async () => {
        calls += 1;
        if (calls < 3) throw new Error(`boom ${calls}`);
        return { decision: "reject", category: "暴力", reason: "x" };
      },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(result.ok).toBe(true);
    expect(result.ok && result.endpoint.label).toBe("primary");
    expect(sleeps).toEqual([100, 200]);
    expect(result.attempts.map((item) => item.error)).toEqual(["boom 1", "boom 2"]);
  });

  test("falls back to the spare model after the primary exhausts its retries", async () => {
    const calledModels: string[] = [];
    const result = await runPostReviewWithFallback({
      endpoints: [primary, fallback],
      retries: 1,
      call: async (endpoint) => {
        calledModels.push(endpoint.model);
        if (endpoint.label === "primary") throw new Error("primary down");
        return { decision: "approve", category: null, reason: "ok" };
      },
      sleep: async () => undefined,
    });
    expect(calledModels).toEqual(["main", "main", "spare"]);
    expect(result.ok && result.endpoint.label).toBe("fallback");
  });

  test("reports failure with every attempt when all models fail", async () => {
    const result = await runPostReviewWithFallback({
      endpoints: [primary, fallback],
      retries: 2,
      call: async (endpoint) => { throw new Error(`${endpoint.label} down`); },
      sleep: async () => undefined,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toHaveLength(6);
    expect(result.attempts.at(-1)).toEqual({ label: "fallback", model: "spare", attempt: 3, error: "fallback down" });
  });

  test("stops early when shouldContinue turns false", async () => {
    let calls = 0;
    const result = await runPostReviewWithFallback({
      endpoints: [primary, fallback],
      retries: 3,
      call: async () => { calls += 1; throw new Error("down"); },
      sleep: async () => undefined,
      shouldContinue: () => calls < 1,
    });
    expect(result.ok).toBe(false);
    expect(calls).toBe(1);
  });

  test("fails immediately when there are no endpoints", async () => {
    const result = await runPostReviewWithFallback({ endpoints: [], retries: 2, call: async () => { throw new Error("unused"); } });
    expect(result).toEqual({ ok: false, attempts: [] });
  });
});

describe("buildPostReviewRequestBody", () => {
  test("sends text plus every image as data URLs and appends the fixed output format", () => {
    const body = buildPostReviewRequestBody({
      model: "vision",
      prompt: "自定义标准",
      text: "正文",
      images: [{ mimeType: "image/jpeg", base64: "AAAA" }, { mimeType: "image/png", base64: "BBBB" }],
    });
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.messages[0]?.content).toBe(`自定义标准\n\n${POST_REVIEW_OUTPUT_INSTRUCTION}`);
    const userContent = body.messages[1]?.content as Array<Record<string, unknown>>;
    expect(userContent).toHaveLength(3);
    expect(userContent[1]).toEqual({ type: "image_url", image_url: { url: "data:image/jpeg;base64,AAAA" } });
    expect(userContent[2]).toEqual({ type: "image_url", image_url: { url: "data:image/png;base64,BBBB" } });
  });

  test("text-only posts are still reviewed", () => {
    const body = buildPostReviewRequestBody({ model: "m", prompt: "p", text: "只有文字", images: [] });
    const userContent = body.messages[1]?.content as Array<{ type: string; text?: string }>;
    expect(userContent).toHaveLength(1);
    expect(userContent[0]?.text).toContain("只有文字");
  });
});

describe("callPostReviewModel", () => {
  const request = { prompt: "p", text: "t", images: [] };

  test("parses a successful chat completion", async () => {
    const fetchImpl = async (url: string, init: RequestInit) => {
      expect(url).toBe("https://a.example/v1/chat/completions");
      expect((init.headers as Record<string, string>).Authorization).toBe("Bearer k1");
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"approve","category":null,"reason":"ok"}' } }] }), { status: 200 });
    };
    expect(await callPostReviewModel(primary, request, fetchImpl)).toEqual({ decision: "approve", category: null, reason: "ok" });
  });

  test("throws on HTTP errors with the provider message", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 429 });
    await expect(callPostReviewModel(primary, request, fetchImpl)).rejects.toThrow("quota exceeded");
  });

  test("throws when the output fails schema validation", async () => {
    const fetchImpl = async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"decision":"ok"}' } }] }), { status: 200 });
    await expect(callPostReviewModel(primary, request, fetchImpl)).rejects.toThrow(PostReviewOutputError);
  });
});

describe("post review images", () => {
  test("keeps the original MIME when compression is unavailable", async () => {
    const image = await preparePostReviewImage(new Uint8Array([1, 2, 3]), "image/png", async (buffer) => buffer);
    expect(image).toEqual({ mimeType: "image/png", base64: Buffer.from([1, 2, 3]).toString("base64") });
  });

  test("steps down resolution until the image fits", async () => {
    const dimensions: number[] = [];
    const image = await preparePostReviewImage(new Uint8Array(10), "image/png", async (_buffer, contentType, config) => {
      expect(contentType).toBe("image/jpeg");
      dimensions.push(config.maxDimension);
      return Buffer.alloc(config.maxDimension >= 896 ? 2_000_000 : 1_000);
    });
    expect(dimensions).toEqual([1_280, 896, 640]);
    expect(image.mimeType).toBe("image/jpeg");
  });

  test("detects when the total image budget is exceeded", () => {
    const half = Buffer.alloc(Math.floor(postReviewImagesTotalMaxBytes / 2)).toString("base64");
    expect(exceedsPostReviewImageBudget([{ mimeType: "image/jpeg", base64: half }])).toBe(false);
    expect(exceedsPostReviewImageBudget([
      { mimeType: "image/jpeg", base64: half },
      { mimeType: "image/jpeg", base64: half },
      { mimeType: "image/jpeg", base64: "AAAA" },
    ])).toBe(true);
  });
});
