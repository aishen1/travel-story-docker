// ============================================================
// Travel Story — 服务端媒体处理（仅服务端可用）
//
// 四件事，都靠镜像里的 ffmpeg / heif-convert：
//   1. HEIC/HEIF → JPEG   iPhone 默认拍 HEIC，浏览器解不了，
//      不转的话素材上传「成功」但缩略图空白、成片里被静默丢弃；
//   2. 缩略图            长边 1280 的 JPEG，列表页只读它；
//   3. 时长探测          ffprobe，写进成片清单；
//   4. 背景音乐混流      视频流直接 copy（不重编码），音乐短则循环。
// 任何一步失败都只降级、不阻断主流程（上传照旧成功）。
// ============================================================

import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "./db";

const FFMPEG = process.env.FFMPEG_PATH || "ffmpeg";
const FFPROBE = process.env.FFPROBE_PATH || "ffprobe";
const HEIF_CONVERT = process.env.HEIF_CONVERT_PATH || "heif-convert";

/** 转码用的临时目录（在 data/ 下，容器内一定可写） */
const TMP_DIR = path.join(DATA_DIR, "tmp");

function run(
  cmd: string,
  args: string[],
  timeout = 120_000
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      cmd,
      args,
      { timeout, maxBuffer: 16 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`${cmd} 失败: ${(stderr || err.message).slice(-400)}`));
          return;
        }
        resolve({ stdout, stderr });
      }
    );
  });
}

async function makeTmpDir(prefix: string): Promise<string> {
  await fs.mkdir(TMP_DIR, { recursive: true });
  return fs.mkdtemp(path.join(TMP_DIR, prefix));
}

// ------------------------------------------------------------
// HEIC / HEIF
// ------------------------------------------------------------

/** 按 ISO-BMFF 的 ftyp box 判定 HEIF 家族（含 AVIF） */
export function isHeifBuffer(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  if (buf.toString("latin1", 4, 8) !== "ftyp") return false;
  const brand = buf.toString("latin1", 8, 12).toLowerCase();
  return [
    "heic",
    "heix",
    "heim",
    "heis",
    "hevc",
    "hevx",
    "hevm",
    "hevs",
    "mif1",
    "msf1",
    "avif",
    "avis",
  ].includes(brand);
}

export const isHeifType = (contentType: string): boolean =>
  /^image\/(hei[cf]|heif|heif-sequence|avif|avif-sequence)/i.test(contentType.trim());

/**
 * HEIC/HEIF → JPEG（heif-convert，走 libde265 解 HEVC）。
 * 返回 null 表示转不了，调用方按原样入库（宁可留下不能显示的原图，也不丢文件）。
 */
export async function convertHeifToJpeg(buf: Buffer): Promise<Buffer | null> {
  const dir = await makeTmpDir("heic-");
  try {
    const src = path.join(dir, "in.heic");
    const dst = path.join(dir, "out.jpg");
    await fs.writeFile(src, buf);
    await run(HEIF_CONVERT, ["-q", "92", src, dst], 180_000);
    // 多图 HEIC（连拍 / 实况照片）会写成 out-1.jpg、out-2.jpg…，取第一张
    let out = dst;
    const exists = await fs
      .access(dst)
      .then(() => true)
      .catch(() => false);
    if (!exists) {
      const candidates = (await fs.readdir(dir))
        .filter((f) => /^out(-\d+)?\.jpg$/.test(f))
        .sort();
      if (!candidates.length) return null;
      out = path.join(dir, candidates[0]);
    }
    const jpeg = await fs.readFile(out);
    return jpeg.length ? jpeg : null;
  } catch (e) {
    console.warn("[media] HEIC 转码失败，按原文件入库", e);
    return null;
  } finally {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// ------------------------------------------------------------
// 缩略图
// ------------------------------------------------------------

/**
 * 生成缩略图（长边 1280 的 JPEG）写到 output。
 * 图片按长边缩；视频取第 1 秒的帧当封面（不足 1 秒就退回首帧）。
 * 注意：`min(1280,iw)` 里的逗号必须用单引号包住 —— ffmpeg 的 filtergraph
 * 用逗号分隔过滤器，不加引号会被切成「scale=min(1280」和「iw):-2」两个过滤器，
 * 报 `No such filter: 'iw):-2'`。execFile 不经 shell，这里写的单引号会原样
 * 传给 ffmpeg 的解析器（它自己会剥掉），不要去引号。
 */
export async function makeThumbnail(
  input: string,
  output: string,
  kind: "image" | "video"
): Promise<boolean> {
  const common = ["-vf", "scale='min(1280,iw)':-2", "-frames:v", "1", "-q:v", "5"];
  const imageArgs = ["-y", "-v", "error", "-i", input, ...common, output];
  try {
    if (kind === "image") {
      await run(FFMPEG, imageArgs, 120_000);
    } else {
      try {
        await run(
          FFMPEG,
          ["-y", "-v", "error", "-ss", "1", "-i", input, ...common, output],
          180_000
        );
      } catch {
        // 太短的视频 seek 1 秒会取不到帧 → 退回首帧
        await run(FFMPEG, ["-y", "-v", "error", "-i", input, ...common, output], 180_000);
      }
    }
    const stat = await fs.stat(output);
    return stat.size > 0;
  } catch (e) {
    console.warn("[media] 缩略图生成失败", e);
    await fs.unlink(output).catch(() => {});
    return false;
  }
}

// ------------------------------------------------------------
// 时长探测
// ------------------------------------------------------------

export async function probeDuration(file: string): Promise<number | null> {
  try {
    const { stdout } = await run(
      FFPROBE,
      ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      30_000
    );
    const seconds = Number(stdout.trim());
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** 校验媒体文件能否完整解码（ffmpeg 返回 0 也可能把错误写进 stderr） */
export async function validateMedia(file: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    execFile(
      FFMPEG,
      ["-v", "error", "-i", file, "-f", "null", "-"],
      { timeout: 600_000 },
      (err, _stdout, stderr) => {
        if (err || stderr.trim()) {
          reject(new Error(`码流校验失败: ${(stderr || err?.message || "unknown").slice(-400)}`));
        } else {
          resolve();
        }
      }
    );
  });
}

// ------------------------------------------------------------
// 背景音乐混流
// ------------------------------------------------------------

/**
 * 把背景音乐混进成片：视频流直接 copy（J1900 上不重编码，秒级完成），
 * 音频转 AAC 192k；音乐短于视频时循环，首尾各做淡入淡出。
 * 失败抛错，由调用方决定是否保留无声版本。
 */
export async function muxBackgroundMusic(
  video: string,
  bgm: string,
  output: string
): Promise<void> {
  const duration = await probeDuration(video);
  const fadeOutAt = duration && duration > 4 ? duration - 2 : null;
  const audioChain =
    fadeOutAt === null
      ? "[1:a]afade=t=in:st=0:d=1.5[a]"
      : `[1:a]afade=t=in:st=0:d=1.5,afade=t=out:st=${fadeOutAt.toFixed(2)}:d=2[a]`;
  await run(
    FFMPEG,
    [
      "-y",
      "-v",
      "error",
      "-i",
      video,
      "-stream_loop",
      "-1", // 音乐比片子短就一直循环
      "-i",
      bgm,
      "-filter_complex",
      audioChain,
      "-map",
      "0:v",
      "-map",
      "[a]",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "192k",
      "-shortest", // 以视频长度为准，音乐多出来的截掉
      "-movflags",
      "+faststart",
      output,
    ],
    900_000
  );
}
