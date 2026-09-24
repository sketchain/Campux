import type { FastifyBaseLogger } from "fastify";
import { prisma } from "../lib/prisma";
import { tenantRuntimeRelationFilter } from "../lib/tenant-runtime";
import { aiReviewAuditActions, isAiPostReviewActive } from "./ai-post-review";
import { readTenantAiSettings } from "./ai-settings";

/**
 * AI 自动审核的重启恢复。
 *
 * 审核在内存里异步执行，服务重启时正在审的稿件会停在 pending_approval 且没有任何通知。
 * 启动后（等 NapCat 重连一会儿）扫描一次，把「开启了自动审核的墙里、最近 N 小时内创建、
 * 仍待审核、且没有任何 AI 审核审计记录」的稿件逐条串行重新交给 AiPostReviewer。
 * 超出时间窗的只记一条数量日志，留给人工。
 */

export const defaultAiReviewRecoveryWindowHours = 24;
/** 启动后等待多久再扫描：给 NapCat 反向 WS 重连留出时间，否则通知发不出去。 */
export const defaultAiReviewRecoveryDelayMs = 30_000;

export type RecoveryCandidate = { id: string; createdAt: Date };

/** 按时间窗与已有审计记录划分：返回需要重新审核的稿件（按创建时间升序）与超窗数量。 */
export function planAiReviewRecovery(
  posts: RecoveryCandidate[],
  options: { now: Date; windowHours: number; reviewedPostIds: Set<string> },
): { toReview: string[]; expiredCount: number } {
  const cutoff = options.now.getTime() - options.windowHours * 60 * 60 * 1000;
  const pending = posts
    .filter((post) => !options.reviewedPostIds.has(post.id))
    .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime());
  return {
    toReview: pending.filter((post) => post.createdAt.getTime() >= cutoff).map((post) => post.id),
    expiredCount: pending.filter((post) => post.createdAt.getTime() < cutoff).length,
  };
}

/** 读取 CAMPUX_AI_REVIEW_RECOVERY_WINDOW_HOURS；非法值回退到 24。 */
export function resolveAiReviewRecoveryWindowHours(value: string | undefined) {
  const parsed = Number(value);
  return value !== undefined && value.trim() !== "" && Number.isFinite(parsed) && parsed > 0
    ? Math.min(24 * 30, parsed)
    : defaultAiReviewRecoveryWindowHours;
}

type Reviewer = { reviewAndWait(postId: string): Promise<boolean> };

export async function recoverInterruptedAiPostReviews(options: {
  reviewer: Reviewer;
  logger: Pick<FastifyBaseLogger, "info" | "warn">;
  windowHours?: number;
  now?: Date;
  shouldStop?: () => boolean;
}) {
  const windowHours = options.windowHours ?? defaultAiReviewRecoveryWindowHours;
  const tenants = await prisma.tenantAiSettings.findMany({
    where: { tenant: tenantRuntimeRelationFilter },
    select: { tenantId: true },
  });
  const enabledTenantIds: string[] = [];
  for (const { tenantId } of tenants) {
    const settings = await readTenantAiSettings(tenantId).catch(() => null);
    if (settings && isAiPostReviewActive(settings)) {
      enabledTenantIds.push(tenantId);
    }
  }
  if (enabledTenantIds.length === 0) {
    return { reviewed: 0, expiredCount: 0 };
  }

  const posts = await prisma.post.findMany({
    where: { tenantId: { in: enabledTenantIds }, status: "pending_approval" },
    select: { id: true, createdAt: true },
  });
  if (posts.length === 0) {
    return { reviewed: 0, expiredCount: 0 };
  }
  const audited = await prisma.auditLog.findMany({
    where: {
      action: { in: Object.values(aiReviewAuditActions) },
      targetType: "post",
      targetId: { in: posts.map((post) => post.id) },
    },
    select: { targetId: true },
  });
  const plan = planAiReviewRecovery(posts, {
    now: options.now ?? new Date(),
    windowHours,
    reviewedPostIds: new Set(audited.flatMap((row) => (row.targetId ? [row.targetId] : []))),
  });

  if (plan.expiredCount > 0) {
    options.logger.info({ expiredCount: plan.expiredCount, windowHours }, "ai post review recovery: skipped pending posts outside the recovery window");
  }
  if (plan.toReview.length > 0) {
    options.logger.info({ count: plan.toReview.length, windowHours }, "ai post review recovery: re-reviewing interrupted posts");
  }

  let reviewed = 0;
  // 逐条串行，避免重启后一下子打爆模型接口。
  for (const postId of plan.toReview) {
    if (options.shouldStop?.()) {
      break;
    }
    try {
      if (await options.reviewer.reviewAndWait(postId)) {
        reviewed += 1;
      }
    } catch (error) {
      options.logger.warn({ error, postId }, "ai post review recovery: failed to re-review post");
    }
  }
  return { reviewed, expiredCount: plan.expiredCount };
}

/** 服务启动后延迟扫描一次；返回的函数用于关闭时取消。 */
export function scheduleAiPostReviewRecovery(options: {
  reviewer: Reviewer;
  logger: Pick<FastifyBaseLogger, "info" | "warn">;
  delayMs?: number;
  windowHours?: number;
}) {
  let stopped = false;
  const timer = setTimeout(() => {
    recoverInterruptedAiPostReviews({
      reviewer: options.reviewer,
      logger: options.logger,
      windowHours: options.windowHours ?? resolveAiReviewRecoveryWindowHours(process.env.CAMPUX_AI_REVIEW_RECOVERY_WINDOW_HOURS),
      shouldStop: () => stopped,
    }).catch((error) => {
      options.logger.warn({ error }, "ai post review recovery scan failed");
    });
  }, options.delayMs ?? defaultAiReviewRecoveryDelayMs);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
