import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalServer } from "../apps/local/dist/server.js";

const [mode, directory, cache] = process.argv.slice(2);
const start = performance.now();
const summary = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { samples: values.map((value) => +value.toFixed(3)), medianMs: +sorted[Math.floor(sorted.length / 2)].toFixed(3), p95Ms: +sorted[Math.ceil(sorted.length * .95) - 1].toFixed(3), maxMs: +sorted.at(-1).toFixed(3) };
};
const create = () => createLocalServer({ rootDir: directory, dataDirectory: cache, autoAnalyze: false, ai: { apiKey: "", model: "" } });
let server;
try {
  server = await create(); let origin = new URL(await server.listen(0)).origin;
  const request = async (route) => {
    const response = await fetch(`${origin}/api${route}`, { headers: { Authorization: `Bearer ${server.token}` } });
    assert.ok(response.ok, `${route}: ${response.status}`); return response.json();
  };
  const wait = async (comparison) => {
    for (let index = 0; index < 12_000; index++) {
      const job = comparison ? server.comparisons.job() : server.manager.job();
      if (job.status !== "running") { assert.equal(job.status, "completed", job.error); return job; }
      await delay(10);
    }
    throw Error("Benchmark job exceeded 120 seconds");
  };
  let result;
  if (mode === "cold") {
    server.manager.start(); const job = await wait(false);
    const overview = await request(`/snapshots/${encodeURIComponent(job.snapshotId)}/overview`);
    result = { firstAnalysisMs: +(performance.now() - start).toFixed(3), snapshotId: overview.snapshotId, sourceLines: server.manager.latest.files.reduce((sum, file) => sum + file.lineCount, 0), sourceBytes: server.manager.latest.files.reduce((sum, file) => sum + file.bytes, 0), status: overview.status, statistics: overview.statistics, partial: overview.status === "partial" };
  } else if (mode === "comparison") {
    const began = performance.now(); server.comparisons.start(); const job = await wait(true);
    const elapsed = performance.now() - began;
    const bundle = server.comparisons.bundle(job.comparisonId);
    assert.equal(bundle.report.baseline.state, "ready");
    assert.ok(bundle.base);
    result = { comparisonMs: +elapsed.toFixed(3), baselineFiles: bundle.base.snapshot.statistics.files, currentFiles: bundle.current.snapshot.statistics.files, statistics: bundle.report.statistics };
  } else if (mode === "warm") {
    const reopen = [];
    let overview;
    for (let index = 0; index < 3; index++) {
      if (index) { const began = performance.now(); server = await create(); origin = new URL(await server.listen(0)).origin; reopen.push(-began); }
      else reopen.push(-start);
      const session = await request("/session"); assert.ok(session.latestSnapshotId); assert.equal(session.job, null);
      overview = await request(`/snapshots/${encodeURIComponent(session.latestSnapshotId)}/overview`);
      reopen[index] += performance.now();
      if (index < 2) await server.app.close();
    }
    const base = `/snapshots/${encodeURIComponent(overview.snapshotId)}`;
    const model = server.manager.explorer(overview.snapshotId);
    const nodes = [...model.nodes.values()].filter((node) => node.kind === "function" || node.kind === "method");
    assert.ok(nodes.length);
    const timings = { search: [], graph1: [], graph2: [], reading: [] }; let largestGraph = 0;
    for (const category of ["search", "graph1", "graph2"]) for (let index = 0; index < 45; index++) {
      const node = nodes[(index * 13) % nodes.length];
      const route = category === "search" ? `${base}/search?q=${encodeURIComponent(node.name)}` : `${base}/graph?focus=${encodeURIComponent(node.id)}&depth=${category === "graph1" ? 1 : 2}`;
      const began = performance.now(); const body = await request(route); const elapsed = performance.now() - began;
      if (body.nodes) { assert.ok(body.nodes.length <= 100); largestGraph = Math.max(largestGraph, body.nodes.length); }
      if (index >= 5) timings[category].push(elapsed);
    }
    for (let index = 0; index < 5; index++) {
      const began = performance.now(); await request(`${base}/reading`); timings.reading.push(performance.now() - began);
    }
    result = { cacheReopen: summary(reopen), queries: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, summary(values)])), largestGraph, status: overview.status, statistics: overview.statistics };
  } else throw Error("Unknown benchmark mode");
  result.nodePeakRssBytes = process.resourceUsage().maxRSS * 1024;
  await server.app.close(); server = null;
  process.stdout.write(JSON.stringify(result));
} finally { await server?.app.close(); }
