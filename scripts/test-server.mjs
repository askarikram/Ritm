import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyIsolation } from './verify-isolation.mjs';
import { verifyWishes } from './test-wishes.mjs';
import { verifyLaunch } from './test-launch.mjs';
const base='http://127.0.0.1:4174';
const child=spawn(process.execPath,['server.js'],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',PORT:'4174',HOST:'127.0.0.1',APP_ORIGIN:base}});
async function ready(){
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)throw Error('Test server exited');
    try{const response=await fetch(base+'/healthz',{signal:AbortSignal.timeout(2000)});if(response.ok&&(await response.json()).ok)return;}catch{}
    await delay(500);
  }
  throw Error('Test server did not start');
}
try {
  await ready();
  await verifyIsolation(base,base,false);
  await verifyWishes(base);
  await verifyLaunch(base);
  if(process.env.RITM_TEST_UI==='1'){
    const {verifyUI}=await import('./test-ui.mjs');
    await verifyUI(base);
  }
} finally {
  if(child.exitCode===null){child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(()=>{child.kill('SIGKILL');resolve();},10000).unref();});}
}
