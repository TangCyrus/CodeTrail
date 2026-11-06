import type { AnalysisSnapshot, CodeRecommendation, ExplorerNode, ReadingGuide, ReadingStep, RecommendationReason, RelationRecord } from "@codetrail/shared";
import { ProjectExplorer } from "./explorer.js";

const EXCLUDED = /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|generated|dist|coverage)(?:\/|$)|\.(?:test|spec)\.[jt]sx?$|\.d\.ts$/i;
const SHARED = /(?:^|\/)(?:utils?|helpers?|shared|common|foundation)(?:\/|\.)/i;
const ENTRY_FILE = /(?:^|\/)(?:main|entry|app)\.[jt]sx?$|^(?:src\/)?index\.[jt]sx?$/i;
const ENTRY_NAME = /^(?:main|start|bootstrap|App)$/;
const CALLABLE = new Set(["function", "method", "class"]);
export const READING_ALGORITHM_VERSION = "structural-reading-1";

/** Explicit structural signals; no model scores, test coverage claims or business importance labels. */
export function recommendReading(snapshot: AnalysisSnapshot, model = new ProjectExplorer(snapshot)): ReadingGuide {
  const excludedIds = new Set(snapshot.files.filter((file) => EXCLUDED.test(file.path)).map((file) => file.id));
  const symbols = snapshot.symbols.filter((symbol) => !excludedIds.has(symbol.fileId)
    && (CALLABLE.has(symbol.kind) || symbol.kind === "interface" || symbol.kind === "type" || symbol.kind === "enum" || symbol.exported && symbol.kind === "variable"));
  const valueRelations = snapshot.relations.filter((edge) => edge.origin === "static" && edge.usage !== "type"
    && ["CALLS", "REFERENCES", "RENDERS"].includes(edge.kind));
  const runtime = valueRelations.filter((edge) => edge.kind === "CALLS" || edge.kind === "RENDERS");
  const declarationProof = new Map(snapshot.relations.filter((edge) => edge.kind === "CONTAINS").map((edge) => [edge.to, edge.evidenceId]));
  const incoming = (id: string) => valueRelations.filter((edge) => edge.to === id && !excludedIds.has(model.nodes.get(edge.from)?.fileId ?? ""));
  const outgoing = (id: string) => runtime.filter((edge) => edge.from === id && !excludedIds.has(model.nodes.get(edge.to)?.fileId ?? ""));
  const candidates = symbols.map((symbol) => {
    const node = model.nodes.get(symbol.id)!;
    const ins = incoming(node.id);
    const outs = outgoing(node.id);
    const foreign = ins.filter((edge) => model.nodes.get(edge.from)?.fileId !== symbol.fileId);
    const files = new Set(foreign.map((edge) => model.nodes.get(edge.from)?.fileId).filter(Boolean));
    const modules = new Set([...ins.map((edge) => edge.from), ...outs.map((edge) => edge.to)].map((id) => model.nodes.get(id)?.moduleId).filter((id) => id && id !== node.moduleId));
    const proof = declarationProof.get(node.id);
    const reasons: RecommendationReason[] = [];
    const fileProofs = new Map<string, string>();
    for (const edge of foreign) fileProofs.set(model.nodes.get(edge.from)!.fileId!, edge.evidenceId);
    if (files.size) reasons.push({ code: "referencing-files", text: `被 ${files.size} 个其他文件静态引用`, origin: "static", evidenceIds: [...fileProofs.values()].slice(0, 6) });
    if (modules.size) reasons.push({ code: "cross-module", text: `与 ${modules.size} 个其他目录模块存在静态关联`, origin: "static", evidenceIds: [...new Set([...ins, ...outs].filter((edge) => model.nodes.get(edge.from === node.id ? edge.to : edge.from)?.moduleId !== node.moduleId).map((edge) => edge.evidenceId))].slice(0, 6) });
    if (symbol.exported && proof) reasons.push({ code: "public-export", text: "编译器将其识别为导出符号，可作为公共接口阅读入口", origin: "static", evidenceIds: [proof] });
    const topLevel = symbol.parentId === symbol.fileId;
    const entry = topLevel && CALLABLE.has(node.kind) && !SHARED.test(node.path)
      && (ENTRY_FILE.test(node.path) || ENTRY_NAME.test(node.name) && ins.length === 0);
    const rank = files.size * 5 + modules.size * 3 + new Set(outs.map((edge) => edge.to)).size + (symbol.exported ? 2 : 0);
    return { node, reasons, metrics: { referencingFiles: files.size, connectedModules: modules.size, directCallees: new Set(outs.map((edge) => edge.to)).size, exported: symbol.exported }, entry, entryRank: (ENTRY_NAME.test(node.name) ? 30 : 0) + (/(?:main|entry)\.[jt]sx?$/i.test(node.path) ? 10 : 0) + rank, rank, proof };
  }).filter((candidate) => !!candidate.proof);
  const stable = (a: typeof candidates[number], b: typeof candidates[number]) => b.rank - a.rank || a.node.path.localeCompare(b.node.path, "en") || a.node.name.localeCompare(b.node.name, "en");
  const entries = candidates.filter((candidate) => candidate.entry).sort((a, b) => b.entryRank - a.entryRank || stable(a, b));
  const entryFiles = new Set<string>();
  const entryPicks = entries.filter((candidate) => {
    if (entryFiles.has(candidate.node.fileId!)) return false;
    entryFiles.add(candidate.node.fileId!); return true;
  }).slice(0, 3);
  const selected = new Set(entryPicks.map((candidate) => candidate.node.id));
  const nearEntry = new Map<string, RelationRecord>();
  let frontier = entryPicks.map((candidate) => candidate.node.id);
  for (let level = 0; level < 2; level++) {
    const next: string[] = [];
    for (const id of frontier) for (const edge of outgoing(id)) {
      if (selected.has(edge.to) || nearEntry.has(edge.to)) continue;
      nearEntry.set(edge.to, edge); next.push(edge.to);
    }
    frontier = next;
  }
  const sharedPicks = candidates.filter((candidate) => !selected.has(candidate.node.id)
    && (SHARED.test(candidate.node.path) || candidate.metrics.referencingFiles >= 2)).sort(stable).slice(0, 3);
  for (const candidate of sharedPicks) selected.add(candidate.node.id);
  const flowCandidates = candidates.filter((candidate) => !selected.has(candidate.node.id) && !SHARED.test(candidate.node.path))
    .sort((a, b) => Number(nearEntry.has(b.node.id)) - Number(nearEntry.has(a.node.id)) || stable(a, b));
  const flowPicks: typeof candidates = [];
  const represented = new Set<string>();
  for (const candidate of flowCandidates) {
    if (flowPicks.length >= 4 || selected.size >= 10) break;
    if (!nearEntry.has(candidate.node.id) && represented.has(candidate.node.moduleId)) continue;
    flowPicks.push(candidate); selected.add(candidate.node.id); represented.add(candidate.node.moduleId);
  }
  const convert = (candidate: typeof candidates[number], category: CodeRecommendation["category"]): CodeRecommendation => {
    const reasons = [...candidate.reasons];
    if (category === "entry") reasons.unshift({ code: "entry-candidate", text: "名称、文件位置与顶层声明符合入口候选规则；需要结合启动代码确认", origin: "rule", evidenceIds: [candidate.proof!] });
    if (category === "workflow") {
      const via = nearEntry.get(candidate.node.id);
      reasons.unshift(via ? { code: "near-entry", text: "位于入口候选附近两层以内的静态调用或组件使用关系中", origin: "static", evidenceIds: [via.evidenceId] }
        : { code: "module-representative", text: "作为所在目录的结构代表，补充模块阅读范围", origin: "rule", evidenceIds: [candidate.proof!] });
    }
    if (category === "shared" && SHARED.test(candidate.node.path)) reasons.unshift({ code: "shared-path", text: "路径符合公共基础代码命名规则，职责仍需结合源码确认", origin: "rule", evidenceIds: [candidate.proof!] });
    return { node: candidate.node, category, metrics: candidate.metrics, reasons };
  };
  const groups: ReadingGuide["groups"] = [
    { id: "entry", title: "入口候选", description: "先建立项目的进入位置", items: entryPicks.map((item) => convert(item, "entry")) },
    { id: "workflow", title: "功能链路候选", description: "沿静态关系理解处理过程", items: flowPicks.map((item) => convert(item, "workflow")) },
    { id: "shared", title: "公共基础候选", description: "补充被复用的接口与基础代码", items: sharedPicks.map((item) => convert(item, "shared")) },
  ];
  const readingOrder: ReadingStep[] = [];
  const visited = new Set<string>();
  const add = (node: ExplorerNode, kind: ReadingStep["kind"], reason: string, evidenceIds: string[], via?: RelationRecord) => {
    if (visited.has(node.id) || readingOrder.length >= 10 || excludedIds.has(node.fileId ?? "")) return;
    visited.add(node.id);
    readingOrder.push({ order: readingOrder.length + 1, node, kind, reason, evidenceIds, ...(via ? { fromNodeId: via.from, viaRelationId: via.id } : {}) });
  };
  // Breadth-first, bounded and cycle-safe; each follow step names an actual preceding relation.
  for (const entry of entryPicks) {
    add(entry.node, "entry", "先核实这个入口候选的职责与调用起点", [entry.proof!]);
    const queue = [{ id: entry.node.id, depth: 0 }];
    const expanded = new Set<string>();
    for (let index = 0; index < queue.length && readingOrder.length < 7; index++) {
      const current = queue[index]!;
      if (current.depth >= 2 || expanded.has(current.id)) continue;
      expanded.add(current.id);
      const edges = outgoing(current.id).sort((a, b) => {
        const an = model.nodes.get(a.to)!; const bn = model.nodes.get(b.to)!;
        const currentFile = model.nodes.get(current.id)?.fileId;
        return Number(SHARED.test(an.path)) - Number(SHARED.test(bn.path))
          || Number(bn.fileId === currentFile) - Number(an.fileId === currentFile)
          || outgoing(b.to).length - outgoing(a.to).length
          || an.path.localeCompare(bn.path, "en") || an.name.localeCompare(bn.name, "en");
      });
      for (const edge of edges) {
        const node = model.nodes.get(edge.to);
        if (!node || !candidates.some((item) => item.node.id === node.id)) continue;
        add(node, "follow", `沿 ${model.nodes.get(edge.from)!.name} 的${edge.kind === "RENDERS" ? "组件使用" : "调用"}位置继续阅读`, [edge.evidenceId], edge);
        queue.push({ id: node.id, depth: current.depth + 1 });
        if (readingOrder.length >= 7) break;
      }
    }
  }
  for (const item of [...flowPicks, ...sharedPicks]) add(item.node, "supplement", "补充阅读这一结构候选；不表示前一步必然调用它", [item.proof!]);
  return { snapshotId: snapshot.id, algorithmVersion: READING_ALGORITHM_VERSION, groups, readingOrder, excludedFiles: excludedIds.size,
    limitations: ["结构重要性线索不等同于业务重要性结论。", "入口、公共目录和模块代表属于候选规则。", "阅读顺序是建议，不是运行时执行顺序；回调候选不作为直接调用传播。", "声明、测试与生成文件不参与核心推荐；源码范围外的关系仍有缺口。"] };
}
