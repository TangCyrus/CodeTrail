import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { GitBaseline } from "@codegraph/shared";

export interface GitTreeEntry { path: string; oid: string; bytes: number; mode: string }
export interface GitInspection extends GitBaseline {
  repository: string;
  entries: GitTreeEntry[];
  renames: { oldPath: string; newPath: string }[];
  untracked: string[];
  warnings: string[];
}
const slash = (value: string) => value.replaceAll("\\", "/");
const within = (root: string, target: string) => { const relative = path.relative(root, target); return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative); };
export const sha = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
export const isSourcePath = (value: string): boolean => /\.[jt]sx?$/i.test(value);

/** No shell, optional locks, executable filters, prompts, replace refs or lazy network fetching. */
function git(directory: string, args: string[], signal?: AbortSignal, maxBuffer = 8 * 1024 * 1024): Promise<Buffer> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1", GIT_NO_REPLACE_OBJECTS: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null" });
  return new Promise((resolve, reject) => execFile("git", ["--no-optional-locks", "--literal-pathspecs", "-c", "core.fsmonitor=false", "-c", "core.quotePath=false", "-c", "diff.external=", "-c", "core.hooksPath=", "-C", directory, ...args],
    { encoding: "buffer", windowsHide: true, timeout: 15_000, maxBuffer, env, ...(signal ? { signal } : {}) }, (error, stdout, stderr) => {
      if (error) reject(Object.assign(new Error("Git 只读操作未能完成。"), { code: error.code, notRepository: stderr.toString("utf8").includes("not a git repository") }));
      else resolve(stdout);
    }));
}

