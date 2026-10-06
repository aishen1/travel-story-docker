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
| `lib/server/mediaTools.ts` | 新增。HEIC 转 JPEG、缩略图、时长探测、背景音乐混流 |
| `app/api/bgm/route.ts` | 新增。背景音乐上传/试听/删除（GET/POST/DELETE） |
| `components/FilmLibrary.tsx` | 新增。成片库（列表/播放/下载/删除） |
| `app/api/media/route.ts` | 上传时 HEIC→JPEG、生成 1280px 缩略图 |
| `app/api/media/[id]/route.ts` | 新增 `?thumb=1` 读缩略图 |
| `app/api/recordings/route.ts` | 新增 GET 成片清单、DELETE 删除；POST 支持 `tripId` 并混入背景音乐 |
| `lib/server/db.ts` | 新增缩略图/背景音乐/成片清单的存储函数与边车元数据 |
| `lib/media.ts` | 新增 `mediaThumbUrl` / `bgmUrl` / 背景音乐读写 |
| `components/StopMedia.tsx` | 列表改读缩略图；文件选择器显式接受 `.heic/.heif` |
| `components/PlanTimeline.tsx` | **跨天路段也能改交通方式**（原来这里是个缺口） |
| `lib/record/compositor.ts` | 视频预载 `auto` → `metadata`（素材大时录制页不再长时间卡在「预热中」） |
| `app/trip/[id]/record/page.tsx` | 录制页新增「背景音乐」选择（上传/试听/更换/移除） |
| `Dockerfile` | 运行阶段加 `libheif-examples`（heif-convert） |
| `app/globals.css` | 成片库、跨天路段标签、背景音乐行的样式 |
| `lib/types.ts` (v3) | `MediaMeta` 增加 `clipStart` / `clipLen` / `volume` |
| `lib/store.ts` (v3) | 新增 `updateStopMedia()` |
| `lib/record/compositor.ts` (v3) | 图片预缩 + 串行预载与进度回调；片段时长窗口；`audioCue()` 收集现场原声排期 |
| `lib/renderJobs.ts` (v3) | 新增。渲染任务上报（`startRenderJob` / 节流上报器 / 列表 / 清理） |
| `lib/server/filmFinish.ts` (v3) | 新增。成片收尾：混音（现场原声 + 配乐）+ 抽海报 |
| `lib/server/zip.ts` (v3) | 新增。自写 zip 读写（store 写 + CRC 回填；解压支持 deflate） |
| `app/api/render-jobs/route.ts` (v3) | 新增。渲染任务 GET/POST/PATCH/DELETE |
| `app/api/export/route.ts` (v3) | 新增。行程导出 zip（流式，自动清理旧导出） |
| `app/api/import/route.ts` (v3) | 新增。行程导入 zip（冲突改名、类型嗅探） |
| `app/api/recordings/[file]/route.ts` (v3) | 新增 `?poster=1` 取成片海报 |
| `components/FilmLibrary.tsx` (v3) | 加封面海报 + 页内播放器 |
| `components/StopMedia.tsx` (v3) | 加片段编辑器（✂ 起始/时长/音量） |
| `app/page.tsx` (v3) | 加「⬆ 导入行程」 |
| `app/trip/[id]/page.tsx` (v3) | 加「⬇ 导出」、片段编辑入口 |
| `app/trip/[id]/record/page.tsx` (v3) | 加素材加载进度、上次渲染中断提示与清理 |
| `lib/server/db.ts` (v3) | 帧目录/TMP 清理、渲染任务落库、海报路径、成片删除连带海报 |

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

## 五、v2 新增的五个功能（均已实测）

**1. HEIC / HEIF 自动转 JPEG（iPhone 照片）**
iPhone 默认拍 HEIC。浏览器解不了、镜像里的静态 ffmpeg 也没带 libheif —— 结果是照片
「上传成功」但缩略图空白、**成片里被静默丢弃**（合成器 `img.decode()` 或 ffmpeg 读失败就跳过）。
现在上传时按文件头识别 HEIF 家族（含 AVIF），用 `heif-convert` 转成 JPEG 再入库，
显示名同步改成 `.jpg`。转不了就按原文件入库，绝不丢文件。
Dockerfile 因此增加 `libheif-examples`（`heif-convert`，apt 约 2.5 分钟，只拉 libheif1/libde265/libx265）。

