import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createControlService} from '../src/control-session.js';

const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},emit(...args){for(const fn of this.listeners)fn(...args);}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Expected control lifecycle event');};
function fixture(options={}) {
  const site='https://example.test',tab={id:7,url:site+'/page',title:'Fixture'};
  let config={origin:'https://server.test',epoch:'one',bindings:{[site]:{id:'binding-a',token:'private-a',session:'agent-a',company_label:'Company A'}}};
  const records=[],sockets=[],commands=[],detaches=[],saved={},messages=[];
  let command=async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:tab.url,loaderId:'doc1'}}}:method==='Runtime.evaluate'?{result:{value:'fixture result'}}:{};
  class Socket {
    readyState=0;
    constructor(url){this.url=url;sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
    send(payload){const frame=JSON.parse(payload);records.push(frame);if(frame.type==='auth')queueMicrotask(()=>this.receive(options.ready?.(frame)??{type:'ready',lease_id:frame.lease_id,connection_id:'connection-'+sockets.length}));}
    receive(frame){this.onmessage?.({data:JSON.stringify(frame)});}
    close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
  }
  const chrome={
    storage:{session:{async get(key){return {[key]:saved[key]};},async set(value){Object.assign(saved,value);}}},
    permissions:{async contains(){return true;},onRemoved:event()},
    tabs:{async get(){return {...tab};},async sendMessage(_id,message){messages.push(message);return message.type==='control.prepare'?{ok:true}:undefined;},onRemoved:event(),onUpdated:event()},
    scripting:{async executeScript(){}},
    debugger:{onEvent:event(),onDetach:event(),async attach(){},async detach(target){detaches.push(target);},async sendCommand(target,method,params){commands.push({target,method,params});return command(method,params);}},
  };
  const service=createControlService({chrome,getConfig:async()=>config,WebSocketClass:Socket,...options});
  const sender={frameId:0,url:tab.url};
  return {service,chrome,tab,records,sockets,commands,detaches,saved,messages,
    setConfig(value){config=value;},getConfig(){return config;},setCommand(fn){command=fn;},
    start:()=>service.handle('control.start',{...tab},sender),stop:()=>service.handle('control.stop',{...tab},sender),
    async batch(steps,id='request',timeout_ms=1000){sockets.at(-1).receive({type:'command',id,steps,timeout_ms});await until(()=>records.some(r=>r.type==='result'&&r.id===id));return records.find(r=>r.type==='result'&&r.id===id);},
  };
}

test('activation authenticates in the first frame without exposing capability in status or URL',async()=>{
  const f=fixture();try{
    const state=await f.start();assert.equal(state.state,'active');assert.equal(JSON.stringify(state).includes('private-a'),false);
    assert.equal(f.sockets[0].url,'wss://server.test/api/browser/control/ws');assert.equal(f.records[0].type,'auth');assert.equal(f.records[0].token,'private-a');
    const result=await f.batch([{action:'evaluate',expression:'1'},{action:'evaluate',expression:'2'}]);assert.equal(result.ok,true);assert.equal(result.completed,2);
    assert.deepEqual(f.records.filter(r=>r.type==='progress').map(r=>r.completed),[1,2]);
  }finally{await f.stop();}
});

test('retargeting or resetting a binding detaches rather than giving existing lease new authority',async()=>{
  for(const change of ['binding','epoch']){
    const f=fixture();try{await f.start();const c=f.getConfig();f.setConfig(change==='binding'?{...c,bindings:{[new URL(f.tab.url).origin]:{id:'binding-b',token:'private-b'}}}:{...c,epoch:'two'});await f.service.connectionChanged();assert.equal(f.sockets[0].readyState,3);assert.equal(f.detaches.length,1);assert.equal((await f.service.status(7)).state,'idle');assert.equal(f.records.some(r=>r.type==='auth'&&r.token==='private-b'),false);}finally{await f.stop();}
  }
});

