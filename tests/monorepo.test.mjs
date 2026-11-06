import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { symlinkSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { tempProject, findSymbol } from './helpers.mjs';
import { isSnapshotStale } from '../packages/analyzer/dist/index.js';
import { SnapshotStore } from '../apps/local/dist/store.js';
import { ComparisonManager } from '../apps/local/dist/comparison-manager.js';
import { gitCommand } from './git-fixture.mjs';

const json = JSON.stringify;
const files = {
  'package.json': json({ private: true, workspaces: ['packages/*', 'apps/*'] }),
  'tsconfig.json': json({ files: [], references: [{ path: './packages/core' }, { path: './apps/a' }, { path: './apps/b/config.json' }] }),
  'base.json': json({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler', strict: true, composite: true } }),
  'packages/core/package.json': json({ name: '@demo/core', exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, './feature/*': { types: './dist/features/*.d.ts', default: './dist/features/*.js' } } }),
  'packages/core/tsconfig.json': json({ extends: '../../base.json', compilerOptions: { rootDir: 'src', outDir: 'dist' }, include: ['src'] }),
  'packages/core/src/index.ts': "export { value } from './value.js'; export type { Payload } from './value.js';\n",
  'packages/core/src/value.ts': 'export interface Payload { count: number; }\nexport function value(input: Payload) { return input.count; }\n',
  'packages/core/src/features/other.ts': 'export function other() { return 2; }\n',
  'apps/a/package.json': json({ name: '@demo/a' }),
  'apps/a/tsconfig.json': json({ extends: '../../base.json', references: [{ path: '../../packages/core' }], compilerOptions: { baseUrl: '.', paths: { '@local': ['./src/helper.ts'] } } }),
  'apps/a/src/helper.ts': 'export function local() { return 1; }',
  'apps/a/src/main.ts': "import { value } from '@demo/core'; import type { Payload } from '@demo/core'; import { local } from '@local';\nexport function run() { const input: Payload = { count: local() }; return value(input); }\n",
  'apps/b/package.json': json({ name: '@demo/b' }),
  'apps/b/config.json': json({ extends: '../../base.json', compilerOptions: { baseUrl: '.', paths: { '@local': ['./src/helper.ts'] }, strict: false } }),
  'apps/b/src/helper.ts': 'export function local() { return 2; }',
  'apps/b/src/main.ts': "import { value } from '@demo/core'; import { other } from '@demo/core/feature/other'; import { local } from '@local';\nexport function run() { return value({ count: local() }) + other(); }\n",
};
function hasEdge(snapshot, kind, fromFile, fromName, toFile, toName) {
  const from = findSymbol(snapshot, fromFile, fromName), to = findSymbol(snapshot, toFile, toName);
  return snapshot.relations.some((edge) => edge.kind === kind && edge.from === from.id && edge.to === to.id);
}
test('solution references and workspace exports resolve to unbuilt source, preserving per-project aliases and symbol identity', (t) => {
  const project = tempProject(t, files), snapshot = project.analyze();
  assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  for (const app of ['a', 'b']) {
    assert.ok(hasEdge(snapshot, 'CALLS', `apps/${app}/src/main.ts`, 'run', 'packages/core/src/value.ts', 'value'));
    assert.ok(hasEdge(snapshot, 'CALLS', `apps/${app}/src/main.ts`, 'run', `apps/${app}/src/helper.ts`, 'local'));
  }
  assert.ok(!hasEdge(snapshot, 'CALLS', 'apps/a/src/main.ts', 'run', 'apps/b/src/helper.ts', 'local'));
  assert.ok(hasEdge(snapshot, 'CALLS', 'apps/b/src/main.ts', 'run', 'packages/core/src/features/other.ts', 'other'));
  const payload = findSymbol(snapshot, 'packages/core/src/value.ts', 'Payload');
  assert.ok(snapshot.relations.some((edge) => edge.kind === 'REFERENCES' && edge.to === payload.id && edge.usage === 'type'));
  assert.ok(snapshot.configuration.inputs.some((input) => input.path === 'apps/b/config.json'));
  assert.ok(snapshot.configuration.inputs.some((input) => input.path === 'packages/core/package.json'));
  assert.ok(!snapshot.files.some((file) => file.path.includes('/dist/') || file.path.includes('node_modules')));
});
test('workspace export conditions and encapsulation do not invent links to unexported or excluded source', (t) => {
  const project = tempProject(t, { ...files,
    'packages/core/src/private.ts': 'export function hidden() { return 9; }',
    'apps/a/src/main.ts': "import { hidden } from '@demo/core/src/private'; export function run() { return hidden(); }",
    '.codetrailignore': 'packages/core/src/features/\n',
  });
  const snapshot = project.analyze();
  assert.ok(snapshot.unresolved.some((item) => item.kind === 'IMPORTS'));
  assert.ok(!snapshot.relations.some((edge) => edge.kind === 'CALLS' && edge.to === findSymbol(snapshot, 'packages/core/src/private.ts', 'hidden').id));
  assert.ok(!snapshot.files.some((file) => file.path.includes('/features/')));
});
test('workspace metadata, nested extends and newly created nested configs invalidate snapshots', (t) => {
  const project = tempProject(t, files), first = project.analyze();
  assert.equal(isSnapshotStale(first), false);
  project.write('packages/core/package.json', json({ name: '@demo/core', exports: './src/value.ts' }));
  assert.equal(isSnapshotStale(first), true); assert.notEqual(first.id, project.analyze().id);
  const second = project.analyze();
  project.write('apps/a/src/tsconfig.json', json({ compilerOptions: { strict: false } }));
  assert.equal(isSnapshotStale(second), true);
});
test('nested project references stay inside the selected root and cycles terminate with a diagnostic', (t) => {
  const outside = tempProject(t, { 'tsconfig.json': '{}', 'secret.ts': 'export const privateData = 1;' });
  const project = tempProject(t, { 'tsconfig.json': json({ references: [{ path: outside.root }, { path: './nested' }] }),
    'index.ts': 'export const good = 1;', 'nested/index.ts': 'export const nested = 1;',
    'nested/tsconfig.json': json({ references: [{ path: '..' }] }),
  });
  const snapshot = project.analyze();
  assert.equal(snapshot.files.length, 2); assert.ok(!snapshot.evidence.some((item) => item.excerpt.includes('privateData')));
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'PROJECT_REFERENCE_OUTSIDE_SCOPE'));
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'PROJECT_REFERENCE_CYCLE'));
});
test('linked dependency barrels remain external, with all related declarations included in freshness checks', (t) => {
  const project = tempProject(t, { '.codetrailignore': 'vendor/\n',
    'vendor/lib/package.json': json({ name: 'lib', types: 'index.d.ts' }),
    'vendor/lib/index.d.ts': "export { external } from './other.js';",
    'vendor/lib/other.d.ts': 'export declare function external(): number;',
    'node_modules/.keep': '', 'index.ts': "import { external } from 'lib'; export function run() { return external(); }",
  });
  try { symlinkSync(path.join(project.root, 'vendor/lib'), path.join(project.root, 'node_modules/lib'), process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Links unavailable'); return; } throw error; }
  const snapshot = project.analyze();
  assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  assert.ok(snapshot.unresolved.some((item) => item.kind === 'CALLS' && item.reason === 'external'));
  assert.equal(snapshot.symbols.filter((item) => item.name === 'external').length, 0);
  project.write('vendor/lib/other.d.ts', 'export declare function external(): string;');
  assert.equal(isSnapshotStale(snapshot), true);
});
test('Git comparison traces cross-workspace callers with separate old and new source evidence', async (t) => {
  let store, manager;
  t.after(async () => { await manager?.close(); store?.close(); });
  const project = tempProject(t, files), cache = tempProject(t);
  gitCommand(project.root, ['init', '--quiet']); gitCommand(project.root, ['add', '--all']); gitCommand(project.root, ['commit', '--quiet', '-m', 'Workspace baseline']);
  project.write('packages/core/src/value.ts', 'export interface Payload { count: number; }\nexport function value(input: Payload) { return input.count * 2; }\n');
  store = new SnapshotStore(cache.root, project.root); manager = new ComparisonManager(project.root, store);
  const job = manager.start(); let result;
  for (let index = 0; index < 600; index++) { const current = manager.job(job.id); if (current.status !== 'running') { assert.equal(current.status, 'completed', current.error); result = manager.bundle(current.comparisonId); break; } await delay(30); }
  assert.ok(result);
  for (const side of ['base', 'current']) {
    assert.equal(result[side].snapshot.status, 'complete', JSON.stringify(result[side].snapshot.diagnostics));
    const route = result.report.paths.find((item) => item.side === side && item.target.path === 'apps/a/src/main.ts' && item.steps.some((step) => step.kind === 'CALLS'));
    assert.ok(route, `Missing ${side} workspace caller`);
    for (const step of route.steps) {
      const proof = result[side].snapshot.evidence.find((item) => item.id === step.evidenceId); assert.ok(proof);
      const file = result[side].snapshot.files.find((item) => item.id === proof.fileId);
      const text = result[side].sources.find((item) => item.path === file.path).content;
      assert.equal(text.slice(proof.range.startOffset, proof.range.endOffset), proof.excerpt);
    }
  }
});

test('same-directory referenced configs select unique file membership instead of borrowing a sibling alias', (t) => {
  const project = tempProject(t, {
    'tsconfig.json': json({ files: [], references: [{ path: './client.json' }, { path: './server.json' }] }),
    'client.json': json({ compilerOptions: { baseUrl: '.', paths: { '@env': ['./client/env.ts'] } }, include: ['client/**/*.ts'] }),
    'server.json': json({ compilerOptions: { baseUrl: '.', paths: { '@env': ['./server/env.ts'] }, strict: false }, include: ['server/**/*.ts'] }),
    'client/env.ts': 'export function env() { return 1; }', 'server/env.ts': 'export function env() { return 2; }',
    'client/main.ts': "import { env } from '@env'; export function run() { return env(); }",
    'server/main.ts': "import { env } from '@env'; export function run() { return env(); }",
  });
  const snapshot = project.analyze(); assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  for (const side of ['client', 'server']) assert.ok(hasEdge(snapshot, 'CALLS', `${side}/main.ts`, 'run', `${side}/env.ts`, 'env'));
  assert.ok(!hasEdge(snapshot, 'CALLS', 'client/main.ts', 'run', 'server/env.ts', 'env'));
});
test('declaration provenance never widens from a dependency without a manifest to ignored project declarations', (t) => {
  const project = tempProject(t, { 'package.json': '{}', '.codetrailignore': 'private/\n',
    'node_modules/bare/index.d.ts': 'export declare function external(): number;',
    'private/secret.d.ts': 'export declare function secret(): number;',
    'index.ts': "import { external } from 'bare'; import { secret } from './private/secret'; export const value = external() + secret();",
  });
  const snapshot = project.analyze();
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'TS2307' && item.message.includes('./private/secret')));
  assert.ok(!snapshot.configuration.inputs.some((item) => item.path.includes('private/')));
});
test('duplicate workspace identities stay unresolved rather than selecting the first declaration', (t) => {
  const project = tempProject(t, { ...files, 'packages/duplicate/package.json': json({ name: '@demo/core', exports: './src/index.ts' }),
    'packages/duplicate/src/index.ts': 'export function value() { return 999; }',
  });
  const snapshot = project.analyze();
  assert.ok(snapshot.diagnostics.some((item) => item.code === 'WORKSPACE_PACKAGE_AMBIGUOUS'));
  assert.ok(!snapshot.relations.some((item) => item.kind === 'CALLS' && item.to === findSymbol(snapshot, 'packages/duplicate/src/index.ts', 'value').id));
});

