import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import { isSnapshotStale } from "@codetrail/analyzer";
import { calculateComparisonImpact, comparisonSymbols } from "@codetrail/graph";
import type { ComparisonBundle, ComparisonJob, ComparisonReport, ComparisonSide, ImpactFocus } from "@codetrail/shared";
import type { SnapshotStore } from "./store.js";
import { inspectGit } from "./git.js";
import { baselineDependencyInputsStale } from "./baseline-dependencies.js";

export class ComparisonManager {
  private worker: Worker | null = null;
  private currentJob: ComparisonJob | null = null;
  private readonly jobs = new Map<string, ComparisonJob>();
  constructor(readonly rootDir: string, private readonly store: SnapshotStore) {}
  job(id?: string): ComparisonJob | null { const job = id ? this.jobs.get(id) : this.currentJob; return job ? { ...job } : null; }
  latest(): ComparisonReport | null { return this.store.latestComparison()?.report ?? null; }
  bundle(id: string): ComparisonBundle | null { return this.store.comparison(id); }
  report(id: string, includeTypes = false, focus?: ImpactFocus): ComparisonReport | null {
    const bundle = this.bundle(id);
    return bundle ? includeTypes || focus || !bundle.report.truncation ? calculateComparisonImpact(bundle.report, bundle.base?.snapshot ?? null, bundle.current.snapshot, includeTypes, focus) : bundle.report : null;
  }
  symbols(id: string, query = "", side?: ComparisonSide) {
    const bundle = this.bundle(id);
    return bundle ? comparisonSymbols(bundle.report, bundle.base?.snapshot ?? null, bundle.current.snapshot, query, side) : null;
  }
  async stale(id: string): Promise<boolean> {
    const bundle = this.bundle(id);
    if (!bundle || bundle.report.stale || isSnapshotStale(bundle.current.snapshot)
      || baselineDependencyInputsStale(this.rootDir, bundle.baselineDependencyInputs, bundle.baselineDependencyMissingInputs)) return true;
    const git = await inspectGit(this.rootDir);
    return git.head !== bundle.report.baseline.head || git.state !== bundle.report.baseline.state;
  }
  start(): ComparisonJob {
    if (this.worker) return { ...this.currentJob! };
    const job: ComparisonJob = { id: randomUUID(), status: "running", phase: "git", startedAt: new Date().toISOString() };
    this.currentJob = job; this.jobs.set(job.id, job);
    if (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value!);
    const parent = path.join(this.store.directory, "comparison-temp");
    const temporaryDirectory = path.join(parent, job.id);
    mkdirSync(temporaryDirectory, { recursive: true });
    const cleanup = () => {
      if (!existsSync(temporaryDirectory)) return;
      const target = realpathSync(temporaryDirectory);
      if (path.dirname(target) !== realpathSync(parent) || path.basename(target) !== job.id) throw new Error("Unsafe comparison cleanup");
      rmSync(target, { recursive: true, force: true });
    };
    const worker = new Worker(new URL("./comparison-worker.js", import.meta.url), { workerData: { rootDir: this.rootDir, temporaryDirectory } });
    let pendingBundle: ComparisonBundle | null = null;
    this.worker = worker;
    const fail = () => { if (job.status === "running") { job.status = "failed"; job.error = "比较未能完成，请检查 Git 和分析范围后重试。"; } };
    worker.on("message", (message: { type: string; phase?: ComparisonJob["phase"]; bundle?: ComparisonBundle; error?: string }) => {
      if (job.status !== "running") return;
      if (message.type === "progress" && message.phase) job.phase = message.phase;
      if (message.type === "failed") { fail(); if (message.error) job.error = message.error; }
      if (message.type === "complete" && message.bundle) {
        job.phase = "saving";
        pendingBundle = message.bundle;
      }
    });
    worker.on("error", fail);
    worker.on("exit", () => {
      if (this.worker === worker) this.worker = null;
      try {
        cleanup();
        if (job.status === "running" && pendingBundle) { this.store.saveComparison(pendingBundle); job.comparisonId = pendingBundle.report.id; job.status = "completed"; }
      } catch { fail(); }
      pendingBundle = null; fail();
    });
    return { ...job };
  }
  async cancel(id: string): Promise<boolean> {
    if (this.currentJob?.id !== id || this.currentJob.status !== "running") return false;
    this.currentJob.status = "cancelled";
    const worker = this.worker;
    if (worker) await worker.terminate();
    if (this.worker === worker) this.worker = null;
    return true;
  }
  async close(): Promise<void> {
    if (this.worker) {
      if (this.currentJob?.status === "running") this.currentJob.status = "cancelled";
      await this.worker.terminate(); this.worker = null;
    }
  }
}
