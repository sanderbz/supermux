import test from 'node:test';import assert from 'node:assert/strict';
import {endpointOrigin,permissionFor,safeUrl,validateFeedback,pngInfo} from '../src/shared.js';
import {png} from './helpers/png.mjs';
const tinyPNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aV1sAAAAASUVORK5CYII=';
test('accept only secure, localhost, and Tailscale server addresses',()=>{
 for(const origin of ['https://work.example','http://localhost:8080','http://100.64.1.4:8080','http://100.127.255.255:999','http://work.tailnet.ts.net'])assert.equal(endpointOrigin(origin),origin);
 for(const origin of ['http://public.example','http://100.128.0.1','http://100.63.0.1','https://me:secret@example.com','https://example.com/api','https://example.com?token=secret'])assert.throws(()=>endpointOrigin(origin));
 assert.equal(permissionFor('https://work.example'),'https://work.example/*');
});

test('fractional narrow crop geometry tolerates pixel rounding on both axes',()=>{
 const viewport={width:100,height:1200,dpr:1,scroll_x:0,scroll_y:0},rect={x:0,y:0,width:24.49,height:1000};
 const p={client_id:'narrow',url:'https://example.com',message:'Fix narrow detail',viewport,screenshot:{mime:'image/png',data_base64:png(100,1200)},annotations:[{id:'one',kind:'region',rect}],crops:[{annotation_id:'one',mime:'image/png',data_base64:png(24,1000),capture:{captured_at:'2026-10-07T12:00:00Z',viewport,rect,annotation_rect:rect}}]};
 assert.equal(validateFeedback(p),p);assert.throws(()=>validateFeedback({...p,crops:[{...p.crops[0],data_base64:png(24,800)}]}),/capture context/);
});
test('URL context does not disclose query, fragment, or credentials',()=>assert.equal(safeUrl('https://me:secret@example.com/path?token=secret#private'),'https://example.com/path?token=%5Bredacted%5D#private'));
test('reject invalid feedback and excessive attachments',()=>{const p={client_id:'one',url:'https://example.com',message:'fix it',viewport:{width:100,height:100,dpr:1,scroll_x:0,scroll_y:0},annotations:[],screenshot:{mime:'image/png',data_base64:tinyPNG}};assert.equal(validateFeedback(p),p);assert.throws(()=>validateFeedback({...p,annotations:Array(41).fill({})}));assert.throws(()=>validateFeedback({...p,screenshot:{mime:'image/jpeg',data_base64:'x'}}));});

test('preserve query and hash router context while masking auth fragments',()=>{assert.equal(safeUrl('https://site.example/?page=pricing#/about?tab=plans'),'https://site.example/?page=pricing#/about?tab=plans');assert.equal(safeUrl('https://site.example/#access_token=abc&state=hello'),'https://site.example/#access_token=%5Bredacted%5D&state=hello');});

test('normalize a pasted Tailscale server trailing slash',()=>assert.equal(endpointOrigin('https://macmini.taild681cb.ts.net/'),'https://macmini.taild681cb.ts.net'));

test('validates numbered overview, native crop limits and immutable original capture context',()=>{
 const image={mime:'image/png',data_base64:tinyPNG},viewport={width:100,height:100,dpr:1,scroll_x:0,scroll_y:200};
 const payload={client_id:'one',url:'https://example.com',message:'',viewport,screenshot:image,annotated_screenshot:image,annotations:[{id:'note',number:1,kind:'element',text:'Fix this',rect:{x:10,y:-50,width:10,height:10}}],crops:[{...image,annotation_id:'note',number:1,capture:{captured_at:'2026-10-07T10:00:00.000Z',viewport:{...viewport,scroll_y:0},rect:{x:5,y:45,width:20,height:20},annotation_rect:{x:10,y:50,width:10,height:10}}}]};
 assert.equal(validateFeedback(payload),payload);assert.equal(pngInfo(image).width,1);
 for(const change of [p=>p.annotations[0].number=2,p=>p.crops[0].number=2,p=>p.crops.push({...p.crops[0]}),p=>p.crops[0].capture.rect.x=-1,p=>p.crops[0].capture.annotation_rect.x=90,p=>p.crops[0].capture.captured_at='yesterday',p=>p.crops[0].capture.points=[{x:NaN,y:4}],p=>p.crops[0].capture.viewport.dpr=0,p=>p.viewport.scroll_y=Infinity,p=>p.screenshot.data_base64='YQ==']){const invalid=structuredClone(payload);change(invalid);assert.throws(()=>validateFeedback(invalid));}
 const legacy=structuredClone(payload);delete legacy.annotated_screenshot;delete legacy.annotations[0].number;delete legacy.crops[0].capture;delete legacy.crops[0].number;assert.equal(validateFeedback(legacy),legacy);
 const wrongSize=Buffer.from(tinyPNG,'base64');wrongSize.writeUInt32BE(10,16);assert.throws(()=>validateFeedback({...payload,annotated_screenshot:{...image,data_base64:wrongSize.toString('base64')}}),/dimensions/);
 assert.throws(()=>pngInfo({...image,data_base64:'a'.repeat(2800000)},2*1024*1024),/oversized/);
 const oversized=Buffer.from(tinyPNG,'base64');oversized.writeUInt32BE(9000,16);assert.throws(()=>pngInfo({...image,data_base64:oversized.toString('base64')}));
});
