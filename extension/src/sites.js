// "All websites" guards. The server owns the blocklist and sends it in the
// control ready frame; this copy of the same first list is only a fallback
// when a ready frame carries none. Matching: the domain itself and every
// subdomain, on a label boundary, case-insensitively, on the punycode host
// that URL parsing produces. Only http(s) without embedded credentials.
export const ALL_SITES_HOURS = 24;
export const DEFAULT_BLOCKED_SITES = Object.freeze([
  'accounts.google.com','myaccount.google.com','passwords.google.com','pay.google.com','payments.google.com','admin.google.com','chromewebstore.google.com',
  'appleid.apple.com','account.apple.com','login.live.com','account.microsoft.com','account.live.com',
  'ing.nl','abnamro.nl','rabobank.nl','snsbank.nl','asnbank.nl','regiobank.nl','knab.nl','triodos.nl','bunq.com','revolut.com','wise.com','paypal.com','americanexpress.com','icscards.nl','adyen.com','mollie.com','stripe.com',
  'degiro.nl','degiro.com','bitvavo.com','coinbase.com','binance.com','kraken.com',
  'digid.nl','mijn.belastingdienst.nl','mijnoverheid.nl',
  '1password.com','bitwarden.com','lastpass.com',
]);
const host=value=>String(value||'').trim().toLowerCase().replace(/\.+$/,'').replace(/^\[|\]$/g,'');
export function hostMatches(candidate,domain){
  const h=host(candidate),d=host(domain);
  return !!d&&(h===d||h.endsWith('.'+d));
}
const ipOrLoopback=h=>h==='localhost'||h.endsWith('.localhost')||/^\d{1,3}(\.\d{1,3}){3}$/.test(h)||h.includes(':');
// `host` or `host:port` (IPv6 as `[::1]:port`). A named host is blocked on
// every port; a loopback/IP host on its port only.
export function parseSelfHost(value){
  try{const u=new URL('http://'+String(value).trim());const h=host(u.hostname);if(!h)return null;return {host:h,port:ipOrLoopback(h)?(u.port?Number(u.port):null):null};}catch{return null;}
}
export function blockedList(ready){
  const valid=list=>Array.isArray(list)&&list.length<=1000&&list.every(v=>typeof v==='string'&&v.length>0&&v.length<=255);
  return {sites:valid(ready?.blocked_sites)?ready.blocked_sites:[...DEFAULT_BLOCKED_SITES],hosts:valid(ready?.blocked_hosts)?ready.blocked_hosts.map(parseSelfHost).filter(Boolean):[]};
}
// Returns null when allowed, else 'invalid' or 'blocked'.
export function refusal(raw,{sites=DEFAULT_BLOCKED_SITES,hosts=[]}={}){
  let url;try{url=new URL(raw);}catch{return 'invalid';}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||!url.hostname)return 'invalid';
  const h=host(url.hostname),port=Number(url.port||(url.protocol==='https:'?443:80));
  if(sites.some(d=>hostMatches(h,d)))return 'blocked';
  if(hosts.some(s=>s.host===h&&(s.port==null||s.port===port)))return 'blocked';
  return null;
}
