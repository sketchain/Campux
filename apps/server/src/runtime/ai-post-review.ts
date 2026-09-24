import type { FastifyBaseLogger } from "fastify";
import type { CampuxConfig } from "@campux/config";
import type { EventBus } from "@campux/plugin";
import { getStorageDriver } from "@campux/integrations";
import { writeAuditLog } from "../lib/audit";
import { imageStorageHardMaxBytes } from "../lib/image-upload-policy";
import { prisma } from "../lib/prisma";
import { readTenantPublishMode } from "../lib/tenant-metadata";
import { isTenantRuntimeActive } from "../lib/tenant-runtime";
import { runWithActiveTenantLease } from "../lib/tenant-runtime-lease";
import { normalizeBaseUrl, readTenantAiSettings, resolveTenantAiApiKey, type TenantAiSettingsPayload, type TenantAiSettingsUpdate } from "./ai-settings";
import { readPostReviewFallbackApiKey } from "./ai-post-review-settings";
import {
  callPostReviewModel,
  exceedsPostReviewImageBudget,
  preparePostReviewImage,
  runPostReviewWithFallback,
  type PostReviewCallAttempt,
  type PostReviewDecision,
  type PostReviewImage,
  type PostReviewModelEndpoint,
} from "./ai-post-review-model";
import { addApprovedPostToBatch } from "./publish-batching";
import { assertValidImageKey, enqueuePublishFanout } from "./publishing";
import type { RuntimeQueue } from "./queue";

/** AI 审核在插件事件里使用的 reviewerId。 */
export const aiReviewerId = "ai";
/** AI 审核写入的审计动作；重启恢复据此判断稿件是否已被 AI 处理过。 */
export const aiReviewAuditActions = {
  approve: "post.ai_review.approve",
  reject: "post.ai_review.reject",
  failed: "post.ai_review.failed",
} as const;
const aiCommentPrefix = "[AI]";
const maxPostReviewImages = 9;

export type AiPostReviewNotifier = {
  notifyReviewResult(postId: string, status: "approved" | "rejected", comment?: string | null): Promise<void>;
  sendTenantReviewNotification(tenantId: string, message: unknown): Promise<void>;
  /** 发送原版「新稿件待审核」通知，note 非空时附在文字末尾。 */
  notifyPendingReview(postId: string, note: string | null): Promise<void>;
};

type ReviewPost = {
  id: string;
  tenantId: string;
  displayId: number;
  status: string;
  text: string;
  attachments: unknown;
};

export function formatAiReviewComment(decision: PostReviewDecision) {
  return decision.decision === "approve"
    ? `${aiCommentPrefix} 通过：${decision.reason}`
    : `${aiCommentPrefix} 拒绝（${decision.category ?? "不符合规范"}）：${decision.reason}`;
}

/** 私聊给投稿人的拒绝理由。 */
export function formatAiRejectReasonForAuthor(decision: PostReviewDecision) {
  return decision.category ? `${decision.category}：${decision.reason}` : decision.reason;
}

/** 审核群里的一行纯文字，不带图片。 */
export function formatAiRejectGroupNotice(displayId: number, decision: PostReviewDecision) {
  return `AI 已拒绝 #${displayId}：${decision.category ?? decision.reason}`;
}

export function formatAiReviewFailedNote(displayId: number) {
  return `AI 审核失败，#${displayId} 转人工`;
}

/**
 * 新稿件的 AI 自动审核。
 *
 * 挂在 OneBotRuntime.notifyNewPost 上（网页投稿与私聊投稿两条路径都会走到那里）。
 * 开启时由本类接管审核群通知：通过不单独通知；拒绝只发一行纯文字；失败才发原版带图通知并附说明。
 * 审核本身在后台执行，不阻塞投稿请求 / 私聊回复。
 */
