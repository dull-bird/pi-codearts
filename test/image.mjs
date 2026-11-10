import {deflateSync} from 'node:zlib';
// Deterministic red RGB PNG, generated locally; no private image is uploaded by tests.
export function redPng() {
 const crc=b=>{let n=0xffffffff;for(const v of b){n^=v;for(let i=0;i<8;i++)n=(n>>>1)^((n&1)?0xedb88320:0);}return (n^0xffffffff)>>>0;};
 const chunk=(name,data)=>{const tag=Buffer.from(name),length=Buffer.alloc(4),checksum=Buffer.alloc(4);length.writeUInt32BE(data.length);checksum.writeUInt32BE(crc(Buffer.concat([tag,data])));return Buffer.concat([length,tag,data,checksum]);};
 const header=Buffer.alloc(13);header.writeUInt32BE(64,0);header.writeUInt32BE(64,4);header[8]=8;header[9]=2;
 const pixels=Buffer.alloc((64*3+1)*64);for(let y=0;y<64;y++)for(let x=0;x<64;x++)pixels[y*(64*3+1)+1+x*3]=255;
 return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(pixels)),chunk('IEND',Buffer.alloc(0))]).toString('base64');
}
