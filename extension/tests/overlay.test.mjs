import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {webcrypto} from 'node:crypto';
import {JSDOM} from '../../web/node_modules/jsdom/lib/api.js';
test('overlay picks safe DOM context, edits, draws, captures visible content without masks, and freezes viewport',async()=>{
 const dom=new JSDOM('<!doctype html><title>Demo</title><main><h1>Build a better homepage</h1><p id="copy">Public copy <input value="secret" type="password"><span data-private>Visible account</span><span hidden>Hidden account</span><textarea>old default</textarea><select><option>hidden option</option></select></p><iframe src="https://private.example"></iframe></main>',{url:'https://demo.example/path?secret=value',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;let listener;const messages=[];w.chrome={runtime:{id:'test',sendMessage:async m=>{messages.push(m);return{ok:true,data:m.type==='draft.load'?{connection:{session:'Claude'}}:true};},onMessage:{addListener:f=>listener=f}}};w.CSS={escape:s=>s};Object.defineProperty(w,'crypto',{value:webcrypto});
 const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){return attach.call(this,{...options,mode:'open'});};w.Element.prototype.getBoundingClientRect=function(){return{x:100,y:120,left:100,top:120,right:300,bottom:200,width:200,height:80};};
 w.eval(await readFile(new URL('../dist/content.js',import.meta.url),'utf8'));await new Promise(r=>setTimeout(r,20));
 const shadow=w.document.querySelector('[data-supermux-overlay]').shadowRoot;
 assert.equal(shadow.querySelectorAll('[data-mode]').length,3);assert.equal(shadow.querySelector('.bar-message'),null);
 w.document.querySelector('#copy').dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
 assert.equal(shadow.querySelector('.pin').textContent,'1');const area=shadow.querySelector('.editor textarea');area.value='Make this clearer';area.dispatchEvent(new w.Event('input',{bubbles:true}));
 shadow.querySelector('[data-action="done"]').click();await new Promise(r=>setTimeout(r,5));
 const rpc=(type,extra={})=>new Promise(resolve=>listener({type,...extra},{id:'test'},resolve));
 const capture=await rpc('capture.prepare');assert.equal(capture.annotations[0].element.text,'Public copy Visible account');assert.equal(capture.url,'https://demo.example/path?secret=value');assert.equal(capture.annotations[0].text,'Make this clearer');assert.equal(shadow.querySelectorAll('.privacy-mask').length,0);assert.ok(w.document.querySelector('[data-supermux-overlay]').classList.contains('capturing'));
 assert.equal(await rpc('capture.validate',{nonce:capture.nonce,viewport:capture.viewport}),true);
 assert.equal(await rpc('capture.validate',{nonce:'other',viewport:capture.viewport}),false);
 w.dispatchEvent(new w.Event('scroll'));assert.equal(await rpc('capture.validate',{nonce:capture.nonce,viewport:capture.viewport}),false);
 await rpc('capture.restore');assert.equal(shadow.querySelectorAll('.privacy-mask').length,0);
 shadow.querySelector('[data-mode="draw"]').click();const body=w.document.body;
 body.dispatchEvent(new w.MouseEvent('pointerdown',{clientX:20,clientY:20,bubbles:true,cancelable:true,button:0}));
 body.dispatchEvent(new w.MouseEvent('pointermove',{clientX:100,clientY:80,bubbles:true,cancelable:true}));
 body.dispatchEvent(new w.MouseEvent('pointerup',{clientX:100,clientY:80,bubbles:true,cancelable:true}));
 assert.equal(shadow.querySelectorAll('.pin').length,2);assert.ok(shadow.querySelector('.stroke'));
 w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(shadow.querySelector('.ui').hidden,true);
 w.eval(await readFile(new URL('../dist/content.js',import.meta.url),'utf8'));assert.equal(w.document.querySelectorAll('[data-supermux-overlay]').length,1);assert.equal(shadow.querySelector('.ui').hidden,false);
 await new Promise(r=>setTimeout(r,600));const draft=messages.filter(m=>m.type==='draft.save').at(-1).draft;assert.equal(draft.notes.length,2);assert.equal(JSON.stringify(draft.notes).includes('Hidden account'),false);
 assert.equal(JSON.stringify(draft.notes).includes('old default'),false);assert.equal(JSON.stringify(draft.notes).includes('hidden option'),false);assert.equal(JSON.stringify(draft.notes).includes('secret'),false);
 w.history.pushState({},'', '/different?page=pricing#/plans');w.eval(await readFile(new URL('../dist/content.js',import.meta.url),'utf8'));await new Promise(r=>setTimeout(r,20));assert.equal(shadow.querySelectorAll('.pin').length,0);assert.equal(shadow.querySelector('.ui').hidden,false);dom.window.close();
});
test('review has one connection control, plain copy, and allows visible editable targets without reading their values',async()=>{
 for(const paired of [false,true]){
  const dom=new JSDOM('<main><input id="field" type="password" value="never-extract-this"><p data-private>Visible private-labelled text</p></main>',{url:'https://demo.example',runScripts:'outside-only',pretendToBeVisual:true});
  const w=dom.window;w.CSS={escape:s=>s};Object.defineProperty(w,'crypto',{value:webcrypto});
  const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=';
  w.chrome={runtime:{id:'test',sendMessage:async()=>({ok:true,data:{connection:{paired,session:'agent',session_label:'Agent',company_label:'Company'},draft:{notes:[{id:'one',kind:'region',text:'Adjust this',rect:{x:20,y:20,width:30,height:40}}],message:'',snapshot:{viewport:{width:640,height:480},annotations:[],crops:[],preview:'data:image/png;base64,'+png,screenshot:{data_base64:png}}}}}),onMessage:{addListener(){}}}};
  const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){return attach.call(this,{...options,mode:'open'});};
  w.Element.prototype.getBoundingClientRect=()=>({x:100,y:120,left:100,top:120,right:300,bottom:200,width:200,height:80});
  w.eval(await readFile(new URL('../dist/content.js',import.meta.url),'utf8'));await new Promise(r=>setTimeout(r,20));
  const root=w.document.querySelector('[data-supermux-overlay]').shadowRoot;
  root.querySelector('[data-action="review"]').click();
  assert.equal(root.querySelectorAll('[data-action="settings"]').length,1);
  assert.equal(root.querySelector('.panel h2').textContent,'Screenshot and notes');
  assert.equal(root.querySelector('.connection-action').textContent,paired?'Change':'Connect');
  assert.equal(root.querySelector('.connection-name').textContent,paired?'AgentCompany':'No chat connected');
  assert.equal(root.querySelector('[data-action="send"]').disabled,!paired);
  assert.equal(/ONE LAST LOOK|Make it clear|masked|let your notes do the talking/.test(root.querySelector('.panel').textContent),false);
  root.querySelector('[data-action="back"]').click();
  w.document.querySelector('#field').dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
  assert.ok(root.querySelector('.editor'));assert.equal(root.querySelector('.element-label').textContent.includes('never-extract-this'),false);
  dom.window.close();
 }
});

