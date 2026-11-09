import {test,expect} from '@playwright/test';
import {mkdirSync,mkdtempSync,rmSync} from 'node:fs';
import path from 'node:path';
import {createLocalServer} from '../../apps/local/dist/server.js';
import {createGitFixture,gitCommand} from '../git-fixture.mjs';

test('focus narrows a capped overview, keeps version and limit warnings, and opens same-side evidence at three widths',async({page})=>{
 const parent=path.resolve('artifacts/impact-focus/browser');mkdirSync(parent,{recursive:true});
 const temporary=mkdtempSync(path.join(parent,'project-'));const fixture=createGitFixture(temporary);
 const text=`function hot(){return 1}\n${Array.from({length:130},(_,i)=>`function caller${i}(){hot()}`).join('\n')}
 function hidden(){return 1} function middle(){hidden()} function outer(){middle()}`;
 fixture.write('index.ts',text);gitCommand(temporary,['add','--all']);gitCommand(temporary,['commit','--quiet','-m','Focus baseline']);
 fixture.write('index.ts',text.replace('hot(){return 1}','hot(){return 2}'));
 const server=await createLocalServer({rootDir:temporary,dataDirectory:path.join(temporary,'cache'),ai:{apiKey:'',model:''}});
 try{
  await page.goto(await server.listen(0));await expect(page.locator('.snapshot-state')).toBeVisible();
  await page.getByRole('button',{name:'改动影响',exact:true}).click();await page.locator('.compare-button').click();
  await expect(page.locator('.file-change').first()).toBeVisible({timeout:20000});
  await page.getByRole('tab',{name:'关联路径',exact:true}).click();
  await expect(page.locator('.impact-truncation')).toContainText('100 条路径');
  await expect(page.locator('.impact-path-start').filter({hasText:'hidden'})).toHaveCount(0);
  await expect(page.locator('.comparison-notice.is-stale')).toHaveCount(0);
  await page.getByRole('textbox',{name:'搜索比较内符号'}).fill('hidden');
  await page.locator('.impact-symbol-results button').filter({hasText:'hidden'}).first().click();
  await expect(page.locator('.impact-focus-status')).toContainText('工作区新版 · hidden');
  await expect(page.locator('.impact-path')).toHaveCount(2);
  await expect(page.locator('.impact-content')).toContainText('整体概览已截断');
  for(const [width,height] of [[1440,900],[768,1024],[390,844]]){
   await page.setViewportSize({width,height});
   await page.locator('.impact-symbol-focus').scrollIntoViewIfNeeded();
   expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
   await page.screenshot({path:path.join(parent,`focused-${width}.png`),fullPage:true,animations:'disabled'});
  }
  await page.setViewportSize({width:1440,height:900});
  await page.getByRole('combobox',{name:'聚焦版本'}).selectOption('base');
  await expect(page.locator('.impact-symbol-results button').first()).toContainText('旧版');
  await page.locator('.impact-symbol-results button').first().click();
  await expect(page.locator('.impact-focus-status')).toContainText('HEAD 旧版 · hidden');
  await page.getByRole('button',{name:/查看 旧版 middle 到 hidden 的调用证据/}).first().click();
  await expect(page.locator('.comparison-version-heading')).toContainText('旧版');
  await expect(page.locator('.source-line.highlighted')).toContainText('middle');
  await page.getByRole('button',{name:'返回概览路径'}).click();
  await expect(page.locator('.impact-focus-status')).toHaveCount(0);
  await page.getByRole('textbox',{name:'搜索比较内符号'}).fill('hot');
  await page.locator('.impact-symbol-results button').filter({hasText:'hot'}).first().click();
  await expect(page.locator('.impact-truncation')).toContainText('本次符号查询存在截断');
 }finally{
  await server.app.close();if(!temporary.startsWith(parent+path.sep))throw Error('Unexpected cleanup');rmSync(temporary,{recursive:true,force:true});
 }
});