test('NodeNext import and require export conditions select their own source declarations', (t) => {
  const project = tempProject(t, { ...files,
    'base.json': json({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true, composite: true } }),
    'apps/a/package.json': json({ name: '@demo/a', type: 'module' }),
    'apps/b/package.json': json({ name: '@demo/b', type: 'commonjs' }),
    'packages/core/package.json': json({ name: '@demo/core', exports: { '.': {
      import: { types: './dist/import.d.ts', default: './dist/import.js' },
      require: { types: './dist/require.d.ts', default: './dist/require.js' },
    } } }),
    'packages/core/src/import.ts': 'export function value() { return 1; }',
    'packages/core/src/require.ts': 'export function value() { return 2; }',
    'apps/a/src/main.ts': "import { value } from '@demo/core'; export function run() { return value(); }",
    'apps/b/src/main.ts': "import { value } from '@demo/core'; export function run() { return value(); }",
  });
  const snapshot = project.analyze(); assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  assert.ok(hasEdge(snapshot, 'CALLS', 'apps/a/src/main.ts', 'run', 'packages/core/src/import.ts', 'value'));
  assert.ok(hasEdge(snapshot, 'CALLS', 'apps/b/src/main.ts', 'run', 'packages/core/src/require.ts', 'value'));
  assert.ok(!hasEdge(snapshot, 'CALLS', 'apps/a/src/main.ts', 'run', 'packages/core/src/require.ts', 'value'));
});

