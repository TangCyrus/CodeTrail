import { useEffect, useRef, useState, type ReactNode } from "react";
import type { EvidenceDetail, ExplorerEdge, ExplorerNode, NodeConnection, NodeDetail, ProjectOverview, SourceWindow, ReadingList } from "@codetrail/shared";
import { ExplanationPanel } from "./ExplanationPanel.js";
import { api, ignoredAbort, messageOf, snapshotPath } from "./api.js";
import { Icon, InlineError, kindLabel, LoadingRows, NodeGlyph, relationLabel } from "./ui.js";

export interface SourceTarget { fileId: string; symbol?: string; evidence?: string; line?: number }
const reasons: Record<string, string> = { dynamic: "动态目标", ambiguous: "多个候选", external: "分析范围外", unresolved: "无法解析", excluded: "已排除", unsupported: "暂不支持" };

function tokens(text: string): ReactNode[] {
  const matcher = /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\/\/.*|\b(?:export|import|from|return|function|const|let|var|class|interface|type|extends|implements|new|if|else|async|await|number|string|boolean|void|null|true|false|declare|default)\b|\b\d+\b)/g;
  const result: ReactNode[] = [];
  let end = 0;
  for (const match of text.matchAll(matcher)) {
    if (match.index > end) result.push(text.slice(end, match.index));
    const value = match[0];
    result.push(<span key={match.index} className={value.startsWith("//") ? "token-comment" : /^["']/.test(value) ? "token-string" : "token-keyword"}>{value}</span>);
    end = match.index + value.length;
  }
  result.push(text.slice(end));
  return result;
}

export function CodeLines({ source }: { source: SourceWindow }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector("[data-highlight='true']")?.scrollIntoView({ block: "nearest" }); }, [source]);
  return <div className="source-code" ref={ref} tabIndex={0} aria-label={`${source.file.path} 源码，第 ${source.startLine} 至 ${source.endLine} 行`}>
    {source.lines.map((line) => {
      const range = source.highlight;
      const highlighted = !!range && line.number >= range.start.line && line.number <= range.end.line;
      const start = range && line.number === range.start.line ? range.start.column - 1 : 0;
      const end = range && line.number === range.end.line ? range.end.column - 1 : line.text.length;
      return <div className={`source-line ${highlighted ? "highlighted" : ""}`} key={line.number} data-highlight={highlighted}>
        <span className="line-number" aria-hidden="true">{line.number}</span>
        <code>{highlighted ? <>{tokens(line.text.slice(0, start))}<mark>{tokens(line.text.slice(start, end)) || " "}</mark>{tokens(line.text.slice(end))}</> : tokens(line.text) || " "}</code>
      </div>;
    })}
  </div>;
}

function ConnectionList({ title, connections, onNavigate, onEdge }: { title: string; connections: NodeConnection[]; onNavigate: (node: ExplorerNode) => void; onEdge: (edge: ExplorerEdge) => void }) {
  return <section className="connection-section"><h3>{title}<span>{connections.length}</span></h3>
    {connections.length ? connections.map(({ node, edge }) => <div className="connection-row" key={edge.id}>
      <button className="connection-target" onClick={() => onNavigate(node)}><NodeGlyph node={node}/><span><strong>{node.name}</strong><small>{relationLabel(edge.kind)}{edge.usage === "type" ? " · 类型" : ""} · {edge.count} 处</small></span></button>
      <button className="text-action" onClick={() => onEdge(edge)} aria-label={`查看 ${node.name} 的${relationLabel(edge.kind)}证据`}>证据</button>
    </div>) : <p className="quiet-empty">当前快照没有已解析的关联。</p>}
  </section>;
}

