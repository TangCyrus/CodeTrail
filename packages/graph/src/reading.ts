import type { AnalysisSnapshot, CodeRecommendation, ExplorerNode, ReadingGuide, ReadingOptions, ReadingStep, RecommendationReason, RelationRecord } from "@codetrail/shared";
import { ProjectExplorer } from "./explorer.js";

const EXCLUDED = /(?:^|\/)(?:__tests__|__mocks__|tests?|fixtures?|generated|dist|coverage)(?:\/|$)|\.(?:test|spec)\.[jt]sx?$|\.d\.[cm]?ts$/i;
const EXAMPLE = /(?:^|\/)(?:examples?|demos?|samples?|playgrounds?)(?:\/|$)/i;
const SHARED = /(?:^|\/)(?:utils?|helpers?|shared|common|foundation)(?:\/|\.)/i;
const ENTRY_NAME = /^(?:main|start|bootstrap|App)$/;
const CALLABLE = new Set(["function", "method", "class"]);
export const READING_ALGORITHM_VERSION = "task-reading-3";

/** Explicit structural signals; no model scores, target execution or inferred business priority. */
export function recommendReading(snapshot: AnalysisSnapshot, model = new ProjectExplorer(snapshot), options: ReadingOptions = {}): ReadingGuide {
  const excludedIds = new Set(snapshot.files.filter(file => EXCLUDED.test(file.path)).map(file => file.id));
  const proofByNode = new Map(snapshot.relations.filter(edge => edge.kind === "CONTAINS").map(edge => [edge.to, edge.evidenceId]));
  const eligible = snapshot.symbols.filter(symbol => !excludedIds.has(symbol.fileId) && proofByNode.has(symbol.id)
    && (CALLABLE.has(symbol.kind) || ["interface", "type", "enum"].includes(symbol.kind) || symbol.exported && symbol.kind === "variable"));
  const requested = options.focusNodeIds;
  if (requested && (requested.length < 1 || requested.length > 3)) throw new RangeError("阅读任务需要 1–3 个当前快照中的符号。");
  const focusIds = [...new Set(requested ?? [])];
  if (focusIds.some(id => !eligible.some(symbol => symbol.id === id))) throw new RangeError("阅读起点不是当前快照中可推荐的符号；文件、测试和已排除的声明不能作为起点。");
  const focused = focusIds.length > 0;
  const deferExamples = !focused && eligible.some(symbol => !EXAMPLE.test(model.nodes.get(symbol.id)!.path));
  const deferredIds = new Set(snapshot.files.filter(file => deferExamples && EXAMPLE.test(file.path) && !excludedIds.has(file.id)).map(file => file.id));
  const allowed = (id: string) => { const node = model.nodes.get(id); return !!node && !excludedIds.has(node.fileId ?? id) && !deferredIds.has(node.fileId ?? id); };
  const incoming = new Map<string, RelationRecord[]>(), outgoing = new Map<string, RelationRecord[]>();
  for (const edge of snapshot.relations) {
    if (edge.origin !== "static" || edge.usage === "type" || !["CALLS", "REFERENCES", "RENDERS"].includes(edge.kind) || !allowed(edge.from) || !allowed(edge.to)) continue;
    const ins = incoming.get(edge.to) ?? []; ins.push(edge); incoming.set(edge.to, ins);
    if (edge.kind !== "REFERENCES") { const outs = outgoing.get(edge.from) ?? []; outs.push(edge); outgoing.set(edge.from, outs); }
  }
  const ins = (id: string) => incoming.get(id) ?? [], outs = (id: string) => outgoing.get(id) ?? [];
  const eligibleIds = new Set(eligible.filter(symbol => allowed(symbol.id)).map(symbol => symbol.id));
  // A focused route contains only selected symbols and proven outgoing calls/renders within two hops.
  const focusPaths = new Map<string, RelationRecord[]>();
  for (const id of focusIds) focusPaths.set(id, []);
  const queue = focusIds.map(id => ({ id, path: [] as RelationRecord[] }));
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!; if (current.path.length >= 2) continue;
    for (const edge of outs(current.id)) if (eligibleIds.has(edge.to) && !focusPaths.has(edge.to)) {
      const path = [...current.path, edge]; focusPaths.set(edge.to, path); queue.push({ id: edge.to, path });
    }
  }
  const candidates = eligible.filter(symbol => allowed(symbol.id) && (!focused || focusPaths.has(symbol.id))).map(symbol => {
    const node = model.nodes.get(symbol.id)!, incomingEdges = ins(node.id), outgoingEdges = outs(node.id), proof = proofByNode.get(node.id)!;
    const foreign = incomingEdges.filter(edge => model.nodes.get(edge.from)?.fileId !== symbol.fileId);
    const files = new Set(foreign.map(edge => model.nodes.get(edge.from)?.fileId).filter(Boolean));
    const modules = new Set([...incomingEdges.map(edge => edge.from), ...outgoingEdges.map(edge => edge.to)].map(id => model.nodes.get(id)?.moduleId).filter(id => id && id !== node.moduleId));
    const reasons: RecommendationReason[] = [], fileProofs = new Map<string, string>();
    for (const edge of foreign) fileProofs.set(model.nodes.get(edge.from)!.fileId!, edge.evidenceId);
    if (files.size) reasons.push({ code: "referencing-files", text: `被 ${files.size} 个其他非测试、非暂缓示例文件静态引用`, origin: "static", evidenceIds: [...fileProofs.values()].slice(0, 6) });
    if (modules.size) reasons.push({ code: "cross-module", text: `与 ${modules.size} 个其他目录模块存在静态关联`, origin: "static", evidenceIds: [...new Set([...incomingEdges, ...outgoingEdges].filter(edge => model.nodes.get(edge.from === node.id ? edge.to : edge.from)?.moduleId !== node.moduleId).map(edge => edge.evidenceId))].slice(0, 6) });
    if (symbol.exported) reasons.push({ code: "public-export", text: "编译器将其识别为导出符号，可作为公共接口阅读线索", origin: "static", evidenceIds: [proof] });
    const top = symbol.parentId === symbol.fileId && CALLABLE.has(node.kind) && !node.name.startsWith("<anonymous@");
    const service = top && symbol.exported && /(?:^|\/)(?:mcp|server|cli)\.[jt]sx?$/i.test(node.path) && /^(?:create|run|start|serve)/.test(node.name);
    const launch = top && ENTRY_NAME.test(node.name) && !SHARED.test(node.path)
      && (/(?:^|\/)(?:main|entry|app)\.[jt]sx?$/i.test(node.path) || !snapshot.relations.some(edge => edge.to === node.id && edge.origin === "static"
        && ["CALLS", "RENDERS", "REFERENCES"].includes(edge.kind) && model.nodes.get(edge.from)?.fileId !== symbol.fileId));
    const boundary = top && symbol.exported && !SHARED.test(node.path) && /^(?:packages|libs)\//.test(node.path)
      && foreign.some(edge => edge.kind === "CALLS" && model.nodes.get(edge.from)?.moduleId !== node.moduleId);
    const publicIndex = top && symbol.exported && /(?:^|\/)index\.[jt]sx?$/i.test(node.path) && !SHARED.test(node.path);
    const rank = files.size * 5 + modules.size * 3 + new Set(outgoingEdges.map(edge => edge.to)).size + (symbol.exported ? 2 : 0);
    if (focused) reasons.unshift(focusIds.includes(node.id)
      ? { code: "task-focus", text: "本次指定的阅读起点；不表示项目启动入口", origin: "rule", evidenceIds: [proof] }
      : { code: "task-path", text: "位于指定起点两跳以内的静态调用或组件使用路径上", origin: "static", evidenceIds: focusPaths.get(node.id)!.map(edge => edge.evidenceId) });
    return { node, proof, reasons, service, launch, boundary, publicIndex, rank,
      metrics: { referencingFiles: files.size, connectedModules: modules.size, directCallees: new Set(outgoingEdges.map(edge => edge.to)).size, exported: symbol.exported } };
  });
  const byId = new Map(candidates.map(candidate => [candidate.node.id, candidate]));
  const stable = (a: typeof candidates[number], b: typeof candidates[number]) => b.rank - a.rank || a.node.path.localeCompare(b.node.path, "en") || a.node.name.localeCompare(b.node.name, "en");
  const entries: typeof candidates = [];
  const pick = (items: typeof candidates) => {
    const candidate = items.find(item => !entries.some(entry => entry.node.fileId === item.node.fileId));
    if (candidate && entries.length < 3) entries.push(candidate);
  };
  if (focused) for (const id of focusIds) entries.push(byId.get(id)!);
  else {
    const serviceRank = (item: typeof candidates[number]) => /(?:^|\/)mcp\./i.test(item.node.path) ? 2 : 1;
    const services = candidates.filter(item => item.service).sort((a, b) => serviceRank(b) - serviceRank(a) || stable(a, b));
    const launches = candidates.filter(item => item.launch).sort((a, b) => b.metrics.connectedModules - a.metrics.connectedModules || stable(a, b));
    const boundaries = candidates.filter(item => item.boundary).sort((a, b) => b.metrics.connectedModules - a.metrics.connectedModules || stable(a, b));
    pick(services); pick(launches); pick(boundaries);
    for (const item of [...launches, ...boundaries, ...services, ...candidates.filter(item => item.publicIndex).sort(stable)]) pick([item]);
  }
  const selected = new Set(entries.map(item => item.node.id)), nearEntry = new Map<string, RelationRecord>();
  let frontier = entries.map(item => item.node.id);
  for (let level = 0; level < 2; level++) {
    const next: string[] = [];
    for (const id of frontier) for (const edge of outs(id)) if (!selected.has(edge.to) && !nearEntry.has(edge.to) && byId.has(edge.to)) {
      nearEntry.set(edge.to, edge); next.push(edge.to);
    }
    frontier = next;
  }
  const shared = candidates.filter(item => !selected.has(item.node.id) && (SHARED.test(item.node.path) || item.metrics.referencingFiles >= 2)).sort(stable).slice(0, 3);
  for (const item of shared) selected.add(item.node.id);
  const flow: typeof candidates = [], represented = new Set<string>();
  for (const item of candidates.filter(item => !selected.has(item.node.id) && !SHARED.test(item.node.path)).sort((a, b) => Number(nearEntry.has(b.node.id)) - Number(nearEntry.has(a.node.id)) || stable(a, b))) {
    if (flow.length >= 4 || selected.size >= 10) break;
    if (!nearEntry.has(item.node.id) && represented.has(item.node.moduleId)) continue;
    flow.push(item); selected.add(item.node.id); represented.add(item.node.moduleId);
  }
  const convert = (item: typeof candidates[number], category: CodeRecommendation["category"]): CodeRecommendation => {
    const reasons = [...item.reasons];
    if (category === "entry" && !focused) reasons.unshift(item.boundary && !item.service && !item.launch
      ? { code: "boundary-interface", text: "导出接口存在跨目录模块的静态调用者；作为核心包阅读候选，不代表启动入口", origin: "static", evidenceIds: ins(item.node.id).filter(edge => edge.kind === "CALLS" && model.nodes.get(edge.from)?.moduleId !== item.node.moduleId).slice(0, 6).map(edge => edge.evidenceId) }
      : { code: "entry-candidate", text: "顶层启动名称、MCP/服务文件或公共导出符合入口候选规则；需要结合启动代码确认", origin: "rule", evidenceIds: [item.proof] });
    if (category === "workflow" && !focused) {
      const edge = nearEntry.get(item.node.id);
      reasons.unshift(edge ? { code: "near-entry", text: "位于入口候选附近两层以内的静态调用或组件使用关系中", origin: "static", evidenceIds: [edge.evidenceId] }
        : { code: "module-representative", text: "作为所在目录的结构代表，补充模块阅读范围", origin: "rule", evidenceIds: [item.proof] });
    }
    if (category === "shared" && SHARED.test(item.node.path)) reasons.unshift({ code: "shared-path", text: "路径符合公共基础代码命名规则，职责仍需结合源码确认", origin: "rule", evidenceIds: [item.proof] });
    return { node: item.node, category, reasons, metrics: item.metrics };
  };
  const groups: ReadingGuide["groups"] = [
    { id: "entry", title: focused ? "任务起点" : "入口与包接口候选", description: focused ? "本次指定的符号，不推断业务职责" : "先核实接入位置与跨模块接口", items: entries.map(item => convert(item, "entry")) },
    { id: "workflow", title: "功能链路候选", description: "沿静态关系理解处理过程", items: flow.map(item => convert(item, "workflow")) },
    { id: "shared", title: "公共基础候选", description: "补充被复用的接口与基础代码", items: shared.map(item => convert(item, "shared")) },
  ];
  const readingOrder: ReadingStep[] = [], visited = new Set<string>();
  const add = (node: ExplorerNode, kind: ReadingStep["kind"], reason: string, evidenceIds: string[], via?: RelationRecord) => {
    if (visited.has(node.id) || readingOrder.length >= 10) return;
    visited.add(node.id); readingOrder.push({ order: readingOrder.length + 1, node, kind, reason, evidenceIds, ...(via ? { fromNodeId: via.from, viaRelationId: via.id } : {}) });
  };
  // Reserve all selected roots first; one high fan-out root cannot crowd out the other tasks.
  for (const entry of entries) add(entry.node, "entry", focused ? "从指定任务符号开始；不表示架构启动入口" : "先核实这个接入或包接口候选", [entry.proof]);
  function* walk(root: string): Generator<RelationRecord> {
    const queue = [{ id: root, depth: 0 }], expanded = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const current = queue[index]!; if (current.depth >= 2 || expanded.has(current.id)) continue;
      expanded.add(current.id);
      const edges = [...outs(current.id)].filter(edge => byId.has(edge.to)).sort((a, b) => {
        const an = byId.get(a.to)!, bn = byId.get(b.to)!;
        return Number(SHARED.test(an.node.path)) - Number(SHARED.test(bn.node.path))
          || Number(bn.metrics.exported) - Number(an.metrics.exported) || bn.metrics.connectedModules - an.metrics.connectedModules
          || bn.metrics.directCallees - an.metrics.directCallees || stable(an, bn);
      });
      for (const edge of edges) { yield edge; queue.push({ id: edge.to, depth: current.depth + 1 }); }
    }
  }
  const walks = entries.map(entry => walk(entry.node.id));
  while (walks.length && readingOrder.length < 7) for (let index = 0; index < walks.length && readingOrder.length < 7;) {
    const next = walks[index]!.next();
    if (next.done) { walks.splice(index, 1); continue; }
    const edge = next.value;
    add(byId.get(edge.to)!.node, "follow", `沿 ${model.nodes.get(edge.from)!.name} 的${edge.kind === "RENDERS" ? "组件使用" : "调用"}位置继续阅读`, [edge.evidenceId], edge); index++;
  }
  for (const item of [...flow, ...shared]) add(item.node, "supplement", "补充阅读这一结构候选；不表示前一步必然调用它", [item.proof]);
  return { snapshotId: snapshot.id, algorithmVersion: READING_ALGORITHM_VERSION, groups, readingOrder, excludedFiles: excludedIds.size,
    scope: { mode: focused ? "focused" : "project", focusNodeIds: focusIds, deferredExampleFiles: deferredIds.size },
    limitations: ["结构重要性线索不等同于业务重要性结论。", "入口、MCP/服务路径、公共目录和模块代表属于候选规则。", "存在非示例候选时，默认暂缓 examples/demo/sample/playground 目录；仍可搜索或显式聚焦示例符号。", "任务模式只追踪指定符号向外两跳的静态调用/组件使用，不推断跨回调的业务链路。", "阅读顺序最多十步，不是运行时执行顺序；回调候选不作为直接调用传播。", "声明、测试与生成文件不参与核心推荐；源码范围外的关系仍有缺口。"] };
}