test('malformed workspace manifests and path-like package identities degrade without redirecting the repository root', (t) => {
  for (const manifest of ['null', json({ name: '..', exports: './src/index.ts' })]) {
    const project = tempProject(t, { ...files, 'packages/core/package.json': manifest });
    const snapshot = project.analyze();
    assert.ok(snapshot.diagnostics.some((item) => item.code === 'WORKSPACE_MANIFEST_INVALID'));
    assert.ok(snapshot.files.some((file) => file.path === 'apps/a/src/main.ts'));
    assert.ok(!hasEdge(snapshot, 'CALLS', 'apps/a/src/main.ts', 'run', 'packages/core/src/value.ts', 'value'));
  }
});

test('Windows reference path casing does not create duplicate projects or permanently stale snapshots', { skip: process.platform !== 'win32' }, (t) => {
  const project = tempProject(t, { ...files, 'tsconfig.json': json({ files: [], references: [{ path: './PACKAGES/CORE' }, { path: './APPS/A' }, { path: './APPS/B/CONFIG.JSON' }] }) });
  const snapshot = project.analyze();
  assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  assert.equal(isSnapshotStale(snapshot), false);
  assert.ok(hasEdge(snapshot, 'CALLS', 'apps/a/src/main.ts', 'run', 'packages/core/src/value.ts', 'value'));
});

