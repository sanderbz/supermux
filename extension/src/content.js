(() => {
  if (globalThis.__supermuxAnnotation) { globalThis.__supermuxAnnotation.toggle(); return; }
  const STYLE='__CONTENT_CSS__';
  const safeUrl='__SAFE_URL__';
  const brandSvg='__BRAND_SVG__';
  const isMac=/Mac|iPhone|iPad/i.test(navigator.userAgentData?.platform||navigator.platform||navigator.userAgent);
  const modifierLabel=isMac?'⌘':'Ctrl+';
  const shortcut=key=>modifierLabel+key;
  const modifierPressed=e=>isMac?e.metaKey&&!e.ctrlKey:e.ctrlKey&&!e.metaKey;
  let draftPage=location.href;
  const icons={pick:'<path d="m5 3 14 10-7 1-3 7Z"/>',draw:'<path d="M4 16c-4-8 7-15 14-10 7 5-1 17-9 14-4-2-2-7 4-7"/>',region:'<rect x="4" y="4" width="16" height="16" rx="3" stroke-dasharray="3 3"/>',undo:'<path d="m8 4-5 5 5 5M3 9h10a7 7 0 0 1 0 14"/>',close:'<path d="m6 6 12 12M18 6 6 18"/>',arrow:'<path d="M4 12h16m-6-6 6 6-6 6"/>',capture:'<path d="M8 5h8l2 3h3v12H3V8h3Z"/><circle cx="12" cy="14" r="4"/>',settings:'<path d="m12 3 2 3 4 1v4l3 2-3 2v4l-4 1-2 3-2-3-4-1v-4l-3-2 3-2V7l4-1Z"/><circle cx="12" cy="13" r="3"/>'};
  const icon=name=>`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]||''}</svg>`;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const host=document.createElement('div');host.setAttribute('data-supermux-overlay','');host.style.cssText='position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important';
  const root=host.attachShadow({mode:'closed'});root.innerHTML=`<style>${STYLE}</style><svg class="scene" xmlns="http://www.w3.org/2000/svg"></svg><div class="pins"></div><div class="ui"></div><div class="masks"></div>`;
  document.documentElement.append(host);
  const ui=root.querySelector('.ui'),scene=root.querySelector('.scene'),pins=root.querySelector('.pins'),masks=root.querySelector('.masks');
  let notes=[],mode='element',selected=null,hover=null,hoverElement=null,message='',snapshot=null,connection=null,visible=true,review=false,busy=false,receipt=null,drawing=null,history=[],captureGuard=null,clientId=crypto.randomUUID(),saveTimer,toastTimer,noteCrops={},feedbackError='';
  const elementRefs=new Map(),anchorRefs=new Map();
  let scrollRevision=0,paintFrame=0;
  const viewport=()=>({width:innerWidth,height:innerHeight,dpr:devicePixelRatio,scroll_x:scrollX,scroll_y:scrollY});
  const rpc=async(type,extra={})=>{const r=await chrome.runtime.sendMessage({type,...extra});if(!r?.ok)throw new Error(r?.error||'Extension disconnected. Reopen it from the toolbar.');return r.data;};
  const isPrivate=el=>!!el?.closest('input,textarea,select,[contenteditable]:not([contenteditable="false"]),[data-private],[data-sensitive],[autocomplete="current-password"],[autocomplete="new-password"]');
  function publicText(element,limit=700){
    const walker=document.createTreeWalker(element,NodeFilter.SHOW_TEXT,{acceptNode(node){const p=node.parentElement;return !p||isPrivate(p)||p.closest('script,style,noscript,[hidden],[aria-hidden="true"]')?NodeFilter.FILTER_REJECT:NodeFilter.FILTER_ACCEPT;}});
    let s='',node;while((node=walker.nextNode())&&s.length<limit)s+=' '+node.textContent;return s.replace(/\s+/g,' ').trim().slice(0,limit);
  }
  function selector(el){
    const parts=[];for(let depth=0;el&&el!==document.documentElement&&depth<4;depth++,el=el.parentElement){
      const tag=el.tagName.toLowerCase();const safeId=el.id&&/^[a-zA-Z][\w-]{0,60}$/.test(el.id)&&!/[0-9]{5}/.test(el.id);
      if(safeId){parts.unshift(`${tag}#${CSS.escape(el.id)}`);break;}
      const siblings=el.parentElement?Array.from(el.parentElement.children).filter(n=>n.tagName===el.tagName):[];
      parts.unshift(tag+(siblings.length>1?`:nth-of-type(${siblings.indexOf(el)+1})`:''));
    }return parts.join(' > ');
  }
  function logical(el){
    if(!(el instanceof Element)||isPrivate(el)||el===host||el.closest('[data-supermux-overlay]'))return null;
    const nearest=el.closest('button,a,[role="button"],[role="link"],h1,h2,h3,h4,h5,h6,p,li,img,figure,label,article,section,nav,header,footer');
    if(nearest){const r=nearest.getBoundingClientRect();if(r.width<innerWidth*.96&&r.height<innerHeight*.92)return nearest;}
    const r=el.getBoundingClientRect();if(r.width<8||r.height<8)return el.parentElement===document.body?null:el.parentElement;
    if(el===document.body||el===document.documentElement)return null;return el;
  }
  const docRect=rect=>({x:rect.x+scrollX,y:rect.y+scrollY,width:rect.width,height:rect.height});
  const viewRect=rect=>({...rect,x:rect.x-scrollX,y:rect.y-scrollY});
  const parentElement=el=>el.parentElement||el.getRootNode()?.host||null;
  function anchorFor(target){
    for(let el=target instanceof Element?target:null;el&&el!==document.scrollingElement;el=parentElement(el)){
      const style=getComputedStyle(el),position=style.position;
      const scrolling=/(auto|scroll|overlay|hidden)/.test(`${style.overflow} ${style.overflowX} ${style.overflowY}`)&&(el.scrollHeight>el.clientHeight||el.scrollWidth>el.clientWidth);
      if(position==='fixed'||position==='sticky'||scrolling){const r=docRect(el.getBoundingClientRect());return {element:el,anchor:{kind:scrolling?'scroll':'element',selector:selector(el),tag:el.tagName.toLowerCase(),text:publicText(el,100),x:r.x,y:r.y,scroll_x:el.scrollLeft,scroll_y:el.scrollTop}};}
    }return null;
  }
  function offsetFor(note){
    const anchor=note.anchor,el=anchorRefs.get(note.id);
    if(!anchor||!el?.isConnected)return {x:0,y:0};
    const r=docRect(el.getBoundingClientRect());
    return {x:r.x-anchor.x-(anchor.kind==='scroll'?el.scrollLeft-anchor.scroll_x:0),y:r.y-anchor.y-(anchor.kind==='scroll'?el.scrollTop-anchor.scroll_y:0)};
  }
  function rectFor(note){const el=elementRefs.get(note.id);if(el?.isConnected)return docRect(el.getBoundingClientRect());const offset=offsetFor(note);return {...note.rect,x:note.rect.x+offset.x,y:note.rect.y+offset.y};}
  function pointsFor(note){const offset=offsetFor(note);return (note.points||[]).map(p=>({x:p.x+offset.x,y:p.y+offset.y}));}
  function intersect(a,b){const x=Math.max(a.x,b.x),y=Math.max(a.y,b.y);return {x,y,width:Math.max(0,Math.min(a.x+a.width,b.x+b.width)-x),height:Math.max(0,Math.min(a.y+a.height,b.y+b.height)-y)};}
  function clipFor(element,includeSelf=false){
    let clip={x:0,y:0,width:innerWidth,height:innerHeight};
    for(let el=includeSelf?element:parentElement(element);el&&el!==document.scrollingElement;el=parentElement(el)){
      const style=getComputedStyle(el),overflowX=style.overflowX||style.overflow,overflowY=style.overflowY||style.overflow;
      const xClip=/(auto|scroll|overlay|hidden|clip)/.test(overflowX),yClip=/(auto|scroll|overlay|hidden|clip)/.test(overflowY);
      if(!xClip&&!yClip)continue;const r=el.getBoundingClientRect();
      const left=r.x+el.clientLeft,top=r.y+el.clientTop,width=el.clientWidth||r.width,height=el.clientHeight||r.height;
      clip=intersect(clip,{x:xClip?left:clip.x,y:yClip?top:clip.y,width:xClip?width:clip.width,height:yClip?height:clip.height});
    }return clip;
  }
  function geometry(note){
    const el=elementRefs.get(note.id)||anchorRefs.get(note.id),rect=viewRect(rectFor(note));
    const clip=el?.isConnected?clipFor(el,note.anchor?.kind==='scroll'):{x:0,y:0,width:innerWidth,height:innerHeight};
    const unresolved=(note.kind==='element'&&note.element||note.anchor)&&!el?.isConnected;
    const visibleRect=intersect(rect,clip),hidden=!!unresolved||!visibleRect.width||!visibleRect.height;
    return {rect,points:pointsFor(note).map(p=>({x:p.x-scrollX,y:p.y-scrollY})),clip,visibleRect,hidden};
  }
  function restoreRefs(){
    elementRefs.clear();anchorRefs.clear();
    for(const note of notes){const context=note.kind==='element'?note.element:note.anchor;if(!context?.selector)continue;
      try{const candidates=document.querySelectorAll(context.selector);if(candidates.length!==1)continue;const el=candidates[0];if(el===host||isPrivate(el)||el.tagName.toLowerCase()!==context.tag||publicText(el,note.kind==='element'?700:100)!==context.text)continue;(note.kind==='element'?elementRefs:anchorRefs).set(note.id,el);}catch{}
    }
  }
  function schedulePaint(){if(!paintFrame)paintFrame=requestAnimationFrame(()=>{paintFrame=0;paint();});}
  function dirty(){snapshot=null;receipt=null;clientId=crypto.randomUUID();scheduleSave();}
  function saveDraft(){clearTimeout(saveTimer);const ids=new Set(notes.map(n=>n.id));noteCrops=Object.fromEntries(Object.entries(noteCrops).filter(([id])=>ids.has(id)));return rpc('draft.save',{draft:{notes,message,snapshot,clientId,noteCrops}});}
  function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(()=>saveDraft().catch(e=>toast(e.message)),500);}
  function checkpoint(){history.push(JSON.stringify(notes));if(history.length>30)history.shift();}
  function toast(text){let el=root.querySelector('.toast');if(!el){el=document.createElement('div');el.className='toast';el.setAttribute('role','status');ui.append(el);}el.textContent=text;clearTimeout(toastTimer);toastTimer=setTimeout(()=>el.remove(),4300);}
  function setMode(next){saveEditor();selected=null;mode=next;review=false;receipt=null;hover=null;render();}
  function saveEditor(){const area=root.querySelector('.editor textarea');if(area&&selected){const note=notes.find(n=>n.id===selected);if(note&&note.text!==area.value){checkpoint();note.text=area.value.slice(0,4000);dirty();}}}
  function addNote(note,element,anchorElement){if(notes.length>=40){toast('This feedback has 40 notes. Send it before adding more.');return;}checkpoint();notes.push(note);if(element)elementRefs.set(note.id,element);if(anchorElement)anchorRefs.set(note.id,anchorElement);selected=note.id;dirty();render();setTimeout(()=>root.querySelector('.editor textarea')?.focus(),20);}
  function remove(id){checkpoint();notes=notes.filter(n=>n.id!==id);elementRefs.delete(id);anchorRefs.delete(id);delete noteCrops[id];if(selected===id)selected=null;dirty();render();}
  function undo(){saveEditor();if(!history.length)return;notes=JSON.parse(history.pop());restoreRefs();selected=null;dirty();render();}
  function paint(){
    if(!visible)return;let svg='';
    if(hover&&!review&&!selected&&!drawing){const r=hover;svg+=`<rect class="hover-outline" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`;}
    const resolved=notes.map(geometry);
    function shape(note,g,index){
      if(g.hidden)return '';const c=g.clip,r=g.rect,id=`sm-clip-${index}`;
      const start=`<defs><clipPath id="${id}"><rect x="${c.x}" y="${c.y}" width="${c.width}" height="${c.height}"/></clipPath></defs>`;
      return start+(note.kind==='draw'?`<polyline class="stroke" clip-path="url(#${id})" points="${g.points.map(p=>`${p.x},${p.y}`).join(' ')}"/>`:`<rect class="annotation-outline" clip-path="url(#${id})" x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}"/>`);
    }
    notes.forEach((note,i)=>{svg+=shape(note,resolved[i],i);});
    if(drawing){const note={id:'__drawing',kind:mode,rect:drawBounds(drawing.points),points:drawing.points,anchor:drawing.anchor};svg+=shape(note,geometry(note),'drawing');}
    scene.innerHTML=svg;
    pins.innerHTML=notes.map((note,i)=>{const g=resolved[i],r=g.rect,c=g.clip,x=r.x+r.width,y=r.y;
      if(g.hidden||x<c.x||x>c.x+c.width||y<c.y||y>c.y+c.height)return '';
      return `<button class="pin ${selected===note.id?'selected':''}" data-pin="${escape(note.id)}" style="left:${x}px;top:${y}px" title="Note ${i+1}: ${escape(note.text||'Add a note')}" aria-label="Edit note ${i+1}">${i+1}</button>`;
    }).join('');
    if(selected&&!review)positionEditor();
  }
  function positionEditor(){const el=root.querySelector('.editor'),n=notes.find(n=>n.id===selected);if(!el||!n)return;const r=viewRect(rectFor(n));el.style.left=`${Math.max(12,Math.min(innerWidth-304,r.x+r.width+17))}px`;el.style.top=`${Math.max(12,Math.min(innerHeight-310,r.y+12))}px`;}
  function render(){
    if(!visible){ui.hidden=true;scene.hidden=true;pins.hidden=true;return;}ui.hidden=false;scene.hidden=false;pins.hidden=false;
    const note=notes.find(n=>n.id===selected);
    ui.innerHTML=`<div class="hint-float">${review?'Review your screenshot and notes before sending':selected?`Add a note · ${shortcut('Enter')} to finish`:mode==='element'?'Pick an element to leave a note':mode==='draw'?'Draw a circle around the detail': 'Drag to select an area'}${!review&&!selected?' · Esc to close':''}</div><div class="bar" role="toolbar" aria-label="Page annotation"><div class="brand">${brandSvg}<span>Supermux</span></div><div class="divider"></div>${[['element','pick','Pick','P'],['draw','draw','Draw','D'],['region','region','Area','R']].map(([key,i,label,k])=>`<button class="tool ${mode===key&&!review?'active':''}" data-mode="${key}" title="${label} (${shortcut(k)})" aria-label="${label} (${shortcut(k)})" aria-pressed="${mode===key&&!review}">${icon(i)}<span>${label}</span><kbd>${shortcut(k)}</kbd></button>`).join('')}<div class="divider"></div><button class="icon-btn" data-action="undo" title="Undo (${shortcut('Z')})" aria-label="Undo" ${history.length?'':'disabled'}>${icon('undo')}</button><input class="bar-message" aria-label="Overall feedback message" maxlength="12000" placeholder="What should change?" value="${escape(message)}"><button class="review-btn" data-action="review">Review <span class="count">${notes.length}</span>${icon('arrow')}</button><button class="icon-btn" data-action="close" title="Close (Esc)" aria-label="Close annotation">${icon('close')}</button></div>${note&&!review?`<div class="editor" role="dialog" aria-label="Edit annotation"><div class="editor-header"><span class="number">${notes.indexOf(note)+1}</span><span class="element-label">${escape(note.element?.tag?`<${note.element.tag}> ${note.element.text?.slice(0,38)||''}`:note.kind==='draw'?'Circled detail':'Selected area')}</span></div><textarea aria-label="Note" maxlength="4000" placeholder="What should change here?">${escape(note.text)}</textarea><div class="editor-footer"><button class="delete" data-action="delete">Delete</button><span class="subtle">${shortcut('↵')}</span><button class="done" data-action="done">Done</button></div></div>`:''}${review?panel():''}`;
    if(busy)ui.querySelectorAll('button,input,textarea').forEach(el=>el.disabled=true);
    paint();
  }
  function panel(){
    if(receipt)return `<aside class="panel"><div class="panel-header"><div><div class="eyebrow">BROWSER FEEDBACK</div><h2>${receipt.status==='cancelled'?'Connection removed.':receipt.status==='failed'?'Delivery needs attention.':'Ready for your agent.'}</h2></div><button class="icon-btn" data-action="back" aria-label="Close review">${icon('close')}</button></div><div class="panel-body success"><div class="success-mark">${receipt.status==='sent'?'✓':receipt.status==='failed'?'!':receipt.status==='cancelled'?'×':'↗'}</div><h3>${receipt.status==='sent'?'Delivered to your chat.':receipt.status==='cancelled'?'Feedback cancelled.':receipt.status==='failed'?'Delivery failed.':'Queued for your chat.'}</h3><p>${receipt.status==='sent'?'Your feedback is in the chat.':receipt.status==='cancelled'?'This website connection was removed before the feedback was delivered.':receipt.status==='failed'?escape(receipt.reason||'Your server has retained the feedback. Check the connected chat and retry delivery there.'):'Supermux received your feedback. It will appear in your connected chat when delivery completes.'}</p><p>${escape(connection?.session_label||connection?.session||'')}</p><button data-action="new">Annotate something else</button></div></aside>`;
    return `<aside class="panel" role="dialog" aria-label="Review feedback"><div class="panel-header"><div><div class="eyebrow">ONE LAST LOOK</div><h2>Make it clear.</h2></div><button class="icon-btn" data-action="back" aria-label="Back to annotation">${icon('close')}</button></div><div class="panel-body"><div class="target"><span class="target-dot"></span>To ${escape(connection?.session_label||connection?.session||'No chat connected yet')}<button class="icon-btn" style="margin-left:auto;height:20px" data-action="settings" aria-label="Connection settings">${icon('settings')}</button></div><div class="capture">${snapshot?`<img src="${snapshot.preview}" alt="Screenshot preview with numbered annotations"><label>Frozen capture · ${snapshot.viewport.width} × ${snapshot.viewport.height}</label>`:'<div class="capture-empty">A little visual context goes a long way.<br>Capture this viewport to review it.</div>'}</div><div class="capture-tools"><span>${snapshot?'Private fields masked':'Only this visible viewport'}</span><button data-action="capture" ${busy?'disabled':''}>${icon('capture')}${busy?'Capturing…':snapshot?'Retake screenshot':'Capture screenshot'}</button></div><label class="message-label" for="sm-message">What would you like to change?</label><textarea class="message" id="sm-message" maxlength="12000" placeholder="Describe the overall change, or let your notes do the talking…">${escape(message)}</textarea><div class="notes-title"><span>${notes.length} NOTE${notes.length===1?'':'S'}</span><span>IN THIS FEEDBACK</span></div>${notes.map((n,i)=>`<div class="note-row"><button class="number" data-pin="${escape(n.id)}" aria-label="Edit note ${i+1}">${i+1}</button><div class="note-content"><strong>${escape(n.element?.tag?`<${n.element.tag}>` :n.kind==='draw'?'Circled detail':'Selected area')}</strong>${escape(n.text||'No note added')}${snapshot&&(()=>{const r=snapshot.annotations.find(a=>a.id===n.id)?.rect;return snapshot.hiddenIds?.includes(n.id)||r&&(r.x+r.width<0||r.y+r.height<0||r.x>=snapshot.viewport.width||r.y>=snapshot.viewport.height)})()?'<strong style="margin-top:5px">Outside screenshot · saved crop</strong>':''}</div>${snapshot?.crops?.find(c=>c.annotation_id===n.id)?`<img class="crop" src="data:image/png;base64,${snapshot.crops.find(c=>c.annotation_id===n.id).data_base64}" alt="Crop for note ${i+1}">`:''}</div>`).join('')}</div><div class="panel-footer"><div class="error" ${feedbackError?'':'hidden'} role="alert">${escape(feedbackError)}</div>${!connection?.paired?'<button class="done" style="width:100%;margin-bottom:12px" data-action="settings">Connect this website to a chat ↗</button>':''}<div class="privacy">Visible inputs, editable fields, private elements, and embedded frames are masked. Check the preview for anything else you want to keep private.</div><button class="send" data-action="send" ${!snapshot||busy||!connection?.paired?'disabled':''}>${busy?'Sending…':'Send to your agent'}${icon('arrow')}</button></div></aside>`;
  }
  function drawBounds(points){const xs=points.map(p=>p.x),ys=points.map(p=>p.y);return{x:Math.min(...xs),y:Math.min(...ys),width:Math.max(...xs)-Math.min(...xs),height:Math.max(...ys)-Math.min(...ys)};}
  function overlayEvent(e){return e.composedPath().includes(host);}
  function point(e){return{x:e.clientX+scrollX,y:e.clientY+scrollY};}
  function mousemove(e){if(!visible||busy||review||selected||overlayEvent(e)||captureGuard)return;if(drawing){const p=point(e),last=drawing.points.at(-1);if(Math.hypot(p.x-last.x,p.y-last.y)>2){if(mode==='region')drawing.points=[drawing.points[0],p];else if(drawing.points.length<1500)drawing.points.push(p);}paint();return;}if(mode==='element'){hoverElement=logical(e.target);hover=hoverElement?.getBoundingClientRect()||null;paint();}}
  function down(e){if(!visible||review||selected||overlayEvent(e)||captureGuard||e.button!==0)return;if(mode!=='element'){e.preventDefault();e.stopImmediatePropagation();const anchoring=anchorFor(e.target);drawing={points:[point(e)],pointerId:e.pointerId,anchor:anchoring?.anchor,anchorElement:anchoring?.element};if(anchoring)anchorRefs.set('__drawing',anchoring.element);hover=null;paint();}}
  function up(e){if(!drawing)return;e.preventDefault();e.stopImmediatePropagation();const current=drawing,path=current.points;drawing=null;anchorRefs.delete('__drawing');const rect=drawBounds(path);if(rect.width>8&&rect.height>8)addNote({id:crypto.randomUUID(),kind:mode,rect,points:mode==='draw'?path:undefined,text:'',...(current.anchor?{anchor:current.anchor}:{})},undefined,current.anchorElement);else paint();}
  function click(e){if(!visible||busy||review||overlayEvent(e)||captureGuard)return;if(mode==='element'&&!selected){const el=logical(e.target);if(!el){toast('Choose a visible element outside private or editable fields.');return;}e.preventDefault();e.stopImmediatePropagation();addNote({id:crypto.randomUUID(),kind:'element',rect:docRect(el.getBoundingClientRect()),text:'',element:{tag:el.tagName.toLowerCase(),selector:selector(el),text:publicText(el),role:el.getAttribute('role')||undefined}},el);}else if(mode!=='element'){e.preventDefault();e.stopImmediatePropagation();}}
  function keydown(e){
    if(!visible||busy||e.isComposing)return;
    const path=e.composedPath(),inside=path.includes(host);
    const editing=path.some(node=>node instanceof Element&&(node.matches('input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])')||node.isContentEditable));
    // The document sees only the closed ShadowRoot's host. Overlay keys are
    // handled inside that root, where the actual focused field remains visible.
    const focusedPageHost=!inside&&e.target instanceof Element&&document.activeElement===e.target&&!e.target.matches('body,html,button,a,[role="button"],[role="link"]');
    if((editing||focusedPageHost)&&!inside)return;
    if(e.key==='Escape'){
      e.preventDefault();e.stopPropagation();
      if(selected){saveEditor();selected=null;render();}else if(review){review=false;render();}else toggle(false);
      return;
    }
    if(captureGuard)return;
    if(editing){
      if(e.key==='Enter'&&modifierPressed(e)&&!e.altKey&&!e.shiftKey&&path[0]?.matches?.('.editor textarea')){
        e.preventDefault();e.stopPropagation();const id=selected;saveEditor();selected=null;render();if(id)captureNote(id);
      }
      return; // Preserve native text editing, including Cmd/Ctrl+Z.
    }
    if(!modifierPressed(e)||e.altKey||e.shiftKey)return;
    if(e.key.toLowerCase()==='z'){e.preventDefault();e.stopPropagation();undo();return;}
    const next={p:'element',d:'draw',r:'region'}[e.key.toLowerCase()];
    if(next){e.preventDefault();e.stopPropagation();setMode(next);}
  }
  function toggle(force){if(captureGuard||busy)return;if(location.href!==draftPage){clearTimeout(saveTimer);draftPage=location.href;notes=[];elementRefs.clear();anchorRefs.clear();message='';snapshot=null;noteCrops={};history=[];selected=null;receipt=null;clientId=crypto.randomUUID();visible=true;review=false;render();loadDraft();return;}saveEditor();visible=typeof force==='boolean'?force:!visible;selected=null;hover=null;render();scheduleSave();if(visible)rpc('draft.load').then(data=>{connection=data.connection;render();}).catch(e=>toast(e.message));}
  globalThis.__supermuxAnnotation={toggle};
  async function imageFrom(url){const image=new Image();image.src=url;await image.decode();return image;}
  // PNG is lossless; shrink dimensions only when its byte budget requires it.
  function boundedPNG(canvas,maxBytes){
    let output=canvas,data=output.toDataURL('image/png'),scale=1;
    while((data.length-data.indexOf(',')-1)*.75>maxBytes&&Math.max(output.width,output.height)>32){
      scale*=.78;const smaller=document.createElement('canvas');smaller.width=Math.max(1,Math.round(canvas.width*scale));smaller.height=Math.max(1,Math.round(canvas.height*scale));smaller.getContext('2d').drawImage(canvas,0,0,smaller.width,smaller.height);output=smaller;data=output.toDataURL('image/png');
    }
    if((data.length-data.indexOf(',')-1)*.75>maxBytes)throw new Error('This screenshot is too large. Try a smaller browser window.');
    return {canvas:output,data};
  }
  async function makeSnapshot(raw){
    const image=await imageFrom(raw.dataUrl),v=raw.viewport,scale=Math.min(1,1800/image.width),canvas=document.createElement('canvas');canvas.width=Math.round(image.width*scale);canvas.height=Math.round(image.height*scale);canvas.getContext('2d').drawImage(image,0,0,canvas.width,canvas.height);
    const overview=boundedPNG(canvas,2*1024*1024),previewCanvas=overview.canvas,ctx=previewCanvas.getContext('2d'),sx=previewCanvas.width/v.width,sy=previewCanvas.height/v.height;
    const frozen=raw.annotations.map((n,i)=>({...n,number:i+1})),crops=[],cropBudget=Math.min(2*1024*1024,Math.floor(10*1024*1024/Math.max(1,frozen.length)));
    for(const n of frozen){
      const r=n.rect,clip=raw.clips?.[n.id]||{x:0,y:0,width:v.width,height:v.height};
      const crop=r&&!raw.hiddenIds?.includes(n.id)?intersect({x:r.x-12,y:r.y-12,width:r.width+24,height:r.height+24},intersect(clip,{x:0,y:0,width:v.width,height:v.height})):null;
      if(crop?.width&&crop.height){
        // Read from the original capture: overview downsampling must not blur text crops.
        const sourceX=image.width/v.width,sourceY=image.height/v.height,factor=Math.min(1,1400/(crop.width*sourceX),1000/(crop.height*sourceY)),c=document.createElement('canvas');c.width=Math.max(1,Math.round(crop.width*sourceX*factor));c.height=Math.max(1,Math.round(crop.height*sourceY*factor));c.getContext('2d').drawImage(image,crop.x*sourceX,crop.y*sourceY,crop.width*sourceX,crop.height*sourceY,0,0,c.width,c.height);
        crops.push({annotation_id:n.id,number:n.number,mime:'image/png',data_base64:boundedPNG(c,cropBudget).data.split(',')[1],capture:{captured_at:raw.captured_at,viewport:{...v},rect:{...crop},annotation_rect:{...r},...(n.points?.length?{points:n.points.map(p=>({...p}))}:{})}});
      }else if(noteCrops[n.id]){
        const saved=noteCrops[n.id];let data=saved.data_base64;
        if(data.length*.75>cropBudget){const previous=await imageFrom('data:image/png;base64,'+data),c=document.createElement('canvas');c.width=previous.width;c.height=previous.height;c.getContext('2d').drawImage(previous,0,0);data=boundedPNG(c,cropBudget).data.split(',')[1];}
        // Only the displayed number changes when notes are deleted; provenance stays immutable.
        crops.push({...saved,number:n.number,data_base64:data});
      }
    }
    ctx.strokeStyle='#617e4d';ctx.lineWidth=2;ctx.fillStyle='#3e582f';ctx.font='600 12px system-ui';
    frozen.forEach(n=>{const r=n.rect;if(raw.hiddenIds?.includes(n.id)||!r||r.x+r.width<0||r.y+r.height<0||r.x>=v.width||r.y>=v.height)return;const clip=raw.clips?.[n.id]||{x:0,y:0,width:v.width,height:v.height};ctx.save();ctx.beginPath();ctx.rect(clip.x*sx,clip.y*sy,clip.width*sx,clip.height*sy);ctx.clip();if(n.kind==='draw'&&n.points?.length){ctx.beginPath();n.points.forEach((p,j)=>j?ctx.lineTo(p.x*sx,p.y*sy):ctx.moveTo(p.x*sx,p.y*sy));ctx.stroke();}else ctx.strokeRect(r.x*sx,r.y*sy,r.width*sx,r.height*sy);const x=Math.max(11,Math.min(previewCanvas.width-11,(r.x+r.width)*sx)),y=Math.max(11,Math.min(previewCanvas.height-11,r.y*sy));ctx.beginPath();ctx.arc(x,y,10,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(String(n.number),x,y);ctx.fillStyle='#3e582f';ctx.restore();});
    // Preserve identical overview dimensions. A complex annotated PNG may exceed
    // budget after drawing; shrink both together, never silently drop annotations.
    let clean=overview.data,preview=previewCanvas.toDataURL('image/png'),finalCanvas=previewCanvas,previewScale=1;
    while(preview.length*.75>2*1024*1024&&Math.max(finalCanvas.width,finalCanvas.height)>32){
      previewScale*=.78;const next=document.createElement('canvas');next.width=Math.max(1,Math.round(previewCanvas.width*previewScale));next.height=Math.max(1,Math.round(previewCanvas.height*previewScale));next.getContext('2d').drawImage(previewCanvas,0,0,next.width,next.height);finalCanvas=next;preview=next.toDataURL('image/png');const plain=document.createElement('canvas');plain.width=next.width;plain.height=next.height;plain.getContext('2d').drawImage(image,0,0,plain.width,plain.height);clean=plain.toDataURL('image/png');
    }
    if(Math.max(clean.length,preview.length)*.75>2*1024*1024)throw new Error('This screenshot is too large. Try a smaller browser window.');
    return {viewport:v,annotations:frozen,hiddenIds:raw.hiddenIds||[],screenshot:{mime:'image/png',data_base64:clean.split(',')[1]},crops,preview,numberedOverview:true,title:raw.title,url:raw.url};
  }
  async function budgetSavedCrops(){
    const budget=Math.min(2*1024*1024,Math.floor(10*1024*1024/Math.max(1,notes.length)));
    for(const n of notes){const saved=noteCrops[n.id];if(saved&&saved.data_base64.length*.75>budget){const image=await imageFrom('data:image/png;base64,'+saved.data_base64),canvas=document.createElement('canvas');canvas.width=image.width;canvas.height=image.height;canvas.getContext('2d').drawImage(image,0,0);noteCrops[n.id]={...saved,data_base64:boundedPNG(canvas,budget).data.split(',')[1]};}}
  }
  async function captureNote(id){try{const raw=await rpc('capture');const shot=await makeSnapshot(raw);const crop=shot.crops.find(c=>c.annotation_id===id);if(crop&&notes.some(n=>n.id===id)){noteCrops[id]=crop;await budgetSavedCrops();scheduleSave();}}catch(e){toast('Note saved. Capture its screenshot while the note is visible: '+e.message);}}
  async function captureNow(){if(busy)return;let failure='';saveEditor();message=root.querySelector('.message')?.value??message;busy=true;render();try{const raw=await rpc('capture');snapshot=await makeSnapshot(raw);const missing=snapshot.annotations.find(n=>!snapshot.crops.some(c=>c.annotation_id===n.id));if(missing){snapshot=null;throw new Error('A note has no screenshot context. Scroll to that note, open it, and click Done before reviewing again.');}await budgetSavedCrops();clientId=crypto.randomUUID();scheduleSave();}catch(e){failure=e.message;}finally{busy=false;render();if(failure)toast(failure);}}
  async function send(){if(busy||!snapshot)return;message=root.querySelector('.message')?.value??message;busy=true;feedbackError='';render();try{
    await saveDraft();
    const payload={client_id:clientId,url:snapshot.url,title:snapshot.title,message,viewport:snapshot.viewport,annotations:snapshot.annotations,screenshot:snapshot.screenshot,...(snapshot.numberedOverview?{annotated_screenshot:{mime:'image/png',data_base64:snapshot.preview.split(',')[1]}}:{}),crops:snapshot.crops};
    receipt=await rpc('feedback.submit',{payload});notes=[];snapshot=null;message='';history=[];noteCrops={};elementRefs.clear();anchorRefs.clear();
    const id=receipt.id;let attempts=0;const poll=async()=>{if(receipt?.id!==id)return;attempts++;try{const p=await rpc('feedback.status',{id});if(receipt?.id===id){receipt=p;render();if(!['sent','failed','cancelled'].includes(p.status))setTimeout(poll,attempts<10?2000:attempts<30?5000:15000);}}catch{setTimeout(poll,15000);}};setTimeout(poll,1000);
  }catch(e){feedbackError=e.message;}finally{busy=false;render();}}
  root.addEventListener('click',e=>{
    const b=e.target.closest?.('button');if(!b||b.disabled||busy)return;
    if(b.dataset.pin){saveEditor();selected=b.dataset.pin;review=false;render();setTimeout(()=>root.querySelector('.editor textarea')?.focus(),10);return;}
    if(b.dataset.mode){setMode(b.dataset.mode);return;}
    const a=b.dataset.action;if(a==='close')toggle(false);if(a==='undo')undo();if(a==='delete')remove(selected);if(a==='done'){const id=selected;saveEditor();selected=null;render();captureNote(id);}
    if(a==='review'){saveEditor();selected=null;review=true;render();if(!snapshot)captureNow();}if(a==='back'){review=false;render();}if(a==='capture')captureNow();if(a==='send')send();if(a==='settings')rpc('settings.open').catch(e=>toast(e.message));if(a==='new'){receipt=null;review=false;clientId=crypto.randomUUID();render();}
  });
  root.addEventListener('input',e=>{if(e.target.matches('.message,.bar-message')){if(message!==e.target.value)clientId=crypto.randomUUID();message=e.target.value;const other=root.querySelector(e.target.matches('.message')?'.bar-message':'.message');if(other)other.value=message;scheduleSave();}else if(e.target.matches('.editor textarea')){const n=notes.find(n=>n.id===selected);if(n){checkpoint();n.text=e.target.value;snapshot=null;clientId=crypto.randomUUID();scheduleSave();}}});
  function restoreCapture(){clearTimeout(captureGuard?.timer);captureGuard=null;host.classList.remove('capturing');masks.innerHTML='';}
  chrome.runtime.onMessage.addListener((m,sender,reply)=>{
    if(sender.id&&sender.id!==chrome.runtime.id)return;
    if(m.type==='capture.validate'){const v=viewport();reply(!!captureGuard&&captureGuard.nonce===m.nonce&&captureGuard.revision===scrollRevision&&captureGuard.scrollState.every(([el,x,y])=>el.isConnected&&el.scrollLeft===x&&el.scrollTop===y)&&Object.keys(v).every(k=>v[k]===m.viewport[k]));return;}
    if(m.type==='capture.restore'){restoreCapture();reply({ok:true});return;}
    if(m.type==='capture.prepare'){
      if(captureGuard){reply(null);return;}
      const v=viewport();captureGuard={nonce:crypto.randomUUID(),revision:scrollRevision,scrollState:Array.from(document.querySelectorAll('*')).filter(el=>el!==host&&(el.scrollLeft||el.scrollTop||el.scrollHeight>el.clientHeight||el.scrollWidth>el.clientWidth)).map(el=>[el,el.scrollLeft,el.scrollTop]),timer:setTimeout(restoreCapture,5000)};
      const sensitive=[];function collect(scope){sensitive.push(...scope.querySelectorAll('input,textarea,select,iframe,[contenteditable]:not([contenteditable="false"]),[data-private],[data-sensitive]'));for(const el of scope.querySelectorAll('*'))if(el!==host&&el.shadowRoot)collect(el.shadowRoot);}collect(document);masks.innerHTML='';for(const el of sensitive){const r=el.getBoundingClientRect();if(r.width&&r.height&&r.bottom>0&&r.right>0&&r.top<innerHeight&&r.left<innerWidth){const mask=document.createElement('div');mask.className='privacy-mask';mask.style.cssText=`left:${r.left-2}px;top:${r.top-2}px;width:${r.width+4}px;height:${r.height+4}px`;masks.append(mask);}}
      host.classList.add('capturing');
      const resolved=notes.map(geometry),clips={},hiddenIds=[];
      const annotations=notes.map((n,i)=>{const g=resolved[i];clips[n.id]=g.clip;if(g.hidden)hiddenIds.push(n.id);return {id:n.id,kind:n.kind,text:n.text,rect:g.rect,...(n.element?{element:n.element}:{}),...(n.points?{points:g.points}:{})};});
      const safe=safeUrl(location.href);
      requestAnimationFrame(()=>requestAnimationFrame(()=>{if(!captureGuard){reply(null);return;}if(Object.keys(viewport()).some(k=>viewport()[k]!==v[k])){restoreCapture();reply(null);return;}reply({nonce:captureGuard.nonce,captured_at:new Date().toISOString(),viewport:v,annotations,clips,hiddenIds,title:document.title.slice(0,300),url:safe});}));return true;
    }
  });
  document.addEventListener('wheel',e=>{if(captureGuard){e.preventDefault();e.stopImmediatePropagation();}},{capture:true,passive:false});
  document.addEventListener('pointermove',mousemove,true);document.addEventListener('pointerdown',down,true);document.addEventListener('pointerup',up,true);document.addEventListener('click',click,true);root.addEventListener('keydown',keydown);document.addEventListener('keydown',e=>{if(!overlayEvent(e))keydown(e);},true);
  window.addEventListener('scroll',e=>{if(overlayEvent(e))return;scrollRevision++;hover=null;if(captureGuard)restoreCapture();if(drawing){drawing=null;anchorRefs.delete('__drawing');}schedulePaint();},{capture:true,passive:true});window.addEventListener('resize',()=>{if(captureGuard)restoreCapture();paint();},{passive:true});
  function loadDraft(){const page=draftPage;rpc('draft.load').then(data=>{if(page!==draftPage)return;connection=data.connection;if(data.draft){notes=data.draft.notes||[];message=data.draft.message||'';snapshot=data.draft.snapshot||null;if(snapshot){snapshot.annotations=snapshot.annotations.map((n,i)=>({...n,number:i+1}));snapshot.crops=(snapshot.crops||[]).map(c=>({...c,number:snapshot.annotations.findIndex(n=>n.id===c.annotation_id)+1}));}clientId=data.draft.clientId||crypto.randomUUID();noteCrops=data.draft.noteCrops||{};restoreRefs();if(notes.length||message||snapshot)toast('Your draft is back. Pick up where you left off.');}render();}).catch(e=>toast(e.message));}
  render();loadDraft();
})();
