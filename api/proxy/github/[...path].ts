/**
 * GitHub REST API 出网代理。
 *
 * 改造自 server/src/routes/proxy.ts 的 github / search 路由。部署在 Vercel 的
 * 理由：GitHub 在魔搭（阿里云华北 2）出口的可达性不稳定。
 *
 * 路径映射：
 * - `/api/proxy/github/<任意路径>`         → 通用 REST 代理
 * - `/api/proxy/github/search/repositories` → 仓库搜索
 * - `/api/proxy/github/search/users`        → 用户搜索
 *
 * （`/api/proxy/github-raw` 由独立 Function 处理，不在本 catch-all 范围内。）
 *
 * 与原实现的关键差异：
 * - **token 来源**：原实现从 SQLite 读 `settings.github_token` 并 AES 解密；
 *   Vercel 无数据库，改由调用方在请求体或 `X-GitHub-Token` 头携带。
 * - **无 proxy_config**：Vercel 出口直达 GitHub，不需要二级代理。
 *
 * 安全边界：上游 host 固定为 api.github.com，调用方只能提供路径与查询参数，
 * 无法把请求导向任意主机（因此无需 SSRF 黑名单）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BROWSER_UA,
  guardSameOrigin,
  readJsonBody,
  sendError,
} from '../../_lib/egress';

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
/** GitHub 请求超时：大仓库 tree 递归较慢，留足余量。 */
const GITHUB_TIMEOUT_MS = 60_000;
/** 允许的 search 子路径白名单。 */
const ALLOWED_SEARCH_PATHS = new Set(['repositories', 'users']);

/** 仅透传上游限流相关响应头，供前端统一识别配额与重试时机。 */
const RATE_LIMIT_HEADERS = [
  'retry-after',
  'retry-after-ms',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-limit',
  'x-ratelimit-remaining-requests',
  'x-ratelimit-reset-requests',
  'x-ratelimit-limit-requests',
  'x-ratelimit-remaining-tokens',
  'x-ratelimit-reset-tokens',
  'x-ratelimit-limit-tokens',
];

/** 请求体形状，字段命名沿用原 Express 版约定以免前端大改。 */
interface GitHubProxyBody {
  /** 上游 HTTP 方法，默认 GET。 */
  method?: string;
  /** 需转发给上游的头（仅 Accept 与 Content-Type 被采纳）。 */
  headers?: Record<string, string>;
  /** 上游请求体（字符串或对象）。 */
  body?: string | object;
  /** 调用方持有的 GitHub token（Vercel 侧无数据库，必须由前端传入）。 */
  githubToken?: string;
  /** search 端点的查询参数。 */
  query_params?: Record<string, string>;
}

/** 从请求头或请求体解析 GitHub token（头优先级更高）。 */
function resolveGithubToken(req: IncomingMessage, body: GitHubProxyBody | null): string {
  const header = req.headers['x-github-token'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const fromBody = body?.githubToken;
  return typeof fromBody === 'string' ? fromBody.trim() : '';
}

/** 从 headers 中取指定字段（大小写不敏感）。 */
function pickHeader(headers: Record<string, string> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) return value;
  }
  return undefined;
}

/** 把上游限流响应头写入本次响应。 */
function relayRateLimitHeaders(res: ServerResponse, headers: Headers): void {
  for (const key of RATE_LIMIT_HEADERS) {
    const value = headers.get(key);
    if (value) res.setHeader(key, value);
  }
}

/** 从 Vercel 注入的 query 中提取 catch-all 路径段。 */
function extractPathSegments(rawPath: unknown): string[] {
  if (Array.isArray(rawPath)) return rawPath.map(String);
  if (typeof rawPath === 'string' && rawPath) return rawPath.split('/').filter(Boolean);
  return [];
}

/** 组装发给 GitHub 的请求头。 */
function buildUpstreamHeaders(
  token: string,
  body: GitHubProxyBody | null
): Record<string, string> {
  const accept = pickHeader(body?.headers, 'accept') || 'application/vnd.github.v3+json';
  const contentType = pickHeader(body?.headers, 'content-type');
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    'X-GitHub-Api-Version': GITHUB_API_VERSION,
    'User-Agent': BROWSER_UA,
  };
  if (contentType) headers['Content-Type'] = contentType;
  return headers;
}

