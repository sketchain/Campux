import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { DEFAULT_BOT_USER_MESSAGE_REPLY, formatPrivateHelp, resolvePrivateHelpReply } from "./bot-messages";

function forEachVariant(run: (stylishEnabled: boolean) => void) {
  const originalRandom = Math.random;
  try {
    for (const stylishEnabled of [false, true]) {
      for (const randomValue of [0, 0.5, 0.9]) {
        Math.random = () => randomValue;
        run(stylishEnabled);
      }
    }
  } finally {
    Math.random = originalRandom;
  }
}

describe("formatPrivateHelp with lazy registration", () => {
  test("lazy help never promises registration on the first message", () => {
    forEachVariant((stylishEnabled) => {
      const message = formatPrivateHelp(stylishEnabled, true);
      expect(message).not.toContain("首次私聊");
      expect(message).not.toContain("自动注册");
      expect(message).toContain("班级群同学加好友后");
      expect(message).toContain("#投稿");
      expect(message).toContain("#重置密码");
      expect(message).not.toContain("#注册账号");
    });
  });

  test("without lazy registration the text is unchanged", () => {
    forEachVariant((stylishEnabled) => {
      // 随机数被固定，两次调用选中同一条文案
      expect(formatPrivateHelp(stylishEnabled, false)).toBe(formatPrivateHelp(stylishEnabled));
      expect(formatPrivateHelp(stylishEnabled, false)).toContain("自动注册");
    });
  });
});

describe("resolvePrivateHelpReply", () => {
  test("keeps the original behaviour when lazy registration is off", () => {
    expect(resolvePrivateHelpReply("自定义回复", false, false)).toBe("自定义回复");
    expect(resolvePrivateHelpReply(DEFAULT_BOT_USER_MESSAGE_REPLY, false, false)).toBe(DEFAULT_BOT_USER_MESSAGE_REPLY);
    expect(resolvePrivateHelpReply("", false, false)).toBe(formatPrivateHelp(false));
    expect(resolvePrivateHelpReply(null, false, false)).toBe(formatPrivateHelp(false));
  });

  test("replaces the untouched factory reply and empty replies when lazy registration is on", () => {
    expect(resolvePrivateHelpReply(DEFAULT_BOT_USER_MESSAGE_REPLY, false, true)).toBe(formatPrivateHelp(false, true));
    expect(resolvePrivateHelpReply(`${DEFAULT_BOT_USER_MESSAGE_REPLY}\n`, false, true)).toBe(formatPrivateHelp(false, true));
    expect(resolvePrivateHelpReply("", false, true)).toBe(formatPrivateHelp(false, true));
  });

  test("respects replies customised by the admin even with lazy registration on", () => {
    expect(resolvePrivateHelpReply("有事请私聊班长", false, true)).toBe("有事请私聊班长");
  });

  test("factory reply constant matches the schema default", () => {
    const schema = readFileSync(resolve(import.meta.dir, "../../../../packages/db/prisma/schema.prisma"), "utf8");
    const match = /userMessageReply\s+String\s+@default\("((?:[^"\\]|\\.)*)"\)/.exec(schema);
    expect(match).not.toBeNull();
    expect(JSON.parse(`"${match![1]}"`)).toBe(DEFAULT_BOT_USER_MESSAGE_REPLY);
  });
});
