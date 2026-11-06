import type { AnalysisSnapshot, Breadcrumb, ExplorerEdge, ExplorerGraph, ExplorerNode, NodeConnection, NodeDetail, ProjectOverview, RelationRecord, SearchResults } from "@codetrail/shared";

export interface GraphOptions { focus?: string; maxNodes?: number; depth?: number; includeTypes?: boolean; includeReferences?: boolean; includeCandidates?: boolean }
const basename = (value: string): string => value.split("/").at(-1) ?? value;

/** Browser-facing projections; no compiler nodes, filesystem access or inferred business claims. */
export class ProjectExplorer {
  readonly nodes = new Map<string, ExplorerNode>();
  readonly modules: ExplorerNode[];
  readonly files: ExplorerNode[];
  private readonly fileGroups = new Map<string, string>();

  constructor(readonly snapshot: AnalysisSnapshot) {
    const groups = new Map<string, string[]>();
    for (const file of snapshot.files) {
      const parts = file.path.split("/");
      const directory = parts.length === 1 ? "." : ["src", "lib", "app", "apps", "packages"].includes(parts[0]!) && parts.length > 2 ? parts.slice(0, 2).join("/") : parts[0]!;
      const groupId = `module:${directory}`;
      this.fileGroups.set(file.id, groupId);
      groups.set(directory, [...(groups.get(directory) ?? []), file.id]);
    }
    this.modules = [...groups].sort(([a], [b]) => a.localeCompare(b, "en")).map(([directory, fileIds]) => ({
      id: `module:${directory}`, moduleId: `module:${directory}`, name: directory === "." ? "项目根目录" : basename(directory), path: directory,
      kind: "module", fileCount: fileIds.length, symbolCount: snapshot.symbols.filter((symbol) => fileIds.includes(symbol.fileId)).length,
    }));
    this.files = snapshot.files.map((file) => ({ id: file.id, fileId: file.id, name: basename(file.path), path: file.path, kind: "file", moduleId: this.fileGroups.get(file.id)!, symbolCount: snapshot.symbols.filter((symbol) => symbol.fileId === file.id).length }));
    for (const node of [...this.modules, ...this.files]) this.nodes.set(node.id, node);
    const filePaths = new Map(snapshot.files.map((file) => [file.id, file.path]));
    for (const symbol of snapshot.symbols) this.nodes.set(symbol.id, {
      id: symbol.id, name: symbol.qualifiedName, path: filePaths.get(symbol.fileId)!, kind: symbol.kind,
      moduleId: this.fileGroups.get(symbol.fileId)!, fileId: symbol.fileId, signature: symbol.signature, range: symbol.range, exported: symbol.exported,
    });
  }

  overview(stale = this.snapshot.stale): ProjectOverview {
    const snapshot = this.snapshot;
    return {
      snapshotId: snapshot.id, name: basename(snapshot.rootDir.replaceAll("\\", "/")), rootDir: snapshot.rootDir,
      createdAt: snapshot.createdAt, status: snapshot.status, stale, statistics: snapshot.statistics,
      modules: this.modules, files: this.files, diagnostics: snapshot.diagnostics, skippedCount: snapshot.skipped.length, limitations: snapshot.limitations,
    };
  }

  search(query: string, limit = 40): SearchResults {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Search limit must be between 1 and 100");
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return { query, total: 0, results: [], truncated: false };
    const tokens = normalized.split(/\s+/);
    const matches = [...this.nodes.values()].filter((node) => tokens.every((token) => `${node.name} ${node.path}`.toLocaleLowerCase().includes(token)));
    const rank = (node: ExplorerNode): number => (node.name.toLocaleLowerCase() === normalized ? 100 : node.name.toLocaleLowerCase().startsWith(normalized) ? 60 : 0)
      + (["function", "method", "class", "file"].includes(node.kind) ? 10 : 0);
    matches.sort((a, b) => rank(b) - rank(a) || a.path.localeCompare(b.path, "en") || a.name.localeCompare(b.name, "en"));
    return { query, total: matches.length, results: matches.slice(0, limit), truncated: matches.length > limit };
  }

  breadcrumbs(node?: ExplorerNode): Breadcrumb[] {
    const result: Breadcrumb[] = [{ id: null, label: "架构概览", kind: "overview" }];
    if (!node) return result;
    const module = this.nodes.get(node.moduleId)!;
    result.push({ id: module.id, label: module.path, kind: "module" });
    if (node.kind !== "module" && node.fileId) {
      const file = this.nodes.get(node.fileId)!;
      result.push({ id: file.id, label: file.name, kind: "file" });
    }
    if (node.kind !== "module" && node.kind !== "file") result.push({ id: node.id, label: node.name, kind: "symbol" });
    return result;
  }

  private significant(node: ExplorerNode): boolean {
    return node.kind === "file" || !["parameter", "variable", "property"].includes(node.kind) || !!node.exported || !!node.signature?.startsWith("(");
  }

  private allowed(edge: RelationRecord, options: GraphOptions): boolean {
    return (options.includeTypes === true || edge.usage !== "type")
      && (options.includeReferences === true || edge.kind !== "REFERENCES")
      && (options.includeCandidates !== false || edge.origin !== "rule");
  }

