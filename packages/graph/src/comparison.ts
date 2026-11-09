import { createHash } from "node:crypto";
import type { AnalysisSnapshot, ComparisonSymbol, ImpactFocus, CapturedSource, ChangeHunk, ComparisonPath, ComparisonReport, ComparisonSide, FileChange, GitBaseline, ImpactStep, SymbolMapping } from "@codetrail/shared";
import { ProjectExplorer } from "./explorer.js";
import { summarizeResolution } from "@codetrail/shared";

const id = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 24);
const normalizeEol = (value: string) => value.replace(/\r\n?/g, "\n");
export const isTestPath = (path: string): boolean => /(?:^|\/)(?:__tests__|tests?)(?:\/|$)|\.(?:test|spec)\.[jt]sx?$/i.test(path);

/** Bounded line LCS, trimmed before allocation. Coarse ranges are explicitly marked. */
export function changedLines(oldText: string, newText: string): ChangeHunk[] {
  if (oldText === newText) return [];
  const old = oldText ? oldText.split(/\r\n|\n|\r/) : [];
  const next = newText ? newText.split(/\r\n|\n|\r/) : [];
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  let suffix = 0;
  while (suffix < old.length - prefix && suffix < next.length - prefix && old.at(-1 - suffix) === next.at(-1 - suffix)) suffix++;
  const a = old.slice(prefix, old.length - suffix), b = next.slice(prefix, next.length - suffix);
  const coarse = (): ChangeHunk[] => [{ oldStart: 1, oldLines: old.length, newStart: 1, newLines: next.length, coarse: true }];
  if (!a.length && !b.length || (a.length + 1) * (b.length + 1) > 1_000_000) return coarse();
  const width = b.length + 1, table = new Uint32Array((a.length + 1) * width);
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--)
    table[i * width + j] = a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
  const hunks: ChangeHunk[] = []; let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    const startI = i, startJ = j;
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (i < a.length && (j === b.length || table[(i + 1) * width + j]! >= table[i * width + j + 1]!)) i++;
      else j++;
    }
    hunks.push({ oldStart: prefix + startI + 1, oldLines: i - startI, newStart: prefix + startJ + 1, newLines: j - startJ, coarse: false });
    if (hunks.length > 100) return coarse();
  }
  return hunks;
}

export interface ComparisonInputs {
  baseline: GitBaseline;
  base: AnalysisSnapshot | null;
  current: AnalysisSnapshot;
  oldSources: CapturedSource[];
  newSources: CapturedSource[];
  renames?: { oldPath: string; newPath: string }[];
  untracked?: string[];
  baselinePaths?: string[];
  presentPaths?: string[];
  warnings?: string[];
}

