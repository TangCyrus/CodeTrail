import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";

/** Controlled loopback protocol fixture. Never forwards to an external provider. */
export async function mockResponses() {
  const requests = [];
  const state = { mode: "valid", delayMs: 0 };
  const server = createServer(async (request, response) => {
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const body = JSON.parse(raw);
    const context = JSON.parse(body.input[0].content[0].text);
    const mode = state.mode;
    const delayMs = state.delayMs;
    requests.push({ url: request.url, headers: request.headers, body, context });
    if (delayMs) await delay(delayMs);
    if (response.destroyed) return;
    if (mode === "error") { response.writeHead(429); response.end("upstream secret error body"); return; }
    const proof = context.evidence[0]?.id;
    const summary = { text: "这段代码的声明和相关调用可从所列源码核实。", evidenceIds: [proof], kind: "explanation" };
    if (mode === "wrong-citation") summary.evidenceIds = ["fabricated-proof"];
    if (mode === "uncited") summary.evidenceIds = [];
    const interpretation = { summary, details: [{ text: "推断：可以从此处开始理解相关流程。", evidenceIds: [proof], kind: "hypothesis" }], uncertainties: ["静态片段不能证明运行时执行路径。"] };
    const content = mode === "refusal" ? [{ type: "refusal", refusal: "refused" }] : [{ type: "output_text", text: mode === "malformed" ? "{bad json" : JSON.stringify(interpretation) }];
    const result = { status: mode === "incomplete" ? "incomplete" : "completed", output: [{ type: "message", role: "assistant", content }] };
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(mode === "oversized" ? JSON.stringify({ padding: "x".repeat(270_000) }) : JSON.stringify(result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { requests, state, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, close: async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
  } };
}

export async function waitUntil(predicate) {
  for (let index = 0; index < 150; index++) { if (predicate()) return; await delay(10); }
  throw new Error("Timed out waiting for controlled request");
}
