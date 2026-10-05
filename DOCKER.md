# Docker 部署说明

本仓库是 [wang-bool/Travel-Story](https://github.com/wang-bool/Travel-Story) 的 **Docker 化部署版**
（基于上游提交 `c7c696cf5131c1cdb6affa218b1b69010febca99`）。上游源码未作业务改动，
只增加了容器化所需文件，并修正了下述一处运行版本要求。

## 一键起服务

```bash
cp .env.example .env      # 填 GAODE_KEY / LOCATIONIQ_KEY，至少一个
docker compose up -d --build
```

访问 `http://<宿主机IP>:3000`。数据持久化在 `./data`，地图瓦片缓存在 `./tile-cache`。

## 相对上游的改动

| 文件 | 改动 |
| --- | --- |
| `Dockerfile` | 新增。多阶段构建 + 静态 ffmpeg |
| `docker-compose.yml` | 新增。端口、数据卷、环境变量、restart 策略 |
| `.dockerignore` | 新增 |
| `next.config.ts` | 增加 `output: "standalone"`，产出最小运行包 |
| `.gitignore` | 增加 `logs/` |

## 三个踩过的坑（都在本机实测过）

**1. 必须用 Node 22.5+，README 写的「Node 20+」是错的。**
`app/api/tiles/[...path]/route.ts` 顶层静态 `import { DatabaseSync } from "node:sqlite"`，
`node:sqlite` 是 Node 22.5 才引入的内置模块。用 Node 20 构建不会立刻报错，
而是跑到 `next build` 的 `Collecting page data` 阶段才炸：

```
Error: No such built-in module: node:sqlite
[Error: Failed to collect page data for /api/tiles/[...path]]
```

所以 Dockerfile 基础镜像固定 `node:22-bookworm-slim`（实测 v22.23.3 可用）。

**2. ffmpeg 不要用 `apt-get install` 装。**
Debian 上它会拖进 183 个依赖包（llvm15、libdrm、libopenal 一整串），
在低功耗机器上实测解包耗掉 **24 分钟**。改用静态二进制：

```dockerfile
COPY --from=mwader/static-ffmpeg:latest /ffmpeg /usr/local/bin/ffmpeg
COPY --from=mwader/static-ffmpeg:latest /ffprobe /usr/local/bin/ffprobe
```

**3. 不要用 `RUN chown -R <uid>:<gid> /app` 统一属主。**
overlayfs 上改属主需要对每个文件做 copy-up，node_modules 几万个小文件实测 6 分钟仍未完成。
改用 `COPY --chown=<uid>:<gid>`，写入时就定好属主，零额外耗时。

## 容器用户

容器以 `981:901` 运行（本机 `hermes-studio` 用户），与 bind mount 的 `./data`、`./tile-cache`
属主一致。换机器部署时改成目标机 `id` 输出的 uid:gid，Dockerfile 的 `--chown` 与
compose 的 `user:` 两处都要改。

## 安全边界

上游所有业务 API **没有登录校验**，能连上就能读写行程、上传素材、触发 FFmpeg。
本部署只监听局域网，请勿直接映射到公网；确需外网访问，应在反向代理层补充
身份验证、HTTPS 与速率限制。

## 许可

沿用上游 MIT License，见 `LICENSE`。
