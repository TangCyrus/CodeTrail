import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { root } from './acceptance-projects.mjs';

// An explicitly invoked acceptance setup step. MCP/analyze never installs or downloads dependencies.
const args = process.argv.slice(2), index = args.indexOf('--project');
const project = realpathSync(path.resolve(index >= 0 ? args[index + 1] : path.join(root, 'artifacts/external-monorepo/tanstack-store')));
const revision = '53f30be1e43c8d7899ace08023705b34f5e533f8';
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith('GIT_')));
Object.assign(env, { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null', GIT_TERMINAL_PROMPT: '0' });
const git = parameters => execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=', '-C', project, ...parameters], { env, windowsHide: true, encoding: 'utf8' });
assert.equal(git(['rev-parse', 'HEAD']).trim(), revision);
assert.ok(!/^(?:filter\.|include(?:if\..*)?\.)/im.test(git(['config', '--local', '--no-includes', '--list'])));
assert.equal(git(['status', '--porcelain=v1', '-z']), '', 'Use a clean dedicated acceptance checkout');
const profile = path.join(root, 'fixtures/dependency-profiles/tanstack-store');
const manifest = JSON.parse(readFileSync(path.join(profile, 'package.json'), 'utf8'));
const lock = readFileSync(path.join(profile, 'package-lock.json'));
const digest = createHash('sha256').update(lock).digest('hex');
const destination = path.join(project, 'node_modules'), receiptPath = path.join(destination, '.codetrail-declaration-profile.json');
function verifyDirectVersions() {
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    assert.equal(JSON.parse(readFileSync(path.join(destination, name, 'package.json'), 'utf8')).version, version, name);
  }
}
if (existsSync(destination)) {
  assert.ok(existsSync(receiptPath), 'Existing dependencies are preserved; choose another dedicated checkout');
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  assert.equal(receipt.lockSha256, digest, 'Existing profile differs; choose another dedicated checkout');
  verifyDirectVersions(); console.log(JSON.stringify({ reused: true, project, ...receipt }, null, 2));
} else {
  const parent = path.join(root, 'artifacts/dependency-entries'); mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, 'install-'));
  cpSync(path.join(profile, 'package.json'), path.join(staging, 'package.json'));
  cpSync(path.join(profile, 'package-lock.json'), path.join(staging, 'package-lock.json'));
  const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  assert.ok(existsSync(npm), 'Run this preparation with npm run prepare:external-deps');
  execFileSync(process.execPath, [npm, 'ci', '--ignore-scripts', '--legacy-peer-deps', '--omit=optional', '--no-audit', '--no-fund', '--cache', path.join(root, '.npm-cache')],
    { cwd: staging, windowsHide: true, stdio: 'inherit', timeout: 600000 });
  cpSync(path.join(staging, 'node_modules'), destination, { recursive: true, force: false, errorOnExist: true,
    filter: file => path.basename(file) !== '.bin' && !lstatSync(file).isSymbolicLink() });
  verifyDirectVersions();
  const receipt = { revision, lockSha256: digest, directDependencies: manifest.dependencies, scriptsExecuted: false, targetBuildExecuted: false,
    scope: 'Pinned declaration preparation profile; direct versions are from the target pnpm lock, transitive versions use the separately committed npm lock. Not a full upstream installation.' };
  writeFileSync(receiptPath, JSON.stringify(receipt, null, 2));
  assert.equal(git(['status', '--porcelain=v1', '-z']), '');
  console.log(JSON.stringify({ reused: false, project, staging, ...receipt }, null, 2));
}
