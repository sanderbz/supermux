// Photograph the shipped extension in real Chromium. Only the demo page and
// connection label are fixtures; capture, masking, crops, and UI are production.
import {chromium} from '../../web/node_modules/playwright/index.mjs';
import {mkdtemp,rm,cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';

const profile=await mkdtemp(join(tmpdir(),'supermux-showcase-'));
const fixture=await readFile(new URL('../showcase/index.html',import.meta.url),'utf8');
let context,server;
try{
  const extension=join(profile,'extension');
  await cp(fileURLToPath(new URL('../dist/',import.meta.url)),extension,{recursive:true});
  const manifestPath=join(extension,'manifest.json');
  const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
  // Automation cannot click Chrome's toolbar to grant activeTab. Chrome's
  // captureVisibleTab requires activeTab or <all_urls>, even for localhost:
  // https://developer.chrome.com/docs/extensions/reference/api/tabs#method-captureVisibleTab
  // Only this throwaway profile receives that grant and opens the demo page;
  // the shipped manifest keeps activeTab and optional server access only.
  manifest.host_permissions=['<all_urls>'];
  await writeFile(manifestPath,JSON.stringify(manifest));
  server=createServer((_req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixture);});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  context=await chromium.launchPersistentContext(profile,{
    channel:'chromium',headless:process.env.HEADED!=='1',
    args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],
    viewport:{width:1440,height:960},deviceScaleFactor:1,
  });
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.bringToFront();
  await worker.evaluate(async url=>{
    const [tab]=await chrome.tabs.query({url});
    const site=new URL(url).origin;
    await chrome.storage.local.set({connection:{origin:site,bindings:{[site]:{session:'website',session_label:'Website · Claude Code',token:'showcase-fixture-never-submitted'}}}});
    await chrome.storage.session.set({annotationTabs:{[tab.id]:tab.url}});
    await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});
  },page.url());
  await page.waitForSelector('[data-supermux-overlay]');
  assert.equal(await page.evaluate(()=>document.querySelector('[data-supermux-overlay]').shadowRoot),null);
  const cdp=await context.newCDPSession(page);
  function findHost(node){
    if(node.attributes?.includes('data-supermux-overlay'))return node;
    for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const found=findHost(child);if(found)return found;}
  }
  async function overlay(fn,arg=null){
    const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});
    const shadow=findHost(root)?.shadowRoots?.[0];
    assert.equal(shadow?.shadowRootType,'closed');
    const {object}=await cdp.send('DOM.resolveNode',{nodeId:shadow.nodeId});
    try{
      const result=await cdp.send('Runtime.callFunctionOn',{
        objectId:object.objectId,functionDeclaration:`function(arg){return (${fn.toString()})(this,arg);}`,
        arguments:[{value:arg}],returnByValue:true,awaitPromise:true,
      });
      assert.equal(result.exceptionDetails,undefined,JSON.stringify(result.exceptionDetails));
      return result.result.value;
    }finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}
  }
  async function until(check,label){
    const end=Date.now()+15000;let last;
    while(Date.now()<end){try{return await check();}catch(error){last=error;}await new Promise(resolve=>setTimeout(resolve,80));}
    throw new Error(`${label}: ${last?.message||'timed out'}`,{cause:last});
  }
  async function clickOverlay(selector){
    const p=await overlay((root,selector)=>{const el=root.querySelector(selector);if(!el||el.disabled)return null;const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};},selector);
    assert.ok(p,`enabled overlay control ${selector}`);await page.mouse.click(p.x,p.y);
  }
  async function typeOverlay(selector,text){
    await clickOverlay(selector);await page.keyboard.press('ControlOrMeta+A');await page.keyboard.type(text);
    assert.equal(await overlay((root,selector)=>root.querySelector(selector).value,selector),text);
  }
  async function savedDraft(){
    return worker.evaluate(async()=>{
      const saved=Object.entries(await chrome.storage.local.get(null)).find(([key])=>key.startsWith('draft:'))?.[1];
      if(!saved)return null;
      function unpack(value,key){
        if(value&&typeof value==='object'&&Number.isInteger(value.image)&&['data_base64','preview'].includes(key))return (value.data_url?'data:image/png;base64,':'')+saved.images[value.image];
        if(Array.isArray(value))return value.map(v=>unpack(v));
        if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,unpack(v,k)]));
        return value;
      }
      return saved.format===1?unpack(saved.draft):saved.draft;
    });
  }
  await until(async()=>assert.match(await overlay(root=>root.querySelector('.bar').textContent),/Supermux/),'production toolbar');
  for(const [selector,text] of [
    ['#headline','Give the heading a little more room to breathe.'],
    ['#work','Increase the contrast and make this the clear next step.'],
  ]){
    await page.locator(selector).click();
    await until(async()=>assert.equal(await overlay(root=>!!root.querySelector('.editor textarea')),true),'note editor');
    await typeOverlay('.editor textarea',text);await clickOverlay('[data-action="done"]');
    await until(async()=>{const draft=await savedDraft();assert.ok(draft?.notes?.some(n=>n.text===text&&draft.noteCrops?.[n.id]?.capture));},'real note crop saved');
  }
  await typeOverlay('.bar-message','Refine the hero: calmer typography and a clearer call to action.');
  await clickOverlay('[data-action="review"]');
  const draft=await until(async()=>{
    const value=await savedDraft();assert.ok(value?.snapshot?.screenshot?.data_base64);
    assert.equal(value.snapshot.crops.length,2);assert.equal(value.notes.length,2);
    assert.equal(value.snapshot.annotations.length,2);
    assert.equal(value.message,'Refine the hero: calmer typography and a clearer call to action.');
    assert.equal(value.snapshot.url,page.url());
    assert.equal(await overlay(root=>root.querySelector('.send')?.disabled),false);
    return value;
  },'review with actual Chrome capture');
  assert.deepEqual(draft.snapshot.annotations.map(n=>n.number),[1,2]);
  assert.deepEqual(draft.snapshot.crops.map(c=>c.number),[1,2]);
  assert.equal(draft.snapshot.viewport.width,1440);assert.equal(draft.snapshot.viewport.height,960);
  assert.ok(draft.snapshot.crops.every(c=>c.capture.captured_at&&c.capture.annotation_rect&&c.capture.rect));
  // Decode the real captured bitmap and verify the editable field is masked.
  const email=await page.locator('#email').boundingBox();
  const maskPixel=await overlay(async(_root,{data,x,y})=>{
    const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();
    const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;
    const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
    return {pixel:[...ctx.getImageData(Math.floor(x*image.width/innerWidth),Math.floor(y*image.height/innerHeight),1,1).data],width:image.width,height:image.height};
  },{data:draft.snapshot.screenshot.data_base64,x:email.x+email.width/2,y:email.y+email.height/2});
  assert.ok(maskPixel.width>0&&maskPixel.width<=1440&&maskPixel.height>0&&maskPixel.height<=960);
  assert.ok(Math.abs(maskPixel.height-maskPixel.width*960/1440)<=2,'capture preserves viewport dimensions or proportional downsampling');
  assert.deepEqual(maskPixel.pixel,[34,45,36,255],'production capture masks the private input');
  await until(async()=>assert.equal(await overlay(root=>[...root.querySelectorAll('.capture img,.note-row img')].every(i=>i.complete&&i.naturalWidth>0)),true),'preview images loaded');
  const output=fileURLToPath(new URL('../../docs/screenshots/browser-feedback.png',import.meta.url));
  await mkdir(fileURLToPath(new URL('../../docs/screenshots/',import.meta.url)),{recursive:true});
  await page.mouse.move(30,920);
  await page.screenshot({path:output});
  console.log(`Saved ${output}: actual Chrome extension, production capture, two numbered crops, and verified privacy mask. No feedback submitted.`);
}finally{
  await context?.close();if(server)await new Promise(resolve=>server.close(resolve));
  await rm(profile,{recursive:true,force:true});
}
