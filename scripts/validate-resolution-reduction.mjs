import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { summarizeResolution } from '../packages/shared/dist/index.js';

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
const externalSites = snapshot => snapshot.unresolved.filter(x => x.reason === 'external').map(site).sort();
const externalSitesUnchanged = JSON.stringify(externalSites(after)) === JSON.stringify(externalSites(before));
if (args.includes('--expect-external-unchanged')) assert.ok(externalSitesUnchanged, 'Ordinary external sites must be retained in this controlled parser-only comparison');
const callSite = item => `${site(item)}:${item.to}`;
const newCalls = new Set(after.relations.filter(x => x.kind === 'CALLS').map(callSite));
const previousCalls = new Set(before.relations.filter(x => x.kind === 'CALLS').map(callSite));
for (const edge of before.relations.filter(x => x.kind === 'CALLS')) assert.ok(newCalls.has(callSite(edge)), `Lost previously resolved call: ${callSite(edge)}`);
assert.ok(promoted.length > 0 || args.includes('--allow-unchanged'));
for (const item of promoted) assert.ok(resolved.has(site(item)), `Removed unresolved site lacks a real static edge: ${site(item)}`);
assert.ok(args.includes('--allow-unchanged') ? after.unresolved.length <= before.unresolved.length : after.unresolved.length < before.unresolved.length);
const files = new Map(after.files.map(x => [x.id, x])), source = new Map();
const captured = option('--sources') ? new Map(JSON.parse(readFileSync(option('--sources'),'utf8')).map(item=>[item.path,item.content])) : null;
for (const file of after.files) {
  if(captured)assert.equal(typeof captured.get(file.path),'string',`Missing preserved source: ${file.path}`);
  const bytes = captured ? Buffer.from(captured.get(file.path) ?? '') : readFileSync(path.join(after.rootDir, file.path));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), file.hash);
  source.set(file.id, bytes.toString('utf8'));
}
for (const proof of after.evidence) {
  assert.equal(proof.fileHash, files.get(proof.fileId).hash);
  assert.equal(source.get(proof.fileId).slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
}
const reasons = snapshot => Object.fromEntries([...new Set(snapshot.unresolved.map(x => x.reason))].sort().map(reason => [reason, snapshot.unresolved.filter(x => x.reason === reason).length]));
const counts = snapshot => ({ files: snapshot.files.length, symbols: snapshot.symbols.length, relations: snapshot.relations.length, unresolved: snapshot.unresolved.length,
  diagnostics: snapshot.diagnostics.length, status: snapshot.status, reasons: reasons(snapshot), resolutionSummary: summarizeResolution(snapshot.unresolved) });
const result = { passed: true, identicalSourceFilesAndHashes: true, before: counts(before), after: counts(after), promotedToStaticEdges: promoted.length,
  unresolvedReduction: before.unresolved.length - after.unresolved.length,
  unresolvedReductionPercent: Math.round((before.unresolved.length - after.unresolved.length) / before.unresolved.length * 10000) / 100,
  newUnresolvedSites: after.unresolved.filter(x => !oldUnresolved.has(site(x))).length,
  promotedByKind: Object.fromEntries(['CALLS', 'REFERENCES', 'IMPORTS', 'RENDERS'].map(kind => [kind, promoted.filter(x => x.kind === kind).length])),
  externalSitesUnchanged, previouslyResolvedCallsRetained: true,
  newStaticCalls: after.relations.filter(edge => edge.kind === 'CALLS' && !previousCalls.has(callSite(edge))).length,
  evidenceChecked: after.evidence.length };
if (option('--out')) { const output = path.resolve(option('--out')); mkdirSync(path.dirname(output), { recursive: true }); writeFileSync(output, JSON.stringify(result, null, 2)); }
console.log(JSON.stringify(result, null, 2));
