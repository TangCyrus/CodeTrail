import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { tempProject } from "./helpers.mjs";
import { createGitFixture, gitCommand } from "./git-fixture.mjs";
import { inspectGit, materializeBaseline } from "../apps/local/dist/git.js";
import { SnapshotStore } from "../apps/local/dist/store.js";
import { ComparisonManager } from "../apps/local/dist/comparison-manager.js";
import { changedLines, calculateComparisonImpact, compareSnapshots } from "../packages/graph/dist/index.js";
import { analyzeProject } from "../packages/analyzer/dist/index.js";
import { createLocalServer } from "../apps/local/dist/server.js";

async function done(manager, job) {
  for (let index = 0; index < 250; index++) {
    const current = manager.job(job.id);
    if (current.status !== "running") { assert.equal(current.status, "completed", current.error); return manager.bundle(current.comparisonId); }
    await delay(30);
  }
  throw Error("Comparison worker timed out");
}
async function setup(t, mutate = true) {
  let manager, store;
  t.after(async () => { await manager?.close(); store?.close(); });
  const project = tempProject(t), cache = tempProject(t);
  const fixture = createGitFixture(project.root);
  if (mutate) fixture.change();
  store = new SnapshotStore(cache.root, project.root); manager = new ComparisonManager(project.root, store);
  return { fixture, project, cache, manager, store };
}

test("Git HEAD capture is bounded, handles Chinese/spaced paths and keeps index, worktree and HEAD unchanged", async (t) => {
  const { fixture, manager } = await setup(t);
  const index = readFileSync(path.join(fixture.root, ".git/index"));
  const head = gitCommand(fixture.root, ["rev-parse", "HEAD"]);
  const status = gitCommand(fixture.root, ["status", "--porcelain=v1", "-z"]);
  const bundle = await done(manager, manager.start());
  assert.equal(bundle.report.baseline.state, "ready");
  assert.equal(bundle.report.baseline.head, head.trim());
  assert.match(bundle.current.sources.find((file) => file.path === "src/math.ts").content, /floor = 2/);
  assert.match(bundle.base.sources.find((file) => file.path === "src/math.ts").content, /value < 0/);
  assert.ok(bundle.report.changes.some((change) => change.untracked && change.newFile.path === "src/新增 helper.ts"));
  assert.deepEqual(readFileSync(path.join(fixture.root, ".git/index")), index);
  assert.equal(gitCommand(fixture.root, ["rev-parse", "HEAD"]), head);
  assert.equal(gitCommand(fixture.root, ["status", "--porcelain=v1", "-z"]), status);
});

