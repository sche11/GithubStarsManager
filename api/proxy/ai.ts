/**
 * AI Provider 出网代理。
 *
 * 改造自 server/src/routes/proxy.ts 的 `POST /api/proxy/ai`。部署在 Vercel 的理由：
 * 用户使用的 AI Provider（OpenAI / Claude / Gemini 官方端点）在魔搭（阿里云华北 2）
 * 出口不可达。
 *
 * 与原实现的关键差异：
 * - **凭证来源**：原实现支持 `{ configId }` 从 SQLite 读配置并解密 apiKey；
 *   Vercel 无数据库，**只保留内联 config 路径**（`{ config: { apiKey, ... } }`）。
 *   前端调用 `configId` 形式时会收到 404 + code=AI_CONFIG_NOT_FOUND，其既有的
 *   fallback 链会自动改用内联 config 重试，无需改变调用方逻辑。
 * - **无 proxy_config**：Vercel 出口直达 Provider。
 * - **超时上限**：原实现 600s（推理模型）；Vercel Hobby 上限 300s。已在
 *   vercel.json 设 maxDuration=300，长推理响应可能被截断（见方案文档风险表）。
 *
 * 安全边界：baseUrl 由调用方提供（用户自己的 AI 服务地址），因此必须做 SSRF
 * 校验。与原实现不同，这里**不做** `allowPrivate` 宽松档——回环与私有网段在
 * Vercel 上只会指向平台内网，没有合法的用户场景。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  assertPublicHttpUrl,
  guardSameOrigin,
  readJsonBody,
  sendError,
} from '../_lib/egress';

/** 推理模型（openai-responses 或带 reasoning）需要更长超时。 */
const AI_TIMEOUT_MS = 290_000;
/** 普通对话请求超时。 */
const AI_TIMEOUT_DEFAULT_MS = 60_000;

/** 仅透传上游限流相关响应头，供前端限流器读取重试时机。 */
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
  'ratelimit-remaining',
  'ratelimit-reset',
  'ratelimit-limit',
  'tencent-ratelimit-requests-remaining',
  'tencent-ratelimit-requests-reset',
  'tencent-ratelimit-input-tokens-remaining',
  'tencent-ratelimit-input-tokens-reset',
  'tencent-ratelimit-output-tokens-remaining',
  'tencent-ratelimit-output-tokens-reset',
  'x-should-retry',
];

/** 请求体形状，字段名沿用原 Express 版。 */
interface AiProxyBody {
  /** 原实现的 DB 配置 ID；本 Function 不支持，收到时返回 404 触发前端 fallback。 */
  configId?: string;
  /** 内联配置（本 Function 唯一支持的路径）。 */
  config?: {
    apiType?: string;
    baseUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort?: string;
  };
  /** 转发给 Provider 的原始请求体。 */
  body: Record<string, unknown>;
}

/**
 * 拼装 Provider 端点 URL。
 *
 * 与原 server/src/routes/proxy.ts 的 buildApiUrl 逐字一致：处理 baseUrl 已含
 * 版本号（/v1、/v3、/v1beta 等）的情况，避免重复拼接。
 * 之所以在 Vercel 侧内联这份实现，是因为 api/ 目录不能跨包引用 server/src。
 */
function buildApiUrl(baseUrl: string, pathWithVersion: string): string {
  const baseUrlWithSlash = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const versionPrefix = pathWithVersion.split('/')[0] || '';

  try {
    const base = new URL(baseUrlWithSlash);
    const basePath = base.pathname.replace(/\/$/, '');

    // 检测 baseUrl 是否已经以任何版本号结尾（v1, v2, v3, v1beta, v1alpha 等），
    // 兼容火山引擎（/v3）、OpenAI（/v1）、Gemini（/v1beta）等不同版本号写法。
    const anyVersionPattern = /\/v\d+(?:beta|alpha)?$/;
    if (anyVersionPattern.test(basePath)) {
      const endpointPath = pathWithVersion.includes('/')
        ? pathWithVersion.split('/').slice(1).join('/')
        : pathWithVersion;
      return new URL(endpointPath, baseUrlWithSlash).toString();
    }

    if (versionPrefix) {
      const versionRe = new RegExp(`/${versionPrefix}$`);
      if (versionRe.test(basePath) && pathWithVersion.startsWith(`${versionPrefix}/`)) {
        const rest = pathWithVersion.slice(versionPrefix.length + 1);
        return new URL(rest, baseUrlWithSlash).toString();
      }
    }

    return new URL(pathWithVersion, baseUrlWithSlash).toString();
  } catch {
    return `${baseUrlWithSlash}${pathWithVersion}`;
  }
}

/** 归一化 reasoning effort：minimal 降级为 low（与原实现一致）。 */
function normalizeReasoningEffort(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value === 'minimal' ? 'low' : value;
}

