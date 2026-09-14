/**
 * Telegram 频道抓取代理。
 *
 * 改造自 server/src/routes/telegram.ts。部署在 Vercel 的理由有两条：
 * 1. 魔搭（阿里云华北 2）出口到 t.me 的可达性不稳定；
 * 2. 原实现使用裸 `fetch()`，**不读取用户的 proxy_config**，因此在魔搭容器内
 *    即使配置了代理也无法出网。
 *
 * 与 Express 版的差异仅限于适配层：
 * - 路径参数从 `req.params.channel` 改为 Vercel 注入的 `req.query.channel`。
 * - 鉴权从挂载在 /api 下的中间件改为本文件内显式校验──Vercel 侧用标准
 *   Authorization 头（无平台注入问题，与魔搭的 X-GSM-Secret 相互独立）。
 * - logger 换为 console.warn（Vercel 日志）。
 *
 * 安全边界逐字保留：频道名严格白名单、翻页游标纯数字、目标 URL 由本文件
 * 拼装（不透传任意 URL）。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { BROWSER_UA, guardSameOrigin, sendError, sendJson } from '../../_lib/egress';

/** 频道名白名单：与原 Express 实现逐字一致。 */
const TG_CHANNEL_PATTERN = /^[A-Za-z0-9_]{3,64}$/;
/** 翻页游标（消息 ID）必须为纯数字，防止注入到 URL。 */
const BEFORE_PATTERN = /^\d{1,20}$/;
const FETCH_TIMEOUT_MS = 20_000;

/** 从 Vercel 注入的 query 中取单值字符串。 */
function singleQuery(value: string | string[] | undefined): string {
  if (Array.isArray(value)) return value[0] ?? '';
  return typeof value === 'string' ? value : '';
}

export default async function handler(
  req: IncomingMessage & { query?: Record<string, string | string[]> },
  res: ServerResponse
): Promise<void> {
  if (!guardSameOrigin(req, res)) return;

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.end();
    return;
  }

  const channel = singleQuery(req.query?.channel);
  if (!TG_CHANNEL_PATTERN.test(channel)) {
    sendError(res, 400, 'invalid channel', 'INVALID_CHANNEL');
    return;
  }

  const before = singleQuery(req.query?.before);
  if (before && !BEFORE_PATTERN.test(before)) {
    sendError(res, 400, 'invalid before cursor', 'INVALID_BEFORE');
    return;
  }

  try {
    const url = before
      ? `https://t.me/s/${channel}?before=${before}`
      : `https://t.me/s/${channel}`;

    const response = await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        Accept: 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!response.ok) {
      console.warn(`[telegram] t.me responded ${response.status} for @${channel}`);
      sendError(res, 502, `t.me responded ${response.status}`, 'UPSTREAM_ERROR', response.status);
      return;
    }

    sendJson(res, 200, { html: await response.text() });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'fetch failed';
    console.warn(`[telegram] fetch failed for @${channel}: ${message}`);
    sendError(res, 502, message, 'UPSTREAM_ERROR');
  }
}
