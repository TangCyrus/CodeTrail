import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseAllDocuments } from "yaml";
import type { AnalysisSnapshot, BaselineDependencyEnvironment } from "@codetrail/shared";
import { sha } from "./git.js";

type Input = { path: string; hash: string };
export interface BaselineDependencies { summary: BaselineDependencyEnvironment; inputs: Input[]; missingInputs: string[] }
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue => !!value && typeof value === "object" && !Array.isArray(value);
const slash = (value: string) => value.replaceAll("\\", "/");
const inside = (root: string, target: string) => { const relative = path.relative(root, target); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
const equalPath = (a: string, b: string) => process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
const rejectionCodes = new Set(["path", "linked-path", "input-budget", "metadata", "package-identity", "lock-identity", "changed-input", "copy-budget", "destination-conflict", "encoding"]);
const safePath = (root: string, relative: string): string => {
  if (!relative || path.isAbsolute(relative) || relative.includes("\\") || relative.split("/").some(part => !part || part === "." || part === ".." || /[:\x00-\x1f]/.test(part))) throw Error("path");
  const file = path.resolve(root, relative);
  if (!inside(root, file) || !equalPath(file, realpathSync(file)) || lstatSync(file).isSymbolicLink()) throw Error("linked-path");
  return file;
};
const json = (bytes: Buffer): RecordValue => { const value: unknown = JSON.parse(bytes.toString("utf8")); if (!record(value)) throw Error("metadata"); return value; };

/** Capture only already-read local declarations/JSON whose package identity matches both locks.
 * This is not installation, archive-integrity verification, or a reconstruction of historical node_modules.
 */
export function prepareBaselineDependencies(root: string, destination: string, current: AnalysisSnapshot,
  budget = { maxFiles: 4096, maxBytes: 32 * 1024 * 1024, maxFileBytes: 1024 * 1024 }): BaselineDependencies {
  const inputs = new Map<string, string>(), missingInputs = new Set<string>(), reasons = new Map<string, number>();
  const copied = new Map<string, string>(), packages = new Set<string>(); let bytes = 0, skipped = 0;
  const skippedPackages: { name: string; reason: string }[] = []; let skippedPackageCount = 0;
  const reject = (code: string, count = 1) => { reasons.set(code, (reasons.get(code) ?? 0) + count); skipped += count; };
  const read = (relative: string, limit = budget.maxFileBytes): Buffer => {
    const file = safePath(root, relative), info = lstatSync(file);
    if (!info.isFile() || info.size > limit) throw Error("input-budget");
    const data = readFileSync(file); if (data.length > limit) throw Error("input-budget");
    inputs.set(relative, sha(data)); return data;
  };
  const groups = new Map<string, Input[]>();
  const sourcePaths = new Set(current.files.map(file => file.path));
  for (const input of current.configuration.inputs ?? []) {
    const parts = input.path.split("/"), index = parts.lastIndexOf("node_modules");
    if (index < 0) { if (/\.d\.[cm]?ts$/i.test(input.path) && !sourcePaths.has(input.path)) reject("linked-layout"); continue; }
    if (parts.includes(".pnpm")) { reject("linked-layout", 1); continue; }
    const length = parts[index + 1]?.startsWith("@") ? index + 3 : index + 2;
    if (parts.length < length || parts.slice(index + 1, length).some(part => !part || part.startsWith("."))) { reject("package-path"); continue; }
    if (!/\.d\.[cm]?ts$|\.json$/i.test(input.path)) { reject("non-declaration"); continue; }
    const key = parts.slice(0, length).join("/"), list = groups.get(key);
    if (list) list.push(input); else groups.set(key, [input]);
  }
  // Parse each lock once. Both copies are plain bounded metadata, never executed.
  const lockCache = new Map<string, { head: RecordValue; local: RecordValue; kind: "npm" | "pnpm" } | null>();
  const lock = (relative: string, kind: "npm" | "pnpm") => {
    if (lockCache.has(relative)) return lockCache.get(relative);
    let result: { head: RecordValue; local: RecordValue; kind: "npm" | "pnpm" } | null = null;
    try {
      if (!existsSync(path.join(root, relative))) missingInputs.add(relative);
      const localBytes = read(relative), headFile = safePath(destination, relative), info = lstatSync(headFile);
      if (!info.isFile() || info.size > budget.maxFileBytes) throw Error("lock-budget");
      const headBytes = readFileSync(headFile);
      const parse = (data: Buffer): RecordValue => {
        if (kind === "npm") return json(data);
        const documents = parseAllDocuments(data.toString("utf8"), { uniqueKeys: true });
        if (!documents.length || documents.length > 8) throw Error("lock-format");
        const entries = new Map<string, unknown>();
        for (const document of documents) {
          if (document.errors.length) throw Error("lock-format");
          const value: unknown = document.toJS({ maxAliasCount: 0 });
          if (!record(value) || Number(value.lockfileVersion) !== 9 || !record(value.packages)) throw Error("lock-format");
          for (const [key, item] of Object.entries(value.packages)) entries.set(key, entries.has(key) ? null : item);
        }
        // pnpm's manager/workspace documents are separate inventories. Duplicate
        // keys are ambiguous even when their text happens to match.
        return { lockfileVersion: 9, packages: Object.fromEntries(entries) };
      };
      const head = parse(headBytes), local = parse(localBytes);
      if (kind === "npm" ? ![2, 3].includes(Number(head.lockfileVersion)) || ![2, 3].includes(Number(local.lockfileVersion))
        : Number(head.lockfileVersion) !== 9 || Number(local.lockfileVersion) !== 9) throw Error("lock-version");
      copied.set(`HEAD:${relative}`, sha(headBytes)); result = { head, local, kind };
    } catch { /* A missing, changed, linked or unsupported lock never permits a guessed reuse. */ }
    lockCache.set(relative, result); return result;
  };
  const identity = (data: RecordValue, key: string, kind: "npm" | "pnpm"): string | undefined => {
    if (!record(data.packages)) return;
    const item = data.packages[key]; if (!record(item) || item.link) return;
    if (kind === "npm") return typeof item.version === "string" && typeof item.integrity === "string" && item.integrity
      ? JSON.stringify([item.version, item.integrity, item.resolved ?? null]) : undefined;
    const resolution = item.resolution; return record(resolution) && typeof resolution.integrity === "string" && resolution.integrity ? resolution.integrity : undefined;
  };
  for (const [packageRoot, captured] of [...groups].sort(([a], [b]) => a.localeCompare(b, "en"))) {
    const manifestPath = `${packageRoot}/package.json`;
    let exposing = false, label = packageRoot;
    try {
      const manifestBytes = read(manifestPath), manifest = json(manifestBytes);
      const suffix = packageRoot.split("/node_modules/").at(-1)!.replace(/^node_modules\//, "");
      if (manifest.name !== suffix || typeof manifest.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(manifest.version)) throw Error("package-identity");
      label = `${suffix}@${manifest.version}`;
      const components = packageRoot.split("/"), firstModules = components.indexOf("node_modules");
      let owner = firstModules ? components.slice(0, firstModules).join("/") + "/" : ""; let matched = false;
      for (;;) {
        for (const [filename, kind] of [["package-lock.json", "npm"], ["pnpm-lock.yaml", "pnpm"]] as const) {
          const lockPath = owner + filename, parsed = lock(lockPath, kind); if (!parsed) continue;
          const key: string = kind === "npm" ? packageRoot.slice(owner.length) : `${suffix}@${manifest.version}`;
          const headId = identity(parsed.head, key, kind), localId = identity(parsed.local, key, kind);
          const entry: unknown = record(parsed.head.packages) ? parsed.head.packages[key] : undefined;
          if (headId && headId === localId && (kind === "pnpm" || record(entry) && entry.version === manifest.version)) { matched = true; break; }
        }
        if (matched || !owner) break;
        const parent = slash(path.dirname(owner.slice(0, -1))); owner = parent === "." ? "" : parent + "/";
      }
      if (!matched) throw Error("lock-identity");
      const files = new Map(captured.map(input => [input.path, input.hash]));
      const capturedManifest = files.get(manifestPath);
      if (capturedManifest && capturedManifest !== sha(manifestBytes)) throw Error("changed-input");
      files.set(manifestPath, sha(manifestBytes));
      if (copied.size + files.size > budget.maxFiles) throw Error("copy-budget");
      // Validate the whole package subset before exposing any of it to the baseline compiler.
      const pending: { relative: string; data: Buffer }[] = []; let size = 0;
      for (const [relative, expected] of [...files].sort(([a], [b]) => a.localeCompare(b, "en"))) {
        const data = read(relative);
        if (sha(data) !== expected) throw Error("changed-input");
        try { new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw Error("encoding"); }
        size += data.length; if (bytes + size > budget.maxBytes) throw Error("copy-budget");
        pending.push({ relative, data });
      }
      if (copied.size + pending.length > budget.maxFiles || bytes + size > budget.maxBytes) throw Error("copy-budget");
      if (pending.some(item => !inside(destination, path.resolve(destination, item.relative)) || existsSync(path.resolve(destination, item.relative)))) throw Error("destination-conflict");
      exposing = true;
      for (const { relative, data } of pending) {
        const target = path.resolve(destination, relative);
        if (!inside(destination, target) || existsSync(target)) throw Error("destination-conflict");
        mkdirSync(path.dirname(target), { recursive: true }); writeFileSync(target, data, { flag: "wx" }); copied.set(relative, sha(data)); bytes += data.length;
      }
      packages.add(packageRoot);
    } catch (error) {
      if (exposing) throw new Error("基线声明写入失败，未发布本次比较。");
      const code = error instanceof Error && rejectionCodes.has(error.message) ? error.message : "unreadable";
      reject(code, captured.length); skippedPackageCount++;
      if (skippedPackages.length < 8) skippedPackages.push({ name: label.slice(0, 256), reason: code });
    }
  }
  const files = [...copied].filter(([name]) => !name.startsWith("HEAD:"));
  const summary: BaselineDependencyEnvironment = { policy: "matched-local-declarations", state: !groups.size && !skipped ? "not-captured" : !files.length ? "unavailable" : skipped ? "partial" : "available",
    copiedFiles: files.length, copiedBytes: bytes, copiedPackages: packages.size, skippedFiles: skipped, reasons: [...reasons].map(([code, count]) => ({ code, count })),
    skippedPackages, omittedSkippedPackages: Math.max(0, skippedPackageCount - skippedPackages.length),
    identity: sha(JSON.stringify([...copied].sort())),
    notice: "仅复用当前分析读到、包版本与旧新锁文件身份匹配、捕获哈希一致的本地声明和 JSON；不是历史依赖安装或压缩包完整性验证。旧版独有依赖、链接布局及未支持锁文件仍可能缺失，必须分别核对两侧诊断。" };
  return { summary, inputs: [...inputs].map(([path, hash]) => ({ path, hash })), missingInputs: [...missingInputs] };
}

export function baselineDependencyInputsStale(root: string, inputs: Input[] = [], missingInputs: string[] = []): boolean {
  try {
    for (const input of inputs) { const file = safePath(root, input.path); if (lstatSync(file).size > 1024 * 1024 || sha(readFileSync(file)) !== input.hash) return true; }
    return missingInputs.some(relative => { const file = path.resolve(root, relative); return !inside(root, file) || existsSync(file); });
  } catch { return true; }
}
