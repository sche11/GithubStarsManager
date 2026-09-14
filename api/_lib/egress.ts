/**
 * Egress 层公共工具。
 *
 * 本目录下的 Function 全部部署在 Vercel，只承担「需要访问境外目标」的请求：
 * GitHub API / GitHub raw / AI Provider / Telegram / X。
 * 数据面（SQLite CRUD、MCP、WebDAV）留在魔搭创空间容器，不在此目录。
 *
 * 与 server/src 的根本差异：Vercel Function 无状态、无文件系统、无数据库。
 * 因此所有凭证（GitHub token、AI apiKey）必须由前端随请求携带，不再从 SQLite
 * 读取解密；也不再读取 proxy_config（Vercel 出口本身可达目标）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';

/** 出网请求默认超时（毫秒）。Hobby 单次调用上限 300s。 */
export const DEFAULT_EGRESS_TIMEOUT_MS = 30_000;

/** 伪装成常见桌面浏览器，用于抓取对 UA 敏感的站点（t.me / x.com）。 */
export const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Vercel 注入的环境标识；非 production 时跳过来源校验便于本地调试。 */
const isProduction = process.env.VERCEL_ENV === 'production';

/** 统一的错误信封，与 server/src 的 {"error","code"} 约定保持一致。 */
export interface EgressErrorBody {
  error: string;
  code: string;
  /** 透传上游真实状态码，供前端区分「本服务错误」与「上游错误」。 */
  upstreamStatus?: number;
}

/** 从 Origin 或 Referer 头解析出主机名；缺失或非法返回 null。 */
function headerHost(value: string | string[] | undefined): string | null {
  if (typeof value !== 'string' || !value) return null;
  try {
    return new URL(value).host;
  } catch {
    return null;
  }
}

/**
 * 拒绝跨站调用。
 *
 * 本层是无状态公网端点，若不设防可被任意站点当作免费代理使用（虽已按主机名
 * 白名单限制目标，仍会消耗带宽与函数配额）。校验方式：浏览器发出的 Origin
 * （跨站请求）或 Referer（同站请求）必须与本次请求的 Host 一致。
 *
 * 局限：直接 curl 可伪造这两个头，因此这是「防滥用」而非「身份认证」。
 * 本层不暴露任何服务端凭证（调用方必须自带 token/Cookie），故该强度足够。
 * 严格模式仅在 production 生效，`vercel dev` 与 curl 调试不受影响。
 *
 * @returns 通过返回 true；否则已写出 403 响应并返回 false。
 */
export function guardSameOrigin(req: IncomingMessage, res: ServerResponse): boolean {
  if (!isProduction) return true;

  const origin = headerHost(req.headers.origin);
  const referer = headerHost(req.headers.referer);
  const source = origin ?? referer;

  // 两者皆缺失：非浏览器发起（脚本/爬虫）。放行以兼容服务端调用场景，
  // 目标主机白名单仍限制其可达范围。
  if (source === null) return true;

  if (source !== req.headers.host) {
    sendError(res, 403, 'Cross-origin egress calls are not allowed', 'EGRESS_CROSS_ORIGIN');
    return false;
  }
  return true;
}

/** 写入 JSON 响应。 */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

/** 写入统一的错误响应。 */
export function sendError(
  res: ServerResponse,
  status: number,
  error: string,
  code: string,
  upstreamStatus?: number
): void {
  const body: EgressErrorBody = { error, code };
  if (upstreamStatus !== undefined) body.upstreamStatus = upstreamStatus;
  sendJson(res, status, body);
}

/**
 * 读取并解析 JSON 请求体。
 *
 * Vercel 的 Node runtime 在识别为 JSON 时会把结果挂在 req.body 上；为空则
 * 回退到手工读取流，保证两条路径都能拿到数据。
 */
export async function readJsonBody<T>(req: IncomingMessage & { body?: unknown }): Promise<T | null> {
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === 'string') {
      try {
        return JSON.parse(req.body) as T;
      } catch {
        return null;
      }
    }
    if (typeof req.body === 'object') {
      return req.body as T;
    }
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  if (chunks.length === 0) return null;

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T;
  } catch {
    return null;
  }
}

