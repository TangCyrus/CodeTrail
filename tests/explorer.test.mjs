import assert from "node:assert/strict";
import test from "node:test";
import { ProjectExplorer } from "../packages/graph/dist/index.js";
import { analyzeFixture } from "../scripts/fixture-tools.mjs";
import { findSymbol } from "./helpers.mjs";

const snapshot = analyzeFixture("reference-lab");
const explorer = new ProjectExplorer(snapshot);

test("directory aggregation accounts for every source file exactly once", () => {
  const overview = explorer.overview();
  assert.equal(overview.files.length, 14);
  assert.equal(overview.modules.reduce((count, node) => count + node.fileCount, 0), 14);
  assert.equal(overview.modules.reduce((count, node) => count + node.symbolCount, 0), snapshot.symbols.length);
  assert.ok(overview.modules.every((module) => explorer.detail(module.id).files.every((file) => file.moduleId === module.id)));
});

test("overview, module, file and symbol navigation have valid breadcrumbs and bounded edges", () => {
  const overview = explorer.graph();
  assert.equal(overview.scope, "overview");
  assert.ok(overview.nodes.every((node) => node.kind === "module"));
  const module = explorer.graph({ focus: "module:src/domain" });
  assert.equal(module.scope, "module");
  assert.ok(module.nodes.every((node) => node.kind === "file"));
  const file = module.nodes[0];
  assert.equal(explorer.graph({ focus: file.id }).scope, "file");
  const normalize = findSymbol(snapshot, "src/domain/math.ts", "normalize");
  const local = explorer.graph({ focus: normalize.id, maxNodes: 2 });
  assert.equal(local.scope, "symbol");
  assert.equal(local.breadcrumbs.length, 4);
  assert.equal(local.nodes.length, 2);
  assert.equal(local.truncated, true);
  assert.ok(local.edges.every((edge) => local.nodes.some((node) => node.id === edge.from) && local.nodes.some((node) => node.id === edge.to)));
});

test("search ranks exact symbols and applies all query terms and limits", () => {
  assert.equal(explorer.search("normalize").results[0].name, "normalize");
  const scoped = explorer.search("shared scope/right");
  assert.equal(scoped.total, 1);
  assert.equal(scoped.results[0].path, "src/scope/right.ts");
  assert.equal(explorer.search(" ").total, 0);
  assert.equal(explorer.search("unfindable-term").total, 0);
  assert.equal(explorer.search("src", 1).truncated, true);
  assert.throws(() => explorer.search("src", 101), /limit/);
});

test("candidate and type filters preserve origins and source evidence in projections", () => {
  const schedule = findSymbol(snapshot, "src/callbacks.ts", "schedule");
  const withCandidates = explorer.graph({ focus: schedule.id });
  assert.ok(withCandidates.edges.some((edge) => edge.origin === "rule"));
  assert.ok(!explorer.graph({ focus: schedule.id, includeCandidates: false }).edges.some((edge) => edge.origin === "rule"));
  const payload = findSymbol(snapshot, "src/domain/math.ts", "Payload");
  assert.ok(!explorer.graph({ focus: payload.id }).edges.some((edge) => edge.usage === "type"));
  assert.ok(explorer.graph({ focus: payload.id, includeTypes: true, includeReferences: true }).edges.some((edge) => edge.usage === "type"));
  for (const edge of explorer.graph().edges) {
    assert.ok(edge.count >= edge.evidenceIds.length);
    for (const id of edge.evidenceIds) assert.ok(snapshot.evidence.some((proof) => proof.id === id));
  }
  assert.throws(() => explorer.graph({ focus: "unknown" }), /Unknown/);
});
