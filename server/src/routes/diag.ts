import { Router } from 'express';
import { config } from '../config.js';
import { logger } from '../services/logger.js';

const router = Router();

/**
 * 临时诊断端点：输出服务端视角的鉴权相关状态。
 *
 * 存在原因：在魔搭创空间上 X-GSM-Secret 返回 401，而无法从外部判断是
 * 「平台丢弃/改写了该头」还是「服务端未正确注入 API_SECRET」。本端点
 * 直接回显收到的头名与其长度（不回显值），用于二者区分。
 *
 * 安全性：只返回头是否存在及其长度，不返回值；且不暴露 API_SECRET 本身
 * （仅返回其长度）。定位完成后应删除本文件及 index.ts 的挂载。
 */
router.get('/api/_diag/auth', (req, res) => {
  const headerNames = Object.keys(req.headers).sort();
  const secret = typeof req.headers['x-gsm-secret'] === 'string' ? req.headers['x-gsm-secret'] : null;
  const authz = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;

  res.json({
    // 服务端是否已注入 API_SECRET（只报长度，不报值）
    apiSecretConfigured: Boolean(config.apiSecret),
    apiSecretLength: config.apiSecret ? config.apiSecret.length : 0,
    // 调用方发送的头
    receivedXGsmSecret: secret !== null,
    receivedXGsmSecretLength: secret ? secret.length : 0,
    receivedAuthorization: authz !== null,
    receivedAuthorizationLength: authz ? authz.length : 0,
    // 本次请求实际可见的全部头名（判断平台是否透传自定义头）
    headerNames,
  });
});

export default router;