test('Stop while an action is awaiting CDP prevents remaining steps and stale completion',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();try{
    await f.start();f.setCommand(async method=>{if(method==='Runtime.evaluate'){entered.resolve();await held.promise;return {result:{value:'late'}};}return {};});
    f.sockets[0].receive({type:'command',id:'cancelled',steps:[{action:'evaluate',expression:'1'},{action:'evaluate',expression:'2'}],timeout_ms:1000});
    await entered.promise;await f.stop();held.resolve();await new Promise(r=>setTimeout(r,20));
    assert.equal(f.commands.filter(c=>c.method==='Runtime.evaluate').length,1);assert.equal(f.records.some(r=>r.type==='result'&&r.id==='cancelled'),false);assert.equal(f.saved.controlSessions.length,0);
  }finally{held.resolve();await f.stop();}
});

test('partial side effects are reported as uncertain and never replayed automatically',async()=>{
  const f=fixture();try{
    await f.start();let count=0;f.setCommand(async method=>{if(method==='Runtime.evaluate'){count++;throw new Error('Execution failed after page JavaScript began');}return {};});
    const result=await f.batch([{action:'evaluate',expression:'window.counter++'}]);assert.equal(result.ok,false);assert.equal(result.completed,0);assert.equal(result.outcome_unknown,true);assert.equal(count,1);
  }finally{await f.stop();}
});

test('schema rejection performs no browser work and concurrent batches do not overlap',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();try{
    await f.start();const before=f.commands.length;const invalid=await f.batch([{action:'unsupported'}],'invalid');assert.equal(invalid.error.code,'invalid_action');assert.equal(f.commands.length,before);
    f.setCommand(async method=>{if(method==='Runtime.evaluate'){entered.resolve();await held.promise;return {result:{value:'done'}};}return {};});
    f.sockets[0].receive({type:'command',id:'held',steps:[{action:'evaluate',expression:'1'}],timeout_ms:1000});await entered.promise;
    const busy=await f.batch([{action:'evaluate',expression:'2'}],'other');assert.equal(busy.error.code,'busy');held.resolve();await until(()=>f.records.some(r=>r.id==='held'&&r.type==='result'));
  }finally{held.resolve();await f.stop();}
});

test('cross-origin or unavailable tab URL fails closed before input dispatch',async()=>{
  for(const url of ['https://other.test/',undefined]){
    const f=fixture();try{await f.start();f.tab.url=url;f.sockets[0].receive({type:'command',id:'off-origin',steps:[{action:'key',key:'Enter'}],timeout_ms:1000});await until(()=>f.detaches.length===1);assert.equal(f.commands.some(c=>c.method.startsWith('Input.')),false);}finally{await f.stop();}
  }
});

test('a batch stuck past its timeout grace detaches, and a fresh activation is usable after old CDP completion',async()=>{
  const f=fixture({runGraceMs:30}),held=deferred(),entered=deferred();try{
    await f.start();f.setCommand(async method=>{if(method==='Runtime.evaluate'){entered.resolve();await held.promise;return {result:{value:'late'}};}return {};});
    f.sockets[0].receive({type:'command',id:'timeout',steps:[{action:'evaluate',expression:'1'}],timeout_ms:15});await entered.promise;await until(()=>f.detaches.length===1);
    held.resolve();f.setCommand(async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:f.tab.url}}}:method==='Runtime.evaluate'?{result:{value:'fresh'}}:{});
    await f.start();const result=await f.batch([{action:'evaluate',expression:'2'}],'fresh');assert.equal(result.results[0],'fresh');assert.notEqual(f.records.filter(r=>r.type==='auth')[0].lease_id,f.records.filter(r=>r.type==='auth')[1].lease_id);
  }finally{held.resolve();await f.stop();}
});

test('worker restart detaches persisted grants without silently reconnecting',async()=>{
  const detached=[];const chrome={storage:{session:{async get(){return {controlSessions:[{tabId:9}]};},async set(){} }},debugger:{async detach(target){detached.push(target);},onEvent:event(),onDetach:event()},tabs:{async get(){return {id:9,url:'https://example.test/'};},onRemoved:event(),onUpdated:event()},permissions:{onRemoved:event()}};
  const service=createControlService({chrome,getConfig:async()=>null,WebSocketClass:class{constructor(){assert.fail('No automatic socket');}}});
  assert.equal((await service.status(9)).state,'idle');assert.deepEqual(detached,[{tabId:9}]);
});

