import assert from "node:assert/strict";
import test from "node:test";
import { traceDependents } from "../packages/graph/dist/index.js";
import { analyzeFixture } from "../scripts/fixture-tools.mjs";
import { findSymbol } from "./helpers.mjs";

const snapshot = analyzeFixture("reference-lab");

test("reverse traversal returns evidenced dependents, never arbitrary callees", () => {
  const normalize = findSymbol(snapshot, "src/domain/math.ts", "normalize");
  const submit = findSymbol(snapshot, "src/entry.ts", "submit");
  const start = findSymbol(snapshot, "src/entry.ts", "start");
  const left = findSymbol(snapshot, "src/scope/left.ts", "left");
  const result = traceDependents(snapshot, normalize.id);
  assert.ok(result.paths.some((entry) => entry.nodeId === submit.id && entry.distance === 1));
  assert.ok(result.paths.some((entry) => entry.nodeId === start.id && entry.distance === 2));
  assert.ok(!result.paths.some((entry) => entry.nodeId === left.id));
  for (const entry of result.paths) {
    let dependency = normalize.id;
    for (const id of entry.relationIds) {
      const edge = snapshot.relations.find((candidate) => candidate.id === id);
      assert.equal(edge.to, dependency);
      dependency = edge.from;
    }
    assert.equal(dependency, entry.nodeId);
  }
});

test("cycles terminate and depth or node limits report truncation", () => {
  const a = findSymbol(snapshot, "src/cycle/a.ts", "a");
  const b = findSymbol(snapshot, "src/cycle/b.ts", "b");
  const result = traceDependents(snapshot, a.id, { maxDepth: 20 });
  assert.deepEqual(result.paths.map((entry) => entry.nodeId), [b.id]);
  assert.equal(result.truncated, false);
  const normalize = findSymbol(snapshot, "src/domain/math.ts", "normalize");
  assert.equal(traceDependents(snapshot, normalize.id, { maxDepth: 0 }).truncated, true);
  const limited = traceDependents(snapshot, normalize.id, { maxNodes: 1 });
  assert.equal(limited.paths.length, 1);
  assert.equal(limited.truncated, true);
  assert.throws(() => traceDependents(snapshot, "missing"), /Unknown focus/);
});

test("type dependencies are opt-in and callback rule candidates are never traversed", () => {
  const payload = findSymbol(snapshot, "src/domain/math.ts", "Payload");
  const submit = findSymbol(snapshot, "src/entry.ts", "submit");
  assert.ok(!traceDependents(snapshot, payload.id).paths.some((entry) => entry.nodeId === submit.id));
  assert.ok(traceDependents(snapshot, payload.id, { includeTypes: true }).paths.some((entry) => entry.nodeId === submit.id));
  const task = findSymbol(snapshot, "src/callbacks.ts", "task");
  const result = traceDependents(snapshot, task.id, { maxDepth: 1 });
  for (const entry of result.paths) {
    for (const id of entry.relationIds) assert.notEqual(snapshot.relations.find((edge) => edge.id === id).origin, "rule");
  }
});
