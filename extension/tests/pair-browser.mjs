// Real Chromium: claimed code, then ONE click in the extension's confirmation
// connects the shown agent and origin and starts control on the original tab.
import {chromium} from '../../web/node_modules/playwright/index.mjs';
import {createRequire} from 'node:module';
import {mkdtemp,rm,cp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import assert from 'node:assert/strict';
const {wsServer:WebSocketServer}=createRequire(import.meta.url)('../../web/node_modules/playwright-core/lib/utilsBundle.js');
const stage=name=>console.log('pair fixture:',name);
const profile=await mkdtemp(join(tmpdir(),'supermux-pair-'));
let context,server,wss,auth=null,claimed=false,site;
async function until(check,label){const end=Date.now()+10000;let error;while(Date.now()<end){try{return await check();}catch(e){error=e;}await new Promise(r=>setTimeout(r,40));}throw new Error(`${label}: ${error?.message||'timed out'}`);}
const json=(res,data)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));};
try{
  server=createServer((req,res)=>{
    if(req.method==='POST'&&req.url==='/api/browser/pairings'){json(res,{id:'pair-1',code:'4821',poll_token:'synthetic-poll',expires_at:new Date(Date.now()+300000).toISOString()});return;}
    if(req.url==='/api/browser/pairings/pair-1'){json(res,claimed?{status:'paired',binding:{id:'binding-1',origin:site,session:'release-agent',session_label:'Release agent',company_id:1,company_label:'Example company',token:'synthetic-control-token'}}:{status:'pending'});return;}
    res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Pairing fixture</title><h1 id="page">Release checklist</h1>');
  });
  wss=new WebSocketServer({server,path:'/api/browser/control/ws'});
  wss.on('connection',ws=>ws.on('message',data=>{const frame=JSON.parse(data.toString());if(frame.type==='auth'){auth=frame;ws.send(JSON.stringify({type:'ready',lease_id:frame.lease_id,connection_id:'fixture-connection'}));}if(frame.type==='ping')ws.send('{"type":"pong"}');}));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));site=`http://127.0.0.1:${server.address().port}`;
  const extension=join(profile,'extension');await cp(fileURLToPath(new URL('../dist/',import.meta.url)),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  stage('launch');context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:process.env.HEADED!=='1',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],viewport:{width:1280,height:860}});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();await page.goto(site);await page.locator('#page').waitFor();
  stage('open annotation');await worker.evaluate(async({site,url})=>{const [tab]=await chrome.tabs.query({url});await chrome.storage.local.set({connection:{origin:site,epoch:'fixture-epoch',bindings:{},pending:{}}});await chrome.storage.session.set({annotationTabs:{[tab.id]:tab.url}});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});},{site,url:page.url()});
  const cdp=await context.newCDPSession(page);
  function hostNode(node,attribute){if(node.attributes?.includes(attribute))return node;for(const child of [...(node.children||[]),...(node.shadowRoots||[])]){const found=hostNode(child,attribute);if(found)return found;}}
  async function ui(fn,attribute){const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});const shadow=hostNode(root,attribute)?.shadowRoots?.[0];assert.ok(shadow,attribute);const {object}=await cdp.send('DOM.resolveNode',{nodeId:shadow.nodeId});try{const value=await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){return (${fn.toString()})(this)}`,returnByValue:true});return value.result.value;}finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId});}}
  stage('connect from the page');
  const point=await until(async()=>{const p=await ui(root=>{const r=root.querySelector('.connection-control')?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;},'data-supermux-overlay');assert.ok(p);return p;},'connection control');
  const settingsOpened=context.waitForEvent('page');await page.mouse.click(point.x,point.y);const settings=await settingsOpened;
  assert.ok(new URL(settings.url()).searchParams.get('from'),'settings page carries the worker-issued nonce');
  stage('code shown');await settings.locator('#code').filter({hasText:'4821'}).waitFor();
  claimed=true;// The user enters 4821 in the Supermux dashboard.
  stage('single consent');await settings.locator('#confirmation:not([hidden])').waitFor({timeout:10000});
  assert.equal(await settings.locator('#confirm-site').innerText(),site);
  assert.equal(await settings.locator('#confirm-target').innerText(),'Example company · Release agent (release-agent)');
  assert.equal(await settings.locator('#confirm').innerText(),'Connect and allow control');
  assert.equal(auth,null,'no control before consent');
  await settings.locator('#confirm').click();
  await until(()=>assert.ok(auth),'control socket after one click');
  assert.equal(auth.origin,site);assert.equal(auth.binding_id,'binding-1');assert.equal(auth.token,'synthetic-control-token');assert.equal(new URL(auth.url).origin,site);
  await settings.locator('#connected:not([hidden])').waitFor();
  assert.match(await settings.locator('#connected-site').innerText(),/now controls the tab you started from/);
  stage('stop pill on the original tab');
  await until(async()=>assert.equal(await ui(root=>root.querySelector('.stop')?.textContent,'data-supermux-control'),'Stop'),'Stop pill');
  const stopPoint=await ui(root=>{const r=root.querySelector('.stop').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},'data-supermux-control');
  await page.mouse.click(stopPoint.x,stopPoint.y);
  await until(async()=>assert.equal(await ui(root=>root.querySelector('.allow')?.textContent,'data-supermux-control'),'Allow control'),'pill offers one-click Allow control again');
  console.log(JSON.stringify({passed:'code, one consent click, control on originating tab, Stop, pill reconnect available'}));
}finally{stage('cleanup');await context?.close();for(const client of wss?.clients||[])client.terminate();wss?.close();server?.closeAllConnections?.();await new Promise(r=>server?.close(r)||r());await rm(profile,{recursive:true,force:true});}