test('unknown frame selectors and oversized UTF-8 text are rejected without browser mutation',async()=>{
  const f=fixture();try{
    await f.start();const unknown=await f.batch([{action:'click',frame:'missing',selector:'#root'}],'missing');assert.equal(unknown.error.code,'stale_frame');assert.equal(f.commands.some(c=>c.method==='Input.dispatchMouseEvent'),false);
    const oversized=await f.batch([{action:'fill',selector:'#root',text:'界'.repeat(5500)}],'large');assert.equal(oversized.error.code,'invalid_action');assert.equal(f.commands.some(c=>c.method==='Input.insertText'),false);
  }finally{await f.stop();}
});

test('aggregate screenshot output is bounded even when each image fits its individual limit',async()=>{
  const f=fixture();try{
    await f.start();const data=Buffer.alloc(3*1024*1024);data.writeUInt32BE(100,16);data.writeUInt32BE(100,20);
    f.setCommand(async(method,params)=>{
      if(method==='Runtime.evaluate')return {result:{value:{width:100,height:100,dpr:1}}};
      if(method==='Page.getLayoutMetrics')return {cssVisualViewport:{pageX:0,pageY:250}};
      if(method==='Page.captureScreenshot'){assert.equal(params.clip.y,250);return {data:data.toString('base64')};}
      return {};
    });
    const result=await f.batch([{action:'screenshot'},{action:'screenshot'}],'images');assert.equal(result.ok,false);assert.equal(result.error.code,'result_too_large');assert.equal(result.completed,2);assert.equal(result.results.length,1);
    assert.ok(f.records.every(frame=>Buffer.byteLength(JSON.stringify(frame))<=8*1024*1024),'no oversized frame is emitted');
  }finally{await f.stop();}
});


test('failed draft persistence refuses control before debugger attach or websocket authentication',async()=>{
  const f=fixture();let attached=false;f.chrome.debugger.attach=async()=>{attached=true;};f.chrome.tabs.sendMessage=async(_id,message)=>message.type==='control.prepare'?{ok:false,error:'Draft storage failed'}:undefined;
  await assert.rejects(f.start(),/Draft storage failed/);assert.equal(attached,false);assert.equal(f.sockets.length,0);assert.equal(f.saved.controlSessions.length,0);
});

test('Stop during draft preparation prevents a queued activation',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();let attached=false;
  f.chrome.debugger.attach=async()=>{attached=true;};f.chrome.tabs.sendMessage=async(_id,message)=>{if(message.type==='control.prepare'){entered.resolve();await held.promise;return {ok:true};}};
  const starting=f.start();await entered.promise;await f.stop();held.resolve();await assert.rejects(starting,/Browser control stopped/);assert.equal(attached,false);assert.equal(f.sockets.length,0);
});

test('serialized SPA URL updates read the latest tab rather than delayed event URLs',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();try{
    await f.start();const get=f.chrome.storage.session.get;let first=true;
    f.chrome.storage.session.get=async key=>{if(key==='annotationTabs'&&first){first=false;entered.resolve();await held.promise;}return get(key);};
    f.tab.url='https://example.test/first';f.chrome.tabs.onUpdated.emit(7,{url:f.tab.url},{...f.tab});await entered.promise;
    f.tab.url='https://example.test/latest';f.chrome.tabs.onUpdated.emit(7,{url:f.tab.url},{...f.tab});held.resolve();
    await until(()=>f.saved.annotationTabs?.[7]===f.tab.url);await new Promise(r=>setTimeout(r,10));assert.equal(f.saved.annotationTabs[7],'https://example.test/latest');
  }finally{held.resolve();await f.stop();}
});

test('native Stop detaches immediately and refreshes SPA URL before returning the idle state',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();try{
    await f.start();f.tab.url='https://example.test/spa';const get=f.chrome.storage.session.get;
    f.chrome.storage.session.get=async key=>{if(key==='annotationTabs'){entered.resolve();await held.promise;}return get(key);};
    const stopping=f.stop();await entered.promise;assert.equal(f.detaches.length,1,'command stream already detached');assert.equal(f.messages.at(-1).state.state,'active','idle UI waits for URL cache');
    held.resolve();await stopping;assert.equal(f.saved.annotationTabs[7],f.tab.url);assert.equal(f.messages.at(-1).state.state,'idle');await f.start();assert.equal(f.sockets.length,2,'initial sender document URL remains valid within the paired origin');
  }finally{held.resolve();await f.stop();}
});

