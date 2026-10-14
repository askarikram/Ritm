import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium,webkit } from 'playwright';
import { grantFixturePremium } from './premium-fixture.mjs';
export async function verifyNotificationUI(base){
 let checks=0;const check=(v,label)=>{assert.ok(v,label);checks++;console.log('RITM_NOTIFICATION_UI_CHECK '+label);};
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'UTC',reducedMotion:'reduce'}),otherContext=await browser.newContext({viewport:{width:1440,height:1000},timezoneId:'UTC',reducedMotion:'reduce'}),page=await context.newPage(),otherPage=await otherContext.newPage();
  const suffix=[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),username='inboxui'+suffix,otherUsername='inboxother'+suffix,password='InboxUiPassword123',headers={Origin:base,'X-Ritm-User':username},errors=[],day=new Date().toISOString().slice(0,10);
  page.on('pageerror',e=>{errors.push(e.message);console.log('RITM_NOTIFICATION_BROWSER_ERROR '+e.stack);});page.on('dialog',dialog=>dialog.accept());
  const navigate=async route=>{await page.evaluate(route=>location.hash=route,route);await page.waitForFunction(route=>document.querySelector('[data-nav="'+(['profile',...['notifications','plan','data','app','delete'].map(x=>'settings-'+x),'premium'].includes(route)?'settings':route==='goals'?'goals':route)+'"][aria-current="page"]'),route);};
  const fits=async(label)=>{for(const width of [320,390,1440]){await page.setViewportSize({width,height:1000});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': '+label+' fits '+width); }await page.setViewportSize({width:390,height:844});};
  let created=false,otherCreated=false;
  try{
   const signup=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Тест уведомлений'}});assert.ok(signup.ok());created=true;
   await page.request.patch(base+'/api/reminders',{headers,data:{inApp:true,lead:0,time:'00:00',timeZone:'UTC',showAmounts:false}});
   const plan={version:1,balance:0,daily:0,currency:'KZT',goals:[],done:{},ledger:[],items:[{id:'current',title:'Аренда квартиры',type:'payment',date:day,repeat:'none',amount:850000},{id:'overdue',title:'Оплатить интернет',type:'payment',date:day,repeat:'none',amount:450000}]};
   assert.ok((await page.request.put(base+'/api/plan',{headers,data:{revision:0,plan}})).ok());
   await page.goto(base,{waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});await page.waitForFunction(()=>document.querySelector('#reminder-bell .reminder-badge')?.textContent==='2');
   check(await page.locator('#reminder-bell').evaluate(n=>n.classList.contains('has-unread')),name+': bell is green and counts two unread arrivals');
   await otherPage.request.post(base+'/api/login',{headers:{Origin:base},data:{username,password}});await otherPage.goto(base,{waitUntil:'networkidle'});await otherPage.waitForFunction(()=>document.querySelector('#reminder-bell .reminder-badge')?.textContent==='2');
   const inbox=await (await page.request.get(base+'/api/notifications',{headers})).json(),id=inbox.notifications.find(n=>n.itemId==='current').id;
   await page.locator('#reminder-bell').click();await page.locator('.notification-row.is-unread').first().waitFor();
   check(await page.locator('#reminders-form').count()===0&&await page.locator('#reminders-dialog .notification-row.is-unread').count()===2,name+': bell opens received messages without settings');
   await fits('notification inbox');
   if(name==='chromium')console.log('RITM_SCREENSHOT_NOTIFICATION_INBOX '+(await page.screenshot()).toString('base64'));
   await page.locator('[data-notification-id="'+id+'"]').click();await page.locator('#notification-detail-dialog').waitFor({state:'visible'});
   check((await page.locator('#notification-detail-body').textContent()).includes('Аренда квартиры')&&(await page.locator('#notification-detail-body').textContent()).replace(/\s/g,'').includes('8500теңге'),name+': reminder detail shows actual title amount and date');
   check((await page.locator('#reminder-bell').textContent()).includes('2'),name+': opening detail does not read every arrival');
   const readSaved=page.waitForResponse(r=>r.url().endsWith('/api/notifications/read')&&r.request().method()==='POST');
   await page.locator('#notification-detail-dialog [data-notify-action="close-detail"]').first().click();check((await readSaved).ok(),name+': read receipt saved on server');
   await page.waitForFunction(id=>document.querySelector('[data-notification-id="'+id+'"]')?.classList.contains('is-read')&&document.querySelector('#reminder-bell .reminder-badge')?.textContent==='1',id);
   await page.waitForFunction(id=>{const n=document.querySelector('[data-notification-id="'+id+'"]');return n&&getComputedStyle(n).backgroundColor==='rgb(255, 255, 255)';},id);
   check(true,name+': closed reminder becomes white and badge decreases');
   await otherPage.evaluate(()=>window.dispatchEvent(new Event('focus')));await otherPage.waitForFunction(()=>document.querySelector('#reminder-bell .reminder-badge')?.textContent==='1');check(true,name+': read state synchronizes to a second device');
   await page.locator('[data-feature-close="reminders-dialog"]').click();await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#reminder-bell .reminder-badge')?.textContent==='1');
   for(const route of ['income','payment','goals','calendar','settings','home']){await navigate(route);await page.locator('#reminder-bell').click();await page.locator('[data-notification-id="'+id+'"].is-read').waitFor();check(await page.locator('.notification-row.is-unread').count()===1,name+': received inbox is shared in '+route);await page.locator('[data-feature-close="reminders-dialog"]').click();}
   await navigate('settings');check(await page.locator('#profile-name-form').count()===0&&await page.locator('.settings-row').first().getAttribute('href')==='#profile'&&await page.locator('.settings-row').last().getAttribute('href')==='#settings-delete',name+': settings are rows with Profile first and Delete last');
   await fits('settings menu');if(name==='chromium')console.log('RITM_SCREENSHOT_SETTINGS_MENU '+(await page.screenshot({fullPage:true})).toString('base64'));
   await page.locator('.settings-row[href="#profile"]').click();await page.locator('#profile-name-form').waitFor();
   check(await page.locator('#profile-password-form').isVisible()&&await page.locator('#recovery-code-form').isVisible(),name+': profile contains name password and recovery');await fits('profile');
   await page.locator('.settings-back').click();await page.locator('.settings-row[href="#settings-notifications"]').click();await page.locator('#reminders-form').waitFor();
   check(await page.locator('#device-toggle').isVisible(),name+': notification preferences and phone control are in settings');await fits('notification settings');
   await page.locator('#reminders-form [name="time"]').fill('10:30');await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   check(await page.locator('#reminders-form [name="time"]').inputValue()==='10:30',name+': notification polling preserves unsaved preferences');
   await page.locator('#reminders-form [name="time"]').fill('00:00');await page.locator('#reminders-form [type="submit"]').click();await page.waitForFunction(()=>document.getElementById('toast').textContent==='Напоминания настроены');
   await page.locator('#reminder-bell').click();await page.locator('[data-notify-action="read-all"]').click();await page.waitForFunction(()=>!document.querySelector('#reminder-bell .reminder-badge'));
   check(await page.locator('#reminders-dialog .notification-row.is-read').count()===2,name+': read all clears counter and keeps white history');
   await page.locator('[data-feature-close="reminders-dialog"]').click();
   for(const [route,title] of [['settings-plan','Баланс и расходы'],['settings-data','Ваши данные'],['settings-app','Приложение и помощь'],['settings-delete','Удалить аккаунт']]){await navigate(route);check(await page.locator('#heading').textContent()===title,name+': settings section '+route);await fits(route);}
   await page.goto(base+'/#notifications?view='+id,{waitUntil:'networkidle'});await page.locator('#notification-detail-dialog').waitFor({state:'visible'});
   check((await page.locator('#notification-detail-body').textContent()).includes('Аренда квартиры'),name+': phone receipt link opens the exact message');
   await page.locator('#notification-detail-dialog [data-notify-action="close-detail"]').first().click();
   await grantFixturePremium(base,username);let personal=await (await page.request.get(base+'/api/personal?timeZone=UTC',{headers})).json();
   await page.request.post(base+'/api/personal',{headers,data:{revision:personal.revision,action:'add_task',item:{title:'Подготовить документы',date:day,time:'00:00'}}});
   await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('#reminder-bell .reminder-badge')?.textContent==='1');
   check((await page.locator('#notification-page-body').textContent()).includes('Подготовить документы'),name+': Premium receives concrete personal reminder');
   await navigate('profile');await page.locator('#profile-name-form [data-action="account-logout"]').click();await page.locator('#auth-screen').waitFor({state:'visible'});
   check(await page.locator('#reminders-body').textContent()===''&&await page.locator('#notification-detail-body').textContent()==='',name+': logout clears notification contents');
   await otherPage.request.post(base+'/api/signup',{headers:{Origin:base},data:{username:otherUsername,password,confirmPassword:password,name:'Другой аккаунт'}});otherCreated=true;
   await otherPage.reload({waitUntil:'networkidle'});await otherPage.locator('#application').waitFor({state:'visible'});
   check(await otherPage.locator('#reminder-bell .reminder-badge').count()===0,name+': different account has no previous unread badge');
   check(errors.length===0,name+': browser has no runtime errors '+errors.join(';'));
  }finally{
   await page.request.post(base+'/api/login',{headers:{Origin:base},data:{username,password}}).catch(()=>{});
   if(created)await page.request.delete(base+'/api/account',{headers,data:{currentPassword:password,confirmation:'УДАЛИТЬ'}}).catch(()=>{});
   if(otherCreated)await otherPage.request.delete(base+'/api/account',{headers:{Origin:base,'X-Ritm-User':otherUsername},data:{currentPassword:password,confirmation:'УДАЛИТЬ'}}).catch(()=>{});
   await context.close();await otherContext.close();await browser.close();
  }
 }
 console.log('RITM_NOTIFICATION_UI_PASS '+checks);
}
