import { useEffect, useRef, useState } from "react";
import { ReactFlow, Background, BackgroundVariant, BaseEdge, EdgeLabelRenderer, Controls, Handle, MarkerType, Position, type Node, type NodeProps, type Edge, type EdgeProps, type ReactFlowInstance } from "@xyflow/react";
import type { ExplorerEdge, ExplorerGraph, ExplorerNode } from "@codegraph/shared";
import type { LayoutReply } from "./layout-worker.js";
import { Icon, kindLabel, NodeGlyph, relationLabel, InlineError } from "./ui.js";

type FlowNode = Node<{ item: ExplorerNode; active: boolean }, "explorer">;
function ExplorerCard({ data }: NodeProps<FlowNode>) {
  return <div className={`graph-card ${data.active ? "is-selected" : ""}`}>
    <Handle type="target" position={Position.Left}/>
    <div className="graph-card-type"><NodeGlyph node={data.item}/><span>{kindLabel(data.item.kind)}</span>{data.item.exported && <span className="export-mark">导出</span>}</div>
    <strong title={data.item.name}>{data.item.name}</strong>
    <span className="graph-card-caption" title={data.item.path}>{data.item.kind === "module" ? `${data.item.fileCount} 个文件 · ${data.item.symbolCount} 个符号` : data.item.path}</span>
    <Handle type="source" position={Position.Right}/>
  </div>;
}
const nodeTypes = { explorer: ExplorerCard };
interface RouteData extends Record<string, unknown> { path: string; labelX: number; labelY: number }
function RoutedEdge(props: EdgeProps<Edge<RouteData>>) {
  if (!props.data) return null;
  return <><BaseEdge id={props.id} path={props.data.path} {...(props.markerEnd ? { markerEnd: props.markerEnd } : {})} style={props.style} interactionWidth={20}/><EdgeLabelRenderer><span className="routed-edge-label" style={{ transform: `translate(-50%, -100%) translate(${props.data.labelX}px, ${props.data.labelY - 5}px)` }}>{props.label}</span></EdgeLabelRenderer></>;
}
const edgeTypes = { routed: RoutedEdge };
function route(points: { x: number; y: number }[]): RouteData {
  let best = { x: points[0]?.x ?? 0, y: points[0]?.y ?? 0, length: -1 };
  for (let index = 1; index < points.length; index++) {
    const a = points[index - 1]!; const b = points[index]!;
    if (Math.abs(a.y - b.y) < 1 && Math.abs(a.x - b.x) > best.length) best = { x: (a.x + b.x) / 2, y: a.y, length: Math.abs(a.x - b.x) };
  }
  return { path: points.map((point, index) => `${index ? "L" : "M"}${point.x},${point.y}`).join(" "), labelX: best.x, labelY: best.y };
}

