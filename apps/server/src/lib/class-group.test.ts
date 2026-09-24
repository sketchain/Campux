import { describe, expect, test } from "bun:test";
import {
  FriendListCache,
  buildRejectFriendAddRequestParams,
  classifyGroupMemberLookupError,
  decideClassGroupFriendRequest,
  inactiveClassGroupSettings,
  interpretGroupMemberInfo,
  parseFriendListUserIds,
  resolveClassGroupSettings,
} from "./class-group";
import { defaultTenantPluginConfig, parseTenantPluginConfig } from "./tenant-plugin-config";

const section = (patch: Partial<typeof defaultTenantPluginConfig.classGroup>) => ({
  classGroup: { ...defaultTenantPluginConfig.classGroup, ...patch },
});

describe("class group settings", () => {
  test("disabled by default, and old configs without the section parse to defaults", () => {
    expect(resolveClassGroupSettings(defaultTenantPluginConfig)).toEqual(inactiveClassGroupSettings);
    const legacy = parseTenantPluginConfig({ markdownRender: { enabled: true } });
    expect(legacy.markdownRender.enabled).toBe(true);
    expect(legacy.classGroup).toEqual(defaultTenantPluginConfig.classGroup);
  });

  test("master switch off disables every sub feature", () => {
    expect(resolveClassGroupSettings(section({
      enabled: false,
      groupId: "123456",
      friendFilterEnabled: true,
      lazyRegisterEnabled: true,
      publishSyncEnabled: true,
    }))).toEqual(inactiveClassGroupSettings);
  });

  test("group-dependent features require a valid group id", () => {
    const noGroup = resolveClassGroupSettings(section({ enabled: true, friendFilterEnabled: true, lazyRegisterEnabled: true, publishSyncEnabled: true }));
    expect(noGroup).toEqual({ groupId: null, friendFilterActive: false, lazyRegisterActive: true, publishSyncActive: false });
    const withGroup = resolveClassGroupSettings(section({ enabled: true, groupId: " 987654321 ", friendFilterEnabled: true, publishSyncEnabled: true }));
    expect(withGroup).toEqual({ groupId: "987654321", friendFilterActive: true, lazyRegisterActive: false, publishSyncActive: true });
  });
});

describe("friend request filter", () => {
  test("only a matching member record counts as in the group", () => {
    expect(interpretGroupMemberInfo({ user_id: 10001, role: "member" }, "10001")).toBe("member");
    expect(interpretGroupMemberInfo({ user_id: "10001" }, "10001")).toBe("member");
    expect(interpretGroupMemberInfo({ user_id: 10002 }, "10001")).toBe("not_member");
    expect(interpretGroupMemberInfo(null, "10001")).toBe("not_member");
    expect(interpretGroupMemberInfo([], "10001")).toBe("not_member");
  });

  test("protocol errors are classified", () => {
    expect(classifyGroupMemberLookupError("用户不是群成员")).toBe("not_member");
    expect(classifyGroupMemberLookupError("member not found")).toBe("not_member");
    expect(classifyGroupMemberLookupError("OneBot 动作 get_group_member_info 等待响应超时")).toBe("lookup_failed");
  });

  test("members are approved, everyone else is rejected", () => {
    expect(decideClassGroupFriendRequest("member")).toEqual({ action: "approve" });
    expect(decideClassGroupFriendRequest("not_member")).toEqual({ action: "reject", reason: "not_in_group" });
    expect(decideClassGroupFriendRequest("lookup_failed")).toEqual({ action: "reject", reason: "lookup_failed" });
    expect(buildRejectFriendAddRequestParams("flag-1")).toEqual({ flag: "flag-1", approve: false });
  });
});

describe("friend list cache", () => {
  test("parses friend ids and rejects malformed payloads", () => {
    expect(parseFriendListUserIds([{ user_id: 1 }, { user_id: "2" }, { nickname: "x" }])).toEqual(new Set(["1", "2"]));
    expect(parseFriendListUserIds({ data: [] })).toBeNull();
  });

  test("serves hits from cache and refreshes misses after the grace period", async () => {
    let now = 0;
    let fetches = 0;
    let friends = new Set(["1"]);
    const cache = new FriendListCache({ ttlMs: 60_000, missRefreshMs: 10_000, now: () => now });
    const fetchFriends = async () => { fetches += 1; return new Set(friends); };

    expect(await cache.isFriend("bot", "1", fetchFriends)).toBe(true);
    expect(await cache.isFriend("bot", "1", fetchFriends)).toBe(true);
    expect(fetches).toBe(1);

    // 刚拉过列表：未命中直接判否，不重复拉取
    expect(await cache.isFriend("bot", "2", fetchFriends)).toBe(false);
    expect(fetches).toBe(1);

    // 过了宽限期：未命中强制刷新一次，刚加的好友能被识别
    friends = new Set(["1", "2"]);
    now = 15_000;
    expect(await cache.isFriend("bot", "2", fetchFriends)).toBe(true);
    expect(fetches).toBe(2);

    // 过期后命中也会刷新
    now = 100_000;
    expect(await cache.isFriend("bot", "1", fetchFriends)).toBe(true);
    expect(fetches).toBe(3);
  });

  test("concurrent lookups share one fetch and errors are not cached", async () => {
    let fetches = 0;
    const cache = new FriendListCache();
    const slow = async () => { fetches += 1; await Promise.resolve(); return new Set(["9"]); };
    const [a, b] = await Promise.all([cache.isFriend("bot", "9", slow), cache.isFriend("bot", "9", slow)]);
    expect([a, b]).toEqual([true, true]);
    expect(fetches).toBe(1);

    const failing = new FriendListCache();
    await expect(failing.isFriend("bot", "1", async () => { throw new Error("offline"); })).rejects.toThrow("offline");
    expect(await failing.isFriend("bot", "1", async () => new Set(["1"]))).toBe(true);
  });
});
