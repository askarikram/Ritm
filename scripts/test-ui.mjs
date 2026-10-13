import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

export async function verifyUI(base,{setOriginAvailable}={}) {
  let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('RITM_UI_CHECK '+label);};
  for(const [engineName,engine] of [['chromium',chromium],['webkit',webkit]]) {
    const browser=await engine.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:1,reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];
    const workerFile=new URL('../public/sw.js',import.meta.url),originalWorker=await readFile(workerFile,'utf8');
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

      // Page-level mock works in WebKit even when Service Worker owns the network request.
      await page.evaluate(()=>{
        window.__ritmOriginalFetch=window.fetch;const realFetch=window.fetch.bind(window);let dayFetches=0;
        window.fetch=async(...args)=>{
          const response=await realFetch(...args),path=typeof args[0]==='string'?args[0]:args[0].url;
          if(!path.startsWith('/api/wish?')||!response.ok)return response;
          const value=await response.json();
          if(++dayFetches===1){value.refreshAfterMs=300;value.expiresAt=new Date(Date.now()+300).toISOString();}
          else{value.opened=false;delete value.text;value.date=new Date(Date.parse(value.date+'T00:00:00Z')+86400000).toISOString().slice(0,10);value.refreshAfterMs=86400000;value.expiresAt=new Date(Date.now()+86400000).toISOString();}
          return new Response(JSON.stringify(value),{status:response.status,headers:response.headers});
        };
      });
      await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
      await page.waitForFunction(()=>{const button=document.querySelector('button.daily-wish');return button&&!button.disabled;});
      check(await page.locator('.wish-text').count()===0,engineName+': new day conceals yesterday wish without reload');
      await page.evaluate(()=>{window.fetch=window.__ritmOriginalFetch;delete window.__ritmOriginalFetch;});
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
        await page.waitForFunction(route=>document.querySelector('[data-nav="'+(route==='goals'?'personal':route)+'"][aria-current="page"]')!==null,route);
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

      // Finance privacy is a view preference, never a financial-plan mutation.
      await navigate('home');await waitSaved();
      const privacyHeaders={'X-Ritm-User':username,Origin:base};
      const beforePrivacy=await (await page.request.get(base+'/api/me',{headers:privacyHeaders})).json();
      const originalBalance=await page.locator('.balance-overview .big').textContent();
      await page.locator('#finance-privacy').click();
      check(await page.locator('#finance-privacy').getAttribute('aria-pressed')==='true',engineName+': eye enables finance privacy');
      check(await page.locator('.balance-overview .big').textContent()==='•••• теңге',engineName+': balance replaced by fixed dots');
      check(await page.locator('[data-month-summary] strong').evaluateAll(nodes=>nodes.length===5&&nodes.every(node=>node.textContent.includes('••••')))&&await page.locator('.progress[aria-valuenow]').count()===0,engineName+': monthly amounts and goal percentage concealed');
      for(const width of [320,390,768,1440]){
        await page.setViewportSize({width,height:844});
        for(const route of ['home','income','payment','goals','calendar','settings']){
          await navigate(route);
          const text=await page.locator('#content').innerText();
          check(!/[0-9][0-9\s\u00a0.,]*\s*(?:теңге|\$)/.test(text)&&!/\d+%/.test(text),engineName+': private finance figures concealed on '+route+' at '+width+'px');
          const geometry=await page.locator('#finance-privacy').evaluate(button=>{
            const b=button.getBoundingClientRect(),heading=document.getElementById('heading').getBoundingClientRect();
            return b.left>=0&&b.right<=innerWidth&&b.width>=44&&b.height>=44&&heading.left>=0&&heading.right<=innerWidth;
          });
          check(geometry&&await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),engineName+': eye and full heading fit '+route+' at '+width+'px');
          if(route==='income'||route==='payment')check(await page.locator('[data-planned-total]').getAttribute('data-total-cents')==='',engineName+': hidden total exposes no numeric dataset');
        }
        if(engineName==='chromium'&&[390,1440].includes(width)){
          await navigate('home');const screenshot=await page.screenshot({fullPage:true});
          console.log('RITM_SCREENSHOT_PRIVACY_'+width+' '+screenshot.toString('base64'));
        }
      }
      await navigate('calendar');
      await page.locator('[data-action="cal-view"][data-view="forecast"]').click();
      check(!/[0-9][0-9\s\u00a0.,]*\s*(?:теңге|\$)/.test(await page.locator('#content').innerText()),engineName+': forecast table amounts concealed');
      await navigate('home');
      await page.locator('.balance-edit').click();
      check(await page.locator('#editor [data-finance-input]').evaluateAll(inputs=>inputs.length===2&&inputs.every(input=>input.type==='password')),engineName+': money fields concealed in edit dialog');
      await page.locator('#dialog [data-action="close"]').first().click();
      await page.reload({waitUntil:'networkidle'});
      await page.locator('#application').waitFor({state:'visible'});
      check(await page.locator('#finance-privacy').getAttribute('aria-pressed')==='true'&&await page.locator('.balance-overview .big').textContent()==='•••• теңге',engineName+': hidden view survives reload');

      const alternateUsername='privacy'+suffix,alternatePassword='PrivacyTestPassword123';
      const alternative=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username:alternateUsername,name:'Проверка режима',password:alternatePassword,confirmPassword:alternatePassword}});
      check(alternative.ok(),engineName+': second account available for privacy isolation');
      await page.reload({waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
      check(await page.locator('#finance-privacy').getAttribute('aria-pressed')==='false',engineName+': privacy preference belongs to account');
      const removedAlternate=await page.request.delete(base+'/api/account',{headers:{Origin:base,'X-Ritm-User':alternateUsername},data:{currentPassword:alternatePassword,confirmation:'УДАЛИТЬ'}});
      check(removedAlternate.ok(),engineName+': secondary privacy test account removed');
      const restored=await page.request.post(base+'/api/login',{headers:{Origin:base},data:{username,password:newPassword}});
      check(restored.ok(),engineName+': original account restored');
      await page.reload({waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
      check(await page.locator('#finance-privacy').getAttribute('aria-pressed')==='true',engineName+': original privacy preference restored after switching account');
      await page.locator('#finance-privacy').click();
      check(await page.locator('.balance-overview .big').textContent()===originalBalance&&!(await page.locator('[data-month-income]').textContent()).includes('••••')&&await page.locator('.progress[aria-valuenow]').count()>0,engineName+': eye restores amounts and monthly summary');
      const afterPrivacy=await (await page.request.get(base+'/api/me',{headers:privacyHeaders})).json();
      assert.deepEqual(afterPrivacy.plan,beforePrivacy.plan);
      check(afterPrivacy.revision===beforePrivacy.revision,engineName+': hiding and revealing leave financial plan unchanged');
      await page.reload({waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
      check(await page.locator('#finance-privacy').getAttribute('aria-pressed')==='false',engineName+': visible preference also persists');

      for(const width of [320,360,390,414,768,1440]) {
        await page.setViewportSize({width,height:width>=1000?1000:844});
        for(const route of ['home','income','payment','goals','calendar','settings']) {
          await page.evaluate(route=>{location.hash=route;},route);
          await page.waitForFunction(route=>document.querySelector('[data-nav="'+(route==='goals'?'personal':route)+'"][aria-current="page"]')!==null,route);
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
      for(const route of ['calendar','income','payment','personal','home']){
        const before=await page.locator('.mobile-nav a').evaluateAll(links=>links.map(link=>{const b=link.getBoundingClientRect();return [b.x,b.y,b.width,b.height];}));
        await page.locator('.mobile-nav [data-nav="'+route+'"]').click();
        await page.waitForFunction(route=>document.querySelector('.mobile-nav a.active')?.dataset.nav===route,route);
        const indicator=await page.locator('.mobile-nav').evaluate(nav=>{
          const active=nav.querySelector('a.active'),style=getComputedStyle(active),box=active.getBoundingClientRect();
          return {rounded:parseFloat(style.borderRadius)>=12,height:box.height,background:style.backgroundColor,color:style.color};
        });
        check(indicator.rounded&&indicator.height>=44&&indicator.background!=='rgba(0, 0, 0, 0)',engineName+': rounded selected tile after tapping '+route);
        const after=await page.locator('.mobile-nav a').evaluateAll(links=>links.map(link=>{const b=link.getBoundingClientRect();return [b.x,b.y,b.width,b.height];}));
        check(JSON.stringify(before)===JSON.stringify(after),engineName+': labels stay in place when switching to '+route);
      }
      await page.emulateMedia({reducedMotion:'reduce'});
      await page.locator('.mobile-nav [data-nav="calendar"]').click();
      check(await page.locator('.mobile-nav').evaluate(nav=>getComputedStyle(nav.querySelector('a.active')).transitionDuration==='0s'),engineName+': reduced motion switches without animation');

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
      check(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(replacementCode)&&replacementCode!==signupCode,engineName+': settings generate replacement code');
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
      const validity=await page.locator('#recovery-form').evaluate(form=>[...form.elements].filter(input=>input.willValidate&&!input.validity.valid).map(input=>({id:input.id,reason:input.validationMessage})));
      check(validity.length===0,engineName+': recovery form valid '+JSON.stringify(validity));
      const resetResponse=page.waitForResponse(response=>response.url().endsWith('/api/recover')&&response.request().method()==='POST');
      await page.locator('#recover-submit').click();const reset=await resetResponse;
      check(reset.ok(),engineName+': recovery request accepted with status '+reset.status());
      await page.waitForFunction(()=>!document.getElementById('application').hidden||Boolean(document.getElementById('recover-error').textContent));
      check(await page.locator('#application').isVisible(),engineName+': recovery opens account '+await page.locator('#recover-error').textContent());
      await page.locator('#recovery-dialog').waitFor({state:'visible'});
      check(await page.locator('#recovery-code').textContent()!==replacementCode,engineName+': recovery rotates code in interface');
      await page.locator('#close-recovery').click();
      const afterRecovery=await (await page.request.get(base+'/api/me',{headers})).json();
      assert.deepEqual(afterRecovery.plan,beforeRecovery.plan);
      check(afterRecovery.revision===beforeRecovery.revision,engineName+': UI recovery preserves financial plan');
      await navigate('home');await page.locator('#toast').waitFor({state:'hidden'});
      // Simulate a real release at the same worker URL; restore the fixture in finally.
      await writeFile(workerFile,originalWorker.replaceAll('__RITM_RELEASE__','__RITM_RELEASE__-uitest-'+engineName));
      await page.evaluate(async()=>{const registration=await navigator.serviceWorker.getRegistration('/');await registration.update();});
      await page.locator('#update-banner').waitFor({state:'visible'});
      check(await page.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration('/')).waiting)),engineName+': new worker waits for explicit update');
      await navigate('settings');
      await page.locator('#profile-current-password').fill('PendingPassword123');
      await page.locator('[data-password-target="profile-current-password"]').click();
      await page.locator('#apply-update').click();
      check(await page.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration('/')).waiting)),engineName+': update protects visible password draft');
      await page.locator('#profile-current-password').fill('');
      await navigate('home');
      await page.locator('.balance-edit').click();
      await page.locator('#apply-update').evaluate(button=>button.dispatchEvent(new Event('click')));
      check(await page.evaluate(async()=>Boolean((await navigator.serviceWorker.getRegistration('/')).waiting)),engineName+': update does not activate over open editing dialog');
      await page.locator('#dialog [data-action="close"]').first().click();
      const updatedPage=page.waitForEvent('load');await page.locator('#apply-update').click();await updatedPage;
      await page.waitForFunction(async engine=>{const registration=await navigator.serviceWorker.getRegistration('/'),keys=await caches.keys();return !registration.waiting&&keys.filter(key=>key.startsWith('ritm-shell-')).length===1&&keys.some(key=>key.endsWith('-uitest-'+engine));},engineName,{timeout:15000});
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
      // WebKit's offline-emulation navigation bug: microsoft/playwright#42775.
      // Stop the disposable origin instead; do not skip cached-navigation coverage.
      let cachedNavigation;
      if(engineName==='webkit'){
        assert.equal(typeof setOriginAvailable,'function','Origin outage fixture required for WebKit');
        await setOriginAvailable(false);
        cachedNavigation=await page.reload({waitUntil:'domcontentloaded'});
        await page.waitForFunction(()=>Boolean(document.getElementById('auth-error').textContent));
      }else{
        await context.setOffline(true);cachedNavigation=await page.reload({waitUntil:'domcontentloaded'});
        await page.locator('#connection-status').waitFor({state:'visible'});
      }
      await page.locator('#auth-screen').waitFor({state:'visible'});
      check(cachedNavigation?.status()===200&&cachedNavigation.fromServiceWorker()&&!(await page.locator('#application').isVisible()),engineName+': unavailable origin loads cached public shell without private plan');
      if(engineName==='webkit'){await setOriginAvailable(true);await page.reload({waitUntil:'networkidle'});}
      else await context.setOffline(false);
      await page.locator('#application').waitFor({state:'visible'});
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
    } finally { await writeFile(workerFile,originalWorker);await context.close();await browser.close(); }
  }
  console.log('RITM_UI_PASS '+checks+' checks');
}
