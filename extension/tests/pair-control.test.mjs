import test from 'node:test';
import assert from 'node:assert/strict';
import {webcrypto} from 'node:crypto';

// One consent click after a claimed code confirms the displayed agent and exact
// origin and starts control on the tab the pairing came from, and nowhere else.
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);}});
const server='https://server.example',site='https://one.example',other='https://two.example';
let generation=0;
async function fixture(){
 const local={},session={},tabs=new Map([[1,{id:1,url:site+'/page',title:'One'}],[2,{id:2,url:other+'/page',title:'Two'}]]);
 const attached=[],created=[],injected=[],activated=[],sockets=[],auths=[];let handler,seq=0;
 const store=map=>({setAccessLevel:async()=>{},get:async key=>key===null?map:{[key]:map[key]},set:async value=>Object.assign(map,value),remove:async key=>{for(const k of [key].flat())delete map[k];}});
 class Socket{
  readyState=0;
  constructor(url){this.url=url;sockets.push(this);queueMicrotask(()=>{this.readyState=1;this.onopen?.();});}
  send(payload){const frame=JSON.parse(payload);if(frame.type==='auth'){auths.push(frame);queueMicrotask(()=>this.onmessage?.({data:JSON.stringify({type:'ready',lease_id:frame.lease_id,connection_id:'connection-'+sockets.length})}));}}
  close(){this.readyState=3;queueMicrotask(()=>this.onclose?.());}
 }
 Object.defineProperty(globalThis,'crypto',{value:webcrypto,configurable:true});
 globalThis.WebSocket=Socket;
 globalThis.chrome={
  runtime:{id:'pair-control',getURL:path=>'chrome-extension://pair-control/'+path,onMessage:{addListener:fn=>handler=fn}},
  storage:{local:store(local),session:store(session)},
  permissions:{contains:async()=>true,onRemoved:event()},
  scripting:{async executeScript({target,files}){injected.push({tabId:target.tabId,files});}},
  tabs:{onRemoved:event(),onUpdated:event(),
   async get(id){const tab=tabs.get(id);if(!tab)throw new Error('No tab with id: '+id);return {...tab};},
   async create(value){created.push(value.url);return {id:99,...value};},
   async update(id,value){activated.push({id,...value});return tabs.get(id);},
   async query(){return [];},
   async sendMessage(_id,message){return message.type==='control.prepare'?{ok:true}:undefined;}},
  debugger:{onEvent:event(),onDetach:event(),async attach(target){attached.push(target.tabId);},async detach(){},
   async sendCommand(_target,method){return method==='Page.getFrameTree'?{frameTree:{frame:{id:'main',url:site+'/page',loaderId:'doc'}}}:{};}},
  action:{onClicked:event(),setBadgeText:async()=>{},setTitle:async()=>{}},commands:{onCommand:event()},
 };
 globalThis.fetch=async(url,init)=>{
  if(url.endsWith('/pairings')){const origin=JSON.parse(init.body).origin,id='pair-'+(++seq);return {ok:true,json:async()=>({ok:true,data:{id,code:'1234',poll_token:'private-poll-'+seq,origin}})};}
  if(url.includes('/pairings/')){const n=url.split('-').at(-1);return {ok:true,json:async()=>({ok:true,data:{status:'paired',binding:{id:'binding-'+n,origin:site,session:'agent-'+n,session_label:'Agent '+n,company_id:1,company_label:'Company',token:'private-binding-'+n}}})};}
  throw new Error('unexpected '+url);
 };
 await import('../src/worker.js?pair-control='+(++generation));
 const options=from=>({id:'pair-control',url:'chrome-extension://pair-control/options.html?site='+encodeURIComponent(site)+(from?'&from='+from:'')});
 const rpc=(type,extra={},sender=options())=>new Promise(resolve=>handler({type,...extra},sender,resolve));
 await rpc('connection.configure',{origin:server});
 session.annotationTabs={1:site+'/page',2:other+'/page'};
 // The page's own connection control opens settings; the worker remembers that tab.
 const opened=await rpc('settings.open',{},{id:'pair-control',tab:{...tabs.get(1)}});
 assert.equal(opened.ok,true);
 const from=new URL(created.at(-1)).searchParams.get('from');
 assert.match(from,/^[0-9a-f-]{36}$/);
 const begin=async(origin=site)=>{assert.equal((await rpc('pair.start',{site:origin,from})).ok,true);const polled=await rpc('pair.poll',{site:origin,from});assert.equal(polled.data.status,'awaiting-confirmation');return polled.data;};
 return {local,session,tabs,attached,created,injected,activated,sockets,auths,rpc,from,begin,options};
}

