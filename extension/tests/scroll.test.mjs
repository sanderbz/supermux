import test from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {webcrypto} from 'node:crypto';
import {JSDOM} from '../../web/node_modules/jsdom/lib/api.js';
import {png} from './helpers/png.mjs';
const script=await readFile(new URL('../dist/content.js',import.meta.url),'utf8');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const box=(x,y,width,height)=>({x,y,width,height,left:x,top:y,right:x+width,bottom:y+height});
async function harness(draft,options={}){
 const dom=new JSDOM('<!doctype html><title>Scroll fixture</title><main id="surface"><p id="normal">Normal content</p><div id="panel" style="overflow:auto;overflow-x:auto;overflow-y:auto"><p id="nested">Nested content</p><input type="password" value="secret"></div><div id="fixedpanel" style="position:fixed;overflow:auto;overflow-x:auto;overflow-y:auto"><p id="fixednested">Fixed nested content</p></div><p id="fixed" style="position:fixed">Fixed toolbar</p><p id="sticky" style="position:sticky">Sticky toolbar</p></main>',{url:'https://voltlogger.com',runScripts:'outside-only',pretendToBeVisual:true});
 const w=dom.window;let shadow,listener,lastDraft,canvasId=0;const shots=[],draws=[],sent=[];
 Object.defineProperty(w,'crypto',{value:webcrypto});w.CSS={escape:s=>s};Object.defineProperties(w,{scrollX:{value:0,writable:true},scrollY:{value:0,writable:true}});
 const attach=w.Element.prototype.attachShadow;w.Element.prototype.attachShadow=function(options){const s=attach.call(this,options);if(this.hasAttribute('data-supermux-overlay'))shadow=s;return s;};
 const panel=w.document.querySelector('#panel'),fixedPanel=w.document.querySelector('#fixedpanel');
 Object.defineProperty(w.document,'scrollingElement',{value:w.document.documentElement});
 if(options.bodyScroller){w.document.documentElement.style.overflow='hidden';w.document.body.style.cssText='height:100vh;overflow:auto;overflow-x:auto;overflow-y:auto';Object.defineProperties(w.document.body,{clientWidth:{value:1024},clientHeight:{value:768},scrollWidth:{value:1800},scrollHeight:{value:2000}});}
 for(const el of [panel,fixedPanel])Object.defineProperties(el,{clientWidth:{value:280},clientHeight:{value:180},scrollWidth:{value:800},scrollHeight:{value:900},clientTop:{value:0},clientLeft:{value:0}});
 w.Element.prototype.getBoundingClientRect=function(){switch(this.id){
  case 'normal':return box(100-w.scrollX-w.document.body.scrollLeft,300-w.scrollY-w.document.body.scrollTop,160,55);
  case 'panel':return box(100-w.scrollX,180-w.scrollY,280,180);
  case 'nested':return box(120-w.scrollX-panel.scrollLeft,220-w.scrollY-panel.scrollTop,120,40);
  case 'fixedpanel':return box(600,180,280,180);
  case 'fixednested':return box(620-fixedPanel.scrollLeft,220-fixedPanel.scrollTop,120,40);
  case 'fixed':return box(900,30,80,30);
  case 'sticky':return box(760-w.scrollX,Math.max(20,160-w.scrollY),100,30);
  default:if(this.tagName==='INPUT')return box(130-w.scrollX-panel.scrollLeft,280-w.scrollY-panel.scrollTop,100,25);return box(0-w.scrollX,0-w.scrollY,1024,2000);
 }};
 w.Image=class{width=options.imageWidth||1024;height=options.imageHeight||768;async decode(){}};
 w.HTMLCanvasElement.prototype.getContext=function(){const canvas=this;return{drawImage(...args){draws.push({canvas,args});if(args[0].__marked)canvas.__marked=true;},strokeRect(){canvas.__marked=true;},fillText(){canvas.__marked=true;},beginPath(){},rect(){},clip(){},save(){},restore(){},moveTo(){},lineTo(){},stroke(){canvas.__marked=true;},arc(){},fill(){canvas.__marked=true;}};};
 w.HTMLCanvasElement.prototype.toDataURL=function(){this.__imageId ||= ++canvasId;return 'data:image/png;base64,'+png(this.width,this.height,this.__imageId+(this.__marked?64:0),options.heavyPNG);};
 const rpc=(type,extra={})=>new Promise(resolve=>listener({type,...extra},{id:'test'},value=>resolve(structuredClone(value))));
 w.chrome={runtime:{id:'test',onMessage:{addListener:f=>listener=f},sendMessage:async m=>{
  if(m.type==='draft.load')return{ok:true,data:{draft:structuredClone(draft),connection:{paired:!!options.paired}}};
  if(m.type==='draft.save'){if(options.saveFails)return{ok:false,error:'Latest changes could not be saved. Keep this page open and retry.'};lastDraft=structuredClone(m.draft);return{ok:true,data:true};}
  if(m.type==='capture'){const raw=await rpc('capture.prepare');if(!raw) return{ok:false,error:'Capture moved'};shots.push(structuredClone(raw));await rpc('capture.restore');return{ok:true,data:{...raw,dataUrl:'data:image/png;base64,'+png()}};}
  if(m.type==='feedback.submit'){sent.push(structuredClone(m.payload));return{ok:true,data:{id:'receipt',status:'sent'}};}
  return{ok:true,data:true};
 }}};
 if(options.changedTarget)w.document.querySelector('#nested').textContent='Replacement content';
 if(options.missingTarget)w.document.querySelector('#nested').remove();
 w.eval(script);await delay(25);
 const key=(target,k)=>target.dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true,composed:true,cancelable:true}));
 const finish=()=>key(shadow.querySelector('.editor textarea'),'Escape');
 const pick=id=>{shadow.querySelector('[data-mode="element"]').click();w.document.getElementById(id).dispatchEvent(new w.MouseEvent('click',{bubbles:true,cancelable:true}));finish();};
 const draw=(mode,target,start,end)=>{shadow.querySelector(`[data-mode="${mode}"]`).click();for(const [type,coords] of [['pointerdown',start],['pointermove',end],['pointerup',end]])target.dispatchEvent(new w.MouseEvent(type,{clientX:coords[0],clientY:coords[1],button:0,bubbles:true,cancelable:true}));finish();};
 const pin=n=>{const node=shadow.querySelector(`[aria-label="Edit note ${n}"]`);return node?{x:parseFloat(node.style.left),y:parseFloat(node.style.top)}:null;};
 const scroll=async(el,x,y)=>{if(el===w){w.scrollX=x;w.scrollY=y;}else{el.scrollLeft=x;el.scrollTop=y;}el.dispatchEvent(new w.Event('scroll',{bubbles:false}));await delay(25);};
 return{dom,w,shadow,panel,fixedPanel,rpc,pick,draw,pin,scroll,shots,draws,sent,getDraft:()=>lastDraft};
}
test('page scroll moves Pick, Draw and Area geometry and pins while fixed/sticky picks follow their nodes',async()=>{
 const h=await harness();try{
  h.pick('normal');h.draw('draw',h.w.document.querySelector('#surface'),[200,250],[260,300]);h.draw('region',h.w.document.querySelector('#surface'),[400,350],[480,390]);h.pick('fixed');h.pick('sticky');
  assert.deepEqual(h.pin(1),{x:260,y:300});assert.deepEqual(h.pin(2),{x:260,y:250});assert.deepEqual(h.pin(3),{x:480,y:350});assert.deepEqual(h.pin(4),{x:980,y:30});
  await h.scroll(h.w,40,110);
  assert.deepEqual(h.pin(1),{x:220,y:190});assert.deepEqual(h.pin(2),{x:220,y:140});assert.deepEqual(h.pin(3),{x:440,y:240});assert.deepEqual(h.pin(4),{x:980,y:30});assert.deepEqual(h.pin(5),{x:820,y:50});
  assert.equal(h.shadow.querySelector('.stroke').getAttribute('points'),'160,140 220,190');
  const shot=await h.rpc('capture.prepare');assert.deepEqual(shot.annotations[2].rect,{x:360,y:240,width:80,height:40});assert.deepEqual(shot.annotations[1].points,[{x:160,y:140},{x:220,y:190}]);await h.rpc('capture.restore');
  await h.scroll(h.w,40,250);assert.deepEqual(h.pin(5),{x:820,y:20});assert.deepEqual(h.pin(4),{x:980,y:30});
 }finally{h.dom.window.close();}
});
test('nonbubbling nested scroll translates Pick, Draw and Area, clips offscreen content, and invalidates capture',async()=>{
 const h=await harness();try{
  h.pick('nested');h.draw('draw',h.w.document.querySelector('#nested'),[145,235],[210,265]);h.draw('region',h.w.document.querySelector('#nested'),[150,240],[225,275]);
  await h.scroll(h.panel,15,25);
  assert.deepEqual(h.pin(1),{x:225,y:195});assert.deepEqual(h.pin(2),{x:195,y:210});assert.deepEqual(h.pin(3),{x:210,y:215});assert.equal(h.shadow.querySelector('.stroke').getAttribute('points'),'130,210 195,240');
  const shot=await h.rpc('capture.prepare');assert.deepEqual(shot.annotations[2].rect,{x:135,y:215,width:75,height:35});assert.equal('anchor' in shot.annotations[2],false);assert.equal('anchor' in shot.annotations[1],false);assert.equal(h.shadow.querySelectorAll('.privacy-mask').length,1);
  h.panel.scrollTop=30;assert.equal(await h.rpc('capture.validate',{nonce:shot.nonce,viewport:shot.viewport}),false);await h.rpc('capture.restore');
  const pending=await h.rpc('capture.prepare');await h.scroll(h.panel,15,40);assert.equal(await h.rpc('capture.validate',{nonce:pending.nonce,viewport:pending.viewport}),false);assert.equal(h.shadow.querySelectorAll('.privacy-mask').length,0);
  await h.scroll(h.panel,15,150);assert.equal(h.pin(1),null);assert.equal(h.pin(2),null);assert.equal(h.pin(3),null);assert.equal(h.shadow.querySelectorAll('.annotation-outline,.stroke').length,0);
  const clipped=await h.rpc('capture.prepare');assert.equal(clipped.hiddenIds.length,3);await h.rpc('capture.restore');
 }finally{h.dom.window.close();}
});
test('Draw and Area in a fixed overflow panel follow its own scroll but stay fixed during page scroll',async()=>{
 const h=await harness();try{
  h.draw('draw',h.w.document.querySelector('#fixednested'),[640,240],[710,270]);h.draw('region',h.w.document.querySelector('#fixednested'),[645,245],[720,280]);
  await h.scroll(h.fixedPanel,20,30);assert.deepEqual(h.pin(1),{x:690,y:210});assert.deepEqual(h.pin(2),{x:700,y:215});
  await h.scroll(h.w,50,90);assert.deepEqual(h.pin(1),{x:690,y:210});assert.deepEqual(h.pin(2),{x:700,y:215});assert.equal(h.shadow.querySelector('.stroke').getAttribute('points'),'620,210 690,240');
 }finally{h.dom.window.close();}
});
test('a body that scrolls independently from the document anchors Draw and Area correctly',async()=>{
 const h=await harness(undefined,{bodyScroller:true});try{
  h.pick('normal');h.draw('draw',h.w.document.querySelector('#surface'),[200,250],[260,300]);h.draw('region',h.w.document.querySelector('#surface'),[400,350],[480,390]);
  await h.scroll(h.w.document.body,40,110);assert.equal(h.w.scrollY,0);assert.deepEqual(h.pin(1),{x:220,y:190});assert.deepEqual(h.pin(2),{x:220,y:140});assert.deepEqual(h.pin(3),{x:440,y:240});assert.equal(h.shadow.querySelector('.stroke').getAttribute('points'),'160,140 220,190');
  const shot=await h.rpc('capture.prepare');assert.deepEqual(shot.annotations[2].rect,{x:360,y:240,width:80,height:40});await h.rpc('capture.restore');
 }finally{h.dom.window.close();}
});
test('draft recovery and undo restore only unique matching DOM refs and preserve frozen snapshots and crops',async()=>{
 const original=await harness();let draft;try{original.pick('nested');original.draw('region',original.w.document.querySelector('#nested'),[150,240],[225,275]);await delay(550);draft=original.getDraft();}finally{original.dom.window.close();}
 const first=draft.notes[0].id,second=draft.notes[1].id;
 draft.noteCrops={[first]:{annotation_id:first,mime:'image/png',data_base64:png(120,40,1)},[second]:{annotation_id:second,mime:'image/png',data_base64:png(75,35,2)}};
 draft.snapshot={viewport:{width:1024,height:768,dpr:1,scroll_x:0,scroll_y:0},annotations:[{id:first,number:1,kind:'element',rect:{x:120,y:220,width:120,height:40},text:''}],screenshot:{mime:'image/png',data_base64:png()},preview:'data:image/png;base64,'+png(),crops:[]};
 const h=await harness(draft);try{
  await h.scroll(h.panel,15,25);assert.deepEqual(h.pin(1),{x:225,y:195});assert.deepEqual(h.pin(2),{x:210,y:215});
  h.w.__supermuxAnnotation.toggle(false);await delay(550);assert.deepEqual(h.getDraft().snapshot,draft.snapshot);assert.deepEqual(h.getDraft().noteCrops,draft.noteCrops);h.w.__supermuxAnnotation.toggle(true);await delay(25);
  h.shadow.querySelector('[aria-label="Edit note 1"]').click();h.shadow.querySelector('[data-action="delete"]').click();h.shadow.querySelector('[data-action="undo"]').click();await h.scroll(h.panel,15,30);assert.deepEqual(h.pin(1),{x:225,y:190});
  h.w.document.querySelector('#nested').remove();await h.scroll(h.panel,15,35);assert.equal(h.pin(1),null);
 }finally{h.dom.window.close();}
 for(const type of ['ambiguous','changed','missing']){
  const stale=structuredClone(draft);stale.snapshot=null;if(type==='ambiguous')stale.notes[0].element.selector='p';
  const a=await harness(stale,{changedTarget:type==='changed',missingTarget:type==='missing'});try{
   await a.scroll(a.panel,15,25);assert.equal(a.pin(1),null,type+' target stays hidden');
   a.shadow.querySelector('[data-action="review"]').click();await delay(130);await delay(550);
   assert.ok(a.getDraft().snapshot.hiddenIds.includes(first));assert.deepEqual(a.getDraft().snapshot.crops.find(c=>c.annotation_id===first),{...draft.noteCrops[first],number:1},type+' target preserves prior crop');
   a.shadow.querySelector('.note-row [data-pin]').click();assert.ok(a.shadow.querySelector('.editor textarea'));a.shadow.querySelector('[data-action="delete"]').click();await delay(550);assert.equal(a.getDraft().notes.some(n=>n.id===first),false);
  }finally{a.dom.window.close();}
 }
 const noCrop={notes:[draft.notes[0]],message:'',noteCrops:{}};const missing=await harness(noCrop,{missingTarget:true});try{
  missing.shadow.querySelector('[data-action="review"]').click();await delay(130);assert.match(missing.shadow.querySelector('.toast').textContent,/no screenshot context/);missing.shadow.querySelector('.note-row [data-pin]').click();missing.shadow.querySelector('[data-action="delete"]').click();assert.equal(missing.shadow.querySelectorAll('.pin').length,0);
 }finally{missing.dom.window.close();}
});
test('clipped notes keep their prior crop; live partial crops never include pixels outside the scroller',async()=>{
 const h=await harness();try{
  h.pick('nested');h.shadow.querySelector('[aria-label="Edit note 1"]').click();h.shadow.querySelector('[data-action="done"]').click();await delay(130);await delay(550);const original=h.getDraft().noteCrops;assert.equal(Object.keys(original).length,1);
  await h.scroll(h.panel,0,150);h.shadow.querySelector('[data-action="review"]').click();await delay(130);await delay(550);const captured=h.getDraft().snapshot;assert.equal(captured.hiddenIds.length,1);assert.deepEqual(captured.crops[0],Object.values(original)[0]);assert.match(h.shadow.querySelector('.note-row').textContent,/Outside screenshot · saved crop/);
  h.shadow.querySelector('[data-action="back"]').click();await h.scroll(h.panel,0,55);h.shadow.querySelector('[data-action="review"]').click();h.shadow.querySelector('[data-action="capture"]').click();await delay(130);const cropCalls=h.draws.filter(call=>call.args.length===9);assert.ok(cropCalls.length);const last=cropCalls.at(-1).args;assert.ok(last[2]>=180,'crop top stays inside overflow viewport');assert.ok(last[2]+last[4]<=360,'crop bottom stays inside overflow viewport');
 }finally{h.dom.window.close();}
});

