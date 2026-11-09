import assert from 'node:assert/strict';
import test from 'node:test';
import {tempProject,findSymbol} from './helpers.mjs';
import {assertSnapshotIntegrity} from '../packages/shared/dist/index.js';

const calls=(s,name='use')=>s.relations.filter(e=>e.kind==='CALLS'&&e.from===findSymbol(s,'index.ts',name).id);
const gaps=(s,name='use')=>s.unresolved.filter(e=>e.kind==='CALLS'&&e.from===findSymbol(s,'index.ts',name).id);

test('bound invocation traces a private source function, receiver and immutable aliases without executing at bind creation',t=>{
  const s=tempProject(t,{'index.ts':`function actual(this:{value:number}){return this.value}
    const description=actual.name+actual.length;
    function create(){return actual.bind({value:1})}
    const bound=create();const alias=bound;
    export function use(){bound();alias();actual.bind({value:2})()}
  `}).analyze();
  const target=findSymbol(s,'index.ts','actual');
  assert.equal(calls(s).length,3);assert.ok(calls(s).every(e=>e.to===target.id&&e.resolution==='value-origin'));
  assert.ok(calls(s).every(e=>e.supportingEvidenceIds.length>=3));
  assert.equal(calls(s,'create').filter(e=>e.to===target.id).length,0);
  assertSnapshotIntegrity(s);
});

test('closed object methods, lexical arrows and self aliases resolve this calls without guessing class instances',t=>{
  const s=tempProject(t,{'index.ts':`const object={
    value:0, leaf(){this.value++},
    run(){const self=this;self.leaf();const later=()=>this.leaf();later()}
  };export function use(){object.run()}`}).analyze();
  const run=findSymbol(s,'index.ts','object.run'),leaf=findSymbol(s,'index.ts','object.leaf');
  assert.ok(s.relations.some(e=>e.kind==='CALLS'&&e.from===run.id&&e.to===leaf.id));
  assert.equal(calls(s).length,1);
  assert.equal(s.relations.filter(e=>e.kind==='CALLS'&&e.to===leaf.id).length,2);
  assertSnapshotIntegrity(s);
});

test('inline nested paths, parent aliases and simple destructured child aliases retain source bodies',t=>{
  const s=tempProject(t,{'index.ts':`const root={child:{value:0,run(){this.value++}}};
    const parent=root;const alias=parent.child;const {child:destructured}=root;
    export function use(){root.child.run();alias.run();destructured.run()}`}).analyze();
  const target=findSymbol(s,'index.ts','root.run'); // Existing symbol labels omit non-callable property segments; identity uses exact AST positions.
  assert.equal(calls(s).length,3);assert.ok(calls(s).every(e=>e.to===target.id));assertSnapshotIntegrity(s);
});

test('nested aliases cannot hide parent replacement, member writes or unknown child escapes',t=>{
  const scenarios=[
    `const alias=root.child;alias.run=()=>{};`,
    `const {child:alias}=root;alias.run=()=>{};`,
    `const alias=root.child;unknown(alias);`,
    `const parent=root;unknown(parent.child);`,
    `root.child={run(){}};`,
    `for([root.child.run]of[[()=>{}]]){}`,
    `({...root.child.run}={value:1});`,
    `const alias=root.child;globalThis.saved=alias;`,
    `declare const key:string;const alias=root[key];unknown(alias);`,
  ];
  for(const hazard of scenarios){
    const s=tempProject(t,{'index.ts':`declare function unknown(value:unknown):void;
      const root={child:{run(){}}};${hazard}export function use(){root.child.run()}`}).analyze();
    assert.equal(calls(s).length,0,hazard);assert.ok(gaps(s)[0].reasonDetail?.evidenceIds.length,hazard);
  }
});

