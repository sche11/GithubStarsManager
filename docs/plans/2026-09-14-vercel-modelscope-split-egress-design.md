# GithubStarsManager 双平台分流出站改造方案

**版本**：v1（设计稿，未实施）
**日期**：2026-09-14
**状态**：待评审
**目标**：数据持久化迁至魔搭创空间（真容器 + 持久化卷），外网抓取保留在 Vercel（出口可达）

---

## 1. 结论摘要

### 为什么不能单纯把整个后端搬到魔搭

魔搭容器出口位于阿里云华北 2，访问 GitHub / Telegram / X 的可用性不稳定。而本项目**全部核心功能都依赖这三个域**（GitHub Stars 同步、Release 订阅、Telegram 频道、X 推文）。

### 为什么不能单纯留在 Vercel

Vercel 是无状态 Serverless：

- 文件系统只读，仅 `/tmp` 可写且冷启动清空 → SQLite 数据必丢
- 原生模块 `better-sqlite3` 在 Serverless 上不可靠
- 8 处 `db.transaction()` 是交互式事务，跨请求不成立

### 采用方案：按出网需求分流

```
                    ┌─────────────────────────────────────┐
   浏览器  ────────▶│  Vercel                             │
                    │  ├── 静态前端（同源，无 CORS）        │
                    │  └── Serverless Functions           │
                    │      /api/proxy/github/*   ────────▶│──▶ api.github.com
                    │      /api/proxy/github-raw ────────▶│──▶ raw.githubusercontent.com
                    │      /api/telegram/*       ────────▶│──▶ t.me
                    │      /api/xtweet/*         ────────▶│──▶ x.com
                    └─────────────────────────────────────┘
                                    │
                                    │ 仅数据 CRUD（跨域一次）
                                    ▼
                    ┌─────────────────────────────────────┐
                    │  魔搭创空间 Docker 容器 :7860        │
                    │  ├── Express API                    │
                    │  ├── better-sqlite3（原样，无需改）  │
                    │  ├── MCP SSE 长连接                 │
                    │  └── SQLite → /mnt/workspace（持久） │
                    └─────────────────────────────────────┘
```

**核心收益**：

| 项 | Vercel 单栈 | 本方案 |
|---|---|---|
| DB 层改造 | 8 处事务 + 13 文件改 async | **0**（`better-sqlite3` 原样） |
| 需引入 Turso | 是 | **否** |
| 数据丢失风险 | 高（无持久 FS） | 低（`/mnt/workspace` 卷） |
| MCP SSE | 不可用 | 可用 |
| 4.5MB 请求上限 | 会 413 | **无**（真容器） |
| 出口到 GitHub | 通 | Vercel 侧通 |
| 前端同源 | 是 | 静态部分同源，数据 API 跨域一次 |

---

## 2. 现状事实（代码证据）

### 2.1 后端仅 13 个文件访问数据库