/** 云元数据服务地址；无论何种模式都必须拦截（凭据窃取的最高危目标）。 */
const IMDS_HOST = '169.254.169.254';
/** 回环与通配地址。 */
const BLOCKED_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', IMDS_HOST]);
/** 私有网段（RFC1918）。 */
const PRIVATE_IPV4 = [/^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./];

/** 归一化 hostname：去掉 IPv6 方括号与结尾点号，小写化，还原 IPv4 映射型 IPv6。 */
function normalizeHostname(hostname: string): string {
  const h = hostname.replace(/\.$/, '').replace(/^\[(.+)\]$/, '$1').toLowerCase();
  if (h.startsWith('::ffff:') && h.includes('.')) return h.slice(7);
  const mapped = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mapped) {
    return [mapped[1], mapped[2]]
      .flatMap((hex) => {
        const v = parseInt(hex, 16);
        return [(v >>> 8) & 0xff, v & 0xff];
      })
      .join('.');
  }
  return h;
}

/** IPv6 私有/本地网段：唯一本地 fc00::/7、链路本地 fe80::/10、组播 ff00::/8。 */
function isPrivateIPv6(h: string): boolean {
  if (!h.includes(':')) return false;
  return (
    h.startsWith('fc') || h.startsWith('fd') ||
    h.startsWith('fe8') || h.startsWith('fe9') ||
    h.startsWith('fea') || h.startsWith('feb') ||
    h.startsWith('ff')
  );
}

/**
 * 校验调用方传入的目标 URL 指向公网。
 *
 * 本层唯一「调用方可控的目标地址」是 AI 代理的 baseUrl。Vercel Function 能访问
 * 云元数据服务与内网，若不加限制则可被用作 SSRF 跳板（CWE-918）。
 * 因此一律拒绝回环、私有网段与 IMDS 地址。
 *
 * 已知局限：仅做主机名字符串判定，无法防御 DNS rebinding（解析后才知真实 IP）。
 * 与 server/src/services/proxyService.ts 的严格模式同等强度。
 *
 * @throws 目标不合法时抛出，调用方应转为 400 响应。
 */
export function assertPublicHttpUrl(rawUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${rawUrl}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol '${parsed.protocol}'`);
  }
  if (parsed.username || parsed.password) {
    throw new Error('URL containing embedded credentials is not allowed');
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (BLOCKED_HOSTS.has(hostname)) {
    throw new Error(`Host '${hostname}' is not allowed`);
  }
  if (PRIVATE_IPV4.some((p) => p.test(hostname))) {
    throw new Error(`Private IP '${hostname}' is not allowed`);
  }
  if (isPrivateIPv6(hostname)) {
    throw new Error(`Private IPv6 address '${hostname}' is not allowed`);
  }
}

/** 出网抓取的可选参数。 */
export interface EgressFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | object;
  timeoutMs?: number;
  /** 'follow'（默认）或 'error'。携带 Cookie 的请求必须用 'error'。 */
  redirect?: 'follow' | 'error' | 'manual';
}

/** 出网抓取结果。 */
export interface EgressFetchResult {
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  text: string;
}

/**
 * 执行一次出网请求并读取文本响应。
 *
 * 与 server/src/services/proxyService.ts 的 proxyRequest 的差异：
 * - 不做 SSRF 黑名单校验：目标 URL 全部由各 Function 内部白名单拼装，
 *   不接受调用方传入任意地址（xtweet/graphql 的 url 已由调用侧白名单校验）。
 * - 不读 proxy_config：Vercel 出口本身可达目标，无需二级代理。
 */
export async function egressFetch(
  url: string,
  options: EgressFetchOptions = {}
): Promise<EgressFetchResult> {
  const {
    method = 'GET',
    headers = {},
    body,
    timeoutMs = DEFAULT_EGRESS_TIMEOUT_MS,
    redirect = 'follow',
  } = options;

  const init: RequestInit = {
    method,
    headers,
    redirect,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body !== undefined && method !== 'GET' && method !== 'HEAD') {
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const response = await fetch(url, init);
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    ok: response.ok,
    status: response.status,
    headers: responseHeaders,
    text: await response.text(),
  };
}