test('one click confirms the shown agent and origin and starts control on the originating tab',async()=>{
 const f=await fixture();
 const proposal=await f.begin();
 // The confirmation still shows exactly which agent and which origin, and that control is offered.
 assert.equal(proposal.binding.origin,site);assert.equal(proposal.binding.session,'agent-1');assert.equal(proposal.binding.session_label,'Agent 1');
 assert.equal(proposal.control_tab,true);
 assert.equal((await f.rpc('connection.get',{site,from:f.from})).data.control_tab,true);
 assert.equal(JSON.stringify(proposal).includes('private-'),false);
 assert.deepEqual(f.attached,[],'nothing is armed before the consent click');
 const confirmed=await f.rpc('pair.confirm',{site,from:f.from,id:proposal.id,binding_id:proposal.binding.id,server_origin:server,allow_control:true});
 assert.equal(confirmed.ok,true,confirmed.error);
 assert.equal(confirmed.data.paired,true);assert.equal(confirmed.data.session,'agent-1');
 assert.deepEqual(confirmed.data.control,{state:'active'});
 assert.deepEqual(f.attached,[1],'debugger attached to the originating tab only');
 assert.equal(f.auths.length,1);assert.equal(f.auths[0].origin,site);assert.equal(f.auths[0].binding_id,'binding-1');assert.equal(f.auths[0].token,'private-binding-1');
 assert.ok(f.injected.some(i=>i.tabId===1&&i.files.includes('control-ui.js')),'the Stop pill is shown on that tab');
 assert.deepEqual(f.activated,[{id:1,active:true}]);
 assert.equal(JSON.stringify(confirmed).includes('private-'),false);
 // The arming nonce is single-use: it cannot start control a second time.
 assert.equal((await f.rpc('connection.get',{site,from:f.from})).data.control_tab,false);
 // The pill stays the one-click path for later reconnects.
 const status=await f.rpc('control.status',{},{id:'pair-control',tab:{...f.tabs.get(1)},frameId:0,url:site+'/page'});
 assert.equal(status.data.state,'active');
 await f.rpc('control.stop',{},{id:'pair-control',tab:{...f.tabs.get(1)},frameId:0,url:site+'/page'});
});

test('a tab that navigated away is not armed; the binding is still confirmed',async()=>{
 const f=await fixture();
 const proposal=await f.begin();
 f.tabs.set(1,{id:1,url:other+'/elsewhere',title:'Elsewhere'});
 assert.equal((await f.rpc('connection.get',{site,from:f.from})).data.control_tab,false);
 const confirmed=await f.rpc('pair.confirm',{site,from:f.from,id:proposal.id,binding_id:proposal.binding.id,server_origin:server,allow_control:true});
 assert.equal(confirmed.ok,true,confirmed.error);
 assert.equal(confirmed.data.paired,true);
 assert.equal(confirmed.data.control.state,'idle');assert.match(confirmed.data.control.message,/no longer on https:\/\/one\.example/);
 assert.deepEqual(f.attached,[]);assert.equal(f.sockets.length,0);
});

test('a closed originating tab, a hand-opened settings page, or Connect without control never arms a tab',async()=>{
 {
  const f=await fixture();const proposal=await f.begin();f.tabs.delete(1);
  const confirmed=await f.rpc('pair.confirm',{site,from:f.from,id:proposal.id,binding_id:proposal.binding.id,server_origin:server,allow_control:true});
  assert.equal(confirmed.ok,true);assert.equal(confirmed.data.control.state,'idle');assert.deepEqual(f.attached,[]);
 }
 {
  // Without the worker-issued nonce there is no originating tab to control.
  const f=await fixture();assert.equal((await f.rpc('pair.start',{site})).ok,true);const polled=await f.rpc('pair.poll',{site});
  assert.equal(polled.data.control_tab,false);
  const forged=await f.rpc('pair.confirm',{site,from:'00000000-0000-4000-8000-000000000000',id:polled.data.id,binding_id:polled.data.binding.id,server_origin:server,allow_control:true});
  assert.equal(forged.ok,true);assert.equal(forged.data.control.state,'idle');assert.deepEqual(f.attached,[]);
 }
 {
  const f=await fixture();const proposal=await f.begin();
  const confirmed=await f.rpc('pair.confirm',{site,from:f.from,id:proposal.id,binding_id:proposal.binding.id,server_origin:server});
  assert.equal(confirmed.ok,true);assert.equal(confirmed.data.control,undefined);assert.deepEqual(f.attached,[]);
  assert.equal((await f.rpc('connection.get',{site,from:f.from})).data.control_tab,false,'the nonce is spent by Connect without control');
 }
 {
  // A page cannot ask the worker to confirm and arm on its own.
  const f=await fixture();const proposal=await f.begin();
  const fromPage=await f.rpc('pair.confirm',{site,from:f.from,id:proposal.id,binding_id:proposal.binding.id,server_origin:server,allow_control:true},{id:'pair-control',tab:{...f.tabs.get(1)}});
  assert.equal(fromPage.ok,false);assert.deepEqual(f.attached,[]);
 }
});
