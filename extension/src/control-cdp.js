// All browser effects use the debugger attached to one explicitly granted tab.
// `send` checks the grant and the current operation before/after each await.
export const CONTROL_ACTIONS = new Set(['snapshot','click','type','fill','key','scroll','navigate','back','reload','wait','evaluate','screenshot','dialog']);
const error = (code, message) => Object.assign(new Error(message), {code});
const boundedText = (value, limit, name) => {
  if (typeof value !== 'string' || new TextEncoder().encode(value).length > limit) throw error('invalid_action', `Invalid ${name}.`);
  return value;
};
const roleOf = node => node.role?.value || '';
const textOf = value => typeof value === 'string' ? value : value == null ? '' : String(value);
const nodeDescription = `function(){
  const element=this.nodeType===1?this:this.parentElement;
  if(!element)return {connected:false};
  let current=element;
  while(current){
    if(current.closest?.('[data-supermux-overlay],[data-supermux-control]'))return {overlay:true};
    current=current.getRootNode?.().host;
  }
  const rect=element.getBoundingClientRect(),hit=element.ownerDocument.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);
  return {connected:element.isConnected,tag:element.localName,type:element.getAttribute('type'),
    editable:!element.disabled&&!element.readOnly&&(element.isContentEditable||['input','textarea'].includes(element.localName)),
    value:element.localName==='input'&&element.type==='password'?undefined:element.value,
    rect:{x:rect.x,y:rect.y,width:rect.width,height:rect.height},
    hit:!!hit&&(element===hit||element.contains(hit)||hit.contains(element))};
}`;

