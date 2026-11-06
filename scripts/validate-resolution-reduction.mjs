import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2), option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
assert.ok(option('--before') && option('--after'), 'Supply --before and --after full snapshots of the identical source corpus');
const before = JSON.parse(readFileSync(option('--before'), 'utf8')), after = JSON.parse(readFileSync(option('--after'), 'utf8'));
const corpus = snapshot => snapshot.files.map(x => [x.path, x.hash]).sort(([a], [b]) => a.localeCompare(b, 'en'));
assert.deepEqual(corpus(before), corpus(after), 'Files and their hashes must remain identical');
const site = item => `${item.kind}:${item.from}:${item.evidenceId}`;
const unresolved = new Set(after.unresolved.map(site));
const oldUnresolved = new Set(before.unresolved.map(site));
const resolved = new Set(after.relations.filter(x => x.origin === 'static').map(site));
const promoted = before.unresolved.filter(x => !unresolved.has(site(x)));
assert.ok(promoted.length > 0);
for (const item of promoted) assert.ok(resolved.has(site(item)), `Removed unresolved site lacks a real static edge: ${site(item)}`);
assert.ok(after.unresolved.length < before.unresolved.length);
const files = new Map(after.files.map(x => [x.id, x])), source = new Map();
for (const file of after.files) {
  const bytes = readFileSync(path.join(after.rootDir, file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.hash);
  source.set(file.id, bytes.toString('utf8'));
}
for (const proof of after.evidence) {
  assert.equal(proof.fileHash, files.get(proof.fileId).hash);
  assert.equal(source.get(proof.fileId).slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
}
const reasons = snapshot => Object.fromEntries([...new Set(snapshot.unresolved.map(x => x.reason))].sort().map(reason => [reason, snapshot.unresolved.filter(x => x.reason === reason).length]));
const counts = snapshot => ({ files: snapshot.files.length, symbols: snapshot.symbols.length, relations: snapshot.relations.length, unresolved: snapshot.unresolved.length,
  diagnostics: snapshot.diagnostics.length, status: snapshot.status, reasons: reasons(snapshot) });
const result = { passed: true, identicalSourceFilesAndHashes: true, before: counts(before), after: counts(after), promotedToStaticEdges: promoted.length,
  unresolvedReduction: before.unresolved.length - after.unresolved.length,
  unresolvedReductionPercent: Math.round((before.unresolved.length - after.unresolved.length) / before.unresolved.length * 10000) / 100,
  newUnresolvedSites: after.unresolved.filter(x => !oldUnresolved.has(site(x))).length,
  evidenceChecked: after.evidence.length };
if (option('--out')) { const output = path.resolve(option('--out')); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
