import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { createLocalServer } from "../../apps/local/dist/server.js";
import { createGitFixture } from "../git-fixture.mjs";

const root = path.resolve(import.meta.dirname, "../.."), artifacts = path.join(root, "artifacts/phase-four");
let server, unborn, temporary, url, unbornUrl, fixture;
const errors = [];
test.beforeAll(async () => {
  mkdirSync(artifacts, { recursive: true }); temporary = mkdtempSync(path.join(artifacts, "browser-"));
  fixture = createGitFixture(path.join(temporary, "project")); fixture.change();
  const uncommitted = createGitFixture(path.join(temporary, "unborn"), false);
  server = await createLocalServer({ rootDir: fixture.root, dataDirectory: path.join(temporary, "cache"), ai: { apiKey: "", model: "" } });
  unborn = await createLocalServer({ rootDir: uncommitted.root, dataDirectory: path.join(temporary, "cache"), ai: { apiKey: "", model: "" } });
  url = await server.listen(0); unbornUrl = await unborn.listen(0);
});
test.afterAll(async () => {
  await server?.app.close(); await unborn?.app.close();
  if (temporary) { const target = path.resolve(temporary); if (!target.startsWith(path.resolve(artifacts) + path.sep)) throw Error("Unsafe cleanup"); rmSync(target, { recursive: true, force: true }); }
});
async function enter(page) {
  if (await page.getByRole("button", { name: "打开项目导航" }).isVisible()) await page.getByRole("button", { name: "打开项目导航" }).click();
  await page.getByRole("button", { name: "改动影响", exact: true }).first().click();
  await expect(page.getByRole("heading", { level: 1, name: "改动影响" })).toBeVisible();
  await expect(page.locator(".compare-button")).toBeEnabled();
}
async function compare(page) {
  await page.locator(".compare-button").click();
  await expect(page.locator(".comparison-progress")).toBeVisible();
  await expect(page.locator(".comparison-progress")).toHaveCount(0, { timeout: 20_000 });
  await expect(page.locator(".file-change").first()).toBeVisible();
}
test.beforeEach(async ({ page }) => {
  errors.length = 0; page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(url); await expect(page.locator(".snapshot-state")).toBeVisible(); await enter(page);
  if (!await page.locator(".file-change").count()) await compare(page);
});
test.afterEach(() => expect(errors).toEqual([]));

test("HEAD comparison lists staged, unstaged, untracked, deleted and rename candidates; old/new source keeps exact version", async ({ page }) => {
  await compare(page);
  await expect(page.locator(".file-change").filter({ hasText: "新增 helper.ts" })).toContainText("未跟踪");
  await expect(page.locator(".file-change").filter({ hasText: "src/renamed.ts" })).toContainText("重命名候选");
  const deleted = page.locator(".file-change").filter({ hasText: "src/obsolete.ts" });
  await expect(deleted).toContainText("删除");
  await deleted.getByRole("button", { name: "旧版源码", exact: true }).click();
  await expect(page.locator(".comparison-version-heading")).toContainText("旧版 · HEAD");
  await expect(page.locator(".source-code")).toContainText("function removed");
  const math = page.locator(".file-change").filter({ hasText: "src/math.ts" });
  await math.locator("summary").click(); await expect(math).toContainText("签名变化");
  await math.getByRole("button", { name: /^新版 1/ }).click();
  await expect(page.locator(".comparison-version-heading")).toContainText("新版 · 工作区");
  await expect(page.locator(".source-line.highlighted")).toContainText("floor = 2");
  await page.screenshot({ path: path.join(artifacts, "changes-1440.png") });
  await page.getByRole("button", { name: /^分析范围与诊断/ }).click();
  await expect(page.getByRole("heading", { name: "解析范围与诊断", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "项目架构", level: 1 })).toBeVisible();
});

