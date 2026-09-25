import { describe, expect, test } from "bun:test";
import {
  formatAiRejectGroupNotice,
  formatAiRejectReasonForAuthor,
  formatAiReviewComment,
  formatAiReviewFailedNote,
  isAiPostReviewActive,
  postReviewBudgetWarnings,
} from "./ai-post-review";
import type { TenantAiSettingsPayload } from "./ai-settings";

const reject = { decision: "reject" as const, category: "血腥", reason: "包含伤口特写" };
const approve = { decision: "approve" as const, category: null, reason: "日常分享" };

describe("AI review messages", () => {
  test("PostLog comments start with [AI] and carry the reason", () => {
    expect(formatAiReviewComment(approve)).toBe("[AI] 通过：日常分享");
    expect(formatAiReviewComment(reject)).toBe("[AI] 拒绝（血腥）：包含伤口特写");
  });

  test("review group gets a single plain-text line for rejections", () => {
    expect(formatAiRejectGroupNotice(123, reject)).toBe("AI 已拒绝 #123：血腥");
    expect(formatAiRejectGroupNotice(7, { ...reject, category: null })).toBe("AI 已拒绝 #7：包含伤口特写");
  });

  test("author sees category and reason", () => {
    expect(formatAiRejectReasonForAuthor(reject)).toBe("血腥：包含伤口特写");
  });

  test("failure note hands the post to humans", () => {
    expect(formatAiReviewFailedNote(123)).toBe("AI 审核失败，#123 转人工");
  });
});

describe("isAiPostReviewActive", () => {
  const base = { enabled: true, rules: { postReviewEnabled: true } } as TenantAiSettingsPayload;
  test("requires both the LLM master switch and the review toggle", () => {
    expect(isAiPostReviewActive(base)).toBe(true);
    expect(isAiPostReviewActive({ ...base, enabled: false })).toBe(false);
    expect(isAiPostReviewActive({ ...base, rules: { postReviewEnabled: false } })).toBe(false);
    expect(isAiPostReviewActive({ ...base, rules: {} })).toBe(false);
  });
});

describe("postReviewBudgetWarnings", () => {
  test("warns when the diagnostic run used more tokens than the real review budget", () => {
    expect(postReviewBudgetWarnings(120, 300, "max_tokens")).toEqual([]);
    expect(postReviewBudgetWarnings(null, 300, "max_tokens")).toEqual([]);
    expect(postReviewBudgetWarnings(900, 300, "omit")).toEqual([]);
    const warnings = postReviewBudgetWarnings(900, 300, "max_completion_tokens");
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("900");
    expect(warnings[0]).toContain("300");
  });
});
