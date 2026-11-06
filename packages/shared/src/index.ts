/** All source positions use one-based lines/columns and UTF-16 offsets. */
export interface Position { line: number; column: number }
export interface SourceRange {
  start: Position;
  end: Position;
  startOffset: number;
  endOffset: number;
}

export type RelationKind =
  | "CONTAINS" | "IMPORTS" | "CALLS" | "REFERENCES" | "RENDERS" | "REGISTERS_CALLBACK";
export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "type" | "variable" | "parameter" | "property" | "enum";
export type EvidenceOrigin = "static" | "rule";

export interface SourceFileRecord {
  id: string;
  path: string;
  hash: string;
  language: "ts" | "tsx" | "js" | "jsx";
  bytes: number;
  lineCount: number;
  parseStatus: "ok" | "error";
}

export interface SymbolRecord {
  id: string;
  fileId: string;
  name: string;
  qualifiedName: string;
  kind: SymbolKind;
  parentId: string;
  range: SourceRange;
  signature: string;
  exported: boolean;
}

export interface EvidenceRecord {
  id: string;
  fileId: string;
  fileHash: string;
  range: SourceRange;
  excerpt: string;
  extractor: string;
}

export interface RelationRecord {
  id: string;
  from: string;
  to: string;
  kind: RelationKind;
  origin: EvidenceOrigin;
  resolution: "syntax" | "compiler-symbol" | "callback-argument-rule" | "value-origin";
  evidenceId: string;
  /** Additional captured source proving a bounded value-origin resolution. */
  supportingEvidenceIds?: string[];
  /** IMPORTS and REFERENCES distinguish type-only uses from value uses. */
  usage?: "type" | "value" | "mixed";
}

export interface UnresolvedRecord {
  id: string;
  from: string;
  kind: "IMPORTS" | "CALLS" | "REFERENCES" | "RENDERS";
  reason: "dynamic" | "ambiguous" | "external" | "unresolved" | "excluded" | "unsupported";
  evidenceId: string;
  candidateIds: string[];
  /** Why an object/interface call could not be pinned to a concrete source value. */
  reasonDetail?: { code: string; message: string; evidenceIds: string[] };
}

export interface AnalysisDiagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  path?: string;
  range?: SourceRange;
}

export interface ResolutionSummary {
  /** Compatibility total: all sites without an indexed target, including external references. */
  totalUnlinked: number;
  external: number;
  gaps: number;
  byReason: Record<UnresolvedRecord["reason"], number>;
}
export function summarizeResolution(records: readonly UnresolvedRecord[]): ResolutionSummary {
  const byReason: ResolutionSummary["byReason"] = { dynamic: 0, ambiguous: 0, external: 0, unresolved: 0, excluded: 0, unsupported: 0 };
  for (const record of records) byReason[record.reason]++;
  return { totalUnlinked: records.length, external: byReason.external, gaps: records.length - byReason.external, byReason };
}

export interface SkippedPath {
  path: string;
  reason: "ignored" | "symlink" | "size-limit" | "file-limit" | "unreadable" | "encoding";
}

export interface AnalysisSnapshot {
  schemaVersion: "0.1";
  id: string;
  rootDir: string;
  createdAt: string;
  status: "complete" | "partial";
  stale: boolean;
  analyzer: { name: string; version: string; compilerVersion: string };
  configuration: { path: string | null; hash: string; inputs?: { path: string; hash: string }[]; missingInputs?: string[] };
  scope?: { maxFiles: number; maxFileBytes: number };
  files: SourceFileRecord[];
  symbols: SymbolRecord[];
  relations: RelationRecord[];
  evidence: EvidenceRecord[];
  unresolved: UnresolvedRecord[];
  /** Derived on demand for older persisted snapshots as well. */
  resolutionSummary?: ResolutionSummary;
  diagnostics: AnalysisDiagnostic[];
  skipped: SkippedPath[];
  statistics: {
    files: number;
    symbols: number;
    relations: number;
    unresolved: number;
    parseErrors: number;
    durationMs: number;
  };
  limitations: string[];
}

