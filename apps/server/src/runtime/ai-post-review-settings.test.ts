import { describe, expect, test } from "bun:test";
import {
  DEFAULT_POST_REVIEW_PROMPT,
  normalizePostReviewRules,
  postReviewFallbackSecretKey,
  readPostReviewFallbackApiKey,
  resolveStoredPostReviewSecret,
  stripTransientPostReviewFields,
} from "./ai-post-review-settings";
import { normalizeAiRules } from "./ai-settings";
import { defaultLlmModelParams } from "./llm-params";

process.env.CAMPUX_BOT_SESSION_SECRET ??= "test-post-review-secret";

describe("post review rules", () => {
  test("defaults to disabled with the built-in prompt and 2 retries", () => {
    expect(normalizePostReviewRules({})).toEqual({
      postReviewEnabled: false,
      postReviewPrompt: DEFAULT_POST_REVIEW_PROMPT,
      postReviewMaxRetries: 2,
      postReviewFallbackBaseUrl: "",
      postReviewFallbackModel: "",
      postReviewFallbackApiKeyConfigured: false,
      postReviewFallbackParams: defaultLlmModelParams,
    });
  });

  test("blank prompt restores the default; retries are clamped", () => {
    const rules = normalizePostReviewRules({ postReviewPrompt: "   ", postReviewMaxRetries: 99, postReviewFallbackBaseUrl: "https://x.example/v1/" });
    expect(rules.postReviewPrompt).toBe(DEFAULT_POST_REVIEW_PROMPT);
    expect(rules.postReviewMaxRetries).toBe(5);
    expect(rules.postReviewFallbackBaseUrl).toBe("https://x.example/v1");
    expect(normalizePostReviewRules({ postReviewMaxRetries: -3 }).postReviewMaxRetries).toBe(0);
  });

  test("normalizeAiRules carries post review fields", () => {
    const rules = normalizeAiRules({ postReviewEnabled: true, postReviewPrompt: "只拦血腥" });
    expect(rules.postReviewEnabled).toBe(true);
    expect(rules.postReviewPrompt).toBe("只拦血腥");
    expect(normalizeAiRules(undefined).postReviewEnabled).toBe(false);
  });

  test("fallback API key is encrypted, readable, and only exposed as configured", () => {
    const stored = resolveStoredPostReviewSecret({ postReviewFallbackApiKey: " sk-spare " }, {});
    const secret = stored[postReviewFallbackSecretKey];
    expect(JSON.stringify(secret)).not.toContain("sk-spare");
    const rules = { postReviewFallbackModel: "m", ...stored };
    expect(readPostReviewFallbackApiKey(rules)).toBe("sk-spare");
    expect(normalizePostReviewRules(rules).postReviewFallbackApiKeyConfigured).toBe(true);
    expect(JSON.stringify(normalizePostReviewRules(rules))).not.toContain("ciphertext");
  });

  test("existing secret is kept unless a new key or clear is submitted", () => {
    const existing = resolveStoredPostReviewSecret({ postReviewFallbackApiKey: "old" }, {});
    expect(resolveStoredPostReviewSecret({}, existing)).toEqual(existing);
    expect(resolveStoredPostReviewSecret({ postReviewFallbackClearApiKey: true }, existing)).toEqual({});
    const replaced = resolveStoredPostReviewSecret({ postReviewFallbackApiKey: "new" }, existing);
    expect(readPostReviewFallbackApiKey(replaced)).toBe("new");
  });

  test("transient fields never reach storage", () => {
    const stripped: Record<string, unknown> = stripTransientPostReviewFields({
      postReviewEnabled: true,
      postReviewFallbackApiKeyConfigured: true,
      postReviewFallbackApiKey: "plain",
      postReviewFallbackClearApiKey: false,
    });
    expect(stripped).toEqual({ postReviewEnabled: true });
  });

  test("unreadable secrets read as not configured key", () => {
    expect(readPostReviewFallbackApiKey({ [postReviewFallbackSecretKey]: { algorithm: "aes-256-gcm", iv: "x", tag: "y", ciphertext: "z" } })).toBe("");
    expect(readPostReviewFallbackApiKey(null)).toBe("");
  });
});