function EdgeInspector({ edge, snapshotId, onEvidence, onNavigate }: { edge: ExplorerEdge; snapshotId: string; onEvidence: (proof: EvidenceDetail) => void; onNavigate: (node: ExplorerNode) => void }) {
  const [proofs, setProofs] = useState<EvidenceDetail[] | null>(null);
  const [nodes, setNodes] = useState<NodeDetail[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    const controller = new AbortController();
    setProofs(null); setError("");
    void Promise.all([
      Promise.all([...new Set([...edge.evidenceIds, ...(edge.supportingEvidenceIds ?? [])])].map((id) => api<EvidenceDetail>(snapshotPath(snapshotId, `/evidence/${encodeURIComponent(id)}`), { signal: controller.signal }))),
      Promise.all([edge.from, edge.to].map((id) => api<NodeDetail>(snapshotPath(snapshotId, `/nodes/${encodeURIComponent(id)}`), { signal: controller.signal }))),
    ]).then(([result, endpoints]) => { setProofs(result); setNodes(endpoints); }).catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => controller.abort();
  }, [edge, snapshotId]);
  return <div className="inspector-body edge-details"><div className="section-heading"><h3>{relationLabel(edge.kind)}</h3><span className="neutral-tag">{edge.origin === "rule" ? "规则候选" : "静态解析"}</span></div>
    <p className="edge-definition">{edge.origin === "rule" ? "函数被作为参数传入；不能据此确定回调一定执行。" : "这条关系来自当前代码快照，可在下面的源码位置核实。"}</p>
    <div className="edge-endpoints">{nodes[0] && <button onClick={() => onNavigate(nodes[0]!.node)}>{nodes[0].node.name}</button>}<Icon name="arrow"/>{nodes[1] && <button onClick={() => onNavigate(nodes[1]!.node)}>{nodes[1].node.name}</button>}</div>
    <h3 className="proof-heading">{edge.count} 处源码证据{edge.supportingEvidenceIds?.length ? ` · ${edge.supportingEvidenceIds.length} 处来源依据` : ""}</h3>
    {error && <InlineError message={error}/>}
    {!proofs && !error && <LoadingRows label="读取关系证据…"/>}
    {proofs?.map((proof) => <button className="proof-row" key={proof.id} onClick={() => onEvidence(proof)}><span className="proof-location"><Icon name="file"/><span>{proof.filePath}</span><small>:{proof.range.start.line}</small></span><code>{proof.excerpt}</code><span className="proof-open">在源码中查看<Icon name="arrow" size={14}/></span></button>)}
    {edge.count > edge.evidenceIds.length && <p className="panel-note">此处展示前 {edge.evidenceIds.length} 个位置，共 {edge.count} 处；可通过文件视图继续定位。</p>}
  </div>;
}

