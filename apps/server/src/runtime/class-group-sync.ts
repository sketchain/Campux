import { Buffer } from "node:buffer";
import type { FastifyBaseLogger } from "fastify";
import type { CampuxConfig } from "@campux/config";
import { getStorageDriver } from "@campux/integrations";
import { writeAuditLog } from "../lib/audit";
import { imageStorageHardMaxBytes } from "../lib/image-upload-policy";
import { prisma } from "../lib/prisma";
import { readClassGroupSettings } from "./class-group";
import { assertValidImageKey } from "./publishing";

/**
 * 墙 → 班级群单向同步：QQ 空间（或 QQ 频道）发布成功后，把发布时已渲染好的卡片图和投稿原图
 * 发到班级群。单条发布发一条群消息；合并发布整批发成一条合并转发。
 * 不附任何文字：匿名稿以卡片呈现为准，不会泄露投稿人 QQ。
 */

export const classGroupSyncSucceededAction = "class_group.sync.succeeded";
const classGroupSyncFailedAction = "class_group.sync.failed";
const classGroupSendTimeoutMs = 60_000;

export type ClassGroupSyncImage = { name: string; bytes: Uint8Array };

export type ClassGroupSyncPost = {
  postId: string;
  displayId: number;
  /** 发布时渲染好的卡片图（复用，不重复渲染） */
  card?: Uint8Array | undefined;
  /** 已读好的投稿原图；缺省时按 attachments 从存储读取 */
  images?: ClassGroupSyncImage[] | undefined;
  attachments?: unknown;
};

export type ClassGroupSyncInput = {
  tenantId: string;
  /** 发布目标对应的 Bot，用它发到班级群 */
  botAccount: { qqUin: bigint };
  batch: boolean;
  posts: ClassGroupSyncPost[];
};

type ImageSegment = { type: "image"; data: { file: string } };

export function buildClassGroupImageSegments(post: { card?: Uint8Array | undefined; images: ClassGroupSyncImage[] }): ImageSegment[] {
  const files = [...(post.card ? [post.card] : []), ...post.images.map((image) => image.bytes)];
  return files.map((bytes) => ({ type: "image", data: { file: `base64://${Buffer.from(bytes).toString("base64")}` } }));
}

/** 合并转发节点：发送者统一显示为 Bot 与墙名，不出现投稿人信息。 */
export function buildClassGroupForwardNodes(
  posts: Array<{ card?: Uint8Array | undefined; images: ClassGroupSyncImage[] }>,
  sender: { name: string; uin: string },
) {
  return posts.map((post) => ({
    type: "node",
    data: {
      name: sender.name,
      uin: sender.uin,
      content: buildClassGroupImageSegments(post),
    },
  }));
}

/** 去掉已同步过或正在同步的稿件（同一稿件多个发布目标只同步一次）。 */
export function selectPostsToSync<T extends { postId: string }>(posts: T[], alreadySynced: Set<string>, inFlight: Set<string>): T[] {
  const seen = new Set<string>();
  return posts.filter((post) => {
    if (seen.has(post.postId) || alreadySynced.has(post.postId) || inFlight.has(post.postId)) {
      return false;
    }
    seen.add(post.postId);
    return true;
  });
}

export function formatClassGroupSyncFailure(displayIds: number[], message: string) {
  return `班级群同步失败 ${displayIds.map((id) => `#${id}`).join("、")}：${message.slice(0, 200)}`;
}

export class ClassGroupPublishSync {
  private readonly inFlight = new Set<string>();

