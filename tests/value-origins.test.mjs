import assert from 'node:assert/strict';
import test from 'node:test';
import { tempProject, findSymbol } from './helpers.mjs';
import { ProjectExplorer, compareSnapshots } from '../packages/graph/dist/index.js';
import { summarizeResolution, assertSnapshotIntegrity } from '../packages/shared/dist/index.js';

test('const destructured factory functions retain implementation, lexical owner and all source proofs', t => {
  const project = tempProject(t, {
    'system.ts': `export function system({ notify }: { notify(): void }) {
      return { link, remove: unlink };
      function link() { notify() }
      function unlink() { link() }
    }`,
    'consumer.ts': `import {system} from './system';
      const {link, remove: unlink} = system({notify(){}});
      export function get() { link(); unlink() }`,
  });
  const snapshot = project.analyze();
  assert.equal(snapshot.status, 'complete');
  const get = findSymbol(snapshot, 'consumer.ts', 'get');
  for (const name of ['link', 'unlink']) {
    const target = findSymbol(snapshot, 'system.ts', `system.${name}`);
    const edge = snapshot.relations.find(e => e.kind === 'CALLS' && e.from === get.id && e.to === target.id);
    assert.ok(edge, name); assert.equal(edge.resolution, 'value-origin');
    const proofs = edge.supportingEvidenceIds.map(id => snapshot.evidence.find(e => e.id === id));
    assert.equal(proofs.length, 4);
    assert.ok(proofs.some(p => p.excerpt.includes('return { link, remove: unlink }')));
    const graph = new ProjectExplorer(snapshot).graph({ focus: get.id });
    assert.ok(graph.edges.some(e => e.to === target.id && e.supportingEvidenceIds?.length === 4));
  }
  const notify = snapshot.symbols.find(s => s.qualifiedName === 'system.notify' && s.kind === 'parameter');
  assert.equal(notify.kind, 'parameter');
  assert.ok(snapshot.unresolved.some(e => e.kind === 'CALLS' && e.reason === 'dynamic' && e.candidateIds.includes(notify.id)));
  assert.ok(!snapshot.relations.some(e => e.kind === 'CALLS' && e.to === notify.id));
  assertSnapshotIntegrity(snapshot);
  const corrupt = structuredClone(snapshot); corrupt.relations.find(e => e.supportingEvidenceIds).supportingEvidenceIds.push('missing');
  assert.throws(() => assertSnapshotIntegrity(corrupt), /supporting evidence/);
});

test('writes, defaults, rest, async, overload-only types and alternative returns never invent implementation calls', t => {
  const project = tempProject(t, { 'index.ts': `
    function first(){} function second(){}
    function stable(){ return { run: first } }
    function alternatives(flag: boolean){ if(flag) return { run: first }; return { run: second } }
    async function asynchronous(){ return { run: first } }
    function generator(){ return { ...{run:first} } }
    function mutated(){ function run(){}; run = second; return {run} }
    declare function declared(): {run: typeof first};
    let {run: mutable} = stable(); mutable = second;
    const {run: fallback = second} = stable();
    const {...rest} = stable();
    const {run: alternate} = alternatives(true);
    const {run: asyncRun} = asynchronous() as unknown as {run: typeof first};
    const {run: spread} = generator();
    const {run: replaced} = mutated();
    const {run: typed} = declared();
    const source: {run: typeof first} = {run:second};
    export function use(){ mutable(); fallback(); rest.run(); alternate(); asyncRun(); spread(); replaced(); typed(); source.run() }
  ` });
  const snapshot = project.analyze(), use = findSymbol(snapshot, 'index.ts', 'use');
  const calls = snapshot.relations.filter(e => e.from === use.id && e.kind === 'CALLS');
  assert.equal(calls.length, 1); // Concrete object value wins over the misleading typeof first signature.
  assert.equal(calls[0].to, findSymbol(snapshot, 'index.ts', 'second').id);
  assert.equal(snapshot.unresolved.filter(e => e.from === use.id && e.kind === 'CALLS').length, 8);
});

test('external targets and real gaps have separate complete counts, including legacy snapshots', t => {
  const project = tempProject(t, {'index.ts': `export function run(fn: () => void){ fn(); JSON.stringify(1); missing() }`});
  const snapshot = project.analyze(), node = findSymbol(snapshot, 'index.ts', 'run');
  const expected = summarizeResolution(snapshot.unresolved);
  assert.ok(expected.external > 0); assert.ok(expected.gaps > 0);
  assert.equal(expected.external + expected.gaps, snapshot.statistics.unresolved);
  assert.deepEqual(snapshot.resolutionSummary, expected);
  delete snapshot.resolutionSummary; // Existing on-disk schema 0.1 snapshots remain readable.
  const explorer = new ProjectExplorer(snapshot), detail = explorer.detail(node.id);
  assert.deepEqual(explorer.overview().resolutionSummary, expected);
  assert.ok(detail.externalReferences.every(e => e.reason === 'external'));
  assert.ok(detail.unresolved.every(e => e.reason !== 'external'));
  assert.equal(detail.resolutionSummary.totalUnlinked, detail.unresolved.length + detail.externalReferences.length);
  const report = compareSnapshots({ baseline: {state:'unavailable'}, base:null, current:snapshot, oldSources:[], newSources:[] });
  assert.deepEqual(report.resolutionSummary, {base:null, current:expected});
});

test('imported functions with writes and mutable object members are not traced through factories', t => {
  const project = tempProject(t, {
    'dependency.ts': `export function run(){}; function replacement(){}; run = replacement;`,
    'index.ts': `import {run} from './dependency';
      const object = {run(){}}; object.run = () => {};
      function factory(){ return {imported:run, member:object.run} }
      const {imported,member} = factory();
      export function use(){ imported(); member() }`,
  });
  const snapshot = project.analyze(), use = findSymbol(snapshot, 'index.ts', 'use');
  assert.equal(snapshot.relations.filter(e => e.from === use.id && e.kind === 'CALLS').length, 0);
});

test('inline returned functions and methods resolve to their captured body, never a signature', t => {
  const project = tempProject(t, { 'index.ts': `
    function factory(){ return { arrow: () => 1, method(){return 2} } }
    const {arrow,method} = factory();
    export function use(){arrow();method()}
  ` });
  const snapshot = project.analyze(), use = findSymbol(snapshot, 'index.ts', 'use');
  const calls = snapshot.relations.filter(e => e.from === use.id && e.kind === 'CALLS');
  assert.equal(calls.length, 2);
  assert.ok(calls.every(e => e.resolution === 'value-origin' && e.supportingEvidenceIds.length === 4));
});
