// ============================================================
// Travel Story — 最小 ZIP 读写（服务端，无第三方依赖）
//
// 用于「导出行程 + 素材」「导入行程」。只实现需要的部分：
//   - 写：store（不压缩）。素材本身是 JPEG/MP4，再压也压不动，
//     省掉压缩反而更快；采用「先占位后回填 CRC/长度」的单遍写法，
//     大文件不需要读两遍。
//   - 读：store 与 deflate 都支持（zlib.inflateRawSync），
//     所以也能读别人用常规工具打的 zip。
// 限制：单文件 < 2GB（ZIP32 的边界），足够本场景。
// ============================================================

import { promises as fs } from "fs";
import zlib from "zlib";

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32Update(crc: number, buf: Buffer): number {
  let c = crc ^ -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

export function crc32(buf: Buffer): number {
  return crc32Update(0, buf);
}

function dosDateTime(ms: number): { time: number; date: number } {
  const d = new Date(ms);
  const time =
    (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const date =
    ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time: time & 0xffff, date: date & 0xffff };
}

export interface ZipSource {
  /** zip 内的路径，如 trip.json / media/media_xxx */
  name: string;
  /** 磁盘上的文件（与 data 二选一） */
  path?: string;
  /** 内存里的内容（与 path 二选一） */
  data?: Buffer;
}

const MAX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const CHUNK = 1 << 20;

/** 写 zip 到磁盘（流式，内存里只过 1MB 缓冲） */
export async function writeZip(
  outPath: string,
  sources: ZipSource[]
): Promise<{ size: number; count: number; skipped: string[] }> {
  const fh = await fs.open(outPath, "w");
  const central: {
    name: Buffer;
    crc: number;
    size: number;
    offset: number;
    time: number;
    date: number;
  }[] = [];
  const skipped: string[] = [];
  const buf = Buffer.alloc(CHUNK);
  let offset = 0;
  try {
    for (const src of sources) {
      const nameBuf = Buffer.from(src.name, "utf-8");
      let total = src.data?.length ?? 0;
      let mtime = Date.now();
      if (!src.data) {
        const stat = await fs.stat(src.path!).catch(() => null);
        if (!stat || !stat.isFile()) {
          skipped.push(src.name);
          continue;
        }
        if (stat.size > MAX_FILE_BYTES) {
          skipped.push(src.name);
          continue;
        }
        total = stat.size;
        mtime = stat.mtimeMs;
      }
      const { time, date } = dosDateTime(mtime);

      // 本地文件头（CRC 与压缩后大小先占位，数据写完回填）
      const header = Buffer.alloc(30);
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4); // version needed
      header.writeUInt16LE(0x0800, 6); // flag：文件名按 UTF-8
      header.writeUInt16LE(0, 8); // method：store
      header.writeUInt16LE(time, 10);
      header.writeUInt16LE(date, 12);
      header.writeUInt32LE(0, 14); // crc32 占位
      header.writeUInt32LE(0, 18); // 压缩后大小占位
      header.writeUInt32LE(total >>> 0, 22);
      header.writeUInt16LE(nameBuf.length, 26);
      header.writeUInt16LE(0, 28);
      await fh.write(header);
      await fh.write(nameBuf);

      let crc = 0;
      let written = 0;
      if (src.data) {
        crc = crc32(src.data);
        await fh.write(src.data);
        written = src.data.length;
      } else {
        const inFh = await fs.open(src.path!, "r");
        try {
          for (;;) {
            const { bytesRead } = await inFh.read(buf, 0, CHUNK, written);
            if (!bytesRead) break;
            const slice = buf.subarray(0, bytesRead);
            crc = crc32Update(crc, slice);
            await fh.write(slice);
            written += bytesRead;
          }
        } finally {
          await inFh.close();
        }
      }

      // 回填 CRC 与大小（store：压缩后大小 == 原始大小）
      const patch = Buffer.alloc(12);
      patch.writeUInt32LE(crc >>> 0, 0);
      patch.writeUInt32LE(written >>> 0, 4);
      patch.writeUInt32LE(written >>> 0, 8);
      await fh.write(patch, 0, 12, offset + 14);

      central.push({ name: nameBuf, crc, size: written, offset, time, date });
      offset += 30 + nameBuf.length + written;
    }

    const cdStart = offset;
    for (const c of central) {
      const h = Buffer.alloc(46);
      h.writeUInt32LE(0x02014b50, 0);
      h.writeUInt16LE(20, 4);
      h.writeUInt16LE(20, 6);
      h.writeUInt16LE(0x0800, 8);
      h.writeUInt16LE(0, 10);
      h.writeUInt16LE(c.time, 12);
      h.writeUInt16LE(c.date, 14);
      h.writeUInt32LE(c.crc >>> 0, 16);
      h.writeUInt32LE(c.size >>> 0, 20);
      h.writeUInt32LE(c.size >>> 0, 24);
      h.writeUInt16LE(c.name.length, 28);
      h.writeUInt32LE(c.offset >>> 0, 42);
      await fh.write(h);
      await fh.write(c.name);
      offset += 46 + c.name.length;
    }

    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(central.length, 8);
    eocd.writeUInt16LE(central.length, 10);
    eocd.writeUInt32LE(offset - cdStart, 12);
    eocd.writeUInt32LE(cdStart, 16);
    await fh.write(eocd);
    offset += 22;
  } finally {
    await fh.close();
  }
  return { size: offset, count: central.length, skipped };
}

export interface ZipEntry {
  name: string;
  data: Buffer;
}

/** 读 zip：支持 store 与 deflate */
export function readZip(buf: Buffer): ZipEntry[] {
  // 从尾部找 EOCD（注释区最多 64KB）
  const maxBack = Math.min(buf.length, 66_000);
  let eocd = -1;
  for (let i = buf.length - 22; i >= buf.length - maxBack && i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("不是有效的 zip（找不到目录）");
  const count = buf.readUInt16LE(eocd + 10);
  let pos = buf.readUInt32LE(eocd + 16);
  const out: ZipEntry[] = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(pos) !== 0x02014b50) throw new Error("zip 目录损坏");
    const method = buf.readUInt16LE(pos + 10);
    const compSize = buf.readUInt32LE(pos + 20);
    const nameLen = buf.readUInt16LE(pos + 28);
    const extraLen = buf.readUInt16LE(pos + 30);
    const commentLen = buf.readUInt16LE(pos + 32);
    const localOffset = buf.readUInt32LE(pos + 42);
    const name = buf.toString("utf-8", pos + 46, pos + 46 + nameLen);
    pos += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // 目录项
    if (buf.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("zip 本地头损坏");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    if (method === 0) out.push({ name, data: Buffer.from(raw) });
    else if (method === 8) out.push({ name, data: zlib.inflateRawSync(raw) });
    else throw new Error(`不支持的压缩方式 ${method}（${name}）`);
  }
  return out;
}