export class AiPostReviewer {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: {
    queue: RuntimeQueue;
    logger: FastifyBaseLogger;
    config?: CampuxConfig | undefined;
    pluginEvents?: EventBus | undefined;
    notifier: AiPostReviewNotifier;
    fetchImpl?: typeof fetch;
  }) {}

  /**
   * 若该稿件应由 AI 审核则在后台启动并返回 true（调用方不要再发原版待审核通知）；
   * 功能关闭或稿件已不是待审核时返回 false，调用方走原逻辑。
   */
  async tryStart(postId: string): Promise<boolean> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { tenantId: true, status: true },
    });
    if (!post || post.status !== "pending_approval") {
      return false;
    }
    const settings = await readTenantAiSettings(post.tenantId).catch((error) => {
      this.deps.logger.warn({ error, tenantId: post.tenantId }, "ai post review: failed to read AI settings");
      return null;
    });
    if (!settings || !isAiPostReviewActive(settings)) {
      return false;
    }
    void this.launch(postId, settings);
    return true;
  }

  /**
   * 重启恢复用：与 tryStart 条件相同，但等待这条稿件审核结束后才返回，便于调用方逐条串行处理。
   * 返回 false 表示未处理（功能已关闭、稿件已不是待审核，或正由其他路径审核中）。
   */
  async reviewAndWait(postId: string): Promise<boolean> {
    const post = await prisma.post.findUnique({
      where: { id: postId },
      select: { tenantId: true, status: true },
    });
    if (!post || post.status !== "pending_approval" || this.inFlight.has(postId)) {
      return false;
    }
    const settings = await readTenantAiSettings(post.tenantId);
    if (!isAiPostReviewActive(settings)) {
      return false;
    }
    const launched = this.launch(postId, settings);
    if (!launched) {
      return false;
    }
    await launched;
    return true;
  }

  /** 登记并启动一次审核；同一稿件已在审核中时返回 null。返回的 Promise 不会 reject。 */
  private launch(postId: string, settings: TenantAiSettingsPayload): Promise<void> | null {
    if (this.inFlight.has(postId)) {
      return null;
    }
    this.inFlight.add(postId);
    return this.review(postId, settings)
      .catch((error) => {
        this.deps.logger.error({ error, postId }, "ai post review crashed");
        return this.fail(postId, error instanceof Error ? error.message : String(error), []);
      })
      .catch((error) => {
        this.deps.logger.error({ error, postId }, "ai post review failure fallback crashed");
      })
      .finally(() => {
        this.inFlight.delete(postId);
      });
  }

  private async review(postId: string, settings: TenantAiSettingsPayload) {
    const post = await loadPendingPost(postId);
    if (!post) {
      return;
    }

    const endpoints = await resolvePostReviewEndpoints(post.tenantId, settings);
    if (endpoints.length === 0) {
      await this.fail(postId, "没有可用的审核模型（主模型未配置，备用模型也未配置）", []);
      return;
    }

    let images: PostReviewImage[];
    try {
      images = await this.loadImages(post);
    } catch (error) {
      await this.fail(postId, `读取稿件图片失败：${error instanceof Error ? error.message : String(error)}`, []);
      return;
    }

    const result = await runPostReviewWithFallback({
      endpoints,
      retries: settings.rules.postReviewMaxRetries ?? 2,
      call: (endpoint) => callPostReviewModel(
        endpoint,
        { prompt: settings.rules.postReviewPrompt ?? "", text: post.text, images },
        this.deps.fetchImpl,
      ),
      // 等待重试期间稿件可能已被人工处理或校园墙被暂停，此时不再继续调模型。
      shouldContinue: async () => Boolean(await loadPendingPost(postId)) && await isTenantRuntimeActive(prisma, post.tenantId),
    });
    if (!result.ok) {
      const summary = result.attempts.map((item) => `${item.label}/${item.model}#${item.attempt}: ${item.error}`).join("; ");
      await this.fail(postId, summary || "审核中止", result.attempts);
      return;
    }

    await this.apply(post, result.decision, result.endpoint, result.attempts);
  }

  private async loadImages(post: ReviewPost): Promise<PostReviewImage[]> {
    const attachments = Array.isArray(post.attachments) ? post.attachments as Array<Record<string, unknown>> : [];
    const imageAttachments = attachments.filter((item) => item?.kind === "image");
    if (imageAttachments.length === 0) {
      return [];
    }
    if (imageAttachments.length > maxPostReviewImages) {
      throw new Error(`图片数量超过 ${maxPostReviewImages} 张`);
    }
    if (!this.deps.config) {
      throw new Error("存储配置不可用");
    }
    const storage = getStorageDriver(this.deps.config);
    const images: PostReviewImage[] = [];
    for (const attachment of imageAttachments) {
      const key = typeof attachment.key === "string" ? attachment.key : "";
      if (!key) {
        throw new Error("图片缺少 key");
      }
      assertValidImageKey(key, post.tenantId);
      const object = await storage.getBytes(key);
      if (!object || object.bytes.byteLength === 0) {
        throw new Error(`图片 ${key} 不存在或为空`);
      }
      if (object.bytes.byteLength > imageStorageHardMaxBytes) {
        throw new Error(`图片 ${key} 超过存储安全限制`);
      }
      const contentType = typeof attachment.contentType === "string" ? attachment.contentType : object.contentType ?? "image/jpeg";
      images.push(await preparePostReviewImage(object.bytes, contentType));
    }
    if (exceedsPostReviewImageBudget(images)) {
      throw new Error("压缩后图片总大小仍超过上限");
    }
    return images;
  }

  private async apply(
    post: ReviewPost,
    decision: PostReviewDecision,
    endpoint: PostReviewModelEndpoint,
    attempts: PostReviewCallAttempt[],
  ) {
    const approve = decision.decision === "approve";
    const nextStatus = approve ? "approved" : "rejected";
    const comment = formatAiReviewComment(decision);
    const leased = await runWithActiveTenantLease(prisma, post.tenantId, async (transaction) => {
      // 条件更新：稿件可能在 AI 判定期间已被人工处理，此时放弃本次结果。
      const updated = await transaction.post.updateMany({
        where: { id: post.id, tenantId: post.tenantId, status: "pending_approval" },
        data: { status: nextStatus },
      });
      if (updated.count === 0) {
        return null;
      }
      await transaction.postLog.create({
        data: {
          postId: post.id,
          tenantId: post.tenantId,
          actorId: null,
          oldStatus: "pending_approval",
          newStatus: nextStatus,
          comment,
        },
      });
      await writeAuditLog({
        tenantId: post.tenantId,
        actorId: null,
        action: approve ? aiReviewAuditActions.approve : aiReviewAuditActions.reject,
        targetType: "post",
        targetId: post.id,
        detail: {
          displayId: post.displayId,
          decision: decision.decision,
          category: decision.category,
          reason: decision.reason,
          model: endpoint.model,
          endpoint: endpoint.label,
          failedAttempts: attempts,
        },
      }, transaction);
      return approve ? readTenantPublishMode(transaction, post.tenantId) : { mode: "single" as const };
    });
    if (!leased.active) {
      this.deps.logger.info({ postId: post.id, tenantId: post.tenantId }, "ai post review skipped: tenant inactive");
      return;
    }
    if (!leased.value) {
      this.deps.logger.info({ postId: post.id }, "ai post review skipped: post no longer pending");
      return;
    }

    this.deps.logger.info({ postId: post.id, displayId: post.displayId, decision: decision.decision, category: decision.category, model: endpoint.model }, "ai post review decided");

    if (approve) {
      // 通过后立即进入发布流程，没有延迟窗口。
      if (leased.value.mode === "accumulate") {
        await addApprovedPostToBatch(this.deps.queue, post.tenantId, post.id, null, this.deps.logger);
      } else {
        await enqueuePublishFanout(this.deps.queue, post.tenantId, post.id, null);
      }
      await this.deps.notifier.notifyReviewResult(post.id, "approved").catch((error) => {
        this.deps.logger.warn({ error, postId: post.id }, "ai post review: failed to notify author");
      });
      this.deps.pluginEvents?.emit({ type: "review:approved", tenantId: post.tenantId, postId: post.id, reviewerId: aiReviewerId });
      return;
    }

    await this.deps.notifier.notifyReviewResult(post.id, "rejected", formatAiRejectReasonForAuthor(decision)).catch((error) => {
      this.deps.logger.warn({ error, postId: post.id }, "ai post review: failed to notify author");
    });
    await this.deps.notifier.sendTenantReviewNotification(post.tenantId, formatAiRejectGroupNotice(post.displayId, decision)).catch((error) => {
      this.deps.logger.warn({ error, postId: post.id }, "ai post review: failed to notify review group");
    });
    this.deps.pluginEvents?.emit({
      type: "review:rejected",
      tenantId: post.tenantId,
      postId: post.id,
      reviewerId: aiReviewerId,
      reason: formatAiRejectReasonForAuthor(decision),
    });
  }

  /** AI 失败：稿件保持待审核，审核群照原样通知并附一句转人工说明。 */
  private async fail(postId: string, reason: string, attempts: PostReviewCallAttempt[]) {
    const post = await loadPendingPost(postId);
    if (!post) {
      // 已被人工处理，无需再通知。
      return;
    }
    this.deps.logger.warn({ postId, displayId: post.displayId, reason }, "ai post review failed; falling back to manual review");
    await writeAuditLog({
      tenantId: post.tenantId,
      actorId: null,
      action: aiReviewAuditActions.failed,
      targetType: "post",
      targetId: post.id,
      detail: {
        displayId: post.displayId,
        reason: reason.slice(0, 1_000),
        failedAttempts: attempts,
      },
    }).catch((error) => {
      this.deps.logger.warn({ error, postId }, "ai post review: failed to write audit log");
    });
    await this.deps.notifier.notifyPendingReview(post.id, formatAiReviewFailedNote(post.displayId));
  }
}

