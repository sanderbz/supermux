import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {JSDOM} from '../../web/node_modules/jsdom/lib/api.js';
import {endpointOrigin,permissionFor} from '../src/shared.js';

const html=await readFile(new URL('../src/options.html',import.meta.url),'utf8');
const script=(await readFile(new URL('../src/options.js',import.meta.url),'utf8')).replace(/^import[^\n]*\n/,'');
const settle=()=>new Promise(resolve=>setTimeout(resolve,20));
test('saved-server setup starts automatically and requires explicit target confirmation; changing agent keeps server',async()=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example',runScripts:'outside-only'});
 const w=dom.window,calls=[];let generation=0;
 w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
 w.chrome={permissions:{contains:async()=>true,request:async()=>true},runtime:{sendMessage:async m=>{
  calls.push(m);let data;
  if(m.type==='connection.get')data={origin:'https://server.example',paired:false};
  if(m.type==='pair.start')data={id:'pair-'+(++generation),code:'1234'};
  if(m.type==='pair.poll')data={status:'awaiting-confirmation',id:'pair-'+generation,server_origin:'https://server.example',binding:{id:'binding-'+generation,origin:'https://site.example',session:'agent-'+generation,session_label:'Shared label',company_label:'Company '+generation}};
  if(m.type==='pair.confirm')data={origin:'https://server.example',paired:true,session:'agent-'+generation,session_label:'Shared label',company_label:'Company '+generation};
  return {ok:true,data};
 }}};
 w.eval(script);await settle();
 assert.deepEqual(calls.map(c=>c.type),['connection.get','pair.start','pair.poll']);
 assert.equal(w.document.getElementById('connect').hidden,true);
 assert.equal(w.document.getElementById('confirmation').hidden,false);
 assert.equal(w.document.getElementById('connected').hidden,true);
 assert.equal(w.document.getElementById('confirm-site').textContent,'https://site.example');
 assert.equal(w.document.getElementById('confirm-target').textContent,'Company 1 · Shared label (agent-1)');
 w.document.getElementById('confirm').click();await settle();
 assert.deepEqual(JSON.parse(JSON.stringify(calls.at(-1))),{type:'pair.confirm',site:'https://site.example',id:'pair-1',binding_id:'binding-1',server_origin:'https://server.example'});
 assert.equal(w.document.getElementById('connected').hidden,false);
 w.document.getElementById('change-agent').click();await settle();
 assert.equal(calls.filter(c=>c.type==='pair.start').length,2);
 assert.equal(calls.some(c=>c.type==='connection.clear'||c.type==='connection.configure'),false);
 assert.equal(w.document.getElementById('confirm-target').textContent,'Company 2 · Shared label (agent-2)');
 dom.window.close();
});
test('permission missing never auto-grants or starts pairing without the user',async()=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example',runScripts:'outside-only'});
 const w=dom.window,calls=[];let grants=0;
 w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
 w.chrome={permissions:{contains:async()=>false,request:async()=>{grants++;return false;}},runtime:{sendMessage:async m=>{calls.push(m);return {ok:true,data:{origin:'https://server.example',paired:false}};}}};
 w.eval(script);await settle();
 assert.equal(grants,0);assert.deepEqual(calls.map(c=>c.type),['connection.get']);
 assert.equal(w.document.getElementById('connect').hidden,false);
 w.document.getElementById('connect').dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));await settle();
 assert.equal(grants,1);assert.deepEqual(calls.map(c=>c.type),['connection.get']);
 assert.match(w.document.getElementById('status').textContent,/access was not granted/);
 dom.window.close();
});
test('an expired saved code renews once without showing the server form or looping on network errors',async()=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example',runScripts:'outside-only'});
 const w=dom.window,calls=[];let polls=0;
 w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
 w.chrome={permissions:{contains:async()=>true},runtime:{sendMessage:async m=>{
  calls.push(m);
  if(m.type==='connection.get')return {ok:true,data:{origin:'https://server.example',pending:{id:'old',code:'1234'}}};
  if(m.type==='pair.start')return {ok:true,data:{id:'new',code:'5678'}};
  if(m.type==='pair.poll')return ++polls===1?{ok:false,status:410,error:'Pairing expired'}:{ok:false,error:'Could not reach Supermux.'};
 }}};
 w.eval(script);await settle();await settle();
 assert.deepEqual(calls.map(c=>c.type),['connection.get','pair.poll','pair.start','pair.poll']);
 assert.equal(w.document.getElementById('connect').hidden,true);
 assert.equal(w.document.getElementById('code').textContent,'5678');
 assert.equal(w.document.getElementById('retry-pairing').hidden,false);
 const count=calls.length;await new Promise(resolve=>setTimeout(resolve,70));assert.equal(calls.length,count);
 dom.window.close();
});
test('after a claimed code one primary click connects and allows control, still showing agent and exact origin',async()=>{
 for(const choice of ['confirm','confirm-only']){
  const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example&from=nonce-1',runScripts:'outside-only'});
  const w=dom.window,calls=[];
  w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
  w.chrome={permissions:{contains:async()=>true,request:async()=>true},runtime:{sendMessage:async m=>{
   calls.push(m);let data;
   if(m.type==='connection.get')data={origin:'https://server.example',paired:false};
   if(m.type==='pair.start')data={id:'pair-1',code:'1234'};
   if(m.type==='pair.poll')data={status:'awaiting-confirmation',id:'pair-1',server_origin:'https://server.example',control_tab:true,binding:{id:'binding-1',origin:'https://site.example',session:'agent-1',session_label:'Release agent',company_label:'Company'}};
   if(m.type==='pair.confirm')data={origin:'https://server.example',paired:true,session:'agent-1',session_label:'Release agent',company_label:'Company',...(m.allow_control?{control:{state:'active'}}:{})};
   return {ok:true,data};
  }}};
  w.eval(script);await settle();
  const $=id=>w.document.getElementById(id);
  assert.equal($('confirmation').hidden,false);
  assert.equal($('confirm-site').textContent,'https://site.example');
  assert.equal($('confirm-target').textContent,'Company · Release agent (agent-1)');
  assert.equal($('confirm-title').textContent,'Connect and allow control?');
  assert.equal($('confirm').textContent,'Connect and allow control');
  assert.equal($('confirm-control').hidden,false);assert.match($('confirm-control').textContent,/tab you started from on https:\/\/site\.example/);
  assert.equal($('confirm-only').hidden,false);
  assert.ok(calls.every(c=>c.from==='nonce-1'),'the settings page forwards only the worker-issued nonce');
  $(choice).click();await settle();
  const sent=JSON.parse(JSON.stringify(calls.at(-1)));
  assert.deepEqual(sent,{type:'pair.confirm',site:'https://site.example',from:'nonce-1',id:'pair-1',binding_id:'binding-1',server_origin:'https://server.example',...(choice==='confirm'?{allow_control:true}:{})});
  assert.equal(calls.filter(c=>c.type==='pair.confirm').length,1,'a single click');
  assert.equal($('connected').hidden,false);
  if(choice==='confirm')assert.match($('connected-site').textContent,/now controls the tab you started from on https:\/\/site\.example/);
  else assert.equal($('connected-site').textContent,'Feedback from https://site.example goes to this agent.');
  dom.window.close();
 }
});
test('without an originating tab the confirmation only connects the website',async()=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example',runScripts:'outside-only'});
 const w=dom.window,calls=[];
 w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
 w.chrome={permissions:{contains:async()=>true},runtime:{sendMessage:async m=>{calls.push(m);return {ok:true,data:m.type==='connection.get'?{origin:'https://server.example',control_tab:false,pending:{id:'pair-1',candidate:{id:'binding-1',origin:'https://site.example',session:'agent-1'}}}:{origin:'https://server.example',paired:true,session:'agent-1'}};}}};
 w.eval(script);await settle();
 const $=id=>w.document.getElementById(id);
 assert.equal($('confirm').textContent,'Connect this website');assert.equal($('confirm-control').hidden,true);assert.equal($('confirm-only').hidden,true);
 $('confirm').click();await settle();
 assert.equal(calls.at(-1).allow_control,undefined);
 dom.window.close();
});
test('All websites needs the red confirmation step before an All websites pairing is requested',async()=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example',runScripts:'outside-only'});
 const w=dom.window,calls=[],$=id=>w.document.getElementById(id);let generation=0;
 w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
 w.chrome={permissions:{contains:async()=>true},runtime:{sendMessage:async m=>{
  calls.push(m);let data;
  if(m.type==='connection.get')data={origin:'https://server.example',paired:false};
  if(m.type==='pair.start')data={id:'pair-'+(++generation),code:m.scope==='all'?'9999':'1234',scope:m.scope==='all'?'all':'origin'};
  if(m.type==='pair.poll')data={status:'pending'};
  return {ok:true,data};
 }}};
 w.eval(script);await settle();
 const starts=()=>calls.filter(c=>c.type==='pair.start');
 assert.equal(starts().length,1);assert.equal(starts()[0].scope,undefined,'This website is the default');
 assert.equal($('scope-site').getAttribute('aria-pressed'),'true');assert.equal($('all-sites-warning').hidden,true);
 // Choosing All websites only shows the red warning; nothing is sent.
 $('scope-all').click();await settle();
 assert.equal($('all-sites-warning').hidden,false);assert.equal($('code-step').hidden,true);
 assert.match($('all-sites-warning').textContent,/any website.*logged-in accounts.*24 hours.*except blocked sites/s);
 assert.equal(starts().length,1);
 // Backing out keeps this website only.
 $('cancel-all').click();await settle();
 assert.equal($('all-sites-warning').hidden,true);assert.equal(starts().length,1);assert.equal($('code').textContent,'1234');
 // The second, explicit click sends the All websites request.
 $('scope-all').click();await settle();$('confirm-all').click();await settle();
 assert.equal(starts().length,2);assert.equal(starts()[1].scope,'all');
 assert.equal($('code').textContent,'9999');assert.match($('code-scope').textContent,/All websites/);
 assert.equal($('scope-all').getAttribute('aria-pressed'),'true');
 // The red button does nothing unless the warning is showing.
 $('confirm-all').click();await settle();assert.equal(starts().length,2);
 // Back to This website requests a single-website code again.
 $('scope-site').click();await settle();assert.equal(starts().length,3);assert.equal(starts()[2].scope,undefined);
 dom.window.close();
});
test('an All websites proposal is shown in red with its expiry before the consent click',async()=>{
 const dom=new JSDOM(html,{url:'https://extension.test/options.html?site=https%3A%2F%2Fsite.example',runScripts:'outside-only'});
 const w=dom.window,$=id=>w.document.getElementById(id);
 w.endpointOrigin=endpointOrigin;w.permissionFor=permissionFor;
 w.chrome={permissions:{contains:async()=>true},runtime:{sendMessage:async m=>{
  if(m.type==='connection.get')return {ok:true,data:{origin:'https://server.example',pending:{id:'p',code:'1',scope:'all',candidate:{id:'b',origin:'https://site.example',session:'agent',scope:'all',expires_at:Math.floor(Date.now()/1000)+86400}},control_tab:true}};
  return {ok:true,data:{}};
 }}};
 w.eval(script);await settle();
 assert.equal($('confirmation').hidden,false);assert.equal($('confirm-scope').hidden,false);
 assert.match($('confirm-scope').textContent,/All websites · until/);
 assert.equal($('confirm').textContent,'Connect and allow control on all websites');assert.ok($('confirm').classList.contains('danger-button'));
 dom.window.close();
});
