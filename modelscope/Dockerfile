# syntax=docker/dockerfile:1
#
# ModelScope Studio（魔搭创空间）部署镜像 —— 后端 API + MCP。
#
# 设计要点及原因：
#
# 1. **构建期从 GitHub 拉源码，而非 COPY 本地**
#    仓库有 542 个文件、工作区 97MB，且含大量 auth/token/secret 关键词。
#    魔搭的阿里云 WAF 会扫描 git push 的 packfile 内容，deeplx-pro 项目曾
#    因此反复 403（最终通过"只留最小 Dockerfile"才通过）。因此魔搭仓库
#    只保留本文件，源码在构建期由 git clone 拉取。该路径已在 deeplx-pro
#    上验证可行（其 Dockerfile 同样在构建期 clone GitHub）。
#
# 2. **端口 7860** —— 魔搭仅对外暴露 7860，其他端口仅供容器内部使用。
#
# 3. **DB_PATH=/mnt/workspace/data.db** —— /mnt/workspace 是魔搭唯一的
#    持久化路径（S3FS 挂载），容器重启保留。其余路径随容器重建清零。
#
# 4. **USER node（用户名，非 UID）** —— 魔搭 runtime 以 `su <user> -c` 拉起
#    进程，纯数字 UID 会报 "user 10001 does not exist"（deeplx-pro 实测）。
#    node:22 镜像自带 node 用户，无需 useradd。
#
# 5. **不含前端静态资源** —— 前端部署在 Vercel，本容器只跑 API 与 MCP，
#    因此不设 STATIC_DIR（staticFrontend 会因缺该变量而跳过挂载）。
#
# 6. **鉴权用 X-GSM-Secret** —— 魔搭反向代理会注入并覆盖 Authorization，
#    前端与 authMiddleware 已同步改用自定义头。

FROM node:22-alpine AS server-build
WORKDIR /src

# git 用于拉源码；better-sqlite3 是原生 C++ 模块，node:22-alpine 用 musl
# libc，若无预编译二进制则回退源码编译，故需 python3/make/g++。
# 保持与上游 Dockerfile.fullstack 相同的基础镜像，避免引入新的 ABI 差异。
#
# 分支说明：当前拉取 agent/GSM-001-split-egress-vercel-modelscope —— 出网分层
# 改造与 X-GSM-Secret 鉴权都在该分支上，尚未合并回 main。合并后应改为 main，
# 否则该分支一旦删除，此处构建即失败。
RUN apk add --no-cache git python3 make g++ \
 && git clone --depth 1 --branch agent/GSM-001-split-egress-vercel-modelscope https://github.com/sche11/GithubStarsManager.git . \
 && cd server \
 && npm ci \
 && npm run build \
 && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production \
    PORT=7860 \
    DB_PATH=/mnt/workspace/data.db
WORKDIR /app

COPY --from=server-build --chown=node:node /src/server/dist ./dist
COPY --from=server-build --chown=node:node /src/server/node_modules ./node_modules
COPY --from=server-build --chown=node:node /src/server/package.json ./package.json

# /mnt/workspace 由平台在启动时挂载为持久化卷，此处不创建。
# /app/data 仅作为卷不可用时的降级落点，保证进程仍能启动。
RUN mkdir -p /app/data && chown node:node /app/data

USER node
EXPOSE 7860
CMD ["node", "dist/index.js"]
