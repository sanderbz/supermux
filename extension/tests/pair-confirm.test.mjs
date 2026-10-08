import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {png} from './helpers/png.mjs';

test('pair confirmation gates new capabilities, persists candidates, and isolates same-site changes',async()=>{
 const state={},session={annotationTabs:{1:'https://one.example/page',2:'https://two.example/page'}};
 let handler,seq=0,block=null;const pairings=new Map(),sent=[];
 const store=map=>({setAccessLevel:async()=>{},get:async key=>key===null?map:{[key]:map[key]},set:async value=>Object.assign(map,value),remove:async key=>{delete map[key];}});
 Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
 globalThis.chrome={runtime:{id:'confirm-test',getURL:path=>'chrome-extension://confirm-test/'+path,onMessage:{addListener:fn=>handler=fn}},storage:{local:store(state),session:store(session)},permissions:{contains:async()=>true},tabs:{onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}},commands:{onCommand:{addListener(){}}}};
 globalThis.fetch=async(url,init)=>{
  if(url.endsWith('/pairings')){
   const site=JSON.parse(init.body).origin,id='pair-'+(++seq);
   pairings.set(id,{id:'binding-'+seq,origin:site,session:'agent-'+seq,session_label:'Agent '+seq,company_id:seq,company_label:'Company '+seq,token:'private-binding-'+seq});
   return {ok:true,json:async()=>({ok:true,data:{id,code:'1234',poll_token:'private-poll-'+seq}})};
  }
  if(url.includes('/pairings/')){if(block)await block.promise;const id=url.split('/').at(-1);return {ok:true,json:async()=>({ok:true,data:{status:'paired',binding:pairings.get(id)}})};}
  sent.push(init.headers.Authorization);return {ok:true,json:async()=>({ok:true,data:{id:'feedback',status:'queued'}})};
 };
 await import('../src/worker.js?confirm=1');
 const options={id:'confirm-test',url:'chrome-extension://confirm-test/options.html'};
 const content=site=>({id:'confirm-test',tab:{id:site==='https://one.example'?1:2,url:site+'/page'}});
 const rpc=(type,extra={},sender=options)=>new Promise(resolve=>handler({type,...extra},sender,resolve));
 const first='https://one.example',second='https://two.example',server='https://server.example';
 const payload=site=>({client_id:'fixture',url:site+'/page',message:'fixture',viewport:{width:100,height:80,dpr:1,scroll_x:0,scroll_y:0},annotations:[],screenshot:{mime:'image/png',data_base64:png()}});
 const begin=async site=>{const started=await rpc('pair.start',{site});assert.equal(started.ok,true);const polled=await rpc('pair.poll',{site});assert.equal(polled.data.status,'awaiting-confirmation');return {site,id:polled.data.id,binding_id:polled.data.binding.id,server_origin:polled.data.server_origin};};
 await rpc('connection.configure',{origin:server});
 const a=await begin(first);
 assert.equal((await rpc('draft.load',{},content(first))).data.connection.paired,false);
 assert.equal((await rpc('feedback.submit',{payload:payload(first)},content(first))).ok,false);
 const publicPending=await rpc('connection.get',{site:first});
 assert.equal(publicPending.data.pending.candidate.company_label,'Company 1');
 assert.equal(JSON.stringify(publicPending).includes('private-'),false);
 // A new service worker sees the saved candidate but cannot silently promote it.
 await import('../src/worker.js?confirm=restart');
 assert.equal((await rpc('draft.load',{},content(first))).data.connection.paired,false);
 for(const bad of [{...a,id:'stale'},{...a,binding_id:'stale'},{...a,site:second},{...a,server_origin:'https://other.example'}])assert.equal((await rpc('pair.confirm',bad)).ok,false);
 assert.equal((await rpc('pair.confirm',a,content(first))).ok,false);
 assert.equal((await rpc('pair.confirm',a)).ok,true);
 const b=await begin(second);assert.equal((await rpc('pair.confirm',b)).ok,true);
 assert.deepEqual(Object.keys(state.connection.bindings).sort(),[first,second]);
 const activeA=structuredClone(state.connection.bindings[first]),activeB=structuredClone(state.connection.bindings[second]);
 const changed=await begin(first);
 assert.deepEqual(state.connection.bindings[first],activeA);
 assert.equal((await rpc('feedback.submit',{payload:payload(first)},content(first))).ok,true);
 assert.equal(sent.at(-1),'Bearer '+activeA.token,'pending target never receives the old active site’s feedback');
 assert.equal((await rpc('pair.confirm',changed)).ok,true);
 assert.equal(state.connection.bindings[first].session,'agent-3');assert.equal(state.connection.bindings[first].company_label,'Company 3');
 assert.deepEqual(state.connection.bindings[second],activeB);
 assert.equal(JSON.stringify((await rpc('draft.load',{},content(first))).data).includes('private-'),false);
 const revoked=await begin(first);pairings.delete(revoked.id);assert.equal((await rpc('pair.confirm',revoked)).ok,false);assert.equal(state.connection.bindings[first].session,'agent-3');
 // The network recheck cannot activate a candidate replaced while it waits.
 const stale=await begin(first);let release;block={promise:new Promise(resolve=>release=resolve)};
 const confirmation=rpc('pair.confirm',stale);await new Promise(resolve=>setTimeout(resolve,0));
 await rpc('pair.start',{site:first});release();block=null;
 assert.equal((await confirmation).ok,false);assert.equal(state.connection.bindings[first].session,'agent-3');
 const serverRace=await begin(first);block={promise:new Promise(resolve=>release=resolve)};
 const delayed=rpc('pair.confirm',serverRace);await new Promise(resolve=>setTimeout(resolve,0));
 await rpc('connection.configure',{origin:'https://new-server.example'});release();block=null;
 assert.equal((await delayed).ok,false);assert.equal(state.connection.origin,'https://new-server.example');assert.deepEqual(state.connection.bindings,{});
 // Reset and reconnect to the identical server is still a new authority epoch.
 let startRelease,startEntered;const entered=new Promise(resolve=>startEntered=resolve),priorFetch=globalThis.fetch;
 globalThis.fetch=async(url,init)=>{if(url.endsWith('/pairings')){startEntered();await new Promise(resolve=>startRelease=resolve);}return priorFetch(url,init);};
 const staleStart=rpc('pair.start',{site:first});await entered;
 await rpc('connection.clear');await rpc('connection.configure',{origin:'https://new-server.example'});startRelease();
 assert.equal((await staleStart).ok,false);assert.deepEqual(state.connection.pending,{});

});