test('retains native crop detail and original capture provenance when an offscreen note is renumbered',async()=>{
 const h=await harness(undefined,{imageWidth:4096,imageHeight:3072,paired:true});try{
  h.pick('normal');h.pick('nested');h.shadow.querySelector('[aria-label="Edit note 2"]').click();h.shadow.querySelector('[data-action="done"]').click();await delay(130);await delay(550);
  const saved=h.getDraft().noteCrops;const original=Object.values(saved)[0];assert.equal(original.number,2);assert.deepEqual(original.capture.annotation_rect,{x:120,y:220,width:120,height:40});assert.deepEqual(original.capture.rect,{x:108,y:208,width:144,height:64});assert.ok(Date.parse(original.capture.captured_at));
  const firstCrop=h.draws.find(call=>call.args.length===9);assert.equal(firstCrop.args[0].width,4096,'crop reads from original full-resolution image');assert.equal(firstCrop.canvas.width,736,'normal text crop keeps native pixels beyond overview scale');
  h.shadow.querySelector('[aria-label="Edit note 1"]').click();h.shadow.querySelector('[data-action="delete"]').click();await h.scroll(h.panel,0,150);h.shadow.querySelector('[data-action="review"]').click();await delay(130);await delay(550);
  const shot=h.getDraft().snapshot;assert.equal(shot.annotations[0].number,1);assert.equal(shot.crops[0].number,1);assert.deepEqual(shot.crops[0].capture,original.capture);assert.equal(shot.crops[0].data_base64,original.data_base64);assert.equal(shot.crops[0].capture.viewport.scroll_y,0);assert.equal(shot.crops[0].capture.annotation_rect.y,220);
  const message=h.shadow.querySelector('.message');message.value='Make this easier to read';message.dispatchEvent(new h.w.Event('input',{bubbles:true}));h.shadow.querySelector('[data-action="send"]').click();await delay(30);assert.equal(h.sent.length,1);assert.equal(h.sent[0].annotated_screenshot.data_base64,shot.preview.split(',')[1]);assert.equal(h.sent[0].annotations[0].number,1);assert.deepEqual(h.sent[0].crops[0].capture,original.capture);
 }finally{h.dom.window.close();}
});

