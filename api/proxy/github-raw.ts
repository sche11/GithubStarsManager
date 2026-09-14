/**
 * GitHub 原始内容代理。
 *
 * 改造自 server/src/routes/proxy.ts 的 `/api/proxy/github-raw` 路由。
 * 用途：gist 详情 API 对 >1MB 文件返回 truncated 时，按 raw_url 回退取全文。
 *
 * 与 server/src/routes/proxy.ts 的差异：token 改为调用方携带（Vercel 无数据库）。
 *
 * 安全边界：仅允许 gist/raw 两个 GitHub 内容域，且拒绝 URL 内嵌凭证与
 * 非 HTTPS 协议。这是防止本端点被当作任意 URL 抓取器（SSRF）的关键约束。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BROWSER_UA,
  guardSameOrigin,
  readJsonBody,
  sendError,
} from '../_lib/egress';

/** raw 内容主机白名单，与原 Express 实现逐字一致。 */
const ALLOWED_RAW_HOSTS = new Set(['gist.githubusercontent.com', 'raw.githubusercontent.com']);
const RAW_TIMEOUT_MS = 60_000;

/** 请求体形状，字段命名沿用原 Express 版。 */
interface RawProxyBody {
  /** 目标 raw 内容的完整 URL，必须落在白名单主机内。 */
  url?: string;
  /** 上游 HTTP 方法，默认 GET。 */
  method?: string;
  /** 需转发的头；Authorization / Host / Content-Length 一律丢弃。 */
  headers?: Record<string, string>;
  /** 调用方持有的 GitHub token。 */
  githubToken?: string;
}

/** 校验并返回目标 URL；不合法返回 null。 */
function resolveRawTarget(rawUrl: unknown): URL | null {
  if (typeof rawUrl !== 'string' || !rawUrl) return null;
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  // 内嵌凭证会被原样带进上游请求，且可能泄露到日志。
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol !== 'https:') return null;
  if (!ALLOWED_RAW_HOSTS.has(parsed.hostname.toLowerCase())) return null;
  return parsed;
}

/** 过滤转发给上游的头：剔除携带凭证与连接控制类。 */
function sanitizeForwardHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  if (!headers) return safe;
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower === 'host' ||
      lower === 'content-length'
    ) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

export default async function handler(
  req: IncomingMessage & { body?: unknown },
  res: ServerResponse
): Promise<void> {
  if (!guardSameOrigin(req, res)) return;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const body = await readJsonBody<RawProxyBody>(req);
  const headerToken = req.headers['x-github-token'];
  const token =
    typeof headerToken === 'string' && headerToken.trim()
      ? headerToken.trim()
      : typeof body?.githubToken === 'string'
        ? body.githubToken.trim()
        : '';

  if (!token) {
    sendError(res, 400, 'GitHub token not provided by client', 'GITHUB_TOKEN_NOT_CONFIGURED');
    return;
  }

  const target = resolveRawTarget(body?.url);
  if (!target) {
    sendError(res, 400, 'url must point to an allowed GitHub raw host', 'HOST_NOT_ALLOWED');
    return;
  }

  try {
    const upstream = await fetch(target.toString(), {
      method: (body?.method || 'GET').toUpperCase(),
      headers: {
        ...sanitizeForwardHeaders(body?.headers),
        Authorization: `Bearer ${token}`,
        'User-Agent': BROWSER_UA,
        Accept: 'application/vnd.github.v3+json',
      },
      redirect: 'error',
      signal: AbortSignal.timeout(RAW_TIMEOUT_MS),
    });

    const text = await upstream.text();
    // raw 内容是纯文本，前端按 response.text() 消费，不能用 JSON 包裹。
    res.statusCode = upstream.status;
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'text/plain; charset=utf-8'
    );
    res.end(text);
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      sendError(res, 504, 'Upstream timeout', 'GATEWAY_TIMEOUT');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 502, `GitHub raw proxy failed: ${message}`, 'GITHUB_RAW_PROXY_FAILED');
  }
}
