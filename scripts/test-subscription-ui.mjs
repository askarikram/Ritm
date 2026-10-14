import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium,webkit } from 'playwright';
import { fixturePool,grantFixturePremium } from './premium-fixture.mjs';
export async function verifySubscriptionUI(base){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_SUBSCRIPTION_UI_CHECK '+label);};
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true}),pool=fixturePool(base),contexts=[],created=[],errors=[];
  const password='SubscriptionUiPass123',suffix=[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join('');
  let original;
  const account=async role=>{
   const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Qyzylorda',reducedMotion:'reduce'});contexts.push(context);
   const page=await context.newPage(),username='subui'+role+suffix;
   page.on('pageerror',e=>{errors.push(e.message);console.log('RITM_SUBSCRIPTION_BROWSER_ERROR '+e.stack);});page.on('dialog',dialog=>dialog.accept());
   const response=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Проверка подписки'}});
   assert.ok(response.ok());created.push(username);return {page,username};
  };
  const navigate=async(page,route,title)=>{
   await page.evaluate(route=>location.hash=route,route);
   await page.waitForFunction(title=>document.getElementById('heading').textContent===title,title);
  };
  const fits=async(page,label)=>{
   for(const width of [320,390,1440]){
    await page.setViewportSize({width,height:1000});await page.evaluate(()=>document.fonts.ready);
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),name+': '+label+' fits '+width+'px');
   }
   check(await page.locator('.mobile-nav a').count()===5,name+': five mobile navigation entries '+label);
   await page.setViewportSize({width:390,height:844});
  };
  try{
   original=(await pool.query('SELECT * FROM ritm_payment_settings WHERE id=1')).rows[0];await pool.query('DELETE FROM ritm_payment_settings');
   const buyer=await account('buyer'),owner=await account('developer');await grantFixturePremium(base,owner.username,true);
   await buyer.page.goto(base,{waitUntil:'networkidle'});try{await buyer.page.locator('#application').waitFor({state:'visible'});}catch(error){console.log('RITM_SUBSCRIPTION_AUTH_ERROR '+await buyer.page.locator('#auth-error').textContent());throw error;}
   check(await buyer.page.locator('#finance-privacy').isHidden()&&await buyer.page.locator('.daily-wish').count()===0&&await buyer.page.locator('[data-personal-next]').count()===0,name+': Basic has no eye wish or tasks');
   check(await buyer.page.locator('.mobile-nav [data-nav="goals"]').textContent()==='Цели',name+': Basic menu offers monetary goals');await fits(buyer.page,'Basic home');
   await navigate(buyer.page,'personal','Цели');check(await buyer.page.locator('.personal-breadcrumb').count()===0,name+': personal route safely redirects Basic to savings');
   await navigate(buyer.page,'premium','Premium');await buyer.page.locator('[data-payment-unavailable]').waitFor();
   check(await buyer.page.locator('[data-payment-unavailable] button').isDisabled(),name+': checkout disabled without Kaspi details');await fits(buyer.page,'Premium page');if(name==='chromium'){for(const width of [390,1440]){await buyer.page.setViewportSize({width,height:1000});console.log('RITM_SCREENSHOT_PREMIUM_'+width+' '+(await buyer.page.screenshot({fullPage:true})).toString('base64'));}await buyer.page.setViewportSize({width:390,height:844});}
   await owner.page.goto(base+'/#developer',{waitUntil:'networkidle'});await owner.page.locator('#merchant-form').waitFor();await fits(owner.page,'developer cabinet');
   await owner.page.locator('#merchant-phone').fill('+7 701 000 00 00');await owner.page.locator('#merchant-name').fill('Тестовый получатель');
   await owner.page.locator('#merchant-password').fill(password);await owner.page.locator('#merchant-form [type="submit"]').click();
   await owner.page.waitForFunction(()=>document.querySelector('#merchant-password')?.value===''&&document.querySelector('.subscription-admin')?.textContent.includes('Приём заявок включён.'));
   await buyer.page.reload({waitUntil:'networkidle'});await buyer.page.locator('#subscription-order-form').waitFor();
   await buyer.page.locator('[data-sub-action="choose-plan"][data-period="month"]').click();
   check(await buyer.page.locator('[data-period="month"]').getAttribute('aria-pressed')==='true'&&(await buyer.page.locator('.subscription-transfer-amount').textContent()).includes('990'),name+': selected plan synchronizes transfer amount');
   await buyer.page.locator('#subscription-confirm').check();await buyer.page.locator('[data-period="year"]').click();check(!await buyer.page.locator('#subscription-confirm').isChecked(),name+': tariff change requires transfer confirmation again');await buyer.page.locator('[data-period="month"]').click();
   await buyer.page.locator('#subscription-sender').fill('Тестовый отправитель');await buyer.page.locator('#subscription-confirm').check();
   await buyer.page.locator('#subscription-order-form [type="submit"]').click();await buyer.page.locator('[data-sub-order][data-status="pending"]').waitFor();
   check(await buyer.page.locator('#finance-privacy').isHidden(),name+': transfer report does not unlock Premium');
   await owner.page.locator('[data-sub-action="refresh-developer"]').click();await owner.page.locator('[data-developer-order][data-status="pending"]').waitFor();
   check((await owner.page.locator('[data-developer-order]').textContent()).includes(buyer.username),name+': developer sees buyer login and sender');
   await owner.page.locator('[data-sub-action="approve"]').click();await owner.page.locator('[data-developer-order][data-status="pending"]').waitFor({state:'hidden'});
   await buyer.page.reload({waitUntil:'networkidle'});await buyer.page.locator('[data-membership-status]').waitFor();
   check(await buyer.page.locator('#finance-privacy').isVisible()&&await buyer.page.locator('.mobile-nav [data-nav="personal"]').count()===1,name+': approved Premium exposes eye and personal navigation');
   await navigate(buyer.page,'home','Главная');await buyer.page.locator('.daily-wish').waitFor();await buyer.page.locator('[data-personal-next]').first().waitFor();
   check(await buyer.page.locator('[data-personal-next]').count()===2,name+': Premium home includes task and habit');
   await buyer.page.locator('#finance-privacy').click();check(await buyer.page.locator('#application').getAttribute('data-finances-hidden')!==null,name+': paid eye masks finance');
   await navigate(buyer.page,'personal','Личное');await fits(buyer.page,'paid personal');
   await owner.page.locator('[data-sub-action="preview-on"]').click();await navigate(owner.page,'home','Главная');
   check(await owner.page.locator('#finance-privacy').isHidden()&&await owner.page.locator('.mobile-nav [data-nav="goals"]').count()===1&&await owner.page.locator('.daily-wish').count()===0,name+': developer can preview Basic');
   await navigate(owner.page,'premium','Premium');check((await owner.page.locator('[data-membership-status]').textContent()).includes('Пожизненный Premium'),name+': preview preserves lifetime entitlement');
   await owner.page.locator('[data-sub-action="preview-off"]').click();check(await owner.page.locator('#finance-privacy').isVisible(),name+': developer exits Basic preview');
   await navigate(buyer.page,'settings','Настройки');await fits(buyer.page,'subscription settings');
   const buyerId=(await pool.query('SELECT id FROM ritm_users WHERE username=$1',[buyer.username])).rows[0].id;
   await pool.query('UPDATE ritm_memberships SET expires_at=$2 WHERE user_id=$1',[buyerId,Date.now()-1]);
   await buyer.page.evaluate(()=>window.dispatchEvent(new Event('focus')));
   await buyer.page.waitForFunction(()=>document.getElementById('finance-privacy').hidden&&document.querySelector('.mobile-nav [data-nav="goals"]'));
   check(await buyer.page.locator('#application').getAttribute('data-finances-hidden')===null,name+': expiry restores Basic visible finances');
   await navigate(buyer.page,'home','Главная');check(await buyer.page.locator('.daily-wish').count()===0,name+': expiry removes Premium home blocks');
   check(errors.length===0,name+': subscription screens have no browser errors '+errors.join(';'));
  }finally{
   for(const context of contexts)await context.close();await browser.close();
   await pool.query('DELETE FROM ritm_users WHERE username=ANY($1::text[])',[created]);await pool.query('DELETE FROM ritm_payment_settings');
   if(original)await pool.query('INSERT INTO ritm_payment_settings(id,phone,name,revision,updated_at) VALUES($1,$2,$3,$4,$5)',[original.id,original.phone,original.name,original.revision,original.updated_at]);
   await pool.end();
  }
 }
 console.log('RITM_SUBSCRIPTION_UI_PASS '+checks);
}