test('returning from pairing refreshes only the connection and preserves the open draft and focus',async()=>{
 const dom=new JSDOM('<main>Visible page</main>',{url:'https://demo.example',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;w.CSS={escape:s=>s};Object.defineProperty(w,'crypto',{value:webcrypto});
 let connection={paired:false},saved;const requests=[];
 const snapshot={viewport:{width:640,height:480},annotations:[],crops:[],preview:'data:image/png;base64,fixture',screenshot:{data_base64:'fixture'}};
 w.chrome={runtime:{id:'test',sendMessage:async m=>{
  requests.push(m);
  if(m.type==='draft.load')return {ok:true,data:{connection,...(m.connection_only?{}:{draft:{notes:[{id:'one',kind:'region',text:'Adjust this',rect:{x:20,y:20,width:30,height:40}}],message:'Original draft',clientId:'original-client',snapshot}})}};
  if(m.type==='draft.save')saved=m.draft;
  return {ok:true,data:true};
 },onMessage:{addListener(){}}}};
 const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){return attach.call(this,{...options,mode:'open'});};
 try{
  w.eval(await readFile(new URL('../dist/content.js',import.meta.url),'utf8'));await new Promise(r=>setTimeout(r,20));
  const root=w.document.querySelector('[data-supermux-overlay]').shadowRoot;
  root.querySelector('[data-action="review"]').click();
  const field=root.querySelector('.capture-preview');field.focus();
  assert.equal(root.querySelector('[data-action="send"]').disabled,true);
  connection={paired:true,session:'agent-a',session_label:'Agent A',company_label:'Company A'};
  w.dispatchEvent(new w.Event('focus'));await new Promise(r=>setTimeout(r,20));
  assert.equal(root.querySelector('.connection-name').textContent,'Agent ACompany A');
  assert.equal(root.querySelector('[data-action="send"]').disabled,false);
  assert.equal(root.querySelector('.capture-preview'),field);assert.equal(root.activeElement,field);
  assert.equal(root.querySelector('.message'),null);
  connection={paired:true,session:'agent-b',session_label:'Agent B',company_label:'Company B'};
  w.document.dispatchEvent(new w.Event('visibilitychange'));await new Promise(r=>setTimeout(r,20));
  assert.equal(root.querySelector('.connection-name').textContent,'Agent BCompany B');
  assert.equal(root.querySelector('.capture-preview'),field);assert.equal(root.activeElement,field);
  assert.equal(requests.filter(m=>m.type==='draft.load'&&m.connection_only).length,2);
  w.__supermuxAnnotation.toggle(false);
  await new Promise(r=>setTimeout(r,550));
  assert.equal(saved.clientId,'original-client');assert.equal(saved.message,'Original draft');assert.deepEqual(JSON.parse(JSON.stringify(saved.snapshot)),snapshot);
 }finally{dom.window.close();}
});