  private group(edges: RelationRecord[], project?: (id: string) => string): ExplorerEdge[] {
    const grouped = new Map<string, ExplorerEdge>();
    for (const edge of edges) {
      const from = project ? project(edge.from) : edge.from;
      const to = project ? project(edge.to) : edge.to;
      if (project && from === to) continue;
      const id = `${from}|${to}|${edge.kind}|${edge.usage ?? ""}`;
      let entry = grouped.get(id);
      if (!entry) {
        entry = { id, from, to, kind: edge.kind, origin: edge.origin, count: 0, evidenceIds: [] };
        if (edge.usage) entry.usage = edge.usage;
        grouped.set(id, entry);
      }
      entry.count++;
      if (entry.evidenceIds.length < 20) entry.evidenceIds.push(edge.evidenceId);
    }
    return [...grouped.values()];
  }

  graph(options: GraphOptions = {}): ExplorerGraph {
    const maxNodes = options.maxNodes ?? 100;
    const depth = options.depth ?? 1;
    if (!Number.isSafeInteger(maxNodes) || maxNodes < 1 || maxNodes > 100 || !Number.isSafeInteger(depth) || depth < 1 || depth > 2) throw new Error("Graph limits are invalid");
    const focus = options.focus ? this.nodes.get(options.focus) : undefined;
    if (options.focus && !focus) throw new Error("Unknown graph focus");
    const allowed = this.snapshot.relations.filter((edge) => this.allowed(edge, options));
    if (!focus) {
      const nodes = this.modules.slice(0, Math.min(maxNodes, 20));
      const visible = new Set(nodes.map((node) => node.id));
      const edges = this.group(allowed.filter((edge) => edge.kind === "IMPORTS"), (id) => this.fileGroups.get(id)!);
      return { nodes, edges: edges.filter((edge) => visible.has(edge.from) && visible.has(edge.to)), breadcrumbs: this.breadcrumbs(), title: "项目架构", scope: "overview", totalNodes: this.modules.length, hiddenNodes: this.modules.length - nodes.length, truncated: nodes.length < this.modules.length };
    }
    const initial = focus.kind === "module" ? this.files.filter((node) => node.moduleId === focus.id)
      : focus.kind === "file" ? [focus, ...[...this.nodes.values()].filter((node) => node.fileId === focus.id && node.id !== focus.id && this.significant(node))]
      : [focus];
    const selected = new Set(initial.slice(0, maxNodes).map((node) => node.id));
    const expected = new Set(initial.map((node) => node.id));
    if (focus.kind !== "module") {
      let frontier = new Set(selected);
      for (let step = 0; step < depth; step++) {
        const next = new Set<string>();
        for (const edge of allowed) {
          if (edge.kind === "CONTAINS") continue;
          const adjacent = frontier.has(edge.from) ? edge.to : frontier.has(edge.to) ? edge.from : undefined;
          const node = adjacent ? this.nodes.get(adjacent) : undefined;
          if (!node || !this.significant(node)) continue;
          expected.add(node.id);
          if (selected.size < maxNodes && !selected.has(node.id)) { selected.add(node.id); next.add(node.id); }
        }
        frontier = next;
      }
    }
    const raw = allowed.filter((edge) => selected.has(edge.from) && selected.has(edge.to)
      && (focus.kind !== "module" || edge.kind === "IMPORTS"));
    return {
      nodes: [...selected].map((id) => this.nodes.get(id)!), edges: this.group(raw), breadcrumbs: this.breadcrumbs(focus), title: focus.name,
      scope: focus.kind === "module" ? "module" : focus.kind === "file" ? "file" : "symbol", totalNodes: expected.size, hiddenNodes: expected.size - selected.size, truncated: expected.size > selected.size,
    };
  }

  detail(id: string): NodeDetail {
    const node = this.nodes.get(id);
    if (!node) throw new Error("Unknown node");
    let raw: ExplorerEdge[];
    if (node.kind === "module") raw = this.group(this.snapshot.relations.filter((edge) => edge.kind === "IMPORTS"), (key) => this.fileGroups.get(key)!);
    else raw = this.group(this.snapshot.relations.filter((edge) => edge.kind !== "CONTAINS"));
    const connections = (direction: "incoming" | "outgoing"): NodeConnection[] => raw
      .filter((edge) => direction === "incoming" ? edge.to === id : edge.from === id)
      .map((edge) => ({ edge, node: this.nodes.get(direction === "incoming" ? edge.from : edge.to)! }));
    const incoming = connections("incoming");
    const outgoing = connections("outgoing");
    const proofs = new Map(this.snapshot.evidence.map((proof) => [proof.id, proof]));
    return {
      node, files: node.kind === "module" ? this.files.filter((file) => file.moduleId === id) : [],
      symbols: node.kind === "file" ? [...this.nodes.values()].filter((item) => item.fileId === id && item.id !== id && this.significant(item)) : [],
      incoming: incoming.slice(0, 40), outgoing: outgoing.slice(0, 40), hiddenConnections: Math.max(0, incoming.length - 40) + Math.max(0, outgoing.length - 40),
      unresolved: this.snapshot.unresolved.filter((item) => item.from === id).slice(0, 30).map((item) => ({ id: item.id, kind: item.kind, reason: item.reason, excerpt: proofs.get(item.evidenceId)!.excerpt, evidenceId: item.evidenceId })),
    };
  }
}
