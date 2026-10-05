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
| `lib/uid.ts` | 新增。`crypto.randomUUID` 的降级实现 |
| `app/trip/[id]/page.tsx` | 素材上传的 id 生成改用 `uid()` |
| `lib/record/offline.ts` | 渲染会话 id 生成改用 `uid()` |
| `app/api/recordings/frames/route.ts` | 合成超时 280s→20min；补 `-color_range tv` |
| `app/api/recordings/route.ts` | webm→mp4 转码超时 240s→10min |

## 四、非容器相关的代码级修复（本版新增，均已实测）

上游代码假定「浏览器是安全上下文」，在局域网 `http://<IP>:3000` 访问下有三处会坏：

**1. `crypto.randomUUID is not a function`（致命，阻断上传与出片）**
`crypto.randomUUID` 只在 HTTPS / localhost 存在，局域网 HTTP 下是 `undefined`，
而素材上传（`app/trip/[id]/page.tsx`）与纪录片渲染（`lib/record/offline.ts`）都直接调它 ——
表现是点上传或点生成纪录片直接崩成错误页。新增 `lib/uid.ts` 做三级降级
（`randomUUID` → `getRandomValues` → `Math.random`），返回形态一致的 UUID v4 字符串。

> 顺带：WebCodecs 的 `VideoEncoder` 同样只在安全上下文存在。
> 局域网 HTTP 下它会走「JPEG 帧序列 + 服务端 ffmpeg」兜底通道（功能完整，只是慢）。

**2. 服务端合成超时过短**
`assemble()` 原为 280 秒。实测（本机 J1900，1080p、preset medium）：
240 帧用 90 秒，线性外推 3105 帧（约 52 秒片长）≈ 1164 秒，**必然超时**。
改为 1200 秒；`recordings/route.ts` 的转码超时 240 秒改为 600 秒。

**3. 成片色彩范围错误**
JPEG 帧是全范围（full range），ffmpeg 新版本里 `-pix_fmt yuv420p` 不再隐含范围转换，
导致成片被标成 `yuvj420p` / `color_range=pc`，部分播放器按 tv 解析会发灰。
两条编码路径均补 `-color_range tv`。修复前后实测：

```
修复前: pix_fmt=yuvj420p  color_range=pc
修复后: pix_fmt=yuv420p   color_range=tv
```

## 已知限制（上游设计如此，非 bug）

- **跨天路段没有编辑入口**：`normalizeTrip()` 会在**所有相邻地点之间**（跨天也算）自动建段，
  地图和成片里都生效，默认交通方式为「汽车」；但时间线 UI 只在「同一天内还有下一个节点」时
  渲染交通方式选择器，所以每天最后一个地点到次日第一个地点那段**看不到也改不了**。
- **「播放行程」不显示照片/视频**：它只播地图镜头与路线动画；素材仅参与「生成纪录片」。
- 无鉴权（见下）。

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
