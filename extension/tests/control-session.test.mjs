import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createControlService} from '../src/control-session.js';

const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},emit(...args){for(const fn of this.listeners)fn(...args);}});
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('Expected control lifecycle event');};
function fixture() {
  const site='https://example.test',tab={id:7,url:site+'/page',title:'Fixture'};
  let config={origin:'https://server.test',epoch:'one',bindings:{[site]:{id:'binding-a',token:'private-a',session:'agent-a',company_label:'Company A'}}};
  const records=[],sockets=[],commands=[],detaches=[],saved={},messages=[];
  let command=async method=>method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:tab.url,loaderId:'doc1'}}}:method==='Runtime.evaluate'?{result:{value:'fixture result'}}:{};
  class Socket {
    readyState=0;
    constructor(url){this.url=url;sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
    send(payload){const frame=JSON.parse(payload);records.push(frame);if(frame.type==='auth')queueMicrotask(()=>this.receive({type:'ready',lease_id:frame.lease_id,connection_id:'connection-'+sockets.length}));}
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
  const service=createControlService({chrome,getConfig:async()=>config,WebSocketClass:Socket});
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

test('a timed out lease detaches, and a fresh activation is usable after old CDP completion',async()=>{
  const f=fixture(),held=deferred(),entered=deferred();try{
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
