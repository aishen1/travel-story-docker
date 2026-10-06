"use client";

// ============================================================
// Travel Story — 成片库（行程页左栏底部）
//
// 「生成纪录片」跑完一关页面，成片原来只能去服务器文件系统里翻。
// 这里列出本行程已生成的片子：封面（首帧海报）/ 时长 / 大小 / 是否配乐，
// 可页内直接播放、下载、删除。数据来自 GET /api/recordings。
// ============================================================

import { useCallback, useEffect, useState } from "react";

interface Film {
  file: string;
  url: string;
  size: number;
  mtime: number;
  duration?: number;
  fps?: number;
  bgm?: boolean;
  clips?: number;
  poster?: boolean;
  tripId?: string;
}

function formatDuration(seconds?: number): string {
  if (!seconds || !Number.isFinite(seconds)) return "--:--";
  const total = Math.round(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatWhen(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function FilmLibrary({ tripId, tripName }: { tripId: string; tripName: string }) {
  const [films, setFilms] = useState<Film[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** 正在页内播放的成片文件名 */
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/recordings?tripId=${encodeURIComponent(tripId)}&trip=${encodeURIComponent(tripName)}`
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      setFilms(Array.isArray(json.files) ? json.files : []);
    } catch {
      setFilms([]);
    }
  }, [tripId, tripName]);

  useEffect(() => {
    load();
  }, [load]);

  async function handleDelete(file: string) {
    if (!confirm("删除这部成片？文件将从服务器移除，无法恢复。")) return;
    setBusy(file);
    try {
      const res = await fetch(`/api/recordings?file=${encodeURIComponent(file)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (playing === file) setPlaying(null);
      await load();
    } catch (e) {
      alert(`删除失败：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <section className="film-lib">
      <header className="film-lib-head">
        <span className="font-mono film-lib-kicker">MOVIES</span>
        <h2 className="font-display">
          成片库{films && films.length > 0 ? ` · ${films.length}` : ""}
        </h2>
      </header>

      {films === null && <p className="film-lib-empty muted">读取中…</p>}

      {films?.length === 0 && (
        <p className="film-lib-empty muted">
          还没有成片。点右上角「🎬 生成纪录片」，出片后会出现在这里。
        </p>
      )}

      {films?.map((f) => (
        <div className="film-item" key={f.file}>
          <div className="film-row">
            {/* 封面：首帧海报；老片子没有海报时显示占位 */}
            <span className="film-poster" title={f.file}>
              {f.poster === false ? (
                <span className="film-poster-none font-mono">无</span>
              ) : (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={`${f.url}?poster=1`}
                  alt={f.file}
                  loading="lazy"
                  onError={(e) => {
                    const el = e.currentTarget;
                    el.style.display = "none";
                  }}
                />
              )}
            </span>
            <div className="film-row-main">
              <span className="film-row-name" title={f.file}>
                {f.file}
              </span>
              <span className="film-row-meta font-mono muted">
                {formatDuration(f.duration)}
                {f.fps ? ` · ${f.fps}fps` : ""}
                {` · ${(f.size / 1024 / 1024).toFixed(1)}MB`}
                {f.bgm ? " · ♪ 配乐" : ""}
                {f.clips ? ` · 🎤 原声×${f.clips}` : ""}
                {` · ${formatWhen(f.mtime)}`}
              </span>
            </div>
            <div className="film-row-actions">
              <button
                className={`film-act${playing === f.file ? " on" : ""}`}
                title={playing === f.file ? "收起播放器" : "在页面里播放"}
                onClick={() => setPlaying(playing === f.file ? null : f.file)}
              >
                {playing === f.file ? "■" : "▶"}
              </button>
              <a
                className="film-act"
                href={`${f.url}?download=1`}
                title="下载"
                download
              >
                ⬇
              </a>
              <button
                className="film-act film-del"
                title="删除"
                disabled={busy === f.file}
                onClick={() => handleDelete(f.file)}
              >
                {busy === f.file ? "…" : "✕"}
              </button>
            </div>
          </div>
          {playing === f.file && (
            <div className="film-player">
              {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
              <video src={f.url} poster={`${f.url}?poster=1`} controls autoPlay />
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
