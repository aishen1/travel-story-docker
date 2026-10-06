"use client";

// ============================================================
// Travel Story — 地点素材（StopMedia）
//
// 规划页每个地点卡片下方的小条：已有素材的缩略图 + 上传按钮。
//   - 图片直接 <img>；视频用 <video preload="metadata"> 取首帧当缩略图，
//     右上角压一个 ▶ 小标；
//   - 缩略图悬停出 ✕ 删除（同时删服务端二进制与行程里的元数据）；
//   - 点击缩略图在新标签页打开原图/视频；
//   - 上传走隐藏 <input type="file" multiple accept="image/*,video/*">。
// 这些素材就是「生成纪录片」时每个地点要拼上去的内容。
// ============================================================

import { useRef } from "react";
import { mediaThumbUrl, mediaUrl } from "@/lib/media";
import type { MediaMeta, TripStop } from "@/lib/types";

export function StopMedia({
  stop,
  onAddFiles,
  onRemove,
}: {
  stop: TripStop;
  onAddFiles?: (files: File[]) => void;
  onRemove?: (mediaId: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const media = stop.media ?? [];

  return (
    <div className="stop-media" onClick={(e) => e.stopPropagation()}>
      {media.map((m) => (
        <MediaThumb key={m.id} meta={m} onRemove={onRemove ? () => onRemove(m.id) : undefined} />
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
        // .heic/.heif 显式列出：Windows 不认这个扩展名的 MIME，只写 image/* 会选不中 iPhone 照片
        accept="image/*,video/*,.heic,.heif,.avif"
        multiple
        hidden
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length && onAddFiles) onAddFiles(files);
          // 允许重复选同一个文件
          e.target.value = "";
        }}
      />
    </div>
  );
}

/**
 * 缩略图：只读服务端生成的 1280px 小图，不拉原图（手机照片动辄 10MB）。
 *  - 图片：<img> 直接读 thumb；没有 thumb（老素材）时 onError 回落到原图；
 *  - 视频：<video preload="none" poster=thumb>，不加载视频本体，只显示封面帧。
 */
function MediaThumb({ meta, onRemove }: { meta: MediaMeta; onRemove?: () => void }) {
  const url = mediaUrl(meta.id);
  const thumb = mediaThumbUrl(meta.id);

  return (
    <div
      className="stop-media-thumb"
      title={meta.name}
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