export function compareSnapshots(input: ComparisonInputs): ComparisonReport {
  const { base, current, baseline } = input;
  const oldModel = base ? new ProjectExplorer(base) : null, newModel = new ProjectExplorer(current);
  const oldFiles = new Map(base?.files.map((file) => [file.path, file]) ?? []), newFiles = new Map(current.files.map((file) => [file.path, file]));
  const oldTexts = new Map(input.oldSources.map((source) => [source.path, source.content])), newTexts = new Map(input.newSources.map((source) => [source.path, source.content]));
  const pairs: { oldPath?: string; newPath?: string; renamed?: boolean }[] = [];
  const pairedOld = new Set<string>(), pairedNew = new Set<string>();
  for (const [path, file] of oldFiles) if (newFiles.has(path)) {
    pairedOld.add(path); pairedNew.add(path);
    if (file.hash !== newFiles.get(path)!.hash && normalizeEol(oldTexts.get(path)!) !== normalizeEol(newTexts.get(path)!)) pairs.push({ oldPath: path, newPath: path });
  }
  const rename = (oldPath: string, newPath: string) => {
    if (pairedOld.has(oldPath) || pairedNew.has(newPath) || !oldFiles.has(oldPath) || !newFiles.has(newPath)) return;
    pairs.push({ oldPath, newPath, renamed: true }); pairedOld.add(oldPath); pairedNew.add(newPath);
  };
  for (const hint of input.renames ?? []) rename(hint.oldPath, hint.newPath);
  // Exact unique content is a candidate, never proof of a semantic rename.
  for (const [oldPath, file] of oldFiles) if (!pairedOld.has(oldPath)) {
    const olds = [...oldFiles].filter(([path, item]) => !pairedOld.has(path) && item.hash === file.hash);
    const news = [...newFiles].filter(([path, item]) => !pairedNew.has(path) && item.hash === file.hash);
    if (olds.length === 1 && news.length === 1) rename(oldPath, news[0]![0]);
  }
  for (const path of oldFiles.keys()) if (!pairedOld.has(path)) pairs.push({ oldPath: path });
  for (const path of newFiles.keys()) if (!pairedNew.has(path)) pairs.push({ newPath: path });
  const changes: FileChange[] = pairs.map((pair): FileChange => {
    const oldFile = pair.oldPath ? oldFiles.get(pair.oldPath)! : null, newFile = pair.newPath ? newFiles.get(pair.newPath)! : null;
    const scope = !!base && (!oldFile && (input.baselinePaths ?? []).includes(pair.newPath!) || !newFile && (input.presentPaths ?? []).includes(pair.oldPath!));
    const symbols: SymbolMapping[] = [];
    const oldSymbols = base?.symbols.filter((symbol) => symbol.fileId === oldFile?.id) ?? [], newSymbols = current.symbols.filter((symbol) => symbol.fileId === newFile?.id);
    const keys = new Set([...oldSymbols, ...newSymbols].map((symbol) => `${symbol.kind}:${symbol.qualifiedName}`));
    for (const key of keys) {
      const oldMatches = oldSymbols.filter((symbol) => `${symbol.kind}:${symbol.qualifiedName}` === key);
      const newMatches = newSymbols.filter((symbol) => `${symbol.kind}:${symbol.qualifiedName}` === key);
      if (oldMatches.length <= 1 && newMatches.length <= 1) {
        const old = oldMatches[0], next = newMatches[0];
        const equal = old && next && normalizeEol(oldTexts.get(pair.oldPath!)!.slice(old.range.startOffset, old.range.endOffset)) === normalizeEol(newTexts.get(pair.newPath!)!.slice(next.range.startOffset, next.range.endOffset));
        const kind = !old ? "added" : !next ? "deleted" : old.exported !== next.exported ? "export" : old.signature !== next.signature ? "signature" : !equal ? "modified" : pair.renamed ? "moved" : "unchanged";
        symbols.push({ oldNode: old ? oldModel!.nodes.get(old.id)! : null, newNode: next ? newModel.nodes.get(next.id)! : null,
          kind, basis: old && next ? pair.renamed ? "rename-candidate" : "identity" : "none" });
      } else {
        for (const old of oldMatches) symbols.push({ oldNode: oldModel!.nodes.get(old.id)!, newNode: null, kind: "ambiguous", basis: "ambiguous" });
        for (const next of newMatches) symbols.push({ oldNode: null, newNode: newModel.nodes.get(next.id)!, kind: "ambiguous", basis: "ambiguous" });
      }
    }
    return { id: `change:${id(JSON.stringify(pair))}`, kind: scope ? "scope" : pair.renamed ? "rename_candidate" : oldFile && newFile ? "modified" : oldFile ? "deleted" : "added",
      oldFile: oldFile ? oldModel!.nodes.get(oldFile.id)! : null, newFile: newFile ? newModel.nodes.get(newFile.id)! : null,
      untracked: !!pair.newPath && (input.untracked ?? []).includes(pair.newPath), mappingNote: scope ? "此文件在一侧未进入解析范围，不能据此断定新增或删除。" : pair.renamed ? "Git 相似度或唯一内容匹配得到的重命名候选；符号按完整名称与种类唯一匹配。" : "同路径文件中，按完整符号名和种类唯一匹配；符号改名不会猜测合并。",
      hunks: changedLines(oldTexts.get(pair.oldPath ?? "") ?? "", newTexts.get(pair.newPath ?? "") ?? ""), symbols: symbols.slice(0, 500), truncated: symbols.length > 500 };
  }).sort((a, b) => (a.newFile?.path ?? a.oldFile!.path).localeCompare(b.newFile?.path ?? b.oldFile!.path, "en"));
  const report: ComparisonReport = { id: `comparison:${id(`${baseline.head}:${current.id}:${base?.id ?? "none"}:${JSON.stringify(changes)}`)}`, createdAt: new Date().toISOString(), baseline,
    currentSnapshotId: current.id, baseSnapshotId: base?.id ?? null, stale: current.stale, changes, paths: [], includeTypes: false, maxDepth: 2, maxPaths: 100,
    resolutionSummary: { base: base ? summarizeResolution(base.unresolved) : null, current: summarizeResolution(current.unresolved) },
    truncated: changes.some((change) => change.truncated), statistics: { files: changes.length, symbols: changes.reduce((sum, change) => sum + change.symbols.filter((symbol) => symbol.kind !== "unchanged").length, 0), paths: 0, testFiles: 0, oldUnresolved: base?.unresolved.length ?? 0, newUnresolved: current.unresolved.length },
    limitations: ["比较固定为 HEAD 与工作区实际内容，包含已暂存和未暂存修改；未跟踪源码单列。", "潜在关联来自静态图，不证明故障、执行顺序、测试覆盖率或未列出代码不受影响。", "仅换行编码变化不计为代码变化；保留的源码和位置仍对应各自原文。", "重命名提示来自暂存区 Git 相似度或唯一内容；未暂存且内容变化的移动可能显示为删除和新增。", "文件级导入关联较保守，不代表导入者使用了变化的具体符号。", "符号按完整名称与种类唯一映射；改名、歧义和分析范围变化保留缺口。", "每次查询最多两跳、100 条路径、20,000 次边检查；概览每侧最多 200 个起点并轮流分配路径。每个起点与目标保留一条最短依据，回调候选不传播。", "符号聚焦只查询该比较变化文件中的指定版本符号，从保存图独立追踪；符号本身可能未变，不表示完整影响或全部可选调用链。分页不解除分析预算。", ...(!base ? ["缺少 HEAD 基线，仅展示当前源码清单，不生成完整历史影响。"] : []), ...(base?.status === "partial" || current.status === "partial" ? ["至少一侧为部分解析；未解析关系和范围限制可能导致遗漏。"] : []), ...(input.warnings ?? [])] };
  return calculateComparisonImpact(report, base, current);
}

