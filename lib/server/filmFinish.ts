// ============================================================
// Travel Story — 成片收尾（服务端）
//
// 两个出片通道（浏览器直传 MP4 / 逐帧序列）最后都调这里：
//   1. 混音：背景音乐 + 现场原声（浏览器渲染时逐帧收集的排期）；
//   2. 海报：抽首帧当封面，成片库用。
// 混音先写临时文件，校验通过才替换原片；任何一步失败都保留无声版本 ——
// 宁缺音乐，不可丢片子。
// ============================================================

import { promises as fs } from "fs";
import { findBgm, mediaPath, posterPath } from "./db";
import {
  hasAudioStream,
  makePoster,
  muxFilmAudio,
  validateMedia,
  type AudioClip,
} from "./mediaTools";

export interface FinishResult {
  /** 是否混入了背景音乐 */
  bgm: boolean;
  /** 实际混入的现场原声段数（无音轨的会被跳过） */
  clips: number;
  /** 是否生成了海报 */
  poster: boolean;
  /** 排期里有但被跳过（原视频没有音轨/文件缺失）的段数 */
  skipped: number;
}

/** 只保留「文件存在且有音轨」的片段 */
async function usableClips(
  clips: AudioClip[]
): Promise<{ usable: { path: string; clip: AudioClip }[]; skipped: number }> {
  const usable: { path: string; clip: AudioClip }[] = [];
  let skipped = 0;
  for (const clip of clips) {
    const path = mediaPath(clip.mediaId);
    const exists = await fs
      .access(path)
      .then(() => true)
      .catch(() => false);
    if (!exists || !(await hasAudioStream(path))) {
      skipped += 1;
      continue;
    }
    usable.push({ path, clip });
  }
  return { usable, skipped };
}

/** 解析浏览器传来的现场原声排期（base64 JSON，见 lib/record/offline.ts） */
export function parseAudioPlan(raw: string | null): AudioClip[] {
  if (!raw) return [];
  try {
    const json = JSON.parse(Buffer.from(raw, "base64").toString("utf-8"));
    if (!Array.isArray(json)) return [];
    const out: AudioClip[] = [];
    for (const item of json.slice(0, 200)) {
      if (!item || typeof item !== "object") continue;
      const mediaId = String((item as AudioClip).mediaId ?? "");
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(mediaId)) continue;
      const num = (v: unknown, def: number) => {
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : def;
      };
      const clipLenSec = num((item as AudioClip).clipLenSec, 0);
      if (clipLenSec < 0.2) continue;
      out.push({
        mediaId,
        filmStartSec: num((item as AudioClip).filmStartSec, 0),
        clipStartSec: num((item as AudioClip).clipStartSec, 0),
        clipLenSec: Math.min(clipLenSec, 300),
        volume: Math.min(2, num((item as AudioClip).volume, 1)),
      });
    }
    return out;
  } catch {
    return [];
  }
}

export async function finishFilm(opts: {
  /** 成片绝对路径 */
  filePath: string;
  /** 成片文件名（用于定位边车/海报） */
  file: string;
  tripId?: string;
  /** 现场原声排期（可空） */
  clips?: AudioClip[];
}): Promise<FinishResult> {
  const { filePath, file, tripId } = opts;
  const result: FinishResult = { bgm: false, clips: 0, poster: false, skipped: 0 };

  // ---- 1. 音轨 ----
  const bgm = tripId ? await findBgm(tripId) : null;
  const { usable, skipped } = await usableClips(opts.clips ?? []);
  result.skipped = skipped;
  if (usable.length || bgm) {
    const tmp = `${filePath}.audio.mp4`;
    try {
      await muxFilmAudio(filePath, { clips: usable, bgm: bgm?.path ?? null, output: tmp });
      await validateMedia(tmp);
      await fs.rename(tmp, filePath);
      result.bgm = Boolean(bgm);
      result.clips = usable.length;
      console.log(
        `[film] 音轨已混入 ${file}：背景音乐=${bgm ? bgm.meta.name : "无"}，现场原声=${usable.length} 段` +
          (skipped ? `（跳过 ${skipped} 段无音轨）` : "")
      );
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      console.warn("[film] 混音失败，保留无声成片", e);
    }
  }

  // ---- 2. 海报 ----
  result.poster = await makePoster(filePath, posterPath(file));

  return result;
}
