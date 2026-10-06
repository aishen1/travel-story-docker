"use client";

// ============================================================
// Travel Story — 地点素材（StopMedia）
//
// 规划页每个地点卡片下方的小条：已有素材的缩略图 + 上传按钮。
//   - 图片直接读服务端生成的 1280px 缩略图（不拉原图）；
//   - 视频用 <video preload="none" poster=缩略图> 只显示封面帧；
//   - 缩略图悬停出 ✕ 删除；视频多一个 ✂ 用来选片段 / 开原声；
//   - 点击缩略图在新标签页打开原图/视频；
//   - 上传走隐藏 <input type="file" multiple>，显式带上 .heic/.heif
//     （Windows 不认这个扩展名的 MIME，只写 image/* 会选不中 iPhone 照片）。
// 这些素材就是「生成纪录片」时每个地点要拼上去的内容。
// ============================================================

import { useRef, useState } from "react";
import { mediaThumbUrl, mediaUrl } from "@/lib/media";
import type { MediaMeta, TripStop } from "@/lib/types";

/** 视频片段的展示摘要：起点/时长/是否有原声 */
function clipSummary(meta: MediaMeta): string | null {
  const parts: string[] = [];
  if (meta.clipStart) parts.push(`从 ${meta.clipStart}s`);
  if (meta.clipLen) parts.push(`${meta.clipLen}s`);
  if ((meta.volume ?? 0) > 0) parts.push("♪ 原声");
  return parts.length ? parts.join(" · ") : null;
}

