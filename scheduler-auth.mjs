import { createPublicKey, verify } from 'node:crypto';
const issuer='https://token.actions.githubusercontent.com';
const repository='askarikram/Ritm',repositoryId='1415973682';
let cachedKeys=null,cachedUntil=0;
async function publicKeys(){
  if(cachedKeys&&Date.now()<cachedUntil)return cachedKeys;
  const response=await fetch(issuer+'/.well-known/jwks',{signal:AbortSignal.timeout(10000)});
  if(!response.ok)throw Error('Scheduler signing keys unavailable');
  const body=await response.json();if(!Array.isArray(body.keys))throw Error('Invalid scheduler keys');
  cachedKeys=body.keys;cachedUntil=Date.now()+3600000;return cachedKeys;
}
export async function verifySchedulerToken(token,audience,{now=Date.now(),keys}={}){
  if(typeof token!=='string'||token.length>12000||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token))throw Error('Invalid scheduler authorization');
  const parts=token.split('.');let header,claims;
  try{header=JSON.parse(Buffer.from(parts[0],'base64url'));claims=JSON.parse(Buffer.from(parts[1],'base64url'));}catch{throw Error('Invalid scheduler token');}
  const seconds=Math.floor(now/1000);
  if(header.alg!=='RS256'||typeof header.kid!=='string'||claims.iss!==issuer||claims.aud!==audience||claims.repository!==repository||claims.repository_id!==repositoryId||claims.ref!=='refs/heads/main'||claims.workflow_ref!==repository+'/.github/workflows/reminder-delivery.yml@refs/heads/main'||!['schedule','workflow_dispatch','push'].includes(claims.event_name)||!Number.isInteger(claims.exp)||claims.exp<=seconds||claims.exp>seconds+3600||!Number.isInteger(claims.iat)||claims.iat>seconds+60||claims.nbf!==undefined&&claims.nbf>seconds+60)throw Error('Scheduler identity rejected');
  const candidates=keys||await publicKeys(),key=candidates.find(key=>key.kid===header.kid&&key.kty==='RSA');
  if(!key||!verify('RSA-SHA256',Buffer.from(parts[0]+'.'+parts[1]),createPublicKey({key,format:'jwk'}),Buffer.from(parts[2],'base64url')))throw Error('Scheduler signature rejected');
  return claims;
}
