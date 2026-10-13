import assert from 'node:assert/strict';
import { randomBytes,createECDH } from 'node:crypto';
import { chromium,webkit } from 'playwright';
export async function verifyFeatureUI(base){
 let checks=0;const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('RITM_FEATURE_UI_CHECK '+label);};
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'UTC',reducedMotion:'reduce'}),page=await context.newPage();
 const username='archiveui'+[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='ArchiveUiPassword123',headers={Origin:base,'X-Ritm-User':username},errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 try{
 const signup=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Проверка архива'}});check(signup.ok(),name+': archive UI account created');
 await page.goto(base,{waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
 if(await page.locator('#close-recovery').isVisible())await page.locator('#close-recovery').click();
 await page.waitForFunction(()=>document.querySelector('#reminder-bell svg'));
 const before=await (await page.request.get(base+'/api/me',{headers})).json();
 await page.locator('[data-action="archive"]').click();await page.locator('[data-archive-month="2026-01"]').waitFor({state:'visible'});
 check(await page.locator('[data-archive-month]').count()===Number(new Date().getUTCMonth()),name+': archive lists previous 2026 months');
 await page.locator('[data-archive-month="2026-01"]').click();await page.locator('[data-archive-edit="2026-01"]:visible').click();
 await page.locator('#archive-editor [name="opening"]').fill('10000');await page.locator('#archive-editor [name="income"]').fill('100000');await page.locator('#archive-editor [name="expenses"]').fill('70000');await page.locator('#archive-editor [name="savings"]').fill('10000');
 check((await page.locator('#archive-preview').textContent()).replace(/\D/g,'')==='30000',name+': historical remainder previews immediately');
 await page.locator('#archive-editor [type="submit"]').click();await page.locator('#archive-edit-dialog').waitFor({state:'hidden'});
 check((await page.locator('[data-archive-value="remaining"]:visible').textContent()).replace(/\D/g,'')==='30000',name+': saved historical summary visible');
 const after=await (await page.request.get(base+'/api/me',{headers})).json();assert.deepEqual(after.plan,before.plan);check(after.revision===before.revision,name+': historical UI editing preserves current plan');
 await page.locator('[data-feature-close="archive-dialog"]').click();
 await page.locator('#finance-privacy').click();await page.locator('[data-action="archive"]').click();await page.locator('[data-archive-month="2026-01"]').click();
 check(await page.locator('[data-archive-value]:visible').evaluateAll(nodes=>nodes.length===5&&nodes.every(n=>n.textContent.includes('••••'))),name+': privacy masks all archived amounts');
 await page.locator('[data-archive-edit="2026-01"]:visible').click();
 check(await page.locator('#archive-editor [name="income"]').getAttribute('type')==='password',name+': privacy masks historical input');
 await page.locator('[data-feature-close="archive-edit-dialog"]').first().click();await page.locator('[data-feature-close="archive-dialog"]').click();await page.locator('#finance-privacy').click();
 for(const width of [320,390,1440]){
 await page.setViewportSize({width,height:width>600?1000:844});
 check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': home header has no horizontal overflow '+width);
 await page.locator('[data-action="archive"]').click();await page.locator('[data-archive-month="2026-01"]').click();
 check(await page.locator('[data-archive-detail="2026-01"]:visible').evaluate(node=>node.getBoundingClientRect().right<=innerWidth+1),name+': archive fits viewport '+width);
 if(name==='chromium'&&[390,1440].includes(width))console.log('RITM_SCREENSHOT_ARCHIVE_'+width+' '+(await page.screenshot({fullPage:true})).toString('base64'));
 await page.locator('[data-feature-close="archive-dialog"]').click();
 await page.locator('#reminder-bell').click();await page.locator('#reminders-form').waitFor({state:'visible'});
 check(!/Telegram|Gmail|Телеграм/.test(await page.locator('#reminders-body').textContent()),name+': only Ritm and device channels '+width);
 check(await page.locator('#reminders-form').evaluate(node=>node.getBoundingClientRect().right<=innerWidth+1),name+': reminder settings fit '+width);
 if(name==='chromium'&&[390,1440].includes(width))console.log('RITM_SCREENSHOT_REMINDERS_'+width+' '+(await page.screenshot({fullPage:true})).toString('base64'));
 await page.locator('[data-feature-close="reminders-dialog"]').click();
 }

 if(name==='chromium'){
  await context.grantPermissions(['notifications']);
  await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
  const worker=context.serviceWorkers().find(worker=>worker.url().endsWith('/sw.js'));check(!!worker,'chromium: background notification worker active');
  const settings=await (await page.request.get(base+'/api/reminders?timeZone=UTC',{headers})).json();
  const payload={owner:settings.owner,tag:'ui-fixture',body:'Аренда — 8500 теңге',genericBody:'Завтра запланирован платёж.'};
  await worker.evaluate(async ({owner,payload})=>{await displayPrefs({owner,hidden:true});await showReminder(payload);},{owner:settings.owner,payload});
  let notes=await page.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return (await r.getNotifications()).map(n=>({body:n.body,owner:n.data?.owner}));});
  check(notes.length===1&&!notes[0].body.includes('8500'),'chromium: hidden finances suppress amount in background notification');
  await worker.evaluate(async ({owner,payload})=>{await displayPrefs({owner,hidden:false});await showReminder(payload);},{owner:settings.owner,payload});
  notes=await page.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return (await r.getNotifications()).map(n=>n.body);});
  check(notes.length===1&&notes[0].includes('8500'),'chromium: explicitly visible financial notification shown');
  await worker.evaluate(async payload=>{await displayPrefs({owner:null,hidden:true});for(const n of await self.registration.getNotifications())n.close();await showReminder(payload);},payload);
  check(await page.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return (await r.getNotifications()).length===0;}),'chromium: signed-out device suppresses queued account notification');
  const curve=createECDH('prime256v1');curve.generateKeys();
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/ui-'+username,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  await page.evaluate(async data=>{
   const r=await navigator.serviceWorker.ready;let subscription=null;
   const mock={endpoint:data.endpoint,toJSON:()=>data,unsubscribe:async()=>{subscription=null;return true;}};
   Object.defineProperty(r.pushManager,'getSubscription',{value:async()=>subscription});
   Object.defineProperty(r.pushManager,'subscribe',{value:async options=>{if(!options.userVisibleOnly||options.applicationServerKey.length!==65)throw Error('Invalid push options');subscription=mock;return mock;}});
   Notification.requestPermission=async()=> 'granted';
   window.__deviceRegistration=r;
   navigator.serviceWorker.getRegistration=async()=>r;
   Object.defineProperty(navigator.serviceWorker,'ready',{value:Promise.resolve(r)});
  },subscription);
  await page.locator('#reminder-bell').click();await page.locator('#device-toggle').click();
  await page.waitForFunction(()=>document.getElementById('device-toggle')?.textContent==='Отключить');
  check((await page.request.post(base+'/api/push/status',{headers,data:{endpoint:subscription.endpoint}})).ok(),'chromium: enable phone button registers authenticated subscription');
  check((await (await page.request.post(base+'/api/push/status',{headers,data:{endpoint:subscription.endpoint}})).json()).enabled,'chromium: enabled device belongs to current session');
  await page.locator('#device-toggle').click();await page.waitForFunction(()=>document.getElementById('device-toggle')?.textContent==='Включить');
  check(!(await (await page.request.post(base+'/api/push/status',{headers,data:{endpoint:subscription.endpoint}})).json()).enabled,'chromium: disable phone button removes server subscription');
  await page.locator('[data-feature-close="reminders-dialog"]').click();
 }

 await page.locator('#reminder-bell').click();await page.locator('#reminders-form [name="inApp"]').uncheck();await page.locator('#reminders-form [name="lead"][value="3"]').check();await page.locator('#reminders-form [name="time"]').fill('10:30');await page.locator('#reminders-form [type="submit"]').click();
 await page.waitForFunction(()=>document.getElementById('toast').textContent==='Напоминания настроены');
 await page.locator('[data-feature-close="reminders-dialog"]').click();await page.reload({waitUntil:'networkidle'});
 await page.locator('#reminder-bell').click();await page.locator('#reminders-form').waitFor({state:'visible'});
 check(!await page.locator('#reminders-form [name="inApp"]').isChecked()&&await page.locator('#reminders-form [name="lead"][value="3"]').isChecked()&&await page.locator('#reminders-form [name="time"]').inputValue()==='10:30',name+': reminder preferences survive reload');
 await page.locator('[data-feature-close="reminders-dialog"]').click();
 await page.locator('[data-action="archive"]').click();await page.locator('[data-archive-month="2026-01"]').click();
 check((await page.locator('[data-archive-value="remaining"]:visible').textContent()).replace(/\D/g,'')==='30000',name+': historical month survives reload');
 await page.locator('[data-feature-close="archive-dialog"]').click();check(errors.length===0,name+': feature UI has no runtime errors');
 }finally{
 await page.request.delete(base+'/api/account',{headers,data:{currentPassword:password,confirmation:'УДАЛИТЬ'}}).catch(()=>{});
 await context.close();await browser.close();
 }
 }
 console.log('PASS '+checks+' archive and reminder UI checks');
}