export function GraphView({ graph, selected, onSelect, onNavigate, onEdge }: {
  graph: ExplorerGraph; selected: string | null;
  onSelect: (node: ExplorerNode) => void; onNavigate: (node: ExplorerNode) => void; onEdge: (edge: ExplorerEdge) => void;
}) {
  const [layout, setLayout] = useState<{ id: ExplorerGraph; nodes: FlowNode[]; routes?: Map<string, RouteData>; error?: string } | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const flow = useRef<ReactFlowInstance<FlowNode> | null>(null);
  useEffect(() => {
    if (!container.current) return;
    let timer: ReturnType<typeof setTimeout>;
    let width = container.current.clientWidth, height = container.current.clientHeight;
    const observer = new ResizeObserver(([entry]) => {
      if (!entry || Math.abs(entry.contentRect.width - width) < 1 && Math.abs(entry.contentRect.height - height) < 1) return;
      width = entry.contentRect.width; height = entry.contentRect.height;
      clearTimeout(timer); timer = setTimeout(() => { void flow.current?.fitView({ padding: 0.22, maxZoom: 1 }); }, 80);
    });
    observer.observe(container.current);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [layout]);
  useEffect(() => {
    let valid = true;
    let worker: Worker | undefined;
    let settled = false;
    const fallback = (message: string) => {
      if (!valid || settled) return;
      settled = true; clearTimeout(timeout); worker?.terminate();
      setLayout({ id: graph, error: message, nodes: graph.nodes.map((item, index) => ({ id: item.id, type: "explorer", position: { x: (index % 3) * 250, y: Math.floor(index / 3) * 150 }, data: { item, active: false }, ariaLabel: `${kindLabel(item.kind)} ${item.name}` })) });
    };
    const timeout = setTimeout(() => fallback("自动布局耗时较长，已使用网格布局。也可切换列表查看。"), 2000);
    try {
      worker = new Worker(new URL("./layout-worker.ts", import.meta.url), { type: "module" });
      worker.onmessage = (event: MessageEvent<LayoutReply>) => {
        if (!valid || settled) return;
        const result = event.data.result;
        if (!result) { fallback("自动布局未完成，已使用网格布局。也可切换列表查看。"); return; }
        settled = true; clearTimeout(timeout); worker?.terminate();
        const routes = new Map<string, RouteData>();
        for (const edge of result.edges ?? []) {
          const section = edge.sections?.[0];
          if (section) routes.set(edge.id, route([section.startPoint, ...(section.bendPoints ?? []), section.endPoint]));
        }
        setLayout({ id: graph, routes, nodes: graph.nodes.map((item) => {
          const position = result.children?.find((entry) => entry.id === item.id);
          return { id: item.id, type: "explorer", position: { x: position?.x ?? 0, y: position?.y ?? 0 }, data: { item, active: false }, ariaLabel: `${kindLabel(item.kind)} ${item.name}` };
        }) });
      };
      worker.onerror = (event) => { event.preventDefault(); fallback("自动布局未完成，已使用网格布局。也可切换列表查看。"); };
      worker.onmessageerror = () => fallback("自动布局未完成，已使用网格布局。也可切换列表查看。");
      worker.postMessage({ nodes: graph.nodes.map((node) => ({ id: node.id })), edges: graph.edges.map((edge) => ({ id: edge.id, from: edge.from, to: edge.to })) });
    } catch { fallback("自动布局未完成，已使用网格布局。也可切换列表查看。"); }
    return () => { valid = false; clearTimeout(timeout); worker?.terminate(); };
  }, [graph]);
  if (!graph.nodes.length) return <div className="graph-empty"><Icon name="graph" size={30}/><h2>当前范围没有可展示的节点</h2><p>可以返回概览，或检查文件范围与解析诊断。</p></div>;
  if (layout?.id !== graph) return <div className="graph-loading" role="status">正在排列 {graph.nodes.length} 个节点…</div>;
  const edges: Edge[] = graph.edges.map((edge) => ({
    id: edge.id, source: edge.from, target: edge.to, type: layout.routes?.has(edge.id) ? "routed" : "smoothstep", ...(layout.routes?.has(edge.id) ? { data: layout.routes.get(edge.id)! } : {}),
    label: `${relationLabel(edge.kind)}${edge.usage === "type" ? " · 类型" : edge.usage === "mixed" ? " · 混合" : ""}${edge.count > 1 ? ` ×${edge.count}` : ""}`,
    markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: edge.origin === "rule" ? "var(--muted)" : "var(--accent)" },
    style: { stroke: edge.kind === "CONTAINS" ? "var(--control)" : "var(--accent)", strokeWidth: edge.kind === "CONTAINS" ? 1 : 1.4, ...(edge.origin === "rule" ? { strokeDasharray: "5 4" } : {}) },
    labelStyle: { fill: "var(--muted)", fontSize: 12 }, labelBgStyle: { fill: "var(--surface)" }, labelBgPadding: [5, 3],
    ariaLabel: `${relationLabel(edge.kind)}，${edge.count} 处证据`,
  }));
  return <div className="flow-container" data-testid="graph-canvas" ref={container} onKeyDownCapture={(event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    const element = (event.target as Element).closest(".react-flow__node");
    const item = graph.nodes.find((node) => node.id === element?.getAttribute("data-id"));
    if (item) { event.preventDefault(); event.stopPropagation(); onSelect(item); }
  }}>
    {layout.error && <InlineError message={layout.error}/>}
    <ReactFlow<FlowNode, Edge> key={`${graph.scope}:${graph.breadcrumbs.at(-1)?.id ?? "root"}:${graph.nodes.length}`} nodes={layout.nodes.map((node) => ({ ...node, selected: node.id === selected, data: { ...node.data, active: node.id === selected } }))} edges={edges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
      fitView fitViewOptions={{ padding: 0.22, maxZoom: 1 }} minZoom={0.3} maxZoom={1.6} nodesDraggable={false} nodesConnectable={false}
      onNodeClick={(_event, node) => onSelect(node.data.item)} onNodeDoubleClick={(_event, node) => onNavigate(node.data.item)}
      onInit={(instance) => { flow.current = instance; }}
      onEdgeClick={(_event, edge) => { const item = graph.edges.find((candidate) => candidate.id === edge.id); if (item) onEdge(item); }}
      proOptions={{ hideAttribution: true }} ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "放大图谱", "controls.zoomOut.ariaLabel": "缩小图谱", "controls.fitView.ariaLabel": "适应画布", "node.a11yDescription.default": "按 Enter 选择节点，使用右侧按钮进入模块或展开关系。" }}>
      <Background variant={BackgroundVariant.Dots} gap={24} size={1} color="var(--grid-dot)"/>
      <Controls showInteractive={false} position="bottom-right"/>
    </ReactFlow>
    <div className="graph-hint"><span className="legend-link"/>静态关系<span className="legend-candidate"/>回调候选<span className="hint-action">点击查看 · 双击进入</span></div>
  </div>;
}
