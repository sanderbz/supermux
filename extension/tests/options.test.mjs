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
