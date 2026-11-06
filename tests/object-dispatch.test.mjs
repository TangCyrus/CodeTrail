import assert from 'node:assert/strict';
import test from 'node:test';
import {tempProject, findSymbol} from './helpers.mjs';
import {assertSnapshotIntegrity} from '../packages/shared/dist/index.js';

const callsFrom = (snapshot, name='use') => snapshot.relations.filter(e=>e.kind==='CALLS' && e.from===findSymbol(snapshot,'index.ts',name).id);
const gapsFrom = (snapshot, name='use') => snapshot.unresolved.filter(e=>e.kind==='CALLS' && e.from===findSymbol(snapshot,'index.ts',name).id);

test('interface-typed literal, const aliases, arrows and literal property accesses retain concrete implementations', t=>{
  const project=tempProject(t,{'index.ts':`interface API {run():number; next():number}
    function actual(){return 1} function wrong(){return 2}
    const source: API = {run: actual, next:()=>3}; const alias: API=source;
    const cast: any = {run(){return 4}};
    export function use(){source.run(); alias['run'](); source.next(); cast.run()}
  `});
  const s=project.analyze(), calls=callsFrom(s);
  assert.equal(calls.length,4); assert.equal(gapsFrom(s).length,0);
  assert.equal(calls.filter(e=>e.to===findSymbol(s,'index.ts','actual').id).length,2);
  assert.ok(calls.every(e=>e.resolution==='value-origin' && e.supportingEvidenceIds.length>=2));
  assert.ok(!calls.some(e=>e.to===findSymbol(s,'index.ts','wrong').id));
  assertSnapshotIntegrity(s);
});

test('a fresh factory object returned through a local const resolves across modules and ignores return signatures', t=>{
  const project=tempProject(t,{
    'api.ts':`export interface API {run():number}
      export function create():API { const result:API={run(){return 1}}; return result }`,
    'index.ts':`import {create} from './api'; const result=create(); export function use(){result.run()}`,
  });
  const s=project.analyze(), calls=callsFrom(s);
  assert.equal(calls.length,1);
  const target=s.symbols.find(x=>x.id===calls[0].to);
  assert.equal(target.qualifiedName,'create.result.run');
  const excerpts=calls[0].supportingEvidenceIds.map(id=>s.evidence.find(e=>e.id===id).excerpt);
  assert.ok(excerpts.includes('return result'));
  assertSnapshotIntegrity(s);
});

test('parameters and structural method types cannot impersonate the object implementation', t=>{
  const project=tempProject(t,{'index.ts':`const original={run(){}};
    export function use(receiver:typeof original){receiver.run()}
  `}); const s=project.analyze();
  assert.equal(callsFrom(s).length,0);
  assert.equal(gapsFrom(s)[0].reasonDetail.code,'receiver-parameter');
});

test('direct and alias writes, dynamic writes, delete, assign, export and unknown escapes reject object dispatch', t=>{
  const cases=[
    ['object.run=()=>{}','member-written'],
    ['const alias=object; alias.run=()=>{}','member-written'],
    ['const alias=object; ({run:alias.run}={run:()=>{}})','member-written'],
    ['for ([object.run] of [[()=>{}]]) {}','member-written'],
    ['({...object.run}={extra:1})','member-written'],
    ['let key="run"; object[key]=()=>{}','computed-write'],
    ['delete object.run','member-written'],
    ['Object.assign(object,{run:()=>{}})','receiver-escaped'],
    ['unknown(object)','receiver-escaped'],
    ['const alias=object; unknown(alias)','receiver-escaped'],
    ['export {object}','receiver-escaped'],
    ['globalThis.saved=object','receiver-escaped'],
  ];
  for(const [hazard,code] of cases){
    const project=tempProject(t,{'index.ts':`declare function unknown(value:unknown):void;
      const object={run(){}}; ${hazard}; export function use(){object.run()}`});
    const s=project.analyze(); assert.equal(callsFrom(s).length,0,hazard);
    const gap=gapsFrom(s)[0];assert.equal(gap.reasonDetail.code,code,hazard);assert.ok(gap.reasonDetail.evidenceIds.length);
  }
});

