import type { AnalysisSnapshot, RelationRecord } from "@codegraph/shared";
export { ProjectExplorer } from "./explorer.js";
export type { GraphOptions } from "./explorer.js";
export { recommendReading, READING_ALGORITHM_VERSION } from "./reading.js";
export { compareSnapshots, calculateComparisonImpact, changedLines, isTestPath } from "./comparison.js";
export type { ComparisonInputs } from "./comparison.js";

export interface ImpactPath { nodeId: string; distance: number; relationIds: string[] }
export interface ImpactResult { focus: string; paths: ImpactPath[]; truncated: boolean; maxDepth: number; maxNodes: number }
export interface ImpactOptions { maxDepth?: number; maxNodes?: number; includeTypes?: boolean }

/** Reverse structural dependencies only; this does not establish a runtime failure. */
export function traceDependents(snapshot: AnalysisSnapshot, focus: string, options: ImpactOptions = {}): ImpactResult {
  const maxDepth = options.maxDepth ?? 2;
  const maxNodes = options.maxNodes ?? 100;
  if (!Number.isSafeInteger(maxDepth) || maxDepth < 0 || !Number.isSafeInteger(maxNodes) || maxNodes < 1) throw new Error("Invalid traversal limits");
  if (!snapshot.files.some((file) => file.id === focus) && !snapshot.symbols.some((symbol) => symbol.id === focus)) throw new Error("Unknown focus node");
  const eligible = (edge: RelationRecord): boolean => edge.origin === "static"
    && ["CALLS", "RENDERS", "REFERENCES", "IMPORTS"].includes(edge.kind)
    && (options.includeTypes === true || edge.usage !== "type");
  const incoming = new Map<string, RelationRecord[]>();
  for (const edge of snapshot.relations) {
    if (eligible(edge)) incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge]);
  }
  const visited = new Set([focus]);
  const queue: ImpactPath[] = [{ nodeId: focus, distance: 0, relationIds: [] }];
  const paths: ImpactPath[] = [];
  for (let index = 0; index < queue.length; index++) {
    const current = queue[index]!;
    if (current.distance >= maxDepth) continue;
    for (const edge of incoming.get(current.nodeId) ?? []) {
      if (visited.has(edge.from) || paths.length >= maxNodes) continue;
      const next = { nodeId: edge.from, distance: current.distance + 1, relationIds: [...current.relationIds, edge.id] };
      visited.add(edge.from);
      paths.push(next);
      queue.push(next);
    }
  }
  const truncated = queue.some((node) => (incoming.get(node.nodeId) ?? []).some((edge) => !visited.has(edge.from)));
  return { focus, paths, truncated, maxDepth, maxNodes };
}
