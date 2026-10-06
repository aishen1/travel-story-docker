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

/** 成片海报（首帧，宽 640）：成片库当封面用 */
export async function makePoster(video: string, output: string): Promise<boolean> {
  const tail = ["-vf", "scale=640:-2", "-frames:v", "1", "-q:v", "4"];
  const attempt = async (withSeek: boolean) => {
    await run(
      FFMPEG,
      ["-y", "-v", "error", ...(withSeek ? ["-ss", "1"] : []), "-i", video, ...tail, output],
      120_000
    );
    const stat = await fs.stat(output).catch(() => null);
    return Boolean(stat?.size);
  };
  try {
    if (await attempt(true)) return true;
  } catch {
    // 片长不足 1 秒 → 退回首帧
  }
  await fs.unlink(output).catch(() => {});
  try {
    return await attempt(false);
  } catch (e) {
    console.warn("[recordings] 海报生成失败", e);
    return false;
  }
}

/** 文件里有没有音轨（没有的话混音时引用 [n:a] 会让整条命令失败） */
export async function hasAudioStream(file: string): Promise<boolean> {
  try {
    const { stdout } = await run(
      FFPROBE,
      ["-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_type", "-of", "csv=p=0", file],
      30_000
    );
    return stdout.trim().length > 0;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------
// 成片音轨：背景音乐 + 现场原声
// ------------------------------------------------------------

/** 一段现场原声在成片里的排期（由浏览器逐帧收集后传上来） */
export interface AudioClip {
  mediaId: string;
  /** 在成片时间轴上的起点（秒） */
  filmStartSec: number;
  /** 从原视频的第几秒开始取 */
  clipStartSec: number;
  /** 取多少秒 */
  clipLenSec: number;
  /** 0~2，1 为原始音量 */
  volume: number;
}

/**
 * 把背景音乐与现场原声混进成片（视频流直接 copy，不重编码）。
 *
 * 逐帧渲染通道只有画面（JPEG 帧），音轨完全由这里补上：浏览器渲染时
 * 逐帧记录「哪段视频在原片第几秒、取多长、放在成片第几秒」，服务端按
 * 这份排期把原视频的音轨 atrim 出来、volume 调好、adelay 推到对应位置，
 * 再用 amix 叠起来；有原声时背景音乐自动降到 0.35 当垫底。
 *
 * clips 里的文件必须确认有音轨（调用方用 hasAudioStream 过滤），
 * 否则 [n:a] 会让整条命令失败。
 */
export async function muxFilmAudio(
  video: string,
  opts: { clips: { path: string; clip: AudioClip }[]; bgm?: string | null; output: string }
): Promise<void> {
  const { clips, bgm, output } = opts;
  if (!clips.length && !bgm) throw new Error("没有可混入的音轨");
  const duration = await probeDuration(video);

  const args: string[] = ["-y", "-v", "error", "-i", video];
  for (const { path: clipPath, clip } of clips) {
    args.push("-ss", clip.clipStartSec.toFixed(3), "-t", clip.clipLenSec.toFixed(3), "-i", clipPath);
  }
  const bgmIndex = clips.length + 1;
  if (bgm) args.push("-stream_loop", "-1", "-i", bgm);

  const filters: string[] = [];
  const voiceLabels: string[] = [];
  clips.forEach(({ clip }, i) => {
    const len = Math.max(0.1, clip.clipLenSec);
    const fade = len > 0.8 ? 0.25 : 0;
    const chain = [
      // 片段已在输入侧用 -ss/-t 取好，这里只兜底截断时长。
      // 千万不要再写 start=<clipStartSec>：输入 seek 已把时间戳归零，
      // 二次 atrim 会把整段裁空 → 音轨为空 → -shortest 连画面一起截掉，
      // 产出一个几百字节、无任何流的空 MP4（v3 首轮验证踩过）。
      `atrim=duration=${len.toFixed(3)}`,
      "asetpts=PTS-STARTPTS",
      `volume=${clip.volume.toFixed(2)}`,
    ];
    if (fade) {
      chain.push(`afade=t=in:st=0:d=${fade}`);
      chain.push(`afade=t=out:st=${Math.max(0, len - fade).toFixed(3)}:d=${fade}`);
    }
    // adelay 把这段原声推到最后落在成片时间轴的正确位置
    chain.push(`adelay=${Math.round(Math.max(0, clip.filmStartSec) * 1000)}:all=1`);
    filters.push(`[${i + 1}:a]${chain.join(",")}[c${i}]`);
    voiceLabels.push(`c${i}`);
  });

  let mixLabel: string | null = null;
  if (voiceLabels.length === 1) {
    mixLabel = voiceLabels[0];
  } else if (voiceLabels.length > 1) {
    filters.push(
      `${voiceLabels.map((l) => `[${l}]`).join("")}amix=inputs=${voiceLabels.length}:normalize=0:dropout_transition=0[voice]`
    );
    mixLabel = "voice";
  }

  let bgmLabel: string | null = null;
  if (bgm) {
    const fadeOutAt = duration && duration > 4 ? duration - 2 : null;
    const parts = [`[${bgmIndex}:a]volume=${voiceLabels.length ? "0.35" : "1"}`, "afade=t=in:st=0:d=1.5"];
    if (fadeOutAt !== null) parts.push(`afade=t=out:st=${fadeOutAt.toFixed(2)}:d=2`);
    filters.push(`${parts.join(",")}[bg]`);
    bgmLabel = "bg";
  }

  let mixed: string;
  if (mixLabel && bgmLabel) {
    filters.push(`[${mixLabel}][${bgmLabel}]amix=inputs=2:normalize=0:dropout_transition=0[mix]`);
    mixed = "mix";
  } else {
    mixed = (mixLabel ?? bgmLabel) as string;
  }

  // apad：音轨不足片长时补静音，让 -shortest 永远以「画面长度」为准。
  // 少了这一步，一段 3 秒原声放进 30 秒成片会把成片截成 3 秒。
  filters.push(`[${mixed}]apad[afin]`);

  args.push(
    "-filter_complex",
    filters.join(";"),
    "-map",
    "0:v",
    "-map",
    "[afin]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-shortest", // 以画面长度为准（apad 保证音轨不会先结束）
    "-movflags",
    "+faststart",
    output
  );

  await run(FFMPEG, args, 900_000);
}
