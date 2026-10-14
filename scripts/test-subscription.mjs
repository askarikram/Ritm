import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { extendSubscription } from '../subscription-service.mjs';
import { fixturePool,grantFixturePremium } from './premium-fixture.mjs';
export async function verifySubscriptions(base){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_SUBSCRIPTION_CHECK '+label);};
 for(const [start,months,expected] of [
  ['2026-01-31T10:15:00Z',1,'2026-02-28T10:15:00Z'],
  ['2024-02-29T10:15:00Z',12,'2025-02-28T10:15:00Z'],
  ['2026-10-31T22:15:00Z',1,'2026-12-01T22:15:00Z']
 ])check(new Date(extendSubscription(Date.parse(start),months)).toISOString()===expected,'calendar subscription uses Kazakhstan date and clamps month end '+start);
 const pool=fixturePool(base),suffix=[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='PremiumFixturePass123',created=[];
 const a={username:'premiuma'+suffix},b={username:'premiumb'+suffix},dev={username:'premiumdev'+suffix};
 const request=async(account,path,method='GET',data,extra={})=>{
  const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{Origin:base}:{}),...(account?{Cookie:account.cookie||'','X-Ritm-User':account.username}:{}),...(data?{'Content-Type':'application/json'}:{}),...extra},body:data?JSON.stringify(data):undefined});
  const cookie=response.headers.get('set-cookie');if(cookie&&account)account.cookie=cookie.split(';')[0];
  return {status:response.status,body:await response.json()};
 };
 let original;
 try{
  original=(await pool.query('SELECT * FROM ritm_payment_settings WHERE id=1')).rows[0];await pool.query('DELETE FROM ritm_payment_settings');
  for(const user of [a,b,dev]){
   const reply=await request(user,'/api/signup','POST',{username:user.username,name:'Проверка Premium',password,confirmPassword:password,membership:{tier:'premium',developer:true}});
   check(reply.status===200&&reply.body.user.membership.tier==='basic','signup cannot grant its own Premium '+user.username);created.push(user.username);
  }
  await grantFixturePremium(base,dev.username,true);
  const uid=(await pool.query('SELECT id,username FROM ritm_users WHERE username=ANY($1::text[])',[created])).rows;for(const user of [a,b,dev])user.id=uid.find(r=>r.username===user.username).id;
  check((await request(null,'/api/subscription')).status===401,'subscription requires authentication');
  for(const method of ['GET','POST'])for(const path of ['/api/wish','/api/personal']){
   const response=await request(a,path,method,method==='POST'?{revision:0,action:'add_task',item:{title:'Bypass',date:'2026-10-14',time:''}}:undefined);
   check(response.status===403&&response.body.code==='premium_required','basic direct '+method+' '+path+' blocked');
  }
  check((await request(a,'/api/me')).status===200&&(await request(a,'/api/archive?year=2026')).status===200&&(await request(a,'/api/reminders?timeZone=UTC')).status===200,'basic finance archive and reminders remain available');
  const unconfigured=await request(a,'/api/subscription');check(!unconfigured.body.merchant.ready&&unconfigured.body.plans.find(p=>p.id==='year').amount===990000,'server prices are fixed and unconfigured payments unavailable');
  check((await request(a,'/api/subscription/orders','POST',{period:'month',senderName:'Тест',merchantRevision:1})).status===409,'payment fails closed until merchant configuration');
  check((await request(a,'/api/developer/subscription')).status===403,'basic cannot view other users payment requests');
  check((await request(a,'/api/developer/subscription','PATCH',{phone:'+77010000000',name:'Тест',revision:0,currentPassword:password})).status===403,'basic cannot change payment destination');
  check((await request(dev,'/api/developer/subscription','PATCH',{phone:'+77010000000',name:'Тест',revision:0,currentPassword:'WrongPassword123'})).status===401,'merchant change requires correct current password');
  const configured=await request(dev,'/api/developer/subscription','PATCH',{phone:'+7 701 000 00 00',name:'Тестовый получатель',revision:0,currentPassword:password});
  check(configured.status===200&&configured.body.merchant.phone==='+77010000000','developer configures normalized payment destination');
  check((await request(dev,'/api/developer/subscription','PATCH',{phone:'+77020000000',name:'Тест',revision:0,currentPassword:password})).status===409,'stale contact update cannot overwrite destination');
  check((await request(a,'/api/subscription/orders','POST',{period:'toString',senderName:'Тест',merchantRevision:1})).status===400,'inherited object keys cannot select a tariff');
  const order=await request(a,'/api/subscription/orders','POST',{period:'month',senderName:'Тестовый отправитель',merchantRevision:1,amount:1,status:'approved',userId:dev.id,currency:'USD'});
  check(order.status===200&&order.body.order.amount===99000&&order.body.order.status==='pending'&&order.body.order.currency==='KZT','client price status currency and owner cannot alter order');
  const id=order.body.order.id;
  check((await request(a,'/api/membership')).body.membership.tier==='basic','reporting a transfer does not activate membership');
  const repeated=await Promise.all(Array.from({length:3},()=>request(a,'/api/subscription/orders','POST',{period:'year',senderName:'Тест',merchantRevision:1})));
  check(repeated.every(r=>r.status===200&&r.body.order.id===id),'repeated transfer reports reuse a single pending order');
  check((await request(b,'/api/subscription?userId='+a.id)).body.orders.length===0,'buyer cannot read another account orders');
  check((await request(a,'/api/developer/orders/'+id,'POST',{status:'approved'})).status===403,'buyer cannot approve own request');
  check((await request(dev,'/api/developer/orders/'+id,'POST',{status:'approved'},{Origin:'https://attacker.invalid'})).status===403,'admin decision requires same origin');
  const approvals=await Promise.all([request(dev,'/api/developer/orders/'+id,'POST',{status:'approved'}),request(dev,'/api/developer/orders/'+id,'POST',{status:'approved'})]);
  const active=(await request(a,'/api/membership')).body.membership;
  check(approvals.every(r=>r.status===200)&&active.tier==='premium'&&!active.developer&&!active.lifetime,'concurrent manual approval grants regular Premium');
  const initialEnd=Date.parse(active.expiresAt);check(initialEnd<=extendSubscription(Date.now(),1)&&initialEnd>=extendSubscription(Date.now()-30000,1),'duplicate approvals add only one calendar month');
  check((await request(a,'/api/personal')).status===200&&(await request(a,'/api/wish')).status===200,'approved buyer gains personal and wish access');
  const personal=(await request(a,'/api/personal?timeZone=UTC')).body;
  const day=new Date().toISOString().slice(0,10);
  check((await request(a,'/api/personal','POST',{revision:personal.revision,action:'add_task',item:{title:'Сохранить при окончании',date:day,time:''}})).status===200,'premium personal record saved');
  const renewal=(await request(a,'/api/subscription/orders','POST',{period:'year',senderName:'Тест',merchantRevision:1})).body.order;
  await request(dev,'/api/developer/orders/'+renewal.id,'POST',{status:'approved'});
  check(Date.parse((await request(a,'/api/membership')).body.membership.expiresAt)===extendSubscription(initialEnd,12),'early renewal adds a year to existing end date');
  await pool.query('UPDATE ritm_memberships SET expires_at=$2 WHERE user_id=$1',[a.id,Date.now()-1000]);
  check((await request(a,'/api/personal')).status===403&&(await request(a,'/api/wish')).status===403,'expired subscription is denied immediately by server');
  check((await pool.query('SELECT state FROM ritm_personal WHERE user_id=$1',[a.id])).rows[0].state.tasks[0].title==='Сохранить при окончании','expiry preserves personal data for renewal');
  check((await request(a,'/api/me')).status===200&&(await request(a,'/api/reminders')).status===200,'expiry keeps financial plan and payment reminders');
  const rejected=(await request(b,'/api/subscription/orders','POST',{period:'year',senderName:'Тест',merchantRevision:1})).body.order;
  check((await request(dev,'/api/developer/orders/'+rejected.id,'POST',{status:'rejected',reason:'Сумма не совпадает.'})).status===200,'developer can reject unmatched transfer');
  check((await request(b,'/api/membership')).body.membership.tier==='basic'&&(await request(b,'/api/subscription')).body.orders[0].reason==='Сумма не совпадает.','rejection explains reason and does not activate');
  check((await request(dev,'/api/developer/orders/'+rejected.id,'POST',{status:'approved'})).status===409,'rejected decision cannot later be silently changed');
  check((await request(dev,'/api/subscription/orders','POST',{period:'month',senderName:'Тест',merchantRevision:1})).status===409,'lifetime developer cannot accidentally buy a subscription');
  check((await request(dev,'/api/developer/subscription')).body.orders.every(o=>o.username&&o.senderName),'developer review shows buyer identity and transfer sender');
 }finally{
  await pool.query('DELETE FROM ritm_users WHERE username=ANY($1::text[])',[created]);
  await pool.query('DELETE FROM ritm_payment_settings');
  if(original)await pool.query('INSERT INTO ritm_payment_settings(id,phone,name,revision,updated_at) VALUES($1,$2,$3,$4,$5)',[original.id,original.phone,original.name,original.revision,original.updated_at]);
  await pool.end();
 }
 console.log('RITM_SUBSCRIPTION_PASS '+checks);
}
