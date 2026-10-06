// 行程导出：GET /api/export?tripId=<行程id>
//
// 产出一个 zip：行程 JSON + 该行程的全部素材（含元数据边车）+ 背景音乐。
// 拷到别的机器 / 留个档都能用（用 /api/import 导回）。
// zip 先写到 data/tmp 再流式回给浏览器（素材几百 MB，不能整个读进内存），
// 顺带清掉两小时前的旧导出文件。
import { NextRequest } from "next/server";
import { createReadStream } from "fs";
import { promises as fs } from "fs";
import { Readable } from "stream";
import path from "path";
import {
  cleanupOldTmpFiles,
  findBgm,
  isTripId,
  mediaPath,
  mediaSidecarPath,
  readTripsDB,
  TMP_DIR,
} from "@/lib/server/db";
import { writeZip, type ZipSource } from "@/lib/server/zip";

export const maxDuration = 300;

export async function GET(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get("tripId") ?? "";
  if (!isTripId(tripId)) {
    return Response.json({ error: "invalid-trip-id" }, { status: 400 });
  }
  const db = await readTripsDB();
  const trip = (db.trips as Record<string, unknown>[]).find((t) => t.id === tripId);
  if (!trip) return Response.json({ error: "行程不存在" }, { status: 404 });

  // 收集素材 id（导出的是「这个行程用到的」，不是整个媒体库）
  const ids = new Set<string>();
  for (const stop of (trip.stops as { media?: { id?: string }[] }[]) ?? []) {
    for (const m of stop.media ?? []) {
      if (typeof m?.id === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(m.id)) ids.add(m.id);
    }
  }

  const sources: ZipSource[] = [
    {
      name: "trip.json",
      data: Buffer.from(
        JSON.stringify(
          {
            format: "travel-story/trip",
            version: 1,
            exportedAt: new Date().toISOString(),
            trip,
          },
          null,
          2
        ),
        "utf-8"
      ),
    },
  ];
  for (const id of ids) {
    sources.push({ name: `media/${id}`, path: mediaPath(id) });
    sources.push({ name: `media/${id}.json`, path: mediaSidecarPath(id) });
  }
  const bgm = await findBgm(tripId);
  if (bgm) {
    const ext = bgm.meta.ext || "mp3";
    sources.push({ name: `bgm/${tripId}.${ext}`, path: bgm.path });
    sources.push({
      name: `bgm/${tripId}.json`,
      data: Buffer.from(JSON.stringify(bgm.meta), "utf-8"),
    });
  }

  try {
    await fs.mkdir(TMP_DIR, { recursive: true });
    await cleanupOldTmpFiles().catch(() => 0);
    const outPath = path.join(TMP_DIR, `export-${tripId}-${Date.now()}.zip`);
    const { size, count, skipped } = await writeZip(outPath, sources);
    console.log(
      `[export] ${tripId} → ${count} 个条目 / ${(size / 1024 / 1024).toFixed(1)}MB` +
        (skipped.length ? `（跳过 ${skipped.length} 个缺失文件）` : "")
    );
    const name = String(trip.name ?? "行程").replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40);
    const stream = Readable.toWeb(createReadStream(outPath)) as ReadableStream<Uint8Array>;
    return new Response(stream, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Length": String(size),
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(`${name}-导出.zip`)}`,
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[export] 导出失败", e);
    return Response.json({ error: "export-failed", detail: String(e).slice(0, 200) }, { status: 500 });
  }
}
