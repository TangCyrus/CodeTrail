import assert from "node:assert/strict";
import { readFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { createLocalServer } from "../apps/local/dist/server.js";
import { SnapshotStore } from "../apps/local/dist/store.js";
import { analyzeProject, isSnapshotStale } from "../packages/analyzer/dist/index.js";
import { tempProject } from "./helpers.mjs";
import { projectRoot } from "../scripts/fixture-tools.mjs";

async function start(t, { files, autoAnalyze = true } = {}) {
  let server;
  t.after(async () => { if (server) await server.app.close(); });
  const cache = tempProject(t);
  const project = files ? tempProject(t, files) : null;
  server = await createLocalServer({ rootDir: project?.root ?? path.join(projectRoot, "fixtures/reference-lab"), dataDirectory: cache.root, autoAnalyze, ai: { apiKey: "", model: "" } });
  const url = new URL(await server.listen(0));
  const headers = { Authorization: `Bearer ${server.token}` };
  const request = (suffix, options = {}) => fetch(`${url.origin}/api${suffix}`, { ...options, headers: { ...headers, ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers } });
  return { server, url, headers, request, project, cache };
}
async function waitForJob(request, id) {
  for (let count = 0; count < 100; count++) {
    const result = await request(`/analyses/${id}`);
    const job = await result.json();
    if (job.status !== "running") return job;
    await delay(30);
  }
  throw new Error("Analysis worker timed out");
}

test("local API requires a session and rejects foreign Origin, Host and root overrides", async (t) => {
  const { url, request, server, headers } = await start(t, { autoAnalyze: false });
  assert.equal((await fetch(`${url.origin}/api/session`)).status, 401);
  assert.equal((await request("/session", { headers: { Origin: "https://untrusted.invalid" } })).status, 403);
  assert.equal((await server.app.inject({ url: "/api/session", headers: { ...headers, Host: "untrusted.invalid" } })).statusCode, 403);
  assert.equal((await request("/analyses", { method: "POST", body: JSON.stringify({ rootDir: "C:/" }) })).status, 400);
  const staticPage = await fetch(url.origin);
  assert.equal(staticPage.status, 200);
  assert.match(staticPage.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await staticPage.text(), /CodeTrail/);
});

test("worker analysis streams stages and serves overview, search, graph and matching source evidence", async (t) => {
  const { request } = await start(t, { autoAnalyze: false });
  const response = await request("/analyses", { method: "POST", body: "{}" });
  assert.equal(response.status, 202);
  const job = await response.json();
  const stream = await request(`/analyses/${job.id}/events`);
  const events = await stream.text();
  assert.match(events, /event: progress/);
  assert.match(events, /"phase":"compiling"/);
  assert.match(events, /"status":"completed"/);
  const finished = await waitForJob(request, job.id);
  const id = finished.snapshotId;
  const overview = await (await request(`/snapshots/${id}/overview`)).json();
  assert.equal(overview.statistics.files, 14);
  const results = await (await request(`/snapshots/${id}/search?q=normalize`)).json();
  const normalize = results.results[0];
  const graph = await (await request(`/snapshots/${id}/graph?focus=${encodeURIComponent(normalize.id)}`)).json();
  assert.equal(graph.scope, "symbol");
  const edge = graph.edges.find((edge) => edge.kind === "CALLS");
  const proof = await (await request(`/snapshots/${id}/evidence/${encodeURIComponent(edge.evidenceIds[0])}`)).json();
  const source = await (await request(`/snapshots/${id}/files/${encodeURIComponent(proof.fileId)}?evidence=${encodeURIComponent(proof.id)}`)).json();
  assert.equal(source.file.hash, proof.fileHash);
  assert.equal(source.highlight.start.line, proof.range.start.line);
  assert.equal(source.matchesCurrentFile, true);
  assert.ok(source.lines.some((line) => line.text.includes(proof.excerpt)));
  assert.equal((await request(`/snapshots/${id}/files/not-indexed`)).status, 404);
  assert.equal((await request(`/snapshots/${id}/graph?depth=99`)).status, 400);
});

test("cancelling a running worker preserves the last complete snapshot and allows retry", async (t) => {
  const { request } = await start(t, { autoAnalyze: false });
  const first = await (await request("/analyses", { method: "POST", body: "{}" })).json();
  const completed = await waitForJob(request, first.id);
  const next = await (await request("/analyses", { method: "POST", body: "{}" })).json();
  assert.equal((await request(`/analyses/${next.id}`, { method: "DELETE" })).status, 200);
  const session = await (await request("/session")).json();
  assert.equal(session.latestSnapshotId, completed.snapshotId);
  assert.equal(session.job.status, "cancelled");
  const retry = await (await request("/analyses", { method: "POST", body: "{}" })).json();
  assert.equal((await waitForJob(request, retry.id)).status, "completed");
});

test("saved source stays tied to its snapshot after editing and deleting the current file", async (t) => {
  const { project, request } = await start(t, { files: { "index.ts": "export function saved() { return 1; }\n" } });
  const session = await (await request("/session")).json();
  const done = await waitForJob(request, session.job.id);
  const overview = await (await request(`/snapshots/${done.snapshotId}/overview`)).json();
  project.write("index.ts", "export function saved() { return 2; }\n");
  const source = await (await request(`/snapshots/${done.snapshotId}/files/${encodeURIComponent(overview.files[0].id)}`)).json();
  assert.equal(source.matchesCurrentFile, false);
  assert.match(source.lines[0].text, /return 1/);
  assert.equal((await (await request(`/snapshots/${done.snapshotId}/status`)).json()).stale, true);
  unlinkSync(path.join(project.root, "index.ts"));
  const deleted = await (await request(`/snapshots/${done.snapshotId}/files/${encodeURIComponent(overview.files[0].id)}`)).json();
  assert.equal(deleted.matchesCurrentFile, false);
  assert.match(deleted.lines[0].text, /return 1/);
});

test("SQLite reopens a valid snapshot and rejects mismatched source before changing latest", (t) => {
  const cache = tempProject(t);
  const project = tempProject(t, { "index.ts": "export const saved = 1;" });
  let sources;
  const snapshot = analyzeProject({ rootDir: project.root }, { onSources: (captured) => { sources = captured; } });
  let store = new SnapshotStore(cache.root, project.root);
  store.save(snapshot, sources);
  const fileId = snapshot.files[0].id;
  assert.equal(store.source(snapshot.id, fileId), readFileSync(path.join(project.root, "index.ts"), "utf8"));
  assert.throws(() => store.save(snapshot, sources.map((source) => ({ ...source, content: "changed" }))), /mismatch/);
  store.close();
  store = new SnapshotStore(cache.root, project.root);
  assert.equal(store.latest().id, snapshot.id);
  store.close();
  assert.equal(isSnapshotStale(snapshot), false);
  project.write("new.ts", "export const added = 1;");
  assert.equal(isSnapshotStale(snapshot), true);
});
