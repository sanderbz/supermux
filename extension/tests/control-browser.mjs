import {chromium} from '../../web/node_modules/playwright/index.mjs';
import {rolldown} from '../../web/node_modules/rolldown/dist/index.mjs';
import {createRequire} from 'node:module';
import {mkdtemp,rm,cp,readFile,writeFile,mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const {wsServer:WebSocketServer}=createRequire(import.meta.url)('../../web/node_modules/playwright-core/lib/utilsBundle.js');
const stage=name=>console.log('control fixture:',name);
const profile=await mkdtemp(join(tmpdir(),'supermux-control-'));
let context,server,wss,socket,auth,connectionId;
const pending=new Map();let requestCount=0,resultCount=0,progressCount=0,wireBytes=0;
const css=`body{margin:0;background:#f4f6ef;color:#29382b;font:15px system-ui}main{max-width:950px;margin:70px auto}header{margin-bottom:35px}.eyebrow{font-size:11px;letter-spacing:2px;color:#65745c}h1{font-size:40px;letter-spacing:-1.5px;margin:12px 0}p{color:#63715c}section{background:#fdfefa;border:1px solid #e1e7d9;border-radius:22px;padding:28px;display:grid;grid-template-columns:1fr 1fr;gap:18px}h2{grid-column:1/-1;font-size:19px;margin:0 0 12px}label{display:grid;gap:8px;font-size:12px;color:#607055}input,select,[contenteditable]{font:15px system-ui;border:1px solid #d5decc;border-radius:9px;padding:12px;background:white;color:#29382b}button{border:0;border-radius:9px;background:#31452d;color:#fff;font:14px system-ui;padding:13px}output{align-self:center;color:#62705a}iframe{grid-column:1/-1;border:1px solid #d5decc;border-radius:12px;width:100%;height:125px}canvas{background:#e2eada;border-radius:8px}`;
function call(steps,timeout_ms=10000){
  const id=randomUUID();requestCount++;const frame=JSON.stringify({type:'command',id,steps,timeout_ms});wireBytes+=Buffer.byteLength(frame);
  return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('Browser batch timed out in fixture'));},timeout_ms+3000);pending.set(id,{resolve,reject,timer});socket.send(frame);});
}
async function okay(steps){const result=await call(steps);assert.equal(result.ok,true,JSON.stringify(result.error));assert.equal(result.completed,steps.length);return result.results;}
async function until(check,label){const end=Date.now()+7000;let error;while(Date.now()<end){try{return await check();}catch(e){error=e;}await new Promise(r=>setTimeout(r,30));}throw new Error(`${label}: ${error?.message||'timed out'}`);}
try {
  stage('bundle');const bundle=await rolldown({input:fileURLToPath(new URL('fixtures/control-page.jsx',import.meta.url)),platform:'browser',transform:{jsx:{runtime:'classic'},define:{'process.env.NODE_ENV':'"production"'}}});
  const generated=await bundle.generate({format:'iife'});await bundle.close();const app=generated.output.find(o=>o.type==='chunk').code;
  server=createServer(async(req,res)=>{
    if(req.url==='/app.js'){res.setHeader('Content-Type','text/javascript');res.end(app);return;}
    if(req.url.startsWith('/cross')){res.end(`<title>Cross-origin frame</title><style>body{padding:15px;font:14px system-ui}iframe{margin:15px 25px;width:500px;height:120px}</style><input aria-label="Cross-origin input" id="cross-input" oninput="window.frameTrusted=event.isTrusted"><iframe title="Nested frame" src="/frame?nested=1"></iframe>`);return;}
    if(req.url.startsWith('/frame')){res.setHeader('Content-Type','text/html');res.end(`<style>body{font:14px system-ui;padding:10px}input{padding:10px;width:75%}</style><label>Frame input<input aria-label="Frame input" id="frame-input" oninput="window.frameTrusted=event.isTrusted"></label>`);return;}
    if(req.url.startsWith('/next')){await new Promise(r=>setTimeout(r,250));res.end('<title>Next document</title><h1 id="next">Navigation completed</h1>');return;}
    res.setHeader('Content-Type','text/html');res.end(`<!doctype html><title>Release checklist</title><style>${css}</style><div id="app"></div><script src="/app.js"></script>`);
  });
  wss=new WebSocketServer({server,path:'/api/browser/control/ws'});
  wss.on('connection',ws=>{
    ws.on('message',data=>{const frame=JSON.parse(data.toString());wireBytes+=data.length;
      if(frame.type==='auth'){assert.equal(frame.version,1);assert.equal(frame.token,'synthetic-control-token');auth=frame;socket=ws;connectionId=randomUUID();ws.send(JSON.stringify({type:'ready',lease_id:frame.lease_id,connection_id:connectionId}));return;}
      if(frame.type==='ping'){ws.send('{"type":"pong"}');return;}
      if(frame.type==='progress'){progressCount++;return;}
      if(frame.type==='result'){resultCount++;const wait=pending.get(frame.id);if(wait){clearTimeout(wait.timer);pending.delete(frame.id);wait.resolve(frame);}}
    });
  });
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const site=`http://127.0.0.1:${server.address().port}`;
  const extension=join(profile,'extension');await cp(fileURLToPath(new URL('../dist/',import.meta.url)),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*','http://localhost/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  stage('launch');context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:process.env.HEADED!=='1',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1440,height:960}});
  stage('page');const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');const page=await context.newPage();await page.goto(site);await page.locator('#approve').waitFor();
  stage('inject');const tabId=await worker.evaluate(async({site,url})=>{const [tab]=await chrome.tabs.query({url});await chrome.storage.local.set({connection:{origin:site,epoch:'fixture-epoch',bindings:{[site]:{id:'fixture-binding',token:'synthetic-control-token',session:'release-agent',session_label:'Release agent',company_label:'Example company'}},pending:{}}});await chrome.storage.session.set({annotationTabs:{[tab.id]:tab.url}});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});return tab.id;},{site,url:page.url()});
  await page.locator('[data-supermux-control]').waitFor();const cdp=await context.newCDPSession(page);
  function hostNode(node,attribute='data-supermux-control'){if(node.attributes?.includes(attribute))return node;for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const found=hostNode(child,attribute);if(found)return found;}}
  async function ui(fn,arg,attribute){const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});const shadow=hostNode(root,attribute)?.shadowRoots?.[0];assert.ok(shadow);const {object}=await cdp.send('DOM.resolveNode',{nodeId:shadow.nodeId});try{const value=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(arg){return (${fn.toString()})(this,arg)}`,arguments:[{value:arg??null}],returnByValue:true,awaitPromise:true});assert.equal(value.exceptionDetails,undefined);return value.result.value;}finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}}
  async function press(action){const p=await ui((root,action)=>{const b=root.querySelector(`[data-action="${action}"]`),r=b?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;},action);assert.ok(p,action);await page.mouse.click(p.x,p.y);}
  stage('immediate annotation persistence');await page.locator('#approve').click();
  const editorPoint=await ui(root=>{const r=root.querySelector('.editor textarea').getBoundingClientRect();return{x:r.x+40,y:r.y+30};},null,'data-supermux-overlay');await page.mouse.click(editorPoint.x,editorPoint.y);await page.keyboard.insertText('Keep this label clear.');
  stage('allow');await press('allow');await until(async()=>{assert.ok(socket);assert.equal(await ui(root=>root.querySelector('.stop')?.textContent),'Stop');},'native Allow control');
  const persisted=await worker.evaluate(async()=>Object.entries(await chrome.storage.local.get(null)).find(([key])=>key.startsWith('draft:'))?.[1]);assert.equal(persisted.draft.notes[0].text,'Keep this label clear.','Allow flushes latest annotation before agent commands');
  stage('snapshot');const [snapshot]=await okay([{action:'snapshot'}]);assert.ok(snapshot.nodes.some(n=>n.name==='Release name'));assert.ok(!snapshot.nodes.some(n=>/Allow control|Stop|Page annotation|Pick an element/.test(n.name)),'own controls excluded');
  stage('trusted input');const [clicked,filled,value]=await okay([{action:'click',selector:'#approve'},{action:'fill',selector:'#name',text:'October release'},{action:'evaluate',expression:'({clicks:document.querySelector("#click-count").textContent,name:document.querySelector("#name-state").textContent,clickTrusted,inputTrusted})'}]);
  assert.equal(value.clicks,'1');assert.equal(value.name,'October release');assert.equal(value.clickTrusted,true);assert.equal(value.inputTrusted,true);
  assert.equal(await page.locator('[data-supermux-overlay]').evaluate(el=>el.classList.contains('control-active')),true,'annotation picking suspended');
  const rootBefore=await page.locator('#click-count').innerText();const wrongFrame=await call([{action:'click',selector:'#approve',frame:'missing-frame'}]);assert.equal(wrongFrame.error.code,'stale_frame');assert.equal(await page.locator('#click-count').innerText(),rootBefore,'unknown frame cannot click root match');
  const frame=snapshot.frames.find(f=>f.parent_id);assert.ok(frame);
  await okay([{action:'fill',frame:frame.id,selector:'#frame-input',text:'Trusted frame edit'},{action:'evaluate',frame:frame.id,expression:'({value:document.querySelector("input").value,trusted:frameTrusted})'}]).then(result=>{assert.equal(result[1].value,'Trusted frame edit');assert.equal(result[1].trusted,true);});
  stage('references and trusted controls');
  const oldRef=snapshot.nodes.find(n=>n.name==='Approve release'&&n.role==='button').ref;
  const [freshSnapshot]=await okay([{action:'snapshot'}]);const freshRef=freshSnapshot.nodes.find(n=>n.name==='Approve release'&&n.role==='button').ref;await okay([{action:'click',ref:freshRef}]);const stale=await call([{action:'click',ref:oldRef}]);assert.equal(stale.ok,false);assert.equal(stale.error.code,'stale_ref');assert.equal(stale.outcome_unknown,false);
  await okay([{action:'fill',selector:'#editable',text:'Updated release notes'},{action:'key',selector:'#channel',key:'s'},{action:'key',key:'Enter'}]);
  assert.equal(await page.locator('#editable').innerText(),'Updated release notes');assert.equal(await page.locator('#channel').inputValue(),'Stable');
  const canvas=await page.locator('#canvas').boundingBox();await okay([{action:'click',x:canvas.x+30,y:canvas.y+20,click_count:2}]);assert.equal(await page.evaluate(()=>window.canvasDouble&&window.canvasTrusted),true);
  const duplicate=await call([{action:'click',selector:'input,select'}]);assert.equal(duplicate.ok,false);assert.equal(duplicate.error.code,'invalid_selector');
  stage('out-of-process and nested frames');
  await page.evaluate(url=>{const iframe=document.createElement('iframe');iframe.id='cross-frame';iframe.title='Cross-origin embedded tool';iframe.src=url;iframe.style.cssText='position:absolute;left:160px;top:820px;width:800px;height:220px';document.body.append(iframe);},site.replace('127.0.0.1','localhost')+'/cross');
  await page.frameLocator('#cross-frame').locator('#cross-input').waitFor();
  const [crossSnapshot]=await okay([{action:'snapshot'}]);
  const crossFrame=crossSnapshot.frames.find(f=>f.url.includes('/cross'));const nestedFrame=crossSnapshot.frames.find(f=>f.url.includes('nested=1'));assert.ok(crossFrame);assert.ok(nestedFrame);
  await page.locator('#cross-frame').scrollIntoViewIfNeeded();
  const crossResults=await okay([{action:'click',selector:'#cross-input',frame:crossFrame.id},{action:'fill',selector:'#cross-input',frame:crossFrame.id,text:'Cross-process edit'},{action:'evaluate',frame:crossFrame.id,expression:'({value:document.querySelector("input").value,trusted:frameTrusted})'},{action:'click',selector:'#frame-input',frame:nestedFrame.id},{action:'fill',selector:'#frame-input',frame:nestedFrame.id,text:'Nested edit'},{action:'evaluate',frame:nestedFrame.id,expression:'({value:document.querySelector("input").value,trusted:frameTrusted})'}]);
  assert.deepEqual(crossResults[2],{value:'Cross-process edit',trusted:true});assert.deepEqual(crossResults[5],{value:'Nested edit',trusted:true});
  await page.evaluate(()=>document.querySelector('#cross-frame').remove());await page.evaluate(()=>scrollTo(0,0));
  const priorLease=auth.lease_id;await press('stop');await until(async()=>assert.equal(await ui(root=>root.querySelector('.allow')?.textContent),'Allow control'),'Stop');socket=null;await press('allow');await until(async()=>{assert.ok(socket);assert.notEqual(auth.lease_id,priorLease);},'rapid Stop then Allow');await okay([{action:'evaluate',expression:'document.title'}]);
  stage('navigation');const [nav,title]=await okay([{action:'navigate',url:site+'/next'},{action:'evaluate',expression:'document.title'}]);assert.equal(title,'Next document');
  await okay([{action:'back'}]);await page.locator('#approve').waitFor();await page.locator('[data-supermux-control]').waitFor();
  // A genuine reload reopens the annotation extension; its saved draft must survive takeover navigation.
  await worker.evaluate(async id=>{await chrome.scripting.executeScript({target:{tabId:id},files:['content.js']});},tabId);
  await until(async()=>assert.equal(await ui(root=>root.querySelector('button.pin')?.textContent,null,'data-supermux-overlay'),'1'),'restored annotation after navigation');
  const restored=await worker.evaluate(async()=>Object.entries(await chrome.storage.local.get(null)).find(([key])=>key.startsWith('draft:'))?.[1]);assert.equal(restored.draft.notes[0].text,'Keep this label clear.');
  stage('screenshot');const [image]=await okay([{action:'screenshot'}]);assert.equal(image.mime,'image/png');assert.ok(image.width>0&&image.width<=1800);assert.ok(Buffer.from(image.data_base64,'base64').length<=4*1024*1024);
  stage('scrolled screenshot');
  await page.evaluate(()=>{const panel=document.createElement('div');panel.id='screenshot-marker';panel.textContent='Scrolled viewport marker';panel.style.cssText='position:absolute;left:0;top:1400px;width:100%;height:960px;background:rgb(24,90,140)';document.body.append(panel);scrollTo(0,1400);});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.ok(await page.evaluate(()=>scrollY)>1000);
  const [scrolledImage]=await okay([{action:'screenshot'}]);
  const pixel=await page.evaluate(async data=>{const image=new Image();image.src='data:image/png;base64,'+data;await image.decode();const canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);return [...ctx.getImageData(40,40,1,1).data];},scrolledImage.data_base64);
  assert.deepEqual(pixel,[24,90,140,255],'screenshot captures current scrolled viewport, not document origin');
  await page.evaluate(()=>{document.querySelector('#screenshot-marker').remove();scrollTo(0,0);});
  stage('benchmark');const trials=[];for(let i=0;i<20;i++){for(const batch of i%2?[false,true]:[true,false]){const requests=requestCount,results=resultCount,bytes=wireBytes,started=performance.now();const steps=[{action:'click',selector:'#approve'},{action:'fill',selector:'#name',text:'Measured release'},{action:'evaluate',expression:'({name:document.querySelector("#name-state").textContent,clicks:document.querySelector("#click-count").textContent})'}];if(batch)await okay(steps);else for(const step of steps)await okay([step]);trials.push({batch,ms:performance.now()-started,requests:requestCount-requests,results:resultCount-results,bytes:wireBytes-bytes});}}
  const stats=mode=>{const rows=trials.filter(t=>t.batch===mode);return {trials:rows.length,median_ms:rows.map(t=>t.ms).sort((a,b)=>a-b)[10],requests:rows[0].requests,result_frames:rows[0].results,mean_bytes:Math.round(rows.reduce((n,t)=>n+t.bytes,0)/rows.length)};};
  await okay([{action:'fill',selector:'#name',text:'October release'},{action:'fill',selector:'#editable',text:'Release notes ready'},{action:'key',selector:'#channel',key:'s'},{action:'key',key:'Enter'}]);
  // Restore fixture presentation after measurement; production UI remains untouched.
  await page.evaluate(()=>{document.querySelector('#click-count').textContent='2';});
  await mkdir(fileURLToPath(new URL('../../docs/screenshots/',import.meta.url)),{recursive:true});await page.evaluate(()=>document.activeElement?.blur());await page.screenshot({path:fileURLToPath(new URL('../../docs/screenshots/browser-control.png',import.meta.url))});
  const screenshotFile=fileURLToPath(new URL('../../docs/screenshots/browser-control.png',import.meta.url));
  stage('immediate SPA Stop');await okay([{action:'evaluate',expression:'history.pushState({},"","/spa-route");location.pathname'}]);await press('stop');await until(async()=>assert.equal(await ui(root=>root.querySelector('.allow')?.textContent),'Allow control'),'native Stop immediately after SPA navigation');socket=null;await press('allow');await until(async()=>assert.ok(socket,await ui(root=>root.querySelector('.message')?.textContent)),'Allow again on SPA route');await okay([{action:'evaluate',expression:'document.title'}]);
  stage('cancel and no replay');const pendingAction=call([{action:'evaluate',expression:'new Promise(r=>{window.actionStarted=true;setTimeout(()=>r(1),250);})'},{action:'evaluate',expression:'window.mustNotRun=true'}],2000);
  await page.waitForFunction(()=>window.actionStarted===true);await press('stop');await until(async()=>assert.equal(await ui(root=>root.querySelector('.allow')?.textContent),'Allow control'),'Stop during pending action');await new Promise(r=>setTimeout(r,350));assert.equal(await page.evaluate(()=>window.mustNotRun),undefined,'Stop prevents later step');
  pendingAction.catch(()=>{});for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('Stopped fixture batch'));}pending.clear();
  console.log(JSON.stringify({screenshot:screenshotFile,passed:'real Allow/Stop, trusted React click/fill, nonzero-offset iframe, delayed navigation, screenshot, lease renewal',benchmark:{batch:stats(true),separate:stats(false)},progress_frames:progressCount}));
}finally{stage('cleanup');for(const wait of pending.values())clearTimeout(wait.timer);await context?.close();for(const client of wss?.clients||[])client.terminate();wss?.close();server?.closeAllConnections();await new Promise(r=>server?.close(r)||r());await rm(profile,{recursive:true,force:true});}
