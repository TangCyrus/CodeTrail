import assert from "node:assert/strict";
import { execFile, fork } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { root } from "./acceptance-projects.mjs";

const execute = promisify(execFile), latest = JSON.parse(readFileSync(path.join(root, "artifacts/releases/latest.json"), "utf8"));
const output = path.join(root, "artifacts/releases/verification"); mkdirSync(output, { recursive: true });
assert.equal(createHash("sha256").update(readFileSync(latest.archive)).digest("hex"), latest.sha256);
const verification = mkdtempSync(path.join(os.tmpdir(), "codetrail-release-")), extracted = path.join(verification, "中文 安装验证"); mkdirSync(extracted);
assert.ok(!path.resolve(extracted).startsWith(path.resolve(root) + path.sep));
const isolatedEnv = { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" };
const listing = (await execute("tar.exe", ["-tf", latest.archive], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 })).stdout.trim().split(/\r?\n/);
assert.ok(listing.every((name) => name.startsWith(latest.name + "/") && !name.split("/").includes("..") && !path.isAbsolute(name)));
await execute("tar.exe", ["-xf", latest.archive, "-C", extracted], { windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024 });
const bundle = path.join(extracted, latest.name), manifest = JSON.parse(readFileSync(path.join(bundle, "release-manifest.json"), "utf8"));
for (const file of manifest.files) {
  const target = path.resolve(bundle, file.path); assert.ok(target.startsWith(bundle + path.sep));
  assert.equal(lstatSync(target).isSymbolicLink(), false);
  assert.equal(createHash("sha256").update(readFileSync(target)).digest("hex"), file.sha256, file.path);
}
assert.ok(!manifest.files.some((file) => file.path.split("/").includes("artifacts") || file.path.split("/").includes(".git") || /(?:^|\/)\.env(?:\.|$)/.test(file.path) || file.path.endsWith(".sqlite")));
const cli = path.join(bundle, "apps/local/dist/cli.js");
const analyzed = JSON.parse((await execute(process.execPath, [cli, "analyze", path.join(bundle, "examples/react-checkout")], { cwd: verification, env: isolatedEnv, windowsHide: true, timeout: 30_000, maxBuffer: 8 * 1024 * 1024 })).stdout);
assert.equal(analyzed.status, "complete"); assert.ok(analyzed.relations.some((edge) => edge.kind === "RENDERS"));
const launcher = path.join(verification, "launcher-check.ps1"); writeFileSync(launcher, 'param([string]$Launcher)\n& $Launcher --help\nexit $LASTEXITCODE\n');
assert.match((await execute("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", launcher, path.join(bundle, "codetrail.cmd")], { cwd: verification, env: isolatedEnv, windowsHide: true, timeout: 10_000 })).stdout, /CodeTrail/);
const demoOutput = (await execute(process.execPath, [path.join(bundle, "scripts/prepare-demo.mjs"), "--json"], { cwd: verification, env: isolatedEnv, windowsHide: true, timeout: 15_000 })).stdout;
const project = JSON.parse(demoOutput).directory;
assert.ok(project.startsWith(bundle + path.sep));
const mcpClient = new Client({ name: "relocated-release", version: "1" });
let mcpTools;
try {
  await mcpClient.connect(new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", project, "--data-dir", path.join(verification, "mcp-cache")], cwd: verification, env: isolatedEnv, stderr: "pipe" }));
  mcpTools = (await mcpClient.listTools()).tools.map((tool) => tool.name); assert.equal(mcpTools.length, 6);
  const call = async (name, args = {}) => { const result = await mcpClient.callTool({ name, arguments: args }); assert.notEqual(result.isError, true); return result.structuredContent; };
  const overview = await call("project_overview"); assert.ok(overview.statistics.files);
  const search = await call("search_symbols", { snapshotId: overview.snapshotId, query: "submit" });
  const node = search.results.find((item) => item.name === "submit"); assert.ok(node);
  const source = await call("read_evidence", { snapshotId: overview.snapshotId, nodeId: node.id }); assert.equal(source.matchesCurrentFile, true);
  const impact = await call("compare_worktree"); assert.equal(impact.baseline.state, "ready"); assert.ok(impact.totals.paths > 0);
  const symbols = await call("compare_worktree",{comparisonId:impact.comparisonId,symbolQuery:"amount",symbolSide:"current",limit:5});
  const symbol = symbols.symbols.find(item=>item.node.name==="amount");assert.ok(symbol);
  const focused = await call("compare_worktree",{comparisonId:impact.comparisonId,focus:{side:"current",nodeId:symbol.node.id},limit:5});
  assert.ok(focused.paths.length>0&&focused.paths.every(item=>item.side==="current"));assert.deepEqual(focused.snapshotIds,impact.snapshotIds);
  assert.equal(focused.focus.nodeId,symbol.node.id);assert.ok(focused.truncation);
  const kitDirectory = path.join(verification, "接入包");
  await execute(process.execPath, [path.join(bundle, "scripts/setup-codex.mjs"), project, "--out", kitDirectory], { cwd: verification, env: isolatedEnv, windowsHide: true, timeout: 10_000 });
  assert.ok(readFileSync(path.join(kitDirectory, "config.toml"), "utf8").includes(JSON.stringify(cli)));
  assert.ok(existsSync(path.join(kitDirectory, "skills/codetrail-understand/SKILL.md")));
} finally { await mcpClient.close(); }
const child = fork(path.join(root, "scripts/release-smoke-server.mjs"), [bundle, project, path.join(verification, "cache")], { cwd: verification, env: isolatedEnv, windowsHide: true, execArgv: [], stdio: ["ignore", "ignore", "pipe", "ipc"] });
let browser;
try {
  const url = await new Promise((resolve, reject) => { const timeout = setTimeout(() => reject(Error("Packaged server startup timed out")), 15_000); child.once("message", (message) => { clearTimeout(timeout); resolve(new URL(message.url)); }); child.once("error", reject); child.once("exit", (code) => { if (code) reject(Error("Packaged server exited")); }); });
  const token = new URLSearchParams(url.hash.slice(1)).get("session");
  const request = async (route, body) => {
    const response = await fetch(`${url.origin}/api${route}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert.ok(response.ok); return response.json();
  };
  let session;
  for (let index = 0; index < 300; index++) { session = await request("/session"); if (session.latestSnapshotId && session.job.status !== "running") break; await delay(25); }
  assert.ok(session.latestSnapshotId);
  const overview = await request(`/snapshots/${encodeURIComponent(session.latestSnapshotId)}/overview`); assert.ok(overview.statistics.files);
  const job = await request("/comparisons", {}); let comparison;
  for (let index = 0; index < 400; index++) { comparison = await request(`/comparison-jobs/${job.id}`); if (comparison.status !== "running") break; await delay(25); }
  assert.equal(comparison.status, "completed", comparison.error);
  const impact = await request(`/comparisons/${encodeURIComponent(comparison.comparisonId)}/impact`); assert.ok(impact.paths.some((item) => item.side === "base" && item.seed.name === "legacyDiscount"));
  browser = await chromium.launch({ channel: process.env.CODETRAIL_BROWSER_CHANNEL ?? "chrome", headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, locale: "zh-CN" }); const errors = [], external = [];
  page.on("pageerror", (error) => errors.push(error.message)); page.on("request", (request) => { if (new URL(request.url()).origin !== url.origin) external.push(request.url()); });
  await page.goto(url.href); await page.locator(".graph-card").first().waitFor();
  await page.getByRole("button", { name: "改动影响", exact: true }).first().click(); await page.locator(".file-change").first().waitFor();
  await page.getByRole("tab", { name: "关联路径", exact: true }).click();
  await page.getByRole("button", { name: "查看 旧版 legacyOrder 到 legacyDiscount 的调用证据", exact: true }).first().click();
  await page.locator(".source-line.highlighted").waitFor();
  assert.match(await page.locator(".source-code").innerText(), /legacyDiscount/);
  await page.screenshot({ path: path.join(output, "packaged-mvp-1440.png") });
  assert.deepEqual(errors, []); assert.deepEqual(external, []);
  const result = { generatedAt: new Date().toISOString(), passed: true, archiveSha256: latest.sha256, verifiedFiles: manifest.files.length, relocatedDirectory: extracted, relocatedOutsideSourceCheckout: true, nodePathCleared: true, noInstallOrBuildInExtractedBundle: true, cliAndWindowsLauncher: true, mcp: { passed: true, tools: mcpTools, sourceAndImpact: true, setupKit: true }, gitDemoAndComparison: impact.statistics, browser: { passed: true, externalRequests: external.length } };
  writeFileSync(path.join(output, "release-smoke.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
} finally {
  await browser?.close();
  if (child.connected) { const ended = new Promise((resolve) => child.once("exit", resolve)); child.send("close"); await Promise.race([ended, delay(5000)]); }
  if (child.exitCode === null) child.kill();
}
