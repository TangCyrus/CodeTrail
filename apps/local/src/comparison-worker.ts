import { parentPort, workerData } from "node:worker_threads";
import { mkdirSync, mkdtempSync, rmSync, realpathSync } from "node:fs";
import path from "node:path";
import { analyzeProject, isSnapshotStale } from "@codetrail/analyzer";
import { compareSnapshots } from "@codetrail/graph";
import type { AnalysisSnapshot, CapturedSource, ComparisonBundle, ComparisonJob } from "@codetrail/shared";
import { existingBaselinePaths, inspectGit, isSourcePath, materializeBaseline, publicBaseline, sha } from "./git.js";

const { rootDir, temporaryDirectory } = workerData as { rootDir: string; temporaryDirectory: string };
const progress = (phase: ComparisonJob["phase"]) => parentPort!.postMessage({ type: "progress", phase });
let temporary: string | undefined;
try {
  progress("git");
  const git = await inspectGit(rootDir, true);
  let base: AnalysisSnapshot | null = null;
  let oldSources: CapturedSource[] = [], newSources: CapturedSource[] = [];
  const warnings = [...git.warnings];
  if (git.head) {
    progress("baseline");
    mkdirSync(temporaryDirectory, { recursive: true });
    temporary = mkdtempSync(path.join(temporaryDirectory, "head-"));
    warnings.push(...await materializeBaseline(git, temporary));
    base = analyzeProject({ rootDir: temporary }, { onSources: (sources) => { oldSources = sources; } });
    base.rootDir = rootDir;
    // Physical staging paths must not make immutable HEAD identities change on every refresh.
    base.id = `baseline:${sha(JSON.stringify({ head: git.head, scope: git.scope, files: base.files.map((file) => [file.path, file.hash]), inputs: base.configuration.inputs, analyzer: base.analyzer })).slice(0, 24)}`;
  }
  progress("current");
  const current = analyzeProject({ rootDir }, { onSources: (sources) => { newSources = sources; } });
  progress("mapping");
  if (base && JSON.stringify(base.configuration.inputs) !== JSON.stringify(current.configuration.inputs)) warnings.push("两侧编译或忽略配置输入不同；配置变化可能影响未发生源码文本变化的解析结果，本版不穷举这些语义变化。");
  const report = compareSnapshots({ baseline: publicBaseline(git), base, current, oldSources, newSources, renames: git.renames, untracked: git.untracked,
    baselinePaths: git.entries.filter((entry) => isSourcePath(entry.path)).map((entry) => entry.path), presentPaths: existingBaselinePaths(rootDir, git), warnings });
  const latestGit = await inspectGit(rootDir);
  report.stale ||= isSnapshotStale(current) || latestGit.head !== git.head || latestGit.state !== git.state;
  const bundle: ComparisonBundle = { report, base: base ? { snapshot: base, sources: oldSources } : null, current: { snapshot: current, sources: newSources } };
  parentPort!.postMessage({ type: "complete", bundle });
} catch {
  parentPort!.postMessage({ type: "failed", error: "比较未能完成。请检查 Git 与文件读取权限，或缩小分析目录后重试。" });
} finally {
  if (temporary) {
    const parent = realpathSync(temporaryDirectory), target = realpathSync(temporary);
    if (path.dirname(target) === parent && path.basename(target).startsWith("head-")) rmSync(target, { recursive: true, force: true });
  }
}
