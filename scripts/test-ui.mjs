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
      check(await page.locator('.landing-story').isVisible(),engineName+': public site introduction');
      for(const width of [320,390,768,1440]){
        await page.setViewportSize({width,height:844});
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),engineName+': public site fits '+width+'px');
        if(engineName==='chromium'&&[390,1440].includes(width)){
          const screenshot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_LANDING_'+width+' '+screenshot.toString('base64'));
        }
      }
      await page.setViewportSize({width:390,height:844});
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
      await page.locator('#recovery-dialog').waitFor({state:'visible'});
      const signupCode=await page.locator('#recovery-code').textContent();
      check(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(signupCode),engineName+': signup displays recovery code');
      const codeDownloadPromise=page.waitForEvent('download');await page.locator('#download-recovery').click();
      const codeDownload=await codeDownloadPromise,codeStream=await codeDownload.createReadStream();let codeFile='';
      for await(const chunk of codeStream)codeFile+=chunk.toString();
      check(codeFile.includes(username)&&codeFile.includes(signupCode)&&codeDownload.suggestedFilename()==='ritm-recovery-'+username+'.txt',engineName+': recovery code can be saved as a file');
      await page.locator('#close-recovery').click();
      check(await page.locator('#recovery-code').textContent()==='',engineName+': dismissed recovery code removed from DOM');
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

      for(const route of ['income','payment']){
        await page.evaluate(route=>{location.hash=route;},route);
        await page.waitForFunction(route=>document.querySelector('[data-planned-total="'+route+'"]')!==null,route);
        check(await page.locator('[data-planned-total="'+route+'"]').getAttribute('data-total-cents')==='0',engineName+': empty '+route+' planned total is zero');
        check((await page.locator('[data-planned-total="'+route+'"]').textContent()).replace(/\s/g,'')==='0теңге',engineName+': Kazakh currency label in empty total');
      }
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

      const navigate=async route=>{
        await page.evaluate(route=>{location.hash=route;},route);
        await page.waitForFunction(route=>document.querySelector('[data-nav="'+route+'"][aria-current="page"]')!==null,route);
      };
      const waitSaved=()=>page.waitForFunction(()=>document.getElementById('save-state').textContent==='План сохранён');
      for(const [type,baseCents] of [['income',7000000n],['payment',2529900n]]){
        await navigate('home');
        await page.locator('.home-actions [data-action="add-'+type+'"]').click();
        await page.locator('#dialog').waitFor({state:'visible'});
        const title='Проверка итога '+type;
        await page.locator('#editor [name="title"]').fill(title);
        await page.locator('#editor [name="amount"]').fill('1234');
        await page.locator('#editor [name="repeat"]').selectOption('weekly');
        await page.locator('#editor button[type="submit"]').click();
        await waitSaved();await navigate(type);
        const total=page.locator('[data-planned-total="'+type+'"]');
        check(await total.getAttribute('data-total-cents')===(baseCents+123400n).toString(),engineName+': '+type+' total updates after adding a recurring entry once');
        check((await total.textContent()).includes('теңге'),engineName+': '+type+' total uses теңге');
        const row=page.locator('.schedule-table tbody tr').filter({has:page.getByText(title,{exact:true})});
        await row.locator('[data-action="edit-item"]').click();
        await page.locator('#editor [name="amount"]').fill('4321');
        await page.locator('#editor button[type="submit"]').click();
        await waitSaved();
        check(await total.getAttribute('data-total-cents')===(baseCents+432100n).toString(),engineName+': '+type+' total updates after editing');
        await page.reload({waitUntil:'networkidle'});
        await total.waitFor();
        check(await total.getAttribute('data-total-cents')===(baseCents+432100n).toString(),engineName+': '+type+' total survives reload');
        await row.locator('[data-action="delete-item"]').click();
        await waitSaved();
        check(await total.getAttribute('data-total-cents')===baseCents.toString(),engineName+': '+type+' total updates after deletion');
      }
      await navigate('home');
      for(const [action,title] of [['expense','Записать расход'],['edit-goal','Новая цель']]){
        await page.locator('.home-actions [data-action="'+action+'"]').click();
        check(await page.locator('#dialog-title').textContent()===title,engineName+': working '+action+' shortcut');
        await page.locator('#dialog [data-action="close"]').first().click();
      }
      await page.locator('.balance-edit').click();
      check(await page.locator('#editor [name="currency"] option[value="KZT"]').textContent()==='Теңге · ₸',engineName+': Kazakh currency name in selector');
      await page.locator('#dialog [data-action="close"]').first().click();

      for(const width of [320,360,390,414,768,1440]) {
        await page.setViewportSize({width,height:width>=1000?1000:844});
        for(const route of ['home','income','payment','goals','calendar','settings']) {
          await page.evaluate(route=>{location.hash=route;},route);
          await page.waitForFunction(route=>document.querySelector('[data-nav="'+route+'"][aria-current="page"]')!==null,route);
          check(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth+1),engineName+': '+route+' fits '+width+'px');
          if(width<=950){
            const geometry=await page.locator('.mobile-nav').evaluate(nav=>{
              const box=nav.getBoundingClientRect(),links=[...nav.querySelectorAll('a')];
              return {left:box.left,right:box.right,bottom:box.bottom,height:box.height,width:innerWidth,screenHeight:innerHeight,
                targetsFit:links.every(link=>{const b=link.getBoundingClientRect();return b.width>=44&&b.height>=44;}),
                labelsFit:links.every(link=>{const b=link.getBoundingClientRect(),label=link.querySelector('span').getBoundingClientRect();return label.left>=b.left&&label.right<=b.right&&label.top>=b.top&&label.bottom<=b.bottom;})};
            });
            check(geometry.left>=0&&geometry.right<=geometry.width&&geometry.bottom<=geometry.screenHeight&&geometry.height<=60,engineName+': lower navigation fits '+route+' at '+width+'px');
            check(geometry.targetsFit&&geometry.labelsFit,engineName+': full navigation labels and touch targets on '+route+' at '+width+'px');
            if(engineName==='chromium'&&['home','calendar'].includes(route)&&[320,390].includes(width)){
              const screenshot=await page.locator('.mobile-nav').screenshot();
              console.log('RITM_SCREENSHOT_NAV_'+width+'_'+route.toUpperCase()+' '+screenshot.toString('base64'));
            }
          }

          if(route==='income'||route==='payment'){
            const expected=route==='income'?'7000000':'2529900';
            check(await page.locator('[data-planned-total="'+route+'"]').getAttribute('data-total-cents')===expected,engineName+': '+route+' aggregate remains correct at '+width+'px');

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

      // Use real taps and normal motion to catch abrupt switching or moving labels.
      await page.setViewportSize({width:320,height:844});
      await navigate('home');
      await page.emulateMedia({reducedMotion:'no-preference'});
      for(const route of ['calendar','income','payment','goals','home']){
        const before=await page.locator('.mobile-nav a').evaluateAll(links=>links.map(link=>{const b=link.getBoundingClientRect();return [b.x,b.y,b.width,b.height];}));
        await page.locator('.mobile-nav [data-nav="'+route+'"]').click();
        await page.waitForFunction(route=>document.querySelector('.mobile-nav a.active')?.dataset.nav===route,route);
        const indicator=await page.locator('.mobile-nav').evaluate(nav=>{
          const style=getComputedStyle(nav,'::before'),active=nav.querySelector('a.active'),color=getComputedStyle(active).backgroundColor;
          return {motion:style.transitionProperty.includes('transform')&&parseFloat(style.transitionDuration)>0&&parseFloat(style.transitionDuration)<=.4,background:color};
        });
        check(indicator.motion&&indicator.background==='rgba(0, 0, 0, 0)',engineName+': gentle animated selection after tapping '+route);
        await page.waitForFunction(()=>{
          const nav=document.querySelector('.mobile-nav'),link=nav.querySelector('a.active'),style=getComputedStyle(nav,'::before'),navBox=nav.getBoundingClientRect(),linkBox=link.getBoundingClientRect();
          const left=navBox.left+nav.clientLeft+new DOMMatrix(style.transform).m41;
          return Math.abs(left-linkBox.left)<1&&Math.abs(parseFloat(style.width)-linkBox.width)<1;
        });
        const after=await page.locator('.mobile-nav a').evaluateAll(links=>links.map(link=>{const b=link.getBoundingClientRect();return [b.x,b.y,b.width,b.height];}));
        check(JSON.stringify(before)===JSON.stringify(after),engineName+': labels stay in place when switching to '+route);
      }
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.locator('.mobile-nav [data-nav="calendar"]').click();
      check(await page.locator('.mobile-nav').evaluate(nav=>getComputedStyle(nav,'::before').transitionDuration==='0s'),engineName+': reduced motion switches without animation');

      // Verify installation assets and offline behavior with a real service worker.
      await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller),null,{timeout:15000});
      check(await page.evaluate(async()=>{const r=await navigator.serviceWorker.ready;return r.active?.state==='activated';}),engineName+': app worker controls page');
      await navigate('settings');
      await page.locator('.install-card [data-install-app]').click();
      check(await page.locator('#install-dialog').isVisible()&&(await page.locator('#install-instructions').textContent()).length>30,engineName+': installation instructions available');
      await page.locator('#close-install').click();
      check(await page.evaluate(async()=>{
        const image=new Image();image.src='/icons/icon-512.png';await image.decode();return image.naturalWidth===512;
      }),engineName+': app icon decodes in browser');

      const codeForm=page.locator('#recovery-code-form');
      await codeForm.locator('[name="currentPassword"]').fill('WrongPassword123');
      await codeForm.locator('button[type="submit"]').click();
      await page.waitForFunction(()=>document.getElementById('recovery-feedback')?.textContent==='Текущий пароль указан неверно.');
      check(!(await page.locator('#recovery-dialog').isVisible()),engineName+': wrong password cannot reveal a recovery code');
      await codeForm.locator('[name="currentPassword"]').fill(newPassword);
      await codeForm.locator('button[type="submit"]').click();
      await page.locator('#recovery-dialog').waitFor({state:'visible'});
      const replacementCode=await page.locator('#recovery-code').textContent();
      check(replacementCode!==signupCode,engineName+': settings generate replacement code');
      await page.locator('#close-recovery').click();
      const headers={'X-Ritm-User':username,Origin:base},beforeRecovery=await (await page.request.get(base+'/api/me',{headers})).json();
      await page.locator('#profile-name-form [data-action="account-logout"]').click();
      await page.locator('#auth-screen').waitFor({state:'visible'});
      check(await page.locator('#content').textContent()===''&&await page.locator('#session-name').textContent()==='',engineName+': logout clears private content from DOM');
      await page.locator('#auth-forgot').click();
      await page.locator('#recover-username').fill(username);
      await page.locator('#recover-code').fill(replacementCode);
      const recoveredPassword='UIRecoveryPassword789';
      await page.locator('#recover-password').fill(recoveredPassword);
      await page.locator('#recover-confirm').fill('MismatchPassword789');
      await page.locator('#recover-submit').click();
      check(await page.locator('#recover-confirm').getAttribute('aria-invalid')==='true',engineName+': recovery confirmation mismatch shown');
      await page.locator('#recover-confirm').fill(recoveredPassword);
      await page.locator('#recover-submit').click();
      await page.locator('#application').waitFor({state:'visible'});
      await page.locator('#recovery-dialog').waitFor({state:'visible'});
      check(await page.locator('#recovery-code').textContent()!==replacementCode,engineName+': recovery rotates code in interface');
      await page.locator('#close-recovery').click();
      const afterRecovery=await (await page.request.get(base+'/api/me',{headers})).json();
      assert.deepEqual(afterRecovery.plan,beforeRecovery.plan);
      check(afterRecovery.revision===beforeRecovery.revision,engineName+': UI recovery preserves financial plan');
      await navigate('home');await page.locator('#toast').waitFor({state:'hidden'});
      // A different worker URL simulates a new release without touching user data.
      await page.evaluate(()=>navigator.serviceWorker.register('/sw.js?update-test=1',{scope:'/',updateViaCache:'none'}));
      await page.locator('#update-banner').waitFor({state:'visible'});
      check(await page.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration('/')).waiting)),engineName+': new worker waits for explicit update');
      await page.locator('.balance-edit').click();
      await page.locator('#apply-update').evaluate(button=>button.dispatchEvent(new Event('click')));
      check(await page.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration('/')).waiting)),engineName+': update does not activate over open editing dialog');
      await page.locator('#dialog [data-action="close"]').first().click();
      const updatedPage=page.waitForEvent('load');await page.locator('#apply-update').click();await updatedPage;
      await page.waitForFunction(()=>navigator.serviceWorker.controller?.scriptURL.includes('update-test=1'),null,{timeout:15000});
      await page.locator('#application').waitFor({state:'visible'});
      await navigate('home');await page.locator('#toast').waitFor({state:'hidden'});

      await context.setOffline(true);
      await page.locator('#connection-status').waitFor({state:'visible'});
      await page.locator('.balance-edit').click();
      await page.locator('#editor [name="balance"]').fill('43000');
      await page.locator('#editor button[type="submit"]').click();
      await page.waitForFunction(()=>document.getElementById('save-state').textContent==='Есть несохранённые изменения');
      check(await page.locator('#connection-status').isVisible(),engineName+': offline edits clearly marked unsaved');
      await navigate('settings');
      const exportPromise=page.waitForEvent('download');await page.locator('[data-action="export"]').first().click();
      const backup=await exportPromise,backupStream=await backup.createReadStream();let backupText='';
      for await(const chunk of backupStream)backupText+=chunk.toString();
      check(JSON.parse(backupText).balance===4300000,engineName+': offline unsaved plan can be exported');
      await context.setOffline(false);await waitSaved();
      const onlinePlan=await (await page.request.get(base+'/api/me',{headers})).json();
      check(onlinePlan.plan.balance===4300000,engineName+': pending plan saves automatically after reconnection');
      const cachesSafe=await page.evaluate(async({username,code})=>{
        let root='';
        for(const key of await caches.keys()){
          const cache=await caches.open(key);for(const request of await cache.keys()){
            if(new URL(request.url).pathname.startsWith('/api/'))return false;
            if(new URL(request.url).pathname==='/')root=await (await cache.match(request)).text();
          }
        }
        return Boolean(root)&&!root.includes(username)&&!root.includes(code);
      },{username,code:replacementCode});
      check(cachesSafe,engineName+': app cache excludes private responses and user data');
      await context.setOffline(true);await page.reload({waitUntil:'domcontentloaded'});
      await page.locator('#auth-screen').waitFor({state:'visible'});
      check(await page.locator('#connection-status').isVisible()&&!(await page.locator('#application').isVisible()),engineName+': offline launch loads public shell without private plan');
      await context.setOffline(false);await page.locator('#application').waitFor({state:'visible'});
      check((await (await page.request.get(base+'/api/me',{headers})).json()).plan.balance===4300000,engineName+': reconnection restores saved account');

      if(engineName==='chromium'){
        const headers={'X-Ritm-User':username,Origin:base};
        const saved=await (await page.request.get(base+'/api/me',{headers})).json();
        const date=new Date().toISOString().slice(0,10);
        const items=Array.from({length:500},(_,i)=>({id:'largetotal'+i,title:'Проверка большой суммы '+i,type:'payment',amount:99999999999999,date,repeat:'none'}));
        const response=await page.request.put(base+'/api/plan',{headers,data:{revision:saved.revision,plan:{...saved.plan,items}}});
        check(response.ok(),'large valid plan accepted for total precision check');
        await navigate('payment');await page.reload({waitUntil:'networkidle'});
        await page.locator('[data-planned-total="payment"]').waitFor();
        const expected=500n*99999999999999n;
        check(await page.locator('[data-planned-total="payment"]').getAttribute('data-total-cents')===expected.toString(),'exact total beyond Number integer precision');
        check((await page.locator('[data-planned-total="payment"]').textContent()).replace(/\s/g,'')===((expected+50n)/100n).toString()+'теңге','large total formatted without precision loss');
      }

      await navigate('settings');
      await page.locator('.account-deletion summary').click();
      await page.locator('#delete-current-password').fill(recoveredPassword);
      await page.locator('#delete-confirmation').fill('УДАЛИТЬ');
      await page.locator('#delete-account-form button[type="submit"]').click();
      await page.locator('#auth-screen').waitFor({state:'visible'});
      check((await page.request.get(base+'/api/me')).status()===401,engineName+': deleting account ends its session');
      check(errors.length===0,engineName+': no browser JavaScript errors');
    } finally { await context.close();await browser.close(); }
  }
  console.log('RITM_UI_PASS '+checks+' checks');
}
