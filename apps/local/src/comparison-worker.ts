import { parentPort, workerData, Worker } from "node:worker_threads";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { isSnapshotStale } from "@codetrail/analyzer";
import { compareSnapshots } from "@codetrail/graph";
import type { AnalysisSnapshot, CapturedSource, ComparisonBundle, ComparisonJob } from "@codetrail/shared";
import { existingBaselinePaths, inspectGit, isSourcePath, materializeBaseline, publicBaseline, sha } from "./git.js";
import { prepareBaselineDependencies, baselineDependencyInputsStale, type BaselineDependencies } from "./baseline-dependencies.js";

const { rootDir, temporaryDirectory } = workerData as { rootDir: string; temporaryDirectory: string };
const progress = (phase: ComparisonJob["phase"]) => parentPort!.postMessage({ type: "progress", phase });
// Retain only plain snapshot/source data between versions. Wait for each isolate
// to exit before starting the next compiler environment.
function captureVersion(root: string): Promise<{ snapshot: AnalysisSnapshot; sources: CapturedSource[] }> {
  return new Promise((resolve, reject) => {
    const child = new Worker(new URL("./analysis-worker.js", import.meta.url), { workerData: { rootDir: root } });
    let result: { snapshot: AnalysisSnapshot; sources: CapturedSource[] } | undefined;
    let error: Error | undefined;
    child.on("message", (message: { type: string; snapshot?: AnalysisSnapshot; sources?: CapturedSource[]; error?: string }) => {
      if (message.type === "complete" && message.snapshot && message.sources) result = { snapshot: message.snapshot, sources: message.sources };
      if (message.type === "failed") error = new Error(message.error ?? "Version analysis failed");
    });
    child.on("error", failure => { error = failure; });
    child.on("exit", code => {
      if (!error && code === 0 && result) resolve(result);
      else reject(error ?? new Error("Version analysis exited without a snapshot"));
    });
  });
}
let temporary: string | undefined;
function discardBaseline(): void {
  if (!temporary) return;
  const parent = realpathSync(temporaryDirectory), target = realpathSync(temporary);
  if (path.dirname(target) !== parent || !path.basename(target).startsWith("head-")) throw new Error("Unsafe baseline cleanup");
  rmSync(target, {recursive:true,force:true}); temporary = undefined;
}
try {
  progress("git");
  const git = await inspectGit(rootDir, true);
  let base: AnalysisSnapshot | null = null;
  let oldSources: CapturedSource[] = [], newSources: CapturedSource[] = [];
  const warnings = [...git.warnings];
  progress("current");
  const capturedCurrent = await captureVersion(rootDir);
  const current = capturedCurrent.snapshot; newSources = capturedCurrent.sources;
  let dependencies: BaselineDependencies | undefined;
  if (git.head) {
    progress("baseline");
    mkdirSync(temporaryDirectory, { recursive: true });
    temporary = mkdtempSync(path.join(temporaryDirectory, "head-"));
    warnings.push(...await materializeBaseline(git, temporary));
    dependencies = prepareBaselineDependencies(rootDir, temporary, current);
    warnings.push(`HEAD 依赖声明环境：${dependencies.summary.state}，复用 ${dependencies.summary.copiedPackages} 个包、${dependencies.summary.copiedFiles} 个声明/JSON 文件，跳过 ${dependencies.summary.skippedFiles} 个输入。${dependencies.summary.reasons.map(item => `${item.code}: ${item.count}`).join("；")}`);
    warnings.push(dependencies.summary.notice);
    const captured = await captureVersion(temporary);
    base = captured.snapshot; oldSources = captured.sources;
    base.rootDir = rootDir;
    // Physical staging paths must not make immutable HEAD identities change on every refresh.
    base.id = `baseline:${sha(JSON.stringify({ head: git.head, scope: git.scope, files: base.files.map((file) => [file.path, file.hash]), inputs: base.configuration.inputs, analyzer: base.analyzer, dependencies: dependencies.summary.identity })).slice(0, 24)}`;
    // Both graphs now contain plain captured data only. Staging must disappear
    // before freshness checks, especially when a custom cache is in the project.
    discardBaseline();
  }
  progress("mapping");
  if (base && JSON.stringify(base.configuration.inputs) !== JSON.stringify(current.configuration.inputs)) warnings.push("两侧编译或忽略配置输入不同；配置变化可能影响未发生源码文本变化的解析结果，本版不穷举这些语义变化。");
  const report = compareSnapshots({ baseline: publicBaseline(git), base, current, oldSources, newSources, renames: git.renames, untracked: git.untracked,
    baselinePaths: git.entries.filter((entry) => isSourcePath(entry.path)).map((entry) => entry.path), presentPaths: existingBaselinePaths(rootDir, git), warnings });
  if (dependencies) report.baselineDependencies = dependencies.summary;
  const latestGit = await inspectGit(rootDir);
  report.stale ||= isSnapshotStale(current) || latestGit.head !== git.head || latestGit.state !== git.state
    || !!dependencies && baselineDependencyInputsStale(rootDir, dependencies.inputs, dependencies.missingInputs);
  const bundle: ComparisonBundle = { report, base: base ? { snapshot: base, sources: oldSources } : null, current: { snapshot: current, sources: newSources },
    ...(dependencies ? { baselineDependencyInputs: dependencies.inputs, baselineDependencyMissingInputs: dependencies.missingInputs } : {}) };
  parentPort!.postMessage({ type: "complete", bundle });
} catch {
  parentPort!.postMessage({ type: "failed", error: "比较未能完成。请检查 Git 与文件读取权限，或缩小分析目录后重试。" });
} finally {
  discardBaseline();
}
