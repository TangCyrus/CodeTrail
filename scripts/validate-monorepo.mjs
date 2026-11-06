import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeProject, isSnapshotStale } from '../packages/analyzer/dist/index.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const value = (name) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
const project = path.resolve(value('--project') ?? root), baseline = value('--baseline');
const output = path.resolve(value('--out') ?? path.join(root, 'artifacts/monorepo/self.json'));
let sources;
const after = analyzeProject({ rootDir: project }, { onSources: (captured) => { sources = captured; } });
assert.equal(after.stale, false); assert.equal(isSnapshotStale(after), false);
assert.equal(after.status, 'complete', JSON.stringify(after.diagnostics));
const files = new Map(after.files.map((file) => [file.id, file])), symbols = new Map(after.symbols.map((symbol) => [symbol.id, symbol]));
const proofs = new Map(after.evidence.map((item) => [item.id, item]));
for (const proof of after.evidence) {
  const file = files.get(proof.fileId), source = sources.find((item) => item.path === file.path);
  assert.equal(source.content.slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
  assert.equal(source.hash, proof.fileHash);
}
const checks = [
  ['apps/local/src/analysis-worker.ts', 'packages/analyzer/src/index.ts', 'analyzeProject'],
  ['apps/local/src/comparison-worker.ts', 'packages/graph/src/comparison.ts', 'compareSnapshots'],
  ['apps/local/src/explanation-context.ts', 'packages/graph/src/reading.ts', 'recommendReading'],
];
const crossPackageEvidence = checks.map(([from, to, name]) => {
  const edge = after.relations.find((item) => item.kind === 'CALLS' && files.get(symbols.get(item.from)?.fileId ?? item.from)?.path === from
    && files.get(symbols.get(item.to)?.fileId ?? item.to)?.path === to && symbols.get(item.to)?.qualifiedName === name);
  assert.ok(edge, `Missing verified cross-package call: ${from} -> ${to}#${name}`);
  const proof = proofs.get(edge.evidenceId);
  return { from, to, symbol: name, evidenceId: proof.id, fileHash: proof.fileHash, range: proof.range, excerpt: proof.excerpt };
});
const counts = (snapshot) => ({ ...snapshot.statistics, diagnostics: snapshot.diagnostics.length, status: snapshot.status,
  unresolvedReasons: Object.fromEntries([...new Set(snapshot.unresolved.map((item) => item.reason))].sort().map((reason) => [reason, snapshot.unresolved.filter((item) => item.reason === reason).length])) });
let comparison;
if (baseline) {
  const before = JSON.parse(readFileSync(baseline, 'utf8'));
  const corpus = (snapshot) => snapshot.files.map(({ path, hash }) => [path, hash]).sort(([a], [b]) => a.localeCompare(b, 'en'));
  assert.deepEqual(corpus(before), corpus(after), 'Before/after source corpus must be identical');
  const unresolved = new Set(after.unresolved.map((item) => `${item.kind}:${item.from}:${item.evidenceId}`));
  const resolved = new Set(after.relations.map((item) => `${item.kind}:${item.from}:${item.evidenceId}`));
  const promoted = before.unresolved.filter((item) => !unresolved.has(`${item.kind}:${item.from}:${item.evidenceId}`));
  assert.ok(promoted.length > 0);
  assert.ok(promoted.every((item) => resolved.has(`${item.kind}:${item.from}:${item.evidenceId}`)), 'Every removed unresolved site needs an actual source-backed relation');
  assert.ok(after.statistics.unresolved < before.statistics.unresolved);
  comparison = { identicalSourceCorpus: true, before: counts(before), unresolvedSitesResolvedWithEvidence: promoted.length,
    unresolvedReduction: before.statistics.unresolved - after.statistics.unresolved,
    unresolvedReductionPercent: Math.round((before.statistics.unresolved - after.statistics.unresolved) / before.statistics.unresolved * 10000) / 100 };
}
const result = { passed: true, project, snapshotId: after.id, after: counts(after), crossPackageEvidence, ...(comparison ? { comparison } : {}) };
mkdirSync(path.dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2));
writeFileSync(output.replace(/\.json$/, '') + '-snapshot.json', JSON.stringify(after));
console.log(JSON.stringify(result, null, 2));
