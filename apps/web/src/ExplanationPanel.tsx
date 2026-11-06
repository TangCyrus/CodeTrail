import { useEffect, useRef, useState } from "react";
import type { AIStatus, CodeExplanation, ContextEvidence, EvidenceDetail, ExplanationAction, ExplanationPreview, ExplorerNode, ReadingAudience } from "@codegraph/shared";
import { api, ignoredAbort, messageOf, snapshotPath } from "./api.js";
import { Icon, InlineError, LoadingRows } from "./ui.js";

const fallback: Record<string, string> = {
  not_configured: "OpenAI 尚未配置，保留本地事实说明。", disabled: "按需 AI 已关闭，保留本地事实说明。", no_evidence: "当前节点没有足够的源码证据，可先从文件或符号开始阅读。",
  busy: "已有解释请求正在处理，请稍后重试。本地事实仍可查看。", timeout: "AI 请求超时，已回退到本地事实。", cancelled: "AI 请求已取消，本地事实仍可查看。",
  provider_error: "AI 服务未能完成请求，已回退到本地事实。", invalid_output: "AI 输出或引用未通过校验，已回退到本地事实。",
};

export function ExplanationPanel({ snapshotId, node, stale, onEvidence }: { snapshotId: string; node: ExplorerNode; stale: boolean; onEvidence: (proof: EvidenceDetail) => void }) {
  const [action, setAction] = useState<ExplanationAction>("explain");
  const [audience, setAudience] = useState<ReadingAudience>("guided");
  const [preview, setPreview] = useState<ExplanationPreview | null>(null);
  const [status, setStatus] = useState<AIStatus | null>(null);
  const [result, setResult] = useState<CodeExplanation | null>(null);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const generation = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    generation.current?.abort(); setBusy(false); setPreview(null); setResult(null); setError(""); setFeedback("");
    void Promise.all([
      api<ExplanationPreview>(snapshotPath(snapshotId, "/explanations/preview"), { method: "POST", body: JSON.stringify({ nodeId: node.id, action, audience }), signal: controller.signal }),
      api<AIStatus>("/ai", { signal: controller.signal }),
    ]).then(([context, state]) => { setPreview(context); setStatus(state); })
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => { controller.abort(); generation.current?.abort(); };
  }, [snapshotId, node.id, action, audience, retry]);
  async function evidence(id: string) {
    try { onEvidence(await api<EvidenceDetail>(snapshotPath(snapshotId, `/evidence/${encodeURIComponent(id)}`))); }
    catch (failure) { setError(messageOf(failure)); }
  }
  async function enable(enabled: boolean) {
    const previous = status?.enabled ?? false;
    setSettingsBusy(true); setError("");
    setStatus((current) => current ? { ...current, enabled } : current);
    if (!enabled) { generation.current?.abort(); setBusy(false); setResult(null); }
    try { setStatus(await api<AIStatus>("/ai", { method: "PATCH", body: JSON.stringify({ enabled }) })); }
    catch (failure) { setStatus((current) => current ? { ...current, enabled: previous } : current); setError(messageOf(failure)); }
    finally { setSettingsBusy(false); }
  }
  async function generate() {
    if (!preview) return;
    generation.current?.abort();
    const controller = new AbortController(); generation.current = controller;
    setBusy(true); setError(""); setResult(null); setFeedback("");
    try {
      const answer = await api<CodeExplanation>(snapshotPath(snapshotId, "/explanations"), { method: "POST", signal: controller.signal,
        body: JSON.stringify({ nodeId: node.id, action, audience, source: "ai", approvedPreviewId: preview.previewId }),
      });
      if (!controller.signal.aborted) setResult(answer);
    } catch (failure) { if (!ignoredAbort(failure)) setError(messageOf(failure)); }
    finally { if (generation.current === controller) { setBusy(false); generation.current = null; } }
  }
  async function clearCache() {
    generation.current?.abort(); setBusy(false); setError("");
    try { await api("/ai/cache", { method: "DELETE" }); setResult(null); setFeedback("已清除本项目的 AI 解释缓存。"); }
    catch (failure) { setError(messageOf(failure)); }
  }
  async function rate(value: "helpful" | "incorrect") {
    if (!result) return;
    try { await api(`/explanations/${encodeURIComponent(result.id)}/feedback`, { method: "POST", body: JSON.stringify({ value }) }); setFeedback(value === "helpful" ? "已记录反馈。" : "已标记有误，这条解释不再复用。"); }
    catch (failure) { setError(messageOf(failure)); }
  }
  const citations = (ids: string[], proofs: ContextEvidence[]) => <div className="citation-links">{ids.map((id, index) => {
    const proof = proofs.find((item) => item.id === id);
    return <button key={id} title={proof ? `${proof.filePath}:${proof.shownRange.start.line}` : "源码证据"} onClick={() => void evidence(id)} aria-label={`打开解释引用 ${index + 1} 的源码`}>{proof ? `${proof.filePath.split("/").at(-1)}:${proof.shownRange.start.line}` : `源码 ${index + 1}`}<Icon name="arrow" size={11}/></button>;
  })}</div>;
  return <div className="explanation-panel inspector-body">
    <div className="explanation-controls"><label htmlFor="explanation-question">我想了解</label><select id="explanation-question" value={action} onChange={(event) => setAction(event.target.value as ExplanationAction)}><option value="explain">解释这段代码</option><option value="importance">为什么值得关注</option><option value="neighbors">上下游是什么</option></select><div className="reading-density" aria-label="解释详细程度"><button aria-pressed={audience === "guided"} onClick={() => setAudience("guided")}>引导阅读</button><button aria-pressed={audience === "compact"} onClick={() => setAudience("compact")}>紧凑阅读</button></div></div>
    {error && <InlineError message={error} retry={() => setRetry((value) => value + 1)}/>}
    {!preview && !error && <LoadingRows label="整理这个节点的源码证据…"/>}
    {preview && <>
      {(stale || preview.stale) && <p className="explanation-stale">项目已变化，以下解释与证据针对当前显示的旧快照。</p>}
      <section className="ai-request-section"><div className="ai-provider-line"><strong>按需 AI 解释</strong><span>{settingsBusy ? "更新设置…" : status?.configured ? status.enabled ? "已启用" : "已配置 · 未启用" : "尚未配置"}</span></div>
        {status?.configured ? <><p className="ai-model-label">{status.model} · {status.destination}</p><label className="ai-enabled"><input type="checkbox" checked={status.enabled} disabled={settingsBusy} onChange={(event) => void enable(event.target.checked)}/>启用本项目的按需 AI</label></> : <details className="ai-configuration"><summary>配置 OpenAI 后可启用</summary><p>在启动本地服务的终端中设置 <code>OPENAI_API_KEY</code> 和 <code>CODEGRAPH_OPENAI_MODEL</code>，再重新启动工作台。模型需支持 Responses API 的结构化输出。</p><p>密钥只由本地服务读取，浏览器不收集或显示密钥。</p></details>}
        <div className="context-review"><h3>发送范围</h3><p>{preview.fileScope.length} 个文件的 {preview.evidence.length} 段证据 · {preview.characters.toLocaleString()} 个字符</p><ul>{preview.fileScope.map((file) => <li key={file.path}><Icon name="file" size={13}/><span title={file.path}>{file.path}</span><small>{file.snippets} 段</small></li>)}</ul><details><summary>查看将发送的源码片段<Icon name="chevron" size={12}/></summary>{preview.evidence.map((proof) => <div className="context-snippet" key={proof.id}><strong>{proof.filePath}:{proof.shownRange.start.line}–{proof.shownRange.end.line}</strong><pre>{proof.excerpt}</pre>{proof.truncated && <p>片段已截断，省略部分不会发送。</p>}</div>)}</details>{preview.truncated && <p className="context-limit">上下文已按预算缩减，AI 无法读取未展示的代码。</p>}</div>
        <div className="ai-request-actions"><button className="generate-explanation" disabled={settingsBusy || !status?.enabled || !preview.evidence.length || busy} onClick={() => void generate()}><Icon name="code" size={14}/>{busy ? "正在生成解释…" : "发送以上片段并用 AI 解释"}</button>{busy && <button className="text-action" onClick={() => { generation.current?.abort(); setBusy(false); }}>取消请求</button>}</div>
        <p className="ai-request-note">仅在点击后发送至 {status?.destination ?? "OpenAI"}；相同上下文优先复用本机缓存。</p>
      </section>
      {result?.fallbackReason && <p className="explanation-fallback" role="status">{fallback[result.fallbackReason]}</p>}
      {result?.interpretation && <section className="ai-answer" aria-label="AI 解释结果"><div className="ai-answer-heading"><h3>AI 说明</h3><span>{result.cacheHit ? "来自本机缓存" : "本次生成"}</span></div><p className="ai-answer-note">引用位置已校验，解释含义请结合源码核实。</p>{[result.interpretation.summary, ...result.interpretation.details].map((statement, index) => <div className="ai-statement" key={index}>{statement.kind === "hypothesis" && <span className="reason-origin">推断</span>}<p>{statement.text}</p>{citations(statement.evidenceIds, result.evidence)}</div>)}{result.interpretation.uncertainties.length > 0 && <div className="ai-uncertainties"><h4>仍需确认</h4><ul>{result.interpretation.uncertainties.map((text, index) => <li key={index}>{text}</li>)}</ul></div>}<div className="explanation-feedback"><span>这份解释是否有帮助？</span><button onClick={() => void rate("helpful")} disabled={!!feedback}>有帮助</button><button onClick={() => void rate("incorrect")} disabled={!!feedback}>有误</button></div></section>}
      {feedback && <p className="explanation-feedback-message" role="status">{feedback}</p>}
      <section className="local-facts"><div className="ai-answer-heading"><h3>本地可核实信息</h3><span>始终可用</span></div>{preview.facts.length ? preview.facts.map((fact, index) => <div className="local-fact" key={index}><span className="reason-origin">{fact.origin === "rule" ? "规则候选" : "静态解析"}</span><p>{fact.text}</p>{citations(fact.evidenceIds, preview.evidence)}</div>) : <p className="quiet-empty">当前节点尚无可引用的声明或关系，先从文件中的具体符号开始。</p>}</section>
      <button className="clear-explanation-cache" onClick={() => void clearCache()}>清除本项目的 AI 解释缓存</button>
    </>}
  </div>;
}