export function Inspector({ overview, selected, target, activeEdge, diagnosticMode, onNavigate, onSelect, onEvidence, onEdge, onTarget, onClose, onBack, onRefresh, readingRevision, onReadingChange }: {
  overview: ProjectOverview; selected: ExplorerNode | null; target: SourceTarget | null; activeEdge: ExplorerEdge | null; diagnosticMode: boolean;
  onNavigate: (node: ExplorerNode) => void; onSelect: (node: ExplorerNode) => void; onEvidence: (proof: EvidenceDetail) => void; onEdge: (edge: ExplorerEdge) => void;
  onTarget: (target: SourceTarget) => void; onClose: () => void; onBack: () => void; onRefresh: () => void;
  readingRevision: number; onReadingChange: () => void;
}) {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [source, setSource] = useState<SourceWindow | null>(null);
  const [error, setError] = useState("");
  const [sourceError, setSourceError] = useState("");
  const [tab, setTab] = useState<"source" | "relations" | "explanation">("source");
  const [bookmarkKey, setBookmarkKey] = useState<string | null>(null);
  const [bookmarkBusy, setBookmarkBusy] = useState(false);
  const [copyState, setCopyState] = useState("");
  const [retry, setRetry] = useState(0);
  const snapshotId = overview.snapshotId;
  useEffect(() => {
    const controller = new AbortController(); setBookmarkKey(null);
    if (!selected) return;
    void api<ReadingList>(snapshotPath(snapshotId, "/reading-list"), { signal: controller.signal }).then((list) => setBookmarkKey(list.items.find((item) => item.node?.id === selected.id)?.key ?? null))
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => controller.abort();
  }, [snapshotId, selected?.id, readingRevision]);
  async function toggleBookmark() {
    if (!selected) return;
    setBookmarkBusy(true);
    try {
      if (bookmarkKey) await api(`/reading-list/${bookmarkKey}`, { method: "DELETE" });
      else await api(snapshotPath(snapshotId, "/reading-list"), { method: "POST", body: JSON.stringify({ nodeId: selected.id }) });
      onReadingChange();
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBookmarkBusy(false); }
  }
  useEffect(() => { setTab("source"); setCopyState(""); }, [selected?.id, target?.evidence]);
  useEffect(() => {
    setDetail(null); setError("");
    if (!selected) return;
    const controller = new AbortController();
    void api<NodeDetail>(snapshotPath(snapshotId, `/nodes/${encodeURIComponent(selected.id)}`), { signal: controller.signal })
      .then(setDetail).catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => controller.abort();
  }, [selected?.id, snapshotId, retry]);
  useEffect(() => {
    setSource(null); setSourceError("");
    if (!target) return;
    const controller = new AbortController();
    const query = new URLSearchParams();
    if (target.symbol) query.set("symbol", target.symbol);
    if (target.evidence) query.set("evidence", target.evidence);
    if (target.line) query.set("line", String(target.line));
    void api<SourceWindow>(snapshotPath(snapshotId, `/files/${encodeURIComponent(target.fileId)}?${query}`), { signal: controller.signal })
      .then(setSource).catch((failure: unknown) => { if (!ignoredAbort(failure)) setSourceError(messageOf(failure)); });
    return () => controller.abort();
  }, [target, snapshotId, retry]);
  async function copyPath() {
    if (!selected) return;
    try { await navigator.clipboard.writeText(`${overview.rootDir.replaceAll("\\", "/")}/${selected.path}${source?.highlight ? `:${source.highlight.start.line}` : ""}`); setCopyState("已复制"); }
    catch { setCopyState("请手动选择并复制路径"); }
  }
  const heading = diagnosticMode ? "分析诊断" : activeEdge ? "关系证据" : selected ? kindLabel(selected.kind) === "模块" ? "模块详情" : "源码与关系" : "项目速览";
  return <>
    <div className="inspector-heading"><span><Icon name={diagnosticMode ? "info" : activeEdge ? "link" : "code"}/><strong>{heading}</strong></span>
      <div>{(activeEdge || diagnosticMode) && <button className="icon-button" onClick={onBack} aria-label="返回节点详情"><Icon name="back"/></button>}<button className="icon-button panel-close" onClick={onClose} aria-label="关闭源码侧栏"><Icon name="close"/></button></div>
    </div>
    {diagnosticMode ? <div className="inspector-body diagnostics-panel"><h2>解析范围与诊断</h2><p>{overview.statistics.files} 个源码文件，跳过 {overview.skippedCount} 个路径；{overview.resolutionSummary.gaps} 处解析缺口，另有 {overview.resolutionSummary.external} 处外部引用。</p>
      <p className="panel-note">“分析完成”表示本次分析过程结束，不代表静态关系覆盖了所有运行时行为。</p>
      <h3>{overview.diagnostics.length} 条诊断</h3>{overview.diagnostics.length ? overview.diagnostics.map((entry, index) => <div className="diagnostic-row" key={index}><strong>{entry.severity === "error" ? "错误" : entry.severity === "warning" ? "提示" : "说明"} · {entry.code}</strong><p>{entry.message}</p>{entry.path && <button onClick={() => { const file = overview.files.find((item) => item.path === entry.path); if (file) onSelect(file); }}>{entry.path}{entry.range ? `:${entry.range.start.line}` : ""}</button>}</div>) : <p className="quiet-empty">当前快照没有编译或扫描诊断。</p>}
      <h3>当前分析边界</h3><ul className="boundary-list"><li>模块按目录聚合，不推断业务边界。</li><li>动态目标和分析范围外的目标不会补成直接调用。</li><li>图谱表达静态依赖，不能当作执行顺序。</li><li>复杂项目引用和运行时数据流仍需人工核实。</li></ul>
    </div> : activeEdge ? <EdgeInspector edge={activeEdge} snapshotId={snapshotId} onEvidence={onEvidence} onNavigate={onNavigate}/> : !selected ? <div className="inspector-body"><h2>从一个模块开始</h2><p>选择图谱节点查看文件与源码；点击连线核实依赖证据。</p>{overview.modules.slice(0, 5).map((node) => <button className="inspector-file" key={node.id} onClick={() => onSelect(node)}><NodeGlyph node={node}/><span>{node.path}</span><Icon name="chevron"/></button>)}</div> : <>
      <div className="selected-summary"><div className="selected-kind"><NodeGlyph node={selected}/><span>{kindLabel(selected.kind)}</span>{selected.exported && <span className="neutral-tag">导出</span>}</div><h2 title={selected.name}>{selected.name}</h2><div className="selected-path"><span title={selected.path}>{selected.path}</span><button className="icon-button" onClick={() => void copyPath()} aria-label="复制源码路径"><Icon name={copyState === "已复制" ? "check" : "copy"}/></button></div>{copyState && <p className="copy-state" role="status">{copyState}</p>}{selected.signature && <code className="signature">{selected.signature}</code>}
        <div className="node-actions"><button className="locate-button" onClick={() => onNavigate(selected)}><Icon name={selected.kind === "module" ? "folder" : "graph"}/>{selected.kind === "module" ? "打开模块文件" : selected.kind === "file" ? "查看文件图谱" : "展开局部关系"}<Icon name="arrow"/></button><button className="bookmark-node" aria-pressed={!!bookmarkKey} aria-label={bookmarkKey ? "从阅读清单移除当前节点" : "加入阅读清单"} title={bookmarkKey ? "已加入阅读清单" : "加入阅读清单"} disabled={bookmarkBusy} onClick={() => void toggleBookmark()}><Icon name={bookmarkKey ? "check" : "bookmark"}/></button></div>
      </div>
      <div className="inspector-tabs" role="tablist" aria-label="节点详情"><button role="tab" aria-selected={tab === "source"} onClick={() => setTab("source")}>{selected.kind === "module" ? "文件" : "源码"}</button><button role="tab" aria-selected={tab === "relations"} onClick={() => setTab("relations")}>关系{detail && <span>{detail.incoming.length + detail.outgoing.length}</span>}</button><button role="tab" aria-selected={tab === "explanation"} onClick={() => setTab("explanation")}>解释</button></div>
      {error && <InlineError message={error} retry={() => setRetry((value) => value + 1)}/>}
      {tab === "explanation" ? <ExplanationPanel snapshotId={snapshotId} node={selected} stale={overview.stale} onEvidence={onEvidence}/> : tab === "relations" ? <div className="inspector-body relations-body">{!detail && !error && <LoadingRows label="读取节点关系…"/>}{detail && <><ConnectionList title="使用此节点" connections={detail.incoming} onNavigate={onNavigate} onEdge={onEdge}/><ConnectionList title="此节点使用" connections={detail.outgoing} onNavigate={onNavigate} onEdge={onEdge}/>{detail.hiddenConnections > 0 && <p className="panel-note">另有 {detail.hiddenConnections} 条关系未展示，请在图谱中缩小范围。</p>}{detail.unresolved.length > 0 && <section className="connection-section"><h3>解析缺口<span>{detail.resolutionSummary.gaps}</span></h3>{detail.resolutionSummary.gaps > detail.unresolved.length && <p className="panel-note">显示前 {detail.unresolved.length} 处缺口。</p>}{detail.unresolved.map((item) => <button className="unresolved-row" key={item.id} onClick={() => { void api<EvidenceDetail>(snapshotPath(snapshotId, `/evidence/${encodeURIComponent(item.evidenceId)}`)).then(onEvidence).catch((failure: unknown) => setError(messageOf(failure))); }}><code>{item.excerpt}</code><span>{reasons[item.reason] ?? item.reason}</span></button>)}</section>}{detail.externalReferences.length > 0 && <section className="connection-section"><h3>外部引用<span>{detail.resolutionSummary.external}</span></h3><p className="panel-note">目标位于分析源码范围外，单独统计。{detail.resolutionSummary.external > detail.externalReferences.length && `显示前 ${detail.externalReferences.length} 处。`}</p>{detail.externalReferences.map((item) => <button className="unresolved-row" key={item.id} onClick={() => { void api<EvidenceDetail>(snapshotPath(snapshotId, `/evidence/${encodeURIComponent(item.evidenceId)}`)).then(onEvidence).catch((failure: unknown) => setError(messageOf(failure))); }}><code>{item.excerpt}</code><span>范围外</span></button>)}</section>}</>}</div>
        : selected.kind === "module" ? <div className="inspector-body module-files"><p className="panel-note">按目录聚合 · {selected.fileCount} 个文件，{selected.symbolCount} 个符号</p>{!detail && !error && <LoadingRows label="读取模块文件…"/>}{detail?.files.map((file) => <button className="inspector-file" key={file.id} onClick={() => onNavigate(file)}><NodeGlyph node={file}/><span><strong>{file.name}</strong><small>{file.path}</small></span><Icon name="chevron"/></button>)}</div>
        : <div className="source-panel">{sourceError && <InlineError message={sourceError} retry={() => setRetry((value) => value + 1)}/>}{!source && !sourceError && <LoadingRows label="读取快照源码…"/>}{source && <>
          {(!source.matchesCurrentFile || overview.stale) && <div className="source-stale"><Icon name="info"/><span>{!source.matchesCurrentFile ? "文件已变化或删除，正在显示分析时的源码。" : "项目内容已变化，当前源码属于旧快照。"}</span><button onClick={onRefresh}>刷新</button></div>}
          <div className="source-meta"><span>{source.file.language.toUpperCase()} · {source.totalLines} 行</span><span className="mono">{source.file.hash.slice(0, 8)}</span></div>
          <CodeLines source={source}/>
          <div className="source-pagination"><button disabled={source.startLine <= 1} onClick={() => target && onTarget({ ...target, line: Math.max(1, source.startLine - 120) })}>上一段</button><span>{source.startLine}–{source.endLine} / {source.totalLines}</span><button disabled={source.endLine >= source.totalLines} onClick={() => target && onTarget({ ...target, line: source.endLine + 1 })}>下一段</button></div>
          <p className="source-footnote">只读源码 · 位置绑定当前分析快照</p>
          {detail && selected.kind === "file" && detail.symbols.length > 0 && <section className="file-symbols"><h3>文件中的主要符号<span>{detail.symbols.length}</span></h3>{detail.symbols.map((symbol) => <button key={symbol.id} onClick={() => onSelect(symbol)}><NodeGlyph node={symbol}/><span>{symbol.name}</span><small>:{symbol.range?.start.line}</small></button>)}</section>}
        </>}</div>}
    </>}
  </>;
}
