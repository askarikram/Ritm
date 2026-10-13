import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chromium, webkit } from 'playwright';

export async function verifyMonthUI(base){
  let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('RITM_MONTH_UI_CHECK '+label);};
  for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
    const browser=await engine.launch({headless:true});
    const context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'UTC',reducedMotion:'reduce'});
    const page=await context.newPage(),errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    page.on('dialog',dialog=>dialog.accept());
    const username='monthtest'+[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join('');
    const password='MonthTestPassword123',headers={Origin:base,'X-Ritm-User':username};
    let created=false;
    const saved=()=>page.waitForFunction(()=>document.getElementById('save-state')?.textContent==='План сохранён');
    const navigate=async route=>{
      await page.evaluate(route=>{location.hash=route;},route);
      await page.waitForFunction(route=>document.querySelector('[data-nav="'+route+'"][aria-current="page"]'),route);
    };
    const read=async()=>{const response=await page.request.get(base+'/api/me',{headers});assert.ok(response.ok());return (await response.json()).plan;};
    const active=(type,key)=>page.locator('[data-active-list="'+type+'"] [data-event-key="'+key+'"]');
    const history=(type,key)=>page.locator('[data-history-list="'+type+'"] [data-history-key="'+key+'"]');
    const confirm=async(type,key)=>{
      await active(type,key).locator('[data-action="record"]').click();
      await page.locator('#dialog').waitFor({state:'visible'});
      await page.locator('#editor button[type="submit"]').click();
      await page.locator('#dialog').waitFor({state:'hidden'});await saved();
      check(await active(type,key).count()===0,name+': confirmed '+key+' leaves active list');
      check(await history(type,key).count()===1,name+': confirmed '+key+' stays in history');
    };
    try{
      const signup=await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Проверка месяца',remember:true}});
      check(signup.ok(),name+': disposable month account created');created=true;
      const plan={version:1,balance:1000000,daily:1000,currency:'KZT',done:{},ledger:[],items:[
        {id:'once-income',title:'Разовая премия',type:'income',amount:1000,date:'2024-01-31',repeat:'none'},
        {id:'once-payment',title:'Разовая покупка',type:'payment',amount:2000,date:'2024-01-31',repeat:'none'},
        {id:'month-income',title:'Зарплата',type:'income',amount:300000,date:'2024-01-31',repeat:'monthly'},
        {id:'month-payment',title:'Подписка',type:'payment',amount:4000,date:'2024-01-31',repeat:'monthly'}
      ],goals:[{id:'goal',title:'Подушка безопасности',target:100000,saved:50000,mode:'monthly',monthly:10000,start:'2024-01-31',deadline:'2024-01-31',done:[]}]};
      check((await page.request.put(base+'/api/plan',{headers,data:{revision:0,plan}})).ok(),name+': seed valid financial plan');
      await page.clock.install({time:new Date('2024-01-31T23:00:00Z')});
      await page.goto(base,{waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});
      await page.evaluate(()=>document.fonts.ready);
      await navigate('income');
      check(await page.locator('[data-planned-total="income"]').getAttribute('data-total-cents')==='301000',name+': active income total before confirmation');
      await confirm('income','once-income@2024-01-31');
      check(await page.locator('[data-planned-total="income"]').getAttribute('data-total-cents')==='300000',name+': income total decreases after receipt');
      await confirm('income','month-income@2024-01-31');
      check(await page.locator('[data-planned-total="income"]').getAttribute('data-total-cents')==='0',name+': all received incomes removed from total');
      await history('income','month-income@2024-01-31').locator('[data-action="edit-item"]').click();
      check(await page.locator('#editor [name="repeat"]').inputValue()==='monthly',name+': monthly setting remains editable from history');
      await page.locator('#dialog [data-action="close"]').first().click();
      await navigate('payment');
      if(name==='chromium'){const shot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_MONTH_ACTIVE_390 '+shot.toString('base64'));}
      await confirm('payment','once-payment@2024-01-31');
      await history('payment','once-payment@2024-01-31').locator('[data-action="undo"]').click();await saved();
      check(await active('payment','once-payment@2024-01-31').count()===1&&await history('payment','once-payment@2024-01-31').count()===0,name+': undo restores one-time payment to active list');
      check((await read()).balance===1301000,name+': undo restores actual balance');
      await confirm('payment','once-payment@2024-01-31');
      await confirm('payment','month-payment@2024-01-31');
      check(await page.locator('[data-planned-total="payment"]').getAttribute('data-total-cents')==='0',name+': paid list total is zero');
      const january=await read();
      check(january.balance===1295000&&january.ledger.length===4,name+': actual transactions saved once');
      await navigate('home');
      check(await page.locator('[data-month-forecast]').getAttribute('data-end-date')==='2024-01-31',name+': home forecast ends this month');
      const amount=async selector=>(await page.locator(selector).textContent()).replace(/\D/g,'');
      check(await amount('[data-month-account-end]')==='12940'&&await amount('[data-month-available-end]')==='12340',name+': monthly account and available totals distinguish goal transfers');
      await page.locator('#finance-privacy').click();
      check((await page.locator('[data-month-account-end]').textContent()).includes('••••')&&(await page.locator('[data-month-available-end]').textContent()).includes('••••'),name+': privacy hides new month-end totals');
      await page.locator('#finance-privacy').click();
      if(name==='chromium'){await page.setViewportSize({width:1440,height:1000});const shot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_MONTH_HOME_1440 '+shot.toString('base64'));await page.setViewportSize({width:390,height:844});}
      await navigate('calendar');await page.locator('[data-action="cal-view"][data-view="forecast"]').click();
      check(await page.locator('[data-two-month-forecast]').getAttribute('data-end-date')==='2024-02-29',name+': long forecast covers current and next month');
      check(await page.locator('[data-forecast-date="2024-02-29"]').count()===1&&await page.locator('[data-forecast-date="2024-03-01"]').count()===0,name+': forecast includes cutoff and excludes third month');
      await navigate('payment');
      await page.clock.pauseAt(new Date('2024-01-31T23:59:55Z'));
      await page.clock.fastForward('00:00:10');
      await active('payment','month-payment@2024-02-29').waitFor();
      check(await page.locator('[data-active-list="payment"] [data-event-key]').count()===1,name+': first day restores monthly payment without reload');
      check(await history('payment','month-payment@2024-01-31').count()===1,name+': January payment remains in history on first day');
      check(await page.locator('[data-planned-total="payment"]').getAttribute('data-total-cents')==='4000',name+': first day updates active payment total');
      await confirm('payment','month-payment@2024-02-29');
      check(await page.locator('[data-active-list="payment"] [data-event-key]').count()===0,name+': early February payment stays hidden');
      check((await read()).ledger[0].date==='2024-02-01'&&(await read()).ledger[0].plannedDate==='2024-02-29',name+': early payment keeps actual and planned dates');
      await page.reload({waitUntil:'networkidle'});await saved();
      check(await page.locator('[data-active-list="payment"] [data-event-key]').count()===0&&await history('payment','month-payment@2024-02-29').count()===1,name+': reload preserves hidden February entry and history');
      await navigate('income');
      check(await active('income','month-income@2024-02-29').count()===1&&await active('income','once-income@2024-01-31').count()===0,name+': only monthly income returns in February');
      await confirm('income','month-income@2024-02-29');
      await navigate('home');
      check(await page.locator('[data-month-forecast]').getAttribute('data-end-date')==='2024-02-29',name+': February home forecast ends on leap day');
      await navigate('calendar');await page.locator('[data-action="cal-view"][data-view="forecast"]').click();
      check(await page.locator('[data-two-month-forecast]').getAttribute('data-end-date')==='2024-03-31',name+': February long forecast ends in March');
      await navigate('payment');
      await page.clock.fastForward(29*86400000);
      await active('payment','month-payment@2024-03-31').waitFor();
      check(await page.locator('[data-active-list="payment"] [data-event-key]').count()===1,name+': March restores original day 31 and no one-time payment');
      check(await page.locator('[data-history-list="payment"] [data-history-key]').count()===3,name+': March retains January and February history');
      if(name==='chromium'){const shot=await page.screenshot({fullPage:true});console.log('RITM_SCREENSHOT_MONTH_HISTORY_390 '+shot.toString('base64'));}
      check((await read()).balance===1591000,name+': calendar rollover does not change actual balance');
      for(const width of [320,390,768,1440]){
        await page.setViewportSize({width,height:844});
        check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+': new active and history layout fits '+width+'px');
      }
      check(errors.length===0,name+': no month-flow browser errors');
    } finally {
      if(created)await page.request.delete(base+'/api/account',{headers,data:{currentPassword:password,confirmation:'УДАЛИТЬ'}});
      await context.close();await browser.close();
    }
  }
  console.log('RITM_MONTH_UI_PASS '+checks+' checks');
}
