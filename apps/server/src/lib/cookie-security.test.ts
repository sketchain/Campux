import { describe, expect, test } from "bun:test";
import { serializeSessionCookie } from "./auth";
import { buildAggregateStateCookie } from "../routes/aggregate-oauth";

describe("login cookie Secure attribute", () => {
  test("session cookie carries Secure only when enabled", () => {
    const secure = serializeSessionCookie("token", 60, true);
    expect(secure.split("; ")).toContain("Secure");
    expect(secure).toContain("HttpOnly");
    expect(secure).toContain("SameSite=Lax");

    const plain = serializeSessionCookie("token", 60, false);
    expect(plain.split("; ")).not.toContain("Secure");
    expect(plain).toContain("HttpOnly");
    expect(plain).toBe(secure.replace("; Secure", ""));
  });

  test("aggregate login state cookie follows the same switch", () => {
    expect(buildAggregateStateCookie("state", 600, true).split("; ")).toContain("Secure");
    const plain = buildAggregateStateCookie("state", 600, false);
    expect(plain.split("; ")).not.toContain("Secure");
    expect(plain).toContain("HttpOnly");
  });
});