/** Search preserved symbols in changed files, independent of mapped-symbol/path caps. */
export function comparisonSymbols(report: ComparisonReport, base: AnalysisSnapshot | null, current: AnalysisSnapshot, query = "", side?: ComparisonSide): ComparisonSymbol[] {
  const needle = query.toLowerCase(), results: ComparisonSymbol[] = [];
  for (const [version, snapshot] of [["base", base], ["current", current]] as const) {
    if (!snapshot || side && side !== version) continue;
    const files = new Map(report.changes.filter(change => change.kind !== "scope").flatMap(change => {
      const file = version === "base" ? change.oldFile : change.newFile;
      return file ? [[file.id, change.id] as const] : [];
    }));
    const model = new ProjectExplorer(snapshot);
    for (const symbol of snapshot.symbols) {
      const changeId = files.get(symbol.fileId), node = model.nodes.get(symbol.id)!;
      if (changeId && `${node.name} ${node.path}`.toLowerCase().includes(needle)) results.push({ side: version, changeId, node });
    }
  }
  return results.sort((a, b) => Number(b.node.name.toLowerCase() === needle) - Number(a.node.name.toLowerCase() === needle)
    || a.node.path.localeCompare(b.node.path) || a.node.name.localeCompare(b.node.name) || a.side.localeCompare(b.side) || a.node.id.localeCompare(b.node.id));
}

