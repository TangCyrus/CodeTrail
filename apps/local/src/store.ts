import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { assertSnapshotIntegrity, type AnalysisSnapshot, type CapturedSource, type CodeExplanation, type ExplorerNode, type ReadingList } from "@codegraph/shared";
import type { ProjectExplorer } from "@codegraph/graph";
import type { ComparisonBundle } from "@codegraph/shared";

const sha = (value: string): string => createHash("sha256").update(value).digest("hex");

export class SnapshotStore {
  private readonly db: DatabaseSync;
  readonly directory: string;

  constructor(baseDirectory: string, private readonly projectRoot: string) {
    this.directory = path.join(baseDirectory, sha(projectRoot).slice(0, 24));
    mkdirSync(this.directory, { recursive: true });
    this.db = new DatabaseSync(path.join(this.directory, "snapshots.sqlite"));
    try { this.db.exec(`
      PRAGMA foreign_keys = ON;
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS sources (
        snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL, hash TEXT NOT NULL, content TEXT NOT NULL,
        PRIMARY KEY (snapshot_id, file_id)
      );
      CREATE TABLE IF NOT EXISTS metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reading_bookmarks (key TEXT PRIMARY KEY, node TEXT NOT NULL, is_read INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explanations (key TEXT PRIMARY KEY, snapshot_id TEXT NOT NULL REFERENCES snapshots(id) ON DELETE CASCADE, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS explanation_feedback (result_id TEXT PRIMARY KEY, value TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comparisons (id TEXT PRIMARY KEY, created_at TEXT NOT NULL, body TEXT NOT NULL);
    `); } catch { this.db.close(); throw new Error("本地缓存无法打开。请检查缓存文件，或用 --data-dir 指定新的可写目录。"); }
  }

  latest(): AnalysisSnapshot | null {
    const pointer = this.db.prepare("SELECT value FROM metadata WHERE key = 'latest'").get();
    return pointer ? this.get(String(pointer.value)) : null;
  }

  get(id: string): AnalysisSnapshot | null {
    const row = this.db.prepare("SELECT body FROM snapshots WHERE id = ?").get(id);
    if (!row) return null;
    const snapshot = JSON.parse(String(row.body)) as AnalysisSnapshot;
    if (snapshot.rootDir !== this.projectRoot) throw new Error("Snapshot belongs to another project");
    assertSnapshotIntegrity(snapshot);
    return snapshot;
  }

  source(snapshotId: string, fileId: string): string | null {
    const row = this.db.prepare("SELECT content FROM sources WHERE snapshot_id = ? AND file_id = ?").get(snapshotId, fileId);
    return row ? String(row.content) : null;
  }

  save(snapshot: AnalysisSnapshot, sources: CapturedSource[]): void {
    assertSnapshotIntegrity(snapshot);
    if (snapshot.rootDir !== this.projectRoot) throw new Error("Snapshot root mismatch");
    const byPath = new Map(sources.map((source) => [source.path, source]));
    for (const file of snapshot.files) {
      const source = byPath.get(file.path);
      if (!source || source.hash !== file.hash || sha(source.content) !== file.hash) throw new Error(`Source content mismatch: ${file.path}`);
    }
    const paths = new Map(snapshot.files.map((file) => [file.id, file.path]));
    for (const proof of snapshot.evidence) {
      const source = byPath.get(paths.get(proof.fileId)!)!;
      if (source.content.slice(proof.range.startOffset, proof.range.endOffset) !== proof.excerpt) throw new Error("Source evidence mismatch");
    }
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO snapshots (id, created_at, body) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET created_at=excluded.created_at, body=excluded.body")
        .run(snapshot.id, snapshot.createdAt, JSON.stringify(snapshot));
      const insert = this.db.prepare("INSERT OR REPLACE INTO sources (snapshot_id, file_id, hash, content) VALUES (?, ?, ?, ?)");
      for (const file of snapshot.files) insert.run(snapshot.id, file.id, file.hash, byPath.get(file.path)!.content);
      this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('latest', ?)").run(snapshot.id);
      // Keep the three latest immutable content snapshots, including source evidence.
      this.db.exec("DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY created_at DESC, id DESC LIMIT 3)");
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }

