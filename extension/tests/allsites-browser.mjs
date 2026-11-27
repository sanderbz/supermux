// Real Chromium: an All websites pairing needs the red confirmation, then the
// controlled tab may leave the paired website (with the All websites pill in
// an isolated world), and landing on a blocked site ends control.
import {chromium} from '../../web/node_modules/playwright/index.mjs';
import {createRequire} from 'node:module';
import {mkdtemp,rm,cp,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
const {wsServer:WebSocketServer}=createRequire(import.meta.url)('../../web/node_modules/playwright-core/lib/utilsBundle.js');
const stage=name=>console.log('all-sites fixture:',name);
const profile=await mkdtemp(join(tmpdir(),'supermux-allsites-'));
let context,server,wss,socket=null,auth=null,ready=null,claimed=false,port;
const pairings=[],frames=[],pending=new Map();
async function until(check,label,ms=10000){const end=Date.now()+ms;let error;while(Date.now()<end){try{return await check();}catch(e){error=e;}await new Promise(r=>setTimeout(r,40));}throw new Error(`${label}: ${error?.message||'timed out'}`);}
const json=(res,data)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,data}));};
function call(steps,timeout_ms=8000){const id=randomUUID();return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{pending.delete(id);reject(new Error('batch timed out'));},timeout_ms+2000);pending.set(id,{resolve,timer});socket.send(JSON.stringify({type:'command',id,steps,timeout_ms}));});}
try{
  server=createServer((req,res)=>{
    const host=(req.headers.host||'').split(':')[0];
    if(req.method==='POST'&&req.url==='/api/browser/pairings'){let body='';req.on('data',c=>body+=c);req.on('end',()=>{const b=JSON.parse(body);pairings.push(b);json(res,{id:'pair-'+pairings.length,code:b.scope==='all'?'7777':'1111',poll_token:'synthetic-poll-'+pairings.length,scope:b.scope==='all'?'all':'origin'});});return;}
    if(req.url.startsWith('/api/browser/pairings/pair-')){json(res,claimed&&req.url.endsWith('-2')?{status:'paired',binding:{id:'binding-all',origin:`http://site.test:${port}`,session:'release-agent',session_label:'Release agent',company_id:null,scope:'all',expires_at:Math.floor(Date.now()/1000)+86400,token:'synthetic-control-token'}}:{status:'pending'});return;}
    res.setHeader('Content-Type','text/html');
    if(host==='www.paypal.com'){res.end('<!doctype html><title>Blocked</title><h1 id="bank">Bank</h1>');return;}
    res.end(`<!doctype html><title>${host}</title><h1 id="page">${host}</h1><a id="away" href="http://other.test:${port}/next">Other site</a>`);
  });
  wss=new WebSocketServer({server,path:'/api/browser/control/ws'});
  wss.on('connection',ws=>ws.on('message',data=>{const frame=JSON.parse(data.toString());frames.push(frame);
    if(frame.type==='auth'){auth=frame;socket=ws;ready={type:'ready',lease_id:frame.lease_id,connection_id:'fixture-connection',scope:'all',expires_at:Date.now()+86400000,blocked_sites:['paypal.com'],blocked_hosts:[`127.0.0.1:${port}`]};ws.send(JSON.stringify(ready));}
    if(frame.type==='ping')ws.send('{"type":"pong"}');
    if(frame.type==='result'){const wait=pending.get(frame.id);if(wait){clearTimeout(wait.timer);pending.delete(frame.id);wait.resolve(frame);}}
  }));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));port=server.address().port;
  const server_origin=`http://127.0.0.1:${port}`,site=`http://site.test:${port}`,other=`http://other.test:${port}`;
  const extension=join(profile,'extension');await cp(fileURLToPath(new URL('../dist/',import.meta.url)),extension,{recursive:true});
  const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));manifest.host_permissions=['http://127.0.0.1/*','http://site.test/*'];await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
  stage('launch');context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:process.env.HEADED!=='1',args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`,'--host-resolver-rules=MAP site.test 127.0.0.1, MAP other.test 127.0.0.1, MAP www.paypal.com 127.0.0.1',`--unsafely-treat-insecure-origin-as-secure=${site},${other},http://www.paypal.com:${port}`],viewport:{width:1280,height:860}});
  const worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
  const page=await context.newPage();await page.goto(site);await page.locator('#page').waitFor();
  await worker.evaluate(async({server_origin,url})=>{const [tab]=await chrome.tabs.query({url});await chrome.storage.local.set({connection:{origin:server_origin,epoch:'fixture-epoch',bindings:{},pending:{}}});await chrome.storage.session.set({annotationTabs:{[tab.id]:tab.url}});await chrome.scripting.executeScript({target:{tabId:tab.id},files:['content.js']});},{server_origin,url:page.url()});
  const cdp=await context.newCDPSession(page);
  function hostNode(node,attribute){if(node.attributes?.includes(attribute))return node;for(const child of [...(node.children||[]),...(node.shadowRoots||[]),...(node.contentDocument?[node.contentDocument]:[])]){const found=hostNode(child,attribute);if(found)return found;}}
  async function ui(fn,attribute){const {root}=await cdp.send('DOM.getDocument',{depth:-1,pierce:true});const shadow=hostNode(root,attribute)?.shadowRoots?.[0];assert.ok(shadow,attribute);const {object}=await cdp.send('DOM.resolveNode',{nodeId:shadow.nodeId});try{return (await cdp.send('Runtime.callFunctionOn',{objectId:object.objectId,functionDeclaration:`function(){return (${fn.toString()})(this)}`,returnByValue:true})).result.value;}finally{await cdp.send('Runtime.releaseObject',{objectId:object.objectId}).catch(()=>{});}}
  const point=await until(async()=>{const p=await ui(root=>{const r=root.querySelector('.connection-control')?.getBoundingClientRect();return r?{x:r.x+r.width/2,y:r.y+r.height/2}:null;},'data-supermux-overlay');assert.ok(p);return p;},'connection control');
  const opened=context.waitForEvent('page');await page.mouse.click(point.x,point.y);const settings=await opened;
  stage('single-website code first');await settings.locator('#code').filter({hasText:'1111'}).waitFor();
  assert.deepEqual(pairings,[{origin:site}]);
  stage('red confirmation before the request');await settings.locator('#scope-all').click();
  await settings.locator('#all-sites-warning:not([hidden])').waitFor();
  assert.match(await settings.locator('#all-sites-warning').innerText(),/any website[\s\S]*logged-in accounts[\s\S]*24 hours[\s\S]*except blocked sites/);
  assert.equal(pairings.length,1,'choosing All websites alone sends nothing');
  assert.equal(await settings.locator('#all-sites-warning').evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(253, 241, 236)');
  await settings.locator('#confirm-all').click();await settings.locator('#code').filter({hasText:'7777'}).waitFor();
  assert.deepEqual(pairings[1],{origin:site,scope:'all'});
  claimed=true;
  stage('consent shows scope');await settings.locator('#confirmation:not([hidden])').waitFor();
  assert.match(await settings.locator('#confirm-scope').innerText(),/^All websites · until/);
  assert.equal(await settings.locator('#confirm').innerText(),'Connect and allow control on all websites');
  assert.equal(auth,null);await settings.locator('#confirm').click();
  await until(()=>assert.equal(ready?.connection_id,'fixture-connection'),'control after consent');
  await until(async()=>assert.match(await ui(root=>root.querySelector('[data-scope="all"]')?.textContent||'','data-supermux-control'),/^All websites · until/),'pill on the paired website');
  stage('other website');
  const nav=await call([{action:'navigate',url:other+'/next'}]);assert.equal(nav.ok,true,JSON.stringify(nav.error));assert.equal(nav.origin,other);
  await until(()=>assert.ok(frames.some(f=>f.type==='navigated'&&f.origin===other)),'navigation report');
  await until(async()=>assert.match(await ui(root=>root.querySelector('small')?.textContent||'','data-supermux-control'),/^All websites · until/),'isolated-world pill on the other website');
  const evaluated=await call([{action:'evaluate',expression:'typeof __supermuxAllSitesPill+":"+typeof __supermuxControlStop'}]);
  assert.equal(evaluated.results[0],'undefined:undefined','the page cannot reach the pill or its Stop binding');
  stage('blocked navigate refused');
  const refused=await call([{action:'navigate',url:`http://www.paypal.com:${port}/`}]);assert.equal(refused.ok,false);assert.equal(refused.error.code,'blocked_site');
  assert.equal(page.url(),other+'/next');
  stage('landing on a blocked site ends control');
  const before=frames.length;await page.evaluate(port=>{location.href=`http://www.paypal.com:${port}/`;},port);
  await until(()=>assert.ok(frames.slice(before).some(f=>f.type==='stop'&&f.code==='blocked_site')),'blocked_site stop');
  await page.locator('#bank').waitFor();
  assert.equal(frames.slice(before).some(f=>f.type==='navigated'),false);
  assert.equal(await page.evaluate(()=>!!document.querySelector('[data-supermux-control]')),false,'no pill on the blocked site');
  console.log(JSON.stringify({passed:'red confirmation before request, scope on consent, off-origin navigate with isolated pill, blocked navigate refused, blocked landing ends control'}));
}catch(e){console.log("frames:",JSON.stringify(frames.filter(f=>f.type!=="ping").map(f=>({...f,token:undefined,results:undefined}))));throw e;}finally{stage("cleanup");await context?.close();for(const client of wss?.clients||[])client.terminate();wss?.close();server?.closeAllConnections?.();await new Promise(r=>server?.close(r)||r());await rm(profile,{recursive:true,force:true});}
