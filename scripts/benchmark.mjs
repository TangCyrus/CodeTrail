import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { generateWorkload, gitInOwnedDemo, representativeProjects, root, prepareGitDemo } from "./acceptance-projects.mjs";

const execute = promisify(execFile), output = path.join(root, "artifacts/phase-five"); mkdirSync(output, { recursive: true });
const run = mkdtempSync(path.join(output, "performance-"));
const report = {
  generatedAt: new Date().toISOString(), runDirectory: run, environment: { node: process.version, platform: process.platform, osRelease: os.release(), architecture: process.arch, cpu: os.cpus()[0]?.model, logicalCpus: os.cpus().length, totalMemoryBytes: os.totalmem() },
  method: { coldSamples: 3, querySamples: 40, queryWarmups: 5, cold: "Fresh Node process, worker analysis, SQLite save and first overview; OS filesystem cache is not flushed. Parent wall time includes process/module startup and shutdown.", warm: "Fresh benchmark process reopens an existing SQLite cache three times; HTTP timings include JSON and loopback transport.", memory: "OS-reported Node process peak RSS, including worker threads, excluding Git child processes.", scope: "Authored examples, deterministic 100/500-file workloads and the tool's own checkout. Not real-team performance or human usability results." },
  budgets: { firstAnalysisMs: 60000, searchP95Ms: 1000, graphP95Ms: 1000, maxGraphNodes: 100 }, cases: [], comparisons: [], passed: true,
};
const worker = async (mode, directory, cache) => {
  const began = performance.now();
  const { stdout } = await execute(process.execPath, [path.join(root, "scripts/benchmark-worker.mjs"), mode, directory, cache], { cwd: root, windowsHide: true, timeout: 150_000, maxBuffer: 2 * 1024 * 1024 });
  return { ...JSON.parse(stdout), processWallMs: +(performance.now() - began).toFixed(3) };
};
const cases = representativeProjects.map((project) => ({ name: project.name, directory: project.name === "git-alias" ? prepareGitDemo(path.join(run, "git-alias")) : path.join(root, "examples", project.name), kind: "representative" }));
for (const count of [100, 500]) cases.push({ name: `generated-${count}`, directory: generateWorkload(path.join(run, `generated-${count}`), count), kind: "generated" });
cases.push({ name: "codetrail-self", directory: root, kind: "self" });
try { report.environment.git = (await execute("git", ["--version"], { windowsHide: true })).stdout.trim(); } catch { report.environment.git = "unavailable"; }
for (const item of cases) {
  process.stdout.write(`Benchmark: ${item.name}\n`);
  try {
    const cold = [];
    for (let index = 0; index < 3; index++) cold.push(await worker("cold", item.directory, path.join(run, `${item.name}-cache-${index}`)));
    const warm = await worker("warm", item.directory, path.join(run, `${item.name}-cache-0`));
    const passed = cold.every((sample) => sample.firstAnalysisMs <= report.budgets.firstAnalysisMs)
      && warm.queries.search.p95Ms <= report.budgets.searchP95Ms && warm.queries.graph1.p95Ms <= report.budgets.graphP95Ms && warm.queries.graph2.p95Ms <= report.budgets.graphP95Ms && warm.largestGraph <= report.budgets.maxGraphNodes;
    report.cases.push({ name: item.name, kind: item.kind, cold, warm, passed }); report.passed &&= passed;
    process.stdout.write(`  ${cold[0].statistics.files} files; search p95 ${warm.queries.search.p95Ms} ms; graph2 p95 ${warm.queries.graph2.p95Ms} ms; reading p95 ${warm.queries.reading.p95Ms} ms\n`);
  } catch (error) { report.cases.push({ name: item.name, passed: false, error: error.message }); report.passed = false; }
}
for (const count of [100, 500]) {
  process.stdout.write(`Git comparison: ${count} files\n`);
  try {
    const directory = generateWorkload(path.join(run, `git-${count}`), count);
    gitInOwnedDemo(directory, ["init", "--quiet", "--initial-branch=main"]); gitInOwnedDemo(directory, ["add", "--all"]); gitInOwnedDemo(directory, ["commit", "--quiet", "-m", "Performance baseline"]);
    const target = path.join(directory, "src/modules/m000.ts"); writeFileSync(target, readFileSync(target, "utf8").replace("value + 0", "value + 1"));
    const samples = [];
    for (let index = 0; index < 3; index++) samples.push(await worker("comparison", directory, path.join(run, `git-${count}-cache-${index}`)));
    report.comparisons.push({ files: count, samples, passed: true });
    process.stdout.write(`  ${samples.map((sample) => `${Math.round(sample.comparisonMs)} ms`).join(", ")}\n`);
  } catch (error) { report.comparisons.push({ files: count, passed: false, error: error.message }); report.passed = false; }
}
writeFileSync(path.join(output, "performance.json"), JSON.stringify(report, null, 2));
process.stdout.write(`Performance ${report.passed ? "passed" : "failed"}: artifacts/phase-five/performance.json\n`);
if (!report.passed) process.exitCode = 1;