/** 按 apiType 解析上游 URL 与鉴权头。 */
function resolveUpstream(
  apiType: string,
  baseUrl: string,
  apiKey: string,
  model: string
): { targetUrl: string; headers: Record<string, string> } {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
  };

  if (
    apiType === 'openai' ||
    apiType === 'openai-responses' ||
    apiType === 'openai-compatible' ||
    apiType === 'deepseek' ||
    apiType === 'mimo'
  ) {
    // openai-compatible 类型直接把 baseUrl 作为完整地址
    const targetUrl =
      apiType === 'openai-compatible'
        ? baseUrl.replace(/\/$/, '')
        : buildApiUrl(baseUrl, apiType === 'openai-responses' ? 'v1/responses' : 'v1/chat/completions');
    headers.Authorization = `Bearer ${apiKey}`;
    return { targetUrl, headers };
  }

  if (apiType === 'claude') {
    headers['x-api-key'] = apiKey;
    headers['Tencent-version'] = '2023-06-01';
    return { targetUrl: buildApiUrl(baseUrl, 'v1/messages'), headers };
  }

  // gemini：key 走查询参数，model 名去前缀
  const rawModel = model.trim();
  const modelName = rawModel.startsWith('models/') ? rawModel.slice('models/'.length) : rawModel;
  const path = `v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
  const urlObj = new URL(buildApiUrl(baseUrl, path));
  urlObj.searchParams.set('key', apiKey);
  return { targetUrl: urlObj.toString(), headers };
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

  const payload = await readJsonBody<AiProxyBody>(req);
  if (!payload) {
    sendError(res, 400, 'Invalid JSON body', 'INVALID_REQUEST');
    return;
  }

  const { configId, config: inlineConfig, body: requestBody } = payload;

  // 本 Function 无数据库访问能力，configId 路径不可用。
  // 返回 404 + 该 code 可让前端既有的 fallback 链自动改用内联 config 重试
  // （见 src/services/backendAdapter.ts 的 proxyAIRequestWithFallback）。
  if (configId && !inlineConfig) {
    sendError(
      res,
      404,
      'configId lookup is not available on the egress function; send inline config',
      'AI_CONFIG_NOT_FOUND'
    );
    return;
  }

  if (!inlineConfig) {
    sendError(res, 400, 'config required', 'CONFIG_ID_REQUIRED');
    return;
  }

  const apiKey = typeof inlineConfig.apiKey === 'string' ? inlineConfig.apiKey : '';
  const baseUrl = typeof inlineConfig.baseUrl === 'string' ? inlineConfig.baseUrl : '';
  const model = typeof inlineConfig.model === 'string' ? inlineConfig.model : '';
  const apiType = inlineConfig.apiType || 'openai';

  if (!baseUrl || !apiKey || !model) {
    sendError(res, 400, 'baseUrl, apiKey, and model are required', 'INVALID_REQUEST');
    return;
  }
  if (!requestBody || typeof requestBody !== 'object') {
    sendError(res, 400, 'body is required', 'INVALID_REQUEST');
    return;
  }

  // SSRF 防护：baseUrl 由调用方提供，必须指向公网。
  try {
    assertPublicHttpUrl(baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'invalid baseUrl';
    sendError(res, 400, message, 'INVALID_BASE_URL');
    return;
  }

  const { targetUrl, headers } = resolveUpstream(apiType, baseUrl, apiKey, model);
  const reasoningEffort = normalizeReasoningEffort(inlineConfig.reasoningEffort);

  // DeepSeek Reasoner 不支持 reasoning 参数；已带 reasoning 时保持原样。
  const isDeepSeekReasoner = model.trim() === 'deepseek-reasoner';
  const supportsReasoning =
    apiType === 'openai' ||
    apiType === 'openai-responses' ||
    apiType === 'openai-compatible' ||
    apiType === 'deepseek' ||
    apiType === 'mimo';
  const effectiveRequestBody =
    reasoningEffort && !isDeepSeekReasoner && supportsReasoning && !('reasoning' in requestBody)
      ? { ...requestBody, reasoning: { effort: reasoningEffort } }
      : requestBody;

  const timeoutMs =
    apiType === 'openai-responses' || reasoningEffort ? AI_TIMEOUT_MS : AI_TIMEOUT_DEFAULT_MS;

  try {
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(effectiveRequestBody),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

    for (const key of RATE_LIMIT_HEADERS) {
      const value = upstream.headers.get(key);
      if (value) res.setHeader(key, value);
    }

    const text = await upstream.text();
    res.statusCode = upstream.status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(text);
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
      sendError(res, 504, 'AI upstream timeout', 'GATEWAY_TIMEOUT');
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    sendError(res, 502, `AI proxy failed: ${message}`, 'AI_PROXY_FAILED');
  }
}
