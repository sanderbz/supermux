import {lstat, mkdir, readFile, readdir, rename, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

// Only shipped extension assets enter the archive, never browser storage,
// local settings, test captures, or files accidentally added to dist.
const allowed = new Set(['manifest.json','content.js','content.css','worker.js',
  'shared.js','logo.svg','options.js','options.html','options.css',
  ...[16,32,48,128].map(n=>`icons/${n}.png`)]);
function crc32(bytes) {
  let crc=0xffffffff;
  for(const byte of bytes) {crc^=byte;for(let bit=0;bit<8;bit++) crc=(crc>>>1)^((crc&1)?0xedb88320:0);}
  return (crc^0xffffffff)>>>0;
}

// ZIP's stored method avoids dependency/version-sensitive compression. Fixed
// DOS timestamps, permissions, UTF-8 names and sorted entries make it repeatable.
export function createZip(entries) {
  const files=[...entries].sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0);
  const local=[], central=[];
  let offset=0;
  for(const {name,data} of files) {
    if(!allowed.has(name)) throw new Error(`Unexpected extension asset: ${name}`);
    const filename=Buffer.from(name), bytes=Buffer.from(data), crc=crc32(bytes);
    const header=Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50,0);header.writeUInt16LE(20,4);
    header.writeUInt16LE(0x0800,6);header.writeUInt16LE(33,12);
    header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);
    header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(filename.length,26);
    local.push(header,filename,bytes);
    const record=Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50,0);record.writeUInt16LE(0x0314,4);
    record.writeUInt16LE(20,6);record.writeUInt16LE(0x0800,8);
    record.writeUInt16LE(33,14);record.writeUInt32LE(crc,16);
    record.writeUInt32LE(bytes.length,20);record.writeUInt32LE(bytes.length,24);
    record.writeUInt16LE(filename.length,28);record.writeUInt32LE((0o100644<<16)>>>0,38);
    record.writeUInt32LE(offset,42);central.push(record,filename);
    offset+=header.length+filename.length+bytes.length;
  }
  const directory=Buffer.concat(central), end=Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(files.length,8);
  end.writeUInt16LE(files.length,10);end.writeUInt32LE(directory.length,12);
  end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,directory,end]);
}

export async function packageExtension(dist, archive) {
  const entries=[];
  async function visit(relative='') {
    for(const name of await readdir(join(dist,relative))) {
      const path=join(dist,relative,name), asset=relative?`${relative}/${name}`:name;
      const info=await lstat(path);
      if(info.isSymbolicLink()) throw new Error(`Extension asset is a symlink: ${asset}`);
      if(info.isDirectory() && asset==='icons') await visit(asset);
      else if(info.isFile() && allowed.has(asset)) entries.push({name:asset,data:await readFile(path)});
      else throw new Error(`Unexpected extension asset: ${asset}`);
    }
  }
  await visit();
  if(entries.length!==allowed.size) throw new Error('Extension build is incomplete.');
  const bytes=createZip(entries);
  await mkdir(new URL('.',archive),{recursive:true});
  const temporary=new URL(`${archive.href}.tmp-${process.pid}`);
  await writeFile(temporary,bytes);
  await rename(temporary,archive);
  return bytes;
}
