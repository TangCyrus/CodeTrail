import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { root } from './acceptance-projects.mjs';
import { SnapshotStore } from '../apps/local/dist/store.js';

const revision = '53f30be1e43c8d7899ace08023705b34f5e533f8';
const args = process.argv.slice(2), option = (name) => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const project = realpathSync(path.resolve(option('--project') ?? path.join(root, 'artifacts/external-monorepo/tanstack-store')));
const parent = path.join(root, 'artifacts/external-monorepo'); mkdirSync(parent, { recursive: true });
const run = mkdtempSync(path.join(parent, 'acceptance-'));
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = (parameters) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', project, ...parameters], { env, windowsHide: true, encoding: 'utf8', timeout: 15000 });
assert.equal(git(['rev-parse', 'HEAD']).trim(), revision, 'Use the pinned TanStack Store revision');
assert.ok(!/^(?:filter\.|include(?:if\..*)?\.)/im.test(git(['config', '--local', '--no-includes', '--list'])), 'Use a disposable clone without executable filters or included Git configuration');
assert.equal(git(['status', '--porcelain=v1', '-z']), '', 'Acceptance requires a clean, disposable checkout');
const core = args.includes('--core'), dispatch = args.includes('--dispatch'), receivers = args.includes('--receivers');
const targetName = receivers ? 'effectScopeOper' : dispatch ? 'createStoreContext.useStoreContext' : core ? 'createReactiveSystem.link' : 'shallow';
const targetPath = receivers ? 'packages/store/src/signal.ts' : dispatch ? 'packages/preact-store/src/createStoreContext.tsx' : core ? 'packages/store/src/alien.ts' : 'packages/store/src/shallow.ts', targetFile = path.join(project, targetPath), original = readFileSync(targetFile);
const workspaceFile = path.join(project, 'pnpm-workspace.yaml'), workspace = readFileSync(workspaceFile);
const sha = (value) => createHash('sha256').update(value).digest('hex');
const client = new Client({ name: 'codetrail-external-monorepo-acceptance', version: '0.10.0' });
const calls = [], proofs = [];
let overview, comparison, reading, snapshot, result, retainedGap, nestedCanary, sideStatistics;
async function call(name, parameters) {
  const started = performance.now();
  const response = await client.callTool({ name, arguments: parameters }, { timeout: 90000 });
  calls.push({ name, parameters, elapsedMs: Math.round(performance.now() - started), response });
  writeFileSync(path.join(run, 'tool-calls.json'), JSON.stringify(calls, null, 2));
  assert.notEqual(response.isError, true, JSON.stringify(response));
  assert.ok(response.content[0].text.length <= 48000);
  assert.equal(response.structuredContent.sourceTrust, 'untrusted-repository-data');
  return response.structuredContent;
}
try {
  await client.connect(new StdioClientTransport({ command: process.execPath,
    args: [path.join(root, 'apps/local/dist/cli.js'), 'mcp', project, '--data-dir', path.join(run, 'cache')], stderr: 'pipe' }));
  overview = await call('project_overview', { refresh: true });
  assert.equal(overview.project.rootDir, project); assert.equal(overview.stale, false);
  assert.equal(overview.statistics.files, 213); assert.equal(overview.statistics.parseErrors, 0);
  assert.equal(overview.totals.diagnostics > 0, true, 'Missing third-party dependencies must remain visible');
  assert.equal(overview.resolutionSummary.gaps + overview.resolutionSummary.external, overview.statistics.unresolved);
  const pin = { snapshotId: overview.snapshotId };
  for (const [query, file] of [[targetName, targetPath], ['createAtom', 'packages/store/src/atom.ts'], ['useCreateAtom', 'packages/react-store/src/useCreateAtom.ts']]) {
    const search = await call('search_symbols', { ...pin, query, limit: 20 });
    const symbol = search.results.find(x => x.name === query && x.path === file); assert.ok(symbol, `${file}#${query}`);
    const context = await call('symbol_context', { ...pin, nodeId: symbol.id, maxNodes: 12 });
    assert.equal(context.stale, false);
    const source = await call('read_evidence', { ...pin, nodeId: symbol.id, maxLines: 12 });
    assert.equal(source.matchesCurrentFile, true); assert.equal(source.fileHash, sha(readFileSync(path.join(project, file))));
  }
  reading = await call('recommend_reading', pin); assert.ok(reading.readingOrder.length > 0);
  if (dispatch || receivers) {
    const found = await call('search_symbols', {...pin, query:'createAtom.atom.subscribe.e', limit:20});
    const owner = found.results.find(item=>item.path==='packages/store/src/atom.ts' && item.kind==='function'); assert.ok(owner);
    const context = await call('symbol_context', {...pin,nodeId:owner.id,maxNodes:6});
    const gap = context.unresolvedDetails.find(item=>item.reasonDetail?.code==='member-written'); assert.ok(gap,'The conditionally replaced atom.get must remain a gap');
    const proof = await call('read_evidence', {...pin,evidenceId:gap.reasonDetail.evidenceIds[0],maxLines:8});
    assert.equal(proof.snapshotId,overview.snapshotId);assert.equal(proof.matchesCurrentFile,true);
    assert.equal(proof.fileHash,sha(readFileSync(path.join(project,proof.filePath))));
    assert.ok(proof.lines.some(line=>line.text.includes('atom.get = function')));
    retainedGap={snapshotId:proof.snapshotId,reasonDetail:gap.reasonDetail,filePath:proof.filePath,fileHash:proof.fileHash};
  }
  assert.ok(reading.groups.filter(x => x.id === 'entry').flatMap(x => x.items).every(x => !x.node.name.startsWith('<anonymous@')));
  assert.ok(!reading.readingOrder[0].node.name.startsWith('<anonymous@'), 'Error handlers are not architecture entry points');
  // Workspace metadata changes must invalidate the pinned graph independently of source edits.
  try {
    writeFileSync(workspaceFile, Buffer.concat([workspace, Buffer.from('\n# CodeTrail metadata freshness probe\n')]));
    assert.equal((await call('project_overview', {})).stale, true);
  } finally { writeFileSync(workspaceFile, workspace); }
  assert.equal((await call('project_overview', {})).stale, false);
  const beforeText = receivers ? 'this.depsTail = undefined\n  this.flags = NONE' : dispatch ? 'return value' : core ? 'const prevDep = sub.depsTail' : 'if (Object.is(objA, objB)) {';
  const afterText = receivers ? `const cleanup = { state: { node: this, reset(): void { this.clearFlags() }, clearFlags(): void { this.node.depsTail = undefined; this.node.flags = NONE } } }
  const stateAlias = cleanup.state
  stateAlias.reset()` : dispatch ? 'return (value)' : core ? 'const prevDep = (sub.depsTail)' : 'if (objA === objB) {';
  assert.ok(original.toString('utf8').includes(beforeText));
  writeFileSync(targetFile, original.toString('utf8').replace(beforeText, afterText));
  comparison = await call('compare_worktree', { refresh: true, limit: 2 });
  assert.equal(comparison.baseline.state, 'ready'); assert.equal(comparison.baseline.head, revision);
  assert.equal(comparison.stale, false); assert.equal(comparison.totals.changes, 1); assert.ok(comparison.totals.paths > 0);
  const change = comparison.changes[0]; assert.equal(change.newFile.path, targetPath);
  assert.equal(change.kind, 'modified');
  const routes = [...comparison.paths];
  let offset = comparison.nextPathOffset;
  while (offset !== null) {
    const page = await call('compare_worktree', { comparisonId: comparison.comparisonId, pathOffset: offset, limit: 5 });
    assert.deepEqual(page.snapshotIds, comparison.snapshotIds); assert.equal(page.stale, false);
    routes.push(...page.paths); offset = page.nextPathOffset;
  }
  assert.equal(new Set(routes.map(x => x.id)).size, comparison.totals.paths);
  const focusedRoutes = [];
  if(receivers)for(const side of ['base','current']){
    const found=await call('compare_worktree',{comparisonId:comparison.comparisonId,symbolQuery:targetName,symbolSide:side,limit:5});
    const symbol=found.symbols.find(item=>item.node.name===targetName && item.node.path===targetPath);assert.ok(symbol);
    const focused=await call('compare_worktree',{comparisonId:comparison.comparisonId,focus:{side,nodeId:symbol.node.id},limit:10});
    assert.deepEqual(focused.snapshotIds,comparison.snapshotIds);assert.equal(focused.stale,false);
    assert.ok(focused.paths.every(item=>item.side===side&&item.seed.id===symbol.node.id));
    focusedRoutes.push(...focused.paths);
  }
  for (const side of ['base', 'current']) {
    const route = (receivers?focusedRoutes:routes).find(x => x.side === side && x.seed.name === targetName
      && (receivers ? x.distance === 1 && x.target.path === targetPath && x.target.name === 'effectOper' : dispatch ? x.distance === 1 && /^packages\/preact-store\/tests\//.test(x.target.path) : core ? /^packages\/store\/src\/(atom|signal)\.ts$/.test(x.target.path) : /^packages\/(react|preact)-store\/tests\//.test(x.target.path)) && x.steps.some(step => step.kind === 'CALLS'));
    assert.ok(route, `Missing source-backed cross-package ${side} test caller`);
    for (const step of route.steps) {
      if ((core || dispatch || receivers) && step.kind === 'CALLS') assert.ok(step.supportingEvidenceIds?.length, 'Core recovered call must retain value-origin proofs');
      for (const evidenceId of step.supportingEvidenceIds ?? []) {
        const support = await call('read_evidence', {comparisonId: comparison.comparisonId, side, evidenceId, maxLines: 8});
        assert.equal(support.snapshotId, comparison.snapshotIds[side]);
        assert.equal(support.evidence.find(x => x.id === evidenceId)?.fileHash, support.fileHash);
        proofs.push({side, role:'value-origin', snapshotId:support.snapshotId, filePath:support.filePath, fileHash:support.fileHash, evidenceId});
      }
      const evidence = await call('read_evidence', { comparisonId: comparison.comparisonId, side, evidenceId: step.evidenceId, maxLines: 12 });
      assert.equal(evidence.snapshotId, comparison.snapshotIds[side]); assert.equal(evidence.filePath, step.from.path);
      assert.equal(evidence.fileHash, sha(side === 'base' && step.from.path === targetPath ? original : readFileSync(path.join(project, step.from.path))));
      const proof = evidence.evidence.find(x => x.id === step.evidenceId); assert.ok(proof);
      const text = side === 'base' && step.from.path === targetPath ? original.toString('utf8') : readFileSync(path.join(project, step.from.path), 'utf8');
      assert.equal(text.slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
      proofs.push({ side, snapshotId: evidence.snapshotId, filePath: evidence.filePath, fileHash: evidence.fileHash, range: proof.range, excerpt: proof.excerpt, kind: step.kind });
    }
    const mapping = core || dispatch || receivers ? {oldNode: routes.find(x => x.side === 'base' && x.seed.name === targetName).seed, newNode: routes.find(x => x.side === 'current' && x.seed.name === targetName).seed} : change.symbols.find(x => x.oldNode?.name === 'shallow' && x.newNode?.name === 'shallow'); assert.ok(mapping);
    const source = await call('read_evidence', { comparisonId: comparison.comparisonId, side, nodeId: mapping[side === 'base' ? 'oldNode' : 'newNode'].id, maxLines: receivers ? 60 : core || dispatch ? 20 : 8 });
    assert.equal(source.snapshotId, comparison.snapshotIds[side]); assert.equal(source.fileHash, sha(side === 'base' ? original : readFileSync(targetFile)));
    assert.equal(source.matchesCurrentFile, side === 'current');
    assert.ok(source.lines.some(x => x.text.includes(receivers ? side === 'base' ? 'this.flags = NONE' : 'this.clearFlags()' : side === 'base' ? beforeText : afterText)));
  }
  if (receivers) {
    const found=await call('compare_worktree',{comparisonId:comparison.comparisonId,symbolQuery:'cleanup.clearFlags',symbolSide:'current',limit:5});
    const symbol=found.symbols.find(item=>item.node.name==='effectScopeOper.cleanup.clearFlags');assert.ok(symbol);
    const focused=await call('compare_worktree',{comparisonId:comparison.comparisonId,focus:{side:'current',nodeId:symbol.node.id},limit:5});
    assert.deepEqual(focused.snapshotIds,comparison.snapshotIds);assert.equal(focused.stale,false);
    assert.equal(focused.focus.nodeId,symbol.node.id);assert.ok(focused.truncation);
    assert.ok(focused.paths.every(item=>item.side==='current'&&item.seed.id===symbol.node.id));
    const route = focused.paths.find(item=>item.target.name==='effectScopeOper' && item.distance===2 && item.steps.every(step=>step.kind==='CALLS'));
    assert.ok(route,'Nested state alias and method this must form a same-side two-step path');
    nestedCanary = {source:'compare_worktree-focus',side:'current',snapshotId:comparison.snapshotIds.current,distance:2,overviewTruncated:focused.overviewTruncated,analysisTruncated:focused.analysisTruncated,truncation:focused.truncation};
    for(const step of route.steps){
      for(const evidenceId of [step.evidenceId,...(step.supportingEvidenceIds??[])]){
        const proof=await call('read_evidence',{comparisonId:comparison.comparisonId,side:'current',evidenceId,maxLines:8});
        assert.equal(proof.snapshotId,comparison.snapshotIds.current);
        assert.equal(proof.fileHash,sha(readFileSync(path.join(project,proof.filePath))));
        proofs.push({side:'current',role:'nested-this-canary',snapshotId:proof.snapshotId,filePath:proof.filePath,fileHash:proof.fileHash,evidenceId});
      }
    }
  }
  // Inspect the exact MCP-produced snapshot rather than running a separate analyzer for statistics.
  const store = new SnapshotStore(path.join(run, 'cache'), project);
  try {
    snapshot = store.get(overview.snapshotId); assert.ok(snapshot);
    assert.ok(snapshot.configuration.inputs.some(x => x.path === 'pnpm-workspace.yaml'));
    const bundle = store.comparison(comparison.comparisonId); assert.ok(bundle);
    sideStatistics=Object.fromEntries(['base','current'].map(side=>[side,{status:bundle[side].snapshot.status,statistics:bundle[side].snapshot.statistics,diagnostics:bundle[side].snapshot.diagnostics.length}]));
    writeFileSync(path.join(run,'base-snapshot.json'),JSON.stringify(bundle.base.snapshot));
    assert.ok(bundle.base.snapshot.configuration.inputs.some(x => x.path === 'pnpm-workspace.yaml'));
    for (const captured of [bundle.base, bundle.current]) {
      const sources = new Map(captured.sources.map(x => [x.path, x]));
      const files = new Map(captured.snapshot.files.map(x => [x.id, x]));
      for (const file of captured.snapshot.files) assert.equal(file.hash, sha(sources.get(file.path).content));
      for (const evidence of captured.snapshot.evidence) {
        const file = files.get(evidence.fileId), source = sources.get(file.path);
        assert.equal(evidence.fileHash, file.hash);
        assert.equal(source.content.slice(evidence.range.startOffset, evidence.range.endOffset), evidence.excerpt);
      }
    }
  } finally { store.close(); }
  writeFileSync(path.join(run, 'snapshot.json'), JSON.stringify(snapshot));
  let fixedCorpus;
  if (option('--baseline')) {
    const before = JSON.parse(readFileSync(option('--baseline'), 'utf8'));
    const corpus = s => s.files.map(f => [f.path, f.hash]).sort(([a], [b]) => a.localeCompare(b, 'en'));
    assert.deepEqual(corpus(before), corpus(snapshot));
    fixedCorpus = { identicalFilesAndHashes: true, before: before.statistics, after: snapshot.statistics,
      diagnostics: { before: before.diagnostics.length, after: snapshot.diagnostics.length } };
  }
  result = { passed: true, repository: 'https://github.com/TanStack/store', revision, run, project, core, dispatch, receivers, modelCalls: 0,
    snapshotId: overview.snapshotId, status: overview.status, statistics: overview.statistics, diagnostics: overview.totals.diagnostics, ...(retainedGap ? {retainedGap} : {}), ...(nestedCanary ? {nestedCanary} : {}),
    reading: reading.readingOrder.map(x => ({ name: x.node.name, path: x.node.path })),
    comparison: { id: comparison.comparisonId, snapshotIds: comparison.snapshotIds, status: comparison.status, statistics: comparison.statistics, baselineDependencies:comparison.baselineDependencies,sideStatistics,
      truncated: comparison.truncated, paths: routes.length, crossPackageProofs: proofs },
    toolCalls: calls.length, maxResultCharacters: Math.max(...calls.map(x => x.response.content[0].text.length)),
    timings: calls.map(x => ({ tool: x.name, elapsedMs: x.elapsedMs })), ...(fixedCorpus ? { fixedCorpus } : {}) };
} catch (error) {
  result = { passed: false, run, error: error.message }; process.exitCode = 1;
} finally {
  writeFileSync(targetFile, original); writeFileSync(workspaceFile, workspace);
  await client.close();
  assert.equal(git(['status', '--porcelain=v1', '-z']), '', 'Controlled probe must restore the external checkout');
  result.checkoutRestored = true;
  writeFileSync(path.join(run, 'result.json'), JSON.stringify(result, null, 2));
  writeFileSync(path.join(parent, 'latest.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
}
