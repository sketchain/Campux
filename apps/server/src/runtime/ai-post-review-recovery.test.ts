import { describe, expect, test } from "bun:test";
import {
  defaultAiReviewRecoveryWindowHours,
  planAiReviewRecovery,
  resolveAiReviewRecoveryWindowHours,
} from "./ai-post-review-recovery";
import { aiReviewAuditActions } from "./ai-post-review";

const now = new Date("2026-09-24T12:00:00Z");
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000);

describe("planAiReviewRecovery", () => {
  test("re-reviews unaudited posts inside the window, oldest first", () => {
    const plan = planAiReviewRecovery(
      [
        { id: "recent", createdAt: hoursAgo(1) },
        { id: "older", createdAt: hoursAgo(20) },
        { id: "edge", createdAt: hoursAgo(24) },
      ],
      { now, windowHours: 24, reviewedPostIds: new Set() },
    );
    expect(plan).toEqual({ toReview: ["edge", "older", "recent"], expiredCount: 0 });
  });

  test("skips posts that already have an AI review audit record", () => {
    const plan = planAiReviewRecovery(
      [
        { id: "failed-before", createdAt: hoursAgo(2) },
        { id: "fresh", createdAt: hoursAgo(3) },
      ],
      { now, windowHours: 24, reviewedPostIds: new Set(["failed-before"]) },
    );
    expect(plan).toEqual({ toReview: ["fresh"], expiredCount: 0 });
  });

  test("only counts posts outside the window, excluding audited ones", () => {
    const plan = planAiReviewRecovery(
      [
        { id: "stale", createdAt: hoursAgo(30) },
        { id: "stale-audited", createdAt: hoursAgo(40) },
        { id: "ok", createdAt: hoursAgo(5) },
      ],
      { now, windowHours: 24, reviewedPostIds: new Set(["stale-audited"]) },
    );
    expect(plan).toEqual({ toReview: ["ok"], expiredCount: 1 });
  });

  test("respects a custom window", () => {
    const plan = planAiReviewRecovery([{ id: "a", createdAt: hoursAgo(3) }], { now, windowHours: 2, reviewedPostIds: new Set() });
    expect(plan).toEqual({ toReview: [], expiredCount: 1 });
  });
});

describe("resolveAiReviewRecoveryWindowHours", () => {
  test("defaults to 24 hours and accepts positive overrides", () => {
    expect(defaultAiReviewRecoveryWindowHours).toBe(24);
    expect(resolveAiReviewRecoveryWindowHours(undefined)).toBe(24);
    expect(resolveAiReviewRecoveryWindowHours("")).toBe(24);
    expect(resolveAiReviewRecoveryWindowHours("abc")).toBe(24);
    expect(resolveAiReviewRecoveryWindowHours("-3")).toBe(24);
    expect(resolveAiReviewRecoveryWindowHours("6")).toBe(6);
    expect(resolveAiReviewRecoveryWindowHours("100000")).toBe(720);
  });
});

describe("aiReviewAuditActions", () => {
  test("covers approve, reject and failed", () => {
    expect(Object.values(aiReviewAuditActions).sort()).toEqual(["post.ai_review.approve", "post.ai_review.failed", "post.ai_review.reject"]);
  });
});
