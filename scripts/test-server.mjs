import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyIsolation } from './verify-isolation.mjs';
import { verifyWishes } from './test-wishes.mjs';
import { verifyLaunch } from './test-launch.mjs';
import { verifyMonths } from './test-months.mjs';
import { verifyFeatures } from './test-features.mjs';
import { verifyPersonal } from './test-personal.mjs';
import { verifySubscriptions } from './test-subscription.mjs';
import { verifyNotifications } from './test-notifications.mjs';
import { verifySecurity } from './test-security.mjs';
const base='http://127.0.0.1:4174';
const spawnServer=()=>spawn(process.execPath,['server.js'],{stdio:'inherit',env:{...process.env,NODE_ENV:'test',PORT:'4174',HOST:'127.0.0.1',APP_ORIGIN:base}});
let child=spawnServer();
async function ready(){
  for(let i=0;i<60;i++){
    if(child.exitCode!==null)throw Error('Test server exited');
    try{const response=await fetch(base+'/healthz',{signal:AbortSignal.timeout(2000)});if(response.ok&&(await response.json()).ok)return;}catch{}
    await delay(500);
  }
  throw Error('Test server did not start');
}
async function stopServer(){
  if(child.exitCode!==null)return;
  await new Promise(resolve=>{
    const current=child;
    current.once('exit',()=>{clearTimeout(deadline);resolve();});
    const deadline=setTimeout(()=>current.kill('SIGKILL'),10000);deadline.unref();
    current.kill('SIGTERM');
  });
}
async function setOriginAvailable(available){
  if(available){child=spawnServer();await ready();}
  else await stopServer();
}
try {
  await ready();
  await verifyMonths();
  await verifyIsolation(base,base,false);
  await verifyWishes(base);
  await verifyLaunch(base);
  await verifyFeatures(base);
  await verifyPersonal(base);
  await verifySubscriptions(base);
  await verifyNotifications(base);
  await verifySecurity(base);
  if(process.env.RITM_TEST_UI==='1'){
    const {verifyNotificationUI}=await import('./test-notifications-ui.mjs');await verifyNotificationUI(base);
    const {verifySubscriptionUI}=await import('./test-subscription-ui.mjs');await verifySubscriptionUI(base);
    const {verifyPersonalUI}=await import('./test-personal-ui.mjs');await verifyPersonalUI(base);
    const {verifyFeatureUI}=await import('./test-feature-ui.mjs');await verifyFeatureUI(base);
    const {verifyMonthUI}=await import('./test-month-ui.mjs');
    await verifyMonthUI(base);
    const {verifyUI}=await import('./test-ui.mjs');
    await verifyUI(base,{setOriginAvailable});
  }
} finally { await stopServer(); }
