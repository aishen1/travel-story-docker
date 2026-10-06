// ============================================================
// Travel Story — 服务端持久化（仅服务端可用）
//
// 轻量后端的存储层：项目根 data/ 目录下的平面文件。
//   data/trips.json      全部行程（整库读写，单用户量级足够）
//   data/media/<id>      素材二进制（图片/视频）+ <id>.json 元数据
//   data/recordings/     生成的纪录片视频
// 行程写库用「写临时文件 + rename」保证原子性，防止中途断电写坏。
// 将来换 PostgreSQL/S3 时只改这一层，API 路由不动。
// ============================================================

import { promises as fs } from "fs";
import { randomUUID } from "node:crypto";
import path from "path";

export const DATA_DIR = path.join(process.cwd(), "data");
const TRIPS_FILE = path.join(DATA_DIR, "trips.json");
const MEDIA_DIR = path.join(DATA_DIR, "media");
export const RECORDINGS_DIR = path.join(DATA_DIR, "recordings");

async function writeFileAtomic(file: string, data: string | Buffer): Promise<void> {
  const tmp = `${file}.${process.pid}-${randomUUID()}.tmp`;
  try {
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, file);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function ensureDirs() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.mkdir(MEDIA_DIR, { recursive: true });
  await fs.mkdir(RECORDINGS_DIR, { recursive: true });
}

// ------------------------------------------------------------
// 行程库（整库 JSON）
// ------------------------------------------------------------

