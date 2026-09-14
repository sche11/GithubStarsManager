/**
 * X（Twitter）未登录主页 HTML 抓取。
 *
 * 改造自 server/src/routes/xtweet.ts 的 `GET /api/xtweet/profile/:handle`。
 * 部署在 Vercel 的理由：魔搭（阿里云华北 2）出口到 x.com 不可达，且原实现用
 * 裸 `fetch()` 不读取用户的 proxy_config，容器内配代理也无法出网。
 *
 * 与 Express 版的差异仅限于适配层：路径参数改从 `req.query.handle` 读取，
 * 鉴权改为本文件内显式校验。安全边界（句柄白名单）逐字保留。
 */

import type { ServerResponse } from 'node:http';
import { BROWSER_UA, guardSameOrigin, sendError, sendJson } from '../../_lib/egress';
import {
  FETCH_TIMEOUT_MS,
  X_HANDLE_PATTERN,
  respondToFetchError,
  singleQuery,
  type EgressRequest,
} from '../_shared';

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

  const handle = singleQuery(req.query?.handle);
  if (!X_HANDLE_PATTERN.test(handle)) {
    sendError(res, 400, 'invalid handle', 'INVALID_HANDLE');
    return;
  }

  try {
    const response = await fetch(`https://x.com/${handle}`, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!response.ok) {
      console.warn(`[xtweet] x.com responded ${response.status} for @${handle}`);
      sendError(res, 502, `x.com responded ${response.status}`, 'UPSTREAM_ERROR', response.status);
      return;
    }

    sendJson(res, 200, { html: await response.text() });
  } catch (error) {
    respondToFetchError(res, error, 'xtweet');
  }
}
