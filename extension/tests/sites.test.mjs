import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {DEFAULT_BLOCKED_SITES,blockedList,hostMatches,parseSelfHost,refusal} from '../src/sites.js';

test('blocked domains and every subdomain are refused, lookalikes are not',()=>{
 for(const url of ['https://paypal.com/','https://www.paypal.com/signin','https://WWW.PAYPAL.COM./x','https://accounts.google.com/','https://a.mijn.belastingdienst.nl/','https://ing.nl:8443/','https://ＰＡＹＰＡＬ.com/'])assert.equal(refusal(url),'blocked',url);
 for(const url of ['https://notpaypal.com/','https://paypal.com.evil.test/','https://pаypal.com/','https://belastingdienst.nl/','https://idmsa.apple.com/','https://mail.google.com/','https://example.com/'])assert.equal(refusal(url),null,url);
 assert.equal(hostMatches('xpaypal.com','paypal.com'),false);
});
test('only http(s) without credentials can be controlled',()=>{
 for(const url of ['file:///etc/passwd','javascript:alert(1)','chrome://settings','data:text/html,x','https://u:p@example.com/','https://u@example.com/','ftp://example.com/','not a url'])assert.equal(refusal(url),'invalid',url);
});
test('the Supermux server is blocked: named hosts on every port, loopback on its port',()=>{
 const list=blockedList({blocked_sites:['paypal.com'],blocked_hosts:['mac.tail1234.ts.net','127.0.0.1:8823','[::1]:8823']});
 assert.equal(refusal('https://mac.tail1234.ts.net/',list),'blocked');assert.equal(refusal('https://MAC.tail1234.ts.net:8443/chat',list),'blocked');
 assert.equal(refusal('http://127.0.0.1:8823/',list),'blocked');assert.equal(refusal('http://[::1]:8823/',list),'blocked');
 assert.equal(refusal('http://127.0.0.1:3000/',list),null);assert.equal(refusal('http://localhost:3000/',list),null);
 assert.deepEqual(parseSelfHost('localhost:8823'),{host:'localhost',port:8823});
});
test('the server list wins; the shipped default is only a fallback and matches the server',async()=>{
 assert.deepEqual(blockedList({blocked_sites:['example.org']}).sites,['example.org']);
 assert.deepEqual(blockedList(null).sites,[...DEFAULT_BLOCKED_SITES]);
 assert.deepEqual(blockedList({blocked_sites:'paypal.com'}).sites,[...DEFAULT_BLOCKED_SITES]);
 const rust=await readFile(new URL('../../server/src/browser_feedback/sites.rs',import.meta.url),'utf8');
 const server=[...rust.slice(rust.indexOf('BLOCKED_SITES'),rust.indexOf('];')).matchAll(/"([^"]+)"/g)].map(m=>m[1]);
 assert.deepEqual(server,[...DEFAULT_BLOCKED_SITES]);
});
