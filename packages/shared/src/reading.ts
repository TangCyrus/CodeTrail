import type { EvidenceRecord, ExplorerNode, SourceRange } from "./index.js";

export type RecommendationCategory = "entry" | "workflow" | "shared";
export interface RecommendationReason {
  code: string;
  text: string;
  origin: "static" | "rule";
  evidenceIds: string[];
}
export interface CodeRecommendation {
  node: ExplorerNode;
  category: RecommendationCategory;
  reasons: RecommendationReason[];
  metrics: { referencingFiles: number; connectedModules: number; directCallees: number; exported: boolean };
}
export interface ReadingStep {
  order: number;
  node: ExplorerNode;
  kind: "entry" | "follow" | "supplement";
  reason: string;
  evidenceIds: string[];
  fromNodeId?: string;
  viaRelationId?: string;
}
export interface ReadingOptions { focusNodeIds?: string[] }
export interface ReadingGuide {
  snapshotId: string;
  algorithmVersion: string;
  groups: { id: RecommendationCategory; title: string; description: string; items: CodeRecommendation[] }[];
  readingOrder: ReadingStep[];
  excludedFiles: number;
  scope: { mode: "project" | "focused"; focusNodeIds: string[]; deferredExampleFiles: number };
  limitations: string[];
}
export interface ReadingBookmark {
  key: string;
  savedNode: Pick<ExplorerNode, "name" | "path" | "kind">;
  node: ExplorerNode | null;
  read: boolean;
  addedAt: string;
}
export interface ReadingList { items: ReadingBookmark[]; readCount: number; total: number }

export type ExplanationAction = "explain" | "importance" | "neighbors";
export type ReadingAudience = "guided" | "compact";
export interface CitedFact { text: string; evidenceIds: string[]; origin: "static" | "rule" }
export interface ContextEvidence extends EvidenceRecord {
  filePath: string;
  shownRange: SourceRange;
  truncated: boolean;
}
export interface ExplanationPreview {
  previewId: string;
  snapshotId: string;
  node: ExplorerNode;
  action: ExplanationAction;
  audience: ReadingAudience;
  facts: CitedFact[];
  evidence: ContextEvidence[];
  fileScope: { path: string; hash: string; snippets: number }[];
  characters: number;
  truncated: boolean;
  stale: boolean;
  limitations: string[];
}
export interface AIStatus {
  provider: "OpenAI Responses API";
  configured: boolean;
  enabled: boolean;
  model: string | null;
  destination: string;
  missing: string[];
  limits: { inputCharacters: number; outputTokens: number; timeoutMs: number; concurrent: number };
}
export interface CitedInterpretation { text: string; evidenceIds: string[]; kind: "explanation" | "hypothesis" }
export interface AIInterpretation { summary: CitedInterpretation; details: CitedInterpretation[]; uncertainties: string[] }
export type FallbackReason = "not_configured" | "disabled" | "no_evidence" | "busy" | "timeout" | "cancelled" | "provider_error" | "invalid_output";
export interface CodeExplanation {
  id: string;
  snapshotId: string;
  nodeId: string;
  action: ExplanationAction;
  audience: ReadingAudience;
  source: "local" | "ai";
  facts: CitedFact[];
  interpretation: AIInterpretation | null;
  evidence: ContextEvidence[];
  model: string | null;
  generatedAt: string;
  cacheHit: boolean;
  fallbackReason: FallbackReason | null;
  contextHash: string;
}