const slowEvaluate=(ms,value='slow')=>async method=>{if(method==='Runtime.evaluate'){await new Promise(r=>setTimeout(r,ms));return {result:{value}};}return method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:'https://example.test/page'}}}:{};};

test('a batch timeout ends only that batch and control stays connected',async()=>{
  const f=fixture();try{
    await f.start();f.setCommand(slowEvaluate(60));
    const timedOut=await f.batch([{action:'evaluate',expression:'1'},{action:'evaluate',expression:'2'}],'slow',15);
    assert.equal(timedOut.ok,false);assert.equal(timedOut.error.code,'timeout');assert.equal(timedOut.completed,0);
    assert.equal(f.detaches.length,0);assert.equal(f.sockets[0].readyState,1);assert.equal((await f.service.status(7)).state,'active');
    assert.equal(f.records.some(r=>r.type==='stop'),false);assert.equal(f.commands.filter(c=>c.method==='Runtime.evaluate').length,1,'later steps never run');
    f.setCommand(slowEvaluate(0,'next'));const next=await f.batch([{action:'evaluate',expression:'3'}],'next');assert.equal(next.ok,true);assert.equal(next.results[0],'next');
  }finally{await f.stop();}
});

test('a cancelled batch ends only that batch and control stays connected',async()=>{
  const f=fixture(),entered=deferred();try{
    await f.start();f.setCommand(async method=>{if(method==='Runtime.evaluate'){entered.resolve();await new Promise(r=>setTimeout(r,30));return {result:{value:'late'}};}return {};});
    f.sockets[0].receive({type:'command',id:'cancel-me',steps:[{action:'evaluate',expression:'1'},{action:'evaluate',expression:'2'}],timeout_ms:1000});
    await entered.promise;f.sockets[0].receive({type:'cancel',id:'cancel-me'});
    await until(()=>f.records.some(r=>r.type==='result'&&r.id==='cancel-me'));
    assert.equal(f.records.find(r=>r.type==='result'&&r.id==='cancel-me').error.code,'cancelled');
    assert.equal(f.detaches.length,0);assert.equal((await f.service.status(7)).state,'active');assert.equal(f.commands.filter(c=>c.method==='Runtime.evaluate').length,1);
  }finally{await f.stop();}
});

test('server lease expiry ends control and the pill shows why and until when',async()=>{
  const f=fixture();try{
    const expires=Date.now()+3600000;await f.start();
    assert.equal((await f.service.status(7)).lease_expires_at,null);
    f.sockets[0].receive({type:'command',id:'lease',steps:[{action:'evaluate',expression:'1'}],timeout_ms:1000,lease_expires_at:expires});
    await until(()=>f.records.some(r=>r.type==='result'&&r.id==='lease'));assert.equal((await f.service.status(7)).lease_expires_at,expires);
    f.sockets[0].receive({type:'stop',reason:'lease_expired'});await until(()=>f.detaches.length===1);
    const state=await f.service.status(7);assert.equal(state.state,'idle');assert.match(state.error,/1 hour without agent activity/);
    assert.equal(f.records.find(r=>r.type==='stop').reason,state.error,'the reason is reported back to the server');
    await f.start();assert.equal((await f.service.status(7)).error,null);
  }finally{await f.stop();}
});

function frameFixture(){
  const f=fixture();let mainNode=11;const resolved=[];
  f.setCommand(async(method,params)=>{
    if(method==='Page.getFrameTree')return {frameTree:{frame:{id:'main',url:f.tab.url,loaderId:'doc1'},childFrames:[{frame:{id:'child',parentId:'main',url:'https://ads.test/'}}]}};
    if(method==='DOM.getDocument')return {root:{backendNodeId:1}};
    if(method==='Accessibility.getFullAXTree')return {nodes:params.frameId==='main'?[{role:{value:'textbox'},name:{value:'App name'},backendDOMNodeId:mainNode},{role:{value:'button'},name:{value:'Save'},backendDOMNodeId:31}]:[{role:{value:'button'},name:{value:'Ad'},backendDOMNodeId:21}]};
    if(method==='Runtime.evaluate')return {result:{value:{url:f.tab.url,title:'Fixture'}}};
    if(method==='DOM.resolveNode'){resolved.push(params.backendNodeId);if(params.backendNodeId!==mainNode&&params.backendNodeId<30&&params.backendNodeId!==21)throw new Error('No node with given id found');return {object:{objectId:'node-'+params.backendNodeId}};}
    if(method==='Runtime.callFunctionOn')return {result:{value:{connected:true,editable:true,hit:true,rect:{x:1,y:1,width:10,height:10}}}};
    return {};
  });
  return Object.assign(f,{resolved,rerender(){mainNode++;},event:(method,params,sessionId)=>f.chrome.debugger.onEvent.emit({tabId:7,...(sessionId?{sessionId}:{})},method,params)});
}

