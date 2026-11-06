import assert from "node:assert/strict";
import { readFileSync, symlinkSync, existsSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { assertSnapshotIntegrity } from "../packages/shared/dist/index.js";
import { analyzeFixture, evaluateGold, score } from "../scripts/fixture-tools.mjs";
import { findSymbol, tempProject } from "./helpers.mjs";

const reference = analyzeFixture("reference-lab");

test("compiler version is locked and the complete hand-reviewed inventories match", () => {
  assert.equal(reference.analyzer.compilerVersion, "5.9.3");
  assert.equal(reference.status, "complete");
  assert.equal(reference.diagnostics.length, 0);
  const results = evaluateGold(reference);
  for (const [kind, result] of Object.entries(results)) {
    assert.equal(result.falsePositive, 0, `${kind}: unexpected edges ${JSON.stringify(result.unexpected)}`);
    assert.equal(result.falseNegative, 0, `${kind}: missing edges ${JSON.stringify(result.missing)}`);
  }
});

test("metric gate detects both duplicated relations and omissions", () => {
  const expected = { kind: "CALLS", from: "a", to: "b", file: "a.ts", line: 1, excerpt: "b" };
  assert.equal(score([expected], [expected, expected]).falsePositive, 1);
  assert.equal(score([expected], []).falseNegative, 1);
});

test("every evidence excerpt and UTF-16 position agrees with source", () => {
  assertSnapshotIntegrity(reference);
  const files = new Map(reference.files.map((file) => [file.id, file]));
  for (const proof of reference.evidence) {
    const text = readFileSync(path.join(reference.rootDir, files.get(proof.fileId).path), "utf8");
    assert.equal(text.slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
    for (const [position, offset] of [[proof.range.start, proof.range.startOffset], [proof.range.end, proof.range.endOffset]]) {
      const before = text.slice(0, offset).split(/\r\n|\n|\r/);
      assert.equal(position.line, before.length);
      assert.equal(position.column, before.at(-1).length + 1);
    }
  }
  const corrupt = structuredClone(reference);
  corrupt.relations[0].to = "missing-node";
  assert.throws(() => assertSnapshotIntegrity(corrupt), /Dangling relation/);
});

test("shadowed functions resolve by symbol identity rather than name", () => {
  const left = findSymbol(reference, "src/scope/left.ts", "left");
  const leftShared = findSymbol(reference, "src/scope/left.ts", "shared");
  const rightShared = findSymbol(reference, "src/scope/right.ts", "shared");
  const nested = findSymbol(reference, "src/scope/left.ts", "nested");
  const nestedShared = findSymbol(reference, "src/scope/left.ts", "nested.shared");
  const calls = reference.relations.filter((entry) => entry.kind === "CALLS");
  assert.ok(calls.some((edge) => edge.from === left.id && edge.to === leftShared.id));
  assert.ok(!calls.some((edge) => edge.from === left.id && edge.to === rightShared.id));
  assert.ok(calls.some((edge) => edge.from === nested.id && edge.to === nestedShared.id));
});

test("callback registration is a candidate and its body has a separate lexical owner", () => {
  const schedule = findSymbol(reference, "src/callbacks.ts", "schedule");
  const task = findSymbol(reference, "src/callbacks.ts", "task");
  assert.ok(!reference.relations.some((edge) => edge.kind === "CALLS" && edge.from === schedule.id && edge.to === task.id));
  assert.ok(reference.relations.some((edge) => edge.kind === "REGISTERS_CALLBACK" && edge.from === schedule.id && edge.to === task.id && edge.origin === "rule"));
  assert.ok(reference.unresolved.some((entry) => entry.kind === "CALLS" && entry.reason === "dynamic"));
});

test("a syntax error and missing dependency preserve healthy relations and excluded-source boundaries", () => {
  const degraded = analyzeFixture("degraded-lab");
  assert.equal(degraded.status, "partial");
  assert.equal(degraded.statistics.parseErrors, 1);
  const caller = findSymbol(degraded, "src/healthy.ts", "caller");
  const healthy = findSymbol(degraded, "src/healthy.ts", "healthy");
  assert.ok(degraded.relations.some((edge) => edge.kind === "CALLS" && edge.from === caller.id && edge.to === healthy.id));
  assert.ok(degraded.unresolved.some((entry) => entry.kind === "IMPORTS" && entry.reason === "unresolved"));
  assert.ok(degraded.unresolved.some((entry) => entry.kind === "IMPORTS" && entry.reason === "excluded"));
  assert.ok(!degraded.files.some((file) => file.path === "src/hidden.ts"));
  assert.ok(!degraded.symbols.some((symbol) => symbol.name === "hidden"));
});

test("Chinese paths, spaces, CRLF and surrogate pairs keep precise evidence", (t) => {
  const project = tempProject(t, {
    "中文 目录/模块.ts": "// 表情 😀\r\nexport function 处理(值: number) { return 值; }\r\nexport function 开始() { const 消息 = '😀'; return 处理(消息.length); }\r\n",
  });
  const snapshot = project.analyze();
  assert.equal(snapshot.status, "complete");
  const call = snapshot.relations.find((edge) => edge.kind === "CALLS");
  const proof = snapshot.evidence.find((entry) => entry.id === call.evidenceId);
  const text = readFileSync(path.join(project.root, "中文 目录/模块.ts"), "utf8");
  assert.equal(proof.range.start.line, 3);
  assert.equal(text.slice(proof.range.startOffset, proof.range.endOffset), "处理");
  const lineStart = text.lastIndexOf("\n", proof.range.startOffset) + 1;
  assert.equal(proof.range.start.column, proof.range.startOffset - lineStart + 1);
});

test("nested gitignore negation works while default dependency exclusions cannot be overridden", (t) => {
  const project = tempProject(t, {
    ".gitignore": "*.ts\n!node_modules/\n",
    "nested/.gitignore": "!keep.ts\n",
    "nested/keep.ts": "export const kept = 1;",
    "nested/drop.ts": "export const dropped = 2;",
    "node_modules/poison.ts": "throw new Error('must never be read');",
    ".codegraphignore": "blocked/\n",
    "blocked/secret.js": "export const blocked = 1;",
  });
  const snapshot = project.analyze();
  assert.deepEqual(snapshot.files.map((file) => file.path), ["nested/keep.ts"]);
  assert.ok(snapshot.skipped.some((item) => item.path === "node_modules" && item.reason === "ignored"));
});

test("file and byte limits produce explicit partial results", (t) => {
  const project = tempProject(t, {
    "a.ts": "export const a = 1;", "b.ts": "export const b = 2;", "large.ts": "//" + "x".repeat(500),
  });
  const byBytes = project.analyze({ maxFileBytes: 100 });
  assert.equal(byBytes.status, "partial");
  assert.ok(byBytes.skipped.some((item) => item.reason === "size-limit"));
  const byCount = project.analyze({ maxFiles: 1 });
  assert.equal(byCount.files.length, 1);
  assert.equal(byCount.status, "partial");
  assert.ok(byCount.skipped.some((item) => item.reason === "file-limit"));
  assert.throws(() => project.analyze({ maxFiles: 0 }), /positive integers/);
});

test("source and untrusted executable configuration are never executed", (t) => {
  const project = tempProject(t);
  const marker = path.join(project.root, "EXECUTED");
  const trap = `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); export const trap = 1;`;
  project.write("source.js", trap);
  project.write("vite.config.js", trap);
  const snapshot = project.analyze();
  assert.ok(snapshot.files.some((file) => file.path === "source.js"));
  assert.equal(existsSync(marker), false);
});

test("imports and tsconfig extends cannot read a directory junction outside the selected project", (t) => {
  const outside = tempProject(t, { "outside.ts": "export function outsideFunction() { return 'private'; }", "config.json": "{\"compilerOptions\":{\"strict\":false}}" });
  const inside = tempProject(t, {
    "index.ts": "import { outsideFunction } from './linked/outside'; export function run() { return outsideFunction(); }",
    "tsconfig.json": '{"extends":"./linked/config.json"}',
  });
  try { symlinkSync(outside.root, path.join(inside.root, "linked"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") { t.skip("OS does not permit test symlinks"); return; }
    throw error;
  }
  const snapshot = inside.analyze();
  assert.ok(snapshot.skipped.some((entry) => entry.path === "linked" && entry.reason === "symlink"));
  assert.ok(!snapshot.symbols.some((symbol) => symbol.name === "outsideFunction"));
  assert.ok(!snapshot.evidence.some((entry) => entry.excerpt.includes("private")));
  assert.ok(snapshot.diagnostics.some((entry) => entry.severity === "error"));
});

test("third-party type declarations inform resolution without indexing or executing dependency code", (t) => {
  const project = tempProject(t, {
    "node_modules/demo/package.json": '{"name":"demo","types":"index.d.ts"}',
    "node_modules/demo/index.d.ts": "export declare function external(): number;",
    "node_modules/demo/index.js": "throw new Error('do not execute dependency');",
    "index.ts": "import { external } from 'demo'; export function run() { return external(); }",
  });
  const snapshot = project.analyze();
  assert.equal(snapshot.status, "complete");
  assert.deepEqual(snapshot.files.map((entry) => entry.path), ["index.ts"]);
  assert.ok(snapshot.unresolved.some((entry) => entry.kind === "CALLS" && entry.reason === "external"));
  assert.ok(!snapshot.symbols.some((entry) => entry.name === "external"));
});

test("dependency declarations linked within the selected root remain readable and invalidate the snapshot when changed", (t) => {
  const project = tempProject(t, {
    "packages/demo/package.json": '{"name":"demo","types":"index.d.ts"}',
    "packages/demo/index.d.ts": "export declare function external(): number;",
    "node_modules/.keep": "",
    ".codegraphignore": "packages/\n",
    "index.ts": "import { external } from 'demo'; export function run() { return external(); }",
  });
  try { symlinkSync(path.join(project.root, "packages/demo"), path.join(project.root, "node_modules/demo"), process.platform === "win32" ? "junction" : "dir"); }
  catch (error) {
    if (error.code === "EPERM" || error.code === "EACCES") { t.skip("OS does not permit test symlinks"); return; }
    throw error;
  }
  const before = project.analyze();
  assert.equal(before.status, "complete", JSON.stringify({ diagnostics: before.diagnostics, stale: before.stale }));
  assert.ok(before.unresolved.some((entry) => entry.kind === "CALLS" && entry.reason === "external"));
  assert.deepEqual(before.files.map((entry) => entry.path), ["index.ts"]);
  project.write("packages/demo/index.d.ts", "export declare function external(): string;");
  assert.notEqual(before.id, project.analyze().id);
});

test("snapshot identity is deterministic and invalidates when source or config changes", (t) => {
  const project = tempProject(t, { "index.ts": "export function run() { return 1; }" });
  const first = project.analyze();
  const repeated = project.analyze();
  assert.equal(first.id, repeated.id);
  assert.deepEqual(first.symbols, repeated.symbols);
  project.write("index.ts", "export function run() { return 2; }");
  const changed = project.analyze();
  assert.notEqual(first.id, changed.id);
  assert.notEqual(first.evidence[0].fileHash, changed.evidence[0].fileHash);
  project.write("tsconfig.json", '{"compilerOptions":{"strict":false}}');
  assert.notEqual(changed.id, project.analyze().id);
});

test("overloads resolve to one implementation and an immediately invoked expression has its own symbol", (t) => {
  const overloaded = reference.symbols.filter((entry) => entry.name === "overloaded");
  assert.equal(overloaded.length, 1);
  assert.equal(overloaded[0].range.start.line, 13);
  const project = tempProject(t, { "index.ts": "function target() { return 1; }\nexport const result = (() => target())();" });
  const snapshot = project.analyze();
  assert.equal(snapshot.relations.filter((edge) => edge.kind === "CALLS").length, 2);
});

test("malformed tsconfig produces diagnostics and empty projects remain valid snapshots", (t) => {
  const project = tempProject(t, { "tsconfig.json": "{ invalid json", "index.ts": "export const value = 1;" });
  const snapshot = project.analyze();
  assert.equal(snapshot.status, "partial");
  assert.equal(snapshot.files.length, 1);
  const empty = tempProject(t).analyze();
  assert.equal(empty.files.length, 0);
  assertSnapshotIntegrity(empty);
});

test("ambiguous methods keep candidate targets without inventing a direct call", (t) => {
  const project = tempProject(t, { "index.ts": `
class A { run() { return 1; } }
class B { run() { return 2; } }
export function invoke(target: A | B) { return target.run(); }
` });
  const snapshot = project.analyze();
  assert.equal(snapshot.status, "complete");
  const call = snapshot.unresolved.find((entry) => entry.kind === "CALLS");
  assert.equal(call.reason, "ambiguous");
  assert.equal(call.candidateIds.length, 2);
  assert.equal(snapshot.relations.filter((edge) => edge.kind === "CALLS").length, 0);
});

test("class extends is a value dependency while implements and type queries remain type dependencies", (t) => {
  const project = tempProject(t, { "index.ts": `
class Base {}
interface Shape {}
export class Derived extends Base implements Shape {}
function fn() { return 1; }
export type FunctionType = typeof fn;
export { fn };
` });
  const snapshot = project.analyze();
  const derived = findSymbol(snapshot, "index.ts", "Derived");
  const base = findSymbol(snapshot, "index.ts", "Base");
  const shape = findSymbol(snapshot, "index.ts", "Shape");
  const fn = findSymbol(snapshot, "index.ts", "fn");
  const functionType = findSymbol(snapshot, "index.ts", "FunctionType");
  const references = snapshot.relations.filter((edge) => edge.kind === "REFERENCES");
  assert.ok(references.some((edge) => edge.from === derived.id && edge.to === base.id && edge.usage === "value"));
  assert.ok(references.some((edge) => edge.from === derived.id && edge.to === shape.id && edge.usage === "type"));
  assert.ok(references.some((edge) => edge.from === functionType.id && edge.to === fn.id && edge.usage === "type"));
  assert.equal(fn.exported, true);
});

test("class arrow fields keep their declared owner and object-shaped parameters retain semantic signatures", (t) => {
  const project = tempProject(t, { "index.ts": `
function target(value: number) { return value; }
export class Service {
  handle = (payload: { value: number }): number => target(payload.value);
}
const service = new Service();
export function run() { return service.handle({ value: 1 }); }
` });
  const snapshot = project.analyze();
  const handle = findSymbol(snapshot, "index.ts", "Service.handle");
  const target = findSymbol(snapshot, "index.ts", "target");
  const run = findSymbol(snapshot, "index.ts", "run");
  assert.match(handle.signature, /value: number/);
  assert.match(handle.signature, /\): number$/);
  assert.ok(snapshot.relations.some((edge) => edge.kind === "CALLS" && edge.from === handle.id && edge.to === target.id));
  assert.ok(snapshot.relations.some((edge) => edge.kind === "CALLS" && edge.from === run.id && edge.to === handle.id));
  assert.equal(snapshot.symbols.filter((entry) => entry.name.startsWith("<anonymous")).length, 0);
});
