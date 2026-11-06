import { createHash } from "node:crypto";
import { recommendReading, type ProjectExplorer } from "@codetrail/graph";
import type { CitedFact, ContextEvidence, ExplanationAction, ExplanationPreview, ReadingAudience, SourceRange } from "@codetrail/shared";
import type { SnapshotStore } from "./store.js";

export const CONTEXT_VERSION = "code-context-1";
export const MAX_CONTEXT_CHARACTERS = 18_000;
export const digest = (value: string): string => createHash("sha256").update(value).digest("hex");
const labels: Record<string, string> = { CALLS: "调用", REFERENCES: "引用", IMPORTS: "导入", RENDERS: "使用组件", REGISTERS_CALLBACK: "传入回调候选" };

/** This exact payload is previewed, hashed and sent; no absolute root, keys or unrelated source. */
export function aiContextPayload(preview: Pick<ExplanationPreview, "node" | "snapshotId" | "action" | "audience" | "facts" | "evidence" | "truncated" | "limitations">) {
  return {
    version: CONTEXT_VERSION, snapshotId: preview.snapshotId, action: preview.action, audience: preview.audience, language: "zh-CN",
    node: { name: preview.node.name.slice(0, 300), path: preview.node.path.slice(0, 600), kind: preview.node.kind, signature: preview.node.signature?.slice(0, 400) ?? null },
    facts: preview.facts, evidence: preview.evidence.map((proof) => ({ id: proof.id, file: proof.filePath, hash: proof.fileHash, shownRange: proof.shownRange, excerpt: proof.excerpt, truncated: proof.truncated })),
    truncated: preview.truncated, limitations: preview.limitations,
  };
}

function shownRange(content: string, start: number, length: number): SourceRange {
  const position = (offset: number) => {
    const lines = content.slice(0, offset).split(/\r\n|\n|\r/);
    return { line: lines.length, column: lines.at(-1)!.length + 1 };
  };
  return { start: position(start), end: position(start + length), startOffset: start, endOffset: start + length };
}

