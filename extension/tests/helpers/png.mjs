import {deflateSync} from 'node:zlib';
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes){crc^=byte;for(let bit=0;bit<8;bit++)crc=(crc>>>1)^((crc&1)?0xedb88320:0);}return (crc^0xffffffff)>>>0;}
function chunk(type,data){const tag=Buffer.from(type),size=Buffer.alloc(4),crc=Buffer.alloc(4);size.writeUInt32BE(data.length);crc.writeUInt32BE(crc32(Buffer.concat([tag,data])));return Buffer.concat([size,tag,data,crc]);}
// Actual decodable RGBA PNGs, with optional uncompressed pixels to exercise budgets.
export function png(width=1,height=1,marker=0,heavy=false){const header=Buffer.alloc(13);header.writeUInt32BE(width,0);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;const pixels=Buffer.alloc((width*4+1)*height,marker%256);for(let y=0;y<height;y++)pixels[y*(width*4+1)]=0;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels,{level:heavy?0:6})),chunk('IEND',Buffer.alloc(0))]).toString('base64');}