export type * from "./explorer.js";
export type * from "./reading.js";
export type * from "./comparison.js";

export interface AnalyzeRequest {
  rootDir: string;
  maxFiles?: number;
  maxFileBytes?: number;
}

/** Keep compiler-specific nodes and symbols behind this boundary. */
export interface AnalyzerAdapter {
  readonly name: string;
  analyze(request: AnalyzeRequest): AnalysisSnapshot;
}

/** Validate typed graph integrity before publishing. Not an untrusted-JSON parser. */
export function assertSnapshotIntegrity(snapshot: AnalysisSnapshot): void {
  if (snapshot.schemaVersion !== "0.1") throw new Error("Unsupported snapshot schema");
  const files = new Map(snapshot.files.map((file) => [file.id, file]));
  const symbols = new Map(snapshot.symbols.map((symbol) => [symbol.id, symbol]));
  const evidence = new Map(snapshot.evidence.map((entry) => [entry.id, entry]));
  const nodes = new Set([...files.keys(), ...symbols.keys()]);
  for (const [label, items] of [
    ["file", snapshot.files], ["symbol", snapshot.symbols], ["evidence", snapshot.evidence],
    ["relation", snapshot.relations], ["unresolved", snapshot.unresolved],
  ] as const) {
    if (new Set(items.map((item) => item.id)).size !== items.length) throw new Error(`Duplicate ${label} ID`);
  }
  for (const symbol of snapshot.symbols) {
    if (!files.has(symbol.fileId) || !nodes.has(symbol.parentId)) throw new Error(`Dangling symbol: ${symbol.id}`);
  }
  for (const entry of snapshot.evidence) {
    const file = files.get(entry.fileId);
    if (!file || file.hash !== entry.fileHash) throw new Error(`Invalid evidence file: ${entry.id}`);
    if (entry.range.startOffset < 0 || entry.range.endOffset < entry.range.startOffset
      || entry.range.start.line < 1 || entry.range.end.line > file.lineCount
      || entry.range.start.column < 1 || entry.range.end.column < 1
      || entry.range.end.line < entry.range.start.line
      || entry.excerpt.length !== entry.range.endOffset - entry.range.startOffset) {
      throw new Error(`Invalid evidence range: ${entry.id}`);
    }
  }
  for (const edge of snapshot.relations) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to) || !evidence.has(edge.evidenceId)) {
      throw new Error(`Dangling relation: ${edge.id}`);
    }
    if (edge.kind === "REGISTERS_CALLBACK" && edge.origin !== "rule") throw new Error("Callback must be a rule candidate");
    if (edge.kind !== "REGISTERS_CALLBACK" && edge.origin !== "static") throw new Error("Parsed relation must be static");
    if (edge.supportingEvidenceIds?.some(id => !evidence.has(id))) throw new Error(`Dangling supporting evidence: ${edge.id}`);
  }
  for (const item of snapshot.unresolved) {
    if (!nodes.has(item.from) || !evidence.has(item.evidenceId)
      || item.candidateIds.some((id) => !nodes.has(id))) throw new Error(`Invalid unresolved item: ${item.id}`);
    if (item.reasonDetail?.evidenceIds.some(id => !evidence.has(id))) throw new Error(`Dangling dispatch evidence: ${item.id}`);
  }
  if (snapshot.statistics.files !== files.size || snapshot.statistics.symbols !== symbols.size
    || snapshot.statistics.relations !== snapshot.relations.length
    || snapshot.statistics.unresolved !== snapshot.unresolved.length) throw new Error("Inconsistent snapshot statistics");
  if (snapshot.resolutionSummary && JSON.stringify(snapshot.resolutionSummary) !== JSON.stringify(summarizeResolution(snapshot.unresolved))) throw new Error("Inconsistent resolution summary");
}
