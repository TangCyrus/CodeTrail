import { useEffect, useState } from "react";
import type { EvidenceDetail, ExplorerNode, ReadingGuide as GuideData, ReadingList } from "@codegraph/shared";
import { api, ignoredAbort, messageOf, snapshotPath } from "./api.js";
import { Icon, InlineError, kindLabel, LoadingRows, NodeGlyph } from "./ui.js";

export function ReadingGuide({ snapshotId, revision, onChange, onSelect, onNavigate, onEvidence }: {
  snapshotId: string; revision: number; onChange: () => void;
  onSelect: (node: ExplorerNode) => void; onNavigate: (node: ExplorerNode) => void; onEvidence: (proof: EvidenceDetail) => void;
}) {
  const [guide, setGuide] = useState<GuideData | null>(null);
  const [list, setList] = useState<ReadingList | null>(null);
  const [tab, setTab] = useState<"key" | "order" | "saved">("key");
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    setGuide(null); setError("");
    void api<GuideData>(snapshotPath(snapshotId, "/reading"), { signal: controller.signal }).then(setGuide)
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => controller.abort();
  }, [snapshotId, retry]);
  useEffect(() => {
    const controller = new AbortController();
    void api<ReadingList>(snapshotPath(snapshotId, "/reading-list"), { signal: controller.signal }).then(setList)
      .catch((failure: unknown) => { if (!ignoredAbort(failure)) setError(messageOf(failure)); });
    return () => controller.abort();
  }, [snapshotId, revision, retry]);
  async function save(node: ExplorerNode) {
    setBusy(node.id); setError("");
    try { setList(await api<ReadingList>(snapshotPath(snapshotId, "/reading-list"), { method: "POST", body: JSON.stringify({ nodeId: node.id }) })); onChange(); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(null); }
  }
  async function update(key: string, read: boolean) {
    setBusy(key); setError("");
    setList((current) => {
      if (!current) return current;
      const items = current.items.map((item) => item.key === key ? { ...item, read } : item);
      return { ...current, items, readCount: items.filter((item) => item.read).length };
    });
    try { await api(`/reading-list/${key}`, { method: "PATCH", body: JSON.stringify({ read }) }); onChange(); }
    catch (failure) { setError(messageOf(failure)); onChange(); }
    finally { setBusy(null); }
  }
  async function remove(key: string) {
    setBusy(key); setError("");
    try { await api(`/reading-list/${key}`, { method: "DELETE" }); onChange(); }
    catch (failure) { setError(messageOf(failure)); }
    finally { setBusy(null); }
  }
  async function proof(id: string) {
    try { onEvidence(await api<EvidenceDetail>(snapshotPath(snapshotId, `/evidence/${encodeURIComponent(id)}`))); }
    catch (failure) { setError(messageOf(failure)); }
  }
  const saved = (node: ExplorerNode) => !!list?.items.some((item) => item.node?.id === node.id);
  const saveButton = (node: ExplorerNode) => <button className="reading-save" disabled={saved(node) || busy === node.id} onClick={() => void save(node)} aria-label={`${saved(node) ? "已加入" : "加入"} ${node.name} 的阅读清单`}><Icon name={saved(node) ? "check" : "bookmark"} size={14}/>{saved(node) ? "已加入" : "加入清单"}</button>;
  return <div className="reading-page">
    <div className="reading-tabs" role="tablist" aria-label="阅读导览方式"><button role="tab" aria-selected={tab === "key"} onClick={() => setTab("key")}>关键代码</button><button role="tab" aria-selected={tab === "order"} onClick={() => setTab("order")}>推荐顺序</button><button role="tab" aria-selected={tab === "saved"} onClick={() => setTab("saved")}>我的清单{list && <span>{list.total}</span>}</button></div>
    <div className="reading-content">
      {error && <InlineError message={error} retry={() => setRetry((value) => value + 1)}/>}
      {!guide && !error && <LoadingRows label="整理结构线索与阅读路径…"/>}
      {guide && tab === "key" && <>
        <p className="reading-intro">根据入口规则、跨文件引用和目录连接推荐。每条理由都能回到源码；业务重要性仍需你确认。</p>
        {guide.groups.filter((group) => group.items.length).map((group) => <section className="recommendation-group" key={group.id}><div className="reading-section-heading"><h2>{group.title}</h2><span>{group.description}</span></div>{group.items.map((item) => <article className="recommendation-row" key={item.node.id}>
          <div className="reading-node-heading"><button className="reading-node" onClick={() => onSelect(item.node)}><NodeGlyph node={item.node}/><span><strong>{item.node.name}</strong><small>{item.node.path}:{item.node.range?.start.line}</small></span></button>{saveButton(item.node)}</div>
          <div className="reading-signals"><span>{item.metrics.referencingFiles} 个其他文件引用</span><span>{item.metrics.connectedModules} 个跨模块关联</span>{item.metrics.exported && <span>导出符号</span>}</div>
          <details className="recommendation-reasons"><summary>为什么推荐<Icon name="chevron" size={12}/></summary>{item.reasons.map((reason) => <div className="recommendation-reason" key={reason.code}><span className="reason-origin">{reason.origin === "rule" ? "规则候选" : "静态解析"}</span><p>{reason.text}</p><div className="citation-links">{reason.evidenceIds.map((id, index) => <button key={id} onClick={() => void proof(id)} aria-label={`查看 ${item.node.name} 推荐理由的证据 ${index + 1}`}>源码 {index + 1}<Icon name="arrow" size={11}/></button>)}</div></div>)}</details>
          <button className="text-action reading-open" onClick={() => onNavigate(item.node)}>在图谱中展开<Icon name="arrow" size={13}/></button>
        </article>)}</section>)}
        {!guide.groups.some((group) => group.items.length) && <div className="reading-empty"><h2>暂时没有足够的推荐线索</h2><p>可以从架构概览选择模块，再把关注的代码加入阅读清单。</p></div>}
        {guide.excludedFiles > 0 && <p className="reading-footnote">已排除 {guide.excludedFiles} 个测试、声明或生成文件，避免它们主导核心推荐。</p>}
      </>}
      {guide && tab === "order" && <><p className="reading-intro">先核实入口候选，再沿已解析的调用与组件使用关系阅读。以下顺序不代表实际执行顺序。</p><ol className="reading-order">{guide.readingOrder.map((step) => <li key={step.node.id}><span className="reading-step-number">{step.order}</span><div className="reading-step-body"><div className="reading-node-heading"><button className="reading-node" onClick={() => onSelect(step.node)}><span><strong>{step.node.name}</strong><small>{step.node.path}</small></span></button>{saveButton(step.node)}</div><p>{step.reason}</p><div className="reading-step-actions"><button className="text-action" onClick={() => void proof(step.evidenceIds[0]!)}>核实这一步<Icon name="arrow" size={13}/></button><button className="text-action" onClick={() => onNavigate(step.node)}>展开关系</button></div></div></li>)}</ol>{!guide.readingOrder.length && <p className="quiet-empty">当前范围没有可构建的阅读路径，可从目录浏览开始。</p>}</>}
      {tab === "saved" && <><div className="reading-list-summary"><h2>我的阅读清单</h2><span>已读 {list?.readCount ?? 0} / {list?.total ?? 0}</span></div><p className="reading-intro">清单与阅读进度保存在本机。文件位置变化后会尝试精确匹配，无法确认时保留记录供你整理。</p>{!list ? <LoadingRows label="读取清单…"/> : list.items.length ? list.items.map((item) => <div className="bookmark-row" key={item.key}><label className="bookmark-check"><input type="checkbox" checked={item.read} disabled={busy === item.key} onChange={(event) => void update(item.key, event.target.checked)} aria-label={`标记 ${item.savedNode.name} 为已读`}/></label><button className="reading-node" disabled={!item.node} onClick={() => item.node && onSelect(item.node)}><span><strong className={item.read ? "is-read" : ""}>{item.savedNode.name}</strong><small>{item.savedNode.path} · {item.node ? kindLabel(item.node.kind) : "当前快照无法唯一定位"}</small></span></button><button className="icon-button" disabled={busy === item.key} onClick={() => void remove(item.key)} aria-label={`移除 ${item.savedNode.name} 的阅读记录`}><Icon name="close" size={14}/></button></div>) : <div className="reading-empty"><Icon name="bookmark" size={24}/><h3>把关注的代码留在这里</h3><p>从推荐条目或源码侧栏加入清单，再按自己的节奏标记已读。</p><button className="text-action" onClick={() => setTab("key")}>查看关键代码<Icon name="arrow" size={13}/></button></div>}</>}
    </div>
  </div>;
}
