import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { SnapshotStore } from '../apps/local/dist/store.js';
import { root } from './acceptance-projects.mjs';

// Deterministic engineering rehearsal. No participant, model turn or target code execution.
const args = process.argv.slice(2);
const value = flag => { const i = args.indexOf(flag); return i < 0 ? undefined : args[i + 1]; };
const selected = value('--project') ?? 'all';
assert.ok(['all', 'self', 'tanstack'].includes(selected), '--project must be all, self or tanstack');
const parent = path.join(root, 'artifacts/user-trial'); mkdirSync(parent, { recursive: true });
const run = mkdtempSync(path.join(parent, 'prerun-'));
const environment = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
Object.assign(environment, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = (project, parameters) => execFileSync('git', ['--no-optional-locks', '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', project, ...parameters], { env: environment, encoding: 'utf8', windowsHide: true, timeout: 15000 });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const scenarios = [
  { id: 'self', project: root, target: 'packages/graph/src/comparison.ts', name: 'compareSnapshots',
    before: 'maxDepth: 2, maxPaths: 100,', after: 'maxDepth: 2, maxPaths: 80,',
    architecture: [['createMcpRuntime', 'apps/local/src/mcp.ts'], ['analyzeProject', 'packages/analyzer/src/index.ts']],
    testFile: 'tests/comparison.test.mjs', testNeedle: 'const capped = calculateComparisonImpact({ ...report, maxPaths: 1 }',
    caller: /^apps\/local\/src\/comparison-worker\.ts$/ },
  { id: 'tanstack', project: value('--external') ?? path.join(root, 'artifacts/external-monorepo/tanstack-store'),
    revision: '53f30be1e43c8d7899ace08023705b34f5e533f8', target: 'packages/store/src/shallow.ts', name: 'shallow',
    before: 'if (Object.is(objA, objB)) {', after: 'if (objA === objB) {',
    architecture: [['createAtom', 'packages/store/src/atom.ts'], ['useCreateAtom', 'packages/react-store/src/useCreateAtom.ts']],
    testFile: 'packages/preact-store/tests/index.test.tsx', testNeedle: 'expect(shallow(objA, objB))',
    caller: /^packages\/preact-store\/tests\// },
].filter(scenario => selected === 'all' || selected === scenario.id);

async function rehearse(scenario) {
  const project = realpathSync(path.resolve(scenario.project)), directory = path.join(run, scenario.id), cache = path.join(directory, 'cache');
  mkdirSync(directory, { recursive: true });
  const target = path.join(project, scenario.target), original = readFileSync(target), text = original.toString('utf8');
  assert.equal(text.split(scenario.before).length, 2, 'Probe must match exactly one source location');
  const probe = Buffer.from(text.replace(scenario.before, scenario.after));
  const head = git(project, ['rev-parse', 'HEAD']).trim();
  assert.equal(git(project, ['show', `HEAD:${scenario.target}`]), text, 'The probe target must match HEAD before rehearsal');
  if (scenario.revision) {
    assert.equal(head, scenario.revision);
    assert.equal(git(project, ['status', '--porcelain=v1', '-z']), '', 'Use a clean disposable external clone');
    assert.ok(!/^(?:filter\.|include(?:if\..*)?\.)/im.test(git(project, ['config', '--local', '--no-includes', '--list'])));
  }
  const client = new Client({ name: 'codetrail-user-trial-prerun', version: '0.11.0' });
  const calls = [], result = { project: scenario.id, root: project, head, kind: 'scripted-engineering-prerun', modelCalls: 0, tasks: {}, passed: false };
  async function call(name, parameters) {
    const started = performance.now(), response = await client.callTool({ name, arguments: parameters }, { timeout: 90000 });
    calls.push({ name, parameters, elapsedMs: Math.round(performance.now() - started), response });
    writeFileSync(path.join(directory, 'tool-calls.json'), JSON.stringify(calls, null, 2));
    assert.notEqual(response.isError, true, JSON.stringify(response));
    assert.ok(response.content[0].text.length <= 48000);
    assert.equal(response.structuredContent.sourceTrust, 'untrusted-repository-data');
    return response.structuredContent;
  }
  const cite = source => ({ snapshotId: source.snapshotId, ...(source.comparisonId ? { comparisonId: source.comparisonId, side: source.side } : {}),
    filePath: source.filePath, fileHash: source.fileHash, startLine: source.startLine, endLine: source.endLine });
  async function find(pin, name, file) {
    const found = await call('search_symbols', { ...pin, query: name, limit: 20 });
    assert.equal(found.stale, false); assert.equal(found.snapshotId, pin.snapshotId);
    const node = found.results.find(item => item.name === name && item.path === file);
    assert.ok(node, `Cannot locate ${file}#${name}`); return node;
  }
  async function source(selector, expected, matches) {
    const proof = await call('read_evidence', { ...selector, maxLines: 80 });
    assert.equal(proof.fileHash, sha(expected)); assert.equal(proof.matchesCurrentFile, matches);
    if (selector.snapshotId) assert.equal(proof.snapshotId, selector.snapshotId);
    if (selector.comparisonId) { assert.equal(proof.comparisonId, selector.comparisonId); assert.equal(proof.side, selector.side); }
    return proof;
  }
  let comparison;
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'apps/local/dist/cli.js'), 'mcp', project, '--data-dir', cache], stderr: 'pipe' }));
    result.server = client.getServerVersion();
    assert.equal(result.server.name, 'codetrail'); assert.equal(result.server.version, '0.11.0');
    const overview = await call('project_overview', { refresh: true });
    assert.equal(overview.project.rootDir, project); assert.equal(overview.stale, false);
    if (scenario.id === 'self') assert.equal(overview.status, 'complete');
    assert.equal(overview.statistics.parseErrors, 0);
    const pin = { snapshotId: overview.snapshotId }, guide = await call('recommend_reading', pin);
    assert.equal(guide.snapshotId, pin.snapshotId); assert.equal(guide.stale, false);
    assert.ok(guide.readingOrder.length > 0 && guide.readingOrder.length <= 10);
    const architectureEvidence = [];
    for (const [name, file] of scenario.architecture) {
      const node = await find(pin, name, file);
      const proof = await source({ ...pin, nodeId: node.id }, readFileSync(path.join(project, file)), true);
      architectureEvidence.push({ name, ...cite(proof) });
    }
    const firstStep = guide.readingOrder[0];
    const readingProof = await source({ ...pin, nodeId: firstStep.node.id }, readFileSync(path.join(project, firstStep.node.path)), true);
    result.tasks.T1 = { passed: true, snapshotId: overview.snapshotId, status: overview.status, diagnostics: overview.totals.diagnostics,
      resolutionSummary: overview.resolutionSummary, architectureEvidence, readingEvidence: cite(readingProof),
      readingOrder: guide.readingOrder.map(item => ({ name: item.node.name, path: item.node.path })),
      note: '入口和推荐是阅读线索；脚本核验可达证据，未对人的架构解释评分。' };

    const node = await find(pin, scenario.name, scenario.target);
    const context = await call('symbol_context', { ...pin, nodeId: node.id, depth: 1, maxNodes: 40 });
    assert.equal(context.stale, false); assert.equal(context.snapshotId, pin.snapshotId);
    const edge = context.edges.find(edge => edge.kind === 'CALLS' && edge.to === node.id); assert.ok(edge);
    const caller = context.nodes.find(item => item.id === edge.from); assert.ok(caller);
    const callProof = await source({ ...pin, evidenceId: edge.evidenceIds[0] }, readFileSync(path.join(project, caller.path)), true);
    result.tasks.T1.staticRelation = { from: caller.path, to: scenario.target, kind: edge.kind, citation: cite(callProof) };
    const location = await source({ ...pin, nodeId: node.id }, original, true);
    assert.ok(location.lines.some(line => line.text.includes(scenario.before)));
    result.tasks.T2 = { passed: true, symbol: { id: node.id, name: node.name, path: node.path }, citation: cite(location),
      contextTruncated: context.truncated, sourceWindowed: location.windowed, sourceTruncated: location.truncated,
      note: scenario.id === 'self' ? '定位图谱计算的 maxPaths；MCP limit 只控制分页。tests/*.mjs 不在扫描范围，须用普通文件工具检查相关测试。' : '只演练首个同值快速判断；不替换 Map、对象成员等其余 Object.is。行为差异需测试核实。' };
    const testBytes = readFileSync(path.join(project, scenario.testFile)), testLines = testBytes.toString('utf8').split(/\r\n|\n|\r/);
    const testLine = testLines.findIndex(line => line.includes(scenario.testNeedle)) + 1; assert.ok(testLine > 0);
    result.tasks.T2.testInspection = { source: 'ordinary-file-inspection', head, filePath: scenario.testFile, fileHash: sha(testBytes), line: testLine,
      excerpt: testLines[testLine - 1], executed: false };
    if (scenario.id === 'tanstack') {
      const other = await find(pin, 'compareShallow', 'packages/store/src/compare.ts'); assert.notEqual(other.id, node.id);
      const proof = await source({ ...pin, nodeId: other.id }, readFileSync(path.join(project, other.path)), true);
      assert.ok(proof.lines.some(line => line.text.includes('return _evaluate')));
      result.tasks.T2.distinctComparisonFunction = { name: other.name, ...cite(proof), note: 'React tests import this separate function; the shallow suite title is not a call identity.' };
    }

    // Deliberately edit source for the impact task; restore bytes even if any assertion fails.
    writeFileSync(target, probe);
    assert.equal((await call('project_overview', {})).stale, true);
    await source({ ...pin, nodeId: node.id }, original, false);
    comparison = await call('compare_worktree', { refresh: true, limit: 2 });
    assert.equal(comparison.baseline.head, head); assert.equal(comparison.baseline.state, 'ready'); assert.equal(comparison.stale, false);
    assert.equal(comparison.totals.changes, 1); assert.equal(comparison.changes[0].newFile.path, scenario.target);
    assert.equal(comparison.baselineDependencies.policy, 'matched-local-declarations');
    const paths = [], declarations = [];
    for (const side of ['base', 'current']) {
      const found = await call('compare_worktree', { comparisonId: comparison.comparisonId, symbolQuery: scenario.name, symbolSide: side, limit: 10 });
      const chosen = found.symbols.find(item => item.node.name === scenario.name && item.node.path === scenario.target);
      assert.ok(chosen, `Missing ${side} focused symbol`);
      let offset = 0, focused; const routes = [];
      do {
        focused = await call('compare_worktree', { comparisonId: comparison.comparisonId, focus: { side, nodeId: chosen.node.id }, pathOffset: offset, limit: 10 });
        assert.equal(focused.stale, false); assert.deepEqual(focused.snapshotIds, comparison.snapshotIds);
        assert.ok(focused.paths.every(route => route.side === side && route.seed.id === chosen.node.id));
        routes.push(...focused.paths); offset = focused.nextPathOffset;
      } while (offset !== null);
      assert.equal(new Set(routes.map(route => route.id)).size, focused.totals.paths);
      if (scenario.id === 'tanstack') assert.ok(!routes.some(route => route.distance === 1 && route.target.path === 'packages/react-store/tests/index.test.tsx' && route.steps.some(step => step.kind === 'CALLS')), 'Do not conflate shallow with compareShallow by test title');
      const route = routes.find(item => scenario.caller.test(item.target.path) && item.distance === 1 && item.steps.some(step => step.kind === 'CALLS'));
      assert.ok(route, `Missing ${side} caller route for ${scenario.name}`);
      const step = route.steps.find(item => item.kind === 'CALLS');
      const proof = await source({ comparisonId: comparison.comparisonId, side, evidenceId: step.evidenceId }, readFileSync(path.join(project, step.from.path)), true);
      assert.equal(proof.snapshotId, comparison.snapshotIds[side]);
      const declaration = await source({ comparisonId: comparison.comparisonId, side, nodeId: chosen.node.id }, side === 'base' ? original : probe, side === 'current');
      assert.equal(declaration.snapshotId, comparison.snapshotIds[side]);
      assert.ok(declaration.lines.some(line => line.text.includes(side === 'base' ? scenario.before : scenario.after)));
      declarations.push({ side, nodeId: chosen.node.id, ...cite(declaration) });
      paths.push({ side, distance: route.distance, target: route.target.path, citation: cite(proof), paths: routes.length,
        overviewTruncated: focused.overviewTruncated, analysisTruncated: focused.analysisTruncated, truncation: focused.truncation });
    }
    const store = new SnapshotStore(cache, project);
    let verifiedEvidence = 0;
    try {
      const bundle = store.comparison(comparison.comparisonId); assert.ok(bundle?.base);
      for (const side of ['base', 'current']) {
        const captured = bundle[side], sources = new Map(captured.sources.map(item => [item.path, item]));
        const files = new Map(captured.snapshot.files.map(item => [item.id, item]));
        for (const file of files.values()) assert.equal(file.hash, sha(sources.get(file.path).content));
        for (const proof of captured.snapshot.evidence) {
          const file = files.get(proof.fileId), content = sources.get(file.path).content;
          assert.equal(proof.fileHash, file.hash); assert.equal(proof.excerpt, content.slice(proof.range.startOffset, proof.range.endOffset)); verifiedEvidence++;
        }
      }
      result.sideDiagnostics = Object.fromEntries(['base', 'current'].map(side => [side, bundle[side].snapshot.diagnostics.length]));
    } finally { store.close(); }

    assert.deepEqual(readFileSync(target), probe, 'Do not overwrite a concurrent source edit'); writeFileSync(target, original);
    assert.equal((await call('compare_worktree', { comparisonId: comparison.comparisonId, limit: 1 })).stale, true);
    for (const declaration of declarations) {
      const old = await source({ comparisonId: comparison.comparisonId, side: declaration.side, nodeId: declaration.nodeId }, declaration.side === 'base' ? original : probe, declaration.side === 'base');
      assert.equal(old.stale, true); assert.ok(old.lines.some(line => line.text.includes(declaration.side === 'base' ? scenario.before : scenario.after)));
    }
    const zero = await call('compare_worktree', { refresh: true, limit: 1 });
    assert.equal(zero.stale, false); assert.equal(zero.baseline.head, head);
    assert.equal(zero.statistics.files, 0); assert.equal(zero.statistics.symbols, 0); assert.equal(zero.statistics.paths, 0);
    result.tasks.T3 = { passed: true, comparisonId: comparison.comparisonId, snapshotIds: comparison.snapshotIds, status: comparison.status,
      baselineDependencies: comparison.baselineDependencies, overviewTruncated: comparison.analysisTruncated, truncation: comparison.truncation,
      paths, declarations, verifiedEvidence, staleAfterRestore: true, historicalEvidenceRetained: true,
      zeroComparisonId: zero.comparisonId, zeroStatistics: zero.statistics, zeroStatus: zero.status };
    result.passed = true;
  } catch (error) { result.error = error.message; }
  finally {
    const live = readFileSync(target);
    if (live.equals(probe)) writeFileSync(target, original);
    else if (!live.equals(original)) { result.passed = false; result.error = 'Concurrent source edit preserved; rehearsal cannot assert restoration'; }
    await client.close();
    result.sourceRestored = readFileSync(target).equals(original);
    result.headUnchanged = git(project, ['rev-parse', 'HEAD']).trim() === head;
    if (scenario.revision) result.externalCheckoutClean = git(project, ['status', '--porcelain=v1', '-z']) === '';
    result.passed &&= result.sourceRestored && result.headUnchanged && result.externalCheckoutClean !== false;
    result.toolCalls = calls.length; result.maxResultCharacters = Math.max(0, ...calls.map(item => item.response.content[0].text.length));
    result.timings = calls.map(item => ({ tool: item.name, elapsedMs: item.elapsedMs }));
    writeFileSync(path.join(directory, 'result.json'), JSON.stringify(result, null, 2));
  }
  return result;
}

const results = [];
for (const scenario of scenarios) {
  try { results.push(await rehearse(scenario)); }
  catch (error) { results.push({ project: scenario.id, passed: false, error: error.message }); }
}
const output = { generatedAt: new Date().toISOString(), run, kind: 'scripted-engineering-prerun', participantCount: 0, modelCalls: 0,
  passed: results.length === scenarios.length && results.every(item => item.passed), results };
writeFileSync(path.join(run, 'result.json'), JSON.stringify(output, null, 2));
writeFileSync(path.join(parent, 'latest.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ ...output, results: results.map(item => ({ project: item.project, passed: item.passed, error: item.error,
  tasks: Object.keys(item.tasks ?? {}), calls: item.toolCalls, sourceRestored: item.sourceRestored, sideDiagnostics: item.sideDiagnostics })) }, null, 2));
if (!output.passed) process.exitCode = 1;