test('detached methods, this escape, class this, shared functions and ordinary callback this remain uncertain',t=>{
  const setups=[
    [`const root={leaf(){},run(){this.leaf()}};const detached=root.run;`, 'root.run()'],
    [`const root={leaf(){},run(){this.leaf()}};root.run.call({leaf(){}});`, 'root.run()'],
    [`const root={leaf(){},run(){unknown(this)}};`, 'root.run()'],
    [`const root={child:{run(){}},get(){return this.child}};const leaked=root.get();unknown(leaked);`, 'root.child.run()'],
    [`function shared(){this.leaf()};const root={leaf(){},run:shared};`, 'root.run()'],
    [`const root={__proto__:{leaf(){},run(){this.leaf()}}};`, 'root.run()'],
  ];
  for(const [setup,call]of setups){
    const s=tempProject(t,{'index.ts':`declare function unknown(value:unknown):void;${setup}export function use(){${call}}`}).analyze();
    assert.equal(calls(s).length,0,setup);assert.ok(gaps(s)[0].reasonDetail,setup);
  }
  const s=tempProject(t,{'index.ts':`const root={leaf(){},run(){function other(){this.leaf()};other()}};export function use(){root.run()}`}).analyze();
  const other=findSymbol(s,'index.ts','root.run.other');
  assert.ok(s.unresolved.some(e=>e.from===other.id&&e.kind==='CALLS'&&e.reasonDetail?.code==='receiver-this'));
});

test('shadowed bind, intrinsic mutation, original-function escape and mutable bound values retain gaps',t=>{
  const scenarios=[
    `function fn(){};fn.bind=(()=>()=>{}) as any;const bound=fn.bind({});`,
    `function fn(){};(fn as any).bind=()=>()=>{};const bound=fn.bind({});`,
    `function fn(){};Function.prototype.bind=(()=>()=>{}) as any;const bound=fn.bind({});`,
    `function fn(){};Function.prototype['bind']=(()=>()=>{}) as any;const bound=fn.bind({});`,
    `function fn(){};Object.defineProperty(Function.prototype,'bind',{value:()=>()=>{}});const bound=fn.bind({});`,
    `function fn(){};declare function unknown(value:unknown):void;unknown(fn);const bound=fn.bind({});`,
    `function fn(){};export {fn};const bound=fn.bind({});`,
    `function fn(){};let bound=fn.bind({});`,
    `const fake={bind(){return ()=>{}}};const bound=fake.bind({});`,
  ];
  for(const setup of scenarios){
    const s=tempProject(t,{'index.ts':`${setup} export function use(){bound()}`}).analyze();
    assert.equal(calls(s).length,0,setup);assert.equal(gaps(s).length,1,setup);
    assert.ok(gaps(s)[0].reasonDetail?.code.startsWith('binding-'),setup);
  }
});

test('factory method bodies do not merge this across separate returned instances',t=>{
  const s=tempProject(t,{'index.ts':`function create(){return {leaf(){},run(){this.leaf()}}}
    const first=create();const second=create();second.leaf=()=>{};
    export function use(){first.run()}`}).analyze();
  assert.equal(calls(s).length,1);
  const run=findSymbol(s,'index.ts','create.run');
  assert.ok(s.unresolved.some(e=>e.from===run.id&&e.kind==='CALLS'&&e.reasonDetail?.code==='receiver-this'));
});

test('standard call/apply forward to a closed source function while the intrinsic remains an external API',t=>{
  const s=tempProject(t,{'index.ts':`function actual(this:{value:number}){return this.value}
    export function use(){actual.call({value:1});actual.apply({value:2},[])}`}).analyze();
  const target=findSymbol(s,'index.ts','actual');
  assert.equal(calls(s).filter(e=>e.to===target.id).length,2);
  assert.equal(gaps(s).filter(e=>e.reason==='external').length,2);
  const bad=tempProject(t,{'index.ts':`function actual(){};(actual as any).call=()=>{};
    export function use(){actual.call({})}`}).analyze();
  assert.equal(calls(bad).length,0);
});

test('binding an arrow never replaces its lexical this with the bind argument',t=>{
  const s=tempProject(t,{'index.ts':`const receiver={leaf(){}};const actual=()=>this.leaf();
    const bound=actual.bind(receiver);export function use(){bound()}`}).analyze();
  assert.equal(calls(s).length,1);
  const actual=findSymbol(s,'index.ts','actual');
  assert.ok(s.unresolved.some(e=>e.from===actual.id&&e.reasonDetail?.code==='receiver-this'));
  assert.ok(!s.relations.some(e=>e.kind==='CALLS'&&e.from===actual.id&&e.to===findSymbol(s,'index.ts','receiver.leaf').id));
});
