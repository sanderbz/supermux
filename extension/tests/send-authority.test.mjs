import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';
import {png} from './helpers/png.mjs';

test('uncertain retry and receipt status retain original company/agent across retarget and worker restart; resets fail closed',async()=>{
 const site='https://site.example',server='https://server.example';
 const bindingA={id:'a',origin:site,session:'agent-a',session_label:'Agent A',company_id:1,company_label:'Company A',token:'secret-a'};
 const bindingB={id:'b',origin:site,session:'agent-b',session_label:'Agent B',company_id:2,company_label:'Company B',token:'secret-b'};
 const state={connection:{origin:server,bindings:{[site]:bindingA},pending:{}}},session={annotationTabs:{1:site+'/page'}};
 let handler,offline=true,receipt=0;const calls=[];
 const store=map=>({setAccessLevel:async()=>{},get:async key=>key===null?map:{[key]:map[key]},set:async value=>Object.assign(map,value),remove:async key=>{delete map[key];}});
 Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
 globalThis.chrome={runtime:{id:'authority-test',getURL:p=>'chrome-extension://authority-test/'+p,onMessage:{addListener:f=>handler=f}},storage:{local:store(state),session:store(session)},permissions:{contains:async()=>true},tabs:{onRemoved:{addListener(){}}},action:{onClicked:{addListener(){}}},commands:{onCommand:{addListener(){}}}};
 globalThis.fetch=async(url,init)=>{
  const token=init.headers.Authorization;calls.push({url,token});let data;
  if(url.endsWith('/pairings'))data={id:'pair-b',code:'1234',poll_token:'secret-poll'};
  else if(url.includes('/pairings/'))data={status:'paired',binding:bindingB};
  else if(url.endsWith('/feedback')){
   assert.ok(Object.keys(state.feedbackAttempts).length>0,'authority is durable before network begins');
   if(offline)throw new Error('lost response');data={id:'receipt-'+(++receipt),status:'queued'};
  }else data={id:url.split('/').at(-1),status:'sent'};
  return {ok:true,json:async()=>({ok:true,data})};
 };
 await import('../src/worker.js?authority=first');
 const options={id:'authority-test',url:'chrome-extension://authority-test/options.html'};
 const content={id:'authority-test',tab:{id:1,url:site+'/page'}};
 const rpc=(type,extra={},sender=content)=>new Promise(resolve=>handler({type,...extra},sender,resolve));
 const payload={client_id:'saved-first',url:site+'/page',message:'Saved feedback',viewport:{width:100,height:80,dpr:1,scroll_x:0,scroll_y:0},annotations:[],screenshot:{mime:'image/png',data_base64:png()}};
 assert.equal((await rpc('feedback.submit',{payload})).ok,false);assert.equal(calls.at(-1).token,'Bearer secret-a');
 await rpc('pair.start',{site},options);await rpc('pair.poll',{site},options);
 await rpc('pair.confirm',{site,id:'pair-b',binding_id:'b',server_origin:server},options);
 assert.equal(state.connection.bindings[site].session,'agent-b');
 await import('../src/worker.js?authority=restart');offline=false;
 const recovered=await rpc('feedback.submit',{payload});assert.equal(recovered.ok,true);assert.equal(calls.at(-1).token,'Bearer secret-a');assert.equal(recovered.data.target.company_label,'Company A');assert.equal(recovered.data.target.session,'agent-a');
 assert.equal(JSON.stringify(recovered).includes('secret-'),false);
 const status=await rpc('feedback.status',{id:recovered.data.id});assert.equal(status.ok,true);assert.equal(calls.at(-1).token,'Bearer secret-a');assert.equal(status.data.target.session,'agent-a');
 const altered=await rpc('feedback.submit',{payload:{...payload,message:'Changed after send'}});assert.equal(altered.ok,false);
 const fresh=await rpc('feedback.submit',{payload:{...payload,client_id:'new-draft'}});assert.equal(fresh.ok,true);assert.equal(calls.at(-1).token,'Bearer secret-b');assert.equal(fresh.data.target.company_label,'Company B');
 const beforeReset=calls.length;await rpc('connection.clear',{},options);await rpc('connection.configure',{origin:server},options);
 assert.equal((await rpc('feedback.submit',{payload})).ok,false);assert.equal((await rpc('feedback.status',{id:recovered.data.id})).ok,false);assert.equal(calls.length,beforeReset,'reset never redirects an old send');
 // Capacity cannot evict a saved uncertain authority to accept a new send.
 state.connection.bindings[site]=bindingB;
 for(let i=Object.keys(state.feedbackAttempts).length;i<2048;i++)state.feedbackAttempts['old-'+i]={site,origin:server};
 const beforeFull=calls.length;const original=structuredClone(state.feedbackAttempts['saved-first']);
 const full=await rpc('feedback.submit',{payload:{...payload,client_id:'over-capacity'}});assert.equal(full.ok,false);assert.match(full.error,/storage is full/);assert.equal(calls.length,beforeFull);assert.deepEqual(state.feedbackAttempts['saved-first'],original);
});