export function isAiPostReviewActive(settings: TenantAiSettingsPayload) {
  return settings.enabled && settings.rules.postReviewEnabled === true;
}

/** 主模型（租户 LLM 设置）在前，备用模型在后；未配置完整的跳过。 */
export async function resolvePostReviewEndpoints(tenantId: string, settings: TenantAiSettingsPayload): Promise<PostReviewModelEndpoint[]> {
  const timeoutMs = settings.timeoutSeconds * 1_000;
  const endpoints: PostReviewModelEndpoint[] = [];
  if (settings.mode === "llm" && settings.apiKeyConfigured) {
    const apiKey = await resolveTenantAiApiKey(tenantId, {});
    if (apiKey) {
      endpoints.push({ label: "primary", baseUrl: normalizeBaseUrl(settings.baseUrl), model: settings.model, apiKey, timeoutMs });
    }
  }
  const fallback = await readFallbackEndpoint(tenantId, timeoutMs);
  if (fallback) {
    endpoints.push(fallback);
  }
  return endpoints;
}

async function readFallbackEndpoint(tenantId: string, timeoutMs: number): Promise<PostReviewModelEndpoint | null> {
  const row = await prisma.tenantAiSettings.findUnique({ where: { tenantId }, select: { rules: true } });
  const rules = row?.rules && typeof row.rules === "object" && !Array.isArray(row.rules) ? row.rules as Record<string, unknown> : {};
  const baseUrl = typeof rules.postReviewFallbackBaseUrl === "string" ? rules.postReviewFallbackBaseUrl.trim().replace(/\/+$/, "") : "";
  const model = typeof rules.postReviewFallbackModel === "string" ? rules.postReviewFallbackModel.trim() : "";
  const apiKey = readPostReviewFallbackApiKey(rules);
  if (!baseUrl || !model || !apiKey) {
    return null;
  }
  return { label: "fallback", baseUrl, model, apiKey, timeoutMs };
}

