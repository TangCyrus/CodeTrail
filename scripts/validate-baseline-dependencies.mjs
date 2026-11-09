import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {SnapshotStore} from '../apps/local/dist/store.js';
import {root} from './acceptance-projects.mjs';

// Self-acceptance only: a byte-restored comment probe, no target execution or Git writes.
const parent=path.join(root,'artifacts/head-dependencies');mkdirSync(parent,{recursive:true});
const run=mkdtempSync(path.join(parent,'self-')),cache=mkdtempSync(path.join(os.tmpdir(),'codetrail-head-deps-'));
const targetFile=path.join(root,'packages/graph/src/comparison.ts'),original=readFileSync(targetFile);
const marker=' // CodeTrail HEAD dependency acceptance; no runtime change.',needle='  let inspectedEdges = 0;';
assert.ok(original.toString('utf8').includes(needle));assert.ok(!original.toString('utf8').includes(marker));
const probe=Buffer.from(original.toString('utf8').replace(needle,needle+marker));
const sha=value=>createHash('sha256').update(value).digest('hex');
const client=new Client({name:'codetrail-head-dependency-acceptance',version:'0.11.0'}),calls=[];let result;
async function call(name,args){const started=performance.now(),r=await client.callTool({name,arguments:args},{timeout:90000});assert.notEqual(r.isError,true,JSON.stringify(r));assert.ok(r.content[0].text.length<=48000);const data={...r.structuredContent};delete data.workbenchUrl;calls.push({name,args,elapsedMs:Math.round(performance.now()-started),data});return data}
try{
 await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'apps/local/dist/cli.js'),'mcp',root,'--data-dir',cache],stderr:'pipe'}));
 const overview=await call('project_overview',{refresh:true});assert.equal(overview.project.rootDir,root);assert.equal(overview.status,'complete');assert.equal(overview.stale,false);
 writeFileSync(targetFile,probe);
 const comparison=await call('compare_worktree',{refresh:true,limit:1});assert.equal(comparison.stale,false);
 assert.equal(comparison.status.base,'complete');assert.equal(comparison.status.current,'complete');assert.equal(comparison.baselineDependencies.state,'available');
 const routes=[];
 for(const side of ['base','current']){
  const search=await call('compare_worktree',{comparisonId:comparison.comparisonId,symbolQuery:'calculateComparisonImpact',symbolSide:side,limit:3});
  const symbol=search.symbols.find(x=>x.node.name==='calculateComparisonImpact'&&x.node.path==='packages/graph/src/comparison.ts');assert.ok(symbol);
  const focus={side,nodeId:symbol.node.id},paths=[];let offset=0;
  do{const page=await call('compare_worktree',{comparisonId:comparison.comparisonId,focus,pathOffset:offset,limit:3});assert.deepEqual(page.snapshotIds,comparison.snapshotIds);assert.equal(page.stale,false);assert.ok(page.paths.every(p=>p.side===side&&p.seed.id===symbol.node.id));paths.push(...page.paths);offset=page.nextPathOffset}while(offset!==null);
  const route=paths.find(p=>p.distance===2&&p.target.path==='apps/local/src/mcp.ts'&&p.steps.every(s=>s.kind==='CALLS')&&p.steps.some(s=>s.from.name==='ComparisonManager.report'));assert.ok(route,`${side}: missing cross-package two-hop caller`);
  for(const step of route.steps){const proof=await call('read_evidence',{comparisonId:comparison.comparisonId,side,evidenceId:step.evidenceId,maxLines:8});assert.equal(proof.snapshotId,comparison.snapshotIds[side]);assert.ok(proof.evidence.some(p=>p.id===step.evidenceId&&p.fileHash===proof.fileHash))}
  const source=await call('read_evidence',{comparisonId:comparison.comparisonId,side,nodeId:symbol.node.id,line:132,maxLines:14});assert.equal(source.snapshotId,comparison.snapshotIds[side]);assert.equal(source.lines.some(l=>l.text.includes('HEAD dependency acceptance')),side==='current');
  routes.push({side,paths:paths.length,route});
 }
 const store=new SnapshotStore(cache,root);let sides;
 try{const bundle=store.comparison(comparison.comparisonId);assert.ok(bundle);
  sides=Object.fromEntries(['base','current'].map(side=>{const {snapshot,sources}=bundle[side],byPath=new Map(sources.map(s=>[s.path,s])),files=new Map(snapshot.files.map(f=>[f.id,f]));
   for(const file of snapshot.files)assert.equal(sha(byPath.get(file.path).content),file.hash);
   for(const proof of snapshot.evidence){const file=files.get(proof.fileId),source=byPath.get(file.path);assert.equal(proof.fileHash,file.hash);assert.equal(source.content.slice(proof.range.startOffset,proof.range.endOffset),proof.excerpt)}
   assert.ok(!snapshot.files.some(f=>f.path.includes('node_modules/')));assert.equal(snapshot.diagnostics.length,0);
   writeFileSync(path.join(run,`${side}-snapshot.json`),JSON.stringify(snapshot));
   if(side==='base')writeFileSync(path.join(run,'base-sources.json'),JSON.stringify(sources));
   return [side,{status:snapshot.status,statistics:snapshot.statistics,diagnostics:snapshot.diagnostics.length,evidenceChecked:snapshot.evidence.length}];}));
 }finally{store.close()}
 result={passed:true,run,cache,snapshotIds:comparison.snapshotIds,comparisonId:comparison.comparisonId,baselineDependencies:comparison.baselineDependencies,sides,routes,toolCalls:calls.length};
}catch(error){result={passed:false,run,error:error.message};process.exitCode=1}
finally{
 const live=sha(readFileSync(targetFile));
 if(live===sha(probe)||live===sha(original)){writeFileSync(targetFile,original);assert.equal(sha(readFileSync(targetFile)),sha(original));result.sourceRestored=true}
 else{result.sourceRestored=false;result.passed=false;result.error='Source changed concurrently; preserved the live file instead of overwriting it.';process.exitCode=1}
 await client.close();
 writeFileSync(path.join(run,'tool-calls.json'),JSON.stringify(calls));writeFileSync(path.join(run,'result.json'),JSON.stringify(result,null,2));writeFileSync(path.join(parent,'self-latest.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}
