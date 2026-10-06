# syntax=docker/dockerfile:1

# 注意：源码 app/api/tiles/[...path]/route.ts 静态 import node:sqlite，
# 该内置模块 Node 22.5 起才有（Node 20 会在 next build 的 Collecting page data 阶段失败），
# 故基础镜像必须 >= 22，README 写的「Node 20+」不适用于构建。
ARG NODE_IMAGE=node:22-bookworm-slim

# ========== 构建阶段 ==========
FROM ${NODE_IMAGE} AS builder

WORKDIR /app
COPY package.json package-lock.json ./
# npm 镜像加速
RUN npm ci --registry=https://registry.npmmirror.com

COPY . .
# J1900 内存有限，限制 Next 构建期堆上限
ENV NODE_OPTIONS=--max-old-space-size=3072
RUN npm run build

# ========== 运行阶段 ==========
FROM ${NODE_IMAGE} AS runtime

# 用静态 ffmpeg 二进制，避免 apt 安装 180+ 依赖包（本机实测要 24 分钟）
COPY --from=mwader/static-ffmpeg:latest /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:latest /ffprobe /usr/local/bin/ffprobe

# heif-convert：iPhone 默认拍 HEIC，浏览器解不了、静态 ffmpeg 也没带 libheif。
# 不带这条，HEIC 会「上传成功但缩略图空白、成片里被静默丢弃」。
# --no-install-recommends 只拉 libheif1/libde265/libx265，实测 apt 约 2 分半（首次构建）。
RUN apt-get update -qq \
 && apt-get install -y -qq --no-install-recommends libheif-examples \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# 用 COPY --chown 在写入时就设好属主（等价于 chown -R，但在 overlayfs 上不需要对每个文件做 copy-up，快得多）
COPY --chown=981:901 --from=builder /app/.next/standalone ./
COPY --chown=981:901 --from=builder /app/.next/static ./.next/static
COPY --chown=981:901 --from=builder /app/public ./public

USER 981:901

ENV PORT=3000 \
    HOSTNAME=0.0.0.0

EXPOSE 3000
CMD ["node", "server.js"]
