import { afterEach, describe, expect, test } from "bun:test";
import { loadConfig, resolveCookieSecure } from "./index";

describe("resolveCookieSecure", () => {
  test("unset keeps the existing behaviour: Secure only in production", () => {
    expect(resolveCookieSecure("production", undefined)).toBe(true);
    expect(resolveCookieSecure("production", "")).toBe(true);
    expect(resolveCookieSecure("production", "  ")).toBe(true);
    expect(resolveCookieSecure("development", undefined)).toBe(false);
    expect(resolveCookieSecure("test", undefined)).toBe(false);
    expect(resolveCookieSecure(undefined, undefined)).toBe(false);
  });

  test("false / 0 drop Secure even in production", () => {
    expect(resolveCookieSecure("production", "false")).toBe(false);
    expect(resolveCookieSecure("production", " FALSE ")).toBe(false);
    expect(resolveCookieSecure("production", "0")).toBe(false);
  });

  test("true / 1 force Secure; unknown values fall back to the default", () => {
    expect(resolveCookieSecure("development", "true")).toBe(true);
    expect(resolveCookieSecure("development", "1")).toBe(true);
    expect(resolveCookieSecure("production", "no")).toBe(true);
    expect(resolveCookieSecure("development", "no")).toBe(false);
  });
});

describe("loadConfig().cookieSecure", () => {
  const original = { nodeEnv: process.env.NODE_ENV, cookieSecure: process.env.CAMPUX_COOKIE_SECURE };
  const restore = (key: string, value: string | undefined) => {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  };
  afterEach(() => {
    restore("NODE_ENV", original.nodeEnv);
    restore("CAMPUX_COOKIE_SECURE", original.cookieSecure);
  });

  test("keeps NODE_ENV=production while dropping Secure via CAMPUX_COOKIE_SECURE", () => {
    process.env.NODE_ENV = "production";
    delete process.env.CAMPUX_COOKIE_SECURE;
    expect(loadConfig().cookieSecure).toBe(true);

    process.env.CAMPUX_COOKIE_SECURE = "false";
    const config = loadConfig();
    expect(config.nodeEnv).toBe("production");
    expect(config.cookieSecure).toBe(false);
  });
});
