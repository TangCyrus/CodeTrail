import type { CSSProperties, ReactNode } from "react";
import type { ExplorerNode, RelationKind } from "@codetrail/shared";

type IconName = "search" | "folder" | "file" | "graph" | "list" | "arrow" | "back" | "chevron" | "refresh" | "close" | "code" | "link" | "menu" | "info" | "copy" | "check" | "stop" | "bookmark" | "book";
const paths: Record<IconName, ReactNode> = {
  bookmark: <path d="M6 3h12v18l-6-4-6 4Z"/>,
  book: <><path d="M12 5C9 3 6 3 3 4v15c3-1 6-1 9 1m0-15c3-2 6-2 9-1v15c-3-1-6-1-9 1Zm0 0v15"/></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/></>,
  folder: <path d="M3 6h6l2 2h10v11H3Z"/>,
  file: <><path d="M6 3h8l4 4v14H6Z"/><path d="M14 3v5h4M9 13h6M9 17h6"/></>,
  graph: <><rect x="3" y="8" width="5" height="7" rx="1"/><rect x="16" y="3" width="5" height="6" rx="1"/><rect x="16" y="16" width="5" height="6" rx="1"/><path d="M8 11h4V6h4M12 11v8h4"/></>,
  list: <><path d="M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1"/></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6"/>,
  back: <path d="M20 12H4m6-6-6 6 6 6"/>,
  chevron: <path d="m9 5 7 7-7 7"/>,
  refresh: <><path d="M20 8a8 8 0 1 0 0 8M20 3v5h-5"/></>,
  close: <path d="m6 6 12 12M6 18 18 6"/>,
  code: <><path d="m8 5-6 7 6 7m8-14 6 7-6 7m-3-16-2 18"/></>,
  link: <><path d="m9 15 6-6M8 16l-1 1a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0M16 8l1-1a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0" transform="translate(0 -1) scale(.95)"/></>,
  menu: <path d="M4 6h16M4 12h16M4 18h16"/>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/></>,
  copy: <><rect x="8" y="8" width="12" height="13" rx="1"/><path d="M16 8V3H3v13h5"/></>,
  check: <path d="m4 12 5 5L20 6"/>,
  stop: <rect x="6" y="6" width="12" height="12" rx="1"/>,
};
export function Icon({ name, size = 16, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}>{paths[name]}</svg>;
}
export function BrandMark() { return <img className="brand-mark" src="/mark.svg" alt="" width="28" height="28"/>; }
export const kindLabel = (kind: ExplorerNode["kind"]): string => ({ module: "模块", file: "文件", function: "函数", method: "方法", class: "类", interface: "接口", type: "类型", variable: "变量", parameter: "参数", property: "属性", enum: "枚举" })[kind];
export const relationLabel = (kind: RelationKind): string => ({ CONTAINS: "包含", IMPORTS: "导入", CALLS: "调用", REFERENCES: "引用", RENDERS: "组件使用", REGISTERS_CALLBACK: "回调候选" })[kind];
export function NodeGlyph({ node }: { node: ExplorerNode }) {
  if (node.kind === "module" || node.kind === "file") return <Icon name={node.kind === "module" ? "folder" : "file"}/>;
  return <span className="symbol-glyph" aria-hidden="true">{node.kind === "class" ? "C" : node.kind === "interface" || node.kind === "type" ? "T" : "ƒ"}</span>;
}
export function InlineError({ message, retry }: { message: string; retry?: () => void }) {
  return <div className="inline-error" role="alert"><Icon name="info"/><span>{message}</span>{retry && <button onClick={retry}>重试</button>}</div>;
}
export function LoadingRows({ label }: { label: string }) {
  return <div className="loading-rows" role="status"><p>{label}</p><span/><span/><span/></div>;
}