test("old deletion paths, two-hop callers, static tests and opt-in types are navigable and cited", async ({ page }) => {
  await page.getByRole("tab", { name: "关联路径", exact: true }).click();
  const removed = page.locator(".impact-path").filter({ has: page.getByRole("button", { name: "查看 旧版 legacy 到 removed 的调用证据", exact: true }) });
  await expect(removed).toBeVisible();
  await removed.getByRole("button", { name: /查看 旧版 legacy 到 removed/ }).click();
  await expect(page.locator(".source-line.highlighted")).toContainText("removed()");
  await expect(page.locator(".comparison-version-heading")).toContainText("旧版 · HEAD");
  await expect(page.locator(".impact-path").filter({ hasText: "main" }).first()).toContainText("两跳关联");
  await page.getByRole("tab", { name: "相关测试", exact: true }).click();
  await expect(page.locator(".impact-path").first()).toContainText("tests/service.test.ts");
  await expect(page.locator(".impact-reading-note").first()).toContainText("不表示测试覆盖");
  await page.getByRole("tab", { name: "关联路径", exact: true }).click();
  await page.getByLabel("改动起点", { exact: true }).selectOption({ label: "src/types.ts" });
  await expect(page.locator(".impact-path")).toHaveCount(0);
  await page.getByRole("checkbox", { name: "包含纯类型依赖" }).check();
  await expect(page.locator(".impact-path").first()).toContainText("纯类型依赖");
  await page.screenshot({ path: path.join(artifacts, "type-impact-1440.png") });
});

test("changed input becomes stale while old source remains readable; cancelling retains the previous comparison", async ({ page }) => {
  fixture.write("src/math.ts", "export function normalize(value: number): number { return value + 99; }\n");
  await expect(page.locator(".impact-page > .comparison-notice.is-stale")).toContainText("重新比较", { timeout: 15_000 });
  await expect(page.locator(".comparison-source-body .comparison-notice.is-stale")).toContainText("保留比较时的源码");
  const math = page.locator(".file-change").filter({ hasText: "src/math.ts" });
  await math.getByRole("button", { name: "新版源码", exact: true }).click();
  await expect(page.locator(".source-code")).toContainText("floor = 2");
  await expect(page.locator(".comparison-source-body")).toContainText("工作区文件已变化");
  await page.locator(".compare-button").click(); await page.getByRole("button", { name: "取消比较", exact: true }).click();
  await expect(page.getByText("比较已取消，可重新比较。已有结果和证据仍可阅读。", { exact: true })).toBeVisible();
  await expect(math).toBeVisible();
  await compare(page); await math.getByRole("button", { name: "新版源码", exact: true }).click();
  await expect(page.locator(".source-code")).toContainText("value + 99");
  fixture.write("src/math.ts", "export function normalize(value: number, floor = 2): number { return value < floor ? floor : value; }\n");
  await compare(page);
});

test("change lists, relationship paths and deleted source remain readable at three widths", async ({ page }) => {
  for (const [width, height] of [[1440, 900], [768, 1024], [390, 844]]) {
    await page.setViewportSize({ width, height }); await page.reload(); await enter(page);
    await expect(page.locator(".file-change").first()).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: path.join(artifacts, `overview-${width}.png`) });
    await page.getByRole("tab", { name: "关联路径", exact: true }).click();
    await expect(page.locator(".impact-path").first()).toBeVisible();
    await page.screenshot({ path: path.join(artifacts, `paths-${width}.png`) });
    await page.getByRole("button", { name: "查看 旧版 legacy 到 removed 的调用证据", exact: true }).click();
    await expect(page.locator(".source-line.highlighted")).toContainText("removed()");
    await expect(page.locator(".comparison-version-heading")).toContainText("旧版 · HEAD");
    await page.screenshot({ path: path.join(artifacts, `source-${width}.png`) });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
});

test("repository without commits lists current additions and explains the missing historical baseline", async ({ page }) => {
  await page.goto(unbornUrl); await expect(page.locator(".snapshot-state")).toBeVisible(); await enter(page);
  await expect(page.locator(".impact-baseline")).toContainText("尚无 HEAD");
  await compare(page);
  await expect(page.locator(".comparison-summary")).toContainText("0 条关联路径");
  await expect(page.locator(".comparison-notice").first()).toContainText("HEAD");
  await page.getByRole("tab", { name: "关联路径", exact: true }).click();
  await expect(page.locator(".impact-empty")).toContainText("没有已解析的关联路径");
});
