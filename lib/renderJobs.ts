// ============================================================
// 渲染任务上报（浏览器侧）
//
// 逐帧渲染的帧在浏览器内存/服务端帧目录里，刷新页面无法续渲；这里做的是
// 「把这次渲染的状态持续写给服务端」——刷新回来能看到上次跑到哪、
// 怎么结束的，中断不再是无声消失。
//
// 写入是节流的（默认 5 秒一次 + 结束必报），不拖慢渲染主循环。
// ============================================================

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

export async function startRenderJob(input: {
  tripId: string;
  tripName: string;
  total: number;
  format?: string;
  quality?: string;
  fps?: number;
}): Promise<string | null> {
  try {
    const res = await fetch("/api/render-jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return typeof json.id === "string" ? json.id : null;
  } catch {
    return null;
  }
}

export interface JobReporter {
  progress(rendered: number, total: number, phase?: string): void;
  done(patch: { file?: string; url?: string; size?: number; bgm?: boolean; clips?: number }): Promise<void>;
  fail(message: string): Promise<void>;
  abort(): Promise<void>;
}

/**
 * 节流写入器：progress 最多每 minIntervalMs 发一次（且同一时刻只有一个
 * 请求在飞），done/fail/abort 立即发。任何网络错误都吞掉 —— 上报失败
 * 绝不能影响渲染本身。
 */
export function createJobReporter(
  jobId: string | null,
  minIntervalMs = 5000
): JobReporter {
  let lastSent = 0;
  let inFlight = false;
  let pending: Record<string, unknown> | null = null;

  const send = async (patch: Record<string, unknown>) => {
    if (!jobId) return;
    try {
      await fetch(`/api/render-jobs?id=${encodeURIComponent(jobId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
    } catch {
      // 静默：上报只是观测，不影响出片
    }
  };

  const flush = async () => {
    if (inFlight || !pending) return;
    const body = pending;
    pending = null;
    inFlight = true;
    await send(body);
    inFlight = false;
    if (pending) void flush();
  };

  return {
    progress(rendered, total, phase) {
      if (!jobId) return;
      const now = Date.now();
      if (now - lastSent < minIntervalMs) return;
      lastSent = now;
      pending = { rendered, total, phase, status: "running" };
      void flush();
    },
    async done(patch) {
      if (!jobId) return;
      lastSent = Date.now();
      pending = null;
      await send({ ...patch, status: "done", phase: "done" });
    },
    async fail(message) {
      if (!jobId) return;
      pending = null;
      await send({ status: "error", error: message.slice(0, 400) });
    },
    async abort() {
      if (!jobId) return;
      pending = null;
      await send({ status: "aborted" });
    },
  };
}

export async function fetchRenderJobs(tripId: string): Promise<{
  jobs: RenderJob[];
  latest: RenderJob | null;
  stale: boolean;
}> {
  try {
    const res = await fetch(`/api/render-jobs?tripId=${encodeURIComponent(tripId)}`);
    if (!res.ok) return { jobs: [], latest: null, stale: false };
    const json = await res.json();
    return {
      jobs: Array.isArray(json.jobs) ? json.jobs : [],
      latest: json.latest ?? null,
      stale: Boolean(json.stale),
    };
  } catch {
    return { jobs: [], latest: null, stale: false };
  }
}

/** 清任务记录；purgeFrames=true 时连残留帧目录一起清 */
export async function clearRenderJobs(tripId: string): Promise<{ removed: number; framesPurged: number }> {
  try {
    const res = await fetch(`/api/render-jobs?tripId=${encodeURIComponent(tripId)}`, {
      method: "DELETE",
    });
    if (!res.ok) return { removed: 0, framesPurged: 0 };
    const json = await res.json();
    return { removed: json.removed ?? 0, framesPurged: json.framesPurged ?? 0 };
  } catch {
    return { removed: 0, framesPurged: 0 };
  }
}