export async function readTripsDB(): Promise<{ trips: unknown[] }> {
  try {
    const raw = await fs.readFile(TRIPS_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    return { trips: Array.isArray(parsed.trips) ? parsed.trips : [] };
  } catch {
    return { trips: [] };
  }
}

export async function writeTripsDB(db: { trips: unknown[] }): Promise<void> {
  await ensureDirs();
  await writeFileAtomic(TRIPS_FILE, JSON.stringify(db));
}

// ------------------------------------------------------------
// 素材二进制
// ------------------------------------------------------------

export interface MediaSidecar {
  contentType: string;
  name: string;
}

const safeId = (id: string) => {
  // 只允许字母数字下划线连字符，防目录穿越
  if (!/^[\w-]+$/.test(id)) throw new Error(`非法素材 id: ${id}`);
  return id;
};

export function mediaPath(id: string) {
  return path.join(MEDIA_DIR, safeId(id));
}

function sidecarPath(id: string) {
  return path.join(MEDIA_DIR, `${safeId(id)}.json`);
}

/** 素材元数据边车路径（导出/导入要用） */
export function mediaSidecarPath(id: string) {
  return sidecarPath(id);
}

export const TMP_DIR = path.join(DATA_DIR, "tmp");

/** 清掉临时目录里超过 maxAgeMs 的临时文件（导出的 zip 等） */
export async function cleanupOldTmpFiles(maxAgeMs = 2 * 60 * 60 * 1000): Promise<number> {
  const dirents = await fs.readdir(TMP_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  let removed = 0;
  for (const d of dirents) {
    if (!d.isFile()) continue;
    const full = path.join(TMP_DIR, d.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || now - stat.mtimeMs < maxAgeMs) continue;
    await fs.unlink(full).catch(() => {});
    removed += 1;
  }
  return removed;
}

export async function writeMedia(id: string, buf: Buffer, meta: MediaSidecar): Promise<void> {
  await ensureDirs();
  await writeFileAtomic(mediaPath(id), buf);
  await writeFileAtomic(sidecarPath(id), JSON.stringify(meta));
}

export async function readMedia(
  id: string
): Promise<{ buf: Buffer; meta: MediaSidecar } | null> {
  try {
    const buf = await fs.readFile(mediaPath(id));
    let meta: MediaSidecar = { contentType: "application/octet-stream", name: id };
    try {
      meta = JSON.parse(await fs.readFile(sidecarPath(id), "utf-8"));
    } catch {
      // 元数据丢了也能出流
    }
    return { buf, meta };
  } catch {
    return null;
  }
}

export async function deleteMedia(id: string): Promise<void> {
  await fs.unlink(mediaPath(id)).catch(() => {});
  await fs.unlink(sidecarPath(id)).catch(() => {});
  await fs.unlink(thumbPath(id)).catch(() => {});
}

// ------------------------------------------------------------
// 素材缩略图（长边 1280 的 JPEG）
//
// 原图动辄 10MB（手机 4000×3000），规划页一屏几十张直接拉原图会卡；
// 列表只读缩略图，成片仍用原图。老的素材没有缩略图时由路由回落到原图。
// ------------------------------------------------------------

export function thumbPath(id: string) {
  return path.join(MEDIA_DIR, `${safeId(id)}-thumb.jpg`);
}

export async function readMediaThumb(id: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(thumbPath(id));
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// 背景音乐（每行程一段：data/bgm/<tripId>.<ext> + <tripId>.json）
// ------------------------------------------------------------

export const BGM_DIR = path.join(DATA_DIR, "bgm");

export const isTripId = (value: string): boolean => /^[\w-]{1,64}$/.test(value);

const safeTripId = (id: string) => {
  if (!isTripId(id)) throw new Error(`非法行程 id: ${id}`);
  return id;
};

export interface BgmSidecar {
  name: string;
  ext: string;
  contentType: string;
  size: number;
  createdAt: number;
}

function bgmSidecarPath(tripId: string) {
  return path.join(BGM_DIR, `${safeTripId(tripId)}.json`);
}

/** 写入背景音乐；同一行程换文件时清掉旧扩展名的残留 */
export async function writeBgm(
  tripId: string,
  buf: Buffer,
  meta: BgmSidecar
): Promise<void> {
  await ensureDirs();
  await fs.mkdir(BGM_DIR, { recursive: true });
  const id = safeTripId(tripId);
  const keep = `${id}.${meta.ext}`;
  const entries = await fs.readdir(BGM_DIR).catch(() => [] as string[]);
  await Promise.all(
    entries
      .filter((f) => f.startsWith(`${id}.`) && f !== keep && !f.endsWith(".json"))
      .map((f) => fs.unlink(path.join(BGM_DIR, f)).catch(() => {}))
  );
  await writeFileAtomic(path.join(BGM_DIR, keep), buf);
  await writeFileAtomic(bgmSidecarPath(id), JSON.stringify(meta));
}

/** 查该行程的背景音乐（元数据优先，元数据丢了就按文件名兜底） */
export async function findBgm(
  tripId: string
): Promise<{ path: string; meta: BgmSidecar } | null> {
  if (!isTripId(tripId)) return null;
  const prefix = `${tripId}.`;
  const entries = await fs.readdir(BGM_DIR).catch(() => [] as string[]);
  const audio = entries.filter((f) => f.startsWith(prefix) && !f.endsWith(".json")).sort();
  if (!audio.length) return null;
  const file = audio[0];
  let meta: BgmSidecar = {
    name: file.slice(prefix.length),
    ext: path.extname(file).slice(1),
    contentType: "audio/mpeg",
    size: 0,
    createdAt: 0,
  };
  try {
    meta = { ...meta, ...JSON.parse(await fs.readFile(bgmSidecarPath(tripId), "utf-8")) };
  } catch {
    // 元数据丢了也能混流
  }
  return { path: path.join(BGM_DIR, file), meta };
}

export async function readBgm(
  tripId: string
): Promise<{ buf: Buffer; meta: BgmSidecar } | null> {
  const found = await findBgm(tripId);
  if (!found) return null;
  try {
    return { buf: await fs.readFile(found.path), meta: found.meta };
  } catch {
    return null;
  }
}

export async function deleteBgm(tripId: string): Promise<void> {
  const found = await findBgm(tripId);
  if (found) await fs.unlink(found.path).catch(() => {});
  await fs.unlink(bgmSidecarPath(tripId)).catch(() => {});
}

// ------------------------------------------------------------
// 成片（纪录片）清单
//
// 每部片子配一份同名 .json 边车（记录 tripId/时长/是否混了音乐），
// 这样「成片库」不必解析文件名就能按行程归档——老的片子没有边车，
// 由 listRecordings 用行程名匹配文件名兜底。
// ------------------------------------------------------------

export interface RecordingSidecar {
  tripId?: string;
  tripName?: string;
  fps?: number;
  width?: number;
  height?: number;
  /** 秒 */
  duration?: number;
  bgm?: boolean;
  /** 混入的现场原声段数 */
  clips?: number;
  /** 是否生成了海报（首帧封面） */
  poster?: boolean;
  /** 该片的源帧数（逐帧渲染路径记录） */
  frames?: number;
  createdAt?: number;
}

export const isRecordingFile = (name: string): boolean =>
  !name.startsWith(".") && /\.(mp4|webm)$/i.test(name);

function recordingSidecarPath(file: string) {
  const base = path.basename(file).replace(/\.(mp4|webm)$/i, "");
  return path.join(RECORDINGS_DIR, `${base}.json`);
}

export async function writeRecordingSidecar(
  file: string,
  meta: RecordingSidecar
): Promise<void> {
  await writeFileAtomic(recordingSidecarPath(file), JSON.stringify(meta));
}

export async function readRecordingSidecar(file: string): Promise<RecordingSidecar> {
  try {
    return JSON.parse(await fs.readFile(recordingSidecarPath(file), "utf-8"));
  } catch {
    return {};
  }
}

export async function deleteRecording(file: string): Promise<boolean> {
  const name = path.basename(file);
  if (name !== file || !isRecordingFile(name)) return false;
  let existed = true;
  await fs.unlink(path.join(RECORDINGS_DIR, name)).catch(() => {
    existed = false;
  });
  await fs.unlink(recordingSidecarPath(name)).catch(() => {});
  // 成片海报（首帧）一并清掉
  await fs.unlink(posterPath(name)).catch(() => {});
  return existed;
}

/** 成片海报：<名字>-poster.jpg，成片库里当封面用 */
export function posterPath(file: string) {
  const base = path.basename(file).replace(/\.(mp4|webm)$/i, "");
  return path.join(RECORDINGS_DIR, `${base}-poster.jpg`);
}

// ------------------------------------------------------------
// 渲染任务（每行程最近一次出片的状态，供录制页显示/中断可见）
//
// 逐帧渲染的帧在浏览器里，刷新后无法续渲；这里记录的是「这次渲染
// 跑到哪、怎么结束的」，让中断可见、残留帧可清，而不是无声消失。
// ------------------------------------------------------------

export const JOBS_DIR = path.join(DATA_DIR, "jobs");

export interface RenderJob {
  id: string;
  tripId?: string;
  tripName?: string;
  status: "running" | "done" | "error" | "aborted";
  phase?: string;
  rendered: number;
  total: number;
  startedAt: number;
  updatedAt: number;
  file?: string;
  url?: string;
  size?: number;
  bgm?: boolean;
  clips?: number;
  format?: string;
  quality?: string;
  fps?: number;
  error?: string;
}

const jobPath = (id: string) => path.join(JOBS_DIR, `${safeJobId(id)}.json`);

const safeJobId = (id: string) => {
  if (!/^[\w-]{1,64}$/.test(id)) throw new Error(`非法任务 id: ${id}`);
  return id;
};

export async function writeJob(job: RenderJob): Promise<void> {
  await ensureDirs();
  await fs.mkdir(JOBS_DIR, { recursive: true });
  await writeFileAtomic(jobPath(job.id), JSON.stringify(job));
}

export async function readJob(id: string): Promise<RenderJob | null> {
  try {
    return JSON.parse(await fs.readFile(jobPath(id), "utf-8"));
  } catch {
    return null;
  }
}

export async function listJobs(tripId?: string): Promise<RenderJob[]> {
  const dirents = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  const out: RenderJob[] = [];
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith(".json")) continue;
    const job = await readJob(d.name.replace(/\.json$/, ""));
    if (!job) continue;
    if (tripId && job.tripId !== tripId) continue;
    out.push(job);
  }
  out.sort((a, b) => b.startedAt - a.startedAt);
  return out.slice(0, 20);
}

export async function deleteJobs(filter?: { id?: string; tripId?: string }): Promise<number> {
  const dirents = await fs.readdir(JOBS_DIR, { withFileTypes: true }).catch(() => []);
  let removed = 0;
  for (const d of dirents) {
    if (!d.isFile() || !d.name.endsWith(".json")) continue;
    const id = d.name.replace(/\.json$/, "");
    if (filter?.id) {
      if (id !== filter.id) continue;
    } else if (filter?.tripId) {
      const job = await readJob(id);
      if (!job || job.tripId !== filter.tripId) continue;
    }
    await fs.unlink(path.join(JOBS_DIR, d.name)).catch(() => {});
    removed += 1;
  }
  return removed;
}

// ------------------------------------------------------------
// 孤儿帧目录清理
//
// 逐帧渲染会把 JPEG 帧攒在 data/recordings/frames-<会话>/，正常结束由
// finalize 删掉；但渲染中途关页面 / 浏览器崩了就没有人删，几十上百 MB
// 会一直留在盘上。这里按「最后修改时间超过 maxAgeMs」判定为孤儿。
// ------------------------------------------------------------

export async function cleanupStaleFrameDirs(maxAgeMs = 24 * 60 * 60 * 1000): Promise<number> {
  const dirents = await fs.readdir(RECORDINGS_DIR, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  let removed = 0;
  for (const d of dirents) {
    if (!d.isDirectory() || !d.name.startsWith("frames-")) continue;
    const full = path.join(RECORDINGS_DIR, d.name);
    const stat = await fs.stat(full).catch(() => null);
    if (!stat || now - stat.mtimeMs < maxAgeMs) continue;
    await fs.rm(full, { recursive: true, force: true }).catch(() => {});
    removed += 1;
  }
  return removed;
}

export interface RecordingEntry extends RecordingSidecar {
  file: string;
  url: string;
  size: number;
  mtime: number;
}

export async function listRecordings(
  filter?: { tripId?: string; tripName?: string }
): Promise<RecordingEntry[]> {
  await ensureDirs();
  const dirents = await fs.readdir(RECORDINGS_DIR, { withFileTypes: true }).catch(() => []);
  const out: RecordingEntry[] = [];
  for (const dirent of dirents) {
    if (!dirent.isFile() || !isRecordingFile(dirent.name)) continue;
    const stat = await fs.stat(path.join(RECORDINGS_DIR, dirent.name)).catch(() => null);
    if (!stat) continue;
    const meta = await readRecordingSidecar(dirent.name);
    out.push({
      ...meta,
      file: dirent.name,
      url: `/api/recordings/${encodeURIComponent(dirent.name)}`,
      size: stat.size,
      mtime: stat.mtimeMs,
    });
  }
  out.sort((a, b) => b.mtime - a.mtime);
  if (!filter?.tripId) return out;
  // 没边车的老片子按文件名里的行程名兜底
  const needle = filter.tripName
    ? filter.tripName.replace(/[\\/:*?"<>|\s]+/g, "-").slice(0, 40)
    : "";
  return out.filter(
    (e) => e.tripId === filter.tripId || (!e.tripId && needle && e.file.includes(needle))
  );
}