test('navigation in an unrelated frame does not invalidate main-frame refs',async()=>{
  const f=frameFixture();try{
    await f.start();const snapshot=(await f.batch([{action:'snapshot'}],'snap')).results[0];
    const input=snapshot.nodes.find(n=>n.name==='App name').ref,ad=snapshot.nodes.find(n=>n.name==='Ad').ref;
    f.event('Page.frameNavigated',{frame:{id:'child',parentId:'main',loaderId:'ad-2',url:'https://ads.test/next'}});
    f.event('Page.frameDetached',{frameId:'lazy-frame'});
    f.event('Target.detachedFromTarget',{sessionId:'unrelated-session'});
    f.event('DOM.documentUpdated',{},'unrelated-session');
    const fill=await f.batch([{action:'fill',ref:input,text:'Supermux'}],'fill');assert.equal(fill.ok,true,JSON.stringify(fill.error));
    assert.ok(f.commands.some(c=>c.method==='Input.insertText'&&c.params.text==='Supermux'));
    const stale=await f.batch([{action:'click',ref:ad}],'ad');assert.equal(stale.error.code,'stale_ref','the navigated frame keeps its own refs stale');
    f.event('Page.frameNavigated',{frame:{id:'main',loaderId:'doc2',url:f.tab.url}});
    const gone=await f.batch([{action:'fill',ref:input,text:'x'}],'gone');assert.equal(gone.error.code,'stale_ref','a main-frame navigation still invalidates everything');
  }finally{await f.stop();}
});

test('a re-rendered element is found again once by role and name',async()=>{
  const f=frameFixture();try{
    await f.start();const snapshot=(await f.batch([{action:'snapshot'}],'snap')).results[0];
    const input=snapshot.nodes.find(n=>n.name==='App name').ref;f.rerender();
    const fill=await f.batch([{action:'fill',ref:input,text:'again'}],'fill');assert.equal(fill.ok,true,JSON.stringify(fill.error));
    assert.deepEqual(f.resolved.slice(-2),[11,12]);
  }finally{await f.stop();}
});

// ── All websites scope ─────────────────────────────────────────────────────
function allSites(options={},expiresIn=3600){
  const ready=frame=>({type:'ready',lease_id:frame.lease_id,connection_id:'connection-all',scope:'all',expires_at:(Math.floor(Date.now()/1000)+expiresIn)*1000,blocked_sites:['paypal.com','bunq.com'],blocked_hosts:['server.test']});
  const f=fixture({ready,...options}),site='https://example.test',c=f.getConfig();
  f.setConfig({...c,bindings:{[site]:{...c.bindings[site],scope:'all',expires_at:Math.floor(Date.now()/1000)+expiresIn}}});
  f.navigate=url=>{f.tab.url=url;f.chrome.debugger.onEvent.emit({tabId:7},'Page.frameNavigated',{frame:{id:'main',url,loaderId:'doc-'+url}});};
  return f;
}

test('All websites: leaving the paired origin keeps control and reports the new origin',async()=>{
  const f=allSites();try{
    const state=await f.start();assert.equal(state.state,'active');
    const status=await f.service.status(7);assert.equal(status.scope,'all');assert.ok(status.expires_at>Date.now());
    f.navigate('https://other.test/next');await new Promise(r=>setTimeout(r,10));
    assert.deepEqual(f.records.filter(r=>r.type==='navigated'),[{type:'navigated',origin:'https://other.test'}]);
    const result=await f.batch([{action:'evaluate',expression:'1'}]);assert.equal(result.ok,true);assert.equal(result.origin,'https://other.test');
    assert.equal((await f.service.status(7)).state,'active');
  }finally{await f.stop();}
});

