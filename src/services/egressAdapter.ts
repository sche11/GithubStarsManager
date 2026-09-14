/**
 * Egress 适配层：区分「出网请求」与「数据请求」的目标后端。
 *
 * 本应用在两个平台上各承担一部分职责：
 * - **Vercel**：静态前端 + `api/` 下的出网 Function。承担必需访问境外的请求族
 *   —— GitHub、Telegram、X、AI Provider。
 * - **魔搭创空间**：Docker 容器 + SQLite 持久化。承担数据面 —— 仓库/Release/
 *   配置的 CRUD、同步导入导出、MCP、WebDAV。
 *
 * 之所以必须在客户端区分：Vercel Function 无状态且无文件系统，无法承载
 * `better-sqlite3`；而魔搭（阿里云华北 2）出口到 GitHub / t.me / x.com 的
 * 可达性不稳定。两者能力互补，缺一不可。
 *
 * 默认约定：egress 与静态前端**同源**（都在 Vercel），因此默认值取
 * `window.location.origin + '/api'`，开箱即用、无需用户配置；数据后端则由
 * 「设置 → 后端服务器」中的地址决定（即 backendAdapter 的 backendUrl）。
 */

/** 覆盖 egress 地址的存储键。仅在同源约定不成立时才需要（如前端独立部署）。 */
const EGRESS_URL_STORAGE_KEY = 'github-stars-manager-egress-url';

/**
 * 规范化 egress 基址：去掉尾斜杠并补 `/api` 后缀。
 * 与 utils/backendUrl.ts 的 normalizeBackendUrl 保持同一约定（返回带 /api 的基址）。
 */
function normalizeEgressUrl(value: string): string | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // 远程必须 HTTPS，否则出网请求携带的用户凭证（GitHub token / AI Key /
    // X Cookie）会以明文传输（CWE-319）；回环地址豁免以便本地开发。
    const hostname = url.hostname;
    const isLoopback =
      hostname === 'localhost' ||
      hostname.endsWith('.localhost') ||
      hostname === '127.0.0.1' ||
      hostname === '[::1]' ||
      hostname === '::1';
    if (url.protocol === 'http:' && !isLoopback) return null;

    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    const normalized = url.toString().replace(/\/$/, '');
    return normalized.endsWith('/api') ? normalized : `${normalized}/api`;
  } catch {
    return null;
  }
}

/** 读取用户配置的 egress 覆盖地址；未配置或非法时返回 null。 */
function readStoredEgressUrl(): string | null {
  try {
    const stored = localStorage.getItem(EGRESS_URL_STORAGE_KEY);
    if (!stored) return null;
    return normalizeEgressUrl(stored);
  } catch {
    return null;
  }
}

/**
 * 解析当前生效的 egress 基址（带 `/api` 后缀）。
 *
 * 优先级：用户配置的覆盖地址 > 前端同源地址。
 * 前端部署在 Vercel 时，同源地址即为该项目的 `/api`，因此默认无需任何配置。
 * Electron（file:// 协议）下无同源可用，此函数返回 null，调用方应回退
 * 浏览器直连或 Electron 主进程 IPC。
 */
export function getEgressBaseUrl(): string | null {
  const configured = readStoredEgressUrl();
  if (configured) return configured;

  if (typeof window === 'undefined') return null;
  // file:// 等非 HTTP(S) 协议没有可用的同源 /api。
  if (window.location.protocol !== 'http:' && window.location.protocol !== 'https:') {
    return null;
  }
  return `${window.location.origin}/api`;
}

/**
 * 持久化 egress 覆盖地址。传空字符串清除覆盖，回到同源默认。
 * @returns 是否写入成功（地址非法或存储受限时返回 false）
 */
export function setEgressBaseUrl(value: string): boolean {
  try {
    if (!value.trim()) {
      localStorage.removeItem(EGRESS_URL_STORAGE_KEY);
      return true;
    }
    const normalized = normalizeEgressUrl(value);
    if (!normalized) return false;
    localStorage.setItem(EGRESS_URL_STORAGE_KEY, normalized);
    return true;
  } catch {
    return false;
  }
}

/**
 * egress 请求的公共头。
 *
 * 与数据后端的头**刻意区分**：数据后端（魔搭）因平台占用 `Authorization`
 * 而使用 `X-GSM-Secret`，且需要携带 API_SECRET；egress 层（Vercel）直接用
 * 标准 `Authorization`，且**不携带数据后端的密钥**——避免把魔搭的 API_SECRET
 * 泄露给 Vercel 侧日志。
 */
export function getEgressHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json' };
}

/**
 * egress 层是否可用。
 *
 * 探测同源 `/egress-health`（区别于数据后端的 `/health`，避免误判）。
 * 纯静态部署（如只部署 dist、未部署 api/）会返回 false，调用方据此回退
 * 浏览器直连。
 */
export async function isEgressAvailable(): Promise<boolean> {
  const baseUrl = getEgressBaseUrl();
  if (!baseUrl) return false;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 3000);
    try {
      const response = await fetch(`${baseUrl}/egress-health`, {
        signal: controller.signal,
        redirect: 'error',
      });
      if (!response.ok) return false;
      const data = (await response.json()) as { role?: string };
      // role 字段确认这是 egress 层而非数据后端（两者都返回 status:'ok'）。
      return data.role === 'egress';
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    return false;
  }
}