export function buildExplanationPreview(model: ProjectExplorer, store: SnapshotStore, nodeId: string, action: ExplanationAction, audience: ReadingAudience, stale: boolean): ExplanationPreview {
  const node = model.nodes.get(nodeId);
  if (!node) throw new Error("Unknown explanation node");
  const snapshot = model.snapshot;
  const files = new Map(snapshot.files.map((file) => [file.id, file]));
  const allProofs = new Map(snapshot.evidence.map((proof) => [proof.id, proof]));
  const members = new Set(node.kind === "module" ? [...model.nodes.values()].filter((item) => item.moduleId === node.id && item.kind !== "module").map((item) => item.id)
    : node.kind === "file" ? [...model.nodes.values()].filter((item) => item.fileId === node.id).map((item) => item.id) : [node.id]);
  const declarations = snapshot.relations.filter((edge) => edge.kind === "CONTAINS" && members.has(edge.to));
  const related = snapshot.relations.filter((edge) => edge.kind !== "CONTAINS"
    && (members.has(edge.from) || members.has(edge.to)));
  const ordered = related.sort((a, b) => (a.kind === "CALLS" || a.kind === "RENDERS" ? 0 : a.kind === "REGISTERS_CALLBACK" ? 2 : 1) - (b.kind === "CALLS" || b.kind === "RENDERS" ? 0 : b.kind === "REGISTERS_CALLBACK" ? 2 : 1));
  const focusDeclaration = declarations.find((edge) => edge.to === node.id) ?? declarations.find((edge) => model.nodes.get(edge.to)?.kind === "function") ?? declarations[0];
  const facts: CitedFact[] = [];
  const requested: string[] = [];
  const addFact = (text: string, evidenceIds: string[], origin: CitedFact["origin"] = "static") => {
    const existing = [...new Set(evidenceIds)].filter((id) => allProofs.has(id)).slice(0, 6);
    if (facts.length < 9) { facts.push({ text: text.slice(0, 900), evidenceIds: existing, origin }); requested.push(...existing); }
  };
  if (focusDeclaration) requested.push(focusDeclaration.evidenceId);
  if (node.kind === "module") addFact(`${node.path} 是按目录聚合的模块，包含 ${node.fileCount} 个文件、${node.symbolCount} 个符号；这不是业务边界识别。`, declarations.slice(0, 3).map((edge) => edge.evidenceId), "rule");
  else if (node.kind === "file") addFact(`${node.path} 在当前快照中包含 ${node.symbolCount} 个已索引符号。`, declarations.slice(0, 3).map((edge) => edge.evidenceId));
  else if (focusDeclaration) addFact(`${node.name} 声明于 ${node.path}:${node.range?.start.line ?? 1}${node.signature ? `，签名为 ${node.signature}` : ""}。`, [focusDeclaration.evidenceId]);
  if (action === "importance") {
    const recommendation = recommendReading(snapshot, model).groups.flatMap((group) => group.items).find((item) => item.node.id === node.id);
    for (const reason of recommendation?.reasons.slice(0, 4) ?? []) addFact(reason.text, reason.evidenceIds, reason.origin);
    if (!recommendation && focusDeclaration) addFact("此节点未进入默认推荐名单；这不表示它在业务上不重要。可结合下面的局部关系核实。", [focusDeclaration.evidenceId], "rule");
  }
  const described = new Set<string>();
  const calledPairs = new Set(ordered.filter((edge) => edge.kind === "CALLS" || edge.kind === "RENDERS").map((edge) => `${edge.from}:${edge.to}`));
  for (const edge of ordered) {
    if (edge.kind === "REFERENCES" && calledPairs.has(`${edge.from}:${edge.to}`)) continue;
    const from = model.nodes.get(edge.from); const to = model.nodes.get(edge.to);
    if (!from || !to || [from.kind, to.kind].includes("parameter")) continue;
    const key = `${edge.kind}:${edge.from}:${edge.to}:${edge.usage ?? ""}`;
    if (described.has(key)) continue;
    described.add(key);
    addFact(`${from.name} 在此处${labels[edge.kind] ?? "关联"} ${to.name}${edge.usage === "type" ? "（仅类型关系）" : ""}${edge.origin === "rule" ? "；不能据此断定回调被执行" : ""}。`, [edge.evidenceId], edge.origin);
    if (facts.length >= (action === "neighbors" ? 8 : 6)) break;
  }
  const unresolved = snapshot.unresolved.filter((item) => members.has(item.from));
  if (unresolved.length) addFact(`当前节点范围内仍有 ${unresolved.length} 处未解析关系，静态图存在缺口。`, unresolved.slice(0, 3).map((item) => item.evidenceId));
  // Include a small number of adjacent declarations only after the facts' own evidence.
  for (const edge of ordered.slice(0, 3)) {
    const neighbor = members.has(edge.from) ? edge.to : edge.from;
    const declaration = snapshot.relations.find((item) => item.kind === "CONTAINS" && item.to === neighbor);
    if (declaration) requested.push(declaration.evidenceId);
  }
  const evidence: ContextEvidence[] = [];
  let remaining = 9500;
  let truncated = false;
  for (const id of [...new Set(requested)].slice(0, 12)) {
    const original = allProofs.get(id);
    if (!original || remaining < 80) { truncated = true; continue; }
    const file = files.get(original.fileId)!;
    const content = store.source(snapshot.id, file.id);
    if (content === null || content.slice(original.range.startOffset, original.range.endOffset) !== original.excerpt) throw new Error("Snapshot source evidence is unavailable");
    const limit = Math.min(remaining, evidence.length === 0 ? 4500 : 1600);
    let excerpt = original.excerpt.slice(0, limit);
    if (/[\uD800-\uDBFF]$/.test(excerpt)) excerpt = excerpt.slice(0, -1);
    if (excerpt.endsWith("\r") && original.excerpt[excerpt.length] === "\n") excerpt = excerpt.slice(0, -1);
    const shortened = excerpt.length < original.excerpt.length;
    evidence.push({ ...original, filePath: file.path, excerpt, shownRange: shownRange(content, original.range.startOffset, excerpt.length), truncated: shortened });
    remaining -= excerpt.length; truncated ||= shortened;
  }
  const preview: ExplanationPreview = {
    previewId: "", snapshotId: snapshot.id, node, action, audience, facts, evidence, fileScope: [], characters: 0, truncated, stale,
    limitations: ["静态引用不代表运行时执行顺序。", "AI 引用有效只表示位置可追溯，解释语义仍需核实。", ...(unresolved.length ? ["存在未解析关系，不应推断完整调用链。"] : [])],
  };
  const pruneFacts = () => {
    const allowed = new Set(preview.evidence.map((proof) => proof.id));
    preview.facts = preview.facts.filter((fact) => fact.evidenceIds.every((id) => allowed.has(id)));
  };
  pruneFacts();
  while (JSON.stringify(aiContextPayload(preview)).length > MAX_CONTEXT_CHARACTERS && preview.evidence.length > 1) {
    preview.evidence.pop(); preview.truncated = true; pruneFacts();
  }
  const scope = new Map<string, { path: string; hash: string; snippets: number }>();
  for (const proof of preview.evidence) {
    const entry = scope.get(proof.fileId) ?? { path: proof.filePath, hash: proof.fileHash, snippets: 0 };
    entry.snippets++; scope.set(proof.fileId, entry);
  }
  preview.fileScope = [...scope.values()];
  const serialized = JSON.stringify(aiContextPayload(preview));
  if (serialized.length > MAX_CONTEXT_CHARACTERS) throw new Error("Explanation context exceeds the bounded budget");
  preview.characters = serialized.length;
  preview.previewId = digest(serialized);
  return preview;
}
