import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createLocalServer } from "../../apps/local/dist/server.js";
import { copyRepresentative, prepareGitDemo, representativeProjects, generateWorkload } from "../../scripts/acceptance-projects.mjs";

const root = path.resolve(import.meta.dirname, "../.."), artifacts = path.join(root, "artifacts/phase-five");
let temporary; const servers = [], urls = new Map(), errors = [];
test.beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true }); temporary = mkdtempSync(path.join(artifacts, "browser-"));
  for (const item of representativeProjects) {
    const directory = path.join(temporary, item.name);
    if (item.name === "git-alias") prepareGitDemo(directory); else copyRepresentative(item.name, directory);
    const server = await createLocalServer({ rootDir: directory, dataDirectory: path.join(temporary, "cache"), ai: { apiKey: "", model: "" } });
    servers.push(server); urls.set(item.name, await server.listen(0));
  }
  const directory = generateWorkload(path.join(temporary, "hundred-nodes"), 121);
  const imports = Array.from({ length: 120 }, (_, index) => `import { step${index} } from './modules/m${String(index).padStart(3, "0")}';`);
  writeFileSync(path.join(directory, "src/main.ts"), `${imports.join("\n")}\nexport function main() { return ${Array.from({ length: 120 }, (_, index) => `step${index}(1)`).join(" + ")}; }\n`);
  const stress = await createLocalServer({ rootDir: directory, dataDirectory: path.join(temporary, "cache"), ai: { apiKey: "", model: "" } });
  servers.push(stress); urls.set("hundred-nodes", await stress.listen(0));
});
test.afterAll(async () => {
  for (const server of servers) await server.app.close();
  if (temporary) { const target = path.resolve(temporary); if (!target.startsWith(path.resolve(artifacts) + path.sep)) throw Error("Unsafe cleanup"); rmSync(target, { recursive: true, force: true }); }
});
test.beforeEach(({ page }) => { errors.length = 0; page.on("pageerror", (error) => errors.push(error.message)); });
test.afterEach(() => expect(errors).toEqual([]));

