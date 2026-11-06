import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { root } from "./acceptance-projects.mjs";

if (process.platform !== "win32") throw Error("The current release builder is validated on Windows only.");
const execute = promisify(execFile), sourceManifest = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const releases = path.join(root, "artifacts/releases"); mkdirSync(releases, { recursive: true });
const run = mkdtempSync(path.join(releases, "build-")), install = path.join(run, "install"); mkdirSync(install);
const workspaces = ["apps/local", "apps/web", "packages/shared", "packages/analyzer", "packages/graph"];
for (const name of ["package.json", "package-lock.json"]) cpSync(path.join(root, name), path.join(install, name));
for (const workspace of workspaces) {
  if (!existsSync(path.join(root, workspace, "dist"))) throw Error("Run npm run build before packaging.");
  mkdirSync(path.join(install, workspace), { recursive: true });
  cpSync(path.join(root, workspace, "package.json"), path.join(install, workspace, "package.json"));
  cpSync(path.join(root, workspace, "dist"), path.join(install, workspace, "dist"), { recursive: true });
}
const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), "node_modules/npm/bin/npm-cli.js");
if (!existsSync(npm)) throw Error("npm CLI was not found; run this builder using npm run release.");
process.stdout.write("Installing locked production dependencies into an isolated staging directory…\n");
await execute(process.execPath, [npm, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", ...(process.argv.includes("--online") ? [] : ["--offline"]), "--cache", path.join(root, ".npm-cache")], { cwd: install, windowsHide: true, timeout: 180_000, maxBuffer: 2 * 1024 * 1024 });
const name = `codetrail-mvp-${sourceManifest.version}-win32-${process.arch}`, bundle = path.join(run, name); mkdirSync(bundle);
const allow = (source) => ![".git", ".npmrc"].includes(path.basename(source)) && !/^\.env(?:\.|$)/i.test(path.basename(source));
for (const workspace of workspaces) cpSync(path.join(install, workspace), path.join(bundle, workspace), { recursive: true, dereference: true, filter: allow });
// npm's workspace junctions must become ordinary directories before the archive is relocated.
cpSync(path.join(install, "node_modules"), path.join(bundle, "node_modules"), { recursive: true, dereference: true, filter: allow });
cpSync(path.join(root, "examples"), path.join(bundle, "examples"), { recursive: true, filter: allow });
mkdirSync(path.join(bundle, "scripts"));
for (const file of ["prepare-demo.mjs", "acceptance-projects.mjs", "setup-codex.mjs"]) cpSync(path.join(root, "scripts", file), path.join(bundle, "scripts", file));
cpSync(path.join(root, "skills"), path.join(bundle, "skills"), { recursive: true, filter: allow });
mkdirSync(path.join(bundle, "docs"));
for (const file of ["MVP安装说明.md", "Agent接入说明.md", "命名迁移说明.md", "已知限制.md", "用户试用方案.md", "用户试用记录模板.csv", "AI解释评测样本.json"]) {
  if (!existsSync(path.join(root, "docs", file))) throw Error(`Missing release document: ${file}`);
  cpSync(path.join(root, "docs", file), path.join(bundle, "docs", file));
}
writeFileSync(path.join(bundle, "package.json"), JSON.stringify({ name: "codetrail-mvp", version: sourceManifest.version, private: true, type: "module", engines: sourceManifest.engines,
  scripts: { open: "node apps/local/dist/cli.js open", analyze: "node apps/local/dist/cli.js analyze", mcp: "node apps/local/dist/cli.js mcp", "setup:codex": "node scripts/setup-codex.mjs", "demo:git": "node scripts/prepare-demo.mjs" } }, null, 2));
writeFileSync(path.join(bundle, "codetrail.cmd"), '@echo off\r\nnode "%~dp0apps\\local\\dist\\cli.js" %*\r\nexit /b %errorlevel%\r\n');
writeFileSync(path.join(bundle, "README.txt"), `CodeTrail ${sourceManifest.version} — local MCP + Skills + evidence workbench\r\nRequires Node.js 24.x; Git is optional for browsing and required for HEAD comparisons.\r\nAgent setup: node scripts/setup-codex.mjs "D:/your-project" --out "D:/codetrail-kit"\r\nWorkbench: codetrail.cmd open "D:/your-project"\r\nGit demo: node scripts/prepare-demo.mjs\r\nNo npm install or build is needed for this prebuilt bundle.\r\nSee docs/Agent接入说明.md, docs/MVP安装说明.md and docs/已知限制.md.\r\n`);
const files = [];
function walk(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), info = lstatSync(file);
    if (info.isSymbolicLink()) throw Error(`Release contains a link: ${file}`);
    if (entry.isDirectory()) walk(file);
    else if (entry.isFile()) files.push({ path: path.relative(bundle, file).replaceAll("\\", "/"), bytes: info.size, sha256: createHash("sha256").update(readFileSync(file)).digest("hex") });
    else throw Error("Unsupported release file kind");
  }
}
walk(bundle);
const manifest = { name, version: sourceManifest.version, generatedAt: new Date().toISOString(), node: process.version, platform: process.platform, architecture: process.arch, dependencies: "npm ci --omit=dev --ignore-scripts from the source lockfile; workspace links materialized", sourceLockSha256: createHash("sha256").update(readFileSync(path.join(root, "package-lock.json"))).digest("hex"), files };
writeFileSync(path.join(bundle, "release-manifest.json"), JSON.stringify(manifest, null, 2));
const archive = path.join(run, `${name}.zip`);
await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", path.join(root, "scripts/zip-release.ps1"), bundle, archive], { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
const result = { name, version: sourceManifest.version, archive, bundle, bytes: lstatSync(archive).size, sha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), files: files.length };
writeFileSync(path.join(releases, "latest.json"), JSON.stringify(result, null, 2));
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
