// 行程导入：POST /api/import（body 为 /api/export 产出的 zip）
//
// 素材二进制与元数据边车都从 zip 里恢复；边车缺失时按文件头猜类型，
// 保证导进来的图片/视频能正常显示。行程 id 与已有行程冲突时另起一个
// id（不覆盖现有行程），素材 id 保持不变（内容是同一份，可重复导入）。
import { NextRequest } from "next/server";
import {
  ensureDirs,
  isTripId,
  readTripsDB,
  writeBgm,
  writeMedia,
  writeTripsDB,
  type BgmSidecar,
  type MediaSidecar,
} from "@/lib/server/db";
import {
  RequestTooLargeError,
  getLimitBytes,
  readBodyWithinLimit,
} from "@/lib/server/requestSafety";
import { readZip } from "@/lib/server/zip";

export const maxDuration = 300;

const MAX_BODY_BYTES = getLimitBytes(process.env.MAX_IMPORT_MB, 2048);

/** 按文件头猜素材类型（zip 里没有边车时的兜底） */
function sniffContentType(buf: Buffer): { contentType: string; kind: "image" | "video" } {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { contentType: "image/jpeg", kind: "image" };
  }
  if (buf.length > 8 && buf.toString("latin1", 1, 4) === "PNG") {
    return { contentType: "image/png", kind: "image" };
  }
  if (buf.length > 12 && buf.toString("latin1", 4, 8) === "ftyp") {
    const brand = buf.toString("latin1", 8, 12).toLowerCase();
    if (brand.startsWith("he") || brand === "mif1" || brand === "avif") {
      return { contentType: "image/heic", kind: "image" };
    }
    return { contentType: "video/mp4", kind: "video" };
  }
  if (buf.length > 4 && buf.readUInt32BE(0) === 0x1a45dfa3) {
    return { contentType: "video/webm", kind: "video" };
  }
  return { contentType: "application/octet-stream", kind: "video" };
}

export async function POST(req: NextRequest) {
  try {
    const buf = await readBodyWithinLimit(req, MAX_BODY_BYTES);
    if (!buf.length) return Response.json({ error: "empty-body" }, { status: 400 });

    let entries;
    try {
      entries = readZip(buf);
    } catch (e) {
      return Response.json(
        { error: "invalid-zip", detail: String(e).slice(0, 200) },
        { status: 400 }
      );
    }

    const tripEntry = entries.find((e) => e.name === "trip.json" || e.name.endsWith("/trip.json"));
    if (!tripEntry) {
      return Response.json({ error: "missing-trip-json" }, { status: 400 });
    }
    let parsed: Record<string, unknown>;
    try {
      const json = JSON.parse(tripEntry.data.toString("utf-8"));
      parsed = (json?.trip ?? json) as Record<string, unknown>;
    } catch {
      return Response.json({ error: "invalid-trip-json" }, { status: 400 });
    }
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !Array.isArray(parsed.days) ||
      !Array.isArray(parsed.stops) ||
      !Array.isArray(parsed.segments)
    ) {
      return Response.json({ error: "invalid-trip-shape" }, { status: 400 });
    }

    await ensureDirs();
    const db = await readTripsDB();
    const trips = db.trips as Record<string, unknown>[];
    const existing = new Set(trips.map((t) => String(t.id)));
    const oldTripId = String(parsed.id ?? "");
    let newTripId = oldTripId;
    if (!isTripId(newTripId) || existing.has(newTripId)) {
      newTripId = `trip_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }
    parsed.id = newTripId;
    parsed.name = String(parsed.name ?? "导入的行程").slice(0, 80);

    // ---- 素材：二进制 + 元数据边车 ----
    const sidecars = new Map<string, MediaSidecar>();
    for (const e of entries) {
      if (!e.name.endsWith(".json")) continue;
      if (!e.name.startsWith("media/")) continue;
      const id = e.name.slice("media/".length, -".json".length);
      try {
        const meta = JSON.parse(e.data.toString("utf-8"));
        if (meta && typeof meta.contentType === "string") sidecars.set(id, meta);
      } catch {
        // 边车坏了就当没有，下面按文件头猜
      }
    }

    let mediaWritten = 0;
    for (const e of entries) {
      if (!e.name.startsWith("media/") || e.name.endsWith(".json")) continue;
      const id = e.name.slice("media/".length);
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) continue;
      const meta =
        sidecars.get(id) ??
        (() => {
          const sniffed = sniffContentType(e.data);
          return { contentType: sniffed.contentType, name: id };
        })();
      await writeMedia(id, e.data, meta);
      mediaWritten += 1;
    }

    // ---- 背景音乐：文件名里的 id 换成本次导入的 id ----
    const bgmEntry = entries.find((e) => /^bgm\/[^/]+\.[a-z0-9]+$/i.test(e.name));
    let bgmRestored = false;
    if (bgmEntry) {
      const ext = bgmEntry.name.split(".").pop() ?? "mp3";
      const bgmMetaEntry = entries.find((e) => e.name.startsWith("bgm/") && e.name.endsWith(".json"));
      let meta: BgmSidecar = {
        name: `background.${ext}`,
        ext,
        contentType: ext === "mp3" ? "audio/mpeg" : "audio/mp4",
        size: bgmEntry.data.length,
        createdAt: Date.now(),
      };
      if (bgmMetaEntry) {
        try {
          meta = { ...meta, ...JSON.parse(bgmMetaEntry.data.toString("utf-8")) };
        } catch {
          // 用兜底元数据
        }
      }
      await writeBgm(newTripId, bgmEntry.data, meta);
      bgmRestored = true;
    }

    trips.push(parsed);
    await writeTripsDB({ trips });

    console.log(
      `[import] 行程「${String(parsed.name)}」→ ${newTripId}（素材 ${mediaWritten} 份，背景音乐=${bgmRestored}）`
    );
    return Response.json({
      ok: true,
      tripId: newTripId,
      name: parsed.name,
      media: mediaWritten,
      bgm: bgmRestored,
      renamed: newTripId !== oldTripId,
    });
  } catch (e) {
    if (e instanceof RequestTooLargeError) {
      return Response.json({ error: "request-too-large" }, { status: 413 });
    }
    console.error("[import] 导入失败", e);
    return Response.json({ error: "import-failed" }, { status: 500 });
  }
}
