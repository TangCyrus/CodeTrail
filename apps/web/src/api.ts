import type { AnalysisJob } from "@codegraph/shared";

const params = new URLSearchParams(window.location.hash.slice(1));
const incoming = params.get("session");
if (incoming) {
  sessionStorage.setItem("codegraph.session", incoming);
  history.replaceState(null, "", window.location.pathname + window.location.search);
}
export const sessionToken = incoming ?? sessionStorage.getItem("codegraph.session");

export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`/api${path}`, {
    ...options, headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), Authorization: `Bearer ${sessionToken ?? ""}`, ...options.headers },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ message: `请求失败 (${response.status})` })) as { message?: string };
    throw new Error(body.message ?? `请求失败 (${response.status})`);
  }
  return response.json() as Promise<T>;
}

/** Fetch-based SSE keeps the credential in a header rather than a query string. */
export async function watchAnalysis(id: string, signal: AbortSignal, update: (job: AnalysisJob) => void): Promise<void> {
  const response = await fetch(`/api/analyses/${encodeURIComponent(id)}/events`, { headers: { Authorization: `Bearer ${sessionToken ?? ""}` }, signal });
  if (!response.ok || !response.body) throw new Error("分析进度连接中断，请重试连接。");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await reader.read();
      buffer += decoder.decode(chunk.value, { stream: !chunk.done });
      let boundary;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split("\n").find((line) => line.startsWith("data: "));
        if (data) update(JSON.parse(data.slice(6)) as AnalysisJob);
      }
      if (chunk.done) break;
    }
  } finally { reader.releaseLock(); }
}

export const snapshotPath = (id: string, suffix: string): string => `/snapshots/${encodeURIComponent(id)}${suffix}`;
export const ignoredAbort = (error: unknown): boolean => error instanceof DOMException && error.name === "AbortError";
export const messageOf = (error: unknown): string => error instanceof Error ? error.message : "请求未完成，请重试。";
