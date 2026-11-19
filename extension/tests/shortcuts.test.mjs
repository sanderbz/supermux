import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {webcrypto} from 'node:crypto';
import {JSDOM} from '../../web/node_modules/jsdom/lib/api.js';
const script=await readFile(new URL('../dist/content.js',import.meta.url),'utf8');
for(const [platform,hint,modifier,other] of [['MacIntel',null,'metaKey','ctrlKey'],['MacIntel','macOS','metaKey','ctrlKey'],['Win32',null,'ctrlKey','metaKey'],['Win32','Windows','ctrlKey','metaKey']])test(`modified modes preserve closed-shadow and website text editing on ${hint||platform}${hint?' client hints':''}`,async()=>{
 const dom=new JSDOM('<!doctype html><h1>Homepage</h1><input id="website"><div contenteditable="true" id="editable"><span>Website text</span></div><div id="closed"></div>',{url:'https://voltlogger.com',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;let shadow;Object.defineProperty(w.navigator,'platform',{value:platform});if(hint)Object.defineProperty(w.navigator,'userAgentData',{value:{platform:hint}});Object.defineProperty(w,'crypto',{value:webcrypto});w.CSS={escape:s=>s};w.chrome={runtime:{id:'test',sendMessage:async m=>({ok:true,data:m.type==='draft.load'?{connection:{paired:false}}:true}),onMessage:{addListener(){}}}};
 const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){const result=attach.call(this,options);if(this.hasAttribute('data-supermux-overlay'))shadow=result;return result;};
 w.Element.prototype.getBoundingClientRect=()=>({x:100,y:100,left:100,top:100,right:300,bottom:180,width:200,height:80});
 w.eval(script);await new Promise(r=>setTimeout(r,20));assert.equal(w.document.querySelector('[data-supermux-overlay]').shadowRoot,null);
 const key=(target,k,extra={})=>{const e=new w.KeyboardEvent('keydown',{key:k,bubbles:true,composed:true,cancelable:true,...extra});target.dispatchEvent(e);return e;};
 const current=()=>shadow.querySelector('.tool.active')?.dataset.mode;
 assert.match(shadow.querySelector('[data-mode="draw"]').title,modifier==='metaKey'?/⌘D/:/Ctrl\+D/);
 for(const k of ['p','d','r'])assert.equal(key(w.document,k).defaultPrevented,false);assert.equal(current(),'element');
 assert.equal(key(w.document,'d',{[other]:true}).defaultPrevented,false);assert.equal(current(),'element');
 assert.equal(key(w.document,'d',{[modifier]:true}).defaultPrevented,true);assert.equal(current(),'draw');
 assert.equal(key(w.document,'p',{[modifier]:true}).defaultPrevented,true);assert.equal(current(),'element');
 w.document.querySelector('h1').dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));
 const note=shadow.querySelector('.editor textarea');note.focus();
 for(const k of ['p','d','r','z'])for(const extra of [{},{[modifier]:true}]){assert.equal(key(note,k,extra).defaultPrevented,false);assert.equal(shadow.querySelector('.editor textarea'),note);assert.equal(current(),'element');}
 assert.equal(shadow.querySelector('.bar-message'),null);
 const website=w.document.querySelector('#website');website.focus();for(const k of ['p','d','r','z'])assert.equal(key(website,k,{[modifier]:true}).defaultPrevented,false);assert.equal(current(),'element');
 const editable=w.document.querySelector('#editable');editable.focus();assert.equal(key(editable.querySelector('span'),'d',{[modifier]:true}).defaultPrevented,false);assert.equal(current(),'element');
 const closedHost=w.document.querySelector('#closed'),closedRoot=closedHost.attachShadow({mode:'closed'}),privateInput=w.document.createElement('input');closedRoot.append(privateInput);privateInput.focus();assert.equal(key(privateInput,'d',{[modifier]:true}).defaultPrevented,false);assert.equal(current(),'element');
 note.focus();assert.equal(key(note,'Enter',{[modifier]:true}).defaultPrevented,true);assert.equal(shadow.querySelector('.editor'),null);
 shadow.querySelector('[data-action="review"]').click();await new Promise(r=>setTimeout(r,20));assert.equal(shadow.querySelector('.message'),null);
 assert.equal(key(shadow.querySelector('[data-action="back"]'),'Escape').defaultPrevented,true);assert.equal(shadow.querySelector('.panel'),null);dom.window.close();
});
