(() => {
  if(globalThis.__supermuxControlUi){globalThis.__supermuxControlUi.refresh();return;}
  const host=document.createElement('div');host.dataset.supermuxControl='';
  host.style.cssText='position:fixed!important;top:14px!important;right:14px!important;z-index:2147483647!important;pointer-events:auto!important';
  const root=host.attachShadow({mode:'closed'});document.documentElement.append(host);
  const brandSvg='__BRAND_SVG__';
  const style=`:host{all:initial;color-scheme:light;font:12px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#283329}*{box-sizing:border-box}button{font:inherit;cursor:pointer;border:0}button:focus-visible{outline:2px solid #91aa81;outline-offset:3px}.pill{display:flex;align-items:center;gap:12px;padding:7px;background:#fafcf7ed;backdrop-filter:blur(24px);border:1px solid #ffffffd9;border-radius:14px;box-shadow:0 7px 30px #12231220;max-width:calc(100vw - 28px)}.brand{width:21px;height:21px;flex:none;margin-left:5px}.brand svg{width:100%;height:100%}.target{text-align:left;background:none;min-width:0;padding:3px 6px;color:inherit}.target strong{display:block;font-size:12px;font-weight:600;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.target small{display:block;color:#63715c;font-size:10px;margin-top:3px;max-width:200px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.allow,.stop{flex:none;min-height:34px;padding:0 12px;border-radius:9px;background:#2b3c29;color:white;font-weight:550}.stop{background:#f2e8df;color:#7b4e37}.message{max-width:calc(100vw - 28px);margin-top:6px;padding:9px 12px;border-radius:10px;background:#fbf0e7;color:#8b4c34;font-size:12px;line-height:1.5}[hidden]{display:none!important}@media(max-width:480px){.pill{gap:6px}.target strong,.target small{max-width:150px}}`;
  const escape=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let state=null,message='',captureStyle=null;
  const rpc=async type=>{const reply=await chrome.runtime.sendMessage({type});if(!reply?.ok)throw new Error(reply?.error||'Reopen Supermux from the extension icon.');return reply.data;};
  function render(){
    const focus=root.activeElement?.dataset.action,active=['active','starting','stopping'].includes(state?.state);
    host.hidden=!state?.paired;
    root.innerHTML=`<style>${style}</style><div class="pill"><span class="brand" aria-label="Supermux">${brandSvg}</span><button class="target" data-action="settings" aria-label="Change connected chat"><strong>${escape(state?.session_label||state?.session||'Your agent')}</strong><small>${escape(state?.company_label||state?.site||'')}</small></button><button class="${active?'stop':'allow'}" data-action="${active?'stop':'allow'}">${active?'Stop':'Allow control'}</button></div>${message?`<div class="message" role="alert">${escape(message)}</div>`:''}`;
    if(focus)root.querySelector(`[data-action="${focus}"]`)?.focus();
  }
  async function refresh(){try{state=await rpc('control.status');render();}catch{host.hidden=true;}}
  root.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button||!event.isTrusted)return;
    const action=button.dataset.action;message='';
    try{
      if(action==='settings'){await rpc('settings.open');return;}
      if(action==='allow'){state={...state,state:'starting'};render();state=await rpc('control.start');}
      if(action==='stop')state=await rpc('control.stop');
    }catch(error){message=error.message;state={...state,state:'idle'};}
    render();
  });
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(sender.id&&sender.id!==chrome.runtime.id)return;
    if(message.type==='control.prepare'&&!globalThis.__supermuxAnnotation){reply({ok:true});return;}
    if(message.type==='control.changed'){state=message.state;render();reply(true);}
    if(message.type==='control.capture'){
      host.hidden=!!message.hidden||!state?.paired;
      const annotation=document.querySelector('[data-supermux-overlay]');
      if(message.hidden&&annotation&&!captureStyle){captureStyle={annotation,value:annotation.style.getPropertyValue('visibility'),priority:annotation.style.getPropertyPriority('visibility')};annotation.style.setProperty('visibility','hidden','important');}
      if(!message.hidden&&captureStyle){const {annotation,value,priority}=captureStyle;value?annotation.style.setProperty('visibility',value,priority):annotation.style.removeProperty('visibility');captureStyle=null;}
      reply(true);
    }
  });
  window.addEventListener('focus',refresh);
  globalThis.__supermuxControlUi={refresh};void refresh();
})();
