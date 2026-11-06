#!/usr/bin/env node
import { mkdirSync, renameSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { analyzeProject } from "@codetrail/analyzer";

const HELP = `CodeTrail — local code explorer

Usage: codetrail analyze <directory> [--out <snapshot.json>] [--max-files <count>]
       codetrail open <directory> [--port <port>] [--data-dir <cache-directory>] [--no-browser]
       codetrail mcp <directory> [--data-dir <cache-directory>] [--workbench]

Without --out, writes the snapshot JSON to stdout. Summary goes to stderr.
open serves the browser workbench on 127.0.0.1. Analysis never executes project code or uses AI.
`;

async function main(args: string[]): Promise<void> {
  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") { process.stdout.write(HELP); return; }
  const [command, directory, ...rest] = args;
  if (command === "mcp" && directory && !directory.startsWith("--")) {
    let dataDirectory: string | undefined;
    let workbench = false;
    const seen = new Set<string>();
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index]!;
      if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      seen.add(flag);
      if (flag === "--workbench") workbench = true;
      else if (flag === "--data-dir" && rest[index + 1] && !rest[index + 1]!.startsWith("--")) dataDirectory = path.resolve(rest[++index]!);
      else throw new Error(`Invalid MCP option: ${flag}`);
    }
    const { runMcp } = await import("./mcp.js");
    await runMcp({ rootDir: directory, workbench, ...(dataDirectory ? { dataDirectory } : {}) });
    return;
  }
  if (command === "open" && directory && !directory.startsWith("--")) {
    let port = 4317;
    let dataDirectory: string | undefined;
    let noBrowser = false;
    const flags = new Set<string>();
    for (let index = 0; index < rest.length; index++) {
      const flag = rest[index]!;
      if (flags.has(flag)) throw new Error(`Duplicate option: ${flag}`);
      flags.add(flag);
      if (flag === "--no-browser") { noBrowser = true; continue; }
      const value = rest[++index];
      if (!value || value.startsWith("--")) throw new Error(`Missing option value: ${flag}`);
      if (flag === "--port") {
        port = Number(value);
        if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Port must be between 0 and 65535");
      } else if (flag === "--data-dir") dataDirectory = path.resolve(value);
      else throw new Error(`Unknown option: ${flag}`);
    }
    const { createLocalServer } = await import("./server.js");
    const server = await createLocalServer({ rootDir: directory, ...(dataDirectory ? { dataDirectory } : {}) });
    let url: string;
    try { url = await server.listen(port); }
    catch (error) { await server.app.close(); throw error; }
    process.stdout.write(`CodeTrail 本地工作台\n项目：${server.manager.rootDir}\n${url}\n按 Ctrl+C 停止服务。\n`);
    const stop = (): void => { void server.app.close().then(() => { process.exitCode = 0; }); };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    if (!noBrowser) {
      const [executable, arguments_] = process.platform === "win32" ? ["rundll32.exe", ["url.dll,FileProtocolHandler", url]]
        : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      const browser = spawn(executable!, arguments_!, { detached: true, stdio: "ignore", windowsHide: true });
      browser.on("error", () => { process.stderr.write("浏览器未能自动打开，请使用上面的完整链接。\n"); });
      browser.unref();
    }
    return;
  }
  if (command !== "analyze" || !directory || directory.startsWith("--")) throw new Error(HELP);
  let output: string | undefined;
  let maxFiles = 500;
  const seen = new Set<string>();
  for (let index = 0; index < rest.length; index += 2) {
    const option = rest[index]!;
    const value = rest[index + 1];
    if (seen.has(option) || !value || value.startsWith("--")) throw new Error(`Invalid option: ${option}`);
    seen.add(option);
    if (option === "--out") output = value;
    else if (option === "--max-files") {
      maxFiles = Number(value);
      if (!Number.isSafeInteger(maxFiles) || maxFiles < 1) throw new Error("--max-files must be a positive integer");
    } else throw new Error(`Unknown option: ${option}`);
  }
  const snapshot = analyzeProject({ rootDir: directory, maxFiles });
  const json = JSON.stringify(snapshot, null, 2) + "\n";
  if (output) {
    const destination = path.resolve(output);
    mkdirSync(path.dirname(destination), { recursive: true });
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, json, { encoding: "utf8", flag: "wx" });
      renameSync(temporary, destination);
    } catch (error) {
      try { unlinkSync(temporary); } catch { /* Nothing published; preserve original error. */ }
      throw error;
    }
  } else process.stdout.write(json);
  const stats = snapshot.statistics;
  process.stderr.write(`[${snapshot.status}] ${stats.files} files, ${stats.symbols} symbols, ${stats.relations} relations, ${stats.unresolved} unresolved, ${snapshot.diagnostics.length} diagnostics (${stats.durationMs} ms)\n`);
  if (output) process.stderr.write(`Snapshot: ${path.resolve(output)}\n`);
}

void main(process.argv.slice(2)).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Analysis failed"}\n`);
  process.exitCode = 1;
});
