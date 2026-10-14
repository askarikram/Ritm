import { writeFileSync, mkdirSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
const origin='https://ritm-r9m8.onrender.com';
if(process.env.RITM_ORIGIN&&process.env.RITM_ORIGIN!==origin)throw Error('Unexpected backup destination');
if(!process.env.ACTIONS_ID_TOKEN_REQUEST_URL||!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('GitHub OIDC is required');
if(process.env.GITHUB_EVENT_NAME==='push'){
 let ready=false;
 for(let i=0;i<20;i++){
  try{const response=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(20000)});if((await response.json()).version===process.env.GITHUB_SHA){ready=true;break;}}catch{}
  await delay(15000);
 }
 if(!ready)throw Error('The new release is not live yet');
}
const request=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);request.searchParams.set('audience',origin);
const identity=await fetch(request,{headers:{Authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},signal:AbortSignal.timeout(15000)});
if(!identity.ok)throw Error('Backup scheduler identity unavailable');
const {value}=await identity.json();
const response=await fetch(origin+'/api/maintenance/backup',{method:'POST',headers:{Authorization:'Bearer '+value},signal:AbortSignal.timeout(90000)});
if(!response.ok)throw Error('Backup failed with HTTP '+response.status+'. Check server backup configuration.');
const encrypted=await response.json();
if(encrypted.format!=='ritm-encrypted-backup'||encrypted.version!==1||typeof encrypted.data!=='string'||!encrypted.data.length)throw Error('Invalid encrypted backup');
mkdirSync('backup-output',{recursive:true});
writeFileSync('backup-output/ritm-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json',JSON.stringify(encrypted),{mode:0o600});
console.log('Encrypted full backup downloaded. No plaintext records or encryption key are written to Actions.');
