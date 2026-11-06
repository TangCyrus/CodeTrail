import { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/ibm-plex-sans/latin-400.css";
import "@fontsource/ibm-plex-sans/latin-500.css";
import "@fontsource/ibm-plex-sans/latin-600.css";
import "@fontsource/ibm-plex-mono/latin-400.css";
import "@xyflow/react/dist/style.css";
import "./styles.css";
import App from "./App.js";

class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(_error: Error, _info: ErrorInfo) { /* Keep code and session details out of the browser log. */ }
  render() {
    return this.state.failed ? <main className="fatal-error"><h1>工作台未能完成显示</h1><p>本地分析结果仍保存在缓存中，可以重新载入界面。</p><button onClick={() => window.location.reload()}>重新载入</button></main> : this.props.children;
  }
}
createRoot(document.getElementById("root")!).render(<ErrorBoundary><App/></ErrorBoundary>);
