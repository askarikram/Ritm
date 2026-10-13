import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium,webkit } from 'playwright';
import { Personal } from '../personal-domain.mjs';
export async function verifyPersonalUI(base){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_PERSONAL_UI_CHECK '+label);};
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await engine.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Almaty',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
 const username='personalui'+[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='PersonalUiPassword123',headers={Origin:base,'X-Ritm-User':username},day=Personal.clock('Asia/Almaty').date;
 page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
 const read=async()=>{const response=await page.request.get(base+'/api/personal',{headers});assert.ok(response.ok());return response.json();};
 const row=id=>page.locator('[data-personal-row="'+id+'"]'),navigate=async route=>{await page.evaluate(route=>location.hash=route,route);await page.waitForFunction(route=>document.querySelector('[data-nav="'+(route==='goals'?'personal':route)+'"][aria-current="page"]'),route);};
 let created=false;
 try{
 const signup=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Проверка личного'}});check(signup.ok(),name+': disposable personal UI account created');created=true;
 const moneyPlan={version:1,balance:42000000,daily:0,currency:'KZT',items:[],goals:[{id:'savings',title:'Путешествие',target:50000000,saved:10000000,mode:'monthly',monthly:1000000,start:day,deadline:Personal.addDays(day,365),done:[]}],done:{},ledger:[]};
 check((await page.request.put(base+'/api/plan',{headers,data:{revision:0,plan:moneyPlan}})).ok(),name+': existing savings plan seeded');
 let seed=await read(),revision=seed.revision;
 const command=async data=>{const reply=await page.request.post(base+'/api/personal',{headers,data:{revision,...data}});assert.ok(reply.ok(),await reply.text());const body=await reply.json();revision=body.revision;return body;};
 await command({action:'add_task',item:{title:'Отправить письмо',date:day,time:'09:00'}});
 seed=await command({action:'add_task',item:{title:'Подготовить документы',date:day,time:'10:00'}});const documentId=seed.state.tasks[1].id;
 seed=await command({action:'add_task',item:{title:'Встреча',date:day,time:'15:00'}});const meetingId=seed.state.tasks[2].id;
 await command({action:'complete_task',id:seed.state.tasks[0].id,done:true});
 seed=await command({action:'add_habit',item:{title:'Зарядка',date:day,time:'08:00',repeat:'daily'}});
 seed=await command({action:'add_habit',item:{title:'Читать 10 минут',date:day,time:'10:00',repeat:'daily'}});const readingId=seed.state.habits[1].id;
 await command({action:'check_habit',id:seed.state.habits[0].id,date:day,done:true});
 seed=await command({action:'add_habit',item:{title:'Разобрать заметки',date:day,time:'17:00',repeat:'once'}});const onceId=seed.state.habits[2].id;
 const financeBefore=await (await page.request.get(base+'/api/me',{headers})).json();
 await page.clock.install({time:new Date(day+'T05:00:00Z')});
 await page.goto(base,{waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
 await page.waitForFunction(()=>document.querySelector('[data-personal-next-id]'));
 check(await page.locator('[data-personal-next]').count()===2&&await page.locator('[data-personal-next="task"]').getAttribute('data-personal-next-id')===documentId&&await page.locator('[data-personal-next="habit"]').getAttribute('data-personal-next-id')===readingId,name+': home shows one current task and one current habit');
 await navigate('personal');
 check(await page.locator('#heading').textContent()==='Личное'&&await page.locator('#subtitle').textContent()==='Ваши дела, привычки и накопления',name+': approved personal title and subtitle');
 check((await page.locator('[data-personal-section="task"] [data-personal-row]').allTextContents())[0].includes('Отправить письмо')&&await row(documentId).getAttribute('class').then(text=>text.includes('is-current')),name+': completed, current and next tasks ordered');
 check(await page.locator('[data-personal-section="task"] .is-done .personal-name').evaluate(node=>getComputedStyle(node).textDecorationLine.includes('line-through')),name+': completed task visibly struck through');
 check(await page.locator('[data-personal-section="habit"] [data-personal-action="move-task"]').count()===0,name+': habits have no transfer action');
 await page.locator('[data-personal-action="next-day"]').click();
 check(await page.locator('[data-personal-section="task"] [data-personal-row]').count()===0&&await row(readingId).getAttribute('data-personal-complete')==='false',name+': next day has fresh daily habits');
 check(await row(readingId).locator('.personal-check').isDisabled()&&await row(onceId).count()===0,name+': future habit cannot be completed and one-day habit does not repeat');
 await page.locator('[data-personal-action="previous-day"]').click();
 check(await page.locator('[data-personal-section="habit"] .is-done').count()===1,name+': yesterday-style day navigation retains original completion');
 await page.locator('[data-personal-action="previous-day"]').click();check(await page.locator('[data-personal-section="habit"] [data-personal-row]').count()===0,name+': days before habit start remain empty');
 await page.locator('[data-personal-action="today"]').click();
 await row(documentId).locator('[data-personal-action="complete-task"]').first().click();await page.waitForFunction(id=>document.querySelector('[data-personal-row="'+id+'"]')?.dataset.personalComplete==='true',documentId);
 check(await row(documentId).locator('.personal-check').getAttribute('aria-pressed')==='true',name+': task checkbox marks completion');
 await navigate('home');check(await page.locator('[data-personal-next="task"]').getAttribute('data-personal-next-id')===meetingId,name+': completing task advances home card');
 await navigate('personal');await row(documentId).locator('.personal-check').click();await page.waitForFunction(id=>document.querySelector('[data-personal-row="'+id+'"]')?.dataset.personalComplete==='false',documentId);
 await row(documentId).locator('[data-personal-action="move-task"]').click();
 const later=Personal.addDays(day,30);await page.locator('#personal-editor [name="date"]').fill(later);await page.locator('#personal-editor [name="time"]').fill('11:30');await page.locator('#personal-editor [type="submit"]').click();await page.locator('#personal-dialog').waitFor({state:'hidden'});
 check(await row(documentId).count()===0,name+': task transferred to arbitrary date leaves original day');
 await page.locator('#personal-date').fill(later);await page.locator('#personal-date').dispatchEvent('change');
 check(await row(documentId).count()===1&&(await row(documentId).textContent()).includes('11:30'),name+': calendar opens moved task on selected date and time');
 await page.locator('[data-personal-action="today"]').click();
 await row(readingId).locator('.personal-check').click();await page.waitForFunction(id=>document.querySelector('[data-personal-row="'+id+'"]')?.dataset.personalComplete==='true',readingId);
 await page.locator('[data-personal-action="next-day"]').click();check(await row(readingId).getAttribute('data-personal-complete')==='false',name+': habit returns unfinished tomorrow');
 await page.locator('[data-personal-action="today"]').click();
 await page.locator('[data-personal-action="add-task"]').click();await page.locator('#personal-editor [name="title"]').fill('Задача без времени');await page.locator('#personal-editor [type="submit"]').click();await page.locator('#personal-dialog').waitFor({state:'hidden'});
 check((await read()).state.tasks.some(t=>t.title==='Задача без времени'&&t.time===''),name+': task accepts optional empty time');
 await page.locator('[data-personal-action="add-habit"]').click();await page.locator('#personal-editor [name="title"]').fill('Разовая привычка');await page.locator('#personal-editor label:has(input[value="once"])').click();await page.locator('#personal-editor [type="submit"]').click();await page.locator('#personal-dialog').waitFor({state:'hidden'});
 check((await read()).state.habits.some(h=>h.title==='Разовая привычка'&&h.repeat==='once'),name+': habit supports one selected day');
 await page.locator('.personal-savings').click();await page.waitForFunction(()=>document.getElementById('heading').textContent==='Накопить деньги');
 check((await page.locator('.goal-card').textContent()).includes('Путешествие')&&await page.locator('[data-nav="personal"][aria-current="page"]').count()>0,name+': old financial goals nested under Personal');
 await page.locator('[data-action="edit-goal"]').first().click();check(await page.locator('#editor [name="mode"]').count()>0,name+': existing savings modes remain available');await page.locator('#dialog [data-action="close"]').first().click();
 await page.locator('.personal-breadcrumb').click();await page.locator('#finance-privacy').click();
 check((await page.locator('.personal-savings-preview').textContent()).includes('••••')&&(await page.locator('[data-personal-section="task"]').textContent()).includes('Встреча'),name+': eye masks savings amounts while personal tasks remain readable');await page.locator('#finance-privacy').click();
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:width>950?1000:844});await navigate('personal');
  check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': personal page fits '+width);
  check(await page.locator('.personal-section').evaluateAll(nodes=>nodes.every(node=>node.getBoundingClientRect().right<=innerWidth+1)),name+': task and habit cards fit '+width);
  if(width<=950){
   check(await page.locator('.mobile-nav a').count()===5&&await page.locator('.mobile-nav a').evaluateAll(nodes=>nodes.every(node=>{const b=node.getBoundingClientRect();return b.width>=44&&b.height>=44&&node.scrollWidth<=node.clientWidth+1;})),name+': five rounded navigation tiles and labels fit '+width);
  }
  await page.locator('[data-personal-action="add-task"]').click();check(await page.locator('#personal-dialog').evaluate(node=>{const b=node.getBoundingClientRect();return b.left>=0&&b.right<=innerWidth+1&&b.bottom<=innerHeight+1;}),name+': personal editor fits '+width);await page.locator('[data-personal-action="close-dialog"]').first().click();
  if(name==='chromium'&&[390,1440].includes(width))console.log('RITM_SCREENSHOT_PERSONAL_'+width+' '+(await page.screenshot({fullPage:true})).toString('base64'));
 }
 await page.reload({waitUntil:'networkidle'});await page.waitForFunction(()=>document.querySelector('[data-personal-row]'));
 check((await read()).state.checks[readingId+'@'+day]===true,name+': completion persists after reload');
 const financeAfter=await (await page.request.get(base+'/api/me',{headers})).json();assert.deepEqual(financeAfter.plan,financeBefore.plan);check(financeAfter.revision===financeBefore.revision,name+': personal editing and day navigation preserve financial plan');
 await navigate('home');if(name==='chromium')console.log('RITM_SCREENSHOT_PERSONAL_HOME '+(await page.screenshot({fullPage:true})).toString('base64'));
 check(errors.length===0,name+': no personal UI runtime errors');
 }finally{
  if(created)await page.request.delete(base+'/api/account',{headers,data:{currentPassword:password,confirmation:'УДАЛИТЬ'}}).catch(()=>{});
  await context.close();await browser.close();
 }
 }
 console.log('RITM_PERSONAL_UI_PASS '+checks+' checks');
}