export function createCdpController({send, origin, check, onMainNavigation, hideUi}) {
  let generation = 0, mainFrame = null, refs = new Map(), serial = 0;
  const childSessions = new Map(), contexts = new Map(), initialization = new Set();
  const frameDocuments = new Map(), frameParents = new Map();
  const scope = frame => ({sessionId: contexts.get(frame)?.sessionId||childSessions.get(frame)||undefined, contextId: contexts.get(frame)?.id});
  async function initSession(sessionId) {
    await send('Runtime.enable', {}, sessionId);
    await send('Page.enable', {}, sessionId);
    await send('DOM.enable', {}, sessionId);
    await send('Target.setAutoAttach', {autoAttach:true,waitForDebuggerOnStart:false,flatten:true,filter:[{type:'iframe',exclude:false},{exclude:true}]}, sessionId);
  }
  async function initialize() {
    await initSession();
    mainFrame = (await send('Page.getFrameTree')).frameTree.frame.id;
  }
  function event(method, params, sessionId) {
    if (method === 'Runtime.executionContextCreated' && params.context.auxData?.isDefault) {
      const context=params.context;
      contexts.set(context.auxData.frameId,{id:context.id,sessionId});
    }
    if (method === 'Runtime.executionContextDestroyed') {
      for(const [frame,context] of contexts) if(context.id===params.executionContextId&&context.sessionId===sessionId) contexts.delete(frame);
    }
    if (method === 'Target.attachedToTarget' && params.targetInfo.type === 'iframe') {
      childSessions.set(params.targetInfo.targetId,params.sessionId);
      const pending=initSession(params.sessionId).catch(()=>{});
      initialization.add(pending);pending.finally(()=>initialization.delete(pending));
    }
    if (method === 'Target.detachedFromTarget') {
      for(const [frame,id] of childSessions) if(id===params.sessionId) {childSessions.delete(frame);contexts.delete(frame);frameDocuments.delete(frame);}
      refs.clear();generation++;
    }
    if (method === 'Page.frameNavigated') {
      const frame=params.frame;frameDocuments.set(frame.id,frame.loaderId);if(frame.parentId)frameParents.set(frame.id,frame.parentId);
      refs.clear();generation++;
      if(!sessionId&&!frame.parentId){mainFrame=frame.id;onMainNavigation(frame.url);}
    }
    if (method === 'DOM.documentUpdated') {refs.clear();generation++;}
  }
  async function evaluate(expression, frame, timeout) {
    const target=frame||mainFrame,{sessionId,contextId}=scope(target);
    if(target!==mainFrame&&!contexts.has(target))throw error('stale_frame','This frame changed. Take a fresh snapshot.');
    const result=await send('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,...(contextId?{contextId}:{}),...(timeout?{timeout}: {})},sessionId);
    if(result.exceptionDetails)throw error('evaluation_failed',result.exceptionDetails.exception?.description||result.exceptionDetails.text||'Page evaluation failed.');
    const value=result.result.value??null;
    if(new TextEncoder().encode(JSON.stringify(value)).length>256*1024)throw error('result_too_large','Page result exceeds 256 KiB. Return a smaller value.');
    return value;
  }
  async function resolve(ref, inspect=true) {
    const entry=refs.get(ref);
    if(!entry||entry.generation!==generation||entry.document!==frameDocuments.get(entry.frame))throw error('stale_ref','This element reference is stale. Take a fresh snapshot.');
    if(entry.frame!==mainFrame&&!contexts.has(entry.frame))throw error('stale_frame','This frame changed. Take a fresh snapshot.');
    const {sessionId,contextId}=scope(entry.frame);
    const result=await send('DOM.resolveNode',{backendNodeId:entry.backendNodeId,...(contextId?{executionContextId:contextId}:{})},sessionId);
    const objectId=result.object?.objectId;
    if(!objectId)throw error('stale_ref','This element is no longer available. Take a fresh snapshot.');
    let info;
    try{
      if(inspect){info=(await send('Runtime.callFunctionOn',{objectId,functionDeclaration:nodeDescription,returnByValue:true},sessionId)).result.value;
        if(!info?.connected||info.overlay)throw error('stale_ref','This element is no longer available. Take a fresh snapshot.');}
      return {...entry,sessionId,objectId,info};
    }catch(e){await release({objectId,sessionId});throw e;}
  }
  async function release({objectId,sessionId}) {try{await send('Runtime.releaseObject',{objectId},sessionId);}catch{}}
  async function target(step) {
    if(step.ref)return resolve(step.ref);
    const selector=boundedText(step.selector,1024,'selector'),frame=step.frame||mainFrame,{sessionId,contextId}=scope(frame);
    if(frame!==mainFrame&&!contexts.has(frame))throw error('stale_frame','This frame changed. Take a fresh snapshot.');
    const result=await send('Runtime.evaluate',{expression:`(()=>{const elements=document.querySelectorAll(${JSON.stringify(selector)});if(elements.length!==1)throw new Error('Selector must match exactly one element');return elements[0]})()`,...(contextId?{contextId}: {})},sessionId);
    if(result.exceptionDetails||!result.result.objectId)throw error('invalid_selector','The selector must match exactly one element.');
    const objectId=result.result.objectId;
    try{
      const info=(await send('Runtime.callFunctionOn',{objectId,functionDeclaration:nodeDescription,returnByValue:true},sessionId)).result.value;
      if(!info?.connected||info.overlay)throw error('invalid_selector','Supermux controls cannot be targeted.');
      const {node}=await send('DOM.describeNode',{objectId},sessionId);
      return {objectId,sessionId,frame,backendNodeId:node.backendNodeId,info};
    }catch(e){await release({objectId,sessionId});throw e;}
  }
  async function rootPoint(x,y,frame,sessionId) {
    if(!sessionId)return {x,y};
    const targetFrame=[...childSessions].find(([,id])=>id===sessionId)?.[0];
    if(!targetFrame)throw error('stale_frame','This frame changed. Take a fresh snapshot.');
    const parent=frameParents.get(targetFrame);
    if(!parent)throw error('stale_frame','The parent frame is not available.');
    const parentScope=scope(parent);
    const owner=await send('DOM.getFrameOwner',{frameId:targetFrame},parentScope.sessionId);
    const {model}=await send('DOM.getBoxModel',{backendNodeId:owner.backendNodeId},parentScope.sessionId);
    const viewport=await evaluate('({width:innerWidth,height:innerHeight})',targetFrame),quad=model.content;
    const point={x:quad[0]+x/viewport.width*(quad[2]-quad[0])+y/viewport.height*(quad[6]-quad[0]),y:quad[1]+x/viewport.width*(quad[3]-quad[1])+y/viewport.height*(quad[7]-quad[1])};
    return rootPoint(point.x,point.y,parent,parentScope.sessionId);
  }
  async function elementPoint(node) {
    // CDP quads already include same-process iframe offsets. An OOPIF's quads
    // are local to its target and need its frame owner's transform applied.
    const {quads}=await send('DOM.getContentQuads',{backendNodeId:node.backendNodeId},node.sessionId);
    const quad=quads?.[0];if(!quad)throw error('element_obscured','This element has no visible bounds.');
    return rootPoint((quad[0]+quad[2]+quad[4]+quad[6])/4,(quad[1]+quad[3]+quad[5]+quad[7])/4,node.frame,node.sessionId);
  }
  async function framePoint(x,y,frame=mainFrame) {
    if(frame===mainFrame)return {x,y};
    const parent=frameParents.get(frame);if(!parent)throw error('stale_frame','The parent frame is not available.');
    const parentScope=scope(parent),owner=await send('DOM.getFrameOwner',{frameId:frame},parentScope.sessionId);
    const {model}=await send('DOM.getBoxModel',{backendNodeId:owner.backendNodeId},parentScope.sessionId);
    const viewport=await evaluate('({width:innerWidth,height:innerHeight})',frame),q=model.content;
    return rootPoint(q[0]+x/viewport.width*(q[2]-q[0])+y/viewport.height*(q[6]-q[0]),q[1]+x/viewport.width*(q[3]-q[1])+y/viewport.height*(q[7]-q[1]),parent,parentScope.sessionId);
  }
  async function snapshot() {
    await Promise.all([...initialization]);
    const tree=(await send('Page.getFrameTree')).frameTree,frames=[];
    function visit(item){if(!frames.some(f=>f.id===item.frame.id))frames.push(item.frame);if(item.frame.parentId)frameParents.set(item.frame.id,item.frame.parentId);for(const child of item.childFrames||[])visit(child);}
    visit(tree);for(const id of new Set(childSessions.values()))visit((await send('Page.getFrameTree',{},id)).frameTree);
    generation++;refs=new Map();const nodes=[],frameInfo=[],domFilters=new Map();let truncated=false,total=0;
    for(const [index,frame] of frames.entries()){
      const {sessionId}=scope(frame.id);
      frameInfo.push({id:frame.id,url:frame.url,parent_id:frame.parentId||null});
      if(!domFilters.has(sessionId)){
        const {root}=await send('DOM.getDocument',{depth:-1,pierce:true},sessionId),excluded=new Set(),passwords=new Set();
        function filter(node,blocked=false,password=false){
          const attributes=node.attributes||[],attrs={};for(let i=0;i<attributes.length;i+=2)attrs[attributes[i]]=attributes[i+1];
          blocked=blocked||Object.hasOwn(attrs,'data-supermux-overlay')||Object.hasOwn(attrs,'data-supermux-control');
          password=password||attrs.type?.toLowerCase()==='password';
          if(blocked)excluded.add(node.backendNodeId);if(password)passwords.add(node.backendNodeId);
          for(const child of [...(node.children||[]),...(node.shadowRoots||[]),...(node.contentDocument?[node.contentDocument]:[])])filter(child,blocked,password);
        }
        filter(root);domFilters.set(sessionId,{excluded,passwords});
      }
      const {excluded,passwords}=domFilters.get(sessionId);let ax;
      try{ax=(await send('Accessibility.getFullAXTree',{frameId:frame.id},sessionId)).nodes;}catch(e){check();if(frame.id===mainFrame)throw e;continue;}
      for(const node of ax){
        const role=roleOf(node),name=textOf(node.name?.value).slice(0,1500);
        if(node.ignored||!node.backendDOMNodeId||excluded.has(node.backendDOMNodeId)||['none','generic','InlineTextBox'].includes(role)||(!name&&!node.value))continue;
        if(nodes.length>=1200){truncated=true;break;}
        const ref=`p${generation}-f${index}-e${++serial}`;
        const entry={generation,frame:frame.id,document:frameDocuments.get(frame.id),backendNodeId:node.backendDOMNodeId};
        refs.set(ref,entry);const item={ref,frame:frame.id,role,name};
        if(!passwords.has(node.backendDOMNodeId)&&node.value?.value!==undefined)item.value=textOf(node.value.value).slice(0,1500);
        if(node.properties?.some(p=>p.name==='disabled'&&p.value?.value))item.disabled=true;
        total+=new TextEncoder().encode(JSON.stringify(item)).length;
        if(total>128*1024){truncated=true;refs.delete(ref);break;}
        nodes.push(item);
      }
      if(truncated)break;
    }
    const page=await evaluate('({url:location.href,title:document.title})');
    return {...page,generation,frames:frameInfo,nodes,truncated};
  }
  async function focused(step) {
    const resolved=await target(step);
    try{await send('DOM.focus',{backendNodeId:resolved.backendNodeId},resolved.sessionId);return resolved;}catch(e){await release(resolved);throw e;}
  }
  async function key(key, modifiers=[], sessionId) {
    boundedText(key,64,'key');
    const flags={Alt:1,Control:2,Meta:4,Shift:8};
    if(!Array.isArray(modifiers)||modifiers.some(value=>!Object.hasOwn(flags,value)))throw error('invalid_action','Invalid key modifiers.');
    const keys={Enter:['Enter',13],Tab:['Tab',9],Escape:['Escape',27],Backspace:['Backspace',8],Delete:['Delete',46],ArrowLeft:['ArrowLeft',37],ArrowUp:['ArrowUp',38],ArrowRight:['ArrowRight',39],ArrowDown:['ArrowDown',40],Home:['Home',36],End:['End',35],PageUp:['PageUp',33],PageDown:['PageDown',34],' ':['Space',32]};
    const [code,virtual]=keys[key]||[key.length===1?'Key'+key.toUpperCase():key,key.length===1?key.toUpperCase().charCodeAt(0):0];
    const params={key,code,windowsVirtualKeyCode:virtual,modifiers:modifiers.reduce((n,value)=>n|flags[value],0)};
    const text=!modifiers.length?(key==='Enter'?'\r':key.length===1?key:''):'';
    await send('Input.dispatchKeyEvent',{...params,type:text?'keyDown':'rawKeyDown',...(text?{text,unmodifiedText:text}: {})},sessionId);
    await send('Input.dispatchKeyEvent',{...params,type:'keyUp'},sessionId);
  }
  async function wait(step, deadline) {
    if(step.selector!==undefined)boundedText(step.selector,1024,'selector');
    if(!['ready','visible','hidden'].includes(step.state||'ready'))throw error('invalid_action','Invalid wait state.');
    const until=Math.min(deadline,Date.now()+Math.min(30000,step.timeout_ms??30000));
    while(Date.now()<until){
      check();let ready;
      if(step.ref){let node;try{node=await resolve(step.ref);ready=node.info.rect.width>0&&node.info.rect.height>0;}finally{if(node)await release(node);}}
      else if(step.selector)ready=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(step.selector)});return !!e&&!!(e.getBoundingClientRect().width&&e.getBoundingClientRect().height)})()`,step.frame);
      else ready=await evaluate("document.readyState!=='loading'",step.frame);
      if(step.state==='hidden'?!ready:ready)return {ready:true};
      await new Promise(resolve=>setTimeout(resolve,60));check();
    }
    throw error('wait_timeout','The page condition did not become ready.');
  }
  async function execute(step, deadline) {
    check();if(!step||!CONTROL_ACTIONS.has(step.action))throw error('invalid_action','Unsupported browser action.');
    if(step.action==='snapshot')return snapshot();
    if(step.action==='evaluate')return evaluate(boundedText(step.expression,16384,'expression'),step.frame,Math.max(1,deadline-Date.now()));
    if(step.action==='wait')return wait(step,deadline);
    if(step.action==='click'){
      const button=step.button||'left',count=step.click_count??1;
      if(!['left','right','middle'].includes(button)||![1,2].includes(count))throw error('invalid_action','Invalid mouse button or click count.');
      let node,point;
      try{
        if(step.ref||step.selector){
          node=await target(step);await send('DOM.scrollIntoViewIfNeeded',{backendNodeId:node.backendNodeId},node.sessionId);
          const info=(await send('Runtime.callFunctionOn',{objectId:node.objectId,functionDeclaration:nodeDescription,returnByValue:true},node.sessionId)).result.value;
          if(!info?.connected||info.overlay||!info.hit||info.rect.width<=0||info.rect.height<=0)throw error('element_obscured','The element cannot be clicked here. Take a fresh snapshot or scroll.');
          point=await elementPoint(node);
        }else{
          const viewport=await evaluate('({width:innerWidth,height:innerHeight})',step.frame);
          if(!Number.isFinite(step.x)||!Number.isFinite(step.y)||step.x<0||step.y<0||step.x>=viewport.width||step.y>=viewport.height)throw error('invalid_action','Click coordinates must be inside the viewport.');
          const blocked=await evaluate(`(()=>{let e=document.elementFromPoint(${step.x},${step.y});while(e){if(e.closest?.('[data-supermux-overlay],[data-supermux-control]'))return true;e=e.getRootNode?.().host;}return false})()`,step.frame);
          if(blocked)throw error('element_obscured','Supermux controls cannot be targeted.');
          point=await framePoint(step.x,step.y,step.frame||mainFrame);
        }
        for(let clickCount=1;clickCount<=count;clickCount++){
          await send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button,clickCount});
          await send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button,clickCount});
        }
        return {clicked:true};
      }finally{if(node)await release(node);}
    }
    if(step.action==='type'||step.action==='fill'){
      const text=boundedText(step.text,16384,'text'),node=await focused(step);
      try{
        if(!node.info.editable)throw error('not_editable','This element is not editable.');
        if(step.action==='fill'||step.clear){
          await send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',commands:['selectAll']});
          await send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA'});
          if(!text)await key('Backspace');
        }
        if(text)await send('Input.insertText',{text});
        return {typed:true};
      }finally{await release(node);}
    }
    if(step.action==='key'){
      let node;try{if(step.ref||step.selector)node=await focused(step);await key(step.key,step.modifiers||[]);return {pressed:true};}finally{if(node)await release(node);}
    }
    if(step.action==='scroll'){
      let node;try{
        if(step.ref||step.selector)node=await target(step);
        const viewport=await evaluate('({width:innerWidth,height:innerHeight})',node?.frame||step.frame);
        const deltaX=step.x??step.delta_x??0,deltaY=step.y??step.delta_y??0;
        if(!Number.isFinite(deltaX)||!Number.isFinite(deltaY)||Math.max(Math.abs(deltaX),Math.abs(deltaY))>100000)throw error('invalid_action','Invalid scroll distance.');
        const point=node?await elementPoint(node):await framePoint(viewport.width/2,viewport.height/2,step.frame||mainFrame);
        await send('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX,deltaY});
        return {scrolled:true};
      }finally{if(node)await release(node);}
    }
    if(step.action==='navigate'||step.action==='back'||step.action==='reload'){
      const before=(await send('Page.getFrameTree')).frameTree.frame;
      let expectedLoader,expectedUrl;
      if(step.action==='navigate'){
        const url=new URL(boundedText(step.url,8192,'URL'));
        if(url.origin!==origin||url.username||url.password)throw error('origin_changed','Navigation must stay on this paired website.');
        const result=await send('Page.navigate',{url:url.href});if(result.errorText)throw error('navigation_failed',result.errorText);
        expectedLoader=result.loaderId;expectedUrl=url.href;
      }else if(step.action==='back'){
        const history=await send('Page.getNavigationHistory'),previous=history.entries[history.currentIndex-1];
        if(!previous)throw error('no_history','There is no previous page.');
        if(new URL(previous.url).origin!==origin)throw error('origin_changed','The previous page belongs to another website.');
        expectedUrl=previous.url;
        await send('Page.navigateToHistoryEntry',{entryId:previous.id});
      }else await send('Page.reload');
      refs.clear();generation++;
      let committed=false;
      while(Date.now()<deadline){
        check();const current=(await send('Page.getFrameTree')).frameTree.frame;
        if(expectedLoader?current.loaderId===expectedLoader:current.loaderId!==before.loaderId||expectedUrl&&expectedUrl!==before.url&&current.url===expectedUrl){committed=true;break;}
        await new Promise(resolve=>setTimeout(resolve,30));check();
      }
      if(!committed)throw error('navigation_timeout','The new document did not become ready.');
      await wait({state:'ready'},deadline);return evaluate('({url:location.href,title:document.title})');
    }
    if(step.action==='dialog'){
      if(typeof step.accept!=='boolean')throw error('invalid_action','Choose whether to accept the dialog.');
      await send('Page.handleJavaScriptDialog',{accept:step.accept,...(step.prompt_text!==undefined?{promptText:boundedText(step.prompt_text,16384,'prompt text')}: {})});return {handled:true};
    }
    if(step.action==='screenshot'){
      await hideUi(true);
      try{
        const viewport=await evaluate('({width:innerWidth,height:innerHeight,dpr:devicePixelRatio})');
        const metrics=await send('Page.getLayoutMetrics'),visual=metrics.cssVisualViewport||metrics.visualViewport;
        let scale=Math.min(1,1800/(viewport.width*viewport.dpr),1200/(viewport.height*viewport.dpr));
        for(let attempt=0;attempt<5;attempt++){
          const result=await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,clip:{x:visual.pageX,y:visual.pageY,width:viewport.width,height:viewport.height,scale}});
          if(result.data.length*0.75<=4*1024*1024){
            const binary=atob(result.data),view=new DataView(Uint8Array.from(binary.slice(0,24),c=>c.charCodeAt(0)).buffer);
            return {mime:'image/png',data_base64:result.data,width:view.getUint32(16),height:view.getUint32(20)};
          }
          scale*=0.7;
        }
        throw error('result_too_large','Screenshot could not fit the 4 MiB image budget.');
      }finally{await hideUi(false);}
    }
  }
  return {initialize,event,execute};
}
