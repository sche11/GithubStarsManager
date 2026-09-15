import crypto from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import { config } from '../config.js';

let warnedOnce = false;

/**
 * 从请求中提取调用方提供的 API_SECRET。
 *
 * 优先读自定义头 `X-GSM-Secret`：魔搭创空间的反向代理会注入并覆盖
 * `Authorization`（平台官方声明该头由平台占用），因此托管在魔搭上时
 * 标准头不可用。保留 `Authorization` 作为回退，兼容自托管 / Electron /
 * Vercel 等无平台注入的环境。
 *
 * 不使用 `X-Modelscope-*` 或 `X-Studio-*` 命名，这两类前缀同样被平台占用。
 */
function extractApiSecret(req: Request): string | null {
  const custom = req.headers['x-gsm-secret'];
  if (typeof custom === 'string' && custom.trim()) {
    return custom.trim();
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
