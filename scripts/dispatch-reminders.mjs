import { setTimeout as delay } from 'node:timers/promises';
const origin=process.env.RITM_ORIGIN||'https://ritm-r9m8.onrender.com';
if(origin!=='https://ritm-r9m8.onrender.com')throw Error('Unexpected reminder destination');
const head=process.env.GITHUB_SHA;
if(!process.env.ACTIONS_ID_TOKEN_REQUEST_URL||!process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)throw Error('GitHub OIDC is required');
// A push can reach Actions before Render finishes publishing that commit.
if(process.env.GITHUB_EVENT_NAME==='push'){
 let ready=false;
 for(let i=0;i<12;i++){
  try{const response=await fetch(origin+'/healthz',{signal:AbortSignal.timeout(20000)});const body=await response.json();if(body.version===head){ready=true;break;}}catch{}
  await delay(15000);
 }
 if(!ready)throw Error('The new release is not live yet; scheduled delivery will retry.');
}
const request=new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);request.searchParams.set('audience',origin);
const identity=await fetch(request,{headers:{Authorization:'Bearer '+process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN},signal:AbortSignal.timeout(15000)});
if(!identity.ok)throw Error('Scheduler identity unavailable');
const {value}=await identity.json();
const response=await fetch(origin+'/api/reminders/dispatch',{method:'POST',headers:{Authorization:'Bearer '+value},signal:AbortSignal.timeout(90000)});
if(!response.ok)throw Error('Reminder dispatch failed with status '+response.status);
const result=await response.json();
console.log('Reminder delivery:',JSON.stringify(result));
