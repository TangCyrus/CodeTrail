import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import path from "node:path";
import ignore, { type Ignore } from "ignore";
import type { AnalysisDiagnostic, AnalyzeRequest, SkippedPath } from "@codegraph/shared";

export const slash = (value: string): string => value.replaceAll("\\", "/");
export const hash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

const SOURCE = /\.(?:ts|tsx|js|jsx)$/i;
const HARD_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", ".npm-cache", ".codegraph"]);
interface IgnoreLayer { base: string; matcher: Ignore }
export interface ScannedFile { absolutePath: string; path: string; text: string; hash: string; bytes: number }
export interface ScanResult {
  root: string;
  files: Map<string, ScannedFile>;
  skipped: SkippedPath[];
  diagnostics: AnalysisDiagnostic[];
  configTexts: Map<string, string>;
  /** All excluded paths, including directories, deny compiler fallback reads. */
  excluded: Set<string>;
}

export function scanProject(request: AnalyzeRequest): ScanResult {
  const root = realpathSync(path.resolve(request.rootDir));
  if (!lstatSync(root).isDirectory()) throw new Error("Project root must be a directory");
  const maxFiles = request.maxFiles ?? 500;
  const maxBytes = request.maxFileBytes ?? 1024 * 1024;
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("Analysis limits must be positive integers");
  }
  const result: ScanResult = { root, files: new Map(), skipped: [], diagnostics: [], configTexts: new Map(), excluded: new Set() };
  function skip(absolute: string, reason: SkippedPath["reason"]): void {
    result.excluded.add(absolute);
    result.skipped.push({ path: slash(path.relative(root, absolute)), reason });
    if (reason !== "ignored" && reason !== "symlink") {
      result.diagnostics.push({ code: `SCAN_${reason.toUpperCase().replaceAll("-", "_")}`, severity: "warning", message: reason === "encoding" ? "源码不是有效 UTF-8 编码；已跳过该文件，其他源码继续分析。" : `Path skipped: ${reason}`, path: slash(path.relative(root, absolute)) });
    }
  }
  function walk(directory: string, inherited: IgnoreLayer[]): void {
    const layers = [...inherited];
    for (const name of directory === root ? [".gitignore", ".codegraphignore"] : [".gitignore"]) {
      const ignorePath = path.join(directory, name);
      try {
        const info = lstatSync(ignorePath);
        if (!info.isFile() || info.isSymbolicLink()) continue;
        const text = readFileSync(ignorePath, "utf8");
        result.configTexts.set(ignorePath, text);
        layers.push({ base: directory, matcher: ignore().add(text) });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") skip(ignorePath, "unreadable");
      }
    }
    let entries;
    try { entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name, "en")); }
    catch { skip(directory, "unreadable"); return; }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) { skip(absolute, "symlink"); continue; }
      if ((entry.isDirectory() && HARD_DIRS.has(entry.name)) || /^\.env(?:\.|$)/.test(entry.name)) {
        skip(absolute, "ignored"); continue;
      }
      let ignored = false;
      for (const layer of layers) {
        const relative = slash(path.relative(layer.base, absolute)) + (entry.isDirectory() ? "/" : "");
        const verdict = layer.matcher.test(relative);
        if (verdict.ignored) ignored = true;
        if (verdict.unignored) ignored = false;
      }
      if (ignored) { skip(absolute, "ignored"); continue; }
      if (entry.isDirectory()) { walk(absolute, layers); continue; }
      if (!entry.isFile() || !SOURCE.test(entry.name)) continue;
      if (result.files.size >= maxFiles) { skip(absolute, "file-limit"); continue; }
      try {
        const info = lstatSync(absolute);
        if (info.size > maxBytes) { skip(absolute, "size-limit"); continue; }
        const bytes = readFileSync(absolute);
        try { new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
        catch { skip(absolute, "encoding"); continue; }
        result.files.set(absolute, { absolutePath: absolute, path: slash(path.relative(root, absolute)), text: bytes.toString("utf8"), hash: hash(bytes), bytes: bytes.length });
      } catch { skip(absolute, "unreadable"); }
    }
  }
  walk(root, []);
  return result;
}
