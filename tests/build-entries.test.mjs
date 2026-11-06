import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { tempProject, findSymbol } from './helpers.mjs';
import { isSnapshotStale } from '../packages/analyzer/dist/index.js';

const json = JSON.stringify;
const config = "import { defineConfig } from 'tsdown'; export default defineConfig({ entry: ['./src/index.ts', './src/public.ts'], format: ['esm', 'cjs'], unbundle: true, dts: true, fixedExtension: false });";
const files = {
  'package.json': json({ private: true, workspaces: ['packages/*'] }),
  'node_modules/tsdown/package.json': json({ name: 'tsdown', types: 'index.d.ts' }),
  'node_modules/tsdown/index.d.ts': 'export declare function defineConfig<T>(value: T): T;',
  'packages/core/package.json': json({ name: '@demo/core', type: 'module', scripts: { build: 'tsdown --tsconfig tsconfig.build.json' }, exports: { '.': { import: './dist/index.js', require: './dist/index.cjs' }, './public': './dist/public.js' } }),
  'packages/core/tsdown.config.ts': config,
  'packages/core/src/index.ts': "export { value } from './value';",
  'packages/core/src/value.ts': 'export function value() { return 1; }',
  'packages/core/src/public.ts': 'export function visible() { return 2; }',
  'packages/core/src/private.ts': 'export function hidden() { return 3; }',
  'packages/app/package.json': json({ name: '@demo/app', type: 'module' }),
  'packages/app/src/main.ts': "import { value } from '@demo/core'; import { visible } from '@demo/core/public'; export function run() { return value() + visible(); }",
};
function calls(snapshot, name, file) {
  const caller = findSymbol(snapshot, 'packages/app/src/main.ts', 'run');
  const target = findSymbol(snapshot, file, name);
  return snapshot.relations.some(x => x.kind === 'CALLS' && x.from === caller.id && x.to === target.id);
}
test('literal tsdown unbundle entries resolve unbuilt import/require outputs and barrels without creating build files', t => {
  const project = tempProject(t, files), snapshot = project.analyze();
  assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  assert.ok(calls(snapshot, 'value', 'packages/core/src/value.ts'));
  assert.ok(calls(snapshot, 'visible', 'packages/core/src/public.ts'));
  assert.ok(!existsSync(path.join(project.root, 'packages/core/dist')));
  assert.ok(snapshot.configuration.inputs.some(x => x.path === 'packages/core/tsdown.config.ts'));
});
test('tsdown mapping honors export encapsulation and scan exclusion', t => {
  const project = tempProject(t, { ...files, '.codetrailignore': 'packages/core/src/public.ts\n',
    'packages/app/src/main.ts': "import { hidden } from '@demo/core/private'; import { visible } from '@demo/core/public'; export function run() { return hidden() + visible(); }" });
  const snapshot = project.analyze();
  assert.ok(!calls(snapshot, 'hidden', 'packages/core/src/private.ts'));
  assert.ok(snapshot.unresolved.some(x => x.kind === 'IMPORTS'));
  assert.ok(!snapshot.files.some(x => x.path === 'packages/core/src/public.ts'));
});
test('plugins, dynamic configuration, output hooks and CLI overrides remain explicit gaps and never execute', t => {
  for (const body of [config + " throw new Error('must never execute');", config.replace("entry:", "plugins: [(() => { throw Error('must never execute') })()], entry:"),
    config.replace("entry:", "outExtensions: () => ({ js: '.other' }), entry:"), config.replace("['./src/index.ts', './src/public.ts']", 'getEntries()')]) {
    const snapshot = tempProject(t, { ...files, 'packages/core/tsdown.config.ts': body }).analyze();
    assert.ok(snapshot.diagnostics.some(x => x.code === 'BUILD_ENTRY_UNSUPPORTED'));
    assert.ok(!calls(snapshot, 'value', 'packages/core/src/value.ts'));
  }
  const manifest = JSON.parse(files['packages/core/package.json']); manifest.scripts.build += ' --out-dir other';
  const snapshot = tempProject(t, { ...files, 'packages/core/package.json': json(manifest) }).analyze();
  assert.ok(!calls(snapshot, 'value', 'packages/core/src/value.ts'));
});
test('static build configuration changes invalidate input identity and output redirects', t => {
  const project = tempProject(t, files), before = project.analyze();
  assert.equal(isSnapshotStale(before), false);
  project.write('packages/core/tsdown.config.ts', config.replace("entry:", "outDir: 'other', entry:"));
  assert.equal(isSnapshotStale(before), true);
  const after = project.analyze(); assert.notEqual(before.id, after.id);
  assert.ok(!calls(after, 'value', 'packages/core/src/value.ts'));
});
test('cross-package build paths, glob entries, and scanned output collisions never become guessed source edges', t => {
  for (const entry of ['../other/index.ts', './src/*.ts']) {
    const snapshot = tempProject(t, { ...files, 'packages/core/tsdown.config.ts': config.replace("['./src/index.ts', './src/public.ts']", json([entry])) }).analyze();
    assert.ok(snapshot.diagnostics.some(x => x.code === 'BUILD_ENTRY_UNSUPPORTED'));
    assert.ok(!calls(snapshot, 'value', 'packages/core/src/value.ts'));
  }
  const snapshot = tempProject(t, { ...files, 'packages/core/tsdown.config.ts': config.replace("entry:", "outDir: 'src', entry:"),
    'packages/core/src/index.js': 'export function different() { return 99; }' }).analyze();
  assert.ok(snapshot.diagnostics.some(x => x.code === 'BUILD_ENTRY_UNSUPPORTED'));
});