for (const item of representativeProjects) test(`representative ${item.name}: discover, inspect, read, explain and resume`, async ({ page }) => {
  await page.goto(urls.get(item.name));
  await expect(page.locator(".snapshot-state")).toBeVisible();
  await expect(page.locator(".graph-card").first()).toBeVisible();
  await expect(page.getByText("自动布局未完成，已使用网格布局。也可切换列表查看。", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "搜索文件或符号" }).fill(item.focus);
  await page.getByRole("option", { name: new RegExp(`^${item.focus}`) }).first().click();
  await expect(page.getByRole("heading", { level: 2, name: item.focus, exact: true })).toBeVisible();
  await expect(page.locator(".source-code")).toContainText(`function ${item.focus}`);
  await page.getByRole("button", { name: "加入阅读清单", exact: true }).click();
  await expect(page.getByRole("button", { name: "从阅读清单移除当前节点", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "解释", exact: true }).click();
  await expect(page.locator(".local-facts")).toContainText(item.focus);
  await expect(page.getByRole("button", { name: "发送以上片段并用 AI 解释" })).toBeDisabled();
  await page.locator(".local-fact").first().getByRole("button").first().click();
  await expect(page.locator(".source-line.highlighted").first()).toContainText(item.focus);
  await page.getByRole("button", { name: "阅读导览", exact: true }).first().click();
  await expect(page.locator(".recommendation-row").first()).toBeVisible();
  await page.getByRole("tab", { name: "推荐顺序", exact: true }).click();
  await expect(page.locator(".reading-order > li").first()).toBeVisible();
  await page.getByRole("tab", { name: /^我的清单/ }).click();
  await page.getByRole("checkbox", { name: `标记 ${item.focus} 为已读` }).check();
  await expect(page.locator(".reading-list-summary")).toContainText("已读 1 / 1");
  await page.reload(); await page.getByRole("button", { name: "阅读导览", exact: true }).first().click();
  await page.getByRole("tab", { name: /^我的清单/ }).click();
  await expect(page.getByRole("checkbox", { name: `标记 ${item.focus} 为已读` })).toBeChecked();
  if (item.name === "git-alias") {
    await page.getByRole("button", { name: "改动影响", exact: true }).first().click();
    await page.locator(".compare-button").click();
    await expect(page.locator(".file-change").first()).toBeVisible();
    await page.getByRole("tab", { name: "关联路径", exact: true }).click();
    await page.getByRole("button", { name: "查看 旧版 legacyOrder 到 legacyDiscount 的调用证据", exact: true }).first().click();
    await expect(page.locator(".source-line.highlighted")).toContainText("legacyDiscount");
  }
  await page.screenshot({ path: path.join(artifacts, `${item.name}-1440.png`) });
});

test("100-node graph stays bounded and supports zoom, list navigation and source selection", async ({ page }) => {
  await page.goto(urls.get("hundred-nodes")); await expect(page.locator(".snapshot-state")).toContainText("分析完成");
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await page.evaluate(() => {
    const state = { last: performance.now(), maxGap: 0, stop: false }; window.__frameProbe = state;
    const frame = (now) => { state.maxGap = Math.max(state.maxGap, now - state.last); state.last = now; if (!state.stop) requestAnimationFrame(frame); }; requestAnimationFrame(frame);
  });
  await page.getByRole("combobox", { name: "搜索文件或符号" }).fill("main");
  await page.getByRole("option", { name: /^main/ }).first().click();
  await expect(page.locator(".graph-list-row")).toHaveCount(100);
  await expect(page.locator(".truncation-note")).toBeVisible();
  const began = performance.now();
  await page.getByRole("tab", { name: "图谱", exact: true }).click();
  await expect(page.locator(".graph-card")).toHaveCount(100, { timeout: 10_000 });
  const layoutMs = performance.now() - began;
  const viewport = page.locator(".react-flow__viewport"), before = await viewport.getAttribute("style");
  await page.getByRole("button", { name: "放大图谱", exact: true }).click();
  await expect(viewport).not.toHaveAttribute("style", before);
  const maxFrameGapMs = await page.evaluate(() => { window.__frameProbe.stop = true; return window.__frameProbe.maxGap; });
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await page.locator(".graph-list-row").nth(20).locator(".node-list-name").click();
  await expect(page.locator(".source-code")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  writeFileSync(path.join(artifacts, "browser-performance.json"), JSON.stringify({ generatedAt: new Date().toISOString(), nodes: 100, layoutMs, maxFrameGapMs, budgets: { layoutMs: 5000, maxFrameGapMs: 1000 }, passed: layoutMs <= 5000 && maxFrameGapMs <= 1000 }, null, 2));
  expect(layoutMs).toBeLessThanOrEqual(5000); expect(maxFrameGapMs).toBeLessThanOrEqual(1000);
  await page.screenshot({ path: path.join(artifacts, "hundred-nodes-list-1440.png") });
});

test("failed or silent layout workers and transient source errors leave usable fallbacks", async ({ page }) => {
  let failedSource = false;
  await page.route("**/assets/layout-worker-*.js", (route) => route.abort());
  await page.route("**/api/snapshots/*/files/*", (route) => {
    if (!failedSource) { failedSource = true; return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ message: "源码读取暂时不可用，请重试。" }) }); }
    return route.continue();
  });
  await page.goto(urls.get("ts-inventory"));
  await expect(page.locator(".graph-card").first()).toBeVisible();
  await expect(page.getByText("自动布局未完成，已使用网格布局。也可切换列表查看。", { exact: true })).toBeVisible();
  await expect(page.getByText("源码读取暂时不可用，请重试。", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "重试", exact: true }).click();
  await expect(page.locator(".source-code")).toBeVisible();
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await expect(page.locator(".graph-list-row").first()).toBeVisible();
  await page.unroute("**/assets/layout-worker-*.js");
  await page.route("**/assets/layout-worker-*.js", (route) => route.fulfill({ contentType: "application/javascript", body: "self.onmessage = () => {};" }));
  await page.reload();
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await expect(page.locator(".graph-list-row").first()).toBeVisible();
  await page.getByRole("tab", { name: "图谱", exact: true }).click();
  await expect(page.getByText("自动布局耗时较长，已使用网格布局。也可切换列表查看。", { exact: true })).toBeVisible();
  await expect(page.locator(".graph-card").first()).toBeVisible();
});
