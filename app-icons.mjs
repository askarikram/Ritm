import { deflateSync } from 'node:zlib';
const crcTable=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0;});
function chunk(type,data){
  const name=Buffer.from(type),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(data.length);
  let value=0xffffffff;for(const byte of Buffer.concat([name,data]))value=crcTable[(value^byte)&255]^(value>>>8);
  crc.writeUInt32BE((value^0xffffffff)>>>0);return Buffer.concat([length,name,data,crc]);
}
function png(size){
  const data=Buffer.alloc(size*(size*4+1)),bars=[[162,200,312],[224,144,368],[288,180,332],[350,220,292]];
  for(let y=0;y<size;y++)for(let x=0;x<size;x++){
    let hits=0;
    for(const dx of [.25,.75])for(const dy of [.25,.75]){
      const px=(x+dx)*512/size,py=(y+dy)*512/size;
      if(bars.some(([cx,top,bottom])=>Math.hypot(px-cx,py-Math.max(top+14,Math.min(bottom-14,py)))<=14))hits++;
    }
    const mix=hits/4,base=[45-15*y/size,118-31*y/size,89-25*y/size],ink=[234,242,223],offset=y*(size*4+1)+1+x*4;
    for(let c=0;c<3;c++)data[offset+c]=Math.round(base[c]*(1-mix)+ink[c]*mix);data[offset+3]=255;
  }
  const header=Buffer.alloc(13);header.writeUInt32BE(size,0);header.writeUInt32BE(size,4);header[8]=8;header[9]=6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(data,{level:9})),chunk('IEND',Buffer.alloc(0))]);
}
export const appIcons=new Map([['/icons/icon-192.png',png(192)],['/icons/icon-512.png',png(512)],['/icons/apple-touch-icon.png',png(180)]]);
