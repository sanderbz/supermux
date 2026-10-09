import {createControlService} from './control-session.js';
import {endpointOrigin, permissionFor, safeUrl, validateFeedback} from './shared.js';
const storage=chrome.storage.local;
void storage.setAccessLevel({accessLevel:'TRUSTED_CONTEXTS'});
const config = async()=> (await storage.get('connection')).connection;
const controls=createControlService({chrome,getConfig:config});
let connectionQueue=Promise.resolve();
function trusted(fn){const next=connectionQueue.then(fn);connectionQueue=next.catch(()=>{});return next;}
function mutateConnection(fn){return trusted(async()=>{const result=await fn(await config());if(result===null)await storage.remove('connection');else await storage.set({connection:result});await controls.connectionChanged();return result;});}
const extensionPage = sender => sender.id===chrome.runtime.id && sender.url?.split('?')[0]===chrome.runtime.getURL('options.html');
const publicBinding=b=>b?{id:b.id,origin:b.origin,session:b.session,session_label:b.session_label,company_id:b.company_id,company_label:b.company_label}:null;
const publicConnection=(c,site)=>c?{origin:c.origin,site,control_enabled:controls.supported,paired:!!c.bindings?.[site],session:c.bindings?.[site]?.session,session_label:c.bindings?.[site]?.session_label,company_id:c.bindings?.[site]?.company_id,company_label:c.bindings?.[site]?.company_label}:null;
const websiteOrigin=value=>{const url=new URL(value);if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.origin!==value)throw new Error('Choose a regular website to pair.');return url.origin;};
async function api(origin,path,token,body){
 const granted=await chrome.permissions.contains({origins:[permissionFor(origin)]});
 if(!granted) throw new Error('Server access is missing. Open connection settings to reconnect.');
 let response;
 try {response=await fetch(origin+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(token?{Authorization:`Bearer ${token}`}:{})},...(body?{body:JSON.stringify(body)}:{}),credentials:'omit',redirect:'error',signal:AbortSignal.timeout(20000)});}catch{throw new Error('Could not reach Supermux. Your draft is saved. Check that your server and Tailscale are connected.');}
 const update='Update Supermux on this server to a version with browser feedback support, and check that this is the correct server address.';
 const contentType=response.headers?.get?.('content-type')||'';
 if(contentType.includes('text/html'))throw new Error(`The server returned a web page instead of the browser feedback API (HTTP ${response.status}). ${update}`);
 if([404,405].includes(response.status))throw Object.assign(new Error(`The browser feedback API was not found on this server (HTTP ${response.status}). ${update}`),{status:response.status});
 let result;try{result=await response.json();}catch{if(path==='/api/browser/feedback'&&response.status===422)throw new Error('This server could not read the screenshot context (HTTP 422). Update Supermux to accept numbered screenshots and crop context, then retry. Your draft is saved.');throw new Error(`The server returned an invalid browser feedback response. ${update}`);}
 if(!result||typeof result.ok!=='boolean'||(result.ok&&!Object.hasOwn(result,'data')))throw new Error(`The server response is missing the browser feedback API envelope. ${update}`);
 if(!response.ok||!result.ok){const detail=result.error?.message||result.error||`Server error (${response.status}).`;throw Object.assign(new Error(path==='/api/browser/feedback'&&/unknown field|deserialize|invalid json/i.test(detail)?`${detail} Update Supermux to accept numbered screenshots and crop context, then retry. Your draft is saved.`:detail),{status:response.status});}
 return result.data;
}
async function authorized(sender){
 if(!sender.tab?.id) throw new Error('Open annotation from the extension toolbar.');
 const state=await chrome.storage.session.get('annotationTabs');
 if(state.annotationTabs?.[sender.tab.id]!==sender.tab.url) throw new Error('This page changed. Click the extension icon again.');
 return sender.tab;
}
async function draftKey(url){return 'draft:'+Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(url)))).map(v=>v.toString(16).padStart(2,'0')).join('');}
let draftQueue=Promise.resolve();
function drafts(fn){const next=draftQueue.then(fn);draftQueue=next.catch(()=>{});return next;}
const byteSize=value=>new TextEncoder().encode(JSON.stringify(value)).length;
// Store repeated crop pixels once while preserving each crop's own metadata.
function packDraft(draft){
 const images=[],indices=new Map();
 function visit(value,key){
  if(typeof value==='string'&&(key==='data_base64'||key==='preview'&&value.startsWith('data:image/png;base64,'))){const preview=key==='preview',data=preview?value.slice(22):value;if(!indices.has(data)){indices.set(data,images.length);images.push(data);}return {image:indices.get(data),...(preview?{data_url:true}:{})};}
  if(Array.isArray(value))return value.map(v=>visit(v));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,k)]));
  return value;
 }
 return {format:1,draft:visit(draft),images,at:Date.now()};
}
function unpackDraft(saved){
 if(saved?.format!==1)return saved?.draft;
 function visit(value,key){
  if(value&&typeof value==='object'&&Number.isInteger(value.image)&&['data_base64','preview'].includes(key)){const image=saved.images[value.image];if(typeof image!=='string')throw new Error('Saved screenshot is unavailable. Capture it again.');return value.data_url?'data:image/png;base64,'+image:image;}
  if(Array.isArray(value))return value.map(v=>visit(v));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,visit(v,k)]));
  return value;
 }
 return visit(saved.draft);
}
async function saveDraft(key,draft){
 if(!draft||typeof draft!=='object')throw new Error('Invalid draft.');
 const saved=packDraft(draft),size=byteSize(saved);
 if(size>48*1024*1024)throw new Error('Your latest changes could not be saved: this draft is too large. Keep this page open and retake its screenshot before retrying.');
 const all=await storage.get(null),older=Object.entries(all).filter(([k])=>k.startsWith('draft:')&&k!==key).sort((a,b)=>(b[1].at||0)-(a[1].at||0));
 let total=size;const prune=[];
 for(const [k,v] of older){const bytes=byteSize(v);if(Date.now()-(v.at||0)>7*86400000||total+bytes>80*1024*1024)prune.push(k);else total+=bytes;}
 try{await storage.set({[key]:saved});}catch{throw new Error('Your latest changes could not be saved to browser storage. Keep this page open and retry; your previous saved draft is preserved.');}
 if(prune.length)await storage.remove(prune);
 return true;
}
let captureQueue=Promise.resolve(),lastCapture=0;
async function capture(tab){const run=captureQueue.then(async()=>{const wait=Math.max(0,550-(Date.now()-lastCapture));if(wait)await new Promise(resolve=>setTimeout(resolve,wait));lastCapture=Date.now();return performCapture(tab);});captureQueue=run.catch(()=>{});return run;}
async function performCapture(tab){
 const original=await chrome.tabs.get(tab.id);
 let prepared=false;
 try{
  const active=(await chrome.tabs.query({active:true,windowId:tab.windowId}))[0];
  if(active?.id!==tab.id||original.url!==tab.url) throw new Error('Return to the page you are annotating before capturing.');
  prepared=true;
  const metadata=await chrome.tabs.sendMessage(tab.id,{type:'capture.prepare'});
  if(!metadata?.viewport) throw new Error('Page capture is unavailable. Reopen the extension.');
  const current=(await chrome.tabs.query({active:true,windowId:tab.windowId}))[0];
  if(current?.id!==tab.id||current.url!==original.url) throw new Error('The active page changed. Capture cancelled.');
  await controls.hideUi(tab.id,true);
  const dataUrl=await chrome.tabs.captureVisibleTab(tab.windowId,{format:'png'});
  const after=(await chrome.tabs.query({active:true,windowId:tab.windowId}))[0];
  if(after?.id!==tab.id||after.url!==original.url) throw new Error('The active page changed. Capture cancelled.');
  const valid=await chrome.tabs.sendMessage(tab.id,{type:'capture.validate',viewport:metadata.viewport,nonce:metadata.nonce});
  if(!valid)throw new Error('The viewport moved during capture. Please capture again.');
  return {dataUrl,...metadata};
 }finally{await controls.hideUi(tab.id,false);if(prepared) await chrome.tabs.sendMessage(tab.id,{type:'capture.restore'}).catch(()=>{});}
}
// A send retains its original destination, including when its response was
// lost and this website is subsequently paired with another agent. This trusted
// ledger stores no images and never leaves the worker. Never evict uncertain
// attempts: a missing authority must not silently acquire a new destination.
async function feedbackAuthority(tab,payload){
 const site=new URL(tab.url).origin,hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(payload))))).map(v=>v.toString(16).padStart(2,'0')).join('');
 return trusted(async()=>{
  const c=await config(),all=(await storage.get('feedbackAttempts')).feedbackAttempts||{};
  const saved=all[payload.client_id];
  if(saved){
   if(saved.site!==site||saved.hash!==hash||saved.origin!==c?.origin||saved.epoch!==(c?.epoch||'')||!saved.binding?.token)throw new Error('This feedback belongs to an earlier connection. Capture again to create a new send.');
   return saved;
  }
  const binding=c?.bindings?.[site];if(!binding)throw new Error('Connect this website to a Supermux chat first.');
  if(Object.keys(all).length>=2048)throw new Error('Browser feedback recovery storage is full. Your draft is saved; no new send was started.');
  const authority={origin:c.origin,epoch:c.epoch||'',site,hash,binding:{...publicBinding(binding),token:binding.token},at:Date.now()};
  const next={...all,[payload.client_id]:authority};
  if(byteSize(next)>4*1024*1024)throw new Error('Browser feedback recovery storage is full. Your draft is saved.');
  await storage.set({feedbackAttempts:next});return authority;
 });
}
async function rememberReceipt(clientId,receipt){
 return trusted(async()=>{const all=(await storage.get('feedbackAttempts')).feedbackAttempts||{};if(!all[clientId])throw new Error('Feedback recovery context is unavailable.');all[clientId]={...all[clientId],receipt_id:receipt.id};await storage.set({feedbackAttempts:all});});
}
const receiptTarget=(receipt,authority)=>({...receipt,target:publicBinding(authority.binding)});
async function handle(message,sender){
 const {type}=message||{};
 if(type?.startsWith('connection.')||type==='pair.start'||type==='pair.poll'||type==='pair.confirm'){
  if(!extensionPage(sender)) throw new Error('This action is only available in extension settings.');
  if(type==='connection.get'){const c=await config(),p=c?.pending?.[message.site];return {...publicConnection(c,message.site),pending:p?{id:p.id,code:p.code,expires_at:p.expires_at,candidate:publicBinding(p.candidate)}:null};}
  if(type==='connection.configure'){const origin=endpointOrigin(message.origin);if(!await chrome.permissions.contains({origins:[permissionFor(origin)]}))throw new Error('Grant server access first.');await mutateConnection(c=>c?.origin===origin?c:{origin,epoch:crypto.randomUUID(),bindings:{},pending:{}});return publicConnection(await config(),message.site);}
  if(type==='connection.clear'){await mutateConnection(()=>null);return true;}
  if(type==='pair.start'){
   const c=await config();if(!c?.origin)throw new Error('Connect your server first.');const site=websiteOrigin(message.site);
   const p=await api(c.origin,'/api/browser/pairings',null,{origin:site});
   await mutateConnection(latest=>{if(latest?.origin!==c.origin||(latest?.epoch||'')!==(c.epoch||''))throw new Error('The server connection changed. Try again.');return {...latest,pending:{...latest.pending,[site]:p}};});
   return {id:p.id,code:p.code,expires_at:p.expires_at};
  }
  const c=await config(),site=websiteOrigin(message.site),pending=c?.pending?.[site];if(!pending) throw new Error('Create a new pairing code.');
  if(type==='pair.confirm'){
   if(c.origin!==message.server_origin||pending.id!==message.id||pending.candidate?.id!==message.binding_id||pending.candidate?.origin!==site)throw new Error('The pairing changed. Review a new code before connecting.');
   // Verify the proposed binding still exists before the user's explicit action
   // promotes it. Recheck local state after the network await as well.
   const verified=await api(c.origin,`/api/browser/pairings/${encodeURIComponent(pending.id)}`,pending.poll_token);
   const b=verified.binding;
   if(verified.status!=='paired'||b?.id!==pending.candidate.id||b.origin!==site||b.session!==pending.candidate.session||b.company_id!==pending.candidate.company_id)throw new Error('This pairing is no longer available. Create a new code.');
   await mutateConnection(latest=>{
    const current=latest?.pending?.[site];
    if(latest?.origin!==c.origin||(latest?.epoch||'')!==(c.epoch||'')||current?.id!==pending.id||current.candidate?.id!==pending.candidate.id)throw new Error('The pairing changed. Review a new code before connecting.');
    const nextPending={...latest.pending};delete nextPending[site];
    return {...latest,pending:nextPending,bindings:{...latest.bindings,[site]:{...b,token:b.token||current.candidate.token}}};
   });
   return publicConnection(await config(),site);
  }

  const p=await api(c.origin,`/api/browser/pairings/${encodeURIComponent(pending.id)}`,pending.poll_token);
  if(p.status==='paired'){
   if(p.binding?.origin!==site)throw new Error('The pairing does not match this website.');
   if(!p.binding?.session) throw new Error('The pairing response is incomplete.');
   await mutateConnection(latest=>{if(latest?.origin!==c.origin||(latest?.epoch||'')!==(c.epoch||'')||latest.pending?.[site]?.id!==pending.id)throw new Error('The pairing changed. Create a new code.');return {...latest,pending:{...latest.pending,[site]:{...latest.pending[site],candidate:{...p.binding,token:p.binding.token||pending.poll_token}}}};});
  }
  return p.status==='paired'?{status:'awaiting-confirmation',id:pending.id,server_origin:c.origin,binding:publicBinding(p.binding)}:{status:p.status};
 }
 // Stop only removes this tab's grant, including during navigation/revocation.
 if(type==='control.stop'&&sender.tab?.id)return controls.handle(type,sender.tab,sender);
 const tab=await authorized(sender);
 if(type?.startsWith('control.'))return controls.handle(type,tab,sender);
 if(type==='draft.load'){await controls.show(tab);if(message.connection_only)return {connection:publicConnection(await config(),new URL(tab.url).origin)};const key=await draftKey(tab.url);const saved=await drafts(async()=>(await storage.get(key))[key]);return {draft:unpackDraft(saved),connection:publicConnection(await config(),new URL(tab.url).origin)};}
 if(type==='draft.save'){
  const key=await draftKey(tab.url);return drafts(()=>saveDraft(key,message.draft));
 }
 if(type==='draft.clear'){const key=await draftKey(tab.url);await drafts(()=>storage.remove(key));return true;}
 if(type==='settings.open'){await chrome.tabs.create({url:chrome.runtime.getURL('options.html')+'?site='+encodeURIComponent(new URL(tab.url).origin)});return true;}
 if(type==='capture') return await capture(tab);
 if(type==='feedback.submit'){
  const payload=validateFeedback(message.payload);
  if(payload.url!==safeUrl(tab.url)) throw new Error('The page changed. Capture the current page again.');
  const authority=await feedbackAuthority(tab,payload);
  const receipt=await api(authority.origin,'/api/browser/feedback',authority.binding.token,payload);
  await rememberReceipt(payload.client_id,receipt);
  const key=await draftKey(tab.url);await drafts(()=>storage.remove(key));return receiptTarget(receipt,authority);
 }
 if(type==='feedback.status'){
  if(!message.id||message.id.length>100)throw new Error('Feedback status unavailable.');
  const authority=await trusted(async()=>{
   const c=await config(),all=(await storage.get('feedbackAttempts')).feedbackAttempts||{};
   const saved=Object.values(all).find(value=>value.receipt_id===message.id&&value.site===new URL(tab.url).origin);
   if(!saved||saved.origin!==c?.origin||saved.epoch!==(c?.epoch||'')||!saved.binding?.token)throw Object.assign(new Error('This feedback belongs to an earlier connection. Check its original chat for delivery.'),{code:'feedback-context-lost'});
   return saved;
  });
  return receiptTarget(await api(authority.origin,`/api/browser/feedback/${encodeURIComponent(message.id)}`,authority.binding.token),authority);
 }
 throw new Error('Unknown extension action.');
}
chrome.runtime.onMessage.addListener((message,sender,reply)=>{handle(message,sender).then(data=>reply({ok:true,data}),error=>reply({ok:false,error:error.message||'Something went wrong.',status:error.status,code:error.code}));return true;});
async function activate(tab){
 if(!tab?.id||!/^https?:\/\//.test(tab.url||'')){await chrome.action.setBadgeText({tabId:tab?.id,text:'!'});await chrome.action.setTitle({tabId:tab?.id,title:'Open a regular website to annotate it.'});return;}
 const {annotationTabs={}}=await chrome.storage.session.get('annotationTabs');annotationTabs[tab.id]=tab.url;await chrome.storage.session.set({annotationTabs});
 try{await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});}catch{await chrome.action.setBadgeText({tabId:tab.id,text:'!'});await chrome.action.setTitle({tabId:tab.id,title:'Chrome prevents annotation on this page.'});}
}
chrome.action.onClicked.addListener(activate);
chrome.commands.onCommand.addListener(async command=>{if(command==='annotate')await activate((await chrome.tabs.query({active:true,currentWindow:true}))[0]);});
chrome.tabs.onRemoved.addListener(async id=>{const {annotationTabs={}}=await chrome.storage.session.get('annotationTabs');delete annotationTabs[id];await chrome.storage.session.set({annotationTabs});});