const pnpmFiles = {
  'package.json': json({ private: true, workspaces: ['excluded/*'] }),
  'pnpm-workspace.yaml': "# package selection, unrelated settings stay data\npackages: ['packages/**', '!packages/excluded']\nallowBuilds: { untrusted: true }\n",
  'packages/core/package.json': json({ name: '@demo/core', exports: { '.': { development: './src/index.ts', default: './dist/index.js' }, './feature/*': { development: './src/*.ts', default: './dist/*.js' } } }),
  'packages/core/src/index.ts': 'export function value() { return 1; }',
  'packages/core/src/extra.ts': 'export function extra() { return 2; }',
  'packages/app/package.json': json({ name: '@demo/app' }),
  'packages/app/tsconfig.json': json({ compilerOptions: { module: 'ESNext', moduleResolution: 'Bundler', customConditions: ['development'] } }),
  'packages/app/src/index.ts': "import { value } from '@demo/core'; import { extra } from '@demo/core/feature/extra'; export function run() { return value() + extra(); }",
  'packages/excluded/package.json': json({ name: '@demo/core', exports: './src/index.ts' }),
  'packages/excluded/src/index.ts': 'export function value() { return 999; }',
};

test('pnpm workspace selection takes precedence over npm metadata, without executing settings or guessing build layouts', (t) => {
  const project = tempProject(t, pnpmFiles), snapshot = project.analyze();
  assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  assert.ok(hasEdge(snapshot, 'CALLS', 'packages/app/src/index.ts', 'run', 'packages/core/src/index.ts', 'value'));
  assert.ok(hasEdge(snapshot, 'CALLS', 'packages/app/src/index.ts', 'run', 'packages/core/src/extra.ts', 'extra'));
  assert.ok(!hasEdge(snapshot, 'CALLS', 'packages/app/src/index.ts', 'run', 'packages/excluded/src/index.ts', 'value'));
  assert.ok(snapshot.configuration.inputs.some(x => x.path === 'pnpm-workspace.yaml'));
  assert.equal(isSnapshotStale(snapshot), false);
  project.write('pnpm-workspace.yaml', 'packages: []\n');
  assert.equal(isSnapshotStale(snapshot), true);
  assert.ok(!hasEdge(project.analyze(), 'CALLS', 'packages/app/src/index.ts', 'run', 'packages/core/src/index.ts', 'value'));
});

