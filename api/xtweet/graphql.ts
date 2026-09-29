/**
 * X（Twitter）鉴权 GraphQL / 静态资源转发。
 *
 * 改造自 server/src/routes/xtweet.ts 的 `POST /api/xtweet/graphql`。
 * 用户在设置中填写自己的 auth_token/ct0 Cookie，本路由逐请求转发（不落库），
 * 带公共 Web Bearer 与 Cookie 代发 GET。
 *
 * 部署在 Vercel 的理由：魔搭（阿里云华北 2）出口到 x.com 不可达，且原实现用
 * 裸 `fetch()` 不读取用户的 proxy_config，容器内配代理也无法出网。
 *
 * 安全边界逐字保留——这是 SSRF 与凭据泄露的双重防线，不得简化：
 * - 目标 URL 白名单（仅首页 / 固定主脚本 / 两个固定 GraphQL 操作名）
 * - Cookie 值白名单（阻止 CRLF 头注入）
 * - `redirect: 'error'` 拒绝跨域重定向，避免用户 Cookie 被转发到白名单外域
 * - 响应 URL 二次校验
 * - 不落库：Cookie 仅在本次请求生命周期内存在
 */

import type { ServerResponse } from 'node:http';
import {
  BROWSER_UA,
  guardSameOrigin,
  readJsonBody,
  sendError,
  sendJson,
} from '../_lib/egress.js';
import {
  FETCH_TIMEOUT_MS,
  X_COOKIE_VALUE_PATTERN,
  X_WEB_BEARER,
  cleanCookie,
  isAllowedXProxyUrl,
  respondToFetchError,
  type EgressRequest,
} from './_shared.js';

/** 请求体形状，字段名沿用原 Express 版。 */
interface XGraphQLBody {
  /** 目标 x.com 或 abs.twimg.com 的完整 URL，必须通过白名单。 */
  url?: string;
  /** 用户自己的 X 会话凭证（来自设置面板，不落库）。 */
  auth?: { authToken?: string; ct0?: string };
}

export default async function handler(
  req: EgressRequest,
  res: ServerResponse
): Promise<void> {
  if (!guardSameOrigin(req, res)) return;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const body = await readJsonBody<XGraphQLBody>(req);
  const url = typeof body?.url === 'string' ? body.url : '';
  const authToken = cleanCookie(body?.auth?.authToken);
  const ct0 = cleanCookie(body?.auth?.ct0);

  if (!isAllowedXProxyUrl(url)) {
    sendError(res, 400, 'invalid url', 'INVALID_URL');
    return;
  }
  if (
    !authToken ||
    !ct0 ||
    !X_COOKIE_VALUE_PATTERN.test(authToken) ||
    !X_COOKIE_VALUE_PATTERN.test(ct0)
  ) {
    sendError(res, 400, 'invalid auth cookies', 'INVALID_AUTH');
    return;
  }

  try {
    // GraphQL API 请求带 Bearer/CSRF 等专有头；HTML 页面与静态资源带这些头
    // 反而被 x.com 拒 401（实测），只发 UA + Cookie
    const isApiCall = url.startsWith('https://x.com/i/api/');
    const headers: Record<string, string> = isApiCall
      ? {
          'User-Agent': BROWSER_UA,
          Accept: '*/*',
          Authorization: `Bearer ${X_WEB_BEARER}`,
          'X-CSRF-Token': ct0,
          'X-Twitter-Auth-Type': 'OAuth2Session',
          'X-Twitter-Active-User': 'yes',
          Cookie: `auth_token=${authToken}; ct0=${ct0}`,
        }
      : {
          'User-Agent': BROWSER_UA,
          Accept: 'text/html,application/xhtml+xml,*/*;q=0.8',
          // 主脚本（abs.twimg.com）绝不附带 X Cookie
          ...(url.startsWith('https://x.com/')
            ? { Cookie: `auth_token=${authToken}; ct0=${ct0}` }
            : {}),
        };

    // redirect: 'error' — 拒绝跨域重定向，避免 Cookie 被转到允许域名之外
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'error',
    });

    // 响应 URL 二次校验：即便 redirect 已设为 error，仍防御代理层改写。
    if (typeof response.url === 'string' && response.url && !isAllowedXProxyUrl(response.url)) {
      sendError(res, 400, 'redirect blocked', 'INVALID_URL');
      return;
    }

    if (!response.ok) {
      console.warn(
        `[xtweet] x.com graphql responded ${response.status} for ${new URL(url).hostname}`
      );
      sendError(res, 502, `x.com responded ${response.status}`, 'UPSTREAM_ERROR', response.status);
      return;
    }

    sendJson(res, 200, { body: await response.text() });
  } catch (error) {
    respondToFetchError(res, error, 'xtweet');
  }
}
