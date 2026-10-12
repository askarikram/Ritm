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
      check(await page.evaluate(()=>[...document.fonts].some(font=>font.family==='Manrope'&&font.status==='loaded')),engineName+': self-hosted Manrope loaded');
      await page.locator('#auth-signup-tab').click();
      check(await page.locator('#auth-confirm-field').isVisible(),engineName+': registration confirmation visible');
      if(engineName==='chromium'){const screenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_REGISTRATION '+screenshot.toString('base64'));}
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
      await page.locator('#auth-confirm-password').fill(oldPassword);
      check(await page.locator('#auth-password-match').textContent()==='Пароли совпадают.',engineName+': registration match feedback');
      await page.locator('#auth-submit').click();
      await page.locator('#application').waitFor({state:'visible'});
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
        }
        const geometry=await page.locator('#profile-password-form .password-control').evaluateAll(controls=>controls.map(control=>{
          const input=control.querySelector('input').getBoundingClientRect(),button=control.querySelector('button').getBoundingClientRect();
          return {height:input.height,radius:getComputedStyle(control.querySelector('input')).borderRadius,buttonFits:button.left>=input.left&&button.right<=input.right&&button.top>=input.top&&button.bottom<=input.bottom};
        }));
        check(geometry.length===3&&geometry.every(g=>g.height===48&&g.radius==='12px'&&g.buttonFits),engineName+': aligned password fields at '+width+'px');
        if(engineName==='chromium'&&width===1440) {
          const screenshot=await page.screenshot({fullPage:true});
          console.log('RITM_SCREENSHOT_DESKTOP '+screenshot.toString('base64'));
        }
        if(engineName==='chromium'&&width===390) {
          const profileScreenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_PROFILE '+profileScreenshot.toString('base64'));
          await page.evaluate(()=>{location.hash='home';});
          await page.waitForFunction(()=>document.getElementById('heading').textContent==='Главная');
          const screenshot=await page.screenshot({fullPage:true});
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
