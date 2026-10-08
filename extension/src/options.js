import {endpointOrigin,permissionFor} from './shared.js';
const $=id=>document.getElementById(id);
let timer;
const site=new URL(location.href).searchParams.get('site');
if(site){const context=document.createElement('p');context.className='hint';context.textContent='Pairing website: '+site;$('connect').prepend(context);}
else $('connect-button').textContent='Save server';
async function request(type,extra={}){const r=await chrome.runtime.sendMessage({type,site,...extra});if(!r?.ok)throw new Error(r?.error||'Extension unavailable.');return r.data;}
const status=message=>$('status').textContent=message;
function connected(c){clearTimeout(timer);$('pairing').hidden=true;$('connect').hidden=true;$('connected').hidden=false;$('session').textContent=c.session_label||c.session;$('endpoint').value=c.origin||$('endpoint').value;$('disconnect').textContent='Reset server';status('');}
function pairing(p){$('pairing').hidden=false;$('code').textContent=p.code;poll();}
async function poll(){try{const p=await request('pair.poll');if(p.status==='paired'){connected(p);return;}if(p.status!=='pending'){status('This code has expired. Connect again to create a new one.');return;}timer=setTimeout(poll,2500);}catch(e){status(e.message);timer=setTimeout(poll,7000);}}
$('connect').addEventListener('submit',async event=>{
 event.preventDefault();clearTimeout(timer);status('');
 let origin;try{origin=endpointOrigin($('endpoint').value.trim());}catch(e){status(e.message);return;}
 // Request from the user's explicit form action, before any asynchronous work.
 const permission=chrome.permissions.request({origins:[permissionFor(origin)]});
 $('connect-button').disabled=true;
 try{if(!await permission)throw new Error('Server access was not granted. Click Connect to try again.');await request('connection.configure',{origin});if(site){const p=await request('pair.start');pairing(p);}else status('Server saved. Open a website and click the extension icon to pair it with a chat.');}catch(e){status(e.message);}finally{$('connect-button').disabled=false;}
});
$('copy').addEventListener('click',async()=>{await navigator.clipboard.writeText($('code').textContent);$('copy').textContent='Copied';setTimeout(()=>$('copy').textContent='Copy code',1500);});
$('disconnect').addEventListener('click',async()=>{const c=await request('connection.get');await request('connection.clear');if(c.origin)await chrome.permissions.remove({origins:[permissionFor(c.origin)]});$('connected').hidden=true;$('connect').hidden=false;status('Disconnected. Your page drafts are still saved.');});
request('connection.get').then(c=>{if(c?.origin)$('endpoint').value=c.origin;if(c?.paired)connected(c);else if(c?.pending)pairing(c.pending);}).catch(e=>status(e.message));
