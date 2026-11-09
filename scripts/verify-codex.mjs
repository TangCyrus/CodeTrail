import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { root, prepareGitDemo } from "./acceptance-projects.mjs";
import { createCodexKit } from "./setup-codex.mjs";

const parent = path.join(root, "artifacts/agent-acceptance"); mkdirSync(parent, { recursive: true });
const run = mkdtempSync(path.join(parent, "codex-"));
const project = prepareGitDemo(path.join(run, "中文 项目"));
const kit = createCodexKit(project, path.join(run, "接入包"));
cpSync(path.join(kit.output, "skills"), path.join(project, ".agents/skills"), { recursive: true });
const codexHome = path.join(run, "isolated-codex-home"); mkdirSync(codexHome);
// This provider is never called. No turn is started and no account/credentials are loaded.
writeFileSync(path.join(codexHome, "config.toml"), `model_provider = "protocol_probe"\nmodel = "protocol-only-no-generation"\n[model_providers.protocol_probe]\nname = "Protocol-only acceptance"\nbase_url = "http://127.0.0.1:9/v1"\nwire_api = "responses"\n\n${kit.config}`);
const executable = process.env.CODETRAIL_CODEX_EXE ?? "codex";
const version = execFileSync(executable, ["--version"], { encoding: "utf8", windowsHide: true }).trim();
const hostEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|COMSPEC|PROCESSOR_ARCHITECTURE)$/i.test(key)));
const child = spawn(executable, ["app-server", "--stdio"], { cwd: project, env: { ...hostEnvironment, CODEX_HOME: codexHome }, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
let nextId = 1, stderr = "";
const pending = new Map(), calls = [];
child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  if (message.id !== undefined && !message.method) {
    const waiting = pending.get(message.id);
    if (waiting) { clearTimeout(waiting.timer); pending.delete(message.id); message.error ? waiting.reject(Error(JSON.stringify(message.error))) : waiting.resolve(message.result); }
  } else if (message.method && message.id !== undefined) {
    child.stdin.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Acceptance harness does not approve operations" } }) + "\n");
  }
});
child.once("error", (error) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error); } pending.clear(); });
child.once("exit", (code) => { for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error(`Codex exited (${code}): ${stderr.slice(-2000)}`)); } pending.clear(); });
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`Codex request timed out: ${method}; ${stderr.slice(-2000)}`)); }, 90_000);
    pending.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
}
let result;
try {
  const initialized = await request("initialize", { clientInfo: { name: "codetrail_acceptance", version: "0.11.0", title: "CodeTrail host acceptance" }, capabilities: { experimentalApi: true } });
  child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  const skills = await request("skills/list", { cwds: [project], forceReload: true });
  writeFileSync(path.join(run, "skills-discovery.json"), JSON.stringify(skills, null, 2));
  const skillNames = skills.data.flatMap((entry) => entry.skills.map((skill) => skill.name));
  assert.ok(skillNames.includes("codetrail-understand")); assert.ok(skillNames.includes("codetrail-impact"));
  assert.ok(skills.data.every((entry) => entry.errors.length === 0));
  assert.ok(skills.data.flatMap((entry) => entry.skills).filter((skill) => skill.name.startsWith("codetrail-")).every((skill) => skill.enabled));
  const thread = await request("thread/start", { cwd: project, ephemeral: true, approvalPolicy: "never", sandbox: "read-only" });
  const threadId = thread.thread.id;
  const inventory = await request("mcpServerStatus/list", { threadId, serverName: "codetrail" });
  writeFileSync(path.join(run, "host-inventory.json"), JSON.stringify(inventory, null, 2));
  const status = inventory.data.find((entry) => entry.name === "codetrail");
  assert.ok(status, "Codex must discover the codetrail server");
  assert.equal(status.runtimeStatus, "connected");
  const toolNames = Object.keys(status.tools).map((name) => name.replace(/^.*__/, "")).sort();
  assert.equal(toolNames.length, 6);
  async function call(tool, args = {}) {
    const started = performance.now();
    const response = await request("mcpServer/tool/call", { threadId, server: "codetrail", tool, arguments: args });
    assert.notEqual(response.isError, true, JSON.stringify(response));
    const data = response.structuredContent ?? JSON.parse(response.content[0].text);
    assert.equal(data.sourceTrust, "untrusted-repository-data");
    calls.push({ tool, args, elapsedMs: Math.round(performance.now() - started), result: data });
    return data;
  }
  const overview = await call("project_overview", { refresh: true });
  assert.equal(overview.project.rootDir, project);
  const search = await call("search_symbols", { snapshotId: overview.snapshotId, query: "submit" });
  const symbol = search.results.find((item) => item.name === "submit"); assert.ok(symbol);
  const context = await call("symbol_context", { snapshotId: overview.snapshotId, nodeId: symbol.id });
  const edge = context.edges.find((item) => item.kind === "CALLS"); assert.ok(edge);
  const proof = await call("read_evidence", { snapshotId: overview.snapshotId, evidenceId: edge.evidenceIds[0] });
  assert.equal(proof.matchesCurrentFile, true);
  const reading = await call("recommend_reading", { snapshotId: overview.snapshotId });
  assert.ok(reading.readingOrder.length > 0);
  const taskReading = await call("recommend_reading", { snapshotId: overview.snapshotId, focusNodeIds: [symbol.id] });
  assert.equal(taskReading.scope.mode, "focused"); assert.equal(taskReading.readingOrder[0].node.id, symbol.id);
  const comparison = await call("compare_worktree", { refresh: true, limit: 10 });
  assert.equal(comparison.baseline.state, "ready"); assert.equal(comparison.stale, false);
  assert.equal(comparison.baselineDependencies.policy,"matched-local-declarations");
  assert.ok(Number.isInteger(comparison.baselineDependencies.copiedFiles));
  const candidates = await call("compare_worktree", { comparisonId:comparison.comparisonId, symbolQuery:"amount", symbolSide:"current",limit:5 });
  const candidate = candidates.symbols.find(item=>item.node.name==="amount");assert.ok(candidate);
  const focused = await call("compare_worktree", { comparisonId:comparison.comparisonId, focus:{side:"current",nodeId:candidate.node.id},limit:5 });
  assert.equal(focused.focus.nodeId,candidate.node.id);assert.deepEqual(focused.snapshotIds,comparison.snapshotIds);
  assert.ok(focused.paths.length>0&&focused.paths.every(item=>item.side==="current"));
  const oldPath = comparison.paths.find((item) => item.side === "base"); assert.ok(oldPath);
  const oldProof = await call("read_evidence", { comparisonId: comparison.comparisonId, side: "base", evidenceId: oldPath.steps[0].evidenceId });
  assert.equal(oldProof.snapshotId, comparison.snapshotIds.base);
  const file = path.join(project, "src/order.ts");
  writeFileSync(file, readFileSync(file, "utf8") + "\n// Acceptance harness edit after first comparison.\n");
  const stale = await call("compare_worktree", { comparisonId: comparison.comparisonId });
  assert.equal(stale.stale, true);
  const refreshed = await call("compare_worktree", { refresh: true });
  assert.equal(refreshed.stale, false); assert.notEqual(refreshed.comparisonId, comparison.comparisonId);
  result = { passed: true, host: version, run, project, serverVersion: status.serverInfo?.version ?? null,
    discoveredSkills: skillNames.filter((name) => name.startsWith("codetrail-")), tools: toolNames,
    toolCalls: calls.length, maxResultCharacters: Math.max(...calls.map((call) => JSON.stringify(call.result).length)), modelTurns: 0, modelCalls: 0, userConfigurationModified: false,
    validation: "Actual Codex app-server discovery and tool invocation; deterministic harness chooses calls. This does not evaluate model tool selection or explanation quality.",
    checks: ["skill discovery", "stdio server discovery", "architecture/search/context/source/reading", "HEAD comparison with base evidence", "symbol search and same-side focused paths", "edit staleness and explicit refresh"] };
  writeFileSync(path.join(run, "tool-calls.json"), JSON.stringify(calls, null, 2));
  await request("thread/unsubscribe", { threadId });
} catch (error) {
  result = { passed: false, run, error: error.message };
  process.exitCode = 1;
} finally {
  const exited = new Promise((resolve) => child.once("exit", resolve));
  child.stdin.end();
  await Promise.race([exited, delay(4000)]);
  if (child.exitCode === null) child.kill();
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error("Host stopped")); } pending.clear();
  // The host's MCP descendants can briefly retain inherited pipe handles on
  // Windows. The probe is finished; release our readers instead of hanging.
  lines.close(); child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy();
  writeFileSync(path.join(run, "host-stderr.txt"), stderr);
  writeFileSync(path.join(parent, "codex-acceptance.json"), JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}