test('complex PNGs shrink to budget without detaching clean and numbered overview dimensions',async()=>{
 const h=await harness(undefined,{imageWidth:4096,imageHeight:3072,heavyPNG:true});try{
  h.draw('region',h.w.document.querySelector('#surface'),[20,20],[950,700]);h.shadow.querySelector('[data-action="review"]').click();await delay(160);await delay(550);const shot=h.getDraft().snapshot;
  assert.ok(shot.screenshot.data_base64.length*.75<=2*1024*1024);assert.ok(shot.preview.split(',')[1].length*.75<=2*1024*1024);assert.equal(shot.screenshot.data_base64.length,shot.preview.split(',')[1].length);assert.notEqual(shot.screenshot.data_base64,shot.preview.split(',')[1],'numbered pixels stay separate from the clean image');assert.ok(shot.crops[0].data_base64.length*.75<=2*1024*1024);assert.ok(h.draws.some(c=>c.args.length===5&&c.args[1]===0&&c.canvas.width<1800),'PNG budget resizes pixels');assert.ok(h.draws.some(c=>c.args.length===9&&c.canvas.width<=1400&&c.canvas.height<=1000),'native crop dimensions bounded');
 }finally{h.dom.window.close();}
});

test('legacy recovered screenshots keep their clean image and normalize note numbers on send',async()=>{
 const draft={notes:[{id:'one',kind:'region',rect:{x:20,y:20,width:30,height:40},text:'Adjust this'}],message:'Change this',snapshot:{viewport:{width:1024,height:768,dpr:1,scroll_x:0,scroll_y:0},url:'https://voltlogger.com/',annotations:[{id:'one',kind:'region',rect:{x:20,y:20,width:30,height:40},text:'Adjust this'}],screenshot:{mime:'image/png',data_base64:png(1024,768)},preview:'data:image/png;base64,'+png(600,450),crops:[{annotation_id:'one',mime:'image/png',data_base64:png(30,40)}]}};
 const h=await harness(draft,{paired:true});try{h.shadow.querySelector('[data-action="review"]').click();h.shadow.querySelector('[data-action="send"]').click();await delay(40);assert.equal(h.sent.length,1);assert.equal(h.sent[0].screenshot.data_base64,draft.snapshot.screenshot.data_base64);assert.equal(h.sent[0].annotated_screenshot,undefined);assert.equal(h.sent[0].annotations[0].number,1);assert.equal(h.sent[0].crops[0].number,1);assert.equal(h.sent[0].crops[0].capture,undefined);}finally{h.dom.window.close();}
});

test('sending waits for durable saving and retains review when storage fails',async()=>{
 const h=await harness(undefined,{paired:true,saveFails:true});try{h.pick('normal');h.shadow.querySelector('[data-action="review"]').click();await delay(200);const input=h.shadow.querySelector('.message');input.value='Make this clearer';input.dispatchEvent(new h.w.Event('input',{bubbles:true}));h.shadow.querySelector('[data-action="send"]').click();await delay(40);assert.equal(h.sent.length,0);assert.match(h.shadow.querySelector('.error').textContent,/could not be saved/);assert.ok(h.shadow.querySelector('.capture img'));assert.equal(h.shadow.querySelectorAll('.note-row').length,1);}finally{h.dom.window.close();}
});
