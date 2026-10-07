// This harness uses the production overlay. Only the Chrome worker is mocked.
let listener;const runtime={id:'preview',onMessage:{addListener(fn){listener=fn;}},async sendMessage(m){
 if(m.type==='draft.load')return{ok:true,data:{connection:{paired:false}}};
 if(m.type==='capture'){
  const raw=await new Promise(resolve=>listener({type:'capture.prepare'},{id:'preview'},resolve));
  const canvas=document.createElement('canvas');canvas.width=innerWidth;canvas.height=innerHeight;const ctx=canvas.getContext('2d');ctx.fillStyle='#f5f6f0';ctx.fillRect(0,0,innerWidth,innerHeight);
  for(const el of document.querySelectorAll('nav strong,h1,p,main button,.eyebrow,.card strong,nav span')){const r=el.getBoundingClientRect(),style=getComputedStyle(el);ctx.fillStyle=style.color;ctx.font=`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;let x=r.x,y=r.y+parseFloat(style.fontSize),line='';for(const word of el.textContent.replace(/\s+/g,' ').split(' ')){if(ctx.measureText(line+word).width>r.width&&line){ctx.fillText(line,x,y);line='';y+=parseFloat(style.lineHeight)||parseFloat(style.fontSize)*1.1;}line+=word+' ';}ctx.fillText(line,x,y);}
  const art=document.querySelector('.art').getBoundingClientRect();ctx.fillStyle='#e5eadb';ctx.beginPath();ctx.roundRect(art.x,art.y,art.width,art.height,25);ctx.fill();const orb=document.querySelector('.orb').getBoundingClientRect();const g=ctx.createRadialGradient(orb.x+70,orb.y+60,10,orb.x+100,orb.y+110,140);g.addColorStop(0,'#f0f2e1');g.addColorStop(1,'#bdcba8');ctx.fillStyle=g;ctx.beginPath();ctx.arc(orb.x+orb.width/2,orb.y+orb.height/2,orb.width/2,0,Math.PI*2);ctx.fill();for(const el of document.querySelectorAll('input')){const r=el.getBoundingClientRect();ctx.fillStyle='#222d24';ctx.fillRect(r.x-2,r.y-2,r.width+4,r.height+4);}
  listener({type:'capture.restore'},{id:'preview'},()=>{});return{ok:true,data:{...raw,dataUrl:canvas.toDataURL('image/png')}};
 }
 if(m.type==='settings.open')return{ok:false,error:'This is a UI preview. Load extension/dist unpacked in Chrome for real pairing.'};
 return{ok:true,data:true};
}};globalThis.chrome={...(globalThis.chrome||{}),runtime};
