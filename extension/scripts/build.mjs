import {safeUrl} from '../src/shared.js';
import {cp, rm, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {packageExtension} from './package.mjs';
const root = new URL('../', import.meta.url);
await rm(new URL('dist/',root), {recursive:true,force:true});
await cp(new URL('src/',root),new URL('dist/',root),{recursive:true});
console.log('Built extension/dist — load this directory unpacked in Chrome.');
const {readFile}=await import('node:fs/promises');
const content=await readFile(new URL('src/content.js',root),'utf8');
const css=await readFile(new URL('src/content.css',root),'utf8');
await writeFile(new URL('dist/content.js',root),content.replace("'__CONTENT_CSS__'",JSON.stringify(css)).replace("'__SAFE_URL__'",safeUrl.toString()).replace("'__BRAND_SVG__'",JSON.stringify((await readFile(new URL('../../web/src/brand/logo.svg',import.meta.url),'utf8')).replace('id="g"','id="sm-brand-gradient"').replaceAll('url(#g)','url(#sm-brand-gradient)'))));

const controlUi=await readFile(new URL('src/control-ui.js',root),'utf8');
await writeFile(new URL('dist/control-ui.js',root),controlUi.replace("'__BRAND_SVG__'",JSON.stringify((await readFile(new URL('../../web/src/brand/logo.svg',import.meta.url),'utf8')).replace('id="g"','id="sm-control-gradient"').replaceAll('url(#g)','url(#sm-control-gradient)'))));
await packageExtension(fileURLToPath(new URL('dist/',root)),new URL('releases/supermux-browser-extension.zip',root));
console.log('Packaged extension/releases/supermux-browser-extension.zip.');