  constructor(private readonly deps: {
    callAction: (botQqUin: string, action: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
    sendTenantReviewNotification: (tenantId: string, message: unknown) => Promise<void>;
    logger: FastifyBaseLogger;
    config?: CampuxConfig | undefined;
  }) {}

  /** 失败只记日志并在审核群提示，从不抛出，不影响发布状态。 */
  async sync(input: ClassGroupSyncInput): Promise<void> {
    const settings = await readClassGroupSettings(input.tenantId, this.deps.logger);
    if (!settings.publishSyncActive || !settings.groupId || input.posts.length === 0) {
      return;
    }
    const synced = await prisma.auditLog.findMany({
      where: {
        tenantId: input.tenantId,
        action: classGroupSyncSucceededAction,
        targetType: "post",
        targetId: { in: input.posts.map((post) => post.postId) },
      },
      select: { targetId: true },
    });
    const posts = selectPostsToSync(input.posts, new Set(synced.flatMap((row) => row.targetId ? [row.targetId] : [])), this.inFlight);
    if (posts.length === 0) {
      return;
    }
    for (const post of posts) this.inFlight.add(post.postId);

    const groupId = settings.groupId;
    const botQqUin = input.botAccount.qqUin.toString();
    try {
      const prepared = [];
      for (const post of posts) {
        prepared.push({ card: post.card, images: post.images ?? await this.loadImages(input.tenantId, post.attachments) });
      }
      if (input.batch) {
        const tenant = await prisma.tenant.findUnique({ where: { id: input.tenantId }, select: { name: true } });
        await this.deps.callAction(botQqUin, "send_group_forward_msg", {
          group_id: Number(groupId),
          messages: buildClassGroupForwardNodes(prepared, { name: tenant?.name ?? "校园墙", uin: botQqUin }),
        }, classGroupSendTimeoutMs);
      } else {
        for (const item of prepared) {
          await this.deps.callAction(botQqUin, "send_group_msg", {
            group_id: Number(groupId),
            message: buildClassGroupImageSegments(item),
          }, classGroupSendTimeoutMs);
        }
      }
      for (const post of posts) {
        await writeAuditLog({
          tenantId: input.tenantId,
          actorId: null,
          action: classGroupSyncSucceededAction,
          targetType: "post",
          targetId: post.postId,
          detail: { displayId: post.displayId, groupId, botQqUin, batch: input.batch },
        });
      }
      this.deps.logger.info({ tenantId: input.tenantId, groupId, postIds: posts.map((post) => post.postId), batch: input.batch }, "class group: published posts synced");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.deps.logger.warn({ error, tenantId: input.tenantId, groupId, postIds: posts.map((post) => post.postId) }, "class group: publish sync failed");
      for (const post of posts) {
        await writeAuditLog({
          tenantId: input.tenantId,
          actorId: null,
          action: classGroupSyncFailedAction,
          targetType: "post",
          targetId: post.postId,
          detail: { displayId: post.displayId, groupId, botQqUin, batch: input.batch, error: message.slice(0, 500) },
        }).catch(() => undefined);
      }
      await this.deps.sendTenantReviewNotification(input.tenantId, formatClassGroupSyncFailure(posts.map((post) => post.displayId), message)).catch((notifyError) => {
        this.deps.logger.warn({ error: notifyError, tenantId: input.tenantId }, "class group: failed to report sync failure");
      });
    } finally {
      for (const post of posts) this.inFlight.delete(post.postId);
    }
  }

  private async loadImages(tenantId: string, attachments: unknown): Promise<ClassGroupSyncImage[]> {
    const items = Array.isArray(attachments) ? attachments as Array<Record<string, unknown>> : [];
    const images = items.filter((item) => item?.kind === "image" && typeof item.key === "string");
    if (images.length === 0) {
      return [];
    }
    if (!this.deps.config) {
      throw new Error("存储配置不可用，无法读取原图");
    }
    const storage = getStorageDriver(this.deps.config);
    const result: ClassGroupSyncImage[] = [];
    for (const image of images) {
      const key = image.key as string;
      assertValidImageKey(key, tenantId);
      const object = await storage.getBytes(key);
      if (!object || object.bytes.byteLength === 0) {
        throw new Error(`图片 ${key} 读取失败`);
      }
      if (object.bytes.byteLength > imageStorageHardMaxBytes) {
        throw new Error(`图片 ${key} 超过存储安全限制`);
      }
      result.push({ name: typeof image.fileName === "string" ? image.fileName : key.split("/").pop() ?? "image", bytes: object.bytes });
    }
    return result;
  }
}
