import { useCallback, useEffect, useRef, useState } from "react";
import type { AnalysisJob, EvidenceDetail, ExplorerEdge, ExplorerGraph, ExplorerNode, ProjectOverview, SearchResults, SessionInfo } from "@codetrail/shared";
import { api, ignoredAbort, messageOf, sessionToken, snapshotPath, watchAnalysis } from "./api.js";
import { GraphView } from "./GraphView.js";
import { Inspector, type SourceTarget } from "./Inspector.js";
import { ReadingGuide } from "./ReadingGuide.js";
import { ImpactPage } from "./ImpactPage.js";
import { ComparisonSource } from "./ComparisonSource.js";
import type { ComparisonSourceTarget } from "@codetrail/shared";
import { BrandMark, Icon, InlineError, kindLabel, LoadingRows, NodeGlyph } from "./ui.js";

const phaseLabel: Record<string, string> = { queued: "准备分析", scanning: "扫描文件", compiling: "解析符号", extracting: "提取引用关系", verifying: "核实输入版本", saving: "保存源码快照" };
const shortTime = (value: string): string => new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(new Date(value));

export default function App() {
  const [section, setSection] = useState<"architecture" | "reading" | "impact">("architecture");
  const [readingRevision, setReadingRevision] = useState(0);
  const [comparisonTarget, setComparisonTarget] = useState<ComparisonSourceTarget | null>(null);
  const [comparisonStatus, setComparisonStatus] = useState<{ id: string; stale: boolean } | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [overview, setOverview] = useState<ProjectOverview | null>(null);
  const [job, setJob] = useState<AnalysisJob | null>(null);
  const [booting, setBooting] = useState(true);
  const [error, setError] = useState("");
  const [streamError, setStreamError] = useState("");
  const [history, setHistory] = useState<(string | null)[]>([null]);
  const focus = history.at(-1) ?? null;
  const [selected, setSelected] = useState<ExplorerNode | null>(null);
  const [target, setTarget] = useState<SourceTarget | null>(null);
  const [activeEdge, setActiveEdge] = useState<ExplorerEdge | null>(null);
  const [diagnosticMode, setDiagnosticMode] = useState(false);
  const [graph, setGraph] = useState<ExplorerGraph | null>(null);
  const [graphLoading, setGraphLoading] = useState(false);
  const [graphError, setGraphError] = useState("");
  const [graphRetry, setGraphRetry] = useState(0);
  const [view, setView] = useState<"graph" | "list">(() => window.matchMedia("(max-width: 640px)").matches ? "list" : "graph");
  const [includeTypes, setIncludeTypes] = useState(false);
  const [includeReferences, setIncludeReferences] = useState(false);
  const [includeCandidates, setIncludeCandidates] = useState(true);
  const [depth, setDepth] = useState(1);
  const [expandedModules, setExpandedModules] = useState<Set<string>>(new Set());
  const [navOpen, setNavOpen] = useState(false);
  const [sourceOpen, setSourceOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchResults | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const searchRef = useRef<HTMLInputElement>(null);
  const searchBox = useRef<HTMLDivElement>(null);
  const navRef = useRef<HTMLElement>(null);
  const snapshotId = overview?.snapshotId;
  const running = job?.status === "running";

  const loadSnapshot = useCallback(async (id: string) => {
    try {
      const result = await api<ProjectOverview>(snapshotPath(id, "/overview"));
      setOverview(result); setHistory([null]); setGraph(null); setActiveEdge(null); setDiagnosticMode(false); setError("");
      const initial = result.files.find((file) => /(?:^|\/)(?:entry|main|index)\.[jt]sx?$/.test(file.path)) ?? result.files[0] ?? null;
      setSelected(initial); setTarget(initial ? { fileId: initial.id } : null); setSourceOpen(false);
      setExpandedModules(new Set(initial ? [initial.moduleId] : []));
    } catch (failure) { setError(messageOf(failure)); }
  }, []);

  const bootstrap = useCallback(async () => {
    setError(""); setBooting(true);
    try {
      const info = await api<SessionInfo>("/session");
      setSession(info);
      if (info.latestSnapshotId) await loadSnapshot(info.latestSnapshotId);
      if (info.job) setJob(info.job);
      else if (!info.latestSnapshotId) setJob(await api<AnalysisJob>("/analyses", { method: "POST", body: "{}" }));
    } catch (failure) { setError(messageOf(failure)); }
    finally { setBooting(false); }
  }, [loadSnapshot]);
  useEffect(() => { if (sessionToken) void bootstrap(); else setBooting(false); }, [bootstrap]);

  useEffect(() => {
    const mobile = window.matchMedia("(max-width: 640px)");
    const adapt = () => { if (mobile.matches) setView("list"); };
    mobile.addEventListener("change", adapt);
    return () => mobile.removeEventListener("change", adapt);
  }, []);

  useEffect(() => {
    if (!job || job.status !== "running") return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const update = (next: AnalysisJob) => {
      if (controller.signal.aborted) return;
      setJob(next); setStreamError("");
      if (next.status === "completed" && next.snapshotId) void loadSnapshot(next.snapshotId);
    };
    const poll = async () => {
      try {
        const next = await api<AnalysisJob>(`/analyses/${job.id}`, { signal: controller.signal });
        update(next);
        if (next.status === "running") timer = setTimeout(() => { void poll(); }, 1000);
      } catch (failure) {
        if (!ignoredAbort(failure)) { setStreamError(messageOf(failure)); timer = setTimeout(() => { void poll(); }, 3000); }
      }
    };
    void watchAnalysis(job.id, controller.signal, update).catch((failure: unknown) => {
      if (!ignoredAbort(failure)) { setStreamError("进度连接暂时中断，正在重新获取状态。"); void poll(); }
    });
    return () => { controller.abort(); if (timer) clearTimeout(timer); };
  }, [job?.id, job?.status, loadSnapshot]);

  useEffect(() => {
    if (!snapshotId) return;
    const controller = new AbortController();
    setGraphLoading(true); setGraphError("");
    const params = new URLSearchParams({ includeTypes: String(includeTypes), includeReferences: String(includeReferences), includeCandidates: String(includeCandidates), depth: String(depth) });
    if (focus) params.set("focus", focus);
    void api<ExplorerGraph>(snapshotPath(snapshotId, `/graph?${params}`), { signal: controller.signal })
      .then((result) => { setGraph(result); setGraphLoading(false); })
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) { setGraphError(messageOf(failure)); setGraphLoading(false); } });
    return () => controller.abort();
  }, [snapshotId, focus, includeTypes, includeReferences, includeCandidates, depth, graphRetry]);

  useEffect(() => {
    if (!snapshotId) return;
    let valid = true;
    const timer = setInterval(() => {
      if (document.hidden || running) return;
      void api<{ stale: boolean }>(snapshotPath(snapshotId, "/status")).then((result) => {
        if (valid) setOverview((old) => old?.snapshotId === snapshotId ? { ...old, stale: result.stale } : old);
      }).catch(() => { /* The next explicit action presents connection failures without interrupting reading. */ });
    }, 8000);
    return () => { valid = false; clearInterval(timer); };
  }, [snapshotId, running]);

  useEffect(() => {
    setSearch(null); setSearchError(""); setSearchIndex(0);
    if (!query.trim() || !snapshotId) { setSearchLoading(false); return; }
    const controller = new AbortController();
    setSearchLoading(true);
    const timer = setTimeout(() => {
      void api<SearchResults>(snapshotPath(snapshotId, `/search?q=${encodeURIComponent(query.trim())}`), { signal: controller.signal })
        .then((result) => { setSearch(result); setSearchLoading(false); })
        .catch((failure: unknown) => { if (!ignoredAbort(failure)) { setSearchError(messageOf(failure)); setSearchLoading(false); } });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [query, snapshotId]);

  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") { event.preventDefault(); searchRef.current?.focus(); setSearchOpen(true); }
      if (event.key === "Escape") { setSearchOpen(false); setNavOpen(false); setSourceOpen(false); }
    };
    const outside = (event: PointerEvent) => { if (!searchBox.current?.contains(event.target as Node)) setSearchOpen(false); };
    window.addEventListener("keydown", keyboard); window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", keyboard); window.removeEventListener("pointerdown", outside); };
  }, []);

  useEffect(() => {
    if (!navOpen) return;
    navRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const buttons = [...(navRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const first = buttons[0]; const last = buttons.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => document.removeEventListener("keydown", trap);
  }, [navOpen]);

  useEffect(() => {
    if (!sourceOpen || !window.matchMedia("(max-width: 1100px)").matches) return;
    const panel = document.querySelector<HTMLElement>(".inspector");
    const previous = document.activeElement as HTMLElement | null;
    panel?.querySelector<HTMLButtonElement>(".panel-close")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...(panel?.querySelectorAll<HTMLElement>("button:not(:disabled), [tabindex='0']") ?? [])]
        .filter((element) => getComputedStyle(element).visibility !== "hidden" && element.getClientRects().length > 0);
      const first = controls[0]; const last = controls.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      if (previous && getComputedStyle(previous).visibility !== "hidden" && previous.getClientRects().length) previous.focus();
      else document.querySelector<HTMLButtonElement>("button[aria-label='打开项目导航']")?.focus();
    };
  }, [sourceOpen]);

  async function refresh() {
    setError(""); setStreamError("");
    try { setJob(await api<AnalysisJob>("/analyses", { method: "POST", body: "{}" })); }
    catch (failure) { setError(messageOf(failure)); }
  }
  function select(node: ExplorerNode) {
    setSelected(node); setActiveEdge(null); setDiagnosticMode(false);
    setTarget(node.fileId ? { fileId: node.fileId, ...(node.kind !== "file" ? { symbol: node.id } : {}) } : null);
    setSourceOpen(true);
  }
  function navigate(node: ExplorerNode) {
    setSection("architecture");
    setHistory((current) => current.at(-1) === node.id ? current : [...current, node.id]);
    setExpandedModules((current) => new Set([...current, node.moduleId]));
    setDepth(1); select(node); setSearchOpen(false); setNavOpen(false); searchRef.current?.blur();
  }
  function goTo(id: string | null) {
    setSection("architecture");
    setHistory((current) => current.at(-1) === id ? current : [...current, id]); setDepth(1); setActiveEdge(null); setDiagnosticMode(false); setNavOpen(false);
    if (id === null) setSourceOpen(false);
  }
  function showEvidence(proof: EvidenceDetail) {
    const file = overview?.files.find((item) => item.id === proof.fileId);
    if (!file) return;
    setSelected(file); setActiveEdge(null); setDiagnosticMode(false); setTarget({ fileId: file.id, evidence: proof.id }); setSourceOpen(true);
  }
  function inspectEdge(edge: ExplorerEdge) { setActiveEdge(edge); setDiagnosticMode(false); setSourceOpen(true); }
  function diagnostics() { setSection("architecture"); setNavOpen(false); setDiagnosticMode(true); setActiveEdge(null); setSourceOpen(true); }
  const noSession = !sessionToken;
  const currentTitle = section === "impact" ? "改动影响" : section === "reading" ? "阅读导览" : !focus ? "项目架构" : graph?.title ?? "代码图谱";
  const breadcrumbs = section === "impact" ? [{ id: null, label: "架构概览", kind: "overview" }, { id: "impact", label: "改动影响", kind: "impact" }] : section === "reading" ? [{ id: null, label: "架构概览", kind: "overview" }, { id: "reading", label: "阅读导览", kind: "reading" }]
    : graph?.breadcrumbs ?? [{ id: null, label: "架构概览", kind: "overview" }];

  return <div className={`workbench ${navOpen ? "navigation-open" : ""} ${sourceOpen ? "source-open" : ""}`}>
    <header className="topbar"><button className="icon-button mobile-menu" onClick={() => setNavOpen(!navOpen)} aria-label="打开项目导航" aria-expanded={navOpen}><Icon name="menu"/></button><a className="brand" href="/" onClick={(event) => { event.preventDefault(); goTo(null); }}><BrandMark/><span>CodeTrail</span></a><span className="workspace-separator">/</span><span className="workspace-name" title={session?.rootDir}>{session?.projectName ?? "本地工作台"}</span>
      <div className="global-search" ref={searchBox}><Icon name="search"/><input ref={searchRef} type="search" aria-label="搜索文件或符号" placeholder="搜索文件、符号或路径" disabled={!overview} value={query} role="combobox" aria-expanded={searchOpen && !!query.trim()} aria-controls="search-results" aria-activedescendant={search?.results[searchIndex] ? `search-${searchIndex}` : undefined} onFocus={() => setSearchOpen(true)} onChange={(event) => { setQuery(event.target.value); setSearchOpen(true); }} onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setSearchIndex((value) => Math.min((search?.results.length ?? 1) - 1, value + 1)); }
        if (event.key === "ArrowUp") { event.preventDefault(); setSearchIndex((value) => Math.max(0, value - 1)); }
        if (event.key === "Enter" && search?.results[searchIndex]) { event.preventDefault(); navigate(search.results[searchIndex]!); }
      }}/><kbd>Ctrl K</kbd>
        {searchOpen && query.trim() && <div className="search-results" id="search-results" role="listbox" aria-label="搜索结果">{searchLoading ? <p role="status">正在搜索…</p> : searchError ? <InlineError message={searchError}/> : !search?.results.length ? <p>未找到“{query}”。试试文件名、符号名或路径片段。</p> : <><div className="search-summary">找到 {search.total} 项{search.truncated ? ` · 显示前 ${search.results.length} 项` : ""}</div>{search.results.map((node, index) => <button role="option" id={`search-${index}`} aria-selected={searchIndex === index} className={searchIndex === index ? "is-active" : ""} key={node.id} onPointerMove={() => setSearchIndex(index)} onClick={() => navigate(node)}><NodeGlyph node={node}/><span><strong>{node.name}</strong><small>{node.path}{node.range ? `:${node.range.start.line}` : ""}</small></span><small>{kindLabel(node.kind)}</small></button>)}</>}</div>}
      </div>
      <span className="local-indicator"><span/>仅本机</span>
    </header>
    {navOpen && <button className="navigation-backdrop" onClick={() => setNavOpen(false)} aria-label="关闭项目导航"/>}
    <aside className="sidebar" ref={navRef} aria-label="项目导航"><div className="project-switcher"><Icon name="folder" size={18}/><span><strong title={session?.projectName}>{session?.projectName ?? "本地项目"}</strong><small title={session?.rootDir}>{overview ? `${overview.statistics.files} 个源码文件` : "等待分析结果"}</small></span><button className="icon-button mobile-menu" onClick={() => setNavOpen(false)} aria-label="关闭项目导航"><Icon name="close"/></button></div>
      <button className={`overview-link ${section === "architecture" && !focus ? "is-active" : ""}`} onClick={() => goTo(null)}><Icon name="graph"/><span>架构概览</span></button>
      <button className={`overview-link ${section === "reading" ? "is-active" : ""}`} onClick={() => { setSection("reading"); setNavOpen(false); setSourceOpen(false); }} disabled={!overview}><Icon name="book"/><span>阅读导览</span></button>
      <button className={`overview-link ${section === "impact" ? "is-active" : ""}`} onClick={() => { setSection("impact"); setNavOpen(false); setSourceOpen(false); }} disabled={!overview}><Icon name="link"/><span>改动影响</span></button>
      <div className="sidebar-section-label">目录与模块</div>
      <nav className="module-tree" aria-label="模块与文件">{!overview && booting && <LoadingRows label="读取项目…"/>}{overview?.modules.map((module) => <div className="tree-group" key={module.id}><div className="tree-module"><button className="tree-toggle" onClick={() => setExpandedModules((current) => { const next = new Set(current); if (next.has(module.id)) next.delete(module.id); else next.add(module.id); return next; })} aria-label={`${expandedModules.has(module.id) ? "收起" : "展开"} ${module.path}`} aria-expanded={expandedModules.has(module.id)}><Icon name="chevron" size={13} style={{ transform: expandedModules.has(module.id) ? "rotate(90deg)" : undefined }}/></button><button className={focus === module.id ? "is-active" : ""} onClick={() => navigate(module)} title={module.path}><Icon name="folder"/><span>{module.path}</span><small>{module.fileCount}</small></button></div>{expandedModules.has(module.id) && <div className="tree-files">{overview.files.filter((file) => file.moduleId === module.id).map((file) => <button key={file.id} className={selected?.fileId === file.id ? "is-active" : ""} onClick={() => navigate(file)} title={file.path}><Icon name="file" size={14}/><span>{file.name}</span></button>)}</div>}</div>)}</nav>
      <div className="sidebar-bottom"><p>模块按目录聚合<br/>业务职责需要结合源码核实</p><button onClick={diagnostics} disabled={!overview}><Icon name="info"/><span>分析范围与诊断</span>{!!overview?.diagnostics.length && <span className="diagnostic-count">{overview.diagnostics.length}</span>}</button></div>
    </aside>
    <main className="workspace"><div className="workspace-main"><div className="title-region"><div className="breadcrumb-row"><button className="icon-button" aria-label={section !== "architecture" ? "返回架构图谱" : "返回上一处图谱"} disabled={section === "architecture" && history.length <= 1} onClick={() => section !== "architecture" ? setSection("architecture") : setHistory((current) => current.slice(0, -1))}><Icon name="back"/></button><nav className="breadcrumbs" aria-label="图谱位置">{breadcrumbs.map((crumb, index, list) => <span key={crumb.id ?? "root"}>{index > 0 && <Icon name="chevron" size={12}/>}<button aria-current={index === list.length - 1 ? "page" : undefined} onClick={() => crumb.kind === "reading" || crumb.kind === "impact" ? setSection(crumb.kind) : goTo(crumb.id)} title={crumb.label}>{crumb.label}</button></span>)}</nav></div>
      <div className="page-title-row"><div><h1>{noSession ? "连接本地项目" : currentTitle}</h1><p className="page-description">{section === "impact" ? "核实变化位置、潜在关联与两个版本的源码依据。" : section === "reading" ? "先看关键位置，再沿源码证据逐步阅读。" : !focus ? "从模块全貌，走到每一处代码依据。" : graph?.scope === "module" ? "模块内的文件与静态导入关系。" : "聚焦当前代码，查看相邻调用与引用。"}</p></div>{section !== "impact" && <button className="refresh-button" disabled={running || !session} onClick={() => void refresh()}><Icon name="refresh"/>{running ? "分析中" : "刷新分析"}</button>}</div>
      {overview && section !== "impact" && <div className="snapshot-summary"><div className="project-counts"><span><strong>{overview.modules.length}</strong> 个模块</span><span><strong>{overview.statistics.files}</strong> 个文件</span><span><strong>{overview.statistics.symbols}</strong> 个符号</span></div><button className={`snapshot-state ${overview.stale ? "is-stale" : ""}`} onClick={diagnostics}><span/>{overview.stale ? "快照已过期" : overview.status === "partial" ? "部分完成" : "分析完成"}<span className="snapshot-time">{shortTime(overview.createdAt)}</span></button></div>}
      </div>
      {noSession ? <div className="setup-panel"><Icon name="link" size={28}/><h2>使用终端中的会话链接</h2><p>在项目根目录启动工作台，再打开终端输出的完整链接。</p><code>npm run open -- &quot;你的项目目录&quot;</code></div> : <>
        {error && <InlineError message={error} retry={() => void (session ? refresh() : bootstrap())}/>}
        {overview?.stale && !running && section !== "impact" && <div className="stale-banner"><Icon name="info"/><span>项目内容已变化，当前仍显示分析时的图谱与源码。</span><button onClick={() => void refresh()}>更新快照<Icon name="arrow" size={14}/></button></div>}
        {running && <div className="analysis-progress" role="status"><span className="progress-dot"/><div><strong>{phaseLabel[job.phase]}</strong><small>{overview ? "上一份快照仍可继续浏览" : "完成后将展示项目架构"}</small></div><button onClick={() => { void api<AnalysisJob>(`/analyses/${job.id}`, { method: "DELETE" }).then(setJob).catch((failure: unknown) => setError(messageOf(failure))); }}><Icon name="stop" size={13}/>取消</button></div>}
        {streamError && <div className="connection-notice" role="status">{streamError}</div>}
        {job?.status === "failed" && <InlineError message={`分析未完成：${job.error ?? "请重试"}`} retry={() => void refresh()}/>}
        {job?.status === "cancelled" && <div className="cancelled-notice" role="status">已取消本次分析。{overview ? "仍在显示上一份快照。" : "可以重新开始。"}<button onClick={() => void refresh()}>重新分析</button></div>}
        {!overview && !error && <div className="analysis-wait"><Icon name="graph" size={40}/><h2>{job?.status === "cancelled" ? "分析已取消" : job?.status === "failed" ? "暂时无法生成图谱" : "正在建立代码地图"}</h2><p>{job?.status === "running" ? phaseLabel[job.phase] : booting ? "连接本地项目…" : "重新分析后即可查看模块、文件与调用关系。"}</p></div>}
        {overview && section === "impact" && <ImpactPage onStatus={(id, stale) => setComparisonStatus({ id, stale })} onDefaultSource={(point) => setComparisonTarget((current) => current?.comparisonId === point.comparisonId ? current : point)} onOpen={(point) => { setComparisonTarget(point); setSourceOpen(true); setNavOpen(false); }} onComparison={() => { setComparisonTarget(null); setComparisonStatus(null); setSourceOpen(false); }}/>}
        {overview && section === "reading" && <ReadingGuide snapshotId={overview.snapshotId} revision={readingRevision} onChange={() => setReadingRevision((value) => value + 1)} onSelect={select} onNavigate={navigate} onEvidence={showEvidence}/>}
        {overview && section === "architecture" && <><div className="graph-toolbar"><div className="view-tabs" role="tablist" aria-label="图谱展示方式"><button role="tab" aria-selected={view === "graph"} onClick={() => setView("graph")}><Icon name="graph"/>图谱</button><button role="tab" aria-selected={view === "list"} onClick={() => setView("list")}><Icon name="list"/>列表</button></div><span className="graph-node-count">{graph?.nodes.length ?? "—"} 个节点</span><div className="graph-filters"><label><input type="checkbox" checked={includeTypes} onChange={(event) => setIncludeTypes(event.target.checked)}/>类型引用</label>{focus && <><label><input type="checkbox" checked={includeReferences} onChange={(event) => setIncludeReferences(event.target.checked)}/>一般引用</label><label><input type="checkbox" checked={includeCandidates} onChange={(event) => setIncludeCandidates(event.target.checked)}/>回调候选</label></>}</div></div>
          <div className={`graph-region ${graphLoading ? "is-loading" : ""}`} aria-busy={graphLoading}>{graphError ? <div className="graph-error"><InlineError message={graphError} retry={() => setGraphRetry((value) => value + 1)}/><button onClick={() => goTo(null)}>返回架构概览</button></div> : !graph ? <LoadingRows label="读取架构图谱…"/> : view === "graph" ? <GraphView graph={graph} selected={selected?.id ?? null} onSelect={select} onNavigate={navigate} onEdge={inspectEdge}/> : <div className="graph-list" aria-label="图谱节点列表"><div className="graph-list-heading"><span>节点与位置</span><span>类型</span><span>操作</span></div>{graph.nodes.length ? graph.nodes.map((node) => <div className={`graph-list-row ${selected?.id === node.id ? "is-selected" : ""}`} key={node.id}><button className="node-list-name" onClick={() => select(node)}><NodeGlyph node={node}/><span><strong>{node.name}</strong><small>{node.kind === "module" ? `${node.fileCount} 个文件 · ${node.symbolCount} 个符号` : node.path}</small></span></button><span>{kindLabel(node.kind)}</span><button className="text-action" onClick={() => navigate(node)}>{node.kind === "module" ? "打开模块" : "展开关系"}<Icon name="arrow" size={14}/></button></div>) : <p className="quiet-empty">当前范围没有可展示的节点。</p>}</div>}{graphLoading && graph && <span className="graph-updating" role="status">更新图谱…</span>}</div>
          {graph?.truncated && <div className="truncation-note">当前显示 {graph.nodes.length} 个节点，另有 {graph.hiddenNodes} 个未展示。请缩小范围或通过搜索定位。</div>}
          <div className="graph-footer"><span><Icon name="info" size={14}/>静态依赖关系，不代表运行时执行顺序。</span>{focus && graph?.scope === "symbol" && <button onClick={() => setDepth((value) => value === 1 ? 2 : 1)}>{depth === 1 ? "展开到两层关系" : "收起为一层关系"}<Icon name="chevron" size={12}/></button>}<button onClick={diagnostics}>{overview.statistics.unresolved} 处未解析<Icon name="chevron" size={12}/></button></div>
        </>}
      </>}
    </div>
    {overview && <aside className="inspector" aria-label="源码与关系侧栏">{section === "impact" ? <ComparisonSource stale={Boolean(comparisonStatus && comparisonTarget && comparisonStatus.id === comparisonTarget.comparisonId && comparisonStatus.stale)} target={comparisonTarget} onClose={() => setSourceOpen(false)}/> : <Inspector overview={overview} selected={selected} target={target} activeEdge={activeEdge} diagnosticMode={diagnosticMode} onNavigate={navigate} onSelect={select} onEvidence={showEvidence} onEdge={inspectEdge} onTarget={setTarget} onClose={() => setSourceOpen(false)} onBack={() => { setActiveEdge(null); setDiagnosticMode(false); }} onRefresh={() => void refresh()} readingRevision={readingRevision} onReadingChange={() => setReadingRevision((value) => value + 1)}/>}</aside>}
    </main>
  </div>;
}
