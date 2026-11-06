import { randomBytes, timingSafeEqual, createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";
import type { AnalysisJob, EvidenceDetail, SessionInfo, SourceWindow } from "@codegraph/shared";
import { AnalysisManager } from "./analysis-manager.js";
import { recommendReading } from "@codegraph/graph";
import type { ExplanationAction, ReadingAudience } from "@codegraph/shared";
import { ExplanationService, type OpenAIConfiguration } from "./ai.js";
import { buildExplanationPreview } from "./explanation-context.js";
import { ComparisonManager } from "./comparison-manager.js";
import { inspectGit, publicBaseline } from "./git.js";
import type { ComparisonSide, ComparisonSourceWindow, SourceRange } from "@codegraph/shared";

export interface LocalServerOptions { rootDir: string; dataDirectory?: string; token?: string; autoAnalyze?: boolean; webDirectory?: string; ai?: OpenAIConfiguration }
class HttpError extends Error { constructor(readonly statusCode: number, message: string) { super(message); } }
const paramsSchema = { type: "object", required: ["id"], properties: { id: { type: "string", minLength: 1, maxLength: 256 } } };
const booleanOption = { type: "boolean" };

export async function createLocalServer(options: LocalServerOptions) {
  const rootDir = realpathSync(path.resolve(options.rootDir));
  const token = options.token ?? randomBytes(32).toString("base64url");
  if (token.length < 24) throw new Error("Session token must have at least 24 characters");
  const dataDirectory = options.dataDirectory ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"), "CodeGraph", "cache");
  const manager = new AnalysisManager(rootDir, dataDirectory);
  let ai: ExplanationService;
  try { ai = new ExplanationService(manager.store, options.ai); }
  catch (error) { await manager.close(); throw error; }
  const comparisons = new ComparisonManager(rootDir, manager.store);
  const app = Fastify({ logger: false, bodyLimit: 1024, ajv: { customOptions: { removeAdditional: false } }, forceCloseConnections: true });
  let origin = "http://127.0.0.1";
  let expectedHost = "127.0.0.1";
  function authorize(value: string | undefined): boolean {
    if (!value?.startsWith("Bearer ")) return false;
    const provided = Buffer.from(value.slice(7));
    const expected = Buffer.from(token);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
  }
  app.addHook("onRequest", async (request, reply) => {
    if (request.headers.host !== expectedHost) return reply.code(403).send({ message: "仅支持终端链接中的本地地址。" });
    if (request.headers.origin && request.headers.origin !== origin) return reply.code(403).send({ message: "请求来源与本地工作台不一致。" });
    if (request.url.split("?")[0]!.startsWith("/api/") && !authorize(request.headers.authorization)) return reply.code(401).send({ message: "请使用终端输出的完整会话链接打开工作台。" });
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cross-Origin-Resource-Policy", "same-origin");
    reply.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  });
  app.setErrorHandler((error, _request, reply) => {
    const detail: Error & { statusCode?: number } = error instanceof Error ? error : new Error("Unknown server error");
    const status = typeof detail.statusCode === "number" && detail.statusCode >= 400 && detail.statusCode < 500 ? detail.statusCode : 500;
    reply.code(status).send({ message: status < 500 ? detail.message : "本地服务未能完成请求，请重试。" });
  });
  const explorer = (id: string) => {
    const result = manager.explorer(id);
    if (!result) throw new HttpError(404, "这份快照不存在或已清理，请刷新项目。");
    return result;
  };

  app.get("/api/session", async (): Promise<SessionInfo> => ({ projectName: path.basename(rootDir), rootDir, latestSnapshotId: manager.latest?.id ?? null, job: manager.job() }));
  app.get("/api/git", async () => publicBaseline(await inspectGit(rootDir)));
  app.get("/api/comparisons/latest", async () => ({ report: comparisons.latest(), job: comparisons.job() }));
  app.post("/api/comparisons", { schema: { body: { type: "object", additionalProperties: false, properties: {} } } }, async (_request, reply) => reply.code(202).send(comparisons.start()));
  app.get<{ Params: { id: string } }>("/api/comparison-jobs/:id", async (request) => {
    const job = comparisons.job(request.params.id);
    if (!job) throw new HttpError(404, "比较任务不存在。");
    return job;
  });
  app.delete<{ Params: { id: string } }>("/api/comparison-jobs/:id", async (request) => {
    if (!await comparisons.cancel(request.params.id)) throw new HttpError(409, "比较任务已结束。");
    return comparisons.job(request.params.id);
  });
  app.get<{ Params: { id: string }; Querystring: { includeTypes?: boolean } }>("/api/comparisons/:id/impact", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { includeTypes: { type: "boolean" } } } },
  }, async (request) => {
    const report = comparisons.report(request.params.id, request.query.includeTypes);
    if (!report) throw new HttpError(404, "比较结果不存在或已清理，请重新比较。");
    return report;
  });
  app.get<{ Params: { id: string } }>("/api/comparisons/:id/status", async (request) => ({ stale: await comparisons.stale(request.params.id) }));
  app.get<{ Params: { id: string; side: string; fileId: string }; Querystring: { line?: number; symbol?: string; evidence?: string; change?: string; hunk?: number } }>("/api/comparisons/:id/:side/files/:fileId", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { line: { type: "integer", minimum: 1, maximum: 1_000_000 }, symbol: { type: "string", maxLength: 256 }, evidence: { type: "string", maxLength: 256 }, change: { type: "string", maxLength: 256 }, hunk: { type: "integer", minimum: 0, maximum: 100 } } } },
  }, async (request): Promise<ComparisonSourceWindow> => {
    const { id, side, fileId } = request.params;
    if (side !== "base" && side !== "current") throw new HttpError(404, "比较版本不存在。");
    const bundle = comparisons.bundle(id), captured = bundle?.[side as ComparisonSide];
    if (!bundle || !captured) throw new HttpError(404, "比较版本不存在或已清理。");
    const snapshot = captured.snapshot;
    const file = snapshot.files.find((item) => item.id === fileId);
    const content = file ? captured.sources.find((item) => item.path === file.path)?.content : undefined;
    if (!file || content === undefined) throw new HttpError(404, "文件未进入该版本快照。");
    const proof = request.query.evidence ? snapshot.evidence.find((item) => item.id === request.query.evidence && item.fileId === file.id) : undefined;
    const symbol = request.query.symbol ? snapshot.symbols.find((item) => item.id === request.query.symbol && item.fileId === file.id) : undefined;
    if (request.query.evidence && !proof || request.query.symbol && !symbol) throw new HttpError(400, "证据或符号与该版本文件不匹配。");
    let highlight: SourceRange | undefined = proof?.range ?? symbol?.range;
    const all = content.split(/\r\n|\n|\r/);
    if (request.query.change || request.query.hunk !== undefined) {
      const change = bundle.report.changes.find((item) => item.id === request.query.change);
      const hunk = change?.hunks[request.query.hunk ?? -1];
      const changeFile = side === "base" ? change?.oldFile : change?.newFile;
      if (!hunk || changeFile?.id !== file.id) throw new HttpError(400, "改动范围与版本文件不匹配。");
      const first = side === "base" ? hunk.oldStart : hunk.newStart, count = side === "base" ? hunk.oldLines : hunk.newLines;
      if (count > 0) {
        const starts = [0];
        for (const match of content.matchAll(/\r\n|\n|\r/g)) starts.push(match.index + match[0].length);
        const end = Math.min(all.length, first + count - 1);
        highlight = { start: { line: first, column: 1 }, end: { line: end, column: all[end - 1]!.length + 1 }, startOffset: starts[first - 1]!, endOffset: starts[end - 1]! + all[end - 1]!.length };
      }
    }
    const start = Math.min(all.length, request.query.line ?? Math.max(1, (highlight?.start.line ?? 1) - 5)), end = Math.min(all.length, start + 119);
    let matchesCurrentFile = false;
    try {
      const absolute = realpathSync(path.resolve(rootDir, file.path)), relative = path.relative(rootDir, absolute);
      if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) matchesCurrentFile = createHash("sha256").update(readFileSync(absolute)).digest("hex") === file.hash;
    } catch { /* Historical evidence remains readable after deletion. */ }
    return { side, head: bundle.report.baseline.head, comparisonCreatedAt: bundle.report.createdAt, file, startLine: start, endLine: end, totalLines: all.length, lines: all.slice(start - 1, end).map((text, index) => ({ number: start + index, text })), matchesCurrentFile, ...(highlight ? { highlight } : {}) };
  });
  app.get("/api/ai", async () => ai.status());
  app.patch<{ Body: { enabled: boolean } }>("/api/ai", { schema: { body: { type: "object", additionalProperties: false, required: ["enabled"], properties: { enabled: { type: "boolean" } } } } }, async (request) => {
    try { return ai.setEnabled(request.body.enabled); }
    catch { throw new HttpError(409, "请在本地服务端配置 OpenAI 密钥和模型后重新启动服务。"); }
  });
  app.delete("/api/ai/cache", async () => { ai.clearCache(); return { cleared: true }; });
  app.get<{ Params: { id: string } }>("/api/snapshots/:id/reading", { schema: { params: paramsSchema } }, async (request) => {
    const model = explorer(request.params.id);
    return recommendReading(model.snapshot, model);
  });
  app.get<{ Params: { id: string } }>("/api/snapshots/:id/reading-list", { schema: { params: paramsSchema } }, async (request) => manager.store.readingList(explorer(request.params.id)));
  app.post<{ Params: { id: string }; Body: { nodeId: string } }>("/api/snapshots/:id/reading-list", {
    schema: { params: paramsSchema, body: { type: "object", additionalProperties: false, required: ["nodeId"], properties: { nodeId: { type: "string", minLength: 1, maxLength: 512 } } } },
  }, async (request) => {
    const model = explorer(request.params.id);
    const node = model.nodes.get(request.body.nodeId);
    if (!node) throw new HttpError(404, "该节点不在当前快照中。");
    manager.store.bookmark(node);
    return manager.store.readingList(model);
  });
  app.patch<{ Params: { key: string }; Body: { read: boolean } }>("/api/reading-list/:key", {
    schema: { body: { type: "object", additionalProperties: false, required: ["read"], properties: { read: { type: "boolean" } } } },
  }, async (request) => {
    if (!manager.store.updateBookmark(request.params.key, request.body.read)) throw new HttpError(404, "阅读记录不存在。");
    return { updated: true };
  });
  app.delete<{ Params: { key: string } }>("/api/reading-list/:key", async (request) => {
    if (!manager.store.removeBookmark(request.params.key)) throw new HttpError(404, "阅读记录不存在。");
    return { removed: true };
  });
  const explanationFields = {
    nodeId: { type: "string", minLength: 1, maxLength: 512 },
    action: { type: "string", enum: ["explain", "importance", "neighbors"] },
    audience: { type: "string", enum: ["guided", "compact"] },
  };
  type ExplanationBody = { nodeId: string; action: ExplanationAction; audience: ReadingAudience };
  const preview = (id: string, body: ExplanationBody) => {
    const model = explorer(id);
    if (!model.nodes.has(body.nodeId)) throw new HttpError(404, "解释节点不存在。");
    try { return buildExplanationPreview(model, manager.store, body.nodeId, body.action, body.audience, manager.stale(id)); }
    catch { throw new HttpError(409, "这份快照的源码证据已不可用，请刷新分析后重试。"); }
  };
  app.post<{ Params: { id: string }; Body: ExplanationBody }>("/api/snapshots/:id/explanations/preview", {
    schema: { params: paramsSchema, body: { type: "object", additionalProperties: false, required: ["nodeId", "action", "audience"], properties: explanationFields } },
  }, async (request) => preview(request.params.id, request.body));
  app.post<{ Params: { id: string }; Body: ExplanationBody & { source: "local" | "ai"; approvedPreviewId?: string } }>("/api/snapshots/:id/explanations", {
    schema: { params: paramsSchema, body: { type: "object", additionalProperties: false, required: ["nodeId", "action", "audience", "source"], properties: { ...explanationFields, source: { type: "string", enum: ["local", "ai"] }, approvedPreviewId: { type: "string", minLength: 64, maxLength: 64 } } } },
  }, async (request, reply) => {
    const context = preview(request.params.id, request.body);
    if (request.body.source === "local") return ai.local(context);
    if (request.body.approvedPreviewId !== context.previewId) throw new HttpError(409, "发送范围与预览不一致，请重新预览后再发起 AI 解释。");
    const controller = new AbortController();
    const closed = () => { if (!reply.raw.writableEnded) controller.abort(); };
    reply.raw.on("close", closed);
    try { return await ai.generate(context, controller.signal); }
    finally { reply.raw.off("close", closed); }
  });
  app.post<{ Params: { resultId: string }; Body: { value: "helpful" | "incorrect" } }>("/api/explanations/:resultId/feedback", {
    schema: { body: { type: "object", additionalProperties: false, required: ["value"], properties: { value: { type: "string", enum: ["helpful", "incorrect"] } } } },
  }, async (request) => {
    const id = request.params.resultId;
    const key = id.startsWith("explanation:") ? id.slice("explanation:".length) : "";
    const result = manager.store.explanation(key);
    if (!result || result.id !== id) throw new HttpError(404, "解释结果不存在或已清理。");
    manager.store.feedback(id, request.body.value);
    if (request.body.value === "incorrect") manager.store.removeExplanation(key);
    return { recorded: true };
  });
  app.post("/api/analyses", { schema: { body: { type: "object", additionalProperties: false, properties: {} } } }, async (_request, reply) => reply.code(202).send(manager.start()));
  app.get<{ Params: { id: string } }>("/api/analyses/:id", { schema: { params: paramsSchema } }, async (request) => {
    const job = manager.job(request.params.id);
    if (!job) throw new HttpError(404, "分析任务不存在。");
    return job;
  });
  app.delete<{ Params: { id: string } }>("/api/analyses/:id", { schema: { params: paramsSchema } }, async (request) => {
    if (!await manager.cancel(request.params.id)) throw new HttpError(409, "任务已结束，当前无需取消。");
    return manager.job(request.params.id);
  });
  app.get<{ Params: { id: string } }>("/api/analyses/:id/events", { schema: { params: paramsSchema } }, async (request, reply) => {
    const initial = manager.job(request.params.id);
    if (!initial) throw new HttpError(404, "分析任务不存在。");
    reply.hijack();
    reply.raw.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", "X-Content-Type-Options": "nosniff" });
    let unsubscribe = (): void => {};
    let heartbeat: NodeJS.Timeout | undefined;
    const close = (): void => { unsubscribe(); if (heartbeat) clearInterval(heartbeat); };
    const send = (job: AnalysisJob): void => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      reply.raw.write(`event: progress\ndata: ${JSON.stringify(job)}\n\n`);
      if (job.status !== "running") { close(); reply.raw.end(); }
    };
    unsubscribe = manager.subscribe(initial.id, send);
    heartbeat = setInterval(() => { if (!reply.raw.destroyed) reply.raw.write(": heartbeat\n\n"); }, 15_000);
    reply.raw.on("close", close);
    send(initial);
  });
  app.get<{ Params: { id: string } }>("/api/snapshots/:id/overview", { schema: { params: paramsSchema } }, async (request) => explorer(request.params.id).overview(manager.stale(request.params.id)));
  app.get<{ Params: { id: string } }>("/api/snapshots/:id/status", { schema: { params: paramsSchema } }, async (request) => { explorer(request.params.id); return { stale: manager.stale(request.params.id) }; });
  app.get<{ Params: { id: string }; Querystring: { q?: string; limit?: number } }>("/api/snapshots/:id/search", {
    schema: { params: paramsSchema, querystring: { type: "object", additionalProperties: false, properties: { q: { type: "string", maxLength: 200 }, limit: { type: "integer", minimum: 1, maximum: 100 } } } },
  }, async (request) => explorer(request.params.id).search(request.query.q ?? "", request.query.limit));
  app.get<{ Params: { id: string }; Querystring: { focus?: string; depth?: number; includeTypes?: boolean; includeReferences?: boolean; includeCandidates?: boolean; maxNodes?: number } }>("/api/snapshots/:id/graph", {
    schema: { params: paramsSchema, querystring: { type: "object", additionalProperties: false, properties: {
      focus: { type: "string", minLength: 1, maxLength: 512 }, depth: { type: "integer", minimum: 1, maximum: 2 }, maxNodes: { type: "integer", minimum: 1, maximum: 100 }, includeTypes: booleanOption, includeReferences: booleanOption, includeCandidates: booleanOption,
    } } },
  }, async (request) => {
    try { return explorer(request.params.id).graph(request.query); }
    catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(404, "图谱位置不存在，请返回概览。"); }
  });
  app.get<{ Params: { id: string; nodeId: string } }>("/api/snapshots/:id/nodes/:nodeId", async (request) => {
    const model = explorer(request.params.id);
    if (!model.nodes.has(request.params.nodeId)) throw new HttpError(404, "节点不存在。");
    return model.detail(request.params.nodeId);
  });
  app.get<{ Params: { id: string; evidenceId: string } }>("/api/snapshots/:id/evidence/:evidenceId", async (request): Promise<EvidenceDetail> => {
    const snapshot = explorer(request.params.id).snapshot;
    const proof = snapshot.evidence.find((item) => item.id === request.params.evidenceId);
    if (!proof) throw new HttpError(404, "源码证据不存在。");
    return { id: proof.id, fileId: proof.fileId, filePath: snapshot.files.find((file) => file.id === proof.fileId)!.path, range: proof.range, excerpt: proof.excerpt, fileHash: proof.fileHash };
  });
  app.get<{ Params: { id: string; fileId: string }; Querystring: { line?: number; evidence?: string; symbol?: string } }>("/api/snapshots/:id/files/:fileId", {
    schema: { querystring: { type: "object", additionalProperties: false, properties: { line: { type: "integer", minimum: 1, maximum: 1_000_000 }, evidence: { type: "string", maxLength: 256 }, symbol: { type: "string", maxLength: 256 } } } },
  }, async (request): Promise<SourceWindow> => {
    const snapshot = explorer(request.params.id).snapshot;
    const file = snapshot.files.find((item) => item.id === request.params.fileId);
    if (!file) throw new HttpError(404, "该文件未纳入这份快照。");
    const content = manager.store.source(snapshot.id, file.id);
    if (content === null) throw new HttpError(404, "这份快照的源码不可用，请重新分析。");
    const proof = request.query.evidence ? snapshot.evidence.find((item) => item.id === request.query.evidence && item.fileId === file.id) : undefined;
    const symbol = request.query.symbol ? snapshot.symbols.find((item) => item.id === request.query.symbol && item.fileId === file.id) : undefined;
    if (request.query.evidence && !proof || request.query.symbol && !symbol) throw new HttpError(400, "源码位置与文件不匹配。");
    const highlight = proof?.range ?? symbol?.range;
    const all = content.split(/\r\n|\n|\r/);
    const start = Math.min(all.length, request.query.line ?? Math.max(1, (highlight?.start.line ?? 1) - 5));
    const end = Math.min(all.length, start + 119);
    let matchesCurrentFile = false;
    try {
      const absolute = realpathSync(path.resolve(rootDir, file.path));
      const relative = path.relative(rootDir, absolute);
      if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) matchesCurrentFile = createHash("sha256").update(readFileSync(absolute)).digest("hex") === file.hash;
    } catch { /* Show preserved snapshot content even if the current file was deleted. */ }
    return { file, startLine: start, endLine: end, totalLines: all.length, lines: all.slice(start - 1, end).map((text, index) => ({ number: start + index, text })), matchesCurrentFile, ...(highlight ? { highlight } : {}) };
  });
  const webDirectory = options.webDirectory ?? fileURLToPath(new URL("../../web/dist/", import.meta.url));
  if (existsSync(path.join(webDirectory, "index.html"))) await app.register(fastifyStatic, { root: webDirectory, index: ["index.html"], cacheControl: false, dotfiles: "deny" });
  else app.get("/", async (_request, reply) => reply.code(503).type("text/plain").send("浏览器界面尚未构建。请先运行 npm run build。"));
  app.setNotFoundHandler(async (_request, reply) => reply.code(404).send({ message: "请求的位置不存在。" }));
  app.addHook("onClose", async () => { ai.close(); await comparisons.close(); await manager.close(); });
  return {
    app, manager, comparisons, token,
    async listen(port = 4317): Promise<string> {
      await app.listen({ host: "127.0.0.1", port });
      const address = app.server.address();
      if (!address || typeof address === "string") throw new Error("Unable to obtain server address");
      expectedHost = `127.0.0.1:${address.port}`;
      origin = `http://${expectedHost}`;
      if (options.autoAnalyze !== false && !manager.latest) manager.start();
      return `${origin}/#session=${token}`;
    },
  };
}