test('All websites: landing on a blocked site ends control with blocked_site and sends no CDP command there',async()=>{
  for(const url of ['https://paypal.com/','https://www.paypal.com/x','https://SERVER.test/dashboard']){
    const f=allSites();try{
      await f.start();await new Promise(r=>setTimeout(r,10));
      const before=f.commands.length;f.navigate(url);
      f.sockets[0].receive({type:'command',id:'after',steps:[{action:'evaluate',expression:'document.cookie'}],timeout_ms:1000});
      await until(()=>f.detaches.length===1);await new Promise(r=>setTimeout(r,10));
      const stop=f.records.find(r=>r.type==='stop');assert.equal(stop?.code,'blocked_site',url);
      assert.deepEqual(f.commands.slice(before).map(c=>c.method),[],'no command after landing on '+url);
      assert.equal(f.records.some(r=>r.type==='navigated'),false);
    }finally{await f.stop();}
  }
});

test('All websites: navigate to a blocked domain or subdomain is refused before Page.navigate; lookalikes go through',async()=>{
  const f=allSites();try{
    await f.start();
    for(const [i,url] of ['https://paypal.com/','https://login.paypal.com/','https://bunq.com/app'].entries()){
      const result=await f.batch([{action:'navigate',url}],'nav-'+i);
      assert.equal(result.ok,false);assert.equal(result.error.code,'blocked_site',url);
    }
    assert.equal(f.commands.some(c=>c.method==='Page.navigate'),false);
    await f.batch([{action:'navigate',url:'https://notpaypal.com/'}],'lookalike',200);
    assert.deepEqual(f.commands.filter(c=>c.method==='Page.navigate').map(c=>c.params.url),['https://notpaypal.com/']);
  }finally{await f.stop();}
});

test('All websites: the page pill lives in an isolated world and its Stop ends control',async()=>{
  const f=allSites();try{
    await f.start();await until(()=>f.commands.some(c=>c.method==='Runtime.evaluate'&&String(c.params.expression).includes('All websites')));
    const binding=f.commands.find(c=>c.method==='Runtime.addBinding');assert.equal(binding.params.executionContextName,'supermux-control');
    assert.equal(f.commands.find(c=>c.method==='Page.addScriptToEvaluateOnNewDocument').params.worldName,'supermux-control');
    f.chrome.debugger.onEvent.emit({tabId:7},'Runtime.bindingCalled',{name:binding.params.name,payload:'stop'});
    await until(()=>f.detaches.length===1);await until(()=>f.saved.controlSessions.length===0);assert.equal((await f.service.status(7)).state,'idle');
  }finally{await f.stop();}
});

test('All websites: an expired binding or a server without scope support never controls',async()=>{
  const expired=allSites({},-5);try{await assert.rejects(expired.start(),e=>e.code==='all_sites_expired');assert.equal(expired.sockets.length,0);}finally{await expired.stop();}
  const old=allSites({ready:frame=>({type:'ready',lease_id:frame.lease_id,connection_id:'c'})});try{await assert.rejects(old.start());assert.equal(old.detaches.length,1);}finally{await old.stop();}
});

test('All websites: the hard expiry ends active control with all_sites_expired',async()=>{
  const f=allSites({ready:frame=>({type:'ready',lease_id:frame.lease_id,connection_id:'c',scope:'all',expires_at:Date.now()+80})});try{
    await f.start();await until(()=>f.detaches.length===1);
    assert.equal(f.records.find(r=>r.type==='stop')?.code,'all_sites_expired');
  }finally{await f.stop();}
});

test('a single-website binding still ends control when the tab leaves its origin',async()=>{
  const f=fixture();try{
    await f.start();f.tab.url='https://other.test/';f.chrome.debugger.onEvent.emit({tabId:7},'Page.frameNavigated',{frame:{id:'main',url:'https://other.test/',loaderId:'x'}});
    await until(()=>f.detaches.length===1);assert.equal(f.records.some(r=>r.type==='navigated'),false);
    const result=await f.service.status(7);assert.equal(result.scope,'origin');
  }finally{await f.stop();}
});
