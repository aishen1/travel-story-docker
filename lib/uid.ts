// ============================================================
// Travel Story — 唯一 id 生成（客户端安全）
//
// crypto.randomUUID 只在**安全上下文**（HTTPS 或 localhost）下存在。
// 局域网用 http://192.168.x.x:3000 访问时它是 undefined，
// 直接调用会让素材上传与纪录片渲染抛异常，被 React error boundary
// 显示成「出错了 crypto.randomUUID is not a function」。
//
// 这里做三级降级：randomUUID → getRandomValues（非安全上下文也有）
// → Math.random。返回形态与 randomUUID 一致（UUID v4 字符串），
// 调用方无需区分。
// ============================================================

export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;

  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID();
  }

  if (c && typeof c.getRandomValues === "function") {
    const b = new Uint8Array(16);
    c.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40; // version 4
    b[8] = (b[8] & 0x3f) | 0x80; // variant 10
    const hex = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }

  // 极端兜底：老浏览器连 getRandomValues 都没有
  const r = () => Math.random().toString(16).slice(2, 10);
  return `${Date.now().toString(16)}-${r()}-${r()}`;
}
