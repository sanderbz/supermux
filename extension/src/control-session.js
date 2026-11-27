import {createCdpController,CONTROL_ACTIONS} from './control-cdp.js';
import {blockedList,parseSelfHost,refusal} from './sites.js';

const failure=(code,message)=>Object.assign(new Error(message),{code});
const bytes=value=>new TextEncoder().encode(JSON.stringify(value)).length;
const MAX_RESULT=8*1024*1024-4096;

// A timed-out or cancelled batch normally ends at its next await. One stuck in
// Chrome for longer ends control, so a later batch never overlaps it.
const RUN_GRACE_MS=5000;
const BLOCKED_MESSAGE='Browser control ended: agents may not use this website (accounts, payments, banks, government, password managers or Supermux itself)';
const EXPIRED_MESSAGE='The 24-hour All websites pairing expired. Pair again to continue';
const SERVER_STOPS={lease_expired:'Browser control ended after 1 hour without agent activity',revoked:'The connected agent no longer has access',replaced:'Browser control moved to a newer connection',authorization_unverifiable:'Supermux could not verify access',blocked_site:BLOCKED_MESSAGE,all_sites_expired:EXPIRED_MESSAGE};
// The All websites pill on pages outside the paired website lives in an
// isolated world the page cannot reach; its Stop button calls this binding,
// which only that world can see.
export const PILL_WORLD='supermux-control',PILL_BINDING='__supermuxControlStop';
const MAX_TIMER=2147483647;
function pillSource(data){
  return `(()=>{const data=${JSON.stringify(data)};
  const h=location.hostname.toLowerCase().replace(/\.+$/,'');
  if(window.top!==window||location.origin===data.site||data.blocked.some(d=>h===d||h.endsWith('.'+d)))return;
  if(globalThis.__supermuxAllSitesPill){globalThis.__supermuxAllSitesPill.show();return;}
  let host;const render=()=>{if(host?.isConnected||!document.documentElement)return;
   host=document.createElement('div');host.setAttribute('data-supermux-control','');
   host.style.cssText='position:fixed!important;top:14px!important;right:14px!important;z-index:2147483647!important;pointer-events:auto!important';
   const root=host.attachShadow({mode:'closed'});
   root.innerHTML='<style>:host{all:initial;color-scheme:light;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#283329}.pill{display:flex;align-items:center;gap:10px;padding:7px 7px 7px 12px;background:#fff7f4f2;border:1px solid #e9b8a6;border-radius:14px;box-shadow:0 7px 30px #12231220}strong{display:block;font-weight:600;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}small{display:block;margin-top:3px;color:#a2402a;font-weight:600}button{font:inherit;cursor:pointer;border:0;min-height:34px;padding:0 12px;border-radius:9px;background:#f2e8df;color:#7b4e37;font-weight:550}</style><div class="pill"><div><strong></strong><small></small></div><button type="button">Stop</button></div>';
   root.querySelector('strong').textContent=data.label;root.querySelector('small').textContent=data.scope;
   root.querySelector('button').addEventListener('click',event=>{if(event.isTrusted&&typeof globalThis.${PILL_BINDING}==='function')globalThis.${PILL_BINDING}('stop');});
   document.documentElement.append(host);};
  globalThis.__supermuxAllSitesPill={show(){if(host)host.hidden=false;render();},hide(v){if(host)host.hidden=!!v;},remove(){host?.remove();host=null;}};
  if(document.documentElement)render();else document.addEventListener('DOMContentLoaded',render,{once:true});})();`;
}
const untilText=ms=>new Date(ms).toLocaleString([],{weekday:'short',hour:'2-digit',minute:'2-digit'});