**2. 素材缩略图（长边 1280）**
原来规划页列表直接 `<img src=原图>`，手机 4000×3000 的照片一多就卡。
现在上传时由 ffmpeg 生成 `<id>-thumb.jpg`（视频取第 1 秒的帧当封面），
列表只读 `GET /api/media/<id>?thumb=1`；老素材没有缩略图时路由回落到原图，
前端 `onError` 也兜一层。成片仍用原图，画质不受影响。

**3. 成片库**
原来「/api/recordings」只有 POST，没有列表接口，出片后关掉页面就只剩文件系统里翻。
现在有 `GET /api/recordings?tripId=<id>`（列成片）、`DELETE ?file=<名>`（删），
行程页左栏底部多一个「成片库」：时长 / fps / 大小 / 是否配乐 / 时间 + 播放 / 下载 / 删除。
每部片子落一份同名 `.json` 边车（tripId、时长、帧数、是否混音），
按行程归档不靠解析文件名；老片子没有边车时用文件名里的行程名兜底。

**4. 跨天路段可改交通方式**
`normalizeTrip()` 会在所有相邻地点之间建段（跨天也算），但时间线只在「同一天内还有下一站」
时渲染交通选择器 —— 每天最后一站到次日第一站那段看不到也改不了。
现在只要该站后面还有站就渲染选择器，并加「跨天 · 次日首站『xxx』」标签。

**5. 成片背景音乐**
原来成片全程无声（合成器把视频静音，且没有任何音频轨）。
现在录制页有「背景音乐」：上传一首 mp3/m4a/wav/aac/flac/ogg，可试听、更换、移除；
合成时服务端把它混进 MP4：
- 视频流 `-c:v copy`，不重编码（J1900 上只花几秒）；
- 音乐比片子短就 `-stream_loop -1` 循环，`-shortest` 以画面长度为准；
- 首尾各做 1.5s / 2s 淡入淡出（淡出起点按 ffprobe 探到的时长算）；
- 混完先整体校验码流，通过才替换原片；**任何一步失败都保留无声版本**。

存放位置：`data/bgm/<行程id>.<扩展名>`（同一行程只保留一份）。
上限由 `MAX_BGM_UPLOAD_MB` 控制，默认 30MB。

**6. 录制页的大素材卡顿（连带修掉）**
`lib/record/compositor.ts` 的 `prepare()` 在打开录制页时会预载**全部**素材：
视频用 `preload="auto"`，浏览器会把每个视频都开始下载（实测素材里 8 个视频合计 600MB+），
素材一多页面就长时间停在「预热中」。改为 `preload="metadata"`：只要时长信息，
真正要用的帧在渲染时按 Range 请求拉（服务端 `/api/media/<id>` 支持 206），一次只取一小段。

> **已修（v3 第 1 项）**：图片原来整张 `img.decode()`，4096×3072 的原图解码后约 50MB 位图，
> 几十张就是 GB 级内存。现在改为 `createImageBitmap` → 画布预缩到输出画幅长边 → `bitmap.close()`
> 立即释放，一张降到约 11MB。详见下节。

**存量素材补缩略图**
v2 之前的素材没有缩略图（列表会回落拉原图）。补生成：

```bash
cp scripts/backfill-thumbnails.sh data/
docker exec travel-story sh /app/data/backfill-thumbnails.sh
```

幂等，可反复跑。注意：回落响应只缓存 60 秒，补完刷新页面即可看到小图。

## 六、v3 新增的七项功能（全部经 37 项脚本 + 真实浏览器实测）

**1. 渲染前图片预缩（降内存）**
`prepare()` 改为逐张 `createImageBitmap` → 画布缩到输出画幅长边（`MAX_IMG_PX = max(宽, 高)`）
→ 绘制 → `bitmap.close()` 立即释放。同时把原来的 `Promise.all` 并行预载改成**串行**：
解码峰值压在单张图内，顺带给出准确的 `x/N` 进度。
实测（近 30 张手机照片 + 8 段视频，共 36 份素材）：录制页 **37 秒准备完毕**，
而 v2 时期同一页面会长时间卡在「预热中」并反复把标签页拖崩。

> 顺带：`createImageBitmap` 在局域网 HTTP（非安全上下文）下**是可用的**（与 `crypto.randomUUID`
> 不同），所以这条降级路径在 LAN 场景也能生效；取不到时回落到 `<img>` 老路径。

