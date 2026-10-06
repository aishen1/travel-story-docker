// ============================================================
// Travel Story — 素材二进制（服务端存储）
//
// v2：素材本体存服务端 data/media/（POST /api/media 上传，
// GET /api/media/<id> 读取，支持 Range 拖动进度条），元数据
// （MediaMeta）跟随行程存 data/trips.json。
// 将来换对象存储（S3 等）时只需改这三个函数的实现。
// ============================================================

/** 素材直链（<img>/<video> 直接用，浏览器自己缓存） */
export function mediaUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}`;
}

/** 缩略图直链（长边 1280）：列表/规划页用，别拉原图。没有缩略图时服务端回落原图 */
export function mediaThumbUrl(id: string): string {
  return `/api/media/${encodeURIComponent(id)}?thumb=1`;
}

/** 该行程的背景音乐直链（没有则 404） */
export function bgmUrl(tripId: string): string {
  return `/api/bgm?tripId=${encodeURIComponent(tripId)}`;
}

/** 背景音乐信息（是否存在/文件名/大小） */
export async function fetchBgmInfo(
  tripId: string
): Promise<{ exists: boolean; name?: string; size?: number }> {
  try {
    const res = await fetch(`/api/bgm?tripId=${encodeURIComponent(tripId)}&info=1`);
    if (!res.ok) return { exists: false };
    return await res.json();
  } catch {
    return { exists: false };
  }
}

/** 上传/替换背景音乐 */
export async function putBgm(tripId: string, file: File): Promise<void> {
  const res = await fetch(`/api/bgm?tripId=${encodeURIComponent(tripId)}`, {
    method: "POST",
    headers: { "Content-Type": file.type || "application/octet-stream" },
    body: file,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `背景音乐上传失败（${res.status}）`);
  }
}

export async function deleteBgm(tripId: string): Promise<void> {
  try {
    await fetch(`/api/bgm?tripId=${encodeURIComponent(tripId)}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[travel-story] 删除背景音乐失败", e);
  }
}

export async function putMediaBlob(id: string, file: File): Promise<void> {
  const res = await fetch(
    `/api/media?id=${encodeURIComponent(id)}&name=${encodeURIComponent(file.name)}`,
    {
      method: "POST",
      headers: { "Content-Type": file.type || "application/octet-stream" },
      body: file,
    }
  );
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `上传失败（${res.status}）`);
  }
}

export async function deleteMediaBlob(id: string): Promise<void> {
  try {
    await fetch(`/api/media/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    console.warn("[travel-story] 删除服务端素材失败", e);
  }
}

/** 行程导出（zip：行程 JSON + 素材 + 背景音乐） */
export function exportUrl(tripId: string): string {
  return `/api/export?tripId=${encodeURIComponent(tripId)}`;
}

/** 从 zip 导回行程（id 冲突时服务端会另起一个，不覆盖现有行程） */
export async function importTripZip(
  file: File
): Promise<{ tripId: string; name: string; media: number; bgm: boolean; renamed: boolean }> {
  const res = await fetch("/api/import", {
    method: "POST",
    headers: { "Content-Type": "application/zip" },
    body: file,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(json?.error ?? `导入失败（${res.status}）`);
  }
  return json;
}
