import { loadConfig } from "@campux/config";

let cachedCookieSecure: boolean | null = null;

/**
 * 登录 cookie（会话 cookie、聚合登录 state cookie）是否带 Secure，读 packages/config 的
 * cookieSecure（环境变量 CAMPUX_COOKIE_SECURE）。进程内只解析一次。
 */
export function isCookieSecure(): boolean {
  cachedCookieSecure ??= loadConfig().cookieSecure;
  return cachedCookieSecure;
}
