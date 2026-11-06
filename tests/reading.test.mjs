import assert from "node:assert/strict";
import test from "node:test";
import { ProjectExplorer, recommendReading } from "../packages/graph/dist/index.js";
import { analyzeFixture } from "../scripts/fixture-tools.mjs";
import { tempProject, findSymbol } from "./helpers.mjs";
import { SnapshotStore } from "../apps/local/dist/store.js";
import { analyzeProject } from "../packages/analyzer/dist/index.js";
import { buildExplanationPreview, aiContextPayload, MAX_CONTEXT_CHARACTERS } from "../apps/local/dist/explanation-context.js";

const snapshot = analyzeFixture("reference-lab");
const model = new ProjectExplorer(snapshot);
const guide = recommendReading(snapshot, model);

test("recommendations balance categories and attach real, snapshot-bound reasons", () => {
  const all = guide.groups.flatMap((group) => group.items);
  assert.ok(all.length > 0 && all.length <= 10);
  assert.equal(new Set(all.map((item) => item.node.id)).size, all.length);
  assert.ok(guide.groups.find((group) => group.id === "shared").items.length <= 3);
  assert.ok(guide.groups.find((group) => group.id === "entry").items.some((item) => item.node.name === "start"));
  for (const item of all) for (const reason of item.reasons) {
    assert.ok(reason.evidenceIds.length > 0);
    assert.ok(reason.evidenceIds.every((id) => snapshot.evidence.some((proof) => proof.id === id)));
    assert.ok(["static", "rule"].includes(reason.origin));
  }
  const normalize = all.find((item) => item.node.name === "normalize");
  assert.equal(normalize.metrics.referencingFiles, 2);
  assert.equal(normalize.metrics.connectedModules, 1);
  const duplicated = structuredClone(snapshot);
  duplicated.relations.push(...snapshot.relations.filter((edge) => edge.kind === "REFERENCES"));
  assert.equal(recommendReading(duplicated).groups.flatMap((group) => group.items).find((item) => item.node.name === "normalize").metrics.referencingFiles, 2);
});

test("reading order starts with a candidate and every follow step has a real preceding static edge", () => {
  assert.equal(guide.readingOrder[0].node.name, "start");
  assert.equal(guide.readingOrder[1].node.name, "submit");
  const previous = new Set();
  for (const step of guide.readingOrder) {
    assert.ok(!previous.has(step.node.id));
    if (step.kind === "follow") {
      assert.ok(previous.has(step.fromNodeId));
      const edge = snapshot.relations.find((edge) => edge.id === step.viaRelationId);
      assert.equal(edge.to, step.node.id);
      assert.ok(["CALLS", "RENDERS"].includes(edge.kind));
      assert.equal(edge.origin, "static");
      assert.deepEqual(step.evidenceIds, [edge.evidenceId]);
    }
    previous.add(step.node.id);
  }
});

test("tests and generated source do not dominate recommendations and call cycles terminate", (t) => {
  const project = tempProject(t, {
    "main.ts": "export function main() { return a(); }\nfunction a(): number { return b(); }\nfunction b(): number { return a(); }",
    "main.test.ts": "export function prominentTest() { return 1; }",
    "generated/client.ts": "export function generatedClient() { return 1; }",
  });
  const result = recommendReading(project.analyze());
  assert.equal(result.excludedFiles, 2);
  assert.ok(result.groups.flatMap((group) => group.items).every((item) => !/test|generated/.test(item.node.path)));
  assert.equal(new Set(result.readingOrder.map((step) => step.node.id)).size, result.readingOrder.length);
  assert.ok(result.readingOrder.length <= 10);
});

test("anonymous error callbacks in a main file are not promoted to architectural entry points", (t) => {
  const project = tempProject(t, {
    'examples/angular/main.ts': "import { bootstrap } from '../../core'; bootstrap().catch((error) => console.error(error));",
    'core.ts': 'export function bootstrap(): Promise<void> { return Promise.resolve(); }',
  });
  const result = recommendReading(project.analyze());
  assert.equal(result.groups.find(x => x.id === 'entry').items.length, 0);
  assert.equal(result.readingOrder[0].node.name, 'bootstrap');
  assert.ok(result.readingOrder.every(x => x.kind !== 'entry' || !x.node.name.startsWith('<anonymous@')));
});

test("bookmarks retain explicit read state across snapshots and never resolve a moved node by guessing", (t) => {
  let store;
  t.after(() => store?.close());
  const cache = tempProject(t);
  const project = tempProject(t, { "entry.ts": "export function main() { return 1; }" });
  store = new SnapshotStore(cache.root, project.root);
  const first = project.analyze();
  const node = new ProjectExplorer(first).search("main").results[0];
  const key = store.bookmark(node);
  store.bookmark(node);
  assert.equal(store.readingList(new ProjectExplorer(first)).total, 1);
  assert.equal(store.updateBookmark(key, true), true);
  project.write("entry.ts", "export const before = 0;\n\nexport function main() { return 2; }");
  const updated = store.readingList(new ProjectExplorer(project.analyze()));
  assert.equal(updated.readCount, 1);
  assert.notEqual(updated.items[0].node.id, node.id);
  project.write("entry.ts", "export function renamed() { return 2; }");
  assert.equal(store.readingList(new ProjectExplorer(project.analyze())).items[0].node, null);
  store.close();
  store = new SnapshotStore(cache.root, project.root);
  assert.equal(store.readingList(new ProjectExplorer(first)).readCount, 1);
});

test("explanation preview has a bounded, verifiable payload and retains actual source positions", (t) => {
  let store;
  t.after(() => store?.close());
  const cache = tempProject(t);
  store = new SnapshotStore(cache.root, snapshot.rootDir);
  let sources;
  const captured = analyzeProject({ rootDir: snapshot.rootDir }, { onSources: (value) => { sources = value; } });
  store.save(captured, sources);
  const explorer = new ProjectExplorer(captured);
  const normalize = findSymbol(captured, "src/domain/math.ts", "normalize");
  const preview = buildExplanationPreview(explorer, store, normalize.id, "explain", "guided", false);
  assert.ok(preview.evidence.length > 0);
  assert.equal(preview.characters, JSON.stringify(aiContextPayload(preview)).length);
  assert.ok(preview.characters <= MAX_CONTEXT_CHARACTERS);
  assert.ok(!JSON.stringify(aiContextPayload(preview)).includes(snapshot.rootDir));
  for (const proof of preview.evidence) {
    const source = sources.find((source) => source.path === proof.filePath);
    assert.equal(source.content.slice(proof.shownRange.startOffset, proof.shownRange.endOffset), proof.excerpt);
    assert.equal(proof.fileHash, source.hash);
  }
  for (const fact of preview.facts) assert.ok(fact.evidenceIds.every((id) => preview.evidence.some((proof) => proof.id === id)));
  assert.notEqual(preview.previewId, buildExplanationPreview(explorer, store, normalize.id, "explain", "compact", false).previewId);
});
