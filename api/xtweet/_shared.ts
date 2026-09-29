/**
 * X（Twitter）抓取代理的共用常量与工具。
 *
 * 供 api/xtweet/profile/[handle].ts 与 api/xtweet/graphql.ts 复用。
 * 改造自 server/src/routes/xtweet.ts，将鉴权白名单集中在此处以避免两份实现
 * 漂移——这些正则是 SSRF 与凭据泄露的双重防线。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError } from '../_lib/egress.js';

/** 句柄白名单：与原 Express 实现逐字一致。 */
export const X_HANDLE_PATTERN = /^[A-Za-z0-9_]{1,15}$/;

// 鉴权代抓仅允许受控操作对应的 URL（调用方不可任意指定 x.com 路径）：
// 首页（queryId 提取入口）、abs.twimg.com 主脚本（绝不附带 X Cookie）、
// GraphQL UserTweets / UserByScreenName（queryId 动态，操作名固定）。
const X_HOME_URL = 'https://x.com/home';
const X_MAIN_JS_PATTERN =
  /^https:\/\/abs\.twimg\.com\/responsive-web\/client-web\/main\.[a-zA-Z0-9_-]+\.js$/;
const X_GRAPHQL_API_PATTERN =
  /^https:\/\/x\.com\/i\/api\/graphql\/[A-Za-z0-9_-]+\/(UserTweets|UserByScreenName)(\?.*)?$/;

/** 目标 URL 白名单判定：仅放行三个受控入口。 */
export const isAllowedXProxyUrl = (url: string): boolean =>
  url === X_HOME_URL || X_MAIN_JS_PATTERN.test(url) || X_GRAPHQL_API_PATTERN.test(url);

/** Cookie 值白名单：阻止 CRLF 注入到请求头。 */
export const X_COOKIE_VALUE_PATTERN = /^[\w%+/=.~-]+$/;

/** x.com 公共 Web Bearer（非用户凭证，官网前端硬编码值）。 */
export const X_WEB_BEARER =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

export const FETCH_TIMEOUT_MS = 20_000;

/** 从 Vercel 注入的 query 中取单值字符串。 */
export function singleQuery(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

/** 清洗 Cookie 值：去掉可能包裹的引号与首尾空白。 */
export function cleanCookie(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^["']|["']$/g, '').trim();
}

/**
 * 把出网异常统一映射为响应。
 * 超时→504，其余→502（与原 Express 版语义一致）。
 */
export function respondToFetchError(
  res: ServerResponse,
  error: unknown,
  logLabel: string
): void {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    sendError(res, 504, 'Upstream timeout', 'GATEWAY_TIMEOUT');
    return;
  }
  const message = error instanceof Error ? error.message : 'fetch failed';
  console.warn(`[${logLabel}] fetch failed: ${message}`);
  sendError(res, 502, message, 'UPSTREAM_ERROR');
}

/** Vercel Function 请求对象的形状（携带注入的 query 与解析后的 body）。 */
export type EgressRequest = IncomingMessage & {
  body?: unknown;
  query?: Record<string, string | string[]>;
};