async function loadPendingPost(postId: string): Promise<ReviewPost | null> {
  const post = await prisma.post.findUnique({
    where: { id: postId },
    select: { id: true, tenantId: true, displayId: true, status: true, text: true, attachments: true },
  });
  return post && post.status === "pending_approval" ? post : null;
}

export type PostReviewModelTestResult = {
  ok: boolean;
  target: "primary" | "fallback";
  model: string;
  baseUrl: string;
  latencyMs: number | null;
  message: string;
};

/** 64×64 纯色 PNG，用于连接测试时确认模型接受 image_url 输入。 */
const postReviewTestImage: PostReviewImage = {
  mimeType: "image/png",
  base64: "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAj0lEQVR4nO3PAQkAABDCQGMb7DMtx8cQQbgAm3xUU7zAG6Ca4gXeANUUL/AGqKZ4gTdANcULvAGqKV7gDVBN8QJvgGqKF3gDVFO8wBugmuIF3gDVFC/wBqimeIE3QDXFC7wBqile4A1QTfECb4Bqihd4A1RTvMAboJriBd4A1RQv8AaopniBN0A1xQu8Aao9JbQh8GLp3hMAAAAASUVORK5CYII=",
};

/**
 * 自动审核模型连接测试：用表单里尚未保存的值（留空则用已保存值）发一条带图的测试稿件，
 * 校验模型能看图并返回合规 JSON。
 */