/** Traverse preserved versions independently, with fair overview seeds or one exact symbol. */
export function calculateComparisonImpact(report: ComparisonReport, base: AnalysisSnapshot | null, current: AnalysisSnapshot, includeTypes = false, focus?: ImpactFocus): ComparisonReport {
  const truncation = { changes: report.changes.some(change => change.truncated), seeds: false, paths: false, depth: false, work: false };
  const result: ComparisonReport = { ...report, includeTypes, paths: [], statistics: { ...report.statistics, paths: 0, testFiles: 0 }, truncated: truncation.changes, truncation };
  delete result.focus; delete result.focusNode; delete result.overviewTruncated;
  const selected = focus && comparisonSymbols(report, base, current, "", focus.side).find(item => item.node.id === focus.nodeId);
  if (focus && !selected) throw new RangeError("聚焦符号不属于该比较指定版本的变化文件，请重新搜索该版本符号。");
  if (selected) { result.focus = focus; result.focusNode = selected.node; result.overviewTruncated = report.truncated; }
  if (!base) return result;
  let inspectedEdges = 0;
  const versions: Generator<ComparisonPath>[][] = [];
  for (const [side, snapshot] of [["base", base], ["current", current]] as const) {
    const generators: Generator<ComparisonPath>[] = []; versions.push(generators);
    if (focus && focus.side !== side) continue;
    const model = new ProjectExplorer(snapshot), incoming = new Map<string, ImpactStep[]>();
    const eligible = snapshot.relations.filter(edge => edge.origin === "static" && ["CALLS", "RENDERS", "REFERENCES", "IMPORTS"].includes(edge.kind) && (includeTypes || edge.usage !== "type"))
      .sort((a, b) => Number(a.kind === "REFERENCES") - Number(b.kind === "REFERENCES") || a.id.localeCompare(b.id));
    for (const edge of eligible) {
      const from = model.nodes.get(edge.from)!, to = model.nodes.get(edge.to)!;
      const step: ImpactStep = { from, to, kind: edge.kind, usage: edge.usage ?? "value", evidenceId: edge.evidenceId, ...(edge.supportingEvidenceIds ? { supportingEvidenceIds: edge.supportingEvidenceIds } : {}) };
      const list = incoming.get(edge.to); if (list) list.push(step); else incoming.set(edge.to, [step]);
    }
    const seeds = selected ? [{ changeId: selected.changeId, node: selected.node }] : report.changes.filter(change => change.kind !== "scope").flatMap(change => {
      const file = side === "base" ? change.oldFile : change.newFile;
      return [...change.symbols.filter(mapping => mapping.kind !== "unchanged").flatMap(mapping => {
        const node = side === "base" ? mapping.oldNode : mapping.newNode; return node ? [{ changeId: change.id, node }] : [];
      }), ...(file ? [{ changeId: change.id, node: file }] : [])];
    });
    if (seeds.length > 200) truncation.seeds = true;
    for (const { changeId, node: seed } of seeds.slice(0, 200)) {
      function* walk(): Generator<ComparisonPath> {
        const visited = new Set([seed.id]), queue = [{ node: seed, steps: [] as ImpactStep[] }];
        for (let index = 0; index < queue.length; index++) {
          const item = queue[index]!;
          for (const edge of incoming.get(item.node.id) ?? []) {
            if (++inspectedEdges > 20_000) { truncation.work = true; return; }
            if (visited.has(edge.from.id)) continue;
            if (item.steps.length >= result.maxDepth) { truncation.depth = true; continue; }
            visited.add(edge.from.id);
            const steps = [...item.steps, edge], key = `${side}:${changeId}:${seed.id}:${edge.from.id}`;
            const hasTypes = steps.some(step => step.usage === "type" || step.usage === "mixed"), hasValues = steps.some(step => step.usage !== "type");
            queue.push({ node: edge.from, steps });
            yield { id: `path:${id(key)}`, side, changeId, seed, target: edge.from, distance: steps.length, steps,
              dependency: hasTypes ? hasValues ? "mixed" : "type" : "value", test: isTestPath(edge.from.path) };
          }
        }
      }
      generators.push(walk());
    }
  }
  // One path per seed per round, alternating versions; high fan-in cannot own the first page.
  const active: Generator<ComparisonPath>[] = [];
  for (let index = 0; index < Math.max(...versions.map(items => items.length)); index++) for (const items of versions) if (items[index]) active.push(items[index]!);
  outer: while (active.length) {
    for (let index = 0; index < active.length;) {
      const next = active[index]!.next();
      if (truncation.work) break outer;
      if (next.done) { active.splice(index, 1); continue; }
      if (result.paths.length >= result.maxPaths) { truncation.paths = true; break outer; }
      result.paths.push(next.value); index++;
    }
  }
  result.truncated = Object.values(truncation).some(Boolean);
  result.statistics.paths = result.paths.length;
  result.statistics.testFiles = new Set(result.paths.filter(item => item.test).map(item => item.target.path)).size;
  return result;
}