export async function inspectGit(rootDir: string, detailed = false, signal?: AbortSignal): Promise<GitInspection> {
  const empty: GitInspection = { state: "unavailable", head: null, scope: "", message: "Git 不可用，请确认本机已安装 Git 且该仓库可读取。", repository: "", entries: [], renames: [], untracked: [], warnings: [] };
  let repository: string;
  try { repository = realpathSync((await git(rootDir, ["rev-parse", "--show-toplevel"], signal)).toString("utf8").trim()); }
  catch (error) {
    if (signal?.aborted) throw error;
    if ((error as { notRepository?: boolean }).notRepository) return { ...empty, state: "not_repository", message: "所选目录不在 Git 工作区中。仍可浏览代码；改动影响需要 Git 的 HEAD 基线。" };
    return empty;
  }
  if (!within(repository, rootDir)) return empty;
  const scope = slash(path.relative(repository, rootDir));
  const result: GitInspection = { ...empty, state: "no_head", repository, scope, message: "仓库尚无 HEAD 提交。可列出当前源码，但无法生成历史影响路径。" };
  try {
    const head = (await git(repository, ["rev-parse", "--verify", "HEAD^{commit}"], signal)).toString("utf8").trim();
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(head)) return empty;
    result.head = head; result.state = "ready"; result.message = "HEAD 与工作区当前内容比较，包含已暂存和未暂存修改。";
  } catch (error) { if (signal?.aborted) throw error; }
  if (!detailed) return result;
  const prefix = scope ? scope + "/" : "";
  const relative = (value: string) => value.startsWith(prefix) ? value.slice(prefix.length) : null;
  result.untracked = (await git(repository, ["ls-files", "--others", "--exclude-standard", "-z", "--", scope || "."], signal)).toString("utf8").split("\0").filter(Boolean).map(relative).filter((value): value is string => value !== null);
  if (!result.head) return result;
  const tree = await git(repository, ["ls-tree", "-r", "-l", "-z", "--full-tree", result.head, "--", scope || "."], signal);
  for (const record of tree.toString("utf8").split("\0").filter(Boolean)) {
    const match = /^(\d{6}) (?:blob|commit) ([0-9a-f]+)\s+(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Git 文件清单格式不支持。");
    const name = relative(match[4]!);
    if (name !== null) result.entries.push({ mode: match[1]!, oid: match[2]!, bytes: Number(match[3]), path: name });
  }
  try {
    // Compare stored index blobs, never worktree content: a worktree diff can execute clean filters.
    // Unstaged changes still come from the analyzer's actual source capture, not this rename hint.
    const fields = (await git(repository, ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--find-renames=50%", result.head, "--", scope || "."], signal)).toString("utf8").split("\0");
    for (let index = 0; index < fields.length && fields[index];) {
      const status = fields[index++]!; const first = fields[index++];
      if (/^[RC]\d+$/.test(status)) {
        const second = fields[index++];
        const oldPath = first ? relative(first) : null, newPath = second ? relative(second) : null;
        if (status.startsWith("R") && oldPath && newPath) result.renames.push({ oldPath, newPath });
      } else if (status.startsWith("U")) result.warnings.push("工作区包含未合并内容，当前解析可能只得到部分关系。");
    }
  } catch (error) { if (signal?.aborted) throw error; result.warnings.push("Git 重命名提示不可用，仅采用唯一内容匹配候选。"); }
  return result;
}

export function publicBaseline(info: GitBaseline): GitBaseline { return { state: info.state, head: info.head, scope: info.scope, message: info.message }; }

function allowedHistoricalPath(name: string): boolean {
  const parts = name.split("/");
  if (path.isAbsolute(name) || name.includes("\\") || parts.some((part) => !part || part === "." || part === ".." || /[:\x00-\x1f]/.test(part)
    || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)
    || [".git", "node_modules", "dist", "build", "coverage", ".next", ".npm-cache", ".codegraph"].includes(part.toLowerCase()) || /^\.env(?:\.|$)/i.test(part))) return false;
  return isSourcePath(name) || name.endsWith(".json") || [".gitignore", ".codegraphignore"].includes(parts.at(-1)!);
}

/** Write only plain blobs into a new, tool-owned directory; never check out or run target code. */
export async function materializeBaseline(info: GitInspection, destination: string, signal?: AbortSignal): Promise<string[]> {
  const warnings: string[] = [];
  let count = 0, bytes = 0, skipped = 0;
  const paths = new Set<string>();
  for (const entry of info.entries) {
    if (signal?.aborted) throw new Error("取消基线读取");
    if (!allowedHistoricalPath(entry.path)) continue;
    if (!["100644", "100755"].includes(entry.mode) || !Number.isFinite(entry.bytes) || entry.bytes > 1024 * 1024 || count >= 2000 || bytes + entry.bytes > 64 * 1024 * 1024) { skipped++; continue; }
    const target = path.resolve(destination, ...entry.path.split("/"));
    const canonical = process.platform === "win32" ? target.toLowerCase() : target;
    if (!within(destination, target) || paths.has(canonical)) { skipped++; continue; }
    const blob = await git(info.repository, ["cat-file", "blob", entry.oid], signal, 1024 * 1024 + 1024);
    if (blob.length !== entry.bytes || blob.includes(0)) { skipped++; continue; }
    try { new TextDecoder("utf-8", { fatal: true }).decode(blob); } catch { skipped++; continue; }
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, blob, { flag: "wx" }); paths.add(canonical); count++; bytes += blob.length;
  }
  if (skipped) warnings.push(`HEAD 有 ${skipped} 个候选路径因文件类型、大小、编码或读取预算未物化，历史分析可能存在缺口。`);
  warnings.push("HEAD 基线只读取已提交的源码与 JSON/忽略配置，不复用工作区未提交的依赖声明；两侧解析环境可能不同。");
  return warnings;
}

export function existingBaselinePaths(rootDir: string, info: GitInspection): string[] {
  return info.entries.filter((entry) => isSourcePath(entry.path) && allowedHistoricalPath(entry.path)).filter((entry) => {
    try {
      const target = path.resolve(rootDir, ...entry.path.split("/"));
      if (!within(rootDir, target)) return false;
      // Metadata only: even excluded links must not be mistaken for a confirmed deletion.
      return !!lstatSync(target);
    } catch { return false; }
  }).map((entry) => entry.path);
}
