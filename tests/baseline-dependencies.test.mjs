import assert from 'node:assert/strict';
import test from 'node:test';
import {readFileSync,existsSync,symlinkSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {tempProject,findSymbol} from './helpers.mjs';
import {gitCommand} from './git-fixture.mjs';
import {SnapshotStore} from '../apps/local/dist/store.js';
import {ComparisonManager} from '../apps/local/dist/comparison-manager.js';
import {prepareBaselineDependencies,baselineDependencyInputsStale} from '../apps/local/dist/baseline-dependencies.js';
import {analyzeProject} from '../packages/analyzer/dist/index.js';

const sha=x=>createHash('sha256').update(x).digest('hex');
const json=JSON.stringify;
const packageFiles={
 'node_modules/decl/package.json':json({name:'decl',version:'1.0.0',types:'index.d.ts',main:'runtime.js'}),
 'node_modules/decl/index.d.ts':'export interface Value { value: number }\nexport declare function size(value:Value):number;',
 'node_modules/decl/runtime.js':'throw new Error("MUST NOT EXECUTE OR COPY")',
};
const lock=(version='1.0.0',integrity='sha512-test-identity')=>json({lockfileVersion:3,packages:{'':{},'node_modules/decl':{version,integrity,resolved:'https://example.invalid/decl.tgz'}}});
function setup(t,override={}){
 const project=tempProject(t,{'package.json':json({name:'sample',dependencies:{decl:'1.0.0'}}),'package-lock.json':lock(),'tsconfig.json':json({compilerOptions:{strict:true,module:'NodeNext',moduleResolution:'NodeNext'}}),
 'index.ts':"import {size,type Value} from 'decl'; function target(x:Value){return size(x)};export function caller(x:Value){return target(x)}",...packageFiles,...override});
 const destination=tempProject(t,{'package-lock.json':lock()}),snapshot=project.analyze();
 return {project,destination,snapshot};
}

test('matched npm declarations are captured byte-for-byte, never implementations, and reproduce source relations',t=>{
 const {project,destination,snapshot}=setup(t);
 const result=prepareBaselineDependencies(project.root,destination.root,snapshot);
 assert.equal(result.summary.state,'available');assert.equal(result.summary.copiedPackages,1);
 assert.equal(readFileSync(path.join(destination.root,'node_modules/decl/index.d.ts'),'utf8'),packageFiles['node_modules/decl/index.d.ts']);
 assert.equal(existsSync(path.join(destination.root,'node_modules/decl/runtime.js')),false);
 assert.equal(baselineDependencyInputsStale(project.root,result.inputs,result.missingInputs),false);
 destination.write('index.ts',readFileSync(path.join(project.root,'index.ts'),'utf8'));
 destination.write('tsconfig.json',readFileSync(path.join(project.root,'tsconfig.json'),'utf8'));
 const base=destination.analyze();assert.equal(base.status,'complete');assert.equal(base.files.length,1);
 assert.ok(!base.symbols.some(s=>s.qualifiedName==='size'));
 project.write('package-lock.json',lock('2.0.0'));assert.equal(baselineDependencyInputsStale(project.root,result.inputs,result.missingInputs),true);
});

test('changed locks, installed versions, captured bytes, missing locks and budgets never silently borrow declarations',t=>{
 const cases=[
  ['lock',x=>x.project.write('package-lock.json',lock('2.0.0'))],
  ['integrity',x=>x.project.write('package-lock.json',lock('1.0.0','sha512-other'))],
  ['version',x=>x.project.write('node_modules/decl/package.json',json({name:'decl',version:'2.0.0',types:'index.d.ts'}))],
  ['bytes',x=>x.project.write('node_modules/decl/index.d.ts','export declare const injected:unknown')],
 ];
 for(const [name,mutate] of cases){const x=setup(t);mutate(x);const r=prepareBaselineDependencies(x.project.root,x.destination.root,x.snapshot);assert.equal(r.summary.state,'unavailable',name);assert.ok(r.summary.reasons.length,name);assert.equal(existsSync(path.join(x.destination.root,'node_modules/decl/index.d.ts')),false,name)}
 const x=setup(t),empty=tempProject(t);const missing=prepareBaselineDependencies(x.project.root,empty.root,x.snapshot);assert.equal(missing.summary.state,'unavailable');
 const limited=prepareBaselineDependencies(x.project.root,x.destination.root,x.snapshot,{maxFiles:1,maxBytes:32,maxFileBytes:1024*1024});
 assert.equal(limited.summary.state,'unavailable');assert.ok(limited.summary.reasons.some(x=>x.code==='copy-budget'));
});

test('pnpm v9 exact package identity is supported, YAML aliases and ambiguous/unsupported metadata are refused',t=>{
 const x=setup(t,{'package-lock.json':'{}'});
 const text="lockfileVersion: '9.0'\npackages:\n  decl@1.0.0:\n    resolution: {integrity: sha512-exact}\n";
 x.project.write('pnpm-lock.yaml',text);x.destination.write('pnpm-lock.yaml',text);x.destination.write('package-lock.json','{}');
 const ok=prepareBaselineDependencies(x.project.root,x.destination.root,x.snapshot);assert.equal(ok.summary.state,'available');
 const multi=setup(t,{'package-lock.json':'{}'}),multiText="---\nlockfileVersion: '9.0'\npackages: {}\n---\n"+text;
 multi.project.write('pnpm-lock.yaml',multiText);multi.destination.write('package-lock.json','{}');multi.destination.write('pnpm-lock.yaml',multiText);
 assert.equal(prepareBaselineDependencies(multi.project.root,multi.destination.root,multi.snapshot).summary.state,'available');
 const duplicate=setup(t,{'package-lock.json':'{}'});duplicate.project.write('pnpm-lock.yaml',text+'---\n'+text);duplicate.destination.write('package-lock.json','{}');duplicate.destination.write('pnpm-lock.yaml',text);
 assert.equal(prepareBaselineDependencies(duplicate.project.root,duplicate.destination.root,duplicate.snapshot).summary.state,'unavailable');
 const y=setup(t,{'package-lock.json':'{}'});y.project.write('pnpm-lock.yaml',text+'copy: &a [1]\nalias: *a\n');y.destination.write('package-lock.json','{}');y.destination.write('pnpm-lock.yaml',text);
 assert.equal(prepareBaselineDependencies(y.project.root,y.destination.root,y.snapshot).summary.state,'unavailable');
});

test('linked declarations and unsafe paths never expand the selected source scope',t=>{
 const x=setup(t),outside=tempProject(t,{'index.d.ts':'export declare const outside:unknown'});
 const unsafe={...x.snapshot,configuration:{...x.snapshot.configuration,inputs:[{path:'node_modules/decl/../../../outside.d.ts',hash:'x'}]}};
 assert.equal(prepareBaselineDependencies(x.project.root,x.destination.root,unsafe).summary.state,'unavailable');
 const fake={...x.snapshot,configuration:{...x.snapshot.configuration,inputs:[{path:'node_modules/decl/linked/index.d.ts',hash:sha('export declare const outside:unknown')}]}};
 try{symlinkSync(outside.root,path.join(x.project.root,'node_modules/decl/linked'),process.platform==='win32'?'junction':'dir')}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Symlink creation not permitted');return}throw error}
 const r=prepareBaselineDependencies(x.project.root,x.destination.root,fake);assert.equal(r.summary.state,'unavailable');assert.ok(r.summary.reasons.some(x=>x.code==='linked-path'));assert.equal(existsSync(path.join(x.destination.root,'node_modules/decl/linked/index.d.ts')),false);
});

test('Git comparison uses matched local declarations for HEAD while preserving old/new source and dependency freshness',async t=>{
 let store,manager;t.after(async()=>{await manager?.close();store?.close()});
 const {project}=setup(t);project.write('.gitignore','node_modules/\n');gitCommand(project.root,['init','--quiet']);gitCommand(project.root,['add','--all']);gitCommand(project.root,['commit','--quiet','-m','Pinned declaration fixture']);
 const original=readFileSync(path.join(project.root,'index.ts'),'utf8');project.write('index.ts',original.replace('return size(x)','return size(x)+1'));
 const cache=tempProject(t);store=new SnapshotStore(cache.root,project.root);manager=new ComparisonManager(project.root,store);
 const job=manager.start();let bundle;
 for(let n=0;n<300;n++){const j=manager.job(job.id);if(j.status!=='running'){assert.equal(j.status,'completed',j.error);bundle=manager.bundle(j.comparisonId);break}await delay(30)}
 assert.ok(bundle);assert.equal(bundle.base.snapshot.status,'complete');assert.equal(bundle.current.snapshot.status,'complete');assert.equal(bundle.report.baselineDependencies.state,'available');
 assert.equal(bundle.base.sources.find(s=>s.path==='index.ts').content,original);assert.match(bundle.current.sources.find(s=>s.path==='index.ts').content,/size\(x\)\+1/);
 for(const side of ['base','current']){const s=bundle[side].snapshot,target=findSymbol(s,'index.ts','target'),caller=findSymbol(s,'index.ts','caller');assert.ok(s.relations.some(e=>e.kind==='CALLS'&&e.from===caller.id&&e.to===target.id));assert.ok(s.files.every(f=>!f.path.startsWith('node_modules/')))}
 assert.equal(await manager.stale(bundle.report.id),false);project.write('package-lock.json',lock('2.0.0'));assert.equal(await manager.stale(bundle.report.id),true);
 assert.equal(bundle.base.sources.find(s=>s.path==='index.ts').content,original);
 project.write('package-lock.json',lock());project.write('index.ts','export function caller(){return 1}');
 const next=manager.start();let oldOnly;
 for(let n=0;n<300;n++){const j=manager.job(next.id);if(j.status!=='running'){assert.equal(j.status,'completed',j.error);oldOnly=manager.bundle(j.comparisonId);break}await delay(30)}
 assert.ok(oldOnly);assert.equal(oldOnly.report.baselineDependencies.state,'not-captured');assert.equal(oldOnly.base.snapshot.status,'partial');
});