test('conditional values, callbacks, getters, spreads, shared returns and unknown this retain explanatory gaps', t=>{
  const cases=[
    [`declare const cond:boolean; const obj=cond?{run(){}}:{run(){}};`, 'obj.run()', 'receiver-origin'],
    [`declare const callback:()=>void; const obj={run:callback};`, 'obj.run()', 'member-not-concrete'],
    [`const obj={get run(){return ()=>{}}};`, 'obj.run()', 'object-shape'],
    [`const obj={...{run(){}}};`, 'obj.run()', 'object-shape'],
    [`const obj={run(){return this}};`, 'obj.run()', 'object-this'],
    [`function actual(){return this}; const obj={run:actual};`, 'obj.run()', 'object-this'],
    [`const shared={run(){}}; function create(){return shared}; const obj=create();`, 'obj.run()', 'shared-return'],
    [`function create(flag:boolean){if(flag)return {run(){}};return {run(){}}};const obj=create(true);`, 'obj.run()', 'factory-returns'],
    [`async function create(){return {run(){}}};const obj=create() as any;`, 'obj.run()', 'factory-origin'],
    [`const obj={run(){}};declare const key:string;`, 'obj[key]()', 'computed-member'],
    [`declare function unknown(value:unknown):void;const outer={inner:{run(){}}};const alias=outer.inner;unknown(alias);`, 'outer.inner.run()', 'receiver-nested'],
  ];
  for(const [setup,call,code] of cases){
    const s=tempProject(t,{'index.ts':`${setup} export function use(){${call}}`}).analyze();
    assert.equal(callsFrom(s).length,0,setup);assert.equal(gapsFrom(s)[0].reasonDetail.code,code,setup);
  }
});

test('writes to unrelated scalar fields do not erase a known method; method name writes never use type as proof',t=>{
  const s=tempProject(t,{'index.ts':`interface API {run():void; value:number};
    const obj:API={run(){},value:0}; obj.value++; export function use(){obj.run()}
  `}).analyze();assert.equal(callsFrom(s).length,1);
});

test('independent project checkers join exact factory declarations without mixing fresh receiver instances', t=>{
  const json=JSON.stringify;
  const files={
    'package.json':json({private:true,workspaces:['packages/*']}),
    'tsconfig.json':json({files:[],references:[{path:'packages/core'},{path:'packages/a'},{path:'packages/b'}]}),
    'base.json':json({compilerOptions:{target:'ES2022',module:'ESNext',moduleResolution:'Bundler',strict:true,composite:true}}),
    'packages/core/package.json':json({name:'@demo/core',exports:'./dist/index.js'}),
    'packages/core/tsconfig.json':json({extends:'../../base.json',compilerOptions:{rootDir:'src',outDir:'dist'},include:['src']}),
    'packages/core/src/index.ts':`export interface API{run():number};export function create():API{return {run(){return 1}}}`,
  };
  for(const name of ['a','b']){
    files[`packages/${name}/package.json`]=json({name:`@demo/${name}`});
    files[`packages/${name}/tsconfig.json`]=json({extends:'../../base.json',compilerOptions:{strict:name==='a'},references:[{path:'../core'}]});
    files[`packages/${name}/index.ts`]=`import {create} from '@demo/core';const obj=create();${name==='b'?'obj.run=()=>2;':''}export function use(){obj.run()}`;
  }
  const s=tempProject(t,files).analyze();assert.equal(s.status,'complete');
  const a=findSymbol(s,'packages/a/index.ts','use'),b=findSymbol(s,'packages/b/index.ts','use');
  assert.equal(s.relations.filter(e=>e.kind==='CALLS'&&e.from===a.id).length,1);
  assert.equal(s.relations.filter(e=>e.kind==='CALLS'&&e.from===b.id).length,0);
  assert.equal(s.unresolved.find(e=>e.kind==='CALLS'&&e.from===b.id).reasonDetail.code,'member-written');
});
