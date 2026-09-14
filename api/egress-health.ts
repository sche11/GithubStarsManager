/**
 * Egress 层健康探针。
 *
 * 前端用它判定「本部署是否包含 egress Functions」：
 * - 是 → GitHub / Telegram / X / AI 请求走同源 Function（出口可达）；
 * - 否（纯静态部署）→ 回退浏览器直连。
 *
 * 刻意不复用 `/api/health` 路径：数据后端的健康检查（server/src/routes/health.ts）
 * 返回 `{status:'ok'}`，前端 backendAdapter.init() 即以该字段判定数据后端可用。
 * 若此处也返回 `status:'ok'` 且路径相同，会让前端误以为 Vercel 就是数据后端。
 * 因此本端点使用独立路径与独立字段 `role`。
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendJson } from './_lib/egress.js';

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  sendJson(res, 200, {
    status: 'ok',
    /** 区分标识：前端据此确认这是 egress 层而非数据后端。 */
    role: 'egress',
    timestamp: new Date().toISOString(),
  });
}
