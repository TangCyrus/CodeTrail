import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createLocalServer } from "../../apps/local/dist/server.js";
import { mockResponses, waitUntil } from "../mock-responses.mjs";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, "artifacts/phase-three");
let server, local, mock, temporary, url, localUrl;
test.beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true }); temporary = mkdtempSync(path.join(artifacts, "browser-"));
  mock = await mockResponses();
  server = await createLocalServer({ rootDir: path.join(root, "fixtures/reference-lab"), dataDirectory: path.join(temporary, "ai"),
    ai: { apiKey: "browser-fixture-secret", model: "test-structured-model", baseUrl: mock.baseUrl } });
  local = await createLocalServer({ rootDir: path.join(root, "fixtures/reference-lab"), dataDirectory: path.join(temporary, "local"), ai: { apiKey: "", model: "" } });
  url = await server.listen(0); localUrl = await local.listen(0);
});
test.afterAll(async () => {
  await server?.app.close(); await local?.app.close(); await mock?.close();
  if (temporary) {
    const resolved = path.resolve(temporary);
    if (!resolved.startsWith(path.resolve(artifacts) + path.sep)) throw new Error("Unsafe cleanup path");
    rmSync(resolved, { recursive: true, force: true });
  }
});
test.beforeEach(async ({ page }) => {
  await page.goto(localUrl);
  await expect(page.locator(".snapshot-state")).toContainText("分析完成");
});
async function reading(page) {
  if (await page.getByRole("button", { name: "打开项目导航" }).isVisible()) await page.getByRole("button", { name: "打开项目导航" }).click();
  await page.getByRole("button", { name: "阅读导览", exact: true }).first().click();
  await expect(page.locator(".recommendation-row").first()).toBeVisible();
}
async function selectStart(page) {
  await page.getByRole("combobox", { name: "搜索文件或符号" }).fill("start");
  await page.getByRole("option", { name: /^start/ }).first().click();
  await expect(page.getByRole("heading", { name: "start", level: 2, exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "解释", exact: true }).click();
  await expect(page.locator(".context-review")).toBeVisible();
}

test("recommendations and reading sequence lead to real source; saved reading state survives reload", async ({ page }) => {
  await reading(page);
  const start = page.locator(".recommendation-row").filter({ has: page.getByText("start", { exact: true }) });
  await start.getByText("为什么推荐", { exact: true }).click();
  await expect(start.locator(".recommendation-reason").first()).toContainText("规则候选");
  await start.getByRole("button", { name: /查看 start 推荐理由的证据/ }).first().click();
  await expect(page.locator(".source-line.highlighted").first()).toContainText("function start");
  await start.getByRole("button", { name: "加入 start 的阅读清单", exact: true }).click();
  await expect(start.getByRole("button", { name: "已加入 start 的阅读清单" })).toBeDisabled();
  await page.getByRole("tab", { name: "推荐顺序", exact: true }).click();
  await expect(page.locator(".reading-order > li").first()).toContainText("start");
  const submit = page.locator(".reading-order > li").filter({ has: page.getByText("submit", { exact: true }) });
  await expect(submit).toContainText("沿 start 的调用");
  await page.getByRole("tab", { name: /^我的清单/ }).click();
  await page.getByRole("checkbox", { name: "标记 start 为已读" }).check();
  await expect(page.locator(".reading-list-summary")).toContainText("已读 1 / 1");
  await page.reload(); await reading(page);
  await page.getByRole("tab", { name: /^我的清单/ }).click();
  await expect(page.getByRole("checkbox", { name: "标记 start 为已读" })).toBeChecked();
  await page.screenshot({ path: path.join(artifacts, "reading-list-1440.png") });
  await page.getByRole("button", { name: "移除 start 的阅读记录" }).click();
  await expect(page.locator(".reading-empty")).toContainText("把关注的代码留在这里");
});

test("without credentials local explanation is useful, question and reading mode update the preview, citations open source", async ({ page }) => {
  await selectStart(page);
  await expect(page.locator(".ai-provider-line")).toContainText("尚未配置");
  await expect(page.getByRole("button", { name: "发送以上片段并用 AI 解释" })).toBeDisabled();
  await expect(page.locator(".local-facts")).toContainText("start");
  await page.getByLabel("我想了解", { exact: true }).selectOption("importance");
  await expect(page.locator(".local-facts")).toContainText("规则候选");
  await page.getByRole("button", { name: "紧凑阅读", exact: true }).click();
  await expect(page.getByRole("button", { name: "紧凑阅读", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".local-fact").first()).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "local-explanation-1440.png") });
  await page.locator(".local-fact").first().getByRole("button").first().click();
  await expect(page.getByRole("tab", { name: "源码", exact: true })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".source-line.highlighted").first()).toContainText("function start");
});

