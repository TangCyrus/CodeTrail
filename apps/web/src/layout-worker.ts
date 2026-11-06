import ELK from "elkjs/lib/elk.bundled.js";
import type { ElkNode } from "elkjs/lib/elk-api.js";

export interface LayoutRequest { nodes: { id: string }[]; edges: { id: string; from: string; to: string }[] }
export interface LayoutReply { result?: ElkNode; failed?: boolean }
const channel = self as unknown as { onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null; postMessage: (reply: LayoutReply) => void };
channel.onmessage = (event) => {
  const graph = event.data;
  if (!Array.isArray(graph.nodes) || graph.nodes.length > 100 || !Array.isArray(graph.edges)) { channel.postMessage({ failed: true }); return; }
  void new ELK().layout<ElkNode>({ id: "root", layoutOptions: {
    "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL", "elk.spacing.nodeNode": "40",
    "elk.layered.spacing.nodeNodeBetweenLayers": "76", "elk.layered.nodePlacement.strategy": "NETWORK_SIMPLEX",
  }, children: graph.nodes.map((node) => ({ id: node.id, width: 196, height: 100 })),
  edges: graph.edges.map((edge) => ({ id: edge.id, sources: [edge.from], targets: [edge.to] })) })
    .then((result) => channel.postMessage({ result })).catch(() => channel.postMessage({ failed: true }));
};
