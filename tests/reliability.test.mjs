import assert from "node:assert/strict";
import test from "node:test";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { tempProject } from "./helpers.mjs";
import { createLocalServer } from "../apps/local/dist/server.js";
import { SnapshotStore } from "../apps/local/dist/store.js";
import { analyzeProject } from "../packages/analyzer/dist/index.js";
import { prepareGitDemo, root } from "../scripts/acceptance-projects.mjs";

const execute = promisify(execFile);
async function jobDone(server, comparison = false) {
  for (let index = 0; index < 300; index++) {
    const job = comparison ? server.comparisons.job() : server.manager.job();
    if (job?.status !== "running") return job;
    await delay(25);
  }
  throw Error("Failure-case job never ended");
}

test("malformed UTF-8 is an explicit partial-result exclusion; healthy files still publish through SQLite", async (t) => {
  let server;
  t.after(async () => { await server?.app.close(); });
  const project = tempProject(t, { "healthy.ts": "\uFEFFexport function healthy() { return 1; }" }), cache = tempProject(t);
  writeFileSync(path.join(project.root, "broken.ts"), Buffer.from([0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0xff]));
  server = await createLocalServer({ rootDir: project.root, dataDirectory: cache.root, ai: { apiKey: "", model: "" } });
  await server.listen(0);
  const job = await jobDone(server);
  assert.equal(job.status, "completed", job.error);
  assert.equal(server.manager.latest.status, "partial");
  assert.equal(server.manager.latest.files.length, 1);
  assert.ok(server.manager.latest.diagnostics.some((item) => item.code === "SCAN_ENCODING"));
  assert.match(server.manager.store.source(job.snapshotId, server.manager.latest.files[0].id), /healthy/);
  assert.ok(server.manager.store.source(job.snapshotId, server.manager.latest.files[0].id).startsWith("\uFEFF"));
});

test("oversized source is excluded with a visible limit while valid source and API remain usable", async (t) => {
  let server;
  t.after(async () => { await server?.app.close(); });
  const project = tempProject(t, { "healthy.ts": "export const healthy = 1;", "large.ts": "//" + "x".repeat(1024 * 1024) }), cache = tempProject(t);
  server = await createLocalServer({ rootDir: project.root, dataDirectory: cache.root, ai: { apiKey: "", model: "" } }); await server.listen(0);
  assert.equal((await jobDone(server)).status, "completed");
  assert.equal(server.manager.latest.status, "partial");
  assert.ok(server.manager.latest.skipped.some((item) => item.reason === "size-limit"));
  assert.ok(server.manager.latest.symbols.some((item) => item.name === "healthy"));
});

test("CLI exits promptly and explains an occupied port or unusable cache directory", async (t) => {
  const listener = createServer(); t.after(() => listener.close());
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const project = tempProject(t, { "index.ts": "export const value = 1;" }), cache = tempProject(t);
  const cli = path.join(root, "apps/local/dist/cli.js");
  await assert.rejects(execute(process.execPath, [cli, "open", project.root, "--port", String(listener.address().port), "--data-dir", cache.root, "--no-browser"], { windowsHide: true, timeout: 5000 }), (error) => error.code === 1 && /EADDRINUSE|address already in use/i.test(error.stderr));
  const blocked = path.join(cache.root, "cache-is-a-file"); writeFileSync(blocked, "occupied");
  await assert.rejects(execute(process.execPath, [cli, "open", project.root, "--data-dir", blocked, "--no-browser"], { windowsHide: true, timeout: 5000 }), (error) => error.code === 1 && /directory|ENOTDIR|EEXIST|缓存/i.test(error.stderr));
});

test("corrupted cached snapshot fails with recovery instructions and releases the database handle", async (t) => {
  const project = tempProject(t, { "index.ts": "export const value = 1;" }), cache = tempProject(t);
  let sources; const snapshot = analyzeProject({ rootDir: project.root }, { onSources: (value) => { sources = value; } });
  const store = new SnapshotStore(cache.root, project.root); store.save(snapshot, sources); const database = path.join(store.directory, "snapshots.sqlite"); store.close();
  const db = new DatabaseSync(database); db.prepare("UPDATE snapshots SET body = ?").run("{broken-json"); db.close();
  for (let index = 0; index < 2; index++) await assert.rejects(createLocalServer({ rootDir: project.root, dataDirectory: cache.root, ai: { apiKey: "", model: "" } }), /缓存.*损坏|缓存.*无法|cache.*invalid/i);
  const reopened = new DatabaseSync(database); reopened.close();
  writeFileSync(database, "not a SQLite database");
  await assert.rejects(createLocalServer({ rootDir: project.root, dataDirectory: cache.root, ai: { apiKey: "", model: "" } }), /缓存.*无法/);
});

test("AI connection failure falls back to cited local facts without hanging the service", async (t) => {
  let server;
  t.after(async () => { await server?.app.close(); });
  const listener = createServer(); await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const closedPort = listener.address().port; await new Promise((resolve) => listener.close(resolve));
  const project = tempProject(t, { "entry.ts": "export function main() { return 1; }" }), cache = tempProject(t);
  server = await createLocalServer({ rootDir: project.root, dataDirectory: cache.root, ai: { apiKey: "failure-test-not-a-key", model: "test-model", baseUrl: `http://127.0.0.1:${closedPort}/v1`, timeoutMs: 1000 } });
  const origin = new URL(await server.listen(0)).origin; const job = await jobDone(server);
  const request = async (route, body, method = "GET") => {
    const response = await fetch(`${origin}/api${route}`, { method, headers: { Authorization: `Bearer ${server.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok); return response.json();
  };
  const node = server.manager.explorer(job.snapshotId).search("main").results[0], body = { nodeId: node.id, action: "explain", audience: "guided" };
  const base = `/snapshots/${encodeURIComponent(job.snapshotId)}`;
  const preview = await request(`${base}/explanations/preview`, body, "POST"); await request("/ai", { enabled: true }, "PATCH");
  const result = await request(`${base}/explanations`, { ...body, source: "ai", approvedPreviewId: preview.previewId }, "POST");
  assert.equal(result.source, "local"); assert.equal(result.fallbackReason, "provider_error"); assert.ok(result.facts.length && result.evidence.length);
  assert.ok((await request("/session")).latestSnapshotId);
});

test("unreadable Git metadata has an explicit current-only result and never invents a HEAD baseline", async (t) => {
  let server;
  t.after(async () => { await server?.app.close(); });
  const temporary = tempProject(t), cache = tempProject(t), project = prepareGitDemo(path.join(temporary.root, "project"));
  writeFileSync(path.join(project, ".git/config"), "not valid git config");
  server = await createLocalServer({ rootDir: project, dataDirectory: cache.root, ai: { apiKey: "", model: "" } }); await server.listen(0); await jobDone(server);
  server.comparisons.start(); const job = await jobDone(server, true);
  assert.equal(job.status, "completed", job.error);
  const report = server.comparisons.report(job.comparisonId);
  assert.equal(report.baseline.state, "unavailable"); assert.equal(report.baseSnapshotId, null); assert.equal(report.paths.length, 0);
  assert.ok(report.changes.length > 0);
});