test("AI sends only after reviewing scope, reuses cache and rejects fabricated citations", async ({ page }) => {
  mock.state.mode = "valid"; mock.state.delayMs = 0;
  await page.goto(url); await expect(page.locator(".snapshot-state")).toContainText("分析完成");
  const before = mock.requests.length;
  await selectStart(page);
  await expect(page.getByRole("button", { name: "发送以上片段并用 AI 解释" })).toBeDisabled();
  await page.getByRole("checkbox", { name: "启用本项目的按需 AI" }).check();
  expect(mock.requests.length).toBe(before);
  await page.getByText("查看将发送的源码片段", { exact: true }).click();
  await expect(page.locator(".context-snippet").first()).toContainText("function start");
  await page.getByText("查看将发送的源码片段", { exact: true }).click();
  await page.getByRole("button", { name: "发送以上片段并用 AI 解释" }).click();
  await expect(page.getByRole("region", { name: "AI 解释结果" })).toContainText("引用位置已校验");
  expect(mock.requests.length).toBe(before + 1);
  const body = mock.requests.at(-1).body;
  expect(JSON.stringify(body)).not.toContain("browser-fixture-secret");
  await page.getByRole("button", { name: "发送以上片段并用 AI 解释" }).click();
  await expect(page.locator(".ai-answer-heading").first()).toContainText("来自本机缓存");
  expect(mock.requests.length).toBe(before + 1);
  await page.getByRole("button", { name: "有误", exact: true }).click();
  await expect(page.locator(".explanation-feedback-message")).toContainText("不再复用");
  mock.state.mode = "wrong-citation";
  await page.getByRole("button", { name: "发送以上片段并用 AI 解释" }).click();
  await expect(page.locator(".explanation-fallback")).toContainText("引用未通过校验");
  await expect(page.locator(".ai-answer")).toHaveCount(0);
  await expect(page.locator(".local-facts")).toContainText("start");
  await page.screenshot({ path: path.join(artifacts, "ai-fallback-1440.png") });
});

test("cancel button aborts AI generation, leaves local facts and allows retry", async ({ page }) => {
  mock.state.mode = "valid"; mock.state.delayMs = 700;
  await page.goto(url); await expect(page.locator(".snapshot-state")).toContainText("分析完成");
  await selectStart(page);
  await page.getByRole("button", { name: "清除本项目的 AI 解释缓存", exact: true }).click();
  const before = mock.requests.length;
  await page.getByRole("checkbox", { name: "启用本项目的按需 AI" }).check();
  await page.getByRole("button", { name: "发送以上片段并用 AI 解释" }).click();
  await waitUntil(() => mock.requests.length === before + 1);
  await page.getByRole("button", { name: "取消请求", exact: true }).click();
  await expect(page.locator(".local-facts")).toContainText("start");
  await expect(page.locator(".ai-answer")).toHaveCount(0);
  mock.state.delayMs = 0;
  await page.getByRole("button", { name: "发送以上片段并用 AI 解释" }).click();
  await expect(page.locator(".ai-answer-heading").first()).toContainText("本次生成");
  await page.locator(".ai-answer").scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(artifacts, "ai-explanation-1440.png") });
  await page.getByRole("region", { name: "AI 解释结果" }).getByRole("button", { name: /打开解释引用/ }).first().click();
  await expect(page.locator(".source-line.highlighted").first()).toContainText("function start");
});

test("reading guide and local evidence remain usable at desktop, tablet and mobile widths", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.reload(); await reading(page);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, `recommendations-${width}.png`) });
    await page.getByRole("tab", { name: "推荐顺序", exact: true }).click();
    await page.screenshot({ path: path.join(artifacts, `reading-order-${width}.png`) });
    await page.locator(".reading-order").getByRole("button", { name: /start src/ }).first().click();
    await page.getByRole("tab", { name: "解释", exact: true }).click();
    await expect(page.locator(".context-review")).toBeVisible();
    await page.locator(".local-facts").scrollIntoViewIfNeeded();
    await expect(page.locator(".local-facts")).toContainText("start");
    await page.screenshot({ path: path.join(artifacts, `explanation-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});