全部经由单一收口点 [`getDb()`](file:///d:/SSDOWN/GithubStarsManager/server/src/db/connection.ts#L9)：

```
routes/         authRestore.ts  categories.ts  configs.ts  proxy.ts
                releases.ts     repositories.ts  sync.ts
mcp/            provider.ts     settings.ts
db/             connection.ts   migrations.ts  schema.ts
index.ts
```

绕开 `getDb()` 的模块**天然可以搬走**。

### 2.2 telegram.ts / xtweet.ts 是纯抓取代理，零 DB 依赖

| 文件 | 行数 | import | 出网 | DB |
|---|---|---|---|---|
| [telegram.ts](file:///d:/SSDOWN/GithubStarsManager/server/src/routes/telegram.ts) | 58 | `Router`, `logger` | `t.me/s/<channel>` | 无 |
| [xtweet.ts](file:///d:/SSDOWN/GithubStarsManager/server/src/routes/xtweet.ts) | 124 | `Router`, `logger` | `x.com`, `abs.twimg.com` | 无 |

两者均无 `getDb()` 调用，搬迁零依赖。

### 2.3 【关键】telegram / xtweet 不走用户配置的代理

全仓库 `SocksProxyAgent` 仅出现 1 次，在 [`proxyService.ts:150`](file:///d:/SSDOWN/GithubStarsManager/server/src/services/proxyService.ts#L150)。

对照两条路径的出网方式：

| 路由 | 出网实现 | 是否读 `proxy_config` |
|---|---|---|
| `/api/proxy/github/*` | `proxyRequest()` → axios + agent | **是** |
| `/api/proxy/github-raw` | `proxyRequest()` | **是** |
| `/api/proxy/ai` | `proxyRequest()` | **是** |
| `/api/proxy/webdav` | `proxyRequest()` | **是** |
| `/api/telegram/channel/*` | **裸 `fetch()`** | **否** |
| `/api/xtweet/profile/*` | **裸 `fetch()`** | **否** |
| `/api/xtweet/graphql` | **裸 `fetch()`** | **否** |

**推论**：即使把整个后端放上魔搭并在设置里配好代理，Telegram 与 X 依然无法出网。它们**必须**迁往出口可达的环境。

### 2.4 前端只有一个后端 URL

| 位置 | 存储键 / 字段 | 用途 |
|---|---|---|
| [backendAdapter.ts:19](file:///d:/SSDOWN/GithubStarsManager/src/services/backendAdapter.ts#L19) | `github-stars-manager-backend-url` | 数据 CRUD + 健康探测 |
| [githubApiFactory.ts:20-23](file:///d:/SSDOWN/GithubStarsManager/src/services/githubApiFactory.ts#L20-L23) | 复用上面的 URL | GitHub 代理 |
| [telegramService.ts:111](file:///d:/SSDOWN/GithubStarsManager/src/services/telegramService.ts#L111) | 复用上面的 URL | Telegram 抓取 |
| [xTweetService.ts:117](file:///d:/SSDOWN/GithubStarsManager/src/services/xTweetService.ts#L117) | 复用上面的 URL | X 抓取 |

**四族请求共用同一个 URL**。本方案必须把它拆成两个。

### 2.5 GitHub 代理依赖 DB 中的 token

[`proxy.ts:109`](file:///d:/SSDOWN/GithubStarsManager/server/src/routes/proxy.ts#L109) 从 SQLite 读取并解密 token：

```ts
const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('github_token')
token = decrypt(tokenRow.value, config.encryptionKey)
```

Vercel Function 无数据库访问能力 → **必须改为前端传 token**。这是本方案最核心的代码改动。

---

## 3. 请求分族详表

| 分族 | 路由 | 出网目标 | 读 DB | Vercel | 魔搭 |
|---|---|---|---|---|---|
| GitHub API | `/api/proxy/github/*` | api.github.com | 是（token） | ✅ | — |
| GitHub raw | `/api/proxy/github-raw` | raw.githubusercontent.com | 是（token） | ✅ | — |
| GitHub search repos | `/api/proxy/github/search/repositories` | api.github.com | 是（token） | ✅ | — |
| GitHub search users | `/api/proxy/github/search/users` | api.github.com | 是（token） | ✅ | — |
| Telegram 频道 | `/api/telegram/channel/:channel` | t.me | **否** | ✅ | — |
| X 主页 | `/api/xtweet/profile/:handle` | x.com | **否** | ✅ | — |
| X GraphQL | `/api/xtweet/graphql` | x.com, abs.twimg.com | **否** | ✅ | — |
| AI 代理 | `/api/proxy/ai` | AI Provider | 是（key） | ⚠️ 待定 | ⚠️ 待定 |
| WebDAV | `/api/proxy/webdav` | 用户自有地址 | 是 | — | ✅ |
| 代理设置读写 | `/api/settings/proxy` | 无 | 是 | — | ✅ |
| RPC 下载 | `/api/settings/rpc-download`, `/api/download/rpc` | 用户 aria2 | 是 | — | ✅ |
| 仓库 CRUD | `/api/repositories` | 无 | 是 | — | ✅ |
| Release CRUD | `/api/releases` | 无 | 是 | — | ✅ |
| 分类 | `/api/categories`, `/api/asset-filters` | 无 | 是 | — | ✅ |
| 配置 | `/api/configs/*` | 无 | 是 | — | ✅ |
| 设置 | `/api/settings` | 无 | 是 | — | ✅ |
| 导入导出 | `/api/sync/export`, `/api/sync/import` | 无 | 是 | — | ✅ |
| 认证恢复 | `/api/sync/auth` | 无 | 是 | — | ✅ |
| 日志 | `/api/logs` | 无 | 内存 | — | ✅ |
| 健康 | `/api/health` | 无 | **否** | — | ✅ |
| MCP | `/mcp`, `/mcp/sse`, `/messages` | 无 | 是 | — | ✅ |

### 3.1 AI 代理归属判定

取决于实际使用的 Provider：

| Provider | 魔搭出口可达 | 建议归属 |
|---|---|---|
| DeepSeek 官方 | ✅ | 魔搭 |
| 通义千问 / DashScope | ✅ | 魔搭 |
| 月之暗面 / 智谱 / 火山 | ✅ | 魔搭 |
| OpenAI 官方 | ❌ | Vercel |
| Anthropic 官方 | ❌ | Vercel |
| OpenRouter | ❌ | Vercel |
| 自建 / Ollama 本地 | 视地址 | 魔搭（若为内网需额外打通） |

**决策待补**：实际使用 ______________。

---

## 4. 目标架构设计

### 4.1 分工边界

```
Vercel 项目（一个项目，两部分）
├── 静态构建产物（Vite dist）           ← 浏览器加载，与下面同源
└── Serverless Functions（/api/*）
    ├── /api/proxy/github/*
    ├── /api/proxy/github-raw
    ├── /api/proxy/github/search/repositories
    ├── /api/proxy/github/search/users
    ├── /api/telegram/channel/:channel
    └── /api/xtweet/profile|graphql

魔搭创空间 Docker 容器（:7860）
├── Express API（减去上面搬走的 6 条路由）
├── better-sqlite3 → /mnt/workspace/data.db
└── MCP SSE / Streamable HTTP
```

### 4.2 为什么前端必须放在 Vercel（与 Function 同源）

若前端放魔搭、Function 放 Vercel，则：

1. 浏览器 → `*.ms.show`：**平台会注入并覆盖 `Authorization` 头**（魔搭官方明确占用该头），现有鉴权会全部 401
2. 浏览器 → `*.vercel.app`：跨域，需 Vercel 侧放行 Origin

前端放 Vercel 后：

- 前端 → Vercel Function：**同源，零 CORS，零预检**
- 前端 → 魔搭 API：跨域一次（这也是唯一需要解决 CORS 的地方）

### 4.3 唯一跨域点：浏览器 → 魔搭

魔搭 ingress 对 `OPTIONS` 预检的处理**未知**，必须实测。两种走向：

**走向 A：预检放行** → 魔搭侧 CORS 已有配置（[index.ts:31-52](file:///d:/SSDOWN/GithubStarsManager/server/src/index.ts#L31-L52)），补 `allowedHeaders` 即可。

**走向 B：预检被拦** → 在魔搭容器内加一层 nginx，接收同源路径 `/mbackend/*` 反向代理到 127.0.0.1:3000，前端把数据 API 指向 `https://<studio>.ms.show/mbackend`。这样浏览器视角仍是同源（同 `ms.show` 域），预检消失。

> 走向 B 是兜底方案，代价是多一个 nginx 进程。**先实测再决定。**

---

## 5. 代码改动清单

### 5.1 Vercel 侧（新建）

#### 5.1.1 目录结构

```
d:\SSDOWN\GithubStarsManager\
├── api/                                  # 新增：Vercel Functions
│   ├── _lib/
│   │   ├── egressFetch.ts                # 出网公共层（超时/UA/错误信封）
│   │   └── verifySecret.ts               # 请求鉴权
│   ├── proxy/
│   │   └── github/
│   │       ├── [...path].ts              # 合并 API + raw + search 三条
│   ├── telegram/
│   │   └── channel/[channel].ts
│   └── xtweet/
│       ├── profile/[handle].ts
│       └── graphql.ts
├── vercel.json                           # 新增
└── package.json                          # 补 functions 运行时依赖
```

#### 5.1.2 `vercel.json`

```json
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "npm run build",
  "outputDirectory": "dist",
  "functions": {
    "api/proxy/github/[...path].ts": { "maxDuration": 60, "memory": 512 },
    "api/telegram/channel/[channel].ts": { "maxDuration": 30 },
    "api/xtweet/profile/[handle].ts": { "maxDuration": 30 },
    "api/xtweet/graphql.ts": { "maxDuration": 30 }
  },
  "rewrites": [
    { "source": "/api/((?!proxy|telegram|xtweet).*)", "destination": "/index.html" }
  ]
}
```

> 说明：`rewrites` 保证未被 Function 接管的其他 `/api/*` 路径不误返回 SPA 页面。

#### 5.1.3 GitHub Function —— token 改为请求传入

**改动来源**：改造自 [`server/src/routes/proxy.ts:103-149`](file:///d:/SSDOWN/GithubStarsManager/server/src/routes/proxy.ts#L103-L149)。

原实现（魔搭侧，读 DB）：

```ts
// 修改前
const tokenRow = db.prepare('SELECT value FROM settings WHERE key = ?').get('github_token')
if (!tokenRow?.value) { /* 400 GITHUB_TOKEN_NOT_CONFIGURED */ }
let token: string
try {
  token = decrypt(tokenRow.value, config.encryptionKey)
} catch { /* 500 GITHUB_TOKEN_DECRYPT_FAILED */ }
```

新实现（Vercel 侧，从请求体取 token）：

```ts
// 修改后
// Vercel Function 无数据库访问能力，GitHub token 由前端随请求携带。
// 前端 store 中本就持有 githubToken，无需额外获取路径。
const token = typeof req.body?.githubToken === 'string' ? req.body.githubToken.trim() : ''
if (!token) {
  return res.status(400).json({
    error: 'GitHub token not provided by client',
    code: 'GITHUB_TOKEN_NOT_CONFIGURED',
  })
}
```

**前端配套改动**：`githubApi.ts` 的 `viaProxy` 分支在 body 中加入 `githubToken`。

对应修改点：[`githubApi.ts:379-384`](file:///d:/SSDOWN/GithubStarsManager/src/services/githubApi.ts#L379-L384)、[`githubApi.ts:715-719`](file:///d:/SSDOWN/GithubStarsManager/src/services/githubApi.ts#L715-L719)。

#### 5.1.4 Telegram / X Function —— 近乎直接搬运

[telegram.ts](file:///d:/SSDOWN/GithubStarsManager/server/src/routes/telegram.ts) 与 [xtweet.ts](file:///d:/SSDOWN/GithubStarsManager/server/src/routes/xtweet.ts) **业务逻辑无需修改**，仅做适配：

| 改动项 | 原（Express） | 新（Vercel Function） |
|---|---|---|
| 路由声明 | `router.get('/api/telegram/channel/:channel', ...)` | `export default async function handler(req, res)` |
| 路径参数 | `req.params.channel` | `req.query.channel`（Vercel 把动态段放进 query） |
| 鉴权 | 挂载在 `/api` 下由 `authMiddleware` 统一处理 | 每个 Function 内显式调用 `verifySecret(req)` |
| logger | `import { logger } from '../services/logger.js'` | 改为 `console.warn`（Vercel 日志） |

**保留不动的部分**（安全边界，逐字保留）：

- `TG_CHANNEL_PATTERN` / `BEFORE_PATTERN` 严格校验
- `X_HANDLE_PATTERN` / `X_MAIN_JS_PATTERN` / `X_GRAPHQL_API_PATTERN` 白名单
- `isAllowedXProxyUrl` 双重校验（请求 + 响应重定向）
- `X_COOKIE_VALUE_PATTERN` Cookie 值校验
- `redirect: 'error'`（xtweet）防止 Cookie 泄露到白名单外域
- `AbortSignal.timeout()` 超时

> ⚠️ 这些是 SSRF 与凭据泄露防线，**不得在适配过程中简化**。

### 5.2 魔搭侧（删除路由）

从 [`server/src/index.ts`](file:///d:/SSDOWN/GithubStarsManager/server/src/index.ts#L70-L74) 摘除已迁走的挂载：

```ts
// 修改前
// Wave 3: Proxy routes
app.use(proxyRouter);
app.use(xtweetRouter);
app.use(telegramRouter);

// 修改后
// Wave 3: Proxy routes
// GitHub / Telegram / X 出网路由已迁至 Vercel Functions（魔搭出口不可达）。
// 本容器仅保留数据面与 AI / WebDAV 代理。
app.use(proxyRouter);     // 保留：AI 与 WebDAV（若 AI 也迁走则仅剩 WebDAV）
// xtweetRouter / telegramRouter 已删除
```

对应的 import 语句一并清理：

```ts
// 删除以下两行
import xtweetRouter from './routes/xtweet.js';
import telegramRouter from './routes/telegram.js';
```

**待定**：若 AI Provider 选定为 OpenAI / Claude 官方，`proxyRouter` 中的 `/api/proxy/ai` 也要迁出，届时需拆分成 `proxyRouter`（WebDAV + RPC）与 AI Function 两个单元。

### 5.3 前端侧（URL 拆分）

这是**影响面最大**的改动。当前四族共用 `backend.backendUrl`。

#### 5.3.1 新增出站 URL 配置

在 [`backendAdapter.ts`](file:///d:/SSDOWN/GithubStarsManager/src/services/backendAdapter.ts#L19) 旁新增：

```ts
/** 出网代理（Vercel Functions）的基址，与数据后端（魔搭）分离。 */
const EGRESS_URL_STORAGE_KEY = 'github-stars-manager-egress-url'

/** 默认与前端同源：Vercel 上静态前端与 Functions 同域，无需配置即可工作。 */
const readEgressUrl = (): string => {
  try {
    const stored = localStorage.getItem(EGRESS_URL_STORAGE_KEY)
    if (stored) return stored.replace(/\/$/, '') + '/api'
  } catch { /* 受限浏览器 */ }
  return `${window.location.origin}/api`
}
```

#### 5.3.2 三处调用点改向

| 文件 | 行 | 原 | 新 |
|---|---|---|---|
| [githubApiFactory.ts](file:///d:/SSDOWN/GithubStarsManager/src/services/githubApiFactory.ts#L20-L23) | 20-23 | `api.setBackendUrl(backend.backendUrl)` | `api.setBackendUrl(egressUrl)` |
| [telegramService.ts](file:///d:/SSDOWN/GithubStarsManager/src/services/telegramService.ts#L108-L111) | 108-111 | `fetch(\`${backendUrl}/telegram/...\`)` | `fetch(\`${egressUrl}/telegram/...\`)` |
| [xTweetService.ts](file:///d:/SSDOWN/GithubStarsManager/src/services/xTweetService.ts#L115-L117) | 115-117, 197-199 | `fetch(\`${backendUrl}/xtweet/...\`)` | `fetch(\`${egressUrl}/xtweet/...\`)` |

**保持不变**：`backendAdapter` 内部所有数据 CRUD 仍走 `backend.backendUrl`（魔搭）。

#### 5.3.3 鉴权头适配

Vercel 侧无 `ms.show` 的 header 注入问题，可正常使用 `Authorization`。但需要与魔搭的信号源分离：

```ts
/** Egress（Vercel）请求头：使用独立的 EGRESS_SECRET。 */
export const getEgressAuthHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const secret = useAppStore.getState().egressApiSecret
  if (secret) headers['Authorization'] = `Bearer ${secret}`
  return headers
}
```

### 5.4 改动量估算

| 单元 | 文件数 | 估算行数 |
|---|---|---|
| Vercel Functions（新建） | 6 | ~320 |
| vercel.json + package.json | 2 | ~30 |
| 魔搭 index.ts 摘除 | 1 | -4 |
| 前端 URL 拆分 | 4 | ~60 |
| 前端 token 透传 | 1 | ~10 |
| **合计** | **14** | **~420** |

---

## 6. 魔搭平台强制约束

### 6.1 端口 7860

魔搭仅对外暴露 7860，其他端口仅供容器内部使用。

| 文件 | 改动 |
|---|---|
| [Dockerfile.fullstack](file:///d:/SSDOWN/GithubStarsManager/Dockerfile.fullstack#L34) | `EXPOSE 3000` → `EXPOSE 7860` |
| 同上 | `ENV PORT=7860` |

### 6.2 `Authorization` 头被平台占用

魔搭官方明确：

> HTTP Header `Authorization`、`X-modelscope-*`、`X-studio-*` 已经被魔搭平台占用，请勿在后端接口中使用。

平台反向代理会**注入自己的 `Authorization` 值，覆盖前端发送的内容** → 现有 [`authMiddleware`](file:///d:/SSDOWN/GithubStarsManager/server/src/middleware/auth.ts#L24-L40) 会全部 401。

**方案**：改用自定义头。

| 位置 | 改动 |
|---|---|
| [auth.ts](file:///d:/SSDOWN/GithubStarsManager/server/src/middleware/auth.ts#L24) | 从 `req.headers.authorization` 改读 `req.headers['x-gsm-secret']` |
| [backendAdapter.ts:37](file:///d:/SSDOWN/GithubStarsManager/src/services/backendAdapter.ts#L37) | 写入 `X-GSM-Secret` 而非 `Authorization` |
| [index.ts:43-50](file:///d:/SSDOWN/GithubStarsManager/server/src/index.ts#L43-L50) | CORS `allowedHeaders` 增加 `X-GSM-Secret` |

约 15 行。**这是上线前必须完成项，否则所有数据 API 401。**

### 6.3 持久化卷

`/mnt/workspace` 是唯一持久化路径，容器重启保留；其余路径随容器重建清零。

| 数据 | 原路径 | 新路径 |
|---|---|---|
| SQLite 主库 | `cwd/data/data.db` | `/mnt/workspace/data.db` |
| 加密密钥文件 | `cwd/data/.encryption-key` | **改环境变量**（见 6.4） |

配置方式：[`config.ts:85`](file:///d:/SSDOWN/GithubStarsManager/server/src/config.ts#L85)

```ts
dbPath: process.env.DB_PATH || path.join(dataDir, 'data.db'),
```

设环境变量 `DB_PATH=/mnt/workspace/data.db` 即可，**代码无需修改**。

### 6.4 `ENCRYPTION_KEY` 必须固化（最高优先级）

当前逻辑（[`config.ts:53-75`](file:///d:/SSDOWN/GithubStarsManager/server/src/config.ts#L53-L75)）：

1. 读 `process.env.ENCRYPTION_KEY`，有则用
2. 否则读 `dataDir/.encryption-key`
3. 都没有 → **随机生成并写入文件**

而 `dataDir` 由 [`resolveDataDir()`](file:///d:/SSDOWN/GithubStarsManager/server/src/config.ts#L14-L20) 解析为 `process.cwd()/data`，**在容器层而非持久化卷**。

**后果**：容器重建 → 密钥重新生成 → 已加密的 GitHub token、AI API Key、WebDAV 密码、MCP token **全部无法解密**。

**方案**：在魔搭创空间设为 Secret 变量 `ENCRYPTION_KEY`（64 位 hex），值本地生成后妥善保存：

```bash
openssl rand -hex 32
```

> 环境变量优先于文件，设置后逻辑自动走分支 1，无需改代码。但**必须确保该变量在每次部署时都存在**，缺失即触发密钥重新生成。

### 6.5 `USER` 必须用用户名

魔搭 runtime 以 `su <user> -c <cmd>` 拉起进程，纯数字 UID 会失败：

```
su: user 10001 does not exist
```

[Dockerfile.fullstack](file:///d:/SSDOWN/GithubStarsManager/Dockerfile.fullstack#L32) 当前用 `USER node`（用户名），**已合规，无需改动**。

### 6.6 WAF 与 git push

阿里云 WAF 扫描 packfile 内容。已知触发组合：

- `sed -i` 与 `chmod +x` 同时出现在 Dockerfile（即使不同 RUN）
- 脚本内含高密度 `password` / `auth` / `token` 关键词

本项目源码 **176 处数据库调用 + 大量鉴权代码**，直接推送整个仓库有触发风险。

**推荐做法**（沿用 deeplx-pro 经验）：魔搭仓库仅放 **最小 Dockerfile**，构建时从 GitHub 拉源码。

```dockerfile
FROM node:22-alpine AS frontend-build
WORKDIR /frontend
RUN apk add --no-cache git \
 && git clone --depth 1 https://github.com/<owner>/GithubStarsManager.git .
RUN npm ci && npm run build

FROM node:22-alpine AS server-build
WORKDIR /app
RUN apk add --no-cache git python3 make g++ \
 && git clone --depth 1 https://github.com/<owner>/GithubStarsManager.git /src
WORKDIR /src/server
RUN npm ci && npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
# better-sqlite3 需要 glibc 兼容层，见 6.7
...
```

> 若构建期拉取 GitHub 也受限，则改用魔搭 `uploadFile` HTTP API 推送源码（绕过 git 协议层）。

### 6.7 `better-sqlite3` 与 alpine

`better-sqlite3` 是原生 C++ 模块。`node:22-alpine` 使用 musl libc，需要预编译二进制或源码编译。

现有 [Dockerfile.fullstack](file:///d:/SSDOWN/GithubStarsManager/Dockerfile.fullstack#L14-L19) 在 `node:22-alpine` 上 `npm ci` 构建，说明上游已验证可行。**保持相同基础镜像，不要换成 debian-slim**，避免引入新的 ABI 差异。

若构建期无法下载预编译二进制，构建阶段需装 `python3 make g++`。

---

## 7. 验证方法

### 7.1 【第一步】魔搭出口可达性实测

**在魔搭容器内**执行，这是决定后续所有工作的前提：

```bash
# GitHub API
curl -sS -o /dev/null -w 'github %{http_code} %{time_total}s\n' --max-time 15 \
  https://api.github.com/rate_limit

# Telegram
curl -sS -o /dev/null -w 'telegram %{http_code} %{time_total}s\n' --max-time 15 \
  https://t.me/s/telegram

# X
curl -sS -o /dev/null -w 'x %{http_code} %{time_total}s\n' --max-time 15 \
  https://x.com/home

# Vercel（用于验证魔搭→Vercel 方向，若非同源反代方案需要）
curl -sS -o /dev/null -w 'vercel %{http_code} %{time_total}s\n' --max-time 15 \
  https://vercel.com
```

判定：

| 结果 | 含义 | 行动 |
|---|---|---|
| `000` 或超时 | 不可达 | 该族必须迁 Vercel（预期结果） |
| `200` / `403` 且时间 < 3s | 可达 | 可留在魔搭，但为稳定性仍建议迁 Vercel |

### 7.2 魔搭 CORS 预检实测

从前端域（`*.vercel.app`）发起跨域预检：

```bash
curl -sS -i -X OPTIONS \
  -H "Origin: https://<your-app>.vercel.app" \
  -H "Access-Control-Request-Method: PUT" \
  -H "Access-Control-Request-Headers: content-type,x-gsm-secret" \
  "https://<owner>-<repo>.ms.show/api/repositories" | head -20
```

判定：

- 返回 `204` 且含 `Access-Control-Allow-Origin` → **走向 A**，直接放行
- 返回 `403` / `405` / 无 CORS 头 → **走向 B**，需要容器内 nginx 同源反代（见 4.3）

### 7.3 Vercel Function 验证

```bash
# 健康：应返回 401（未带密钥）而非 404
curl -sS -o /dev/null -w '%{http_code}\n' https://<app>.vercel.app/api/telegram/channel/telegram

# 带密钥 + 合法频道：应返回 HTML
curl -sS -H "Authorization: Bearer $EGRESS_SECRET" \
  "https://<app>.vercel.app/api/telegram/channel/telegram" | head -c 200

# 非法频道：应返回 400 INVALID_CHANNEL（校验未被削弱）
curl -sS -H "Authorization: Bearer $EGRESS_SECRET" \
  "https://<app>.vercel.app/api/telegram/channel/../../etc/passwd"
```

### 7.4 数据持久化验证（魔搭）

1. 在 UI 中新增一个分类或修改一个仓库描述
2. 在魔搭控制台**重启容器**
3. 刷新页面，确认修改仍在

若丢失 → 检查 `DB_PATH` 是否指向 `/mnt/workspace/data.db`。

### 7.5 密钥持久性验证（魔搭）

1. 在 UI 中保存一个 AI 配置（含 API Key）
2. 重启容器
3. 编辑该配置，确认 Key 可正常解密显示（而非「解密失败」）

若失败 → `ENCRYPTION_KEY` 未固化。

---

## 8. 风险与未决项

| # | 风险/未决项 | 影响 | 处理 |
|---|---|---|---|
| 1 | AI Provider 未定 | 决定 `/api/proxy/ai` 归属 | **待用户确认** |
| 2 | 魔搭 `OPTIONS` 预检行为未知 | 决定是否需要 nginx 同源反代 | 7.2 实测 |
| 3 | GitHub token 改为前端透传 | 安全性略降（token 出现在请求体） | 已有 HTTPS + 服务端密钥鉴权；token 本来就在浏览器内存中，风险增量小 |
| 4 | 构建期 git clone GitHub | 魔搭构建环境可能同样受限 | 备选 `uploadFile` API 推送源码 |
| 5 | WAF 拦 git push | 无法部署 | 最小 Dockerfile + 构建期拉源码 |
| 6 | Vercel Function 冷启动 | 首次请求延迟 1–3s | 可接受；必要时配 cron 保活 |
| 7 | 魔搭容器休眠策略 | 未确认免费资源是否有闲置回收 | **待查**；若有则需外部定时保活 |
| 8 | 前端已部署版本缓存 | 旧前端指向单一 URL，改造后行为不一致 | 部署后强制刷新 / 版本号提示 |
| 9 | 双份鉴权密钥（魔搭 + Vercel） | 配置复杂度上升 | 设置面板增加 Egress URL / Secret 两个字段 |
| 10 | GitHub token 迁移 | 若用户已在魔搭 DB 中存过 token，前端需能读取 | 复用现成的 `/api/sync/auth` 恢复路径 |

---

## 9. 实施顺序

按依赖关系排序，每步可独立验证。

| 步 | 内容 | 验证方式 | 阻塞后续 |
|---|---|---|---|
| 1 | 魔搭出口实测（7.1） | curl 返回码 | 是 |
| 2 | 魔搭创空间创建 + 最小 Dockerfile + 端口/DB_PATH/ENCRYPTION_KEY | 容器 Running，`/api/health` 200 | 是 |
| 3 | 魔搭侧 CORS 预检实测（7.2） | `OPTIONS` 返回 204 | 是 |
| 4 | 魔搭侧鉴权头改 `X-GSM-Secret` | 前端能正常读写数据 | 是 |
| 5 | 数据持久化验证（7.4 / 7.5） | 重启后数据与密钥完好 | 是 |
| 6 | Vercel Functions 编写 + telemetry/telegram/xtweet 迁移 | 7.3 | 否 |
| 7 | GitHub Function + 前端 token 透传 | Stars 同步成功 | 否 |
| 8 | 前端 URL 拆分（egress vs backend） | 四族请求各走各的 | 否 |
| 9 | 全链路验证 | Stars 同步、Release 订阅、TG 频道、X 推文、MCP | — |

---

## 10. 备选方案对照

| 方案 | DB 改动 | 出口问题 | 持久化 | 复杂度 | 结论 |
|---|---|---|---|---|---|
| Vercel 单栈 + Turso | 8 事务 + 13 文件 async | 无 | 好 | 高 | 不选 |
| 魔搭单栈 | 0 | ❌ GitHub/TG/X 不可达 | 好 | 低 | **不可行** |
| **Vercel 前端+出口 / 魔搭数据（本方案）** | **0** | ✅ | 好 | 中 | **采用** |
| Vercel 前端 / 魔搭全部后端 + 代理 | 0 | 部分（TG/X 不走代理） | 好 | 中 | 不可行 |
| Vercel 前端 / 魔搭数据 + Turso 双写 | 高 | 无 | 冗余 | 高 | 过度设计 |

---

## 11. 平台控制台手动操作清单

以下操作不留存在 git 历史中，需逐条执行并记录：

| # | 操作 | 控制台位置 | 要点 | 结果 |
|---|---|---|---|---|
| 1 | 创建创空间 | modelscope.cn/studios | `sdk_type=docker`，硬件选 `platform/2v-cpu-16g-mem` | 待执行 |
| 2 | 设置可见性 | 创空间设置 | 建议 `private`（含大量源码逻辑） | 待执行 |
| 3 | 配置 Secret `ENCRYPTION_KEY` | 创空间 → 变量（Secret 类型） | 64 位 hex，本地 `openssl rand -hex 32` 生成后保存 | 待执行 |
| 4 | 配置明文变量 `DB_PATH` | 创空间 → 变量（明文类型） | `/mnt/workspace/data.db` | 待执行 |
| 5 | 配置明文变量 `PORT` | 创空间 → 变量（明文类型） | `7860` | 待执行 |
| 6 | 配置 Secret `API_SECRET` | 创空间 → 变量（Secret 类型） | 长随机串 | 待执行 |
| 7 | Vercel 项目环境变量 | Vercel → Settings → Environment Variables | `EGRESS_SECRET`、`STATIC_DIR` 等 | 待执行 |
| 8 | 绑定自定义域名（可选） | 双方控制台 | 若需统一入口 | 待执行 |

---

## 12. 敏感信息清单

**本章仅记录变量名与用途，实际值通过安全通道交接，文档不留档。**

| 变量名 | 用途 | 申请/生成渠道 | 配置位置 | 归属 |
|---|---|---|---|---|
| `ENCRYPTION_KEY` | AES-256-GCM 加解密（GitHub token / AI Key / WebDAV 密码 / MCP token） | `openssl rand -hex 32` 本地生成 | 魔搭创空间 Secret | 魔搭 |
| `API_SECRET` | 数据 API 鉴权（Bearer） | 本地生成长随机串 | 魔搭创空间 Secret | 魔搭 |
| `EGRESS_SECRET` | Vercel Functions 鉴权 | 本地生成长随机串 | Vercel 环境变量 | Vercel |
| `DB_PATH` | SQLite 文件路径（非敏感） | 固定值 | 魔搭创空间明文变量 | 魔搭 |
| `PORT` | 监听端口（非敏感） | 固定值 `7860` | 魔搭创空间明文变量 | 魔搭 |
| `STATIC_DIR` | 静态资源目录（非敏感，数据侧不设） | 固定值 | 环境变量 | — |

> ⚠️ `ENCRYPTION_KEY` 一旦变更或丢失，已存储的所有密钥类数据将永久无法解密。生成后须在密码管理器中备份。

---

## 13. 待补充清单

| 项 | 说明 |
|---|---|
| AI Provider 选型 | 决定 `/api/proxy/ai` 归属（见 3.1） |
| 魔搭实际出口实测结果 | 见 7.1，填入实际返回码 |
| 魔搭 `OPTIONS` 预检实测结果 | 见 7.2，决定走向 A 或 B |
| 魔搭免费资源休眠策略 | 需查阅平台文档确认是否有闲置回收 |
| GitHub 上游仓库地址 | 用于最小 Dockerfile 的 `git clone` |
| Vercel 项目名与生产域名 | 用于构造 7.2 的 Origin 头 |
