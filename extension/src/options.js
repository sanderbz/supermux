import {endpointOrigin,permissionFor} from './shared.js';
const $=id=>document.getElementById(id);
let timer,flow=0,confirmation=null,renewals=0;
const site=new URL(location.href).searchParams.get('site');
if(site){const context=document.createElement('p');context.className='hint';context.textContent='Pairing website: '+site;$('connect').prepend(context);}
else $('connect-button').textContent='Save server';
async function request(type,extra={}){const r=await chrome.runtime.sendMessage({type,site,...extra});if(!r?.ok)throw Object.assign(new Error(r?.error||'Extension unavailable.'),{status:r?.status});return r.data;}
const status=message=>$('status').textContent=message;
const agentLabel=c=>c.session_label&&c.session_label!==c.session?`${c.session_label} (${c.session})`:c.session;
function connected(c){
 clearTimeout(timer);confirmation=null;$('confirmation').hidden=true;$('pairing').hidden=true;$('connect').hidden=true;$('connected').hidden=false;
 $('session').textContent=agentLabel(c);$('connected-company').textContent=c.company_label||'';
 $('connected-site').textContent=site?`Feedback from ${site} goes to this agent.`:'Open a website and click the Supermux extension icon to start.';
 $('change-agent').hidden=!site;$('endpoint').value=c.origin||$('endpoint').value;status('');
}
function proposed(p){
 clearTimeout(timer);confirmation=p;$('pairing').hidden=true;$('connect').hidden=true;$('connected').hidden=true;$('confirmation').hidden=false;
 $('confirm-site').textContent=p.binding.origin;$('confirm-target').textContent=(p.binding.company_label?p.binding.company_label+' · ':'')+agentLabel(p.binding);status('');
}
function pairing(p){confirmation=null;$('confirmation').hidden=true;$('connected').hidden=true;$('connect').hidden=true;$('pairing').hidden=false;$('code').textContent=p.code;void poll(flow);}
async function poll(version){
 try{const p=await request('pair.poll');if(version!==flow)return;
  if(p.status==='awaiting-confirmation'){proposed(p);return;}
  if(p.status!=='pending'){await refreshExpired();return;}
  timer=setTimeout(()=>poll(version),2500);
 }catch(e){if(version!==flow)return;if([404,410].includes(e.status)||/pairing.*expired|code.*expired/i.test(e.message)){await refreshExpired();return;}status(e.message);$('retry-pairing').hidden=false;}
}
async function refreshExpired(){if(renewals++<1){await newCode(true);}else{status('This pairing code is no longer available. Create a new one.');$('retry-pairing').hidden=false;}}
async function newCode(automatic=false){
 if(!automatic)renewals=0;const version=++flow;clearTimeout(timer);$('retry-pairing').hidden=true;status('');
 try{const p=await request('pair.start');if(version!==flow)return;pairing(p);}catch(e){if(version===flow){status(e.message);$('retry-pairing').hidden=false;$('connect').hidden=false;}}
}
$('connect').addEventListener('submit',async event=>{
 event.preventDefault();const version=++flow;clearTimeout(timer);status('');
 let origin;try{origin=endpointOrigin($('endpoint').value.trim());}catch(e){status(e.message);return;}
 // Request from the user's explicit form action, before any asynchronous work.
 const permission=chrome.permissions.request({origins:[permissionFor(origin)]});
 $('connect-button').disabled=true;
 try{if(!await permission)throw new Error('Server access was not granted. Click Connect to try again.');await request('connection.configure',{origin});$('change-server').hidden=false;$('disconnect').hidden=false;if(version!==flow)return;if(site){const p=await request('pair.start');if(version===flow)pairing(p);}else status('Server saved. Open a website and click the extension icon to pair it with a chat.');}catch(e){if(version===flow)status(e.message);}finally{$('connect-button').disabled=false;}
});
$('confirm').addEventListener('click',async()=>{
 if(!confirmation||$('confirm').disabled)return;
 const version=flow,p=confirmation;$('confirm').disabled=true;status('');
 try{const c=await request('pair.confirm',{id:p.id,binding_id:p.binding.id,server_origin:p.server_origin});if(version===flow)connected(c);}catch(e){if(version===flow){status(e.message);$('retry-pairing').hidden=false;}}finally{$('confirm').disabled=false;}
});
$('retry-pairing').addEventListener('click',()=>void newCode());
$('change-server').addEventListener('click',()=>{$('connect').hidden=false;$('endpoint').focus();});
$('change-agent').addEventListener('click',()=>void newCode());
$('new-code').addEventListener('click',()=>void newCode());
$('copy').addEventListener('click',async()=>{await navigator.clipboard.writeText($('code').textContent);$('copy').textContent='Copied';setTimeout(()=>$('copy').textContent='Copy code',1500);});
$('disconnect').addEventListener('click',async()=>{
 const version=++flow;clearTimeout(timer);
 try{const c=await request('connection.get');await request('connection.clear');if(c.origin)await chrome.permissions.remove({origins:[permissionFor(c.origin)]});if(version!==flow)return;confirmation=null;$('change-server').hidden=true;$('disconnect').hidden=true;$('confirmation').hidden=true;$('connected').hidden=true;$('pairing').hidden=true;$('connect').hidden=false;status('Disconnected. Your page drafts are still saved.');}catch(e){if(version===flow){status(e.message);$('retry-pairing').hidden=false;$('connect').hidden=false;}}
});
request('connection.get').then(async c=>{
 if(c?.origin){$('endpoint').value=c.origin;$('change-server').hidden=false;$('disconnect').hidden=false;}
 if(c?.pending?.candidate)proposed({id:c.pending.id,server_origin:c.origin,binding:c.pending.candidate});
 else if(c?.pending)pairing(c.pending);
 else if(c?.paired)connected(c);
 else if(site&&c?.origin&&await chrome.permissions.contains({origins:[permissionFor(c.origin)]}))await newCode();
}).catch(e=>status(e.message));
