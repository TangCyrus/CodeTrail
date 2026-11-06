import type { AnalysisSnapshot, CapturedSource, ExplorerNode, RelationKind, SourceWindow } from "./index.js";

export type ComparisonSide = "base" | "current";
export interface GitBaseline {
  state: "ready" | "no_head" | "not_repository" | "unavailable";
  head: string | null;
  scope: string;
  message: string;
}
export interface ChangeHunk { oldStart: number; oldLines: number; newStart: number; newLines: number; coarse: boolean }
export type SymbolChangeKind = "added" | "deleted" | "modified" | "signature" | "export" | "moved" | "ambiguous" | "unchanged";
export interface SymbolMapping {
  oldNode: ExplorerNode | null;
  newNode: ExplorerNode | null;
  kind: SymbolChangeKind;
  basis: "identity" | "rename-candidate" | "none" | "ambiguous";
}
export interface FileChange {
  id: string;
  kind: "added" | "modified" | "deleted" | "rename_candidate" | "scope";
  oldFile: ExplorerNode | null;
  newFile: ExplorerNode | null;
  untracked: boolean;
  mappingNote: string;
  hunks: ChangeHunk[];
  symbols: SymbolMapping[];
  truncated: boolean;
}
export interface ImpactStep {
  from: ExplorerNode;
  to: ExplorerNode;
  kind: RelationKind;
  usage: "type" | "value" | "mixed";
  evidenceId: string;
  supportingEvidenceIds?: string[];
}
export interface ComparisonPath {
  id: string;
  changeId: string;
  side: ComparisonSide;
  seed: ExplorerNode;
  target: ExplorerNode;
  distance: number;
  steps: ImpactStep[];
  dependency: "value" | "type" | "mixed";
  test: boolean;
}
export interface ComparisonReport {
  id: string;
  createdAt: string;
  baseline: GitBaseline;
  currentSnapshotId: string;
  baseSnapshotId: string | null;
  stale: boolean;
  changes: FileChange[];
  paths: ComparisonPath[];
  includeTypes: boolean;
  maxDepth: number;
  maxPaths: number;
  truncated: boolean;
  statistics: { files: number; symbols: number; paths: number; testFiles: number; oldUnresolved: number; newUnresolved: number };
  resolutionSummary?: { base: import("./index.js").ResolutionSummary | null; current: import("./index.js").ResolutionSummary };
  limitations: string[];
}
export interface ComparisonBundle {
  report: ComparisonReport;
  base: { snapshot: AnalysisSnapshot; sources: CapturedSource[] } | null;
  current: { snapshot: AnalysisSnapshot; sources: CapturedSource[] };
}
export interface ComparisonJob {
  id: string;
  status: "running" | "completed" | "failed" | "cancelled";
  phase: "git" | "baseline" | "current" | "mapping" | "saving";
  startedAt: string;
  comparisonId?: string;
  error?: string;
}
export interface ComparisonSourceTarget {
  comparisonId: string;
  side: ComparisonSide;
  fileId: string;
  symbol?: string;
  evidence?: string;
  line?: number;
  change?: string;
  hunk?: number;
}
export interface ComparisonSourceWindow extends SourceWindow { side: ComparisonSide; head: string | null; comparisonCreatedAt: string }