test('explicit svelte-package directories map TS/JS exports without executing preprocessors or indexing Svelte files', t => {
  const manifest = JSON.parse(files['packages/core/package.json']);
  manifest.scripts.build = 'svelte-package --input ./src --output ./dist';
  manifest.devDependencies = { '@sveltejs/package': '2.5.7' };
  const { 'packages/core/tsdown.config.ts': unused, ...others } = files;
  const project = tempProject(t, { ...others, 'packages/core/package.json': json(manifest),
    'packages/core/src/component.svelte': '<script>throw Error("never execute")</script>' });
  const snapshot = project.analyze();
  assert.ok(calls(snapshot, 'value', 'packages/core/src/value.ts'));
  assert.ok(!snapshot.files.some(x => x.path.endsWith('.svelte')));
  assert.ok(!existsSync(path.join(project.root, 'packages/core/dist')));
  manifest.scripts.build += ' && untrusted';
  project.write('packages/core/package.json', json(manifest));
  assert.ok(!calls(project.analyze(), 'value', 'packages/core/src/value.ts'));
});

test('explicit build root/outDir preserve nested entry paths and reject non-scalar directories', t => {
  const manifest = JSON.parse(files['packages/core/package.json']);
  manifest.exports = { '.': './lib/src/index.js', './public': './lib/src/public.js' };
  const project = tempProject(t, { ...files, 'packages/core/package.json': json(manifest),
    'packages/core/tsdown.config.ts': config.replace('entry:', "root: '.', outDir: 'lib', entry:") });
  assert.ok(calls(project.analyze(), 'value', 'packages/core/src/value.ts'));
  project.write('packages/core/tsdown.config.ts', config.replace('entry:', "root: ['.', 'other'], outDir: 'lib', entry:"));
  assert.ok(!calls(project.analyze(), 'value', 'packages/core/src/value.ts'));
  manifest.exports = { '.': './lib/.js' };
  project.write('packages/core/package.json', json(manifest));
  project.write('packages/core/tsdown.config.ts', config.replace("['./src/index.ts', './src/public.ts']", "['./src/index.ts']").replace('entry:', "root: './src/index.ts', outDir: 'lib', entry:"));
  assert.ok(project.analyze().diagnostics.some(x => x.code === 'BUILD_ENTRY_UNSUPPORTED'));
});

test('shared dependency declarations keep independent project aliases and source method targets', t => {
  const project = tempProject(t, {
    'node_modules/shared/package.json': json({ name: 'shared', types: 'index.d.ts' }),
    'node_modules/shared/index.d.ts': "import { Model } from '@env'; export declare function identity(value: Model): Model;",
    'a/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@env': ['./env.ts'] } } }),
    'b/tsconfig.json': json({ compilerOptions: { baseUrl: '.', paths: { '@env': ['./env.ts'] } } }),
    'a/env.ts': "export class Model { value() { return 'a'; } }",
    'b/env.ts': 'export class Model { value() { return 2; } }',
    'a/index.ts': "import { identity } from 'shared'; import { Model } from './env'; export function run(value: Model) { return identity(value).value(); }",
    'b/index.ts': "import { identity } from 'shared'; import { Model } from './env'; export function run(value: Model) { return identity(value).value(); }",
  });
  const snapshot = project.analyze(); assert.equal(snapshot.status, 'complete', JSON.stringify(snapshot.diagnostics));
  for (const side of ['a', 'b']) {
    const caller = findSymbol(snapshot, `${side}/index.ts`, 'run'), target = findSymbol(snapshot, `${side}/env.ts`, 'Model.value');
    const other = findSymbol(snapshot, `${side === 'a' ? 'b' : 'a'}/env.ts`, 'Model.value');
    assert.ok(snapshot.relations.some(x => x.kind === 'CALLS' && x.from === caller.id && x.to === target.id));
    assert.ok(!snapshot.relations.some(x => x.kind === 'CALLS' && x.from === caller.id && x.to === other.id));
    assert.match(caller.signature, side === 'a' ? /string/ : /number/);
  }
});