**2. 孤儿帧目录自动清理（24 小时）**
渲染中途关页面/断网会残留 `data/recordings/frames-<session>/`（几万个 JPEG）。
现在 `GET /api/recordings` 与出片 finalize 都会顺手清掉 24 小时前的这类目录；
正在渲染的目录（mtime 很新）不会被误删。实测：30 小时前的目录被清、新建的目录保留。

**3. 素材加载进度回传**
合成器新增 `onPrepareProgress(done, total)`，录制页把「正在准备…」卡片换成
`正在加载素材 x/N` + 进度条。实测浏览器里 9/36 → 17/36 → 24/36 逐格推进后完成。

**4. 成片库海报 + 页内播放**
出片时用 ffmpeg 抽首帧存 `<成片名>-poster.jpg`（宽 640），列表项显示封面；
`GET /api/recordings/<文件>?poster=1` 提供海报；点封面**在页内直接播放**（不再跳新标签页），
下载走 `?download=1`。

**5. 视频片段选择（起始 / 时长）+ 成片保留现场原声**
`MediaMeta` 增加 `clipStart` / `clipLen` / `volume`，素材卡片上有 ✂ 编辑器（从第几秒、取多久、
音量），带 ✂/♪ 角标与摘要文字（如 `5.0s 起 3.0s`）。
关键点：**音轨由服务端补**——逐帧渲染通道只有画面。浏览器渲染时逐帧收集「哪段视频在原片第几秒、
取多长、放在成片第几秒」，渲染结束以 base64 JSON 通过 `X-Film-Audio` 头一次性传给服务端；
服务端用 `atrim` + `volume` + `atrim`+`afade` + `adelay` 摆好后与背景音乐 `amix` 叠加
（有原声时 BGM 自动降到 0.35 当垫底），视频流 `-c:v copy` 不重编码。

> **两个坑（都踩了才通）**：
> ① 片段已在**输入侧**用 `-ss/-t` 取好，滤镜里**不能再写 `atrim=start=`** —— 输入 seek 已把
> 时间戳归零，二次裁剪会把音轨裁空，`-shortest` 接着把画面也一起截掉，
> 产出几百字节、无任何流的空 MP4（实测 261 字节）。
> ② 音轨末尾要 `apad` 补静音，否则 `-shortest` 会以**音频**长度为准：
> 一段 3 秒原声放进 30 秒成片会把成片截成 3 秒（实测 8 秒成片 + 3 秒原声= 8 秒，加 apad 前是 3 秒）。

**6. 渲染任务状态落库（中断可见）**
渲染开始/每 5 秒/结束都会上报 `POST/PATCH /api/render-jobs`，落 `data/jobs/<id>.json`
（行程、进度、阶段、格式、帧率、结束状态）。录制页加载时读 `GET /api/render-jobs?tripId=`：
上次任务是 `running` 且两分钟没上报就判定为「上次渲染中断了」，给出提示与「清理记录」按钮。
实测：新建 → latest 指向它 → 刚上报不算中断 → 拨快 5 分钟即判中断 → PATCH 改状态 → DELETE 清掉。

**7. 行程导出 / 导入 zip**
- `GET /api/export?tripId=<id>`：打包**该行程用到的**素材（不是整个媒体库）+ 元数据边车 + 配乐
  + `trip.json`，先写 `data/tmp` 再流式返回（素材几百 MB，不能读进内存），并清理 2 小时前的旧导出。
- `POST /api/import`：读 zip 还原行程、素材、边车、配乐；缺边车时按文件头嗅探类型；
  行程 id 冲突自动改名（`renamed: true`）。上限 `MAX_IMPORT_MB`（默认 2048）。
- 入口：行程页右上「⬇ 导出」、首页「⬆ 导入行程」。
- zip 读写是自写的（store 写入 + CRC 回填，解压支持 deflate），不引第三方依赖。
- 实测：真实行程 738.2MB / 73 个条目（1 个 trip.json + 36 素材 + 36 边车），
  `unzip -l` 正常；小行程导入往返还原成功且自动改名。

> **不做自动备份**：本项目的行程数据不接入每日备份（用户明确要求）。
> 需要留档时用页面上的「⬇ 导出」按需导出即可。

## 已知限制（上游设计如此，非 bug）

- **「播放行程」不显示照片/视频**：它只播地图镜头与路线动画；素材仅参与「生成纪录片」。
- 无鉴权（见下）。

> 上一版列在这里的「跨天路段没有编辑入口」已在 v2 修掉（见上）。

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