  comparison(id: string): ComparisonBundle | null {
    const row = this.db.prepare("SELECT body FROM comparisons WHERE id = ?").get(id);
    return row ? JSON.parse(String(row.body)) as ComparisonBundle : null;
  }
  latestComparison(): ComparisonBundle | null {
    const row = this.db.prepare("SELECT value FROM metadata WHERE key = 'latest-comparison'").get();
    return row ? this.comparison(String(row.value)) : null;
  }
  saveComparison(bundle: ComparisonBundle): void {
    for (const captured of [bundle.base, bundle.current]) {
      if (!captured) continue;
      const { snapshot, sources } = captured;
      assertSnapshotIntegrity(snapshot);
      if (snapshot.rootDir !== this.projectRoot) throw new Error("Comparison root mismatch");
      const byPath = new Map(sources.map((source) => [source.path, source]));
      const files = new Map(snapshot.files.map((file) => [file.id, file]));
      for (const file of snapshot.files) if (sha(byPath.get(file.path)?.content ?? "") !== file.hash || byPath.get(file.path)?.hash !== file.hash) throw new Error("Comparison source hash mismatch");
      for (const proof of snapshot.evidence) if (byPath.get(files.get(proof.fileId)!.path)!.content.slice(proof.range.startOffset, proof.range.endOffset) !== proof.excerpt) throw new Error("Comparison evidence mismatch");
    }
    if (bundle.report.currentSnapshotId !== bundle.current.snapshot.id || bundle.report.baseSnapshotId !== (bundle.base?.snapshot.id ?? null)) throw new Error("Comparison versions mismatch");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT OR REPLACE INTO comparisons (id, created_at, body) VALUES (?, ?, ?)").run(bundle.report.id, bundle.report.createdAt, JSON.stringify(bundle));
      this.db.prepare("INSERT OR REPLACE INTO metadata (key, value) VALUES ('latest-comparison', ?)").run(bundle.report.id);
      this.db.exec("DELETE FROM comparisons WHERE id NOT IN (SELECT id FROM comparisons ORDER BY created_at DESC, id DESC LIMIT 3)");
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  readingList(model: ProjectExplorer): ReadingList {
    const items = this.db.prepare("SELECT key, node, is_read, added_at FROM reading_bookmarks ORDER BY added_at, key").all().map((row) => {
      const savedNode = JSON.parse(String(row.node)) as Pick<ExplorerNode, "name" | "path" | "kind">;
      const matches = [...model.nodes.values()].filter((node) => node.name === savedNode.name && node.path === savedNode.path && node.kind === savedNode.kind);
      return { key: String(row.key), savedNode, node: matches.length === 1 ? matches[0]! : null, read: row.is_read === 1, addedAt: String(row.added_at) };
    });
    return { items, readCount: items.filter((item) => item.read).length, total: items.length };
  }

  bookmark(node: ExplorerNode): string {
    const saved = { name: node.name, path: node.path, kind: node.kind };
    const key = sha(JSON.stringify(saved));
    this.db.prepare("INSERT INTO reading_bookmarks (key, node, is_read, added_at) VALUES (?, ?, 0, ?) ON CONFLICT(key) DO NOTHING").run(key, JSON.stringify(saved), new Date().toISOString());
    return key;
  }

  updateBookmark(key: string, read: boolean): boolean { return this.db.prepare("UPDATE reading_bookmarks SET is_read = ? WHERE key = ?").run(read ? 1 : 0, key).changes > 0; }
  removeBookmark(key: string): boolean { return this.db.prepare("DELETE FROM reading_bookmarks WHERE key = ?").run(key).changes > 0; }
  explanation(key: string): CodeExplanation | null {
    const row = this.db.prepare("SELECT body FROM explanations WHERE key = ?").get(key);
    return row ? JSON.parse(String(row.body)) as CodeExplanation : null;
  }
  saveExplanation(key: string, result: CodeExplanation): void {
    this.db.prepare("INSERT OR REPLACE INTO explanations (key, snapshot_id, body) VALUES (?, ?, ?)").run(key, result.snapshotId, JSON.stringify(result));
  }
  clearExplanations(): void { this.db.exec("DELETE FROM explanations"); }
  removeExplanation(key: string): void { this.db.prepare("DELETE FROM explanations WHERE key = ?").run(key); }
  feedback(resultId: string, value: "helpful" | "incorrect"): void {
    this.db.prepare("INSERT OR REPLACE INTO explanation_feedback (result_id, value, created_at) VALUES (?, ?, ?)").run(resultId, value, new Date().toISOString());
  }
}
