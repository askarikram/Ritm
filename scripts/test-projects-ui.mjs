import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium,webkit } from 'playwright';
import { Personal } from '../personal-domain.mjs';
import { Projects } from '../projects-domain.mjs';
import { grantFixturePremium } from './premium-fixture.mjs';

export async function verifyProjectUI(base){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_PROJECT_UI_CHECK '+label);};
 for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Almaty',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  const username='projectui'+[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='ProjectUiPassword123',headers={Origin:base,'X-Ritm-User':username},day=Personal.clock('Asia/Almaty').date;
  let created=false,otherContext;
  page.on('pageerror',error=>errors.push(error.message));page.on('dialog',dialog=>dialog.accept());
  const read=async()=>{const r=await page.request.get(base+'/api/personal',{headers});assert.ok(r.ok());return r.json();};
  const route=async(name,title)=>{await page.evaluate(name=>location.hash=name,name);await page.waitForFunction(title=>document.getElementById('heading').textContent===title,title);await page.waitForFunction(()=>!personalBusy&&!personalLoading);};
  const action=name=>page.locator('[data-workspace-action="'+name+'"]');
  const fields=()=>page.locator('#workspace-editor');
  const submit=async()=>{await fields().locator('[type="submit"]').click();await page.locator('#workspace-dialog').waitFor({state:'hidden'});await page.waitForFunction(()=>!personalBusy);};
  const form=async(actionName)=>{await action(actionName).first().click();await page.locator('#workspace-dialog').waitFor({state:'visible'});};
  const reading=async(date,pageNumber)=>{await form('reading');await fields().locator('[name="page"]').fill(String(pageNumber));await fields().locator('[name="date"]').fill(date);await submit();};
  try{
   const signup=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Личные проекты'}});check(signup.ok(),engineName+': disposable workspace account created');created=true;
   await page.goto(base+'/#projects',{waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
   await page.waitForFunction(()=>location.hash==='#goals');check(await page.locator('.workspace-entry').count()===0,engineName+': Basic direct route cannot reveal the Premium workspace');
   await grantFixturePremium(base,username);await page.goto(base+'/?workspace=1#personal',{waitUntil:'networkidle'});await page.locator('.workspace-entry').waitFor({state:'visible'});
   check(await page.locator('[data-personal-section="task"]').count()===1&&await page.locator('[data-personal-section="habit"]').count()===1&&await page.locator('.personal-savings').count()===1,engineName+': new entry preserves My Day, habits and savings');
   await page.locator('.workspace-entry').click();await page.waitForFunction(()=>document.getElementById('heading').textContent==='Мои проекты'&&document.querySelectorAll('.workspace-tabs>a').length===4);
   check(await page.locator('.workspace-tabs>a').count()===4&&await page.locator('[data-nav="personal"][aria-current="page"]').count()>0,engineName+': four sections nested under Personal');
   await form('add-project');await fields().locator('[name="title"]').fill('Прочитать и применить книгу');await fields().locator('[name="description"]').fill('Выбрать полезное и применить в жизни');await fields().locator('[name="deadline"]').fill(Personal.addDays(day,14));await submit();
   let state=(await read()).state;const project=state.workspace.projects[0].id;
   await page.locator('[data-workspace-project="'+project+'"] h3').click();await page.locator('[data-project-detail="'+project+'"]').waitFor();
   await form('add-step');await fields().locator('[name="title"]').fill('Выбрать книгу');await submit();
   check((await read()).state.tasks.length===0,engineName+': undated step stays out of My Day');
   await form('add-step');await fields().locator('[name="title"]').fill('Прочитать главу');await fields().locator('[name="date"]').fill(day);await fields().locator('[name="time"]').fill('10:00');await submit();
   state=(await read()).state;const step=state.workspace.projects[0].steps[1],task=step.taskId;
   await route('personal','Личное');await page.locator('[data-personal-row="'+task+'"] .personal-check').click();await page.waitForFunction(()=>!personalBusy);
   await route('project?id='+project,'Проект');await page.locator('[data-workspace-step="'+step.id+'"].is-done').waitFor();
   check(await page.locator('[data-project-detail] [role="progressbar"]').getAttribute('aria-valuenow')==='50',engineName+': My Day completion becomes 50 percent project progress');
   await page.locator('[data-workspace-step="'+step.id+'"] [data-workspace-action="step-check"]').click();await page.waitForFunction(()=>!personalBusy);
   check(!(await read()).state.tasks.find(t=>t.id===task).done,engineName+': unchecking project step unchecks linked task');
   await page.locator('[data-workspace-step="'+step.id+'"] [data-workspace-action="step-check"]').click();await page.waitForFunction(()=>!personalBusy);
   await route('books','Книжная полка');await form('add-book');
   await fields().locator('[name="title"]').fill('Психология денег');await fields().locator('[name="author"]').fill('Моя книга');await fields().locator('[name="total"]').fill('160');await fields().locator('[name="status"]').selectOption('reading');await submit();
   const book=(await read()).state.workspace.books[0].id;
   await page.locator('[data-workspace-book="'+book+'"] h3').click();await page.locator('[data-book-detail="'+book+'"]').waitFor();
   await reading(Personal.addDays(day,-1),70);await reading(day,80);
   check(await page.locator('[data-book-page]').textContent()==='80'&&await page.locator('.workspace-reading-progress [role="progressbar"]').getAttribute('aria-valuenow')==='50',engineName+': 70 then 80 displays 80 of 160 and a half-filled line');
   check(await page.locator('[data-reading-log]').count()===2,engineName+': reading history keeps both dates');
   await reading(Personal.addDays(day,-2),60);
   check(await page.locator('[data-book-page]').textContent()==='80',engineName+': adding an earlier date does not move progress backward');
   await reading(day,90);check(await page.locator('[data-reading-log]').count()===3,engineName+': another same-day mark updates existing log');
   let current=(await read()).state.workspace.books.find(b=>b.id===book),todayLog=current.logs.find(l=>l.date===day);
   await page.locator('[data-reading-log="'+todayLog.id+'"] [data-workspace-action="edit-reading"]').click();await fields().locator('[name="page"]').fill('80');await submit();
   check(await page.locator('[data-book-page]').textContent()==='80',engineName+': pencil corrects saved page position');
   await reading(day,160);check((await read()).state.workspace.books[0].status==='finished',engineName+': reaching final page marks the book read');
   await page.locator('[data-reading-log="'+todayLog.id+'"] [data-workspace-action="delete-reading"]').click();await page.waitForFunction(()=>!personalBusy);
   check(await page.locator('[data-book-page]').textContent()==='70',engineName+': deleting latest log falls back to previous dated position');
   await reading(day,80);
   await form('edit-book');await fields().locator('[name="total"]').fill('79');await fields().locator('[type="submit"]').click();await page.locator('#workspace-error').filter({hasText:'меньше'}).waitFor();
   check(await page.locator('#workspace-dialog').isVisible(),engineName+': invalid book total preserves the editor and user draft');
   await fields().locator('[name="total"]').fill('160');await submit();
   await form('add-note');await fields().locator('[name="text"]').fill('Сначала откладывать, затем распределять расходы.');await submit();
   current=(await read()).state.workspace.books.find(b=>b.id===book);const note=current.notes[0].id;
   await page.locator('[data-book-note="'+note+'"] [data-workspace-action="edit-note"]').click();await fields().locator('[name="text"]').fill('Одна полезная мысль, которую применю на этой неделе.');await submit();
   await page.reload({waitUntil:'networkidle'});await page.locator('[data-book-page]').waitFor();
   check(await page.locator('[data-book-page]').textContent()==='80'&&(await page.locator('[data-book-note]').textContent()).includes('Одна полезная мысль'),engineName+': book position, history and edited notes survive reload');
   for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:900});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),engineName+': book detail fits '+width+'px');
    check(await page.locator('.workspace-log').evaluateAll(nodes=>nodes.every(n=>n.scrollWidth<=n.clientWidth+1)),engineName+': dated reading rows fit '+width+'px');
    await form('reading');check(await page.locator('#workspace-dialog').evaluate(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1;}),engineName+': reading editor fits '+width+'px');await action('close').first().click();
   }
   if(engineName==='chromium')for(const width of [390,1440]){await page.setViewportSize({width,height:1000});const shot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_PROJECT_BOOK_'+width+' '+shot.toString('base64'));}
   await route('ideas','Идеи');await form('add-idea');await fields().locator('[name="title"]').fill('Идея для недели');await fields().locator('[name="tag"]').selectOption('growth');await fields().locator('[name="text"]').fill('<img src=x onerror=alert(1)> Прочитать и применить.');await submit();
   const idea=(await read()).state.workspace.ideas[0].id;
   check(await page.locator('[data-workspace-idea="'+idea+'"] img').count()===0&&(await page.locator('[data-workspace-idea="'+idea+'"]').textContent()).includes('<img'),engineName+': idea content is rendered as text, not executable HTML');
   await page.locator('[data-workspace-idea="'+idea+'"] [data-workspace-action="edit-idea"]').click();await fields().locator('[name="title"]').fill('Новая полезная идея');await fields().locator('[name="tag"]').selectOption('money');await submit();
   await page.locator('[data-workspace-action="idea-filter"][data-filter="work"]').click();check(await page.locator('[data-workspace-idea]').count()===0,engineName+': ideas filter by saved topic');
   await page.locator('[data-workspace-action="idea-filter"][data-filter="money"]').click();check(await page.locator('[data-workspace-idea]').count()===1,engineName+': updated idea appears in the new topic');
   await route('weekly','Итоги недели');const week=Projects.weekStart(day);
   await form('review');await fields().locator('[name="wins"]').fill('Прочитал главу и сделал шаг к цели');await fields().locator('[name="barriers"]').fill('Отвлекался');await fields().locator('[name="focus"]').fill('Читать регулярно');await submit();
   check((await page.locator('[data-workspace-review="'+week+'"]').textContent()).includes('Читать регулярно'),engineName+': weekly answers are visible after saving');
   await action('previous-week').click();const previous=Projects.addDays(week,-7);await page.locator('[data-workspace-review="'+previous+'"]').waitFor();
   await form('review');await fields().locator('[name="wins"]').fill('Итог прошлой недели');await submit();
   await action('next-week').click();await page.locator('[data-workspace-review="'+week+'"]').waitFor();
   check((await page.locator('[data-workspace-review="'+week+'"]').textContent()).includes('Читать регулярно')&&(await read()).state.workspace.reviews.length===2,engineName+': current and past weekly reflections remain separate');
   for(const target of [['projects','Мои проекты'],['books','Книжная полка'],['ideas','Идеи'],['weekly','Итоги недели']]){
    await route(target[0],target[1]);
    for(const width of [320,390,1440]){await page.setViewportSize({width,height:900});check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),engineName+': '+target[0]+' fits '+width+'px');}
   }
   await route('book?id='+book,'Книга');await page.setViewportSize({width:390,height:844});
   otherContext=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Almaty'});
   const login=await otherContext.request.post(base+'/api/login',{headers:{Origin:base},data:{username,password,remember:true}});check(login.ok(),engineName+': second device signs into same account');
   const other=await otherContext.newPage();other.on('pageerror',error=>errors.push(error.message));
   await other.goto(base+'/#book?id='+book,{waitUntil:'networkidle'});await other.locator('[data-book-page]').waitFor();
   check(await other.locator('[data-book-page]').textContent()==='80',engineName+': second device loads saved reading position');
   await form('reading');await fields().locator('[name="page"]').fill('96');
   const remote=await otherContext.request.get(base+'/api/personal',{headers}),snapshot=await remote.json();
   const changed=await otherContext.request.post(base+'/api/personal',{headers,data:{revision:snapshot.revision,action:'workspace_reading_save',id:book,item:{date:day,page:95}}});check(changed.ok(),engineName+': another device records a newer position');
   await fields().locator('[type="submit"]').click();await page.locator('#workspace-error').filter({hasText:'другой вкладке'}).waitFor();
   check(await fields().locator('[name="page"]').inputValue()==='96',engineName+': stale save keeps draft and cannot overwrite remote progress');
   await action('close').first().click();await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await page.waitForFunction(()=>document.querySelector('[data-book-page]')?.textContent==='95');
   check(Projects.progress((await read()).state.workspace.books[0]).page===95,engineName+': returning to device refreshes latest saved progress');
   await route('profile','Профиль');await page.locator('#content [data-action="account-logout"]').click();await page.locator('#auth-screen').waitFor({state:'visible'});
   check(await page.locator('#content').textContent()===''&&await page.locator('#workspace-fields').textContent()==='',engineName+': logout clears workspace content and private editor');
   check(errors.length===0,engineName+': workspace flows produce no browser errors');
  }finally{
   if(otherContext)await otherContext.close();
   if(created){await page.request.post(base+'/api/login',{headers:{Origin:base},data:{username,password}});await page.request.delete(base+'/api/account',{headers,data:{currentPassword:password,confirmation:'УДАЛИТЬ'}});}
   await context.close();await browser.close();
  }
 }
 console.log('RITM_PROJECT_UI_PASS '+checks+' checks');
}
