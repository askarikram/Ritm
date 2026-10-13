import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

export async function verifyUI(base) {
  let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('RITM_UI_CHECK '+label);};
  for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await engine.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    const suffix=[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join('');
    const username='uitest'+suffix,oldPassword='UITestPassword123',newPassword='UINewPassword456';
    let signupRequests=0;
    page.on('request',request=>{if(request.url().endsWith('/api/signup'))signupRequests++;});
    try {
      await page.goto(base,{waitUntil:'networkidle'});
      await page.evaluate(()=>document.fonts.ready);
      check(await page.locator('#auth-screen').isVisible(),engineName+': login screen');
      check(await page.evaluate(()=>[...document.fonts].some(font=>font.family.replaceAll('"','')==='Golos Text'&&font.status==='loaded')),engineName+': self-hosted Golos Text loaded');
      await page.locator('#auth-signup-tab').click();
      check(await page.locator('#auth-confirm-field').isVisible(),engineName+': registration confirmation visible');
      if(engineName==='chromium'){await page.locator('#toast').waitFor({state:'hidden'});const screenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_REGISTRATION '+screenshot.toString('base64'));}
      await page.locator('#auth-username').fill(username);
      await page.locator('#auth-name').fill('Александр Тестовый');
      await page.locator('#auth-password').fill(oldPassword);
      const eye=page.locator('[data-password-target="auth-password"]');
      await eye.click();
      check(await page.locator('#auth-password').getAttribute('type')==='text',engineName+': registration eye shows password');
      await eye.click();
      check(await page.locator('#auth-password').getAttribute('type')==='password',engineName+': registration eye hides password');
      await page.locator('#auth-confirm-password').fill('DifferentPassword123');
      await page.locator('#auth-submit').click();
      check(signupRequests===0&&await page.locator('#auth-screen').isVisible(),engineName+': mismatched registration never submitted');
      await page.evaluate(value=>{const input=document.getElementById('auth-confirm-password');input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));},oldPassword);
      check(await page.locator('#auth-confirm-password').evaluate(input=>input.validity.valid),engineName+': registration confirmation updates after autofill change');
      await page.locator('#auth-confirm-password').fill(oldPassword);
      check(await page.locator('#auth-password-match').textContent()==='Пароли совпадают.',engineName+': registration match feedback');
      await page.locator('#auth-submit').click();
      await page.locator('#application').waitFor({state:'visible'});
      await page.locator('button.daily-wish').waitFor();
      await page.waitForFunction(()=>!document.querySelector('button.daily-wish')?.disabled);
      check(await page.locator('.wish-text').count()===0,engineName+': wish concealed before click');
      if(engineName==='chromium'){await page.locator('#toast').waitFor({state:'hidden'});const screenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_WISH_CLOSED '+screenshot.toString('base64'));}
      await page.locator('button.daily-wish').click();
      await page.locator('.daily-wish.is-open .wish-text').waitFor();
      const dailyText=await page.locator('.wish-text').textContent();
      check(Boolean(dailyText)&&dailyText.length<=120,engineName+': one short wish revealed after click');
      await page.reload({waitUntil:'networkidle'});
      await page.locator('.daily-wish.is-open .wish-text').waitFor();
      check(await page.locator('.wish-text').textContent()===dailyText,engineName+': opened wish persists across reload');

      let dayFetches=0;
      await page.route('**/api/wish?**',async route=>{
        const response=await route.fetch(),value=await response.json();
        if(++dayFetches===1){
          value.refreshAfterMs=300;value.expiresAt=new Date(Date.now()+300).toISOString();
        }else{
          value.opened=false;delete value.text;
          value.date=new Date(Date.parse(value.date+'T00:00:00Z')+86400000).toISOString().slice(0,10);
          value.refreshAfterMs=86400000;value.expiresAt=new Date(Date.now()+86400000).toISOString();
        }
        await route.fulfill({response,json:value});
      });
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(()=>{const button=document.querySelector('button.daily-wish');return button&&!button.disabled;});
      check(await page.locator('.wish-text').count()===0,engineName+': new day conceals yesterday wish without reload');
      await page.unroute('**/api/wish?**');
      await page.reload({waitUntil:'networkidle'});
      await page.locator('.daily-wish.is-open .wish-text').waitFor();
      check(signupRequests===1,engineName+': confirmed registration submitted once');
      await page.locator('.account-pill').click();
      await page.waitForFunction(()=>document.getElementById('heading').textContent==='Настройки');
      check(await page.locator('#profile-name-form').isVisible()&&await page.locator('#profile-password-form').isVisible(),engineName+': profile available in settings');
      await page.getByRole('button',{name:'Загрузить пример',exact:true}).click();
      await page.waitForFunction(()=>document.getElementById('heading').textContent==='Главная'&&document.getElementById('save-state').textContent==='План сохранён');
      const before=await (await page.request.get(base+'/api/me',{headers:{'X-Ritm-User':username}})).json();
      await page.locator('.account-pill').click();
      await page.locator('#profile-name').fill('Александр Новый');
      await page.locator('#profile-name-form button[type="submit"]').click();
      await page.waitForFunction(()=>document.getElementById('profile-name-feedback')?.textContent==='Имя сохранено.');
      check(await page.locator('#session-name').textContent()==='Александр Новый',engineName+': updated name in header');
      check(await page.locator('[data-profile-name]').textContent()==='Александр Новый',engineName+': updated name in profile');
      for(const id of ['profile-current-password','profile-new-password','profile-confirm-password']) {
        await page.locator('[data-password-target="'+id+'"]').click();
        check(await page.locator('#'+id).getAttribute('type')==='text',engineName+': '+id+' eye shows');
        await page.locator('[data-password-target="'+id+'"]').click();
        check(await page.locator('#'+id).getAttribute('type')==='password',engineName+': '+id+' eye hides');
      }
      await page.locator('#profile-current-password').fill(oldPassword);
      await page.locator('#profile-new-password').fill(newPassword);
      await page.locator('#profile-confirm-password').fill('DifferentPassword456');
      await page.locator('#profile-password-form button[type="submit"]').click();
      check(await page.locator('#profile-confirm-password').getAttribute('aria-invalid')==='true',engineName+': profile mismatch shown');
      await page.evaluate(value=>{const input=document.getElementById('profile-confirm-password');input.value=value;input.dispatchEvent(new Event('change',{bubbles:true}));},newPassword);
      check(await page.locator('#profile-confirm-password').evaluate(input=>input.validity.valid),engineName+': profile confirmation updates after autofill change');
      await page.locator('#profile-confirm-password').fill(newPassword);
      await page.locator('#profile-current-password').fill('WrongPassword123');
      await page.locator('#profile-password-form button[type="submit"]').click();
      await page.waitForFunction(()=>document.getElementById('profile-password-feedback')?.textContent==='Текущий пароль указан неверно.');
      check(await page.locator('#application').isVisible(),engineName+': wrong current password keeps user signed in');
      await page.locator('#profile-current-password').fill(oldPassword);
      await page.locator('#profile-password-form button[type="submit"]').click();
      await page.waitForFunction(()=>document.getElementById('profile-password-feedback')?.textContent.startsWith('Пароль изменён.'));
      check(await page.locator('#profile-new-password').inputValue()===''&&await page.locator('#profile-current-password').inputValue()==='',engineName+': password fields cleared after success');
      const after=await (await page.request.get(base+'/api/me',{headers:{'X-Ritm-User':username}})).json();
      assert.deepEqual(after.plan,before.plan);
      check(after.revision===before.revision&&after.user.name==='Александр Новый',engineName+': profile changes preserve financial plan');
      for(const width of [320,390,768,1440]) {
        await page.setViewportSize({width,height:width>=1000?1000:844});
        for(const route of ['home','income','payment','goals','calendar','settings']) {
          await page.evaluate(route=>{location.hash=route;},route);
          await page.waitForFunction(route=>document.querySelector('[data-nav="'+route+'"][aria-current="page"]')!==null,route);
          check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),engineName+': '+route+' fits '+width+'px');
          if(route==='income'||route==='payment'){
            check(await page.locator('.schedule-table .row-name .tile').count()===0,engineName+': '+route+' names have no decorative icons');
            if(width<=850){
              check(await page.locator('.schedule-table .list-label').evaluateAll(labels=>labels.every(label=>{const box=label.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&getComputedStyle(label).whiteSpace==='normal';})),engineName+': complete schedule names at '+width+'px');
            }
            if(engineName==='chromium'&&route==='payment'&&width===390){await page.locator('#toast').waitFor({state:'hidden'});const screenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_PAYMENTS '+screenshot.toString('base64'));}
          }

        }
        const geometry=await page.locator('#profile-password-form .password-control').evaluateAll(controls=>controls.map(control=>{
          const input=control.querySelector('input').getBoundingClientRect(),button=control.querySelector('button').getBoundingClientRect();
          return {height:input.height,radius:getComputedStyle(control.querySelector('input')).borderRadius,buttonFits:button.left>=input.left&&button.right<=input.right&&button.top>=input.top&&button.bottom<=input.bottom};
        }));
        check(geometry.length===3&&geometry.every(g=>g.height===48&&g.radius==='12px'&&g.buttonFits),engineName+': aligned password fields at '+width+'px');
        if(width<=650)check(await page.locator('#profile-new-password').evaluate(input=>parseFloat(getComputedStyle(input).fontSize)>=16),engineName+': readable mobile input without focus zoom at '+width+'px');
        if(engineName==='chromium'&&width===1440) {
          await page.locator('#toast').waitFor({state:'hidden'});const screenshot=await page.screenshot({fullPage:true});
          console.log('RITM_SCREENSHOT_DESKTOP '+screenshot.toString('base64'));
          await page.evaluate(()=>{location.hash='home';});
          await page.waitForFunction(()=>document.getElementById('heading').textContent==='Главная');
          const homeScreenshot=await page.screenshot({fullPage:true});
          console.log('RITM_SCREENSHOT_HOME_DESKTOP '+homeScreenshot.toString('base64'));

        }
        if(engineName==='chromium'&&width===390) {
          await page.locator('#toast').waitFor({state:'hidden'});const profileScreenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_PROFILE '+profileScreenshot.toString('base64'));
          await page.evaluate(()=>{location.hash='home';});
          await page.waitForFunction(()=>document.getElementById('heading').textContent==='Главная');
          await page.locator('#toast').waitFor({state:'hidden'});const screenshot=await page.screenshot({fullPage:true});
          console.log('RITM_SCREENSHOT_MOBILE '+screenshot.toString('base64'));
        }
        await page.locator('.head-add').click();
        await page.locator('#dialog').waitFor({state:'visible'});
        check(await page.locator('#dialog').evaluate(dialog=>{const box=dialog.getBoundingClientRect();return box.left>=0&&box.right<=innerWidth&&box.top>=0&&box.bottom<=innerHeight;}),engineName+': dialog fits '+width+'px');
        await page.locator('#dialog [data-action="close"]').first().click();
      }
      check(errors.length===0,engineName+': no browser JavaScript errors');
    } finally { await context.close();await browser.close(); }
  }
  console.log('RITM_UI_PASS '+checks+' checks');
}
