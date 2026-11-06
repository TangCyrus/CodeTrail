import { useEffect, useState } from "react";
import type { ComparisonSourceTarget, ComparisonSourceWindow } from "@codegraph/shared";
import { api, ignoredAbort, messageOf } from "./api.js";
import { CodeLines } from "./Inspector.js";
import { Icon, InlineError, LoadingRows } from "./ui.js";

export function ComparisonSource({ target, stale, onClose }: { target: ComparisonSourceTarget | null; stale: boolean; onClose: () => void }) {
  const [source, setSource] = useState<ComparisonSourceWindow | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState<{ key: string; line: number } | null>(null);
  const key = JSON.stringify(target), line = page?.key === key ? page.line : undefined;
  useEffect(() => {
    const controller = new AbortController(); setSource(null); setError("");
    if (!target) return;
    const query = new URLSearchParams();
    for (const name of ["evidence", "symbol", "line", "change", "hunk"] as const) if (target[name] !== undefined) query.set(name, String(target[name]));
    if (line !== undefined) query.set("line", String(line));
    void api<ComparisonSourceWindow>(`/comparisons/${encodeURIComponent(target.comparisonId)}/${target.side}/files/${encodeURIComponent(target.fileId)}?${query}`, { signal: controller.signal }).then(setSource)
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => controller.abort();
  }, [target, line, retry]);
  return <>
    <div className="inspector-heading"><span><Icon name="code"/><strong>比较源码</strong></span><button className="icon-button panel-close" onClick={onClose} aria-label="关闭源码侧栏"><Icon name="close"/></button></div>
    {!target ? <div className="inspector-body comparison-source-empty"><Icon name="link" size={24}/><h2>沿依据核实改动</h2><p>选择旧版或新版源码，或打开关联路径中的关系证据。两个版本分别保留分析时的内容。</p></div> : <>
      <div className="comparison-version-heading"><span className="neutral-tag">{target.side === "base" ? "旧版 · HEAD" : "新版 · 工作区"}</span>{source && <><h2>{source.file.path.split("/").at(-1)}</h2><p>{source.file.path}</p><code>{target.side === "base" ? source.head?.slice(0, 12) : new Date(source.comparisonCreatedAt).toLocaleString("zh-CN", { hour12: false })}</code></>}</div>
      <div className="inspector-body comparison-source-body">
        {stale && <p className="comparison-notice is-stale">HEAD 或工作区已变化，此处保留比较时的源码。</p>}
        {error && <InlineError message={error} retry={() => setRetry((value) => value + 1)}/>}
        {!source && !error && <LoadingRows label="读取该版本保存的源码…"/>}
        {source && <><div className="source-meta"><span>快照源码</span><code title={source.file.hash}>{source.file.hash.slice(0, 8)}</code></div><CodeLines source={source}/><div className="source-pagination"><button disabled={source.startLine <= 1} onClick={() => setPage({ key, line: Math.max(1, source.startLine - 120) })}>上一段</button><span>{source.startLine}–{source.endLine} / {source.totalLines}</span><button disabled={source.endLine >= source.totalLines} onClick={() => setPage({ key, line: source.endLine + 1 })}>下一段</button></div><p className="panel-note">{target.side === "base" ? "位置对应所选 HEAD 的旧版内容，删除后仍可核实。" : source.matchesCurrentFile ? "读取时文件与此处快照一致。" : "工作区文件已变化，此处保留比较时的源码。"}</p><p className="panel-note">只读源码；高亮来自该版本的声明、关系或改动范围。</p></>}
      </div>
    </>}
  </>;
}
