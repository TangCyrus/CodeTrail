import { test, expect } from "@playwright/test";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createLocalServer } from "../../apps/local/dist/server.js";

const root = path.resolve(import.meta.dirname, "../..");
const artifacts = path.join(root, "artifacts/phase-two");
const errors = [];
let server;
let url;
let temporary;
let project;
test.beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true });
  temporary = mkdtempSync(path.join(artifacts, "browser-project-"));
  project = path.join(temporary, "project");
  cpSync(path.join(root, "fixtures/reference-lab"), project, { recursive: true });
  server = await createLocalServer({ rootDir: project, dataDirectory: path.join(temporary, "cache"), ai: { apiKey: "", model: "" } });
  url = await server.listen(0);
});
test.afterAll(async () => {
  await server?.app.close();
  if (temporary) {
    const resolved = path.resolve(temporary);
    if (!resolved.startsWith(path.resolve(artifacts) + path.sep)) throw new Error("Unsafe test cleanup path");
    rmSync(resolved, { recursive: true, force: true });
  }
});
test.beforeEach(async ({ page }) => {
  errors.length = 0;
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url);
  await expect(page.getByRole("heading", { level: 1, name: "项目架构" })).toBeVisible();
  await expect(page.locator(".snapshot-state")).toContainText("分析完成");
  await expect(page.locator(".graph-card").first()).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
});
test.afterEach(() => { expect(errors).toEqual([]); });

test("architecture overview uses live counts, graph nodes, local fonts and preserved source", async ({ page }) => {
  await expect(page).toHaveTitle("CodeTrail · 本地代码工作台");
  await expect(page.locator(".brand")).toHaveText("CodeTrail");
  expect(await page.evaluate(() => sessionStorage.getItem("codetrail.session"))).toBeTruthy();
  await page.reload();
  await expect(page.locator(".project-counts")).toContainText("14");
  await expect(page.locator(".graph-card")).toHaveCount(5);
  await expect(page.locator(".source-code")).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "entry.ts", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.fonts.check('14px "IBM Plex Sans"'))).toBe(true);
  await page.screenshot({ path: path.join(artifacts, "overview-1440.png"), fullPage: true });
  const moduleNode = page.locator(".react-flow__node").filter({ has: page.getByText("domain", { exact: true }) });
  await moduleNode.focus();
  await moduleNode.press("Enter");
  await expect(page.getByRole("heading", { level: 2, name: "domain", exact: true })).toBeVisible();
});

test("search navigates to the canonical symbol, highlights source and opens relation evidence", async ({ page }) => {
  await page.getByRole("combobox", { name: "搜索文件或符号" }).fill("normalize");
  await page.getByRole("option", { name: /^normalize/ }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "normalize", exact: true })).toBeVisible();
  await expect(page.locator(".source-line.highlighted").first()).toContainText("function normalize");
  await page.getByRole("tab", { name: /^关系/ }).click();
  await expect(page.locator(".connection-section").first()).toContainText("submit");
  await page.getByRole("button", { name: /查看 submit 的调用证据/ }).click();
  await expect(page.getByText("关系证据", { exact: true })).toBeVisible();
  await page.locator(".proof-row").first().click();
  await expect(page.locator(".source-code")).toContainText("sanitize");
  await expect(page.locator(".source-line.highlighted")).toHaveCount(1);
  await expect(page.locator(".source-line.highlighted")).toContainText("sanitize");
  await page.screenshot({ path: path.join(artifacts, "source-evidence-1440.png"), fullPage: true });
});

test("module navigation, breadcrumbs, accessible list mode and empty search remain usable", async ({ page }) => {
  const tree = page.getByRole("navigation", { name: "模块与文件" });
  await tree.getByRole("button", { name: /^src\/domain/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "domain", exact: true })).toBeVisible();
  await page.getByRole("tab", { name: "列表", exact: true }).click();
  await expect(page.locator(".graph-list-row")).toHaveCount(1);
  await page.getByRole("button", { name: "展开关系", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "math.ts", exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "图谱位置" }).getByRole("button", { name: "架构概览", exact: true }).click();
  await expect(page.getByRole("heading", { level: 1, name: "项目架构" })).toBeVisible();
  await page.getByRole("combobox", { name: "搜索文件或符号" }).fill("nothing-matches-this");
  await expect(page.getByRole("listbox")).toContainText("未找到");
  await page.keyboard.press("Escape");
});

test("edited files keep old source visible until a manual refresh publishes a new snapshot", async ({ page }) => {
  const search = page.getByRole("combobox", { name: "搜索文件或符号" });
  await search.fill("normalize");
  await page.getByRole("option", { name: /^normalize/ }).first().click();
  writeFileSync(path.join(project, "src/domain/math.ts"), "export function normalize(value: number): number { return value + 99; }\n", "utf8");
  await expect(page.locator(".snapshot-state")).toContainText("快照已过期", { timeout: 15_000 });
  await expect(page.locator(".source-code")).toContainText("value < 0");
  await page.getByRole("button", { name: "刷新分析", exact: true }).click();
  await expect(page.locator(".snapshot-state")).toContainText("部分完成");
  await search.fill("normalize");
  await page.getByRole("option", { name: /^normalize/ }).first().click();
  await expect(page.locator(".source-code")).toContainText("value + 99");
  cpSync(path.join(root, "fixtures/reference-lab/src/domain/math.ts"), path.join(project, "src/domain/math.ts"));
  await page.getByRole("button", { name: "刷新分析", exact: true }).click();
  await expect(page.locator(".snapshot-state")).toContainText("分析完成");
});

test("tablet and phone fold navigation and keep source in a single-pane reading flow", async ({ page }) => {
  await page.setViewportSize({ width: 768, height: 1024 });
  await expect(page.getByRole("complementary", { name: "项目导航" })).not.toBeVisible();
  await page.screenshot({ path: path.join(artifacts, "overview-768.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("tab", { name: "列表", exact: true })).toHaveAttribute("aria-selected", "true");
  await page.screenshot({ path: path.join(artifacts, "overview-390.png"), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.getByRole("button", { name: "打开项目导航" }).click();
  await expect(page.getByRole("complementary", { name: "项目导航" })).toBeVisible();
  await page.getByRole("navigation", { name: "模块与文件" }).getByRole("button", { name: "entry.ts", exact: true }).click();
  await expect(page.getByRole("complementary", { name: "项目导航" })).not.toBeVisible();
  await expect(page.getByRole("complementary", { name: "源码与关系侧栏" })).toBeVisible();
  await expect(page.locator(".source-code")).toBeVisible();
  await expect(page.getByRole("button", { name: "关闭源码侧栏" })).toBeFocused();
  await page.screenshot({ path: path.join(artifacts, "source-390.png"), fullPage: true });
  await page.getByRole("button", { name: "关闭源码侧栏" }).click();
  await expect(page.getByRole("complementary", { name: "源码与关系侧栏" })).not.toBeVisible();
});
