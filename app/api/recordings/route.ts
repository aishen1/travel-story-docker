// 纪录片视频接口
//   GET    /api/recordings?tripId=<行程id>&trip=<行程名>   列出成片（成片库）
//   POST   /api/recordings?trip=<行程名>&ext=<webm|mp4>&tripId=<行程id>
//          body 为浏览器录制的视频字节；webm 一律用 ffmpeg 转码成 mp4（H.264）；
//          该行程配了背景音乐就混进去（音乐流直接 copy，不重编码）。
//   DELETE /api/recordings?file=<文件名>                    删除成片
import { NextRequest } from "next/server";
import { execFile } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import {
  cleanupStaleFrameDirs,
  deleteRecording,
  ensureDirs,
  listRecordings,
  RECORDINGS_DIR,
  writeRecordingSidecar,
} from "@/lib/server/db";
import { finishFilm, parseAudioPlan } from "@/lib/server/filmFinish";
import { probeDuration, validateMedia } from "@/lib/server/mediaTools";
import {
  RequestTooLargeError,
  getLimitBytes,
  isAllowedVideoType,
  readBodyWithinLimit,
} from "@/lib/server/requestSafety";

export const maxDuration = 300; // 长视频转码需要时间
const MAX_BODY_BYTES = getLimitBytes(process.env.MAX_RECORDING_UPLOAD_MB, 512);

function transcodeToMp4(input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-y",
        "-i",
        input,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        // 默认 CRF 23 对地图线条/照片细节糊得明显，压到 18 保画质
        "-crf",
        "18",
        "-pix_fmt",
        "yuv420p",
        "-color_range",
        "tv", // JPEG 来源是全范围，不显式指定会被带成 yuvj420p/pc，部分播放器发灰
        "-movflags",
        "+faststart",
        output,
      ],
      // 原 240_000：veryfast 在 J1900 上转 1080p/3min 素材会逼近上限，抬到 10 分钟
      { timeout: 600_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg 转码失败: ${stderr.slice(-400)}`));
        else resolve();
      }
    );
  });
}

/**
 * 该行程配了背景音乐 / 带现场原声就混进成片：先写临时文件，校验通过才替换
 * 原片，任何一步失败都保留无声版本（宁缺音乐，不可丢片子）。
 */
async function applyAudio(
  filePath: string,
  tripId: string,
  clips: ReturnType<typeof parseAudioPlan>
) {
  if (!tripId && !clips.length) {
    return { bgm: false, clips: 0, poster: false, skipped: 0 };
  }
  return finishFilm({ filePath, file: path.basename(filePath), tripId: tripId || undefined, clips });
}

export async function GET(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get("tripId") ?? undefined;
  const tripName = req.nextUrl.searchParams.get("trip") ?? undefined;
  try {
    // 顺手清掉渲染中途挂掉留下的孤儿帧目录（>24h），别让它一直占盘
    const purged = await cleanupStaleFrameDirs().catch(() => 0);
    if (purged) console.log(`[recordings] 清理孤儿帧目录 ${purged} 个`);
    const files = await listRecordings(tripId ? { tripId, tripName } : undefined);
    return Response.json({ ok: true, files });
  } catch (e) {
    console.error("[recordings] 列出成片失败", e);
    return Response.json({ error: "list-failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const file = req.nextUrl.searchParams.get("file") ?? "";
  try {
    const ok = await deleteRecording(file);
    return ok
      ? Response.json({ ok: true })
      : Response.json({ error: "not-found-or-invalid" }, { status: 404 });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const tripName = (req.nextUrl.searchParams.get("trip") ?? "纪录片").trim() || "纪录片";
    const tripId = req.nextUrl.searchParams.get("tripId") ?? "";
    const extParam = req.nextUrl.searchParams.get("ext");
    if (extParam !== "mp4" && extParam !== "webm") {
      return Response.json({ error: "invalid-video-extension" }, { status: 400 });
    }
    const ext = extParam;
    const contentType = req.headers.get("content-type") ?? "";
    if (!isAllowedVideoType(contentType, ext)) {
      return Response.json({ error: "unsupported-video-type" }, { status: 400 });
    }
    const buf = await readBodyWithinLimit(req, MAX_BODY_BYTES);
    if (!buf.length) return Response.json({ error: "empty-video" }, { status: 400 });

    await ensureDirs();
    // 文件名：时间戳 + 清洗后的行程名
    const safeName = tripName.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
    const ts = new Date().toISOString().slice(0, 19).replace(/[T:]/g, "").replace(/-/g, "");
    const base = `${ts}-${safeName}`;
    const rawPath = path.join(RECORDINGS_DIR, `${base}.${ext}`);
    await fs.writeFile(rawPath, buf);

    let finalFile = `${base}.${ext}`;
    if (ext === "mp4") {
      try {
        await validateMedia(rawPath);
      } catch (e) {
        await fs.unlink(rawPath).catch(() => {});
        console.warn("[recordings] 拒绝损坏 MP4", e);
        return Response.json({ error: "invalid-video-stream" }, { status: 422 });
      }
    } else {
      // 浏览器给的是 webm → 转成通用 mp4
      const mp4Path = path.join(RECORDINGS_DIR, `${base}.mp4`);
      try {
        await transcodeToMp4(rawPath, mp4Path);
        await fs.unlink(rawPath);
        finalFile = `${base}.mp4`;
      } catch (e) {
        // 转码失败不丢原片：保留 webm 照常返回
        console.warn("[recordings] 转码失败，保留 webm", e);
      }
    }

    const fullPath = path.join(RECORDINGS_DIR, finalFile);
    const clips = parseAudioPlan(req.headers.get("x-film-audio"));
    const audio = await applyAudio(fullPath, tripId, clips);
    const stat = await fs.stat(fullPath);
    await writeRecordingSidecar(finalFile, {
      tripId: tripId || undefined,
      tripName,
      duration: (await probeDuration(fullPath)) ?? undefined,
      bgm: audio.bgm,
      clips: audio.clips,
      poster: audio.poster,
      createdAt: Date.now(),
    });
    return Response.json({
      ok: true,
      file: finalFile,
      url: `/api/recordings/${finalFile}`,
      size: stat.size,
      bgm: audio.bgm,
      clips: audio.clips,
      poster: audio.poster,
    });
  } catch (e) {
    if (e instanceof RequestTooLargeError) {
      return Response.json({ error: "request-too-large" }, { status: 413 });
    }
    console.error("[recordings] 录像写入失败", e);
    return Response.json({ error: "recording-failed" }, { status: 500 });
  }
}
