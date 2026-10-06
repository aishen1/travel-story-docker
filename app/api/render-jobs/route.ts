// ============================================================
// 渲染任务状态：GET/POST/PATCH/DELETE /api/render-jobs
//
// 逐帧渲染的帧存在浏览器里，刷新页面无法续渲；这个接口记录的是
// 「这次渲染跑到哪、怎么结束的」——让中断可见（而不是无声消失）、
// 残留帧可清。录制页打开时读一次，据此提示上次的渲染结果。
//
//   GET    ?tripId=<id>            列出该行程的渲染任务（最多 20 条，新的在前）
//   POST   body {tripId,tripName,total,format,quality,fps}  新建，返回 {id}
//   PATCH  ?id=<jobId> body {rendered,total,phase,status,file,url,size,error}
//   DELETE ?id=<jobId> | ?tripId=<id>  删除任务记录（并可清孤儿帧目录）
// ============================================================

import { NextRequest } from "next/server";
import {
  cleanupStaleFrameDirs,
  deleteJobs,
  isTripId,
  listJobs,
  readJob,
  writeJob,
  type RenderJob,
} from "@/lib/server/db";

export const maxDuration = 30;

const STATUSES: RenderJob["status"][] = ["running", "done", "error", "aborted"];

function clampInt(value: unknown, max: number): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), max);
}

export async function GET(req: NextRequest) {
  const tripId = req.nextUrl.searchParams.get("tripId") ?? undefined;
  try {
    const jobs = await listJobs(tripId && isTripId(tripId) ? tripId : undefined);
    // 「上次渲染」的语义：最新一条 + 仍在 running 但其实已经死了的（超过 2 分钟没更新）
    const latest = jobs[0] ?? null;
    const stale =
      latest?.status === "running" && Date.now() - latest.updatedAt > 2 * 60 * 1000;
    return Response.json({ ok: true, jobs, latest, stale: Boolean(stale) });
  } catch (e) {
    console.error("[render-jobs] 读取失败", e);
    return Response.json({ error: "list-failed" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json().catch(() => ({}));
    const tripId = String(body.tripId ?? "");
    if (!isTripId(tripId)) {
      return Response.json({ error: "invalid-trip-id" }, { status: 400 });
    }
    const now = Date.now();
    const id = `job_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const job: RenderJob = {
      id,
      tripId,
      tripName: String(body.tripName ?? "").slice(0, 80) || undefined,
      status: "running",
      phase: "prepare",
      rendered: 0,
      total: clampInt(body.total, 1_000_000),
      startedAt: now,
      updatedAt: now,
      format: typeof body.format === "string" ? body.format.slice(0, 16) : undefined,
      quality: typeof body.quality === "string" ? body.quality.slice(0, 16) : undefined,
      fps: clampInt(body.fps, 240) || undefined,
    };
    await writeJob(job);
    return Response.json({ ok: true, id, job });
  } catch (e) {
    console.error("[render-jobs] 创建失败", e);
    return Response.json({ error: "create-failed" }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  if (!id) return Response.json({ error: "missing-id" }, { status: 400 });
  try {
    const existing = await readJob(id);
    if (!existing) return Response.json({ error: "job-not-found" }, { status: 404 });
    const body = await req.json().catch(() => ({}));
    const status = STATUSES.includes(body.status) ? (body.status as RenderJob["status"]) : undefined;
    const next: RenderJob = {
      ...existing,
      rendered: body.rendered !== undefined ? clampInt(body.rendered, 10_000_000) : existing.rendered,
      total: body.total !== undefined ? clampInt(body.total, 10_000_000) : existing.total,
      phase: typeof body.phase === "string" ? body.phase.slice(0, 24) : existing.phase,
      status: status ?? existing.status,
      file: typeof body.file === "string" ? body.file.slice(0, 200) : existing.file,
      url: typeof body.url === "string" ? body.url.slice(0, 300) : existing.url,
      size: body.size !== undefined ? clampInt(body.size, 1 << 40) : existing.size,
      bgm: typeof body.bgm === "boolean" ? body.bgm : existing.bgm,
      clips: body.clips !== undefined ? clampInt(body.clips, 500) : existing.clips,
      error: typeof body.error === "string" ? body.error.slice(0, 500) : existing.error,
      updatedAt: Date.now(),
    };
    await writeJob(next);
    return Response.json({ ok: true, job: next });
  } catch (e) {
    console.error("[render-jobs] 更新失败", e);
    return Response.json({ error: "update-failed" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id") ?? "";
  const tripId = req.nextUrl.searchParams.get("tripId") ?? "";
  try {
    const removed = await deleteJobs(
      id ? { id } : tripId && isTripId(tripId) ? { tripId } : undefined
    );
    // 「清理」语义：把这次渲染留下的孤儿帧目录一并清掉（不限 24 小时）
    const purged = await cleanupStaleFrameDirs(0).catch(() => 0);
    return Response.json({ ok: true, removed, framesPurged: purged });
  } catch (e) {
    console.error("[render-jobs] 删除失败", e);
    return Response.json({ error: "delete-failed" }, { status: 500 });
  }
}
