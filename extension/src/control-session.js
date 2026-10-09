import {createCdpController,CONTROL_ACTIONS} from './control-cdp.js';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const MAX_RESULT=8*1024*1024-4096;

export function createControlService({chrome:c,getConfig,WebSocketClass=globalThis.WebSocket}) {
  if(!c.debugger||!WebSocketClass)return {supported:false,show:async()=>{},hideUi:async()=>{},connectionChanged:async()=>{},status:async()=>null,handle:async()=>{throw new Error('Browser control requires Chrome 125 or newer.');}};
  const sessions=new Map(),shown=new Set(),intents=new Map();
  let lifecycle=Promise.resolve(),tabUpdates=Promise.resolve();
  function serialized(fn){const next=lifecycle.then(fn);lifecycle=next.catch(()=>{});return next;}
  const ready=(async()=>{
    const {controlSessions=[]}=await c.storage.session.get('controlSessions');
    // A worker restart never silently revives a previous control grant.
    for(const previous of controlSessions)try{await c.debugger.detach({tabId:previous.tabId});}catch{}
    await c.storage.session.set({controlSessions:[]});
  })();
  function identity(config,site){
    const binding=config?.bindings?.[site];
    return binding?{server:config.origin,epoch:config.epoch||'',site,bindingId:binding.id,token:binding.token}:null;
  }
  function same(a,b){return !!a&&!!b&&['server','epoch','site','bindingId','token'].every(key=>a[key]===b[key]);}
  async function persist(){await c.storage.session.set({controlSessions:[...sessions.values()].map(s=>({tabId:s.tabId,origin:s.authority.site,bindingId:s.authority.bindingId,leaseId:s.leaseId}))});}
  async function ensure(session,run) {
    if(sessions.get(session.tabId)!==session||session.stopped||intents.get(session.tabId)!==session.intent||run?.cancelled)throw failure('control_stopped','Browser control stopped.');
    const [tab,config]=await Promise.all([c.tabs.get(session.tabId),getConfig()]);
    if(!tab.url||new URL(tab.url).origin!==session.authority.site||!same(session.authority,identity(config,session.authority.site)))throw failure('authority_changed','The website or connected agent changed. Allow control again.');
    if(!await c.permissions.contains({origins:[session.authority.server+'/*']}))throw failure('authority_changed','Server access was removed.');
    if(sessions.get(session.tabId)!==session||session.stopped||intents.get(session.tabId)!==session.intent||run?.cancelled)throw failure('control_stopped','Browser control stopped.');
    return tab;
  }
  function write(session,frame){
    if(session.socket?.readyState!==1)return false;
    const payload=JSON.stringify(frame);if(new TextEncoder().encode(payload).length>8*1024*1024)throw failure('result_too_large','Browser result exceeds the transport limit.');
    session.socket.send(payload);return true;
  }
  async function status(tabId){
    await ready;const tab=await c.tabs.get(tabId),config=await getConfig(),binding=tab.url?config?.bindings?.[new URL(tab.url).origin]:null;
    const session=sessions.get(tabId);
    return {supported:true,paired:!!binding,state:session?.state||'idle',site:tab.url?new URL(tab.url).origin:null,session:binding?.session,session_label:binding?.session_label,company_label:binding?.company_label,error:session?.error||null};
  }
  async function notify(tabId){try{await c.tabs.sendMessage(tabId,{type:'control.changed',state:await status(tabId)});}catch{}}
  async function show(tab){
    await ready;
    if(!tab?.id||!tab.url||!/^https?:/.test(tab.url))return;
    const config=await getConfig();
    if(!config?.bindings?.[new URL(tab.url).origin])return;
    await c.scripting.executeScript({target:{tabId:tab.id},files:['control-ui.js']});shown.add(tab.id);await notify(tab.id);
  }
  async function hideUi(tabId,hidden){try{await c.tabs.sendMessage(tabId,{type:'control.capture',hidden});}catch{}}
  async function stop(session,reason='Stopped by you',refreshUrl=false){
    if(!session||session.stopped)return;
    session.stopped=true;session.state='stopping';if(session.run)session.run.cancelled=true;
    clearInterval(session.heartbeat);clearTimeout(session.authTimer);clearTimeout(session.run?.timer);
    session.rejectReady?.(failure('control_stopped',reason));session.rejectReady=null;
    try{write(session,{type:'stop',reason});}catch{}
    try{session.socket?.close(1000,'Control stopped');}catch{}
    try{await c.debugger.detach({tabId:session.tabId});}catch{}
    if(refreshUrl)try{await updateTabCache(session.tabId,session.authority);}catch{}
    if(sessions.get(session.tabId)===session){sessions.delete(session.tabId);await persist();await notify(session.tabId);}
  }
  async function execute(session,frame){
    if(typeof frame.id!=='string'||!/^[\w-]{1,100}$/.test(frame.id))return;
    if(session.run){write(session,{type:'result',id:frame.id,origin:session.authority.site,ok:false,completed:0,results:[],error:{code:'busy',message:'This tab is already running a batch.'}});return;}
    if(!Array.isArray(frame.steps)||frame.steps.length<1||frame.steps.length>32||frame.steps.some(step=>!step||!CONTROL_ACTIONS.has(step.action))||!Number.isInteger(frame.timeout_ms??30000)||(frame.timeout_ms??30000)<1||(frame.timeout_ms??30000)>30000){
      write(session,{type:'result',id:frame.id,origin:session.authority.site,ok:false,completed:0,results:[],error:{code:'invalid_action',message:'Invalid browser batch.'}});return;
    }
    const run={id:frame.id,cancelled:false,completed:0,results:[],deadline:Date.now()+(frame.timeout_ms??30000)};
    session.run=run;
    run.timer=setTimeout(()=>{run.cancelled=true;void stop(session,'Browser action timed out');},frame.timeout_ms??30000);
    let error;
    try{
      for(const step of frame.steps){
        await ensure(session,run);
        run.mutationStep=['click','type','fill','key','scroll','navigate','back','reload','evaluate','dialog'].includes(step.action);run.mayHaveActed=false;
        const value=await session.cdp.execute(step,run.deadline);
        await ensure(session,run);run.completed++;
        write(session,{type:'progress',id:run.id,completed:run.completed});
        const candidate=[...run.results,value];
        if(bytes(candidate)>MAX_RESULT)throw failure('result_too_large','Batch output exceeds 8 MiB. Request fewer images or smaller results.');
        run.results=candidate;
      }
    }catch(e){error={code:e.code||'action_failed',message:String(e.message||'Browser action failed.').slice(0,2000)};}
    finally{
      clearTimeout(run.timer);
      if(session.run===run)session.run=null;
    }
    if(session.stopped||sessions.get(session.tabId)!==session)return;
    try{
      const tab=await ensure(session);
      write(session,{type:'result',id:run.id,origin:new URL(tab.url).origin,ok:!error,completed:run.completed,results:run.results,...(error?{error,outcome_unknown:!!run.mayHaveActed}:{})});
    }catch{await stop(session,'Browser control authority changed');}
  }
  async function start(tab,sender,intent){
    await ready;
    if(sender.frameId!==undefined&&sender.frameId!==0)throw failure('wrong_tab','Allow control from the top-level website.');
    const current=await c.tabs.get(tab.id);
    if(!current.url||current.url!==tab.url||(sender.url&&new URL(sender.url).origin!==new URL(current.url).origin))throw failure('wrong_tab','This page changed. Click the extension icon again.');
    const site=new URL(current.url).origin,config=await getConfig(),authority=identity(config,site);
    if(!authority?.bindingId||!authority.token)throw failure('not_paired','Connect this website to an agent first.');
    if(intents.get(tab.id)!==intent)throw failure('control_stopped','Browser control stopped.');
    if(sessions.has(tab.id))return status(tab.id);
    const session={tabId:tab.id,intent,authority,leaseId:crypto.randomUUID(),state:'starting',stopped:false,run:null};
    sessions.set(tab.id,session);
    session.cdp=createCdpController({origin:site,check:()=>{
      if(session.stopped||sessions.get(tab.id)!==session||session.run?.cancelled)throw failure('control_stopped','Browser control stopped.');
    },send:async(method,params={},sessionId)=>{
      const run=session.run;await ensure(session,run);
      if(run?.mutationStep&&(/^(Input\.|Page\.(navigate|reload|handleJavaScriptDialog)|DOM\.(focus|scrollIntoViewIfNeeded))/.test(method)||method==='Runtime.evaluate'))run.mayHaveActed=true;
      const result=await c.debugger.sendCommand({tabId:tab.id,...(sessionId?{sessionId}:{})},method,params);
      await ensure(session,run);return result;
    },onMainNavigation:url=>{
      try{if(new URL(url).origin!==site)void stop(session,'The tab left the paired website');}catch{void stop(session,'The tab left the paired website');}
    },hideUi:hidden=>hideUi(tab.id,hidden)});
    try{
      await persist();await notify(tab.id);await ensure(session);
      // Hide annotation editing before awaiting storage; the retained editor DOM is saved by prepare.
      const prepared=await c.tabs.sendMessage(tab.id,{type:'control.prepare'},{frameId:0});
      if(prepared?.ok!==true)throw failure('draft_not_saved',prepared?.error||'Your annotation draft could not be saved. Try Allow control again.');
      await ensure(session);
      clearTimeout(session.authTimer);session.authTimer=setTimeout(()=>{void stop(session,'Browser control initialization timed out');},10000);
      await ensure(session);await c.debugger.attach({tabId:tab.id},'1.3');await ensure(session);
      await session.cdp.initialize();
      const endpoint=new URL('/api/browser/control/ws',authority.server);endpoint.protocol=endpoint.protocol==='https:'?'wss:':'ws:';
      const socket=session.socket=new WebSocketClass(endpoint.href);
      const connected=new Promise((resolve,reject)=>{session.resolveReady=resolve;session.rejectReady=reject;});
      clearTimeout(session.authTimer);session.authTimer=setTimeout(()=>{void stop(session,'Could not connect browser control');},5000);
      socket.onopen=async()=>{
        try{const actual=await ensure(session);write(session,{type:'auth',version:1,token:authority.token,binding_id:authority.bindingId,lease_id:session.leaseId,origin:site,url:actual.url,title:actual.title||''});}
        catch{void stop(session,'Browser connection changed');}
      };
      socket.onmessage=event=>{
        if(session.stopped)return;
        if(typeof event.data!=='string'||new TextEncoder().encode(event.data).length>8*1024*1024){void stop(session,'Invalid browser control frame');return;}
        let message;try{message=JSON.parse(event.data);}catch{void stop(session,'Invalid browser control frame');return;}
        if(session.state==='starting'){
          if(message.type!=='ready'||message.lease_id!==session.leaseId||typeof message.connection_id!=='string'||message.connection_id.length>128){void stop(session,'Browser control authentication failed');return;}
          session.state='active';session.connectionId=message.connection_id;clearTimeout(session.authTimer);
          session.heartbeat=setInterval(()=>{try{write(session,{type:'ping'});void ensure(session).catch(()=>stop(session,'Browser connection changed'));}catch{void stop(session,'Browser connection lost');}},20000);
          session.resolveReady?.();session.resolveReady=null;session.rejectReady=null;void notify(tab.id);return;
        }
        if(message.type==='ping'){write(session,{type:'pong'});return;}
        if(message.type==='pong')return;
        if(message.type==='stop'){void stop(session,'The agent stopped browser control');return;}
        if(message.type==='cancel'){if(session.run?.id===message.id){session.run.cancelled=true;void stop(session,'Browser action cancelled');}return;}
        if(message.type==='command')void execute(session,message);
      };
      socket.onclose=()=>{void stop(session,'Browser connection lost');};
      socket.onerror=()=>{void stop(session,'Could not reach Supermux browser control');};
      await connected;await ensure(session);return status(tab.id);
    }catch(e){await stop(session,e.message);throw e;}
  }
  c.debugger.onEvent.addListener((source,method,params)=>{
    const session=sessions.get(source.tabId);if(session&&!session.stopped)session.cdp?.event(method,params,source.sessionId);
  });
  c.debugger.onDetach.addListener(source=>{void stop(sessions.get(source.tabId),'Chrome stopped browser control');});
  c.tabs.onRemoved.addListener(tabId=>{shown.delete(tabId);void stop(sessions.get(tabId),'The tab closed');});
  function updateTabCache(tabId,authority,showOnComplete=false){
    // Serialize control-navigation writes and read current URL at execution time.
    const next=tabUpdates.then(async()=>{
      const stored=await c.storage.session.get('annotationTabs');
      const [tab,config]=await Promise.all([c.tabs.get(tabId),getConfig()]);
      if(!tab.url)return;
      if(authority&&(new URL(tab.url).origin!==authority.site||!same(authority,identity(config,authority.site))))return;
      if(authority&&!await c.permissions.contains({origins:[authority.server+'/*']}))return;
      const [latest,latestConfig]=await Promise.all([c.tabs.get(tabId),getConfig()]);
      if(!latest.url||new URL(latest.url).origin!==new URL(tab.url).origin)return;
      if(authority&&!same(authority,identity(latestConfig,authority.site)))return;
      await c.storage.session.set({annotationTabs:{...stored.annotationTabs,[tabId]:latest.url}});
      if(showOnComplete)await show(latest);
    });
    tabUpdates=next.catch(()=>{});return next;
  }
  c.tabs.onUpdated.addListener((tabId,change)=>{
    const session=sessions.get(tabId);
    if(session&&(change.url||change.status))void ensure(session).catch(()=>stop(session,'The tab left the paired website'));
    if(change.url&&session?.state==='active'||change.status==='complete'&&(session||shown.has(tabId)))void updateTabCache(tabId,session?.authority,change.status==='complete').catch(()=>{});
  });
  c.permissions.onRemoved?.addListener(()=>{void Promise.all([...sessions.values()].map(s=>ensure(s).catch(()=>stop(s,'Server access removed'))));});
  async function connectionChanged(){await ready;for(const session of [...sessions.values()])try{await ensure(session);}catch{await stop(session,'The connected agent changed');}for(const id of shown)await notify(id);}
  async function handle(type,tab,sender){
    if(type==='control.status')return status(tab.id);
    if(type==='control.start'){if(sessions.has(tab.id))return status(tab.id);const intent=(intents.get(tab.id)||0)+1;intents.set(tab.id,intent);return serialized(()=>start(tab,sender,intent));}
    if(type==='control.stop'){intents.set(tab.id,(intents.get(tab.id)||0)+1);await stop(sessions.get(tab.id),'Stopped by you',true);return status(tab.id);}
    throw new Error('Unknown browser control action.');
  }
  return {supported:true,show,hideUi,status,handle,connectionChanged};
}
