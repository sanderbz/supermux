export function endpointOrigin(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new Error('Use just the server origin, for example https://your-machine.tailnet.ts.net');
  const octets=url.hostname.split('.').map(Number);
  const tailscaleIP=octets.length===4&&octets[0]===100&&octets[1]>=64&&octets[1]<=127&&octets.every(n=>Number.isInteger(n)&&n>=0&&n<=255);
  const privateHost=['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.hostname.endsWith('.ts.net')||tailscaleIP;
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && privateHost)) throw new Error('Use HTTPS, or HTTP on localhost or a private Tailscale address.');
  return url.origin;
}
export const permissionFor = origin => `${origin}/*`;
export function safeUrl(value) {
  try {
    const u=new URL(value);u.username='';u.password='';
    const secret=/^(?:access[_-]?token|refresh[_-]?token|id[_-]?token|token|auth|authorization|password|passwd|secret|code|key|api[_-]?key|session|session[_-]?id|csrf|signature)$/i;
    for(const key of [...u.searchParams.keys()])if(secret.test(key))u.searchParams.set(key,'[redacted]');
    const hash=u.hash.slice(1),queryAt=hash.indexOf('?');
    if(queryAt>=0||(!hash.startsWith('/')&&hash.includes('='))){const prefix=queryAt>=0?hash.slice(0,queryAt+1):'';const params=new URLSearchParams(queryAt>=0?hash.slice(queryAt+1):hash);for(const key of [...params.keys()])if(secret.test(key))params.set(key,'[redacted]');u.hash=prefix+params.toString();}
    return u.href;
  }catch{return '';}
}
const imageError=()=>{throw new Error('Invalid or oversized PNG screenshot.');};
export function pngInfo(image,maxBytes=8*1024*1024){
  const data=image?.data_base64;if(image?.mime!=='image/png'||typeof data!=='string'||!data.length||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data)||data.length>Math.ceil(maxBytes/3)*4)imageError();
  let bytes;try{bytes=atob(data);}catch{imageError();}
  if(bytes.length>maxBytes||bytes.length<33||bytes.slice(0,8)!=='\x89PNG\r\n\x1a\n'||bytes.slice(12,16)!=='IHDR')imageError();
  const uint=i=>((bytes.charCodeAt(i)*0x1000000)+(bytes.charCodeAt(i+1)<<16)+(bytes.charCodeAt(i+2)<<8)+bytes.charCodeAt(i+3));
  const width=uint(16),height=uint(20);if(uint(8)!==13||!width||!height||width>8192||height>8192||width*height>32*1024*1024)imageError();
  return {width,height,bytes:bytes.length};
}
const finite=n=>Number.isFinite(n);
function validViewport(v){return !!v&&[v.width,v.height,v.dpr,v.scroll_x,v.scroll_y].every(finite)&&v.width>=1&&v.width<=8192&&v.height>=1&&v.height<=8192&&v.dpr>=.1&&v.dpr<=8&&Math.abs(v.scroll_x)<=1e9&&Math.abs(v.scroll_y)<=1e9;}
function validRect(r){return !!r&&[r.x,r.y,r.width,r.height].every(finite)&&Math.abs(r.x)<=1e7&&Math.abs(r.y)<=1e7&&r.width>0&&r.height>0&&r.width<=1e7&&r.height<=1e7;}
function validPoints(points){return Array.isArray(points)&&points.length<=1500&&points.every(p=>finite(p.x)&&finite(p.y)&&Math.abs(p.x)<=1e7&&Math.abs(p.y)<=1e7);}
function proportions(image,rect,dpr){return image.width<=rect.width*dpr+2&&image.height<=rect.height*dpr+2&&Math.abs(image.width*rect.height-image.height*rect.width)<=2*(rect.width+rect.height);}
export function validateFeedback(p) {
  if (!p || typeof p.client_id !== 'string' || !/^[\w-]{1,96}$/.test(p.client_id) || !/^https?:\/\//.test(p.url) || p.url.length>4096 || typeof p.message !== 'string' || p.message.length>12000 || (p.title||'').length>2048) throw new Error('Invalid feedback.');
  if(!validViewport(p.viewport))throw new Error('Invalid viewport.');
  if (!Array.isArray(p.annotations) || p.annotations.length>40 || !Array.isArray(p.crops||[]) || (p.crops||[]).length>40) throw new Error('Too many annotations.');
  const ids=new Map();
  for (const [i,n] of p.annotations.entries()) {
    if (!['element','region','draw','note'].includes(n.kind) || typeof n.id!=='string' || !/^[\w-]{1,64}$/.test(n.id) || ids.has(n.id) || (n.text||'').length>4000 || (n.number!==undefined&&n.number!==i+1) || (n.rect&&!validRect(n.rect)) || !validPoints(n.points||[]) || (['element','region'].includes(n.kind)&&!n.rect) || (n.kind==='draw'&&(n.points||[]).length<2)) throw new Error('Invalid annotation.');
    if(n.element&&(typeof n.element.tag!=='string'||n.element.tag.length>64||['text','selector','role'].some(k=>n.element[k]!==undefined&&(typeof n.element[k]!=='string'||n.element[k].length>2048))))throw new Error('Invalid element context.');
    ids.set(n.id,i+1);
  }
  if(!p.message.trim()&&!p.annotations.some(n=>n.text?.trim()))throw new Error('Add a message or a note before sending.');
  const screenshot=pngInfo(p.screenshot);if(!proportions(screenshot,p.viewport,p.viewport.dpr))throw new Error('Screenshot geometry does not match its viewport.');
  let total=screenshot.bytes;
  if(p.annotated_screenshot){const annotated=pngInfo(p.annotated_screenshot);if(annotated.width!==screenshot.width||annotated.height!==screenshot.height)throw new Error('Numbered overview dimensions must match the screenshot.');total+=annotated.bytes;}
  const cropIds=new Set();
  for(const crop of p.crops||[]){
    if(!ids.has(crop.annotation_id)||cropIds.has(crop.annotation_id)||(crop.number!==undefined&&crop.number!==ids.get(crop.annotation_id)))throw new Error('Invalid crop annotation number.');cropIds.add(crop.annotation_id);
    const image=pngInfo(crop,2*1024*1024);total+=image.bytes;
    if(crop.capture){const c=crop.capture,v=c.viewport,r=c.rect,a=c.annotation_rect;
      if(typeof c.captured_at!=='string'||!/^\d{4}-\d{2}-\d{2}T/.test(c.captured_at)||!finite(Date.parse(c.captured_at))||!validViewport(v)||!validRect(r)||!validRect(a)||!validPoints(c.points||[])||r.x<0||r.y<0||r.x+r.width>v.width+.01||r.y+r.height>v.height+.01||Math.min(r.x+r.width,a.x+a.width)<=Math.max(r.x,a.x)||Math.min(r.y+r.height,a.y+a.height)<=Math.max(r.y,a.y)||!proportions(image,r,v.dpr))throw new Error('Invalid crop capture context.');
    }
  }
  for(const n of p.annotations){const outside=point=>point.x<0||point.y<0||point.x>p.viewport.width||point.y>p.viewport.height;if((n.rect&&(outside(n.rect)||outside({x:n.rect.x+n.rect.width,y:n.rect.y+n.rect.height}))||(n.points||[]).some(outside))&&!cropIds.has(n.id))throw new Error('An offscreen annotation needs its saved screenshot crop.');}
  if(total>16*1024*1024||new TextEncoder().encode(JSON.stringify(p)).length>24*1024*1024)throw new Error('Screenshots are too large. Try a smaller browser window.');
  return p;
}
