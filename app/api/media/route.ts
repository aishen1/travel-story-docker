// 素材上传：POST /api/media?id=<id>&name=<原始文件名>，body 为文件字节
//
// 入库前做两件事（都可能失败，失败只降级、不上报错误）：
//   1. HEIC/HEIF → JPEG：iPhone 默认拍 HEIC，浏览器解不了、成片里也会被静默丢弃；
//   2. 生成缩略图（长边 1280）：规划页列表只读缩略图，不拉 10MB 原图。
import { NextRequest } from "next/server";
import { thumbPath, mediaPath, writeMedia } from "@/lib/server/db";
import { convertHeifToJpeg, isHeifBuffer, isHeifType, makeThumbnail } from "@/lib/server/mediaTools";
import {
  RequestTooLargeError,
  getLimitBytes,
  isAllowedMediaType,
  isMediaId,
  readBodyWithinLimit,
  safeDisplayName,
} from "@/lib/server/requestSafety";

const MAX_BODY_BYTES = getLimitBytes(process.env.MAX_MEDIA_UPLOAD_MB, 250);

export async function POST(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id || !isMediaId(id)) {
    return Response.json({ error: "invalid-media-id" }, { status: 400 });
  }
  const rawName = req.nextUrl.searchParams.get("name") ?? "";
  let name = safeDisplayName(rawName, "未命名");
  const contentType = req.headers.get("content-type") ?? "application/octet-stream";
  if (!isAllowedMediaType(contentType)) {
    return Response.json({ error: "unsupported-media-type" }, { status: 400 });
  }
  try {
    const buf = await readBodyWithinLimit(req, MAX_BODY_BYTES);
    if (!buf.length) return Response.json({ error: "empty-file" }, { status: 400 });

    // 1) HEIC/HEIF → JPEG。浏览器给 HEIC 的 content-type 可能是空（Windows 不认这个扩展名），
    //    所以除了 content-type 还要看文件头。
    let body = buf;
    let type = contentType;
    let converted = false;
    if (isHeifType(contentType) || isHeifBuffer(buf)) {
      const jpeg = await convertHeifToJpeg(buf);
      if (jpeg) {
        body = jpeg;
        type = "image/jpeg";
        name = `${name.replace(/\.(heic|heif|avif|hif)$/i, "") || "照片"}.jpg`;
        converted = true;
      } else {
        console.warn("[media] HEIC 未转换成功，按原文件入库", name);
      }
    }

    await writeMedia(id, body, { contentType: type, name });

    // 2) 缩略图
    let thumb = false;
    const kind = type.startsWith("video/")
      ? "video"
      : type.startsWith("image/")
        ? "image"
        : null;
    if (kind) {
      thumb = await makeThumbnail(mediaPath(id), thumbPath(id), kind);
    }

    return Response.json({
      ok: true,
      id,
      size: body.length,
      contentType: type,
      name,
      converted,
      thumb,
    });
  } catch (e) {
    if (e instanceof RequestTooLargeError) {
      return Response.json({ error: "request-too-large" }, { status: 413 });
    }
    console.error("[media] 上传失败", e);
    return Response.json({ error: "upload-failed" }, { status: 500 });
  }
}
