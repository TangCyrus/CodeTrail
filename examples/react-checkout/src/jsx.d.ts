// Minimal host element types for this source-reading example; no React runtime is executed.
declare namespace JSX {
  interface Element { }
  interface IntrinsicElements { [tag: string]: unknown; }
}
