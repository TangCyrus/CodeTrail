import { test, expect } from '@playwright/test';
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createLocalServer } from '../../apps/local/dist/server.js';

test('nested this calls expose provenance and detached receivers retain source-backed gaps', async ({page}) => {
  const parent=path.resolve('artifacts/receiver-aliases/browser');mkdirSync(parent,{recursive:true});
  const project=mkdtempSync(path.join(parent,'project-'));
  writeFileSync(path.join(project,'index.ts'), `const root={child:{leaf(){},run(){this.leaf()}}};
    const alias=root.child;
    const detached={leaf(){},run(){this.leaf()}};const extracted=detached.run;
    export function use(){alias.run();extracted()}`);
  const server=await createLocalServer({rootDir:project,dataDirectory:path.join(project,'cache'),ai:{apiKey:'',model:''}});
  try {
    await page.goto(await server.listen(0));
    await page.getByRole('combobox',{name:'搜索文件或符号'}).fill('root.run');
    await page.getByRole('option',{name:/^root.run/}).first().click();
    await page.getByRole('tab',{name:/^关系/}).click();
    await page.getByRole('button',{name:/查看 root.leaf 的调用证据/}).click();
    await expect(page.locator('.proof-row').first()).toContainText('this.leaf');
    await page.locator('.proof-row').first().click();
    await expect(page.locator('.source-code')).toContainText('this.leaf()');
    await page.getByRole('combobox',{name:'搜索文件或符号'}).fill('detached.run');
    await page.getByRole('option',{name:/^detached.run/}).first().click();
    await page.getByRole('tab',{name:/^关系/}).click();
    await expect(page.locator('.dispatch-gap')).toHaveCount(1);
    await expect(page.locator('.dispatch-gap')).toContainText('提取');
    await page.setViewportSize({width:390,height:844});
    await page.getByRole('button',{name:'查看缺口依据 1',exact:true}).click();
    await expect(page.locator('.source-line.highlighted')).toContainText('detached.run');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
    await page.screenshot({path:path.join(parent,'this-provenance-390.png'),fullPage:true,animations:'disabled'});
  }finally{
    await server.app.close();
    if(!project.startsWith(parent+path.sep))throw Error('Unexpected cleanup path');
    rmSync(project,{recursive:true,force:true});
  }
});

test('external references, gaps and factory value proofs stay separately readable at three widths', async ({page}) => {
  const parent = path.resolve('artifacts/core-relations/browser'); mkdirSync(parent, {recursive:true});
  const project = mkdtempSync(path.join(parent, 'project-'));
  writeFileSync(path.join(project,'index.ts'), `function system(){return {link}; function link(){return 1}}
    const {link} = system();
    export function run(fn: () => void){link(); fn(); JSON.stringify(1); missing()}`);
  const server = await createLocalServer({rootDir:project, dataDirectory:path.join(project,'cache'), ai:{apiKey:'',model:''}});
  try {
    await page.goto(await server.listen(0));
    await expect(page.locator('.snapshot-state')).toContainText('部分完成');
    await page.getByRole('combobox',{name:'搜索文件或符号'}).fill('run');
    await page.getByRole('option',{name:/^run/}).first().click();
    await page.getByRole('tab',{name:/^关系/}).click();
    for (const [width,height] of [[1440,900],[768,1024],[390,844]]) {
      await page.setViewportSize({width,height});
      await expect(page.locator('.relations-body').getByRole('heading',{name:/解析缺口/})).toBeVisible();
      const external = page.locator('.connection-section').filter({has:page.getByRole('heading',{name:/外部引用/})});
      await expect(external).toContainText('JSON');
      await external.getByRole('heading').scrollIntoViewIfNeeded();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.screenshot({path:path.join(parent,`resolution-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await page.locator('.connection-section').filter({has:page.getByRole('heading',{name:/外部引用/})}).getByRole('button').first().click();
    await expect(page.locator('.source-code')).toContainText('JSON.stringify');
    await page.setViewportSize({width:1440,height:900});
    await page.getByRole('combobox',{name:'搜索文件或符号'}).fill('run');
    await page.getByRole('option',{name:/^run/}).first().click();
    await page.getByRole('tab',{name:/^关系/}).click();
    await page.getByRole('button',{name:/查看 system.link 的调用证据/}).click();
    await page.setViewportSize({width:390,height:844});
    await expect(page.locator('.proof-heading')).toContainText('4 处来源依据');
    await expect(page.locator('.proof-row')).toHaveCount(5);
    await page.screenshot({path:path.join(parent,'factory-proofs-390.png'),fullPage:true,animations:'disabled'});
  } finally {
    await server.app.close();
    if (!project.startsWith(parent+path.sep)) throw Error('Unexpected cleanup path');
    rmSync(project,{recursive:true,force:true});
  }
});

test('interface dispatch gaps explain writes and parameters and open the exact rejection source', async ({page}) => {
  const parent=path.resolve('artifacts/object-dispatch/browser');mkdirSync(parent,{recursive:true});
  const project=mkdtempSync(path.join(parent,'project-'));
  writeFileSync(path.join(project,'index.ts'), `interface API{run():void}
    const stable:API={run(){}};const changed:API={run(){}};changed.run=()=>{};
    export function run(receiver:API){stable.run();changed.run();receiver.run()}`);
  const server=await createLocalServer({rootDir:project,dataDirectory:path.join(project,'cache'),ai:{apiKey:'',model:''}});
  try {
    await page.goto(await server.listen(0));
    await expect(page.locator('.snapshot-state')).toContainText('分析完成');
    await page.getByRole('combobox',{name:'搜索文件或符号'}).fill('run');
    await page.getByRole('option',{name:/^run/}).first().click();
    await page.getByRole('tab',{name:/^关系/}).click();
    await expect(page.locator('.dispatch-gap')).toHaveCount(2);
    await expect(page.locator('.relations-body')).toContainText('接口签名不能确定实际对象');
    await expect(page.locator('.relations-body')).toContainText('目标成员或其父路径');
    for(const [width,height] of [[1440,900],[768,1024],[390,844]]){
      await page.setViewportSize({width,height});
      await page.locator('.dispatch-gap').last().scrollIntoViewIfNeeded();
      expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
      await page.screenshot({path:path.join(parent,`gap-reasons-${width}.png`),fullPage:true,animations:'disabled'});
    }
    await page.getByRole('button',{name:'查看缺口依据 1',exact:true}).first().click();
    await expect(page.locator('.source-line.highlighted')).toContainText('changed.run');
  }finally{
    await server.app.close();
    if(!project.startsWith(parent+path.sep))throw Error('Unexpected cleanup path');
    rmSync(project,{recursive:true,force:true});
  }
});
