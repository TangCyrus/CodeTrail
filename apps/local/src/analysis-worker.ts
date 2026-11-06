import { parentPort, workerData } from "node:worker_threads";
import { analyzeProject } from "@codegraph/analyzer";
import type { AnalyzeRequest, CapturedSource } from "@codegraph/shared";

let sources: CapturedSource[] = [];
try {
  const snapshot = analyzeProject(workerData as AnalyzeRequest, {
    onProgress: (phase) => parentPort!.postMessage({ type: "progress", phase }),
    onSources: (captured) => { sources = captured; },
  });
  parentPort!.postMessage({ type: "complete", snapshot, sources });
} catch (error) {
  parentPort!.postMessage({ type: "failed", error: error instanceof Error ? error.message : "代码分析失败" });
}
