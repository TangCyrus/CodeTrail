import { useEffect, useState } from "react";
import type { ComparisonJob, ComparisonPath, ComparisonReport, ComparisonSide, ComparisonSourceTarget, ExplorerNode, FileChange, GitBaseline, SymbolChangeKind } from "@codegraph/shared";
import { api, ignoredAbort, messageOf } from "./api.js";
import { Icon, InlineError, LoadingRows, relationLabel } from "./ui.js";

const fileLabel: Record<FileChange["kind"], string> = { added: "新增", modified: "修改", deleted: "删除", rename_candidate: "重命名候选", scope: "范围变化" };
const symbolLabel: Record<SymbolChangeKind, string> = { added: "新增", deleted: "删除", modified: "实现变化", signature: "签名变化", export: "导出变化", moved: "路径变化", ambiguous: "映射不明确", unchanged: "声明未变" };
const phases: Record<ComparisonJob["phase"], string> = { git: "固定 HEAD 基线", baseline: "解析旧版源码", current: "解析工作区当前内容", mapping: "映射符号与追踪关联", saving: "保存比较与证据" };

export function ImpactPage({ onOpen, onComparison, onDefaultSource, onStatus }: { onOpen: (target: ComparisonSourceTarget) => void; onComparison: () => void; onDefaultSource: (target: ComparisonSourceTarget) => void; onStatus: (id: string, stale: boolean) => void }) {
  const [git, setGit] = useState<GitBaseline | null>(null);
  const [report, setReport] = useState<ComparisonReport | null>(null);
  const [reportId, setReportId] = useState<string | null>(null);
  const [reportRevision, setReportRevision] = useState(0);
  const [job, setJob] = useState<ComparisonJob | null>(null);
  const [includeTypes, setIncludeTypes] = useState(false);
  const [tab, setTab] = useState<"changes" | "paths" | "tests">("changes");
  const [filter, setFilter] = useState("all");
  const [focus, setFocus] = useState("all");
  const [error, setError] = useState("");
  const [booting, setBooting] = useState(true);
  const [starting, setStarting] = useState(false);
  const [loadingReport, setLoadingReport] = useState(false);
  const [retry, setRetry] = useState(0);
  const running = job?.status === "running";
  useEffect(() => {
    const controller = new AbortController(); setBooting(true); setError("");
    void Promise.all([api<GitBaseline>("/git", { signal: controller.signal }), api<{ report: ComparisonReport | null; job: ComparisonJob | null }>("/comparisons/latest", { signal: controller.signal })])
      .then(([baseline, latest]) => { setGit(baseline); setReport(latest.report); setReportId(latest.report?.id ?? null); setJob(latest.job); setBooting(false); })
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) { setError(messageOf(failure)); setBooting(false); } });
    return () => controller.abort();
  }, [retry]);
  useEffect(() => {
    if (!running || !job) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api<ComparisonJob>(`/comparison-jobs/${job.id}`, { signal: controller.signal }); setJob(next);
        if (next.comparisonId && next.status === "completed") { setReportId(next.comparisonId); setReportRevision((value) => value + 1); setFocus("all"); onComparison(); }
        if (next.status === "running") timer = setTimeout(() => void poll(), 300);
      } catch (failure) { if (!ignoredAbort(failure)) { setError(messageOf(failure)); timer = setTimeout(() => void poll(), 1500); } }
    };
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [job?.id, running]);
  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController(); setLoadingReport(true);
    void api<ComparisonReport>(`/comparisons/${encodeURIComponent(reportId)}/impact?includeTypes=${includeTypes}`, { signal: controller.signal })
      .then((value) => {
        setReport((current) => ({ ...value, stale: value.stale || !!(current?.id === value.id && current.createdAt === value.createdAt && current.stale) })); setGit(value.baseline); setLoadingReport(false);
        const first = value.changes[0], file = first?.newFile ?? first?.oldFile;
        if (file && window.matchMedia("(min-width: 1101px)").matches) onDefaultSource({ comparisonId: value.id, side: first?.newFile ? "current" : "base", fileId: file.id });
      })
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) { setError(messageOf(failure)); setLoadingReport(false); } });
    return () => controller.abort();
  }, [reportId, includeTypes, reportRevision]);
  useEffect(() => {
    if (!reportId) return;
    const controller = new AbortController();
    const check = () => void api<{ stale: boolean }>(`/comparisons/${encodeURIComponent(reportId)}/status`, { signal: controller.signal })
      .then((state) => { onStatus(reportId, state.stale); if (state.stale) setReport((value) => value?.id === reportId ? { ...value, stale: true } : value); })
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    check(); const timer = setInterval(check, 8000);
    return () => { controller.abort(); clearInterval(timer); };
  }, [reportId, reportRevision]);
  async function compare() {
    setStarting(true); setError("");
    try { setJob(await api<ComparisonJob>("/comparisons", { method: "POST", body: "{}" })); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setStarting(false); }
  }
  async function cancel() {
    if (!job) return;
    try { setJob(await api<ComparisonJob>(`/comparison-jobs/${job.id}`, { method: "DELETE" })); }
    catch (failure) { setError(messageOf(failure)); }
  }
  function node(side: ComparisonSide, value: ExplorerNode) {
    if (!report) return;
    onOpen({ comparisonId: report.id, side, fileId: value.fileId ?? value.id, ...(value.kind !== "file" && value.kind !== "module" ? { symbol: value.id } : {}) });
  }
  function changeRange(change: FileChange, side: ComparisonSide, hunk?: number) {
    const file = side === "base" ? change.oldFile : change.newFile;
    if (report && file) onOpen({ comparisonId: report.id, side, fileId: file.id, ...(hunk === undefined ? {} : { change: change.id, hunk }) });
  }
  function pathRow(path: ComparisonPath) {
    return <article className="impact-path" key={path.id}><div className="impact-path-title"><button onClick={() => node(path.side, path.target)}>{path.target.name}</button><span className="neutral-tag">{path.side === "base" ? "旧版依据" : "新版依据"}</span><span>{path.distance === 1 ? "直接关联" : "两跳关联"}</span></div><p className="impact-path-location">{path.target.path}{path.test ? " · 测试文件静态关联" : ""} · {path.dependency === "type" ? "纯类型依赖" : path.dependency === "mixed" ? "含类型与值依赖" : "值依赖"}</p><div className="impact-path-start"><span>改动起点</span><button onClick={() => node(path.side, path.seed)}>{path.seed.name}</button>{path.seed.kind === "file" && <span>文件级关联</span>}</div><ol className="impact-steps">{path.steps.map((step, index) => <li key={`${step.evidenceId}:${index}`}><div><button onClick={() => node(path.side, step.to)}>{step.to.name}</button><span>← {relationLabel(step.kind)} ←</span><button onClick={() => node(path.side, step.from)}>{step.from.name}</button></div><button className="text-action" onClick={() => report && onOpen({ comparisonId: report.id, side: path.side, fileId: step.from.fileId ?? step.from.id, evidence: step.evidenceId })} aria-label={`查看 ${path.side === "base" ? "旧版" : "新版"} ${step.from.name} 到 ${step.to.name} 的${relationLabel(step.kind)}证据`}>源码依据<Icon name="arrow" size={13}/></button></li>)}</ol></article>;
  }
  const paths = report?.paths.filter((path) => (focus === "all" || path.changeId === focus) && (tab !== "tests" || path.test)) ?? [];
  return <div className="impact-page">
    <div className="impact-baseline"><div><span className="impact-eyebrow">比较口径</span><strong>HEAD <Icon name="arrow" size={14}/> 工作区当前内容</strong><p>{git?.head ? <><code>{git.head.slice(0, 12)}</code>{git.scope ? ` · 范围 ${git.scope}` : " · 所选项目范围"}</> : git?.message ?? "检查本地 Git…"}</p></div><button className="compare-button" onClick={() => void compare()} disabled={running || starting || booting}><Icon name="refresh" size={14}/>{running ? "比较中" : report ? "重新比较" : "比较当前改动"}</button></div>
    {error && <InlineError message={error} retry={() => setRetry((value) => value + 1)}/>}
    {running && <div className="comparison-progress" role="status"><span className="progress-dot"/><span>{phases[job.phase]}{report && <small>上一份结果仍可核实</small>}</span><button onClick={() => void cancel()}>取消比较</button></div>}
    {job?.status === "failed" && <InlineError message={job.error ?? "比较未完成，请重试。"} retry={() => void compare()}/>}
    {job?.status === "cancelled" && <p className="comparison-notice" role="status">比较已取消，可重新比较。已有结果和证据仍可阅读。</p>}
    {booting ? <LoadingRows label="检查 Git 与最近比较…"/> : !report ? <div className="impact-content"><div className="impact-intro"><h2>核实当前改动的潜在关联</h2><p>比较已暂存、未暂存及范围内未跟踪源码。从变化的声明出发，分别追踪旧版与新版的调用、引用和文件导入。</p><p>默认最多两跳，不运行项目代码或测试，也不修改 Git 索引。</p>{git?.state !== "ready" && <p className="comparison-notice">{git?.message}</p>}</div></div> : <>
      <div className="comparison-summary"><span><strong>{report.statistics.files}</strong> 个变化文件</span><span><strong>{report.statistics.symbols}</strong> 个变化声明</span><span><strong>{report.statistics.paths}</strong> 条关联路径</span><span><strong>{report.statistics.testFiles}</strong> 个静态关联测试文件</span></div>
      {report.stale && <div className="comparison-notice is-stale" role="status">工作区或 HEAD 已变化，以下保留比较时的结果与源码。请重新比较。</div>}
      {report.baseline.state !== "ready" && <div className="comparison-notice">{report.baseline.message}</div>}
      <div className="impact-toolbar"><div className="impact-tabs" role="tablist" aria-label="改动影响视图"><button role="tab" aria-selected={tab === "changes"} onClick={() => setTab("changes")}>变更清单</button><button role="tab" aria-selected={tab === "paths"} onClick={() => setTab("paths")}>关联路径</button><button role="tab" aria-selected={tab === "tests"} onClick={() => setTab("tests")}>相关测试</button></div><label className="impact-types"><input type="checkbox" checked={includeTypes} disabled={loadingReport} onChange={(event) => setIncludeTypes(event.target.checked)}/>包含纯类型依赖</label></div>
      <div className="impact-content" aria-busy={loadingReport}>
        {loadingReport && <p className="impact-updating" role="status">更新关联范围…</p>}
        {tab === "changes" ? <><div className="impact-filter"><label htmlFor="change-filter">变化类型</label><select id="change-filter" value={filter} onChange={(event) => setFilter(event.target.value)}><option value="all">全部变化</option>{Object.entries(fileLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></div>{report.changes.filter((change) => filter === "all" || change.kind === filter).map((change) => <article className="file-change" key={change.id}><div className="file-change-heading"><span className="change-kind">{fileLabel[change.kind]}</span><strong>{change.newFile?.path ?? change.oldFile?.path}</strong>{change.untracked && <span className="neutral-tag">未跟踪</span>}</div>{change.kind === "rename_candidate" && <p className="old-file-path">原路径：{change.oldFile?.path}</p>}<div className="file-change-actions">{change.oldFile && <button className="text-action" onClick={() => changeRange(change, "base")}>旧版源码<Icon name="arrow" size={13}/></button>}{change.newFile && <button className="text-action" onClick={() => changeRange(change, "current")}>新版源码<Icon name="arrow" size={13}/></button>}<button className="text-action" onClick={() => { setFocus(change.id); setTab("paths"); }}>查看关联路径</button></div><details className="change-details"><summary>{change.symbols.filter((symbol) => symbol.kind !== "unchanged").length} 个变化声明 · {change.hunks.length} 处改动范围<Icon name="chevron" size={12}/></summary><p className="mapping-note">{change.mappingNote}</p>{change.hunks.map((hunk, index) => <div className="change-hunk" key={index}><span>{hunk.coarse ? "文件级范围" : `范围 ${index + 1}`}</span>{change.oldFile && hunk.oldLines > 0 && <button onClick={() => changeRange(change, "base", index)}>旧版 {hunk.oldStart}–{hunk.oldStart + hunk.oldLines - 1} 行</button>}{change.newFile && hunk.newLines > 0 && <button onClick={() => changeRange(change, "current", index)}>新版 {hunk.newStart}–{hunk.newStart + hunk.newLines - 1} 行</button>}</div>)}<div className="changed-symbols">{change.symbols.filter((symbol) => symbol.kind !== "unchanged").map((symbol, index) => <div key={index}><strong>{symbol.newNode?.name ?? symbol.oldNode?.name}</strong><span>{symbolLabel[symbol.kind]}</span><div>{symbol.oldNode && <button onClick={() => node("base", symbol.oldNode!)}>旧版声明</button>}{symbol.newNode && <button onClick={() => node("current", symbol.newNode!)}>新版声明</button>}</div></div>)}</div>{change.truncated && <p className="comparison-notice">声明列表达到上限，部分未展示。</p>}</details></article>)}{!report.changes.filter((change) => filter === "all" || change.kind === filter).length && <p className="quiet-empty">{filter === "all" ? "纳入分析的源码没有文件内容变化。请结合下方分析边界核实配置与范围。" : "当前类型没有变化文件。"}</p>}</> : <><div className="impact-filter"><label htmlFor="impact-focus">改动起点</label><select id="impact-focus" value={focus} onChange={(event) => setFocus(event.target.value)}><option value="all">全部变化文件</option>{report.changes.map((change) => <option key={change.id} value={change.id}>{change.newFile?.path ?? change.oldFile?.path}</option>)}</select></div>{tab === "tests" && <p className="impact-reading-note">这里仅列出路径中实际出现的测试文件静态引用，不表示测试覆盖或执行结果。</p>}<p className="impact-reading-note">路径从改动起点向关联对象展开；箭头保留源码中“引用者 → 被引用者”的方向。</p>{paths.map(pathRow)}{!paths.length && <div className="impact-empty"><h2>{tab === "tests" ? "当前范围未发现静态关联测试" : "当前范围没有已解析的关联路径"}</h2><p>这不能证明没有潜在影响。请结合未解析关系、类型开关和分析范围核实。</p></div>}</>}
        {report.truncated && <p className="comparison-notice">已达到声明、路径数量或两跳深度限制，展示结果存在截断。</p>}
        <details className="comparison-limitations"><summary>分析边界与未解析项<Icon name="chevron" size={12}/></summary><p>旧版 {report.statistics.oldUnresolved} 处、新版 {report.statistics.newUnresolved} 处未解析关系。</p><ul>{report.limitations.map((text, index) => <li key={index}>{text}</li>)}</ul></details>
      </div>
    </>}
  </div>;
}
