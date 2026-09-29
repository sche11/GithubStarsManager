import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

let warnedOnce = false;

/**
 * 从请求中提取调用方提供的 API_SECRET。
 *
 * 头的选择受魔搭创空间网关的双重约束（2026-09 实测，Playwright 真实浏览器验证）：
 *
 * | 头                  | 网关 CORS 白名单 | 容器能否收到 | 可用 |
 * |---------------------|------------------|--------------|------|
 * | X-Mx-ReqToken       | 是               | 是           | 是   |
 * | X-GSM-Secret        | 否               | 是           | 否（预检被拦） |
 * | X-Studio-Token      | 是               | 否（平台消费）| 否   |
 * | Authorization       | 是               | 否（平台覆盖）| 否   |
 *
 * 只有 `X-Mx-ReqToken` 同时满足两个条件 —— 它是阿里遗留头，无标准语义，
 * 网关既放行预检也不消费其值。
 *
 * 优先级：X-Mx-ReqToken（魔搭）→ X-GSM-Secret（自托管备选）→ Authorization。
 * 后两者保留是为了兼容非魔搭环境（Electron / 自托管 Docker / Vercel）。
 */
function extractApiSecret(req: Request): string | null {
  const candidates: Array<string | string[] | undefined> = [
    req.headers['x-mx-reqtoken'],
    req.headers['x-gsm-secret'],
  ];

  for (const raw of candidates) {
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  const authHeader = req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }

  return null;
}

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check
  if (req.method === 'GET' && req.path === '/health') {
    next();
    return;
  }

  // Dev mode: no API_SECRET set
  if (!config.apiSecret) {
    if (!warnedOnce) {
      console.warn('⚠️  API_SECRET not set — auth disabled (dev mode)');
      warnedOnce = true;
    }
    next();
    return;
  }

  const token = extractApiSecret(req);
  if (token === null) {
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  // Constant-time comparison
  // 使用固定时间的比较来防止时序攻击
  const tokenBuf = Buffer.from(token);
  const secretBuf = Buffer.from(config.apiSecret);

  if (tokenBuf.length !== secretBuf.length || !crypto.timingSafeEqual(tokenBuf, secretBuf)) {
    res.status(401).json({ error: 'Unauthorized', code: 'UNAUTHORIZED' });
    return;
  }

  next();
}
