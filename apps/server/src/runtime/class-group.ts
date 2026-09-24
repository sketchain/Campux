import type { FastifyBaseLogger } from "fastify";
import {
  FriendListCache,
  buildRejectFriendAddRequestParams,
  checkMembershipWithRetry,
  classifyGroupMemberLookupError,
  decideClassGroupFriendRequest,
  formatClassGroupLookupDeferredNotice,
  inactiveClassGroupSettings,
  interpretGroupMemberInfo,
  parseFriendListUserIds,
  resolveClassGroupSettings,
  type ClassGroupMembership,
  type ClassGroupSettings,
} from "../lib/class-group";
import { writeAuditLog } from "../lib/audit";
import { prisma } from "../lib/prisma";
import { readTenantPluginConfig } from "../lib/tenant-plugin-config";

type CallAction = (botQqUin: string, action: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;

export async function readClassGroupSettings(tenantId: string, logger?: Pick<FastifyBaseLogger, "warn">): Promise<ClassGroupSettings> {
  try {
    return resolveClassGroupSettings(await readTenantPluginConfig(prisma, tenantId));
  } catch (error) {
    logger?.warn({ error, tenantId }, "class group: failed to read plugin config");
    return inactiveClassGroupSettings;
  }
}

/** 通过 OneBot（NapCat）查询班级群成员与 Bot 好友。 */
export class ClassGroupGate {
  private readonly friendCache = new FriendListCache();

  constructor(
    private readonly callAction: CallAction,
    private readonly logger: FastifyBaseLogger,
    private readonly notifyReviewGroup: (tenantId: string, message: string) => Promise<void> = async () => undefined,
    private readonly lookupRetryDelayMs?: number,
  ) {}

  async checkMembership(botQqUin: string, groupId: string, userQqUin: string): Promise<{ membership: ClassGroupMembership; error: string | null }> {
    try {
      const data = await this.callAction(botQqUin, "get_group_member_info", {
        group_id: Number(groupId),
        user_id: Number(userQqUin),
        no_cache: true,
      }, 12_000);
      return { membership: interpretGroupMemberInfo(data, userQqUin), error: null };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.info({ botQqUin, groupId, userQqUin, error: message }, "class group: member lookup failed");
      return { membership: classifyGroupMemberLookupError(message), error: message };
    }
  }

  /**
   * 好友申请过滤：
   * - 申请人在班级群里 → "approve"（调用方按原流程随机延迟后通过）；
   * - 明确不在群里 → 立即拒绝、写审计日志 → "rejected"；
   * - 查询失败（重试一次后仍失败）→ 既不同意也不拒绝，留给人工在 QQ 里处理，
   *   审核群提示一句并写审计日志 → "deferred"。
   */
  async screenFriendRequest(input: {
    tenantId: string;
    botAccountId: string;
    botQqUin: string;
    groupId: string;
    userQqUin: string;
    flag: string;
  }): Promise<"approve" | "rejected" | "deferred"> {
    const { membership, error, attempts } = await checkMembershipWithRetry(
      () => this.checkMembership(input.botQqUin, input.groupId, input.userQqUin),
      this.lookupRetryDelayMs === undefined ? {} : { retryDelayMs: this.lookupRetryDelayMs },
    );
    const decision = decideClassGroupFriendRequest(membership);
    if (decision.action === "approve") {
      return "approve";
    }
    const auditBase = {
      botQqUin: input.botQqUin,
      userQqUin: input.userQqUin,
      groupId: input.groupId,
      reason: decision.reason,
      lookupAttempts: attempts,
      lookupError: error,
    };

    if (decision.action === "defer") {
      this.logger.warn({ ...auditBase }, "class group: member lookup failed twice; friend request left for manual handling");
      await this.notifyReviewGroup(input.tenantId, formatClassGroupLookupDeferredNotice(input.userQqUin)).catch((caught) => {
        this.logger.warn({ error: caught }, "class group: failed to notify review group about deferred friend request");
      });
      await this.writeFriendRequestAudit(input, "bot.friend_request.class_group_deferred", auditBase);
      return "deferred";
    }

    let rejectError: string | null = null;
    try {
      await this.callAction(input.botQqUin, "set_friend_add_request", buildRejectFriendAddRequestParams(input.flag), 12_000);
      this.logger.info({ ...auditBase }, "class group: friend request rejected");
    } catch (caught) {
      rejectError = caught instanceof Error ? caught.message : String(caught);
      this.logger.warn({ ...auditBase, rejectError }, "class group: failed to reject friend request");
    }
    await this.writeFriendRequestAudit(input, "bot.friend_request.class_group_reject", { ...auditBase, rejectError });
    return "rejected";
  }

  private async writeFriendRequestAudit(input: { tenantId: string; botAccountId: string }, action: string, detail: Record<string, unknown>) {
    await writeAuditLog({
      tenantId: input.tenantId,
      actorId: null,
      action,
      targetType: "bot_account",
      targetId: input.botAccountId,
      detail,
    }).catch((caught) => {
      this.logger.warn({ error: caught }, "class group: failed to write friend request audit log");
    });
  }

  /** 查询失败按「不是好友」处理（维持原来的提示）。 */
  async isFriend(botQqUin: string, userQqUin: string): Promise<boolean> {
    try {
      return await this.friendCache.isFriend(botQqUin, userQqUin, async () => {
        const data = await this.callAction(botQqUin, "get_friend_list", {}, 45_000);
        const friends = parseFriendListUserIds(data);
        if (!friends) {
          throw new Error("get_friend_list 返回格式异常");
        }
        return friends;
      });
    } catch (error) {
      this.logger.warn({ error, botQqUin, userQqUin }, "class group: friend list lookup failed");
      return false;
    }
  }
}
