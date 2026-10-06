// ============================================================
// 背景音乐：GET /api/bgm?tripId=<id>          读音频（支持 Range，可试听）
//                  ?tripId=<id>&info=1        只查信息（是否存在/文件名/大小）
//           POST  /api/bgm?tripId=<id>        上传/替换（body 为音频字节）
//           DELETE /api/bgm?tripId=<id>       删除
//
// 每行程一段，存 data/bgm/<tripId>.<ext>。成片合成时由服务端 ffmpeg
// 混进 MP4（音乐短则循环、首尾淡入淡出），见 lib/server/mediaTools.ts。
// ============================================================

import { NextRequest } from "next/server";
import { deleteBgm, findBgm, isTripId, readBgm, writeBgm } from "@/lib/server/db";
import {
  RequestTooLargeError,
  getLimitBytes,
  readBodyWithinLimit,
  safeDisplayName,
} from "@/lib/server/requestSafety";

const MAX_BODY_BYTES = getLimitBytes(process.env.MAX_BGM_UPLOAD_MB, 30);

/** 允许的音频类型 → 落盘扩展名 */
const AUDIO_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/m4a": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/webm": "weba",
};

const FALLBACK_EXT = ["mp3", "m4a", "aac", "wav", "ogg", "opus", "flac", "weba"];

/** 浏览器对音频的 content-type 可能为空（比如 .m4a），按扩展名兜底 */
function resolveExt(contentType: string, fileName: string): string | null {
  const type = contentType.split(";", 1)[0].trim().toLowerCase();
  if (AUDIO_EXT[type]) return AUDIO_EXT[type];
  if (type === "application/octet-stream" || type === "binary/octet-stream") {
    const ext = /\.([a-z0-9]{2,4})$/i.exec(fileName)?.[1]?.toLowerCase();
    return ext && FALLBACK_EXT.includes(ext) ? ext : null;
  }
  return null;
}

function badTrip() {
  return Response.json({ error: "invalid-trip-id" }, { status: 400 });
}

export async function GET(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get("tripId") ?? "";
  if (!isTripId(tripId)) return badTrip();
  const found = await findBgm(tripId);
  if (!found) {
    if (req.nextUrl.searchParams.get("info") === "1") {
      return Response.json({ ok: true, exists: false });
    }
    return Response.json({ error: "背景音乐不存在" }, { status: 404 });
  }
  if (req.nextUrl.searchParams.get("info") === "1") {
    return Response.json({
      ok: true,
      exists: true,
      name: found.meta.name,
      size: found.meta.size,
      ext: found.meta.ext,
    });
  }
  const read = await readBgm(tripId);
  if (!read) return Response.json({ error: "背景音乐不存在" }, { status: 404 });

  const { buf, meta } = read;
  const contentType = meta.contentType || "audio/mpeg";
  const total = buf.length;
  const headers = {
    "Content-Type": contentType,
    "Accept-Ranges": "bytes",
    "Cache-Control": "private, max-age=3600",
  };

  // 试听时浏览器会发 Range，支持一下（<audio> 拖动进度条）
  const range = req.headers.get("range");
  const m = range ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
  if (m) {
    const start = m[1] ? parseInt(m[1], 10) : 0;
    const end = m[2] ? Math.min(parseInt(m[2], 10), total - 1) : total - 1;
    if (start <= end && start < total) {
      return new Response(new Uint8Array(buf.subarray(start, end + 1)), {
        status: 206,
        headers: {
          ...headers,
          "Content-Range": `bytes ${start}-${end}/${total}`,
          "Content-Length": String(end - start + 1),
        },
      });
    }
  }
  return new Response(new Uint8Array(buf), {
    headers: { ...headers, "Content-Length": String(total) },
  });
}

export async function POST(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get("tripId") ?? "";
  if (!isTripId(tripId)) return badTrip();
  const contentType = req.headers.get("content-type") ?? "";
  const rawName = req.nextUrl.searchParams.get("name") ?? "";
  const name = safeDisplayName(rawName, "背景音乐");
  const ext = resolveExt(contentType, rawName);
  if (!ext) {
    return Response.json({ error: "unsupported-audio-type" }, { status: 400 });
  }
  try {
    const buf = await readBodyWithinLimit(req, MAX_BODY_BYTES);
    if (!buf.length) return Response.json({ error: "empty-file" }, { status: 400 });
    await writeBgm(tripId, buf, {
      name,
      ext,
      contentType: contentType || "audio/mpeg",
      size: buf.length,
      createdAt: Date.now(),
    });
    return Response.json({ ok: true, name, ext, size: buf.length });
  } catch (e) {
    if (e instanceof RequestTooLargeError) {
      return Response.json({ error: "request-too-large" }, { status: 413 });
    }
    console.error("[bgm] 上传失败", e);
    return Response.json({ error: "bgm-upload-failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get("tripId") ?? "";
  if (!isTripId(tripId)) return badTrip();
  try {
    await deleteBgm(tripId);
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ error: String(e) }, { status: 400 });
  }
}
