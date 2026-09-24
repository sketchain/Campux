import type { TenantPluginConfig } from "./tenant-plugin-config";

/**
 * 班级群（单墙服务一个班级 QQ 群）相关的纯逻辑：配置解析、群成员判定、好友列表缓存。
 * 配置存在 tenant_metadata.plugin_config.classGroup，在「管理 / 插件」页配置。
 */

export type ClassGroupSettings = {
  groupId: string | null;
  /** 好友申请只放行班级群成员，其余拒绝 */
  friendFilterActive: boolean;
  /** 私聊投稿时对 Bot 好友懒注册（不再首条私聊即注册并私发密码） */
  lazyRegisterActive: boolean;
  /** QQ 空间发布成功后同步到班级群 */
  publishSyncActive: boolean;
};

export const inactiveClassGroupSettings: ClassGroupSettings = {
  groupId: null,
  friendFilterActive: false,
  lazyRegisterActive: false,
  publishSyncActive: false,
};

export function resolveClassGroupSettings(config: Pick<TenantPluginConfig, "classGroup">): ClassGroupSettings {
  const section = config.classGroup;
  if (!section.enabled) {
    return inactiveClassGroupSettings;
  }
  const groupId = /^\d{5,}$/.test(section.groupId.trim()) ? section.groupId.trim() : null;
  return {
    groupId,
    friendFilterActive: Boolean(groupId) && section.friendFilterEnabled,
    lazyRegisterActive: section.lazyRegisterEnabled,
    publishSyncActive: Boolean(groupId) && section.publishSyncEnabled,
  };
}

export type ClassGroupMembership = "member" | "not_member" | "lookup_failed";

/** 解读 NapCat `get_group_member_info` 的返回：只有返回了该用户的成员信息才算在群里。 */
export function interpretGroupMemberInfo(data: unknown, userQqUin: string): ClassGroupMembership {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return "not_member";
  }
  const record = data as Record<string, unknown>;
  const userId = typeof record.user_id === "number" || typeof record.user_id === "string" ? String(record.user_id) : "";
  return userId === userQqUin ? "member" : "not_member";
}

/** 查询报错时，协议端的「不是群成员」类错误视为不在群里，其余视为查询失败。 */
export function classifyGroupMemberLookupError(message: string): ClassGroupMembership {
  return /不是群成员|不在群|not\s*(a\s*)?member|member\s*not\s*found|群成员不存在|用户不存在|找不到/i.test(message)
    ? "not_member"
    : "lookup_failed";
}

export type ClassGroupFriendRequestDecision =
  | { action: "approve" }
  | { action: "reject"; reason: "not_in_group" | "lookup_failed" };

/** 在群里就通过（沿用随机延迟），不在群里或查询失败都拒绝。 */
export function decideClassGroupFriendRequest(membership: ClassGroupMembership): ClassGroupFriendRequestDecision {
  if (membership === "member") {
    return { action: "approve" };
  }
  return { action: "reject", reason: membership === "not_member" ? "not_in_group" : "lookup_failed" };
}

export function buildRejectFriendAddRequestParams(flag: string) {
  return { flag, approve: false };
}

/** 从 `get_friend_list` 返回里取出好友 QQ 号。 */
export function parseFriendListUserIds(data: unknown): Set<string> | null {
  if (!Array.isArray(data)) {
    return null;
  }
  const ids = new Set<string>();
  for (const entry of data) {
    const userId = entry && typeof entry === "object" ? (entry as Record<string, unknown>).user_id : undefined;
    if (typeof userId === "number" || typeof userId === "string") {
      ids.add(String(userId));
    }
  }
  return ids;
}

/**
 * 按 Bot 缓存好友列表。命中直接返回；未命中且缓存已有一段时间时强制刷新一次，
 * 以便刚加上好友的用户不必等缓存过期。并发请求共享同一次拉取。
 */
export class FriendListCache {
  private readonly entries = new Map<string, { fetchedAt: number; friends: Set<string> }>();
  private readonly inFlight = new Map<string, Promise<Set<string>>>();

  constructor(private readonly options: { ttlMs?: number; missRefreshMs?: number; now?: () => number } = {}) {}

  async isFriend(botQqUin: string, userQqUin: string, fetchFriends: () => Promise<Set<string>>): Promise<boolean> {
    const now = this.options.now ?? Date.now;
    const ttlMs = this.options.ttlMs ?? 5 * 60_000;
    const missRefreshMs = this.options.missRefreshMs ?? 10_000;
    const cached = this.entries.get(botQqUin);
    if (cached && now() - cached.fetchedAt < ttlMs) {
      if (cached.friends.has(userQqUin)) {
        return true;
      }
      if (now() - cached.fetchedAt < missRefreshMs) {
        return false;
      }
    }
    const friends = await this.refresh(botQqUin, fetchFriends);
    return friends.has(userQqUin);
  }

  invalidate(botQqUin: string) {
    this.entries.delete(botQqUin);
  }

  private refresh(botQqUin: string, fetchFriends: () => Promise<Set<string>>) {
    const existing = this.inFlight.get(botQqUin);
    if (existing) {
      return existing;
    }
    const now = this.options.now ?? Date.now;
    const task = fetchFriends()
      .then((friends) => {
        this.entries.set(botQqUin, { fetchedAt: now(), friends });
        return friends;
      })
      .finally(() => {
        this.inFlight.delete(botQqUin);
      });
    this.inFlight.set(botQqUin, task);
    return task;
  }
}
