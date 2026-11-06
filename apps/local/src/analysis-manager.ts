import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { Worker } from "node:worker_threads";
import { isSnapshotStale } from "@codetrail/analyzer";
import { ProjectExplorer } from "@codetrail/graph";
import type { AnalysisJob, AnalysisPhase, AnalysisSnapshot, CapturedSource } from "@codetrail/shared";
import { SnapshotStore } from "./store.js";

export class AnalysisManager {
  readonly store: SnapshotStore;
  private worker: Worker | null = null;
  private readonly jobs = new Map<string, AnalysisJob>();
  private readonly events = new EventEmitter();
  private currentJob: AnalysisJob | null = null;
  private readonly explorers = new Map<string, ProjectExplorer>();
  latest: AnalysisSnapshot | null;

  constructor(readonly rootDir: string, dataDirectory: string) {
    this.store = new SnapshotStore(dataDirectory, rootDir);
    try { this.latest = this.store.latest(); }
    catch { this.store.close(); throw new Error("本地快照缓存损坏或无法读取。请用 --data-dir 指定新的缓存目录后重试；旧缓存不会被自动删除。"); }
  }

  job(id?: string): AnalysisJob | null {
    const job = id ? this.jobs.get(id) : this.currentJob;
    return job ? { ...job } : null;
  }

  start(): AnalysisJob {
    if (this.worker) return { ...this.currentJob! };
    const job: AnalysisJob = { id: randomUUID(), status: "running", phase: "queued", startedAt: new Date().toISOString() };
    this.currentJob = job;
    this.jobs.set(job.id, job);
    if (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    const worker = new Worker(new URL("./analysis-worker.js", import.meta.url), { workerData: { rootDir: this.rootDir } });
    this.worker = worker;
    const notify = (): void => { this.events.emit(job.id, { ...job }); };
    const fail = (message: string): void => {
      if (job.status !== "running") return;
      job.status = "failed";
      job.error = message;
      if (this.worker === worker) this.worker = null;
      notify();
    };
    worker.on("message", (message: { type: string; phase?: AnalysisPhase; snapshot?: AnalysisSnapshot; sources?: CapturedSource[]; error?: string }) => {
      if (job.status !== "running") return;
      if (message.type === "progress" && message.phase) { job.phase = message.phase; notify(); }
      if (message.type === "failed") fail(message.error ?? "分析失败，请重试");
      if (message.type === "complete" && message.snapshot && message.sources) {
        job.phase = "saving";
        notify();
        try {
          this.store.save(message.snapshot, message.sources);
          this.latest = message.snapshot;
          this.explorers.clear();
          job.status = "completed";
          job.snapshotId = message.snapshot.id;
          if (this.worker === worker) this.worker = null;
          notify();
        } catch (error) { fail(error instanceof Error ? error.message : "无法保存快照"); }
      }
    });
    worker.on("error", (error) => fail(error.message));
    worker.on("exit", (code) => {
      if (this.worker === worker) this.worker = null;
      if (job.status === "running") fail(`分析进程意外结束 (${code})`);
    });
    return { ...job };
  }

  subscribe(id: string, listener: (job: AnalysisJob) => void): () => void {
    this.events.on(id, listener);
    return () => { this.events.off(id, listener); };
  }

  async cancel(id: string): Promise<boolean> {
    const job = this.jobs.get(id);
    if (!job || job.status !== "running" || this.currentJob?.id !== id) return false;
    job.status = "cancelled";
    this.events.emit(id, { ...job });
    const worker = this.worker;
    if (worker) await worker.terminate();
    if (this.worker === worker) this.worker = null;
    return true;
  }

  explorer(id: string): ProjectExplorer | null {
    const cached = this.explorers.get(id);
    if (cached) return cached;
    const snapshot = this.latest?.id === id ? this.latest : this.store.get(id);
    if (!snapshot) return null;
    const explorer = new ProjectExplorer(snapshot);
    if (this.explorers.size >= 3) this.explorers.delete(this.explorers.keys().next().value!);
    this.explorers.set(id, explorer);
    return explorer;
  }

  stale(id: string): boolean {
    const explorer = this.explorer(id);
    return explorer ? isSnapshotStale(explorer.snapshot) : true;
  }

  async close(): Promise<void> {
    if (this.currentJob?.status === "running") await this.cancel(this.currentJob.id);
    this.events.removeAllListeners();
    this.store.close();
  }
}