export function StopMedia({
  stop,
  onAddFiles,
  onRemove,
  onEditClip,
}: {
  stop: TripStop;
  onAddFiles?: (files: File[]) => void;
  onRemove?: (mediaId: string) => void;
  /** 保存视频的片段/原声设置（不传则不显示 ✂） */
  onEditClip?: (mediaId: string, patch: Partial<MediaMeta>) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState<MediaMeta | null>(null);
  const media = stop.media ?? [];

  return (
    <div className="stop-media" onClick={(e) => e.stopPropagation()}>
      {media.map((m) => (
        <MediaThumb
          key={m.id}
          meta={m}
          onRemove={onRemove ? () => onRemove(m.id) : undefined}
          onEdit={onEditClip ? () => setEditing(m) : undefined}
        />
      ))}
      <button
        className="stop-media-add"
        title="上传图片 / 视频"
        onClick={() => inputRef.current?.click()}
      >
        ＋ 图片/视频
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*,video/*,.heic,.heif,.avif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length && onAddFiles) onAddFiles(files);
          e.target.value = ""; // 允许重复选同一个文件
        }}
      />
      {editing && (
        <ClipEditor
          meta={editing}
          onSave={(patch) => {
            onEditClip?.(editing.id, patch);
            setEditing(null);
          }}
          onCancel={() => setEditing(null)}
        />
      )}
    </div>
  );
}

/**
 * 缩略图：只读服务端生成的 1280px 小图，不拉原图（手机照片动辄 10MB）。
 *  - 图片：<img> 读 thumb；没有 thumb（老素材）时 onError 回落到原图；
 *  - 视频：<video preload="none" poster=thumb>，不加载视频本体。
 */
function MediaThumb({
  meta,
  onRemove,
  onEdit,
}: {
  meta: MediaMeta;
  onRemove?: () => void;
  onEdit?: () => void;
}) {
  const url = mediaUrl(meta.id);
  const thumb = mediaThumbUrl(meta.id);
  const clip = meta.kind === "video" ? clipSummary(meta) : null;

  return (
    <div
      className="stop-media-thumb"
      title={clip ? `${meta.name}\n${clip}` : meta.name}
      onClick={() => window.open(url, "_blank")}
    >
      {meta.kind === "image" ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={thumb}
          alt={meta.name}
          loading="lazy"
          onError={(e) => {
            const el = e.currentTarget;
            if (el.dataset.fallback) return;
            el.dataset.fallback = "1";
            el.src = url;
          }}
        />
      ) : (
        <video src={url} muted preload="none" poster={thumb} />
      )}
      {meta.kind === "video" && <span className="stop-media-play">▶</span>}
      {clip && (
        <span className="stop-media-clip-tag font-mono">
          {(meta.volume ?? 0) > 0 ? "♪" : "✂"}
        </span>
      )}
      {onEdit && (
        <button
          className="stop-media-cut"
          title="选取片段 / 保留原声"
          onClick={(e) => {
            e.stopPropagation();
            onEdit();
          }}
        >
          ✂
        </button>
      )}
      {onRemove && (
        <button
          className="stop-media-del"
          title="删除这份素材"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          ×
        </button>
      )}
    </div>
  );
}

/**
 * 片段编辑器：视频在成片里只出现一小段，这里选「从第几秒开始、取多长」，
 * 并决定要不要保留现场原声（原声由服务端在合成时按同一份排期混进去 ——
 * 逐帧渲染通道本身没有音轨）。
 */
function ClipEditor({
  meta,
  onSave,
  onCancel,
}: {
  meta: MediaMeta;
  onSave: (patch: Partial<MediaMeta>) => void;
  onCancel: () => void;
}) {
  const [start, setStart] = useState(String(meta.clipStart ?? 0));
  const [len, setLen] = useState(meta.clipLen ? String(meta.clipLen) : "");
  const [voice, setVoice] = useState((meta.volume ?? 0) > 0);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [duration, setDuration] = useState(0);

  const startNum = Number(start);
  const lenNum = Number(len);
  const summary = len
    ? `${Number.isFinite(startNum) ? startNum : 0}s 起，取 ${Number.isFinite(lenNum) ? lenNum : 0}s`
    : `${Number.isFinite(startNum) ? startNum : 0}s 起到片尾`;

  return (
    <div className="clip-edit" onClick={(e) => e.stopPropagation()}>
      <div className="clip-edit-head">
        <span className="font-mono">✂ 片段</span>
        <span className="clip-edit-name" title={meta.name}>
          {meta.name}
        </span>
        <button className="clip-edit-close" onClick={onCancel} title="收起">
          ×
        </button>
      </div>
      <video
        ref={videoRef}
        src={mediaUrl(meta.id)}
        controls
        preload="metadata"
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration || 0)}
      />
      <div className="clip-edit-row">
        <label>
          起点（秒）
          <input
            type="number"
            min={0}
            step={0.5}
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        <button
          className="btn btn-ghost btn-sm"
          onClick={() => {
            const t = videoRef.current?.currentTime ?? 0;
            setStart(String(Math.max(0, Math.round(t * 10) / 10)));
          }}
        >
          用当前播放位置
        </button>
      </div>
      <div className="clip-edit-row">
        <label>
          时长（秒）
          <input
            type="number"
            min={1}
            step={0.5}
            placeholder="留空 = 到片尾"
            value={len}
            onChange={(e) => setLen(e.target.value)}
          />
        </label>
        {duration > 0 && (
          <span className="clip-edit-dur font-mono">
            原片 {duration.toFixed(1)}s
          </span>
        )}
      </div>
      <label className="clip-edit-vol">
        <input type="checkbox" checked={voice} onChange={(e) => setVoice(e.target.checked)} />
        保留现场原声（成片里会混入这一段声音）
      </label>
      <div className="clip-edit-actions">
        <button
          className="btn btn-sm"
          onClick={() =>
            onSave({
              clipStart: Number.isFinite(startNum) && startNum > 0 ? startNum : 0,
              clipLen: len && Number.isFinite(lenNum) && lenNum > 0 ? lenNum : undefined,
              volume: voice ? 1 : 0,
            })
          }
        >
          保存
        </button>
        <span className="clip-edit-summary font-mono">{summary}</span>
      </div>
    </div>
  );
}
