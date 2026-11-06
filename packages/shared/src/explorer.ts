import type { AnalysisDiagnostic, AnalysisSnapshot, RelationKind, ResolutionSummary, SourceFileRecord, SourceRange, SymbolKind } from "./index.js";

export type AnalysisPhase = "queued" | "scanning" | "compiling" | "extracting" | "verifying" | "saving";
export interface AnalysisJob {
  id: string;
  status: "running" | "completed" | "cancelled" | "failed";
  phase: AnalysisPhase;
  startedAt: string;
  snapshotId?: string;
  error?: string;
}
export interface CapturedSource { path: string; content: string; hash: string }
export interface ExplorerNode {
  id: string;
  name: string;
  path: string;
  kind: SymbolKind | "module" | "file";
  moduleId: string;
  fileId?: string;
  fileCount?: number;
  symbolCount?: number;
  signature?: string;
  exported?: boolean;
  range?: SourceRange;
}
export interface ExplorerEdge {
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  origin: "static" | "rule";
  count: number;
  evidenceIds: string[];
  supportingEvidenceIds?: string[];
  usage?: "type" | "value" | "mixed";
}
export interface Breadcrumb { id: string | null; label: string; kind: "overview" | "module" | "file" | "symbol" }
export interface ExplorerGraph {
  nodes: ExplorerNode[];
  edges: ExplorerEdge[];
  breadcrumbs: Breadcrumb[];
  title: string;
  scope: "overview" | "module" | "file" | "symbol";
  totalNodes: number;
  hiddenNodes: number;
  truncated: boolean;
}
export interface ProjectOverview {
  snapshotId: string;
  name: string;
  rootDir: string;
  createdAt: string;
  status: AnalysisSnapshot["status"];
  stale: boolean;
  statistics: AnalysisSnapshot["statistics"];
  resolutionSummary: ResolutionSummary;
  modules: ExplorerNode[];
  files: ExplorerNode[];
  diagnostics: AnalysisDiagnostic[];
  skippedCount: number;
  limitations: string[];
}
export interface SearchResults { query: string; total: number; results: ExplorerNode[]; truncated: boolean }
export interface NodeConnection { edge: ExplorerEdge; node: ExplorerNode }
export interface NodeDetail {
  node: ExplorerNode;
  files: ExplorerNode[];
  symbols: ExplorerNode[];
  incoming: NodeConnection[];
  outgoing: NodeConnection[];
  hiddenConnections: number;
  unresolved: { id: string; kind: string; reason: string; excerpt: string; evidenceId: string; reasonDetail?: import("./index.js").UnresolvedRecord["reasonDetail"] }[];
  externalReferences: NodeDetail["unresolved"];
  resolutionSummary: ResolutionSummary;
}
export interface SourceWindow {
  file: SourceFileRecord;
  startLine: number;
  endLine: number;
  totalLines: number;
  lines: { number: number; text: string }[];
  matchesCurrentFile: boolean;
  highlight?: SourceRange;
}
export interface SessionInfo {
  projectName: string;
  rootDir: string;
  latestSnapshotId: string | null;
  job: AnalysisJob | null;
}
export interface EvidenceDetail { id: string; fileId: string; filePath: string; range: SourceRange; excerpt: string; fileHash: string }