test('creating pnpm workspace metadata invalidates a snapshot even when no source changed', (t) => {
  const { 'pnpm-workspace.yaml': workspace, ...withoutWorkspace } = pnpmFiles;
  const project = tempProject(t, withoutWorkspace), first = project.analyze();
  assert.equal(isSnapshotStale(first), false);
  project.write('pnpm-workspace.yaml', workspace);
  assert.equal(isSnapshotStale(first), true);
  assert.notEqual(first.id, project.analyze().id);
});

test('invalid or aliased pnpm package selectors do not fall back to npm declarations', (t) => {
  for (const text of ['packages: [packages/**\n', 'packages: [!!str 1, 3]\n', 'patterns: &p [packages/**]\npackages: *p\n', 'packages: [../*]\n', 'packages: [packages/**]\npackages: []\n']) {
    const project = tempProject(t, { ...pnpmFiles, 'package.json': json({ workspaces: ['packages/core', 'packages/app'] }), 'pnpm-workspace.yaml': text });
    const snapshot = project.analyze();
    assert.ok(snapshot.diagnostics.some(x => x.code === 'WORKSPACE_CONFIG_INVALID'));
    assert.ok(!hasEdge(snapshot, 'CALLS', 'packages/app/src/index.ts', 'run', 'packages/core/src/index.ts', 'value'));
  }
});

test('pnpm glob normalization and negative patterns preserve the selected root and ignore boundary', (t) => {
  const project = tempProject(t, { ...pnpmFiles, 'pnpm-workspace.yaml': "packages:\n - './packages//**'\n - '!./packages/excluded'\n", '.codetrailignore': 'packages/core/src/extra.ts\n' });
  const snapshot = project.analyze();
  assert.ok(hasEdge(snapshot, 'CALLS', 'packages/app/src/index.ts', 'run', 'packages/core/src/index.ts', 'value'));
  assert.ok(!snapshot.files.some(x => x.path.endsWith('extra.ts')));
  assert.ok(snapshot.unresolved.some(x => x.kind === 'IMPORTS'));
});

test('cached missing dependency probes invalidate when declarations are installed, without indexing implementations', (t) => {
  const project = tempProject(t, { 'index.ts': "import { value } from 'missing-dependency'; export function run() { return value(); }" });
  const before = project.analyze(); assert.equal(isSnapshotStale(before), false);
  assert.ok(before.diagnostics.some(x => x.code === 'TS2307'));
  project.write('node_modules/missing-dependency/package.json', json({ name: 'missing-dependency', types: './index.d.ts' }));
  project.write('node_modules/missing-dependency/index.d.ts', 'export declare function value(): number;');
  assert.equal(isSnapshotStale(before), true);
  const after = project.analyze(); assert.equal(isSnapshotStale(after), false);
  assert.ok(!after.diagnostics.some(x => x.code === 'TS2307'));
  assert.equal(after.files.length, 1);
  assert.ok(after.unresolved.some(x => x.kind === 'CALLS' && x.reason === 'external'));
});
