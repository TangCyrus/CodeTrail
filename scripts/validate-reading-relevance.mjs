import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import ts from 'typescript';
import {Client} from '@modelcontextprotocol/client';
import {StdioClientTransport} from '@modelcontextprotocol/client/stdio';
import {SnapshotStore} from '../apps/local/dist/store.js';
import {root} from './acceptance-projects.mjs';

// Compare only our own pinned previous recommendation algorithm, never execute target code.
const parent=path.join(root,'artifacts/reading-relevance');mkdirSync(parent,{recursive:true});
const run=mkdtempSync(path.join(parent,'acceptance-'));
const oldRevision='583354f508611534f61b0d44b7106e7a6b85e78c';
const oldSource=execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','show',`${oldRevision}:packages/graph/src/reading.ts`],{cwd:root,encoding:'utf8',windowsHide:true});
const oldModule=path.join(run,'previous-reading.mjs');
const rewritten=oldSource.replace('"./explorer.js"',JSON.stringify(pathToFileURL(path.join(root,'packages/graph/dist/explorer.js')).href));
assert.notEqual(rewritten,oldSource);
writeFileSync(oldModule,ts.transpileModule(rewritten,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText);
const previous=await import(pathToFileURL(oldModule).href);
assert.equal(previous.READING_ALGORITHM_VERSION,'structural-reading-2');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const cases=[
  {id:'self',project:root,anchors:[['createMcpRuntime','apps/local/src/mcp.ts'],['analyzeProject','packages/analyzer/src/index.ts'],['compareSnapshots','packages/graph/src/comparison.ts']]},
  {id:'tanstack',project:path.join(root,'artifacts/external-monorepo/tanstack-store'),anchors:[['createAtom','packages/store/src/atom.ts'],['useCreateAtom','packages/react-store/src/useCreateAtom.ts'],['shallow','packages/store/src/shallow.ts']]},
];
const results=[];
for(const scenario of cases){
 const cache=path.join(run,scenario.id),client=new Client({name:'codetrail-task-reading-acceptance',version:'0.11.0'}),calls=[];
 const result={project:scenario.id,passed:false,modelCalls:0};
 async function call(name,args){const start=performance.now(),response=await client.callTool({name,arguments:args},{timeout:90000});calls.push({name,args,elapsedMs:Math.round(performance.now()-start),response});writeFileSync(path.join(run,scenario.id+'-calls.json'),JSON.stringify(calls,null,2));assert.notEqual(response.isError,true,JSON.stringify(response));assert.ok(response.content[0].text.length<=48000);assert.equal(response.structuredContent.sourceTrust,'untrusted-repository-data');return response.structuredContent;}
 try{
  result.head=execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',scenario.project,'rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim();
  if(scenario.id==='tanstack'){
   assert.equal(result.head,'53f30be1e43c8d7899ace08023705b34f5e533f8');
   assert.equal(execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',scenario.project,'status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim(),'');
  }
  await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(root,'apps/local/dist/cli.js'),'mcp',scenario.project,'--data-dir',cache],stderr:'pipe'}));
  result.server=client.getServerVersion();assert.equal(result.server.version,'0.11.0');
  const overview=await call('project_overview',{refresh:true}),pin={snapshotId:overview.snapshotId};
  assert.equal(overview.project.rootDir,scenario.project);assert.equal(overview.stale,false);assert.equal(overview.statistics.parseErrors,0);
  if(scenario.id==='self')assert.equal(overview.status,'complete');
  const general=await call('recommend_reading',pin),anchors=[];
  assert.equal(general.scope.mode,'project');assert.equal(general.algorithmVersion,'task-reading-3');assert.ok(general.scope.deferredExampleFiles>0);
  assert.ok(general.readingOrder.every(step=>!/(?:^|\/)examples?\//.test(step.node.path)));
  for(const [name,file]of scenario.anchors){const search=await call('search_symbols',{...pin,query:name,limit:20});const node=search.results.find(item=>item.name===name&&item.path===file);assert.ok(node,`${file}#${name}`);anchors.push(node)}
  if(scenario.id==='self')for(const node of anchors)assert.ok(general.readingOrder.some(step=>step.node.id===node.id),`Default route must include ${node.name}`);
  else assert.ok(general.readingOrder.slice(0,3).some(step=>step.node.id===anchors[0].id));
  const focused=await call('recommend_reading',{...pin,focusNodeIds:anchors.map(node=>node.id)});
  assert.equal(focused.scope.mode,'focused');assert.deepEqual(focused.readingOrder.slice(0,3).map(step=>step.node.id),anchors.map(node=>node.id));
  if(scenario.id==='self'){
   assert.ok(focused.readingOrder.some(step=>step.node.name==='TypeScriptAnalyzer.analyze'&&step.kind==='follow'&&step.fromNodeId===anchors[1].id));
   assert.ok(focused.readingOrder.some(step=>step.node.name==='calculateComparisonImpact'&&step.kind==='follow'&&step.fromNodeId===anchors[2].id));
  }
  const store=new SnapshotStore(cache,scenario.project);
  let snapshot,sources,old;
  try{
   snapshot=store.get(pin.snapshotId);assert.ok(snapshot);sources=new Map(snapshot.files.map(file=>[file.path,store.source(snapshot.id,file.id)]));
   old=previous.recommendReading(snapshot);
   for(const guide of [general,focused]){
    assert.equal(guide.snapshotId,pin.snapshotId);assert.equal(guide.stale,false);assert.ok(guide.readingOrder.length<=10);
    const seen=new Set(),distance=new Map(anchors.map(node=>[node.id,0]));
    for(const step of guide.readingOrder){
     if(step.kind==='follow'){const edge=snapshot.relations.find(edge=>edge.id===step.viaRelationId);assert.ok(edge);assert.equal(edge.origin,'static');assert.ok(['CALLS','RENDERS'].includes(edge.kind));assert.equal(edge.from,step.fromNodeId);assert.equal(edge.to,step.node.id);assert.ok(seen.has(step.fromNodeId));if(guide===focused)distance.set(step.node.id,(distance.get(step.fromNodeId)??99)+1)}
     seen.add(step.node.id);
     if(guide===focused&&step.kind==='follow')assert.ok(distance.get(step.node.id)<=2);
     const proof=await call('read_evidence',{...pin,nodeId:step.node.id,maxLines:8});assert.equal(proof.snapshotId,pin.snapshotId);assert.equal(proof.matchesCurrentFile,true);assert.equal(proof.fileHash,sha(sources.get(step.node.path)));
    }
    for(const item of guide.groups.flatMap(group=>group.items))for(const reason of item.reasons)for(const id of reason.evidenceIds){const proof=snapshot.evidence.find(proof=>proof.id===id);assert.ok(proof);const file=snapshot.files.find(file=>file.id===proof.fileId);assert.equal(proof.fileHash,file.hash);assert.equal(proof.excerpt,sources.get(file.path).slice(proof.range.startOffset,proof.range.endOffset))}
   }
  }finally{store.close()}
  const concise=guide=>guide.readingOrder.map(step=>({name:step.node.name,path:step.node.path,kind:step.kind}));
  const oldExamples=old.readingOrder.filter(step=>/(?:^|\/)examples?\//.test(step.node.path)).length;
  if(scenario.id==='self')assert.ok(oldExamples>0,'Pinned previous algorithm must reproduce example interference');
  result.overview={snapshotId:pin.snapshotId,status:overview.status,statistics:overview.statistics,diagnostics:overview.totals.diagnostics,resolutionSummary:overview.resolutionSummary};
  result.sameSnapshotComparison={snapshotId:pin.snapshotId,previousRevision:oldRevision,previousSourceHash:sha(oldSource),previous:concise(old),current:concise(general),oldExamples,newExamples:0};
  result.focused={scope:focused.scope,readingOrder:concise(focused),roots:anchors.map(node=>({id:node.id,name:node.name,path:node.path}))};
  if(scenario.id==='self'){
   const comparison=await call('compare_worktree',{refresh:true,limit:1});assert.equal(comparison.stale,false);assert.equal(comparison.baseline.state,'ready');
   const paths=[];
   const readingSourceChanged=execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','diff','--name-only','HEAD','--','packages/graph/src/reading.ts'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()!=='';
   for(const side of readingSourceChanged?['base','current']:[]){
    const found=await call('compare_worktree',{comparisonId:comparison.comparisonId,symbolQuery:'recommendReading',symbolSide:side,limit:3});
    const node=found.symbols.find(item=>item.node.name==='recommendReading'&&item.node.path==='packages/graph/src/reading.ts');assert.ok(node);
    const selected=await call('compare_worktree',{comparisonId:comparison.comparisonId,focus:{side,nodeId:node.node.id},limit:3});
    assert.equal(selected.stale,false);assert.ok(selected.paths.every(route=>route.side===side));
    const route=selected.paths.find(route=>route.distance===1&&route.target.path.startsWith('apps/local/src/')&&route.steps.some(step=>step.kind==='CALLS'));assert.ok(route);
    const step=route.steps.find(step=>step.kind==='CALLS'),proof=await call('read_evidence',{comparisonId:comparison.comparisonId,side,evidenceId:step.evidenceId,maxLines:8});
    assert.equal(proof.snapshotId,comparison.snapshotIds[side]);assert.equal(proof.side,side);
    paths.push({side,from:route.target.path,snapshotId:proof.snapshotId,fileHash:proof.fileHash,evidenceId:step.evidenceId,analysisTruncated:selected.analysisTruncated,truncation:selected.truncation});
   }
   result.impact={comparisonId:comparison.comparisonId,snapshotIds:comparison.snapshotIds,status:comparison.status,baselineDependencies:comparison.baselineDependencies,changes:comparison.totals.changes,paths,
     readingSourceChanged,note:'Actual working source against HEAD. Reading-function side paths are checked when that file changed; a clean checkout legitimately has zero changes.'};
  }
  if(scenario.id==='tanstack')assert.equal(execFileSync('git',['--no-optional-locks','-c','core.fsmonitor=false','-C',scenario.project,'status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim(),'');
  result.passed=true;
 }catch(error){result.error=error.message}
 finally{await client.close();result.toolCalls=calls.length;result.maxResultCharacters=Math.max(0,...calls.map(call=>call.response.content[0].text.length));result.timings=calls.map(call=>({tool:call.name,elapsedMs:call.elapsedMs}));writeFileSync(path.join(run,scenario.id+'-result.json'),JSON.stringify(result,null,2));results.push(result)}
}
const result={generatedAt:new Date().toISOString(),run,passed:results.every(result=>result.passed),kind:'scripted-engineering-acceptance',modelCalls:0,results};
writeFileSync(path.join(run,'result.json'),JSON.stringify(result,null,2));writeFileSync(path.join(parent,'latest.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({run,passed:result.passed,results:results.map(result=>({project:result.project,passed:result.passed,error:result.error,calls:result.toolCalls,max:result.maxResultCharacters}))},null,2));
if(!result.passed)process.exitCode=1;