export function createControlService({chrome:c,getConfig,WebSocketClass=globalThis.WebSocket,runGraceMs=RUN_GRACE_MS}) {
  if(!c.debugger||!WebSocketClass)return {supported:false,show:async()=>{},hideUi:async()=>{},connectionChanged:async()=>{},status:async()=>null,handle:async()=>{throw new Error('Browser control requires Chrome 125 or newer.');}};
  const sessions=new Map(),shown=new Set(),intents=new Map(),endings=new Map();
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
    return binding?{server:config.origin,epoch:config.epoch||'',site,bindingId:binding.id,token:binding.token,scope:binding.scope==='all'?'all':'origin',expiresAt:binding.scope==='all'&&Number.isFinite(binding.expires_at)?binding.expires_at*1000:null}:null;
  }
  function same(a,b){return !!a&&!!b&&['server','epoch','site','bindingId','token','scope','expiresAt'].every(key=>a[key]===b[key]);}
  // null when the session may act on `url`, else the failure to raise. An
  // origin binding stays on its exact website; an All websites binding goes
  // anywhere http(s) except blocked sites, until its hard expiry.
  function refusalFor(session,url){
    const a=session.authority,changed=()=>failure('authority_changed','The website or connected agent changed. Allow control again.');
    if(a.scope!=='all'){try{return url&&new URL(url).origin===a.site?null:changed();}catch{return changed();}}
    if(session.blockedSite)return failure('blocked_site',BLOCKED_MESSAGE+'.');
    const expiresAt=Math.min(a.expiresAt||0,session.expiresAt??Infinity);
    if(!expiresAt||Date.now()>=expiresAt)return failure('all_sites_expired',EXPIRED_MESSAGE+'.');
    const why=url?refusal(url,session.blocked):'invalid';
    return why==='blocked'?failure('blocked_site',BLOCKED_MESSAGE+'.'):why?failure('authority_changed','This page cannot be controlled. Allow control again on a regular website.'):null;
  }
  const urlOf=(session,tab)=>tab?.url||(session.authority.scope==='all'?session.url:undefined);
  function blocklist(session,ready){
    const list=blockedList(ready),own=parseSelfHost(new URL(session.authority.server).host);
    if(own)list.hosts.push(own);return list;
  }
  async function persist(){await c.storage.session.set({controlSessions:[...sessions.values()].map(s=>({tabId:s.tabId,origin:s.authority.site,bindingId:s.authority.bindingId,leaseId:s.leaseId}))});}
  async function ensure(session,run) {
    if(sessions.get(session.tabId)!==session||session.stopped||intents.get(session.tabId)!==session.intent||run?.cancelled)throw failure('control_stopped','Browser control stopped.');
    const [tab,config]=await Promise.all([c.tabs.get(session.tabId),getConfig()]);
    if(!same(session.authority,identity(config,session.authority.site)))throw failure('authority_changed','The website or connected agent changed. Allow control again.');
    // Without a host permission Chrome hides a foreign tab's URL; an All
    // websites session then uses the URL its attached debugger reported.
    const refused=refusalFor(session,urlOf(session,tab))||(session.authority.scope==='all'&&tab.pendingUrl?refusalFor(session,tab.pendingUrl):null);
    if(refused){if(refused.code==='blocked_site')session.blockedSite=true;throw refused;}
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
    await ready;const tab=await c.tabs.get(tabId),config=await getConfig(),session=sessions.get(tabId);
    let origin=null;try{origin=tab.url?new URL(tab.url).origin:null;}catch{}
    const binding=session?config?.bindings?.[session.authority.site]:origin?config?.bindings?.[origin]:null;
    const all=binding?.scope==='all';
    return {supported:true,paired:!!binding,state:session?.state||'idle',site:origin,session:binding?.session,session_label:binding?.session_label,company_label:binding?.company_label,scope:all?'all':'origin',expires_at:all&&Number.isFinite(binding.expires_at)?binding.expires_at*1000:null,lease_expires_at:session?.state==='active'?session.leaseExpiresAt??null:null,error:session?.error||(session?null:endings.get(tabId))||null};
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
  async function stop(session,reason='Stopped by you',refreshUrl=false,code){
    if(!session||session.stopped)return;
    session.stopped=true;session.state='stopping';if(session.run)session.run.cancelled=true;
    if(reason!=='Stopped by you')endings.set(session.tabId,reason);
    clearInterval(session.heartbeat);clearTimeout(session.authTimer);clearTimeout(session.run?.timer);clearTimeout(session.run?.grace);clearTimeout(session.expiryTimer);
    session.rejectReady?.(failure('control_stopped',reason));session.rejectReady=null;
    try{write(session,{type:'stop',reason,...(code?{code}:{})});}catch{}
    try{session.socket?.close(1000,'Control stopped');}catch{}
    // Take the All websites pill off the page, never on a blocked site.
    if(session.pillContext&&!session.blockedSite)try{await Promise.race([c.debugger.sendCommand({tabId:session.tabId},'Runtime.evaluate',{expression:'globalThis.__supermuxAllSitesPill?.remove()',contextId:session.pillContext}),new Promise(r=>setTimeout(r,500))]);}catch{}
    try{await c.debugger.detach({tabId:session.tabId});}catch{}
    if(refreshUrl)try{await updateTabCache(session.tabId,session.authority);}catch{}
    if(sessions.get(session.tabId)===session){sessions.delete(session.tabId);await persist();await notify(session.tabId);}
  }
  function abandon(session,run,code){
    if(run.cancelled)return;run.cancelled=true;run.cancelCode=code;
    run.grace=setTimeout(()=>{if(session.run===run)void stop(session,code==='timeout'?'A timed-out browser action did not finish':'A cancelled browser action did not finish');},runGraceMs);
  }
  async function execute(session,frame){
    if(typeof frame.id!=='string'||!/^[\w-]{1,100}$/.test(frame.id))return;
    if(session.run){write(session,{type:'result',id:frame.id,origin:session.authority.site,ok:false,completed:0,results:[],error:{code:'busy',message:'This tab is already running a batch.'}});return;}
    if(!Array.isArray(frame.steps)||frame.steps.length<1||frame.steps.length>32||frame.steps.some(step=>!step||!CONTROL_ACTIONS.has(step.action))||!Number.isInteger(frame.timeout_ms??30000)||(frame.timeout_ms??30000)<1||(frame.timeout_ms??30000)>30000){
      write(session,{type:'result',id:frame.id,origin:session.authority.site,ok:false,completed:0,results:[],error:{code:'invalid_action',message:'Invalid browser batch.'}});return;
    }
    const run={id:frame.id,cancelled:false,completed:0,results:[],deadline:Date.now()+(frame.timeout_ms??30000)};
    session.run=run;
    if(Number.isFinite(frame.lease_expires_at)){const minute=Math.floor(frame.lease_expires_at/60000)!==Math.floor((session.leaseExpiresAt||0)/60000);session.leaseExpiresAt=frame.lease_expires_at;if(minute)void notify(session.tabId);}
    // A timeout ends this batch only; control stays connected.
    run.timer=setTimeout(()=>abandon(session,run,'timeout'),frame.timeout_ms??30000);
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
    }catch(e){
      error=run.cancelCode&&e.code==='control_stopped'?{code:run.cancelCode,message:run.cancelCode==='timeout'?'The batch timed out. Browser control is still connected; inspect the page before trying again.':'The batch was cancelled. Browser control is still connected; inspect the page before trying again.'}
        :{code:e.code||'action_failed',message:String(e.message||'Browser action failed.').slice(0,2000)};
    }
    finally{
      clearTimeout(run.timer);clearTimeout(run.grace);
      if(session.run===run)session.run=null;
    }
    if(session.stopped||sessions.get(session.tabId)!==session)return;
    try{
      const tab=await ensure(session);
      write(session,{type:'result',id:run.id,origin:new URL(urlOf(session,tab)).origin,ok:!error,completed:run.completed,results:run.results,...(error?{error,outcome_unknown:!!run.mayHaveActed}:{})});
    }catch(e){await stopFor(session,e,'Browser control authority changed');}
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
    endings.delete(tab.id);
    const session={tabId:tab.id,intent,authority,leaseId:crypto.randomUUID(),state:'starting',stopped:false,run:null,currentOrigin:site,url:current.url};
    session.blocked=blocklist(session,null);
    const refused=refusalFor(session,current.url);if(refused)throw refused;
    sessions.set(tab.id,session);
    session.cdp=createCdpController({origin:site,navigable:url=>{const refused=refusalFor(session,url);return refused?(refused.code==='blocked_site'?'blocked_site':'origin_changed'):null;},check:()=>{
      if(session.stopped||sessions.get(tab.id)!==session||session.run?.cancelled)throw failure('control_stopped','Browser control stopped.');
      if(session.blockedSite)throw failure('blocked_site',BLOCKED_MESSAGE+'.');
    },send:async(method,params={},sessionId)=>{
      const run=session.run;await ensure(session,run);
      if(run?.mutationStep&&(/^(Input\.|Page\.(navigate|reload|handleJavaScriptDialog)|DOM\.(focus|scrollIntoViewIfNeeded))/.test(method)||method==='Runtime.evaluate'))run.mayHaveActed=true;
      const result=await c.debugger.sendCommand({tabId:tab.id,...(sessionId?{sessionId}:{})},method,params);
      await ensure(session,run);return result;
    },onMainNavigation:url=>{
      if(authority.scope==='all'){session.url=url;observe(session,url);return;}
      try{if(new URL(url).origin!==site)void stop(session,'The tab left the paired website');}catch{void stop(session,'The tab left the paired website');}
    },hideUi:async hidden=>{
      await hideUi(tab.id,hidden);
      if(session.pillContext)try{await c.debugger.sendCommand({tabId:tab.id},'Runtime.evaluate',{expression:`globalThis.__supermuxAllSitesPill?.hide(${!!hidden})`,contextId:session.pillContext});}catch{}
    }});
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
          // An All websites binding needs the server to agree on the scope.
          if(authority.scope==='all'&&(message.scope!=='all'||!Number.isFinite(message.expires_at))){void stop(session,'This Supermux server does not support All websites control');return;}
          if(authority.scope!=='all'&&message.scope!==undefined&&message.scope!=='origin'){void stop(session,'Browser control authentication failed');return;}
          if(authority.scope==='all'){
            session.blocked=blocklist(session,message);
            session.expiresAt=Math.min(authority.expiresAt,message.expires_at);
            session.expiryTimer=setTimeout(()=>{void stop(session,EXPIRED_MESSAGE,false,'all_sites_expired');},Math.max(0,Math.min(MAX_TIMER,session.expiresAt-Date.now())));
            void installPill(session);
          }
          session.state='active';session.connectionId=message.connection_id;session.leaseExpiresAt=Number.isFinite(message.lease_expires_at)?message.lease_expires_at:null;clearTimeout(session.authTimer);
          session.heartbeat=setInterval(()=>{try{write(session,{type:'ping'});void ensure(session).catch(e=>stopFor(session,e,'Browser connection changed'));}catch{void stop(session,'Browser connection lost');}},20000);
          session.resolveReady?.();session.resolveReady=null;session.rejectReady=null;void notify(tab.id);return;
        }
        if(message.type==='ping'){write(session,{type:'pong'});return;}
        if(message.type==='pong')return;
        if(message.type==='stop'){void stop(session,SERVER_STOPS[message.reason]||'The agent stopped browser control');return;}
        // Cancelling ends that batch only; control stays connected.
        if(message.type==='cancel'){if(session.run?.id===message.id)abandon(session,session.run,'cancelled');return;}
        if(message.type==='command')void execute(session,message);
      };
      socket.onclose=()=>{void stop(session,'Browser connection lost');};
      socket.onerror=()=>{void stop(session,'Could not reach Supermux browser control');};
      await connected;await ensure(session);return status(tab.id);
    }catch(e){await stop(session,e.message);throw e;}
  }
  // Ends a session for a failed check, carrying blocked_site / expiry codes.
  function stopFor(session,e,fallback){
    if(e?.code==='blocked_site')return stop(session,BLOCKED_MESSAGE,false,'blocked_site');
    if(e?.code==='all_sites_expired')return stop(session,EXPIRED_MESSAGE,false,'all_sites_expired');
    return stop(session,fallback);
  }
  // All websites: every top-level navigation is checked against the blocklist
  // (no CDP command is sent after landing on a blocked site) and each origin
  // change is reported to the server, which writes the audit log.
  function observe(session,url){
    if(session.stopped)return;
    const refused=refusalFor(session,url);
    if(refused){if(refused.code==='blocked_site')session.blockedSite=true;void stopFor(session,refused,'The tab left the allowed websites');return;}
    const origin=new URL(url).origin;
    if(origin!==session.currentOrigin){session.currentOrigin=origin;try{write(session,{type:'navigated',origin});}catch{}}
  }
  async function installPill(session){
    const send=(method,params)=>c.debugger.sendCommand({tabId:session.tabId},method,params);
    try{
      await ensure(session);
      const binding=(await getConfig())?.bindings?.[session.authority.site];
      const source=pillSource({blocked:session.blocked.sites,site:session.authority.site,label:binding?.session_label||binding?.session||'Your agent',scope:`All websites · until ${untilText(session.expiresAt??session.authority.expiresAt)}`});
      await send('Runtime.addBinding',{name:PILL_BINDING,executionContextName:PILL_WORLD});
      await send('Page.addScriptToEvaluateOnNewDocument',{source,worldName:PILL_WORLD});
      await ensure(session);
      const {frameTree}=await send('Page.getFrameTree');session.mainFrameId=frameTree.frame.id;
      const {executionContextId}=await send('Page.createIsolatedWorld',{frameId:frameTree.frame.id,worldName:PILL_WORLD});
      session.pillContext=executionContextId;
      await ensure(session);
      await send('Runtime.evaluate',{expression:source,contextId:executionContextId});
    }catch{}
  }
  c.debugger.onEvent.addListener((source,method,params)=>{
    const session=sessions.get(source.tabId);if(!session||session.stopped)return;
    if(session.authority.scope==='all'&&!source.sessionId){
      if(method==='Runtime.bindingCalled'&&params?.name===PILL_BINDING){intents.set(source.tabId,(intents.get(source.tabId)||0)+1);void stop(session,'Stopped by you',true);return;}
      if(method==='Page.frameNavigated'&&!params?.frame?.parentId)session.mainFrameId=params.frame.id;
      // Stop before a renderer-requested navigation to a blocked site commits.
      if(method==='Page.frameRequestedNavigation'&&params?.frameId===session.mainFrameId&&refusal(params.url,session.blocked)==='blocked'){session.blockedSite=true;void stopFor(session,{code:'blocked_site'});return;}
      if(method==='Runtime.executionContextCreated'&&params?.context?.name===PILL_WORLD&&params.context.auxData?.frameId===session.mainFrameId)session.pillContext=params.context.id;
    }
    session.cdp?.event(method,params,source.sessionId);
  });
  c.debugger.onDetach.addListener(source=>{void stop(sessions.get(source.tabId),'Chrome stopped browser control');});
  c.tabs.onRemoved.addListener(tabId=>{shown.delete(tabId);void stop(sessions.get(tabId),'The tab closed').then(()=>endings.delete(tabId));});
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
    if(session&&change.url&&session.authority.scope==='all'&&session.state==='active')observe(session,change.url);
    if(session&&(change.url||change.status))void ensure(session).catch(e=>stopFor(session,e,'The tab left the paired website'));
    if(change.url&&session?.state==='active'||change.status==='complete'&&(session||shown.has(tabId)))void updateTabCache(tabId,session?.authority,change.status==='complete').catch(()=>{});
  });
  c.permissions.onRemoved?.addListener(()=>{void Promise.all([...sessions.values()].map(s=>ensure(s).catch(()=>stop(s,'Server access removed'))));});
  async function connectionChanged(){await ready;for(const session of [...sessions.values()])try{await ensure(session);}catch{await stop(session,'The connected agent changed');}for(const id of shown)await notify(id);}
  async function handle(type,tab,sender){
    if(type==='control.status')return status(tab.id);
    if(type==='control.start'){if(sessions.has(tab.id))return status(tab.id);const intent=(intents.get(tab.id)||0)+1;intents.set(tab.id,intent);return serialized(()=>start(tab,sender,intent));}
    if(type==='control.stop'){intents.set(tab.id,(intents.get(tab.id)||0)+1);endings.delete(tab.id);await stop(sessions.get(tab.id),'Stopped by you',true);return status(tab.id);}
    throw new Error('Unknown browser control action.');
  }
  return {supported:true,show,hideUi,status,handle,connectionChanged};
}
