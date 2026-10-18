import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {chromium,webkit} from 'playwright';
import {grantFixturePremium} from './premium-fixture.mjs';

export async function verifySpendingUI(base){
 let checks=0;
 const check=(ok,label)=>{assert.ok(ok,label);checks++;console.log('RITM_SPENDING_UI_CHECK '+label);};
 for(const [name,engine] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await engine.launch({headless:true}),context=await browser.newContext({viewport:{width:390,height:844},timezoneId:'Asia/Almaty',reducedMotion:'reduce'}),page=await context.newPage(),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  const username='spending'+[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='SpendingTestPassword123',headers={Origin:base,'X-Ritm-User':username};
  let created=false;
  const saved=()=>page.waitForFunction(()=>document.getElementById('save-state')?.textContent==='План сохранён');
  const navigate=async hash=>{await page.evaluate(h=>{location.hash=h;},hash);await page.waitForFunction(h=>document.getElementById('heading')?.textContent===(h.startsWith('home')?'Главная':'Платежи'),hash);};
  const amount=async selector=>(await page.locator(selector).textContent()).replace(/[^0-9]/g,'');
  const read=async()=>{const r=await page.request.get(base+'/api/me',{headers});assert.ok(r.ok());return (await r.json()).plan;};
  const submit=async()=>{await page.locator('#editor button[type="submit"]').click();await page.locator('#dialog').waitFor({state:'hidden'});await saved();};
  try{
   check((await page.request.post(base+'/api/signup',{headers:{Origin:base},data:{username,password,confirmPassword:password,name:'Проверка периодов'}})).ok(),name+': create disposable account');created=true;
   const plan={version:1,balance:1000000,daily:55555,currency:'KZT',goals:[],items:[],ledger:[],done:{}};
   const receipt=(id,date,amount,category='expense',repeat='none',plannedDate=date)=>{
    const key=id+'@'+plannedDate;
    plan.items.push({id,title:id,type:'payment',date:plannedDate,amount,repeat,...(category?{spendingType:category}:{})});
    plan.ledger.push({id:'receipt-'+id,key,itemId:id,title:id,type:'payment',date,plannedDate,amount,...(category?{spendingType:category}:{})});plan.done[key]=true;
   };
   receipt('prev-sunday','2026-10-11',1100);receipt('monday','2026-10-12',1200);receipt('sunday','2026-10-18',1800);receipt('next-monday','2026-10-19',1900);
   receipt('last-month','2026-09-30',3000);receipt('old-expense','2026-10-09',900);receipt('legacy','2026-10-14',1400,null);
   receipt('rent','2026-10-12',50000,'payment','monthly','2026-10-10');
   plan.items.push({id:'pending',title:'pending',type:'payment',date:'2026-10-20',amount:10000,repeat:'none',spendingType:'payment'});
   plan.items.push({id:'weekly',title:'weekly',type:'payment',date:'2026-10-05',amount:1000,repeat:'weekly',spendingType:'payment'});
   plan.items.push({id:'november',title:'november',type:'payment',date:'2026-11-02',amount:7777,repeat:'none',spendingType:'payment'});
   plan.ledger.push({id:'paid-removed',itemId:'removed',key:'removed@2026-10-15',title:'removed',type:'payment',date:'2026-10-15',plannedDate:'2026-10-15',amount:1234,spendingType:'payment'});plan.done['removed@2026-10-15']=true;
   plan.ledger.push({id:'income',itemId:'salary',key:'salary@2026-10-13',title:'salary',type:'income',date:'2026-10-13',plannedDate:'2026-10-13',amount:999999});plan.done['salary@2026-10-13']=true;
   check((await page.request.put(base+'/api/plan',{headers,data:{revision:0,plan}})).ok(),name+': persist classified and legacy spending');
   await page.clock.install({time:new Date('2026-10-18T05:00:00Z')});
   await page.goto(base,{waitUntil:'networkidle'});await page.locator('#application').waitFor({state:'visible'});await saved();
   check(await amount('[data-week-expenses]')==='44',name+': Monday to Sunday expenses exclude paid bills and daily allowance');
   check(await page.locator('[data-week-expenses]').getAttribute('data-start-date')==='2026-10-12'&&await page.locator('[data-week-expenses]').getAttribute('data-end-date')==='2026-10-18',name+': correct inclusive week boundaries');
   check(await page.getByText('Доступно для трат',{exact:true}).count()===0,name+': duplicate available balance removed');
   check(await amount('[data-recent-expense-total]')==='83'&&await page.locator('[data-recent-expense]').count()===5,name+': home monthly total includes all six expenses, even outside visible five');
   check(!(await page.locator('[data-recent-expenses]').textContent()).includes('rent'),name+': paid recurring bill excluded from recent expenses');
   if(name==='chromium')for(const width of [390,1440]){await page.setViewportSize({width,height:1000});console.log('RITM_SCREENSHOT_WEEK_HOME_'+width+' '+(await page.screenshot({fullPage:true})).toString('base64'));}
   await page.setViewportSize({width:390,height:844});
   await page.locator('.recent-expense-more').click();await page.locator('[data-history-list="payment"]').waitFor();
   check(await page.locator('[data-history-list="payment"]').evaluate(n=>document.activeElement===n),name+': home history link focuses monthly expense section');
   check(await page.locator('[data-planned-total="payment"]').getAttribute('data-total-cents')==='65234',name+': payment month total counts scheduled occurrences and removed paid schedule once');
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='8300',name+': expense total reflects selected month only');
   check(await page.locator('[data-active-list="payment"] [data-event-key]').count()===5,name+': one continuous monthly list has unpaid once and four weekly dates');
   check(await page.locator('[data-history-list="payment"] [data-history-key]').count()===6&&await page.locator('[data-paid-list] [data-history-key]').count()===2,name+': expenses and paid bills have separate histories');
   check(await page.locator('.plan-summary').count()===0,name+': payment total is inside shared payment card');
   assert.deepEqual(await page.locator('[data-active-list="payment"] [data-event-key]').evaluateAll(ns=>ns.map(n=>n.dataset.eventKey)),['weekly@2026-10-05','weekly@2026-10-12','weekly@2026-10-19','pending@2026-10-20','weekly@2026-10-26']);checks++;
   for(const width of [320,390,768,1440]){
    await page.setViewportSize({width,height:1000});
    check(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),name+': payment and expense sections fit '+width+'px');
    check(await page.locator('.payment-month-card .schedule-table tr').evaluateAll(ns=>ns.every(n=>getComputedStyle(n).borderRadius==='0px')),name+': rows have no individual rounded cards at '+width+'px');
    check(await page.locator('.payment-month-card,.expense-month-card').evaluateAll(ns=>ns.length===2&&Math.abs(ns[0].getBoundingClientRect().width-ns[1].getBoundingClientRect().width)<1),name+': both monthly sections share the same width '+width+'px');
   }
   if(name==='chromium')for(const width of [390,1440]){await page.setViewportSize({width,height:1000});console.log('RITM_SCREENSHOT_SPENDING_'+width+' '+(await page.screenshot({fullPage:true})).toString('base64'));}
   await page.locator('[data-action="edit-expense"][data-id="receipt-monday"]').click();
   await page.locator('#editor [name="amount"]').fill('22');await page.locator('#editor [name="date"]').fill('2026-10-11');await submit();
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='9300',name+': expense edits update month sum');
   await navigate('home');check(await amount('[data-week-expenses]')==='32'&&await amount('[data-recent-expense-total]')==='93',name+': changed date leaves current week and updates home month total');
   await navigate('payment');
   await page.locator('[data-event-key="pending@2026-10-20"] [data-action="record"]').click();await submit();
   check(await page.locator('[data-planned-total="payment"]').getAttribute('data-total-cents')==='65234',name+': confirmation retains full month planned payment total');
   await navigate('home');check(await amount('[data-week-expenses]')==='32',name+': confirming a one-time payment never increases weekly expenses');
   await navigate('payment');
   await page.locator('.expense-month-card [data-action="expense"]').click();await page.locator('#editor [name="title"]').fill('Новый расход');await page.locator('#editor [name="amount"]').fill('7');await submit();
   let stored=await read(),fresh=stored.ledger.find(e=>e.title==='Новый расход');
   check(fresh?.spendingType==='expense'&&stored.items.find(i=>i.id===fresh.itemId).spendingType==='expense',name+': new manual expense stores its origin explicitly');
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='10000',name+': manual expense updates month total');
   await page.locator('[data-history-key="'+fresh.key+'"] [data-action="undo"]').click();await saved();
   check(!(await read()).items.some(i=>i.id===fresh.itemId)&&await page.locator('[data-event-key="'+fresh.key+'"]').count()===0,name+': undo manual expense removes its hidden item instead of creating a scheduled payment');
   await page.locator('[data-action="edit-expense"][data-id="receipt-legacy"]').click();await page.locator('#editor [name="spendingType"]').selectOption('payment');await submit();
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='7900',name+': legacy category correction moves entry out of expenses');
   await page.getByRole('link',{name:'Предыдущий месяц',exact:true}).click();await page.locator('[data-payment-period][data-start-date="2026-09-01"]').waitFor();
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='3000',name+': September shows its own expense history');
   check(await page.locator('[data-history-list="payment"] [data-history-key]').count()===1,name+': past month does not include current receipts');
   await page.getByRole('link',{name:'Текущий месяц',exact:true}).click();await page.locator('[data-payment-period][data-start-date="2026-10-01"]').waitFor();
   await page.locator('[data-payment-month]').fill('2026-11');await page.locator('[data-payment-period][data-start-date="2026-11-01"]').waitFor();
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='0'&&await page.locator('[data-planned-total="payment"]').getAttribute('data-total-cents')==='62777',name+': November resets expenses and uses only its own payment occurrences');
   await page.reload({waitUntil:'networkidle'});await saved();check(await page.locator('[data-payment-period]').getAttribute('data-start-date')==='2026-11-01',name+': selected month survives reload');
   await page.getByRole('link',{name:'Текущий месяц',exact:true}).click();await page.locator('[data-payment-period][data-start-date="2026-10-01"]').waitFor();
   await grantFixturePremium(base,username);await page.reload({waitUntil:'networkidle'});await saved();
   await page.locator('#finance-privacy').click();
   check(await page.locator('[data-planned-total]').evaluateAll(ns=>ns.length===2&&ns.every(n=>n.textContent.includes('••••')&&n.dataset.totalCents==='')),name+': privacy conceals both monthly totals and datasets');
   await navigate('home');check(await page.locator('[data-week-expenses],[data-recent-expense-total]').evaluateAll(ns=>ns.length===2&&ns.every(n=>n.textContent.includes('••••'))),name+': privacy masks weekly and monthly home figures');
   await page.locator('#finance-privacy').click();
   await page.clock.pauseAt(new Date('2026-10-18T18:59:55Z'));await page.clock.fastForward('00:00:10');
   check(await amount('[data-week-expenses]')==='19',name+': local Monday rolls weekly sum without reload');
   await navigate('payment');await page.clock.fastForward(13*86400000);
   await page.locator('[data-payment-period][data-start-date="2026-11-01"]').waitFor();
   check(await page.locator('[data-planned-total="expense"]').getAttribute('data-total-cents')==='0',name+': first day automatically resets current month view');
   check((await read()).ledger.some(e=>e.id==='receipt-sunday'),name+': rollover retains previous month saved data');
   check(errors.length===0,name+': no spending browser errors');
  }finally{
   if(created)await page.request.delete(base+'/api/account',{headers,data:{currentPassword:password,confirmation:'УДАЛИТЬ'}});
   await context.close();await browser.close();
  }
 }
 console.log('RITM_SPENDING_UI_PASS '+checks+' checks');
}