/** 透传上游响应：二进制按字节，其余按文本。 */
async function relayResponse(
  res: ServerResponse,
  upstream: Response,
  isBinary: boolean
): Promise<void> {
  relayRateLimitHeaders(res, upstream.headers);
  res.statusCode = upstream.status;

  if (isBinary) {
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.setHeader(
      'Content-Type',
      upstream.headers.get('content-type') || 'application/octet-stream'
    );
    res.end(buffer);
    return;
  }

  const text = await upstream.text();
  res.setHeader(
    'Content-Type',
    upstream.headers.get('content-type') || 'application/json; charset=utf-8'
  );
  res.end(text);
}

/** 处理 search 端点：查询参数走请求体（与原 Express 版一致）。 */
async function handleSearch(
  res: ServerResponse,
  subPath: string,
  body: GitHubProxyBody | null,
  token: string
): Promise<void> {
  const params = new URLSearchParams();
  const incoming = body?.query_params;
  if (incoming && typeof incoming === 'object') {
    for (const [key, value] of Object.entries(incoming)) {
      if (typeof value === 'string') params.set(key, value);
    }
  }
  const query = params.toString() ? `?${params.toString()}` : '';

  const upstream = await fetch(`${GITHUB_API_BASE}/search/${subPath}${query}`, {
    method: 'GET',
    headers: buildUpstreamHeaders(token, body),
    redirect: 'error',
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  });

  await relayResponse(res, upstream, false);
}

/** 处理通用 REST 路径。 */
async function handleApiPath(
  res: ServerResponse,
  apiPath: string,
  query: string,
  body: GitHubProxyBody | null,
  token: string
): Promise<void> {
  const method = (body?.method || 'GET').toUpperCase();
  const accept = pickHeader(body?.headers, 'accept') || 'application/vnd.github.v3+json';

  const init: RequestInit = {
    method,
    headers: buildUpstreamHeaders(token, body),
    redirect: 'error',
    signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
  };
  if (body?.body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body.body === 'string' ? body.body : JSON.stringify(body.body);
  }

  const upstream = await fetch(`${GITHUB_API_BASE}/${apiPath}${query}`, init);
  // releases 资产下载需二进制透传，其余为 JSON 文本。
  await relayResponse(res, upstream, accept === 'application/octet-stream');
}

/**
 * Function 入口。
 *
 * 注意：Vercel 的 catch-all `[...path]` 只匹配 `/api/proxy/github/` 下的子路径，
 * 因此 `/api/proxy/github-raw` 由独立 Function 处理（该路径不是本 catch-all 的子级）。
 */
export default async function handler(
  req: IncomingMessage & { body?: unknown; query?: Record<string, string | string[]> },
  res: ServerResponse
): Promise<void> {
  if (!guardSameOrigin(req, res)) return;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `https://${req.headers.host || 'localhost'}`);
  const query = url.search;
  const segments = extractPathSegments(req.query?.path);

  const body = await readJsonBody<GitHubProxyBody>(req);
  const token = resolveGithubToken(req, body);
  if (!token) {
    sendError(res, 400, 'GitHub token not provided by client', 'GITHUB_TOKEN_NOT_CONFIGURED');
    return;
  }

  try {
    if (segments[0] === 'search') {
      const subPath = segments.slice(1).join('/');
      if (!ALLOWED_SEARCH_PATHS.has(subPath)) {
        sendError(res, 404, `Unknown search endpoint '${subPath}'`, 'UNKNOWN_SEARCH_ENDPOINT');
        return;
      }
      await handleSearch(res, subPath, body, token);
      return;
    }

    const apiPath = segments.join('/');
    if (!apiPath) {
      sendError(res, 400, 'proxy path required', 'MISSING_PROXY_PATH');
      return;
    }

    await handleApiPath(res, apiPath, query, body, token);
  } catch (error) {
    // 超时与网络故障统一映射，与原 Express 版语义一致。
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      sendError(res, 504, 'Upstream timeout', 'GATEWAY_TIMEOUT');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 502, `GitHub proxy failed: ${message}`, 'GITHUB_PROXY_FAILED');
  }
}
