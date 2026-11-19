import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {png} from './helpers/png.mjs';

test('large distinct review and saved crops recover within bounded storage, with failure and clear ordering',async()=>{
 const manifest=JSON.parse(await readFile(new URL('../src/manifest.json',import.meta.url),'utf8'));
 const unlimited=manifest.permissions.includes('unlimitedStorage');
 const state={},session={annotationTabs:{1:'https://one.example/page'}},tab={id:1,url:session.annotationTabs[1]};let handler,failWrite=false,holdNext=false,release,started;
 const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
 const local={setAccessLevel:async()=>{},get:async key=>key===null?structuredClone(state):{[key]:structuredClone(state[key])},set:async value=>{if(holdNext){holdNext=false;started();await new Promise(r=>release=r);}if(failWrite||!unlimited&&bytes({...state,...value})>10*1024*1024)throw new Error('QUOTA_BYTES quota exceeded');Object.assign(state,structuredClone(value));},remove:async keys=>{for(const key of Array.isArray(keys)?keys:[keys])delete state[key];}};
 Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
 globalThis.chrome={runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,onMessage:{addListener:f=>handler=f}},storage:{local,session:{get:async()=>session}},tabs:{onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}},commands:{onCommand:{addListener(){}}}};
 await import('../src/worker.js?storage-regression');
 const rpc=(type,extra={})=>new Promise(resolve=>handler({type,...extra},{id:'test',tab:{...tab}},resolve));
 const images=Array.from({length:12},(_,i)=>png(1024,500,i+1,true));
 const viewport={width:1024,height:500,dpr:1,scroll_x:0,scroll_y:0},rect={x:0,y:0,width:1024,height:500};
 const crops=images.slice(2,7).map((data_base64,i)=>({annotation_id:'note-'+i,number:i+1,mime:'image/png',data_base64,capture:{captured_at:'2026-10-07T12:00:00Z',viewport,rect,annotation_rect:rect}}));
 const draft={message:'Distinct frozen and saved originals',clientId:'retry-id',notes:crops.map(c=>({id:c.annotation_id,kind:'region',rect,text:'Note '+c.number})),snapshot:{viewport,url:'https://one.example/page',annotations:crops.map(c=>({id:c.annotation_id,number:c.number,kind:'region',rect,text:'Note '+c.number})),screenshot:{mime:'image/png',data_base64:images[0]},preview:'data:image/png;base64,'+images[1],crops},noteCrops:Object.fromEntries(crops.map((c,i)=>[c.annotation_id,{...c,data_base64:images[i+7]}]))};
 assert.ok(bytes(draft)>24*1024*1024,'distinct cached crops exceed the wire request size');
 assert.equal((await rpc('draft.save',{draft})).ok,true,'a large draft bypasses Chrome default 10MiB quota');
 assert.deepEqual((await rpc('draft.load')).data.draft,draft);
 const firstKey=Object.keys(state).find(k=>k.startsWith('draft:'));
 assert.ok(bytes(state[firstKey])<=48*1024*1024);
 const repeated={...draft,noteCrops:Object.fromEntries(crops.map(c=>[c.annotation_id,{...c,number:40,capture:{...c.capture,rect:{x:90,y:70,width:1024,height:500}}}]))};
 assert.equal((await rpc('draft.save',{draft:repeated})).ok,true);
 assert.ok(bytes(state[firstKey])<bytes(repeated)-10*1024*1024,'repeated pixels are deduplicated');
 assert.deepEqual((await rpc('draft.load')).data.draft,repeated);
 failWrite=true;const failed=await rpc('draft.save',{draft:{message:'unsaved'}});assert.equal(failed.ok,false);assert.match(failed.error,/previous saved draft is preserved/);assert.deepEqual((await rpc('draft.load')).data.draft,repeated);failWrite=false;
 for(const page of [2,3,4]){tab.url='https://one.example/page'+page;session.annotationTabs[1]=tab.url;assert.equal((await rpc('draft.save',{draft})).ok,true);await new Promise(r=>setTimeout(r,2));}
 assert.ok(bytes(state)<=80*1024*1024,'aggregate draft storage stays bounded');
 assert.equal(state[firstKey],undefined,'oldest draft is evicted for recent work');
 assert.deepEqual((await rpc('draft.load')).data.draft,draft);
 holdNext=true;const writing=new Promise(r=>started=r),save=rpc('draft.save',{draft:{message:'pending'}});await writing;const clear=rpc('draft.clear');release();assert.equal((await save).ok,true);assert.equal((await clear).ok,true);assert.equal((await rpc('draft.load')).data.draft,undefined,'clear waits for outstanding save');
});
