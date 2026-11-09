import assert from 'node:assert/strict';
import test from 'node:test';
import {tempProject} from './helpers.mjs';
import {compareSnapshots,calculateComparisonImpact,comparisonSymbols} from '../packages/graph/dist/index.js';

function fixture(t){
 const text=`function hot(){return 1} function cold(){return 1}
 ${Array.from({length:140},(_,i)=>`function caller${i}(){hot()}`).join('\n')}
 function coldCaller(){cold()} function outer(){coldCaller()} function top(){outer()}
 function dormant(){return 1} function stableMiddle(){dormant()} function stableOuter(){stableMiddle()}
 function typed(input:typeof dormant){};`;
 const project=tempProject(t,{'index.ts':text});let oldSources,newSources;
 const base=project.analyze();
 project.write('index.ts',text.replace('hot(){return 1}','hot(){return 2}').replace('cold(){return 1}','cold(){return 2}'));
 const current=project.analyze();
 oldSources=[{path:'index.ts',content:text,hash:base.files[0].hash}];
 newSources=[{path:'index.ts',content:text.replace('hot(){return 1}','hot(){return 2}').replace('cold(){return 1}','cold(){return 2}'),hash:current.files[0].hash}];
 const report=compareSnapshots({baseline:{state:'ready',head:'test-head',scope:'',message:''},base,current,oldSources,newSources});
 return {report,base,current};
}

test('overview shares its bounded paths between versions and seeds; focus discovers symbols outside overview seeds',t=>{
 const {report,base,current}=fixture(t);
 assert.equal(report.paths.length,100);assert.equal(report.truncation.paths,true);
 for(const side of ['base','current'])assert.ok(report.paths.some(p=>p.side===side&&p.seed.name==='cold'&&p.target.name==='outer'));
 assert.ok(!report.paths.some(p=>p.seed.name==='dormant'));
 const found=comparisonSymbols(report,base,current,'dormant','current').find(x=>x.node.name==='dormant');assert.ok(found);
 const focused=calculateComparisonImpact(report,base,current,false,{side:'current',nodeId:found.node.id});
 assert.equal(focused.paths.length,2);assert.equal(focused.truncated,false);assert.equal(focused.overviewTruncated,true);
 assert.ok(focused.paths.every(p=>p.side==='current'&&p.seed.id===found.node.id));
 assert.ok(focused.paths.some(p=>p.target.name==='stableOuter'&&p.distance===2));
 assert.deepEqual(report.focus,undefined);assert.equal(report.paths.length,100);
 assert.throws(()=>calculateComparisonImpact(report,base,current,false,{side:'base',nodeId:'missing'}),RangeError);
});

test('focused fan-in still truncates, types stay opt-in and missing HEAD remains explicit',t=>{
 const {report,base,current}=fixture(t);
 const hot=comparisonSymbols(report,base,current,'hot','base').find(x=>x.node.name==='hot');
 const focused=calculateComparisonImpact(report,base,current,false,{side:'base',nodeId:hot.node.id});
 assert.equal(focused.paths.length,100);assert.equal(focused.truncation.paths,true);
 const cold=comparisonSymbols(report,base,current,'cold','current').find(x=>x.node.name==='cold');
 const deep=calculateComparisonImpact(report,base,current,false,{side:'current',nodeId:cold.node.id});
 assert.equal(deep.truncation.depth,true);assert.equal(deep.truncation.paths,false);
 const target=comparisonSymbols(report,base,current,'dormant','current').find(x=>x.node.name==='dormant');
 const focus={side:'current',nodeId:target.node.id};
 assert.ok(!calculateComparisonImpact(report,base,current,false,focus).paths.some(p=>p.dependency==='type'));
 assert.ok(calculateComparisonImpact(report,base,current,true,focus).paths.some(p=>p.dependency==='type'));
 assert.equal(calculateComparisonImpact(report,null,current,false,focus).paths.length,0);
});

test('full snapshot discovery bypasses mapped declaration caps; depth and work limits remain explicit',t=>{
 const text=Array.from({length:310},(_,i)=>`function f${i}(){return 1} function c${i}(){f${i}()}`).join('\n');
 const project=tempProject(t,{'index.ts':text,'unrelated.ts':'export function unrelated(){}'}),base=project.analyze();
 const next=text.replaceAll('return 1','return 2');project.write('index.ts',next);const current=project.analyze();
 const report=compareSnapshots({baseline:{state:'ready',head:'test',scope:'',message:''},base,current,oldSources:[{path:'index.ts',content:text}],newSources:[{path:'index.ts',content:next}]});
 assert.equal(report.changes[0].truncated,true);
 const target=comparisonSymbols(report,base,current,'f309','current').find(x=>x.node.name==='f309');assert.ok(target);
 const focus={side:'current',nodeId:target.node.id};
 const result=calculateComparisonImpact(report,base,current,false,focus);
 assert.ok(result.paths.some(p=>p.target.name==='c309'));assert.equal(result.truncation.changes,true);
 assert.equal(comparisonSymbols(report,base,current,'unrelated').length,0);
 const caller=current.symbols.find(x=>x.qualifiedName==='c309'),proof=current.evidence.find(x=>x.id===current.relations.find(x=>x.kind==='CALLS'&&x.from===caller.id).evidenceId);
 const edges=current.relations.filter(x=>x.kind==='CALLS'&&x.from===caller.id);
 current.relations.push(...Array.from({length:20001},(_,i)=>({...edges[0],id:`duplicate:${i}`})));
 assert.equal(calculateComparisonImpact(report,base,current,false,focus).truncation.work,true);
 assert.ok(proof);
});
