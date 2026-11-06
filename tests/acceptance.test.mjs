import assert from "node:assert/strict";
import test, { after } from "node:test";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { tempProject } from "./helpers.mjs";
import { representativeProjects, copyRepresentative, prepareGitDemo, root } from "../scripts/acceptance-projects.mjs";
import { createLocalServer } from "../apps/local/dist/server.js";

const results = [];
after(() => {
  const output = path.join(root, "artifacts/phase-five"); mkdirSync(output, { recursive: true });
  writeFileSync(path.join(output, "representatives.json"), JSON.stringify({ generatedAt: new Date().toISOString(), scope: "Authored representative examples; not independent team projects or human trials.", passed: results.length === 3 && results.every((item) => item.passed), results }, null, 2));
});
async function finished(request, id, comparison = false) {
  for (let index = 0; index < 400; index++) {
    const job = await request(`${comparison ? "/comparison-jobs" : "/analyses"}/${id}`);
    if (job.status !== "running") { assert.equal(job.status, "completed", job.error); return job; }
    await delay(25);
  }
  throw Error("Representative job did not finish");
}
for (const descriptor of representativeProjects) test(`${descriptor.name}: overview → search → graph → evidence → reading → local explanation → persisted restart`, async (t) => {
  let server;
  t.after(async () => { await server?.app.close(); });
  const temporary = tempProject(t), cache = tempProject(t);
  const project = path.join(temporary.root, descriptor.name);
  if (descriptor.name === "git-alias") prepareGitDemo(project); else copyRepresentative(descriptor.name, project);
  const options = { rootDir: project, dataDirectory: cache.root, ai: { apiKey: "", model: "" } };
  server = await createLocalServer(options);
  let origin = new URL(await server.listen(0)).origin;
  const request = async (suffix, body, method = "GET") => {
    const response = await fetch(`${origin}/api${suffix}`, { method, headers: { Authorization: `Bearer ${server.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok, `${suffix}: ${response.status}`); return response.json();
  };
  const session = await request("/session"), job = await finished(request, session.job.id);
  const base = `/snapshots/${encodeURIComponent(job.snapshotId)}`;
  const overview = await request(`${base}/overview`);
  assert.ok(overview.modules.length > 0 && overview.statistics.files >= 6);
  const search = await request(`${base}/search?q=${descriptor.focus}`), node = search.results.find((item) => item.name === descriptor.focus && item.path === descriptor.path);
  assert.ok(node);
  const graph = await request(`${base}/graph?focus=${encodeURIComponent(node.id)}&depth=2`);
  assert.ok(graph.nodes.length <= 100);
  const snapshot = server.manager.explorer(job.snapshotId).snapshot;
  const names = new Map(snapshot.symbols.map((item) => [item.id, item.qualifiedName]));
  for (const expected of [descriptor.relation, descriptor.core]) assert.ok(snapshot.relations.some((edge) => edge.kind === expected.kind && names.get(edge.from) === expected.from && names.get(edge.to) === expected.to), JSON.stringify(expected));
  for (const proof of snapshot.evidence) {
    const content = server.manager.store.source(snapshot.id, proof.fileId);
    assert.equal(content.slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
    assert.equal(createHash("sha256").update(content).digest("hex"), proof.fileHash);
  }
  const relation = snapshot.relations.find((edge) => edge.kind === descriptor.relation.kind && names.get(edge.from) === descriptor.relation.from && names.get(edge.to) === descriptor.relation.to);
  const evidence = await request(`${base}/evidence/${encodeURIComponent(relation.evidenceId)}`);
  const source = await request(`${base}/files/${encodeURIComponent(evidence.fileId)}?evidence=${encodeURIComponent(evidence.id)}`);
  assert.equal(source.highlight.start.line, evidence.range.start.line);
  assert.equal(source.file.hash, evidence.fileHash);
  const guide = await request(`${base}/reading`);
  assert.ok(guide.groups.flatMap((group) => group.items).length > 0);
  assert.ok(guide.readingOrder.length > 0);
  for (const item of guide.groups.flatMap((group) => group.items)) for (const reason of item.reasons) assert.ok(reason.evidenceIds.every((id) => snapshot.evidence.some((proof) => proof.id === id)));
  const list = await request(`${base}/reading-list`, { nodeId: node.id }, "POST");
  await request(`/reading-list/${list.items[0].key}`, { read: true }, "PATCH");
  const preview = await request(`${base}/explanations/preview`, { nodeId: node.id, action: "explain", audience: "guided" }, "POST");
  assert.ok(preview.evidence.length && preview.facts.length);
  assert.ok(preview.facts.every((fact) => fact.evidenceIds.every((id) => preview.evidence.some((proof) => proof.id === id))));
  assert.equal((await request("/ai")).enabled, false);
  let comparisonStatistics = null;
  if (descriptor.name === "git-alias") {
    const comparison = await finished(request, (await request("/comparisons", {}, "POST")).id, true);
    const report = await request(`/comparisons/${encodeURIComponent(comparison.comparisonId)}/impact`);
    assert.ok(report.paths.some((item) => item.side === "base" && item.seed.name === "legacyDiscount" && item.target.name === "legacyOrder"));
    assert.ok(report.paths.some((item) => item.seed.name === "amount" && item.target.name === "submit"));
    assert.ok(report.paths.some((item) => item.test));
    assert.ok(report.changes.some((item) => item.kind === "rename_candidate"));
    assert.ok(report.changes.some((item) => item.untracked));
    comparisonStatistics = report.statistics;
  }
  await server.app.close(); server = await createLocalServer(options); origin = new URL(await server.listen(0)).origin;
  const reopened = await request("/session"); assert.equal(reopened.latestSnapshotId, job.snapshotId); assert.equal(reopened.job, null);
  assert.equal((await request(`${base}/reading-list`)).readCount, 1);
  results.push({ name: descriptor.name, title: descriptor.title, passed: true, status: snapshot.status, statistics: snapshot.statistics, verifiedEvidence: snapshot.evidence.length, verifiedRelations: [descriptor.relation, descriptor.core], comparisonStatistics });
});