export async function testPostReviewModel(
  tenantId: string,
  input: TenantAiSettingsUpdate,
  target: "primary" | "fallback",
  fetchImpl: typeof fetch = fetch,
): Promise<PostReviewModelTestResult> {
  const current = await readTenantAiSettings(tenantId);
  const timeoutMs = Math.max(5, Math.min(120, input.timeoutSeconds ?? current.timeoutSeconds)) * 1_000;
  let endpoint: PostReviewModelEndpoint;
  if (target === "primary") {
    endpoint = {
      label: "primary",
      baseUrl: normalizeBaseUrl(input.baseUrl ?? current.baseUrl),
      model: input.model?.trim() || current.model,
      apiKey: await resolveTenantAiApiKey(tenantId, input),
      timeoutMs,
    };
  } else {
    const row = await prisma.tenantAiSettings.findUnique({ where: { tenantId }, select: { rules: true } });
    const rules = input.rules;
    endpoint = {
      label: "fallback",
      baseUrl: (rules?.postReviewFallbackBaseUrl ?? current.rules.postReviewFallbackBaseUrl ?? "").trim().replace(/\/+$/, ""),
      model: (rules?.postReviewFallbackModel ?? current.rules.postReviewFallbackModel ?? "").trim(),
      apiKey: rules?.postReviewFallbackApiKey?.trim()
        || (rules?.postReviewFallbackClearApiKey ? "" : readPostReviewFallbackApiKey(row?.rules)),
      timeoutMs,
    };
  }

  const base = { target, model: endpoint.model, baseUrl: endpoint.baseUrl };
  if (!endpoint.baseUrl || !endpoint.model) {
    return { ...base, ok: false, latencyMs: null, message: "接口地址或模型名未填写。" };
  }
  if (!endpoint.apiKey) {
    return { ...base, ok: false, latencyMs: null, message: "未配置 API Key。" };
  }
  if (!await isTenantRuntimeActive(prisma, tenantId)) {
    return { ...base, ok: false, latencyMs: null, message: "校园墙已暂停或归档。" };
  }

  const startedAt = Date.now();
  try {
    const decision = await callPostReviewModel(endpoint, {
      prompt: input.rules?.postReviewPrompt?.trim() || current.rules.postReviewPrompt || "",
      text: "测试稿件：今天食堂的红烧肉很好吃，推荐大家去试试。",
      images: [postReviewTestImage],
    }, fetchImpl);
    return {
      ...base,
      ok: true,
      latencyMs: Date.now() - startedAt,
      message: `模型可用，测试稿件判定为「${decision.decision === "approve" ? "通过" : "拒绝"}」：${decision.reason}`,
    };
  } catch (error) {
    return {
      ...base,
      ok: false,
      latencyMs: Date.now() - startedAt,
      message: error instanceof Error ? error.message : "测试失败",
    };
  }
}
