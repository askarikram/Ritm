import { grantFixturePremium } from './premium-fixture.mjs';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { WISHES, dateInZone, wishDay, wishForDay } from '../daily-wishes.mjs';

export async function verifyWishes(base){
  let checks=0;
  const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('RITM_WISH_CHECK '+label);};
  check(WISHES.length===5&&WISHES.every(track=>track.length===30),'five complete 30-day collections');
  check(new Set(WISHES.flat()).size===150,'150 distinct wishes');
  check(WISHES.flat().every(text=>text.length<=120&&text.endsWith('.')),'short single-sentence wishes');
  for(let lane=0;lane<5;lane++){
    const days=Array.from({length:30},(_,i)=>new Date(Date.UTC(2026,9,13+i)).toISOString().slice(0,10));
    check(new Set(days.map(day=>wishForDay(lane,day))).size===30,'no repeats across month boundary for collection '+lane);
  }
  for(let i=0;i<30;i++){
    const date=new Date(Date.UTC(2026,9,13+i)).toISOString().slice(0,10);
    assert.equal(new Set(Array.from({length:5},(_,lane)=>wishForDay(lane,date))).size,5);
  }
  check(true,'five different wishes on every day of the cycle');
  check(dateInZone('Asia/Almaty',Date.parse('2026-10-13T18:59:59Z'))==='2026-10-13'&&dateInZone('Asia/Almaty',Date.parse('2026-10-13T19:00:00Z'))==='2026-10-14','day changes at local midnight');
  for(const [now,expected] of [
    ['2026-10-13T18:59:59Z','2026-10-13T19:00:00Z'],
    ['2026-11-01T04:00:00Z','2026-11-02T05:00:00Z'],
    ['2026-03-08T05:00:00Z','2026-03-09T04:00:00Z']
  ]){
    const zone=now.startsWith('2026-10')?'Asia/Almaty':'America/New_York';
    const expires=Date.parse(wishDay(zone,Date.parse(now)).expiresAt);
    check(expires>=Date.parse(expected)&&expires-Date.parse(expected)<1000,'correct expiry including daylight saving '+now);
  }
  assert.throws(()=>wishDay('Not/A_TimeZone'));assert.throws(()=>wishForDay(5,'2026-10-13'));assert.throws(()=>wishForDay(0,'2026-02-30'));
  check(true,'invalid timezone, collection, and date rejected');

  const suffix=[...randomBytes(10)].map(n=>String.fromCharCode(97+n%26)).join('');
  const accounts=Array.from({length:5},(_,i)=>({username:'wishtest'+suffix+String.fromCharCode(97+i),password:randomBytes(20).toString('hex'),name:'Пожелания '+String.fromCharCode(65+i)})),created=[];
  const request=async(account,path,method='GET',data,extra={})=>{
    const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{'Content-Type':'application/json',Origin:base}:{}),...(account?{Cookie:account.cookie||'','X-Ritm-User':account.username}:{}),...extra},body:data?JSON.stringify(data):undefined,signal:AbortSignal.timeout(30000)});
    const cookie=response.headers.get('set-cookie');if(cookie&&account)account.cookie=cookie.split(';')[0];
    return {status:response.status,body:await response.json()};
  };
  const dbURL=new URL(process.env.DATABASE_URL);
  for(const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])dbURL.searchParams.delete(key);
  const pool=new pg.Pool({connectionString:dbURL.toString(),ssl:{rejectUnauthorized:true},enableChannelBinding:true,max:1,connectionTimeoutMillis:15000,query_timeout:15000});
  try{
    check((await request(null,'/api/wish')).status===401,'anonymous wish denied');
    for(const account of accounts){
      const signup=await request(account,'/api/signup','POST',{username:account.username,name:account.name,password:account.password,confirmPassword:account.password});
      assert.equal(signup.status,200);created.push(account.username);await grantFixturePremium(base,account.username);account.original=(await request(account,'/api/me')).body;
      const locked=await request(account,'/api/wish?timeZone=Asia%2FAlmaty');
      check(locked.status===200&&!locked.body.opened&&!Object.hasOwn(locked.body,'text'),'wish hidden before click');
    }
    check((await request(accounts[0],'/api/wish?timeZone=Invalid%2FZone')).status===400,'invalid timezone denied');
    check((await request(accounts[0],'/api/wish','POST',{timeZone:'UTC'},{Origin:'https://unrelated.invalid'})).status===403,'foreign origin open denied');
    check((await request(accounts[0],'/api/wish','POST',{timeZone:'UTC'},{'X-Ritm-User':accounts[1].username})).status===401,'forged account open denied');
    check((await request(accounts[0],'/api/wish','POST',{timeZone:'UTC'},{'X-Ritm-User':''})).status===403,'missing account open denied');
    const opened=await Promise.all(accounts.map(account=>request(account,'/api/wish','POST',{timeZone:'Asia/Almaty'})));
    check(opened.every(value=>value.status===200&&value.body.opened&&typeof value.body.text==='string'),'all five accounts can open concurrently');
    check(new Set(opened.map(value=>value.body.text)).size===5,'concurrent accounts receive different wishes');
    for(let i=0;i<5;i++){
      const account=accounts[i],again=await request(account,'/api/wish','POST',{timeZone:'UTC',date:'2099-01-01',username:accounts[(i+1)%5].username});
      check(again.status===200&&again.body.text===opened[i].body.text&&again.body.date===opened[i].body.date,'reopening stays on own current-day wish');
      const saved=await request(account,'/api/wish?timeZone=UTC');
      check(saved.body.opened&&saved.body.text===opened[i].body.text&&saved.body.timeZone==='Asia/Almaty','opened state and timezone survive fresh request');
      const plan=await request(account,'/api/me');
      assert.deepEqual(plan.body.plan,account.original.plan);
      check(plan.body.revision===account.original.revision,'opening a wish does not alter financial plan');
    }
    const otherDevice={username:accounts[0].username};
    check((await request(otherDevice,'/api/login','POST',{username:accounts[0].username,password:accounts[0].password})).status===200,'second device signs in');
    check((await request(otherDevice,'/api/wish')).body.text===opened[0].body.text,'same wish restored on another device');
    await pool.query('UPDATE ritm_wish_accounts SET opened_date=opened_date-1 WHERE user_id=(SELECT id FROM ritm_users WHERE username=$1)',[accounts[0].username]);
    const nextDay=await request(otherDevice,'/api/wish');
    check(!nextDay.body.opened&&!Object.hasOwn(nextDay.body,'text'),'yesterday open state does not reveal today');
    check((await request(otherDevice,'/api/wish','POST',{timeZone:'UTC'})).body.opened,'today can be opened after old state expires');
  }finally{
    try{if(created.length){const removed=await pool.query('DELETE FROM ritm_users WHERE username=ANY($1::text[])',[created]);check(removed.rowCount===created.length,'only test accounts cleaned up');}}finally{await pool.end();}
  }
  console.log('RITM_WISH_PASS '+checks+' checks');
}
