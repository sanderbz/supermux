import {chromium} from '../../web/node_modules/playwright/index.mjs';
import {mkdtemp,rm,cp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';

const fixture=`<!doctype html><title>Feedback scrolling fixture</title><style>
html{scroll-behavior:auto}body{margin:0;min-height:2800px;font:16px system-ui;background:#f7f8f4;color:#263326}
#copy{position:absolute;left:60px;top:140px;width:360px;height:80px;margin:0;background:#e3eddf;padding:12px}
#scrollbox{position:absolute;left:60px;top:340px;width:500px;height:280px;overflow:auto;border:2px solid #31442d}
#scroll-content{position:relative;width:1100px;height:1400px;background:linear-gradient(#f3f7ee,#c9d8be)}
#nested{position:absolute;left:110px;top:130px;width:220px;height:70px;margin:0;background:#d6e4cd;padding:8px}
#fixed{position:fixed;left:870px;top:110px;width:230px;height:80px;z-index:3}
#sticky-scope{position:absolute;left:770px;top:320px;width:270px;height:1400px}
#sticky{position:sticky;top:40px;width:230px;height:60px;display:block}
button{font:inherit;border:0;border-radius:8px;background:#31442d;color:white}
#canvas-target{position:absolute;left:60px;top:800px;width:560px;height:400px;background:#e4ecd9}
#private{position:absolute;top:240px;left:60px}
</style><p id="copy">Normal page target. Its annotation should follow document scrolling.</p>
<div id="scrollbox"><div id="scroll-content"><p id="nested">Nested scroll target. Its annotation should follow this element.</p></div></div>
<button id="fixed">Fixed target</button><div id="sticky-scope"><button id="sticky">Sticky target</button></div>
<section id="canvas-target" aria-label="Page drawing surface"></section>
<input id="private" type="password" value="synthetic-private-fixture" data-private>`;
const profile=await mkdtemp(join(tmpdir(),'supermux-extension-'));
let context,server;
try {
  const extension=join(profile,'fixture-extension');
  await cp(fileURLToPath(new URL('../dist/',import.meta.url)),extension,{recursive:true});
  const manifestPath=join(extension,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // Only this disposable fixture gets localhost access: automation cannot click
  // Chrome's toolbar for activeTab. Production permissions stay unchanged.
  manifest.host_permissions=['http://127.0.0.1/*'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:process.env.HEADED!=='1',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
    viewport:{width:1280,height:850},
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/?page=scrolling`);
  const tabId=await worker.evaluate(async url=>{
    const [tab]=await chrome.tabs.query({url});
    await chrome.storage.session.set({annotationTabs:{[tab.id]:tab.url}});return tab.id;
  },page.url());
  await worker.evaluate(async id=>{await chrome.scripting.executeScript({target:{tabId:id},files:['content.js']});},tabId);
  await page.waitForSelector('[data-supermux-overlay]');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-supermux-overlay]').shadowRoot),null,'overlay must remain closed');
  const cdp=await context.newCDPSession(page);
  function findHost(node) {
    if(node.attributes?.includes('data-supermux-overlay'))return node;
    for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const found=findHost(child);if(found)return found;}
  }
  // CDP inspects the real closed root; no attachShadow patch or website-visible hook.
  async function overlay(fn,arg=null) {
    const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
    const shadow=findHost(root)?.shadowRoots?.[0];assert.ok(shadow,'CDP overlay root');assert.equal(shadow.shadowRootType,'closed');
    const {object}=await cdp.send('DOM.resolveNode',{nodeId:shadow.nodeId});
    try {
      const result=await cdp.send('Runtime.callFunctionOn',{
        objectId:object.objectId,functionDeclaration:`function(arg){return (${fn.toString()})(this,arg);}`,
        arguments:[{value:arg}],returnByValue:true,awaitPromise:true,
      });
      assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));return result.result.value;
    } finally {await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}
  }
  const readOverlay=()=>overlay(root=>({
    rectangles:[...root.querySelectorAll('.scene rect.annotation-outline')].map(el=>({x:+el.getAttribute('x'),y:+el.getAttribute('y'),width:+el.getAttribute('width'),height:+el.getAttribute('height')})),
    strokes:[...root.querySelectorAll('.scene polyline.stroke')].map(el=>(el.getAttribute('points')||'').trim().split(/\s+/).filter(Boolean).map(p=>{const [x,y]=p.split(',').map(Number);return{x,y};})),
    pins:[...root.querySelectorAll('button.pin')].map(el=>{const r=el.getBoundingClientRect();return{number:+el.textContent,id:el.dataset.pin,selected:el.classList.contains('selected'),x:r.x+r.width/2,y:r.y+r.height/2,visible:r.width>0&&r.height>0&&getComputedStyle(el).visibility!=='hidden'};}),
    editor:root.querySelector('.editor')?{label:root.querySelector('.element-label').textContent,x:root.querySelector('.editor').getBoundingClientRect().x,y:root.querySelector('.editor').getBoundingClientRect().y}:null,
  }));
  async function until(check,label) {
    const end=Date.now()+5000;let last;
    while(Date.now()<end){try{return await check();}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,40));}
    throw new Error(`${label}: ${last?.message||'timed out'}`,{cause:last});
  }
  function near(actual,expected,label){assert.ok(Math.abs(actual-expected)<=1.5,`${label}: expected ${expected}, got ${actual}`);}
  const nativeRect=selector=>page.locator(selector).evaluate(el=>{const r=el.getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height};});
  async function rectangleAndPin(number,expected,label,selected=false) {
    return until(async()=>{
      const state=await readOverlay(),rect=state.rectangles.find(r=>Math.abs(r.x-expected.x)<1.5&&Math.abs(r.y-expected.y)<1.5);
      assert.ok(rect,`${label}: missing SVG rectangle; actual=${JSON.stringify(state.rectangles)}`);
      near(rect.width,expected.width,`${label} width`);near(rect.height,expected.height,`${label} height`);
      const pin=state.pins.find(p=>p.number===number);assert.ok(pin?.visible,`${label}: pin ${number} visible`);
      near(pin.x,expected.x+expected.width,`${label} pin x`);near(pin.y,expected.y,`${label} pin y`);
      if(selected)assert.equal(pin.selected,true,`${label}: DOM note stays selected`);return state;
    },label);
  }
  const elementAndPin=async(number,selector,label)=>rectangleAndPin(number,await nativeRect(selector),label,true);
  async function clickTool(mode) {
    const point=await overlay((root,mode)=>{const r=root.querySelector(`[data-mode="${mode}"]`).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},mode);
    await page.mouse.click(point.x,point.y);
  }
  async function clickPin(number) {
    const point=await overlay((root,number)=>{
      const r=root.querySelector(`button.pin[aria-label="Edit note ${number}"]`).getBoundingClientRect();
      return{x:r.x+r.width/2,y:r.y+r.height/2};
    },number);
    await page.mouse.click(point.x,point.y);
  }
  async function closeEditor(){await page.keyboard.press('Escape');await until(async()=>assert.equal((await readOverlay()).editor,null),'close editor');}
  async function pageScroll(y){await page.evaluate(y=>window.scrollTo({top:y,left:0,behavior:'instant'}),y);await page.waitForFunction(y=>Math.abs(scrollY-y)<1,y);}
  async function containerScroll(top,left=0){await page.locator('#scrollbox').evaluate((el,p)=>el.scrollTo({...p,behavior:'instant'}),{top,left});await page.waitForFunction(p=>{const el=document.querySelector('#scrollbox');return el.scrollTop===p.top&&el.scrollLeft===p.left;},{top,left});}
  async function draw(points){await page.mouse.move(...points[0]);await page.mouse.down();for(const point of points.slice(1))await page.mouse.move(...point,{steps:4});await page.mouse.up();}
  async function strokeAndPin(number,expected,label,selected=true) {
    assert.ok(expected?.length,`${label}: drawing has points`);
    return until(async()=>{
      const state=await readOverlay(),stroke=state.strokes.find(p=>Math.abs(p[0]?.x-expected[0].x)<1.5&&Math.abs(p[0]?.y-expected[0].y)<1.5);
      assert.ok(stroke,`${label}: missing polyline`);assert.equal(stroke.length,expected.length);
      stroke.forEach((p,i)=>{near(p.x,expected[i].x,`${label} point ${i} x`);near(p.y,expected[i].y,`${label} point ${i} y`);});
      const pin=state.pins.find(p=>p.number===number);assert.ok(pin?.visible,`${label}: pin visible`);if(selected)assert.equal(pin.selected,true);
      near(pin.x,Math.max(...expected.map(p=>p.x)),`${label} pin x`);near(pin.y,Math.min(...expected.map(p=>p.y)),`${label} pin y`);return state;
    },label);
  }

  await page.locator('#copy').click();let state=await elementAndPin(1,'#copy','normal element');assert.ok(state.editor.label.includes('Normal page target'));
  await pageScroll(100);await elementAndPin(1,'#copy','normal element follows document');
  await pageScroll(0);await elementAndPin(1,'#copy','normal element restored');await closeEditor();

  await page.locator('#nested').click();await elementAndPin(2,'#nested','nested element');
  await pageScroll(120);const before=await nativeRect('#nested');await elementAndPin(2,'#nested','nested element follows page');
  await containerScroll(80,45);const after=await nativeRect('#nested');
  near(after.y,before.y-80,'fixture overflow really scrolled vertically');near(after.x,before.x-45,'fixture overflow really scrolled horizontally');
  state=await elementAndPin(2,'#nested','nested nonbubbling scroll repaints selection');assert.ok(state.editor.label.includes('Nested scroll target'));
  near(state.editor.x,after.x+after.width+17,'selected editor follows nested x');near(state.editor.y,after.y+12,'selected editor follows nested y');
  await containerScroll(0);await pageScroll(0);await elementAndPin(2,'#nested','nested element restored');await closeEditor();

  await page.locator('#fixed').click();const fixed=await nativeRect('#fixed');await elementAndPin(3,'#fixed','fixed element');
  await pageScroll(450);near((await nativeRect('#fixed')).y,fixed.y,'fixed fixture stays in viewport');await elementAndPin(3,'#fixed','fixed selection stays anchored');
  await pageScroll(0);await closeEditor();
  await page.locator('#sticky').click();await elementAndPin(4,'#sticky','sticky element');
  await pageScroll(400);near((await nativeRect('#sticky')).y,40,'fixture enters sticky position');await elementAndPin(4,'#sticky','sticky selection at boundary');await closeEditor();

  await pageScroll(500);await clickTool('region');await draw([[180,330],[290,400]]);
  await rectangleAndPin(5,{x:180,y:330,width:110,height:70},'page region',true);await closeEditor();
  await pageScroll(560);await rectangleAndPin(5,{x:180,y:270,width:110,height:70},'page region follows document');
  await pageScroll(500);await clickTool('draw');await draw([[360,480],[390,460],[420,490],[380,515],[360,480]]);
  state=await until(async()=>{const s=await readOverlay();assert.ok(s.pins.some(p=>p.number===6&&p.selected));return s;},'page drawing selected');
  const pageStroke=state.strokes.find(p=>Math.abs(p[0].x-360)<1.5);await strokeAndPin(6,pageStroke,'page drawing');
  await pageScroll(580);await strokeAndPin(6,pageStroke.map(p=>({...p,y:p.y-80})),'all page drawing points follow document');await closeEditor();

  await pageScroll(0);await clickTool('region');await draw([[160,380],[260,430]]);
  await rectangleAndPin(7,{x:160,y:380,width:100,height:50},'nested region',true);await containerScroll(30,20);
  await rectangleAndPin(7,{x:140,y:350,width:100,height:50},'nested region follows container',true);await closeEditor();await containerScroll(0);
  await clickTool('draw');await draw([[310,480],[350,460],[390,490]]);
  state=await until(async()=>{const s=await readOverlay();assert.ok(s.pins.some(p=>p.number===8&&p.selected));return s;},'nested drawing selected');
  const nestedStroke=state.strokes.find(p=>Math.abs(p[0].x-310)<1.5);await strokeAndPin(8,nestedStroke,'nested drawing');
  await containerScroll(40,15);await strokeAndPin(8,nestedStroke.map(p=>({x:p.x-15,y:p.y-40})),'all nested drawing points follow container');await closeEditor();

  const draft=await until(async()=>{
    const drafts=await worker.evaluate(async()=>Object.entries(await chrome.storage.local.get(null)).filter(([key])=>key.startsWith('draft:')).map(([,v])=>v.draft));
    const saved=drafts.find(d=>d.notes?.length===8);assert.ok(saved);return saved;
  },'eight notes persist');
  for(const [i,id]of ['copy','nested','fixed','sticky'].entries())assert.ok(draft.notes[i].element.selector.includes(`#${id}`),`note ${i+1} keeps chosen DOM target`);
  assert.deepEqual(draft.notes.map(n=>n.kind),['element','element','element','element','region','draw','region','draw']);

  // A real navigation destroys the element references and shadow root. Restore
  // the persisted draft into fresh DOM nodes, then move the nested scroller again.
  await page.reload();await pageScroll(0);await containerScroll(0);
  await worker.evaluate(async({id,url})=>{
    await chrome.storage.session.set({annotationTabs:{[id]:url}});
    await chrome.scripting.executeScript({target:{tabId:id},files:['content.js']});
  },{id:tabId,url:page.url()});
  await page.waitForSelector('[data-supermux-overlay]');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-supermux-overlay]').shadowRoot),null);
  await rectangleAndPin(2,await nativeRect('#nested'),'restored DOM selection after real reload');
  await clickPin(2);await elementAndPin(2,'#nested','restored nested note selected');
  await strokeAndPin(8,nestedStroke,'restored nested drawing',false);
  await containerScroll(40,15);await elementAndPin(2,'#nested','restored DOM reference follows fresh container');
  await strokeAndPin(8,nestedStroke.map(p=>({x:p.x-15,y:p.y-40})),'restored drawing anchor follows fresh container',false);
  await page.screenshot({path:fileURLToPath(new URL('../preview-overlay.png',import.meta.url))});
  console.log('Production closed-shadow Chromium geometry passed: document/container scrolling, selected DOM/editor/pins, fixed/sticky, page/container area/drawing points, and real reload restoration.');
} finally {
  await context?.close();if(server)await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true});
}