test("deleted symbols retain old callers; signature, unique renames and two-hop paths carry same-version source evidence", async (t) => {
  const { manager } = await setup(t);
  const bundle = await done(manager, manager.start());
  const { report } = bundle;
  assert.ok(report.changes.some((change) => change.kind === "rename_candidate" && change.oldFile.path === "src/rename.ts" && change.newFile.path === "src/renamed.ts"));
  assert.ok(report.changes.find((change) => change.newFile?.path === "src/math.ts").symbols.some((symbol) => symbol.newNode?.name === "normalize" && symbol.kind === "signature"));
  const deleted = report.paths.find((item) => item.side === "base" && item.seed.name === "removed" && item.target.name === "legacy");
  assert.ok(deleted);
  assert.ok(!report.paths.some((item) => item.side === "current" && item.seed.name === "removed"));
  assert.ok(report.paths.some((item) => item.seed.name === "normalize" && item.target.name === "main" && item.distance === 2));
  assert.ok(report.paths.some((item) => item.test && item.target.path === "tests/service.test.ts"));
  for (const item of report.paths) {
    const snapshot = bundle[item.side].snapshot;
    let node = item.seed.id;
    assert.ok(item.distance <= 2);
    for (const step of item.steps) {
      assert.equal(step.to.id, node); node = step.from.id;
      const edge = snapshot.relations.find((edge) => edge.from === step.from.id && edge.to === step.to.id && edge.evidenceId === step.evidenceId && edge.kind === step.kind);
      assert.ok(edge); assert.equal(edge.origin, "static");
      const proof = snapshot.evidence.find((proof) => proof.id === step.evidenceId);
      const source = bundle[item.side].sources.find((source) => source.path === snapshot.files.find((file) => file.id === proof.fileId).path);
      assert.equal(source.content.slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
      assert.equal(source.hash, proof.fileHash);
    }
    assert.equal(node, item.target.id);
  }
});

test("pure type dependency propagation is opt-in and does not become a value call", async (t) => {
  const { manager } = await setup(t);
  const bundle = await done(manager, manager.start());
  assert.ok(!bundle.report.paths.some((item) => item.seed.name === "Payload"));
  const typed = calculateComparisonImpact(bundle.report, bundle.base.snapshot, bundle.current.snapshot, true);
  assert.ok(typed.paths.some((item) => item.seed.name === "Payload" && item.dependency === "type"));
  assert.ok(typed.paths.filter((item) => item.seed.name === "Payload").every((item) => item.steps.every((step) => step.usage === "type")));
});

test("line insertion changes offsets without remapping unchanged functions as modified; scope exclusions are not deletions", async (t) => {
  const { fixture, manager } = await setup(t, false);
  fixture.write("src/math.ts", `// inserted heading\n${fixture.files["src/math.ts"]}`);
  fixture.write(".codetrailignore", "src/obsolete.ts\n");
  const bundle = await done(manager, manager.start());
  const math = bundle.report.changes.find((change) => change.newFile?.path === "src/math.ts");
  assert.ok(math.symbols.every((mapping) => mapping.kind === "unchanged" || mapping.kind === "modified" && mapping.newNode.name === "normalize"));
  const old = math.symbols.find((mapping) => mapping.newNode?.name === "normalize");
  assert.ok(old.oldNode && old.newNode);
  assert.equal(old.kind, "unchanged");
  assert.notEqual(old.oldNode.range.start.line, old.newNode.range.start.line);
  assert.equal(old.basis, "identity");
  assert.ok(bundle.report.changes.some((change) => change.oldFile?.path === "src/obsolete.ts" && change.kind === "scope"));
  assert.ok(!bundle.report.paths.some((item) => item.seed.name === "removed"));
});

test("missing repository and unborn HEAD produce explicit current-only reports with no invented historical paths", async (t) => {
  let manager, store;
  t.after(async () => { await manager?.close(); store?.close(); });
  const project = tempProject(t, { "index.ts": "export const current = 1;" }, { outsideRepository: true }), cache = tempProject(t);
  assert.equal((await inspectGit(project.root)).state, "not_repository");
  store = new SnapshotStore(cache.root, project.root); manager = new ComparisonManager(project.root, store);
  let bundle = await done(manager, manager.start());
  assert.equal(bundle.report.baseline.state, "not_repository"); assert.equal(bundle.report.paths.length, 0);
  gitCommand(project.root, ["init", "--quiet"]);
  bundle = await done(manager, manager.start());
  assert.equal(bundle.report.baseline.state, "no_head"); assert.equal(bundle.report.baseSnapshotId, null);
  assert.ok(bundle.report.changes.length > 0); assert.equal(bundle.report.paths.length, 0);
});

test("baseline scope does not expand to siblings, links, environment files or executable configuration", async (t) => {
  const { fixture } = await setup(t, false);
  fixture.write("sub/index.ts", "export const scoped = 1;");
  fixture.write("sub/.env.secret.ts", "export const privateKey = 'never indexed';");
  fixture.write("sub/vite.config.js", "throw new Error('must never execute');");
  fixture.write("sub/link.ts", "../../outside.ts");
  gitCommand(fixture.root, ["add", "--all"]); gitCommand(fixture.root, ["commit", "--quiet", "-m", "Scoped baseline"]);
  const linkBlob = gitCommand(fixture.root, ["hash-object", "-w", "--", "sub/link.ts"]).trim();
  gitCommand(fixture.root, ["update-index", "--add", "--cacheinfo", `120000,${linkBlob},sub/link.ts`]);
  gitCommand(fixture.root, ["commit", "--quiet", "-m", "Historical symbolic link mode"]);
  const info = await inspectGit(path.join(fixture.root, "sub"), true);
  assert.equal(info.scope, "sub"); assert.ok(info.entries.every((entry) => !entry.path.startsWith("src/")));
  const destination = path.join(fixture.root, "scratch"); mkdirSync(destination);
  await materializeBaseline(info, destination);
  assert.ok(existsSync(path.join(destination, "index.ts")));
  assert.equal(existsSync(path.join(destination, ".env.secret.ts")), false);
  assert.equal(existsSync(path.join(destination, "src")), false);
  assert.equal(existsSync(path.join(destination, "link.ts")), false);
});

test("line diff is bounded and preserves exact CRLF line positions, including pure additions and removals", () => {
  assert.deepEqual(changedLines("a\r\nb\r\nc", "a\r\nB\r\nc"), [{ oldStart: 2, oldLines: 1, newStart: 2, newLines: 1, coarse: false }]);
  assert.equal(changedLines("", "x")[0].newLines, 1);
  assert.equal(changedLines("x", "")[0].oldLines, 1);
  assert.equal(changedLines("a\n".repeat(1100), "b\n".repeat(1100))[0].coarse, true);
});

test("comparison persistence survives snapshot pruning; stale HEAD and source edits are detected; cancel retains the last result", async (t) => {
  const { fixture, manager, store, cache } = await setup(t);
  const bundle = await done(manager, manager.start());
  assert.equal(await manager.stale(bundle.report.id), false);
  gitCommand(fixture.root, ["commit", "--quiet", "--allow-empty", "-m", "HEAD changed without source edits"]);
  assert.equal(await manager.stale(bundle.report.id), true);
  for (let index = 0; index < 4; index++) {
    const snapshot = structuredClone(bundle.current.snapshot);
    snapshot.id = `temporary-analysis-${index}`; snapshot.createdAt = new Date(Date.now() + index).toISOString();
    store.save(snapshot, bundle.current.sources);
  }
  assert.ok(store.comparison(bundle.report.id));
  const reopened = new SnapshotStore(cache.root, fixture.root);
  try { assert.equal(reopened.latestComparison().report.id, bundle.report.id); assert.ok(reopened.comparison(bundle.report.id).base.sources.length); }
  finally { reopened.close(); }
  fixture.write("src/entry.ts", "export function changed() { return 42; }");
  assert.equal(await manager.stale(bundle.report.id), true);
  assert.match(store.comparison(bundle.report.id).base.sources.find((item) => item.path === "src/obsolete.ts").content, /removed/);
  const next = manager.start(); assert.equal(await manager.cancel(next.id), true);
  assert.equal(manager.job(next.id).status, "cancelled");
  assert.equal(store.latestComparison().report.id, bundle.report.id);
  const temp = path.join(store.directory, "comparison-temp");
  assert.equal(readdirSync(temp).length, 0);
});

test("cancelling an active baseline isolate releases its files and a later comparison preserves identical graph facts", async (t) => {
  const {fixture,manager,store}=await setup(t,false);
  for(let index=0;index<70;index++)fixture.write(`src/baseline-${index}.ts`,`export const value${index}=${index};`);
  gitCommand(fixture.root,["add","--all"]);gitCommand(fixture.root,["commit","--quiet","-m","Baseline isolate corpus"]);
  const job=manager.start();
  for(let index=0;index<1000&&manager.job(job.id).phase!=="baseline";index++)await delay(5);
  await delay(100);
  assert.equal(manager.job(job.id).phase,"baseline");
  assert.equal(await manager.cancel(job.id),true);
  assert.equal(manager.job(job.id).status,"cancelled");
  assert.equal(readdirSync(path.join(store.directory,"comparison-temp")).length,0);
  const bundle=await done(manager,manager.start());
  assert.equal(bundle.report.changes.length,0);
  for(const field of ["files","symbols","relations","evidence","unresolved"])assert.deepEqual(bundle.base.snapshot[field],bundle.current.snapshot[field],field);
});

test("CRLF checkout conversion alone produces no code change while the captured versions retain exact bytes", async (t) => {
  const { fixture, manager } = await setup(t, false);
  for (const [name, content] of Object.entries(fixture.files)) fixture.write(name, content.replaceAll("\n", "\r\n"));
  const bundle = await done(manager, manager.start());
  assert.equal(bundle.report.changes.length, 0);
  assert.ok(bundle.current.sources[0].content.includes("\r\n"));
  assert.ok(!bundle.base.sources[0].content.includes("\r\n"));
});

test("Git metadata inspection never invokes clean filters, textconv, external diff or fsmonitor hooks", async (t) => {
  const { fixture, manager } = await setup(t, false);
  fixture.write("spy.cjs", "require('node:fs').writeFileSync(require('node:path').join(__dirname, 'executed-marker'), 'bad'); process.stdin.resume();");
  fixture.write(".gitattributes", "*.ts filter=spy diff=spy\n");
  gitCommand(fixture.root, ["add", "--", ".gitattributes", "spy.cjs"]); gitCommand(fixture.root, ["commit", "--quiet", "-m", "Filter metadata"]);
  const command = `node "${path.join(fixture.root, "spy.cjs").replaceAll("\\", "/")}"`;
  for (const key of ["filter.spy.clean", "filter.spy.smudge", "diff.spy.textconv", "diff.external", "core.fsmonitor"]) gitCommand(fixture.root, ["config", key, command]);
  fixture.write("src/math.ts", "export function normalize(value: number) { return value + 1; }\n");
  const bundle = await done(manager, manager.start());
  assert.ok(bundle.report.changes.some((change) => change.newFile?.path === "src/math.ts"));
  assert.equal(existsSync(path.join(fixture.root, "executed-marker")), false);
});

test("batch baseline capture preserves Unicode, CRLF, empty and repeated blobs; rejects binary/encoding gaps without losing framing", async (t) => {
  const text = '\uFEFFexport const text = `中文\r\n' + '0'.repeat(40) + ' blob 0\n`;\r\n';
  const contents = Object.fromEntries(Array.from({ length: 220 }, (_, i) => [`src/f${i}.ts`, `export const value = ${i};\n`]));
  Object.assign(contents, { 'src/中文 space.ts': text, 'src/copy.ts': text, 'src/empty.ts': '',
    'src/binary.ts': Buffer.from([0, 10, 255]), 'src/invalid.ts': Buffer.from([255, 254]),
    'pnpm-workspace.yaml': "packages: ['packages/*']\n", 'pnpm-lock.yaml': 'lockfileVersion: 9\n', '.env': 'SECRET=private' });
  const project = tempProject(t, contents), destination = tempProject(t);
  gitCommand(project.root, ['init', '--quiet']); gitCommand(project.root, ['add', '--all']); gitCommand(project.root, ['commit', '--quiet', '-m', 'Batch source corpus']);
  const info = await inspectGit(project.root, true), before = gitCommand(project.root, ['status', '--porcelain=v1', '-z']);
  const warnings = await materializeBaseline(info, destination.root);
  for (const [name, content] of Object.entries(contents)) {
    const file = path.join(destination.root, name);
    if (Buffer.isBuffer(content) || name === '.env' || name === 'pnpm-lock.yaml') assert.equal(existsSync(file), false, name);
    else assert.equal(readFileSync(file, 'utf8'), content, name);
  }
  assert.ok(warnings.some(x => x.includes('2 个候选路径')));
  assert.equal(gitCommand(project.root, ['status', '--porcelain=v1', '-z']), before);
  const cancelled = tempProject(t), controller = new AbortController(); controller.abort();
  await assert.rejects(materializeBaseline(info, cancelled.root, controller.signal));
  assert.equal(readdirSync(cancelled.root).length, 0);
});

test("cycles, duplicate call/reference pairs and third-hop dependents stay bounded, and callbacks never become proven call steps", (t) => {
  const project = tempProject(t, { "index.ts": "export function leaf() { return 1; }\nexport function a(): number { return leaf() + b(); }\nexport function b(): number { return a(); }\nexport function c() { return b(); }\nfunction register(callback: () => number) {}\nexport function setup() { register(leaf); }\n" });
  const capture = () => { let sources; const snapshot = analyzeProject({ rootDir: project.root }, { onSources: (value) => { sources = value; } }); return { snapshot, sources }; };
  const old = capture();
  project.write("index.ts", readFileSync(path.join(project.root, "index.ts"), "utf8").replace("return 1", "return 2"));
  const current = capture();
  const report = compareSnapshots({ baseline: { state: "ready", head: "0".repeat(40), scope: "", message: "fixture" }, base: old.snapshot, current: current.snapshot, oldSources: old.sources, newSources: current.sources });
  assert.ok(report.paths.some((item) => item.target.name === "b" && item.seed.name === "leaf" && item.distance === 2));
  assert.ok(!report.paths.some((item) => item.target.name === "c" && item.seed.name === "leaf"));
  assert.equal(report.truncated, true);
  assert.ok(report.paths.every((item) => item.steps.every((step) => step.kind !== "REGISTERS_CALLBACK")));
  assert.equal(new Set(report.paths.map((item) => item.id)).size, report.paths.length);
  const capped = calculateComparisonImpact({ ...report, maxPaths: 1 }, old.snapshot, current.snapshot);
  assert.equal(capped.paths.length, 1); assert.equal(capped.truncated, true);
  const balanced = calculateComparisonImpact({ ...report, maxPaths: 2 }, old.snapshot, current.snapshot);
  assert.deepEqual(balanced.paths.map((item) => item.side), ["base", "current"]);
});

test("comparison API validates side/range, serves deleted source and relationship highlights, and never changes the analysis latest pointer", async (t) => {
  let server;
  t.after(async () => { await server?.app.close(); });
  const project = tempProject(t), cache = tempProject(t); const fixture = createGitFixture(project.root); fixture.change();
  server = await createLocalServer({ rootDir: project.root, dataDirectory: cache.root, autoAnalyze: false, ai: { apiKey: "", model: "" } });
  const origin = new URL(await server.listen(0)).origin;
  const request = (suffix, body, method = "GET") => fetch(`${origin}/api${suffix}`, { method, headers: { Authorization: `Bearer ${server.token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  assert.equal((await request("/comparisons", { rootDir: "C:/" }, "POST")).status, 400);
  const job = await (await request("/comparisons", {}, "POST")).json();
  const bundle = await done(server.comparisons, job), report = bundle.report;
  assert.equal((await (await request("/session")).json()).latestSnapshotId, null);
  const deleted = report.changes.find((change) => change.oldFile?.path === "src/obsolete.ts");
  const endpoint = `/comparisons/${encodeURIComponent(report.id)}`;
  const source = await (await request(`${endpoint}/base/files/${encodeURIComponent(deleted.oldFile.id)}?change=${encodeURIComponent(deleted.id)}&hunk=0`)).json();
  assert.match(source.lines[0].text, /function removed/); assert.equal(source.highlight.start.line, 1);
  assert.equal(source.matchesCurrentFile, false);
  assert.equal((await request(`${endpoint}/base/files/${encodeURIComponent(deleted.oldFile.id)}?evidence=not-in-snapshot`)).status, 400);
  assert.equal((await request(`${endpoint}/unknown/files/${encodeURIComponent(deleted.oldFile.id)}`)).status, 404);
  const relation = report.paths.find((item) => item.seed.name === "removed").steps[0];
  const evidence = await (await request(`${endpoint}/base/files/${encodeURIComponent(relation.from.fileId)}?evidence=${encodeURIComponent(relation.evidenceId)}`)).json();
  assert.ok(evidence.lines.some((line) => line.text.includes("removed()")));
  assert.ok(evidence.highlight);
  assert.equal((await request(`${endpoint}/impact?depth=99`)).status, 400);
  const typed = await (await request(`${endpoint}/impact?includeTypes=true`)).json(); assert.equal(typed.includeTypes, true);
  assert.equal((await request(`${endpoint}/impact?focusSide=current`)).status,400);
  assert.equal((await request(`${endpoint}/impact?focusSide=base&focusNodeId=missing`)).status,400);
  assert.equal((await request(`${endpoint}/symbols?side=unknown`)).status,400);
  const symbols=await (await request(`${endpoint}/symbols?q=removed&side=base&limit=1`)).json();
  assert.ok(symbols.symbols[0]);assert.equal(symbols.symbols[0].side,'base');
  const focused=await (await request(`${endpoint}/impact?focusSide=base&focusNodeId=${encodeURIComponent(symbols.symbols[0].node.id)}`)).json();
  assert.ok(focused.paths.every(p=>p.side==='base'));assert.equal(focused.focus.nodeId,symbols.symbols[0].node.id);
});

test('an in-project cache never leaks temporary HEAD sources into the current graph or makes a fresh comparison stale',async t=>{
 let store,manager;t.after(async()=>{await manager?.close();store?.close()});
 const project=tempProject(t);const fixture=createGitFixture(project.root);fixture.change();
 store=new SnapshotStore(path.join(project.root,'custom-cache'),project.root);manager=new ComparisonManager(project.root,store);
 const bundle=await done(manager,manager.start());
 assert.ok(!bundle.current.snapshot.files.some(file=>file.path.startsWith('custom-cache/')));
 assert.equal(bundle.report.stale,false);assert.equal(await manager.stale(bundle.report.id),false);
 assert.equal(bundle.current.snapshot.files.length,9);
});
