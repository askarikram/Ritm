/*
Ритм: личные финансовые планы. Бесплатное размещение: Render Free + Neon Free.
Node.js 24; npm install; npm start.
DATABASE_URL — секретная строка подключения Neon (только переменная окружения).
NODE_ENV=production. Render задаёт PORT и RENDER_EXTERNAL_URL автоматически.
APP_ORIGIN можно задать для собственного HTTPS-домена.
Данные хранятся в PostgreSQL, постоянный диск Render не требуется.
*/
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { derivePassword, validLoginPassword, validNewPassword, createRateLimiter } from './security.mjs';
import pg from 'pg';
import { wishDay, wishForDay } from './daily-wishes.mjs';
import { appIcons } from './app-icons.mjs';
import { createArchiveService } from './archive-service.mjs';
import { createNotificationService } from './notification-store.mjs';
import { createReminderService } from './reminder-store.mjs';
import { verifySchedulerToken } from './scheduler-auth.mjs';
import { createPersonalService } from './personal-service.mjs';
import { captureBackup } from './backup.mjs';
import { createMembershipService, developerUsername } from './memberships.mjs';
import { createSubscriptionService } from './subscription-service.mjs';
const Core = (() => {
  const iso = d => d.toISOString().slice(0,10);
  const parse = s => new Date(s + 'T12:00:00Z');
  const today = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
  const addDays = (s,n) => {const d=parse(s);d.setUTCDate(d.getUTCDate()+n);return iso(d);};
  const days = (a,b) => Math.round((parse(b)-parse(a))/86400000);
  const month = (s,n) => {
    const d=parse(s), y=d.getUTCFullYear(), m=d.getUTCMonth()+n;
    const last=new Date(Date.UTC(y,m+1,0,12)).getUTCDate();
    return iso(new Date(Date.UTC(y,m,Math.min(d.getUTCDate(),last),12)));
  };
  const monthStart = date => date.slice(0,7)+'-01';
  const monthEnd = date => addDays(month(monthStart(date),1),-1);
  const forecastEnd = date => monthEnd(month(date,1));
  const cyclePeriod = (item,now) => {
    if(item.repeat==='monthly')return {start:monthStart(now),end:monthEnd(now)};
    if(item.repeat==='yearly')return {start:now.slice(0,4)+'-01-01',end:now.slice(0,4)+'-12-31'};
    if(item.repeat==='weekly'){const start=addDays(now,-((parse(now).getUTCDay()+6)%7));return {start,end:addDays(start,6)};}
    return {start:item.date,end:item.date};
  };
  const validDate = s => typeof s==='string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(parse(s)) && iso(parse(s))===s;
  const id = () => typeof crypto!=='undefined' && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36)+Math.random().toString(36).slice(2);
  const fresh = () => ({version:1,balance:0,daily:0,currency:'KZT',items:[],goals:[],done:{},ledger:[]});
  const reserved = s => s.goals.reduce((a,g)=>a+g.saved,0);
  const available = s => s.balance-reserved(s);
  const dates = (item,from,to) => {
    if(item.repeat==='none') return item.date>=from&&item.date<=to?[item.date]:[];
    if(from>to||item.date>to)return [];
    const out=[],step=item.repeat==='yearly'?12:1;
    const distance=(Number(from.slice(0,4))-Number(item.date.slice(0,4)))*12+Number(from.slice(5,7))-Number(item.date.slice(5,7));
    const first=item.repeat==='weekly'?Math.max(0,Math.ceil(days(item.date,from)/7)):Math.max(0,Math.floor(distance/step)-1);
    // Jump directly to the requested interval; old anchors do not add work.
    for(let n=first,count=0;count<4000;n++,count++){
      const date=item.repeat==='weekly'?addDays(item.date,n*7):month(item.date,n*step);
      if(date>to) break;
      if(date>=from) out.push(date);
    }
    return out;
  };
  const pendingEvent = (s,item,now=today()) => {
    const period=cyclePeriod(item,now);
    const date=item.date>period.end?item.date:dates(item,period.start,period.end).find(date=>!s.done[item.id+'@'+date]);
    if(!date||s.done[item.id+'@'+date])return null;
    return {...item,date,originalDate:date,key:item.id+'@'+date,overdue:date<now};
  };
  const currentEvents = (s,type,now=today()) => s.items.filter(item=>item.type===type).map(item=>pendingEvent(s,item,now)).filter(Boolean).sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title,'ru')||a.id.localeCompare(b.id));
  const pastEvents = (s,type,now=today()) => {
    const events=[];
    for(const item of s.items.filter(item=>item.type===type&&['weekly','yearly'].includes(item.repeat))){
      const period=cyclePeriod(item,now);
      for(const date of dates(item,item.date,addDays(period.start,-1))){
        const key=item.id+'@'+date;
        if(!s.done[key])events.push({...item,date,originalDate:date,key,overdue:true});
      }
    }
    return events.sort((a,b)=>a.date.localeCompare(b.date)||a.title.localeCompare(b.title));
  };
  const scheduled = (s,from,to,overdue=false,cycleDate=from) => {
    const out=[];
    s.items.forEach(item=>{
      const start=overdue?item.date:from,cycleStart=monthStart(cycleDate);
      const first=item.repeat==='monthly'&&start<cycleStart?cycleStart:start;
      dates(item,first,to).forEach(date=>{
      const key=item.id+'@'+date;
      if(s.done[key]) return;
      if(date<from && (!overdue || item.type==='income')) return;
      out.push({...item,date:date<from?from:date,originalDate:date,key,overdue:date<from});
      });
    });
    return out.sort((a,b)=>a.date.localeCompare(b.date)||a.type.localeCompare(b.type));
  };
  const goalPlan = (g,now=today()) => {
    const remaining=Math.max(0,g.target-g.saved);
    if(!remaining) return {remaining:0,amount:0,end:now,slots:[],complete:true};
    let slots=[];
    const limit=g.mode==='deadline'?g.deadline:month(now,1200);
    for(let n=0;n<1200;n++){
      const date=month(g.start,n);
      if(date>limit) break;
      if(date>=now && !(g.done||[]).includes(date)) slots.push(date);
      if(g.mode==='monthly' && slots.length>=Math.ceil(remaining/g.monthly)) break;
    }
    if(g.mode==='deadline' && !slots.length && g.deadline>=now && !(g.done||[]).includes(g.deadline)) slots=[g.deadline];
    const amount=g.mode==='deadline'?(slots.length?Math.ceil(remaining/slots.length/100)*100:0):g.monthly;
    return {remaining,amount,end:slots.length?slots[slots.length-1]:null,slots,complete:false,expired:g.mode==='deadline'&&g.deadline<now};
  };
  const savings = (s,from,to) => {
    const out=[];
    s.goals.forEach(g=>{
      const p=goalPlan(g,from);let left=p.remaining;
      p.slots.forEach(date=>{
        const amount=Math.min(left,p.amount);left-=amount;
        if(date<=to && amount>0) out.push({id:g.id,title:g.title,type:'saving',date,originalDate:date,amount,key:'goal:'+g.id+'@'+date});
      });
    });
    return out;
  };
  const forecast = (s,now=today(),until=forecastEnd(now),withGoals=true) => {
    if(until<now) return {rows:[],events:[],firstGap:null,min:available(s)};
    const events=[...scheduled(s,now,until,true),...(withGoals?savings(s,now,until):[])];
    const grouped=new Map();
    events.forEach(e=>{if(!grouped.has(e.date))grouped.set(e.date,[]);grouped.get(e.date).push(e);});
    let balance=available(s);const rows=[];let firstGap=null,min=balance;
    for(let date=now;date<=until;date=addDays(date,1)){
      const es=grouped.get(date)||[];
      const income=es.filter(e=>e.type==='income').reduce((a,e)=>a+e.amount,0);
      const payments=es.filter(e=>e.type==='payment').reduce((a,e)=>a+e.amount,0);
      const saving=es.filter(e=>e.type==='saving').reduce((a,e)=>a+e.amount,0);
      balance+=income-payments-saving-s.daily;
      const row={date,income,payments,saving,daily:s.daily,balance,events:es};
      rows.push(row);min=Math.min(min,balance);
      if(balance<0&&!firstGap) firstGap=row;
    }
    return {rows,events,firstGap,min};
  };
  const monthlyForecast = (s,now=today()) => {
    const end=monthEnd(now),result=forecast(s,now,end),availableEnd=result.rows.at(-1).balance;
    const plannedSaving=result.rows.reduce((sum,row)=>sum+row.saving,0);
    return {...result,end,availableEnd,accountEnd:availableEnd+reserved(s)+plannedSaving};
  };
  const goalMonthAmount = (g,date=today()) => {
    const key=date.slice(0,7),from=monthStart(date),to=monthEnd(date);
    if(Object.hasOwn(g.monthPlans||{},key))return g.monthPlans[key];
    const done=(g.done||[]).filter(date=>date>=from&&date<=to);
    if(g.mode==='monthly'&&done.length)return Math.min(g.monthly,g.target);
    const p=goalPlan({...g,done:(g.done||[]).filter(date=>date<from)},from);
    if(!p.slots.some(date=>date>=from&&date<=to))return 0;
    return Math.min(p.amount,p.remaining);
  };
  const freezeGoalMonth = (g,date=today()) => {
    const key=date.slice(0,7);
    if(!Object.hasOwn(g.monthPlans||{},key))g.monthPlans={...(g.monthPlans||{}),[key]:goalMonthAmount(g,date)};
  };
  const monthOpening = (s,date=today()) => {
    const start=monthStart(date),key=date.slice(0,7);
    return Object.hasOwn(s.monthBalances||{},key)?BigInt(s.monthBalances[key]):s.ledger.filter(e=>e.date>=start).reduce((balance,e)=>balance+(e.type==='income'?-BigInt(e.amount):BigInt(e.amount)),BigInt(s.balance));
  };
  const monthOverview = (s,date=today()) => {
    const start=monthStart(date),end=monthEnd(date),key=date.slice(0,7),count=days(start,end)+1;
    let income=0n,payments=0n;
    for(const item of s.items){
      const amount=BigInt(item.amount)*BigInt(dates(item,start,end).length);
      if(item.type==='income')income+=amount;else payments+=amount;
    }
    const savings=s.goals.reduce((sum,g)=>sum+BigInt(goalMonthAmount(g,date)),0n);
    const includeDaily=s.monthlyIncludeDaily!==false,daily=includeDaily?BigInt(s.daily)*BigInt(count):0n,expenses=payments+daily;
    const specified=Object.hasOwn(s.monthBalances||{},key);
    const opening=monthOpening(s,date);
    return {start,end,count,income,payments,daily,expenses,savings,opening,remaining:opening+income-expenses-savings,includeDaily,specified};
  };
  const freezeMonthBalance = (s,date=today()) => {
    const key=date.slice(0,7);
    if(!Object.hasOwn(s.monthBalances||{},key)){
      const opening=Number(monthOpening(s,date));
      if(Number.isSafeInteger(opening)&&Math.abs(opening)<=100000000000000)s.monthBalances={...(s.monthBalances||{}),[key]:opening};
    }
  };
  const allowance = (s,now=today()) => {
    const es=scheduled(s,now,addDays(now,365),true);
    const next=es.find(e=>e.type==='income');
    const count=next?Math.max(1,days(now,next.date)):days(now,monthEnd(now))+1;
    const last=addDays(now,count-1);
    const obligations=scheduled(s,now,last,true).filter(e=>e.type==='payment').reduce((a,e)=>a+e.amount,0);
    const goals=savings(s,now,last).reduce((a,e)=>a+e.amount,0);
    const left=available(s)-obligations-goals;
    return {next,count,last,obligations,goals,left,perDay:Math.max(0,Math.floor(left/count/100)*100),need:Math.max(0,s.daily*count-left)};
  };
  const record = (s,event,amount,date,now=today()) => {
    if(s.done[event.key]) throw Error('Это событие уже подтверждено.');
    if(!Number.isSafeInteger(amount)||amount<=0) throw Error('Введите сумму больше нуля.');
    if(!validDate(date)||date>now) throw Error('Дата фактической операции не может быть в будущем.');
    freezeMonthBalance(s,now);
    s.balance+=event.type==='income'?amount:-amount;
    const entry={id:id(),key:event.key,itemId:event.id,title:event.title,type:event.type,amount,date,plannedDate:event.originalDate};
    s.ledger.unshift(entry);s.done[event.key]=true;
    return entry;
  };
  const validate = s => {
    if(!s||s.version!==1||!Array.isArray(s.items)||!Array.isArray(s.goals)||!Array.isArray(s.ledger)||!s.done||typeof s.done!=='object'||Array.isArray(s.done)) throw Error('Неподдерживаемый файл плана.');
    const money=(v,negative=false)=>Number.isSafeInteger(v)&&Math.abs(v)<=100000000000000&&(negative||v>=0);
    if(!money(s.balance,true)||!money(s.daily)||!['KZT','USD'].includes(s.currency))throw Error('Некорректный баланс или валюта.');
    const monthMap=(map,label)=>{
      if(map===undefined)return;
      if(!map||typeof map!=='object'||Array.isArray(map)||Object.keys(map).length>2400||Object.entries(map).some(([key,value])=>!/^\d{4}-(0[1-9]|1[0-2])$/.test(key)||!money(value,label==='balance')))throw Error('Некорректные суммы по месяцам.');
    };
    monthMap(s.monthBalances,'balance');
    if(s.monthlyIncludeDaily!==undefined&&typeof s.monthlyIncludeDaily!=='boolean')throw Error('Некорректная настройка месячных расходов.');
    const name=v=>typeof v==='string'&&v.trim().length>0&&v.length<=120;
    const ident=v=>typeof v==='string'&&/^[a-zA-Z0-9-]{1,80}$/.test(v);
    if(s.items.length>500||s.goals.length>100||s.ledger.length>10000)throw Error('В файле слишком много записей.');
    s.items.forEach(i=>{if(!ident(i.id)||!name(i.title)||!money(i.amount)||i.amount<=0||!validDate(i.date)||!['income','payment'].includes(i.type)||!['none','monthly','weekly','yearly'].includes(i.repeat))throw Error('Некорректное поступление или платёж.');});
    s.goals.forEach(g=>{monthMap(g.monthPlans,'goal');if(!ident(g.id)||!name(g.title)||!money(g.target)||!g.target||!money(g.saved)||!money(g.monthly)||!validDate(g.start)||!['deadline','monthly'].includes(g.mode)||(g.mode==='deadline'&&!validDate(g.deadline))||(g.mode==='monthly'&&g.monthly<=0)||!Array.isArray(g.done)||!g.done.every(validDate))throw Error('Некорректная цель накопления.');});
    if(new Set([...s.items.map(i=>i.id),...s.goals.map(g=>g.id)]).size!==s.items.length+s.goals.length)throw Error('Повторяющиеся записи в файле.');
    s.ledger.forEach(e=>{if(!ident(e.id)||!ident(e.itemId)||!name(e.title)||!money(e.amount)||!e.amount||!validDate(e.date)||!validDate(e.plannedDate)||e.key!==e.itemId+'@'+e.plannedDate||!['income','payment'].includes(e.type))throw Error('Некорректная история операций.');});
    const marks=new Set(s.ledger.map(e=>e.key));
    if(marks.size!==s.ledger.length||Object.keys(s.done).some(k=>!marks.has(k)||s.done[k]!==true)||s.ledger.some(e=>!s.done[e.key]))throw Error('Некорректные отметки платежей.');
    return s;
  };
  return {iso,parse,today,addDays,days,month,monthStart,monthEnd,forecastEnd,cyclePeriod,validDate,id,fresh,reserved,available,dates,pendingEvent,currentEvents,pastEvents,scheduled,goalPlan,savings,forecast,monthlyForecast,goalMonthAmount,freezeGoalMonth,monthOpening,monthOverview,freezeMonthBalance,allowance,record,validate};
})();
const validUsername = value => typeof value==='string' && /^[a-z]{1,32}$/.test(value);
const validPassword = validLoginPassword;
const validName = value => typeof value==='string' && value.trim().length>=1 && value.trim().length<=80 && !/[\u0000-\u001f\u007f]/.test(value);
const HTML=readFileSync(new URL('./public/index.html',import.meta.url),'utf8');
const release=process.env.RENDER_GIT_COMMIT||createHash('sha256').update(HTML).digest('hex').slice(0,16);
const fonts=new Map(['latin','cyrillic','cyrillic-ext'].map(subset=>[
  '/assets/fonts/golos-text-'+subset+'.woff2',
  readFileSync(new URL('./node_modules/@fontsource-variable/golos-text/files/golos-text-'+subset+'-wght-normal.woff2',import.meta.url))
]));

const scriptHash=createHash('sha256').update(HTML.match(/<script>([\s\S]*?)<\/script>/)[1]).digest('base64');
const publicFiles=new Map([
  ['/manifest.webmanifest','manifest.webmanifest','application/manifest+json; charset=utf-8'],
  ['/sw.js','sw.js','text/javascript; charset=utf-8'],
  ['/icons/icon.svg','icons/icon.svg','image/svg+xml'],
  ['/help','help.html','text/html; charset=utf-8'],
  ['/privacy','privacy.html','text/html; charset=utf-8'],
  ['/offline.html','offline.html','text/html; charset=utf-8']
].map(([path,file,type])=>[path,{type,body:readFileSync(new URL('./public/'+file,import.meta.url),'utf8').replaceAll('__RITM_RELEASE__',release)}]));
const production=process.env.NODE_ENV==='production';
const port=Number(process.env.PORT||3000),host=process.env.HOST||(production?'0.0.0.0':'127.0.0.1');
if(!Number.isInteger(port)||port<1||port>65535)throw Error('Некорректный PORT.');
const configuredOrigin=process.env.APP_ORIGIN||process.env.RENDER_EXTERNAL_URL;
if(production&&!configuredOrigin)throw Error('Для публикации нужен HTTPS-адрес приложения (APP_ORIGIN или RENDER_EXTERNAL_URL).');
const appOrigin=new URL(configuredOrigin||'http://127.0.0.1:'+port).origin;
if(production&&!appOrigin.startsWith('https://'))throw Error('В production адрес приложения должен использовать HTTPS.');
if(!process.env.DATABASE_URL)throw Error('Задайте DATABASE_URL — строку подключения к Neon.');
const databaseURL=new URL(process.env.DATABASE_URL);
if(!['postgres:','postgresql:'].includes(databaseURL.protocol))throw Error('DATABASE_URL должен вести в PostgreSQL.');
// Не позволяем параметрам URL отключать проверку сертификата TLS.
for(const option of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])databaseURL.searchParams.delete(option);
const pool=new pg.Pool({connectionString:databaseURL.toString(),ssl:{rejectUnauthorized:true},enableChannelBinding:true,max:5,idleTimeoutMillis:30000,connectionTimeoutMillis:15000,query_timeout:15000,statement_timeout:15000});
pool.on('error',error=>console.error('Соединение с базой:',error.code||error.name));
const archives=createArchiveService({pool,Core});
const personal=createPersonalService({pool});
const memberships=createMembershipService({pool});
const subscriptions=createSubscriptionService({pool,memberships});
const notifications=createNotificationService({pool,Core});
const reminders=createReminderService({pool,Core,notifications,appOrigin,testMode:process.env.NODE_ENV==='test'});
const cookieName=production?'__Host-ritm-session':'ritm-session',ttl=30*24*60*60*1000,shortTTL=12*60*60*1000;
const sql={
  byName:'SELECT id,username,name,password_hash,salt FROM ritm_users WHERE username=$1',
  addUser:'INSERT INTO ritm_users(id,username,name,password_hash,salt,created_at) VALUES($1,$2,$3,$4,$5,$6)',
  addPlan:'INSERT INTO ritm_plans(user_id,plan_json,revision) VALUES($1,$2::jsonb,0)',
  getPlan:'SELECT plan_json,revision,EXISTS(SELECT 1 FROM ritm_recovery_codes r WHERE r.user_id=p.user_id) AS recovery_enabled FROM ritm_plans p WHERE user_id=$1',
  updatePlan:'UPDATE ritm_plans SET plan_json=$1::jsonb,revision=revision+1 WHERE user_id=$2 AND revision=$3 RETURNING revision',
  sessionUser:'SELECT u.id,u.username,u.name,s.expires_at,s.remember FROM ritm_sessions s JOIN ritm_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>$2',
  addSession:'INSERT INTO ritm_sessions(token_hash,user_id,expires_at,remember) VALUES($1,$2,$3,$4)',
  renewSession:'UPDATE ritm_sessions SET expires_at=GREATEST(expires_at,$1) WHERE token_hash=$2',
  deleteSession:'DELETE FROM ritm_sessions WHERE token_hash=$1',
  purgeSessions:'DELETE FROM ritm_sessions WHERE expires_at<=$1'
};
async function transaction(work){
  const client=await pool.connect();
  try{await client.query('BEGIN');const value=await work(client);await client.query('COMMIT');return value;}
  catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}
  finally{client.release();}
}
async function initialize(){
  let developerGranted=false;
  await transaction(async client=>{
    await client.query('CREATE TABLE IF NOT EXISTS ritm_users(id UUID PRIMARY KEY,username VARCHAR(32) NOT NULL CONSTRAINT ritm_users_username_key UNIQUE,name VARCHAR(80) NOT NULL,password_hash TEXT NOT NULL,salt TEXT NOT NULL,created_at BIGINT NOT NULL)');
    await client.query('CREATE TABLE IF NOT EXISTS ritm_plans(user_id UUID PRIMARY KEY REFERENCES ritm_users(id) ON DELETE CASCADE,plan_json JSONB NOT NULL,revision INTEGER NOT NULL DEFAULT 0)');
    await client.query('CREATE TABLE IF NOT EXISTS ritm_sessions(token_hash TEXT PRIMARY KEY,user_id UUID NOT NULL REFERENCES ritm_users(id) ON DELETE CASCADE,expires_at BIGINT NOT NULL,remember BOOLEAN NOT NULL DEFAULT TRUE)');
    await client.query('CREATE INDEX IF NOT EXISTS ritm_sessions_expiry ON ritm_sessions(expires_at)');
    await client.query('CREATE TABLE IF NOT EXISTS ritm_wish_accounts(user_id UUID PRIMARY KEY REFERENCES ritm_users(id) ON DELETE CASCADE,lane SMALLINT NOT NULL CHECK(lane BETWEEN 0 AND 4),timezone TEXT NOT NULL,opened_date DATE NOT NULL)');
    await client.query('CREATE TABLE IF NOT EXISTS ritm_recovery_codes(user_id UUID PRIMARY KEY REFERENCES ritm_users(id) ON DELETE CASCADE,code_hash TEXT NOT NULL)');
    await archives.initialize(client);await personal.initialize(client);await reminders.initialize(client);await limiter.initialize(client);developerGranted=await memberships.initialize(client);await subscriptions.initialize(client);await notifications.initialize(client);
  });
  if(developerGranted)console.log('RITM_DEVELOPER_PREMIUM_GRANTED');
}
const derive=derivePassword,hashToken=t=>createHash('sha256').update(t).digest('hex');
const dummySalt=randomBytes(16).toString('hex');
const newRecoveryCode=()=>randomBytes(16).toString('hex').toUpperCase().match(/.{4}/g).join('-');
const normalizeRecovery=value=>typeof value==='string'&&value.length<=80?value.replace(/[\s-]/g,'').toUpperCase():'';
const recoveryHash=code=>hashToken(normalizeRecovery(code));
async function checkCurrentPassword(userId,password){
  if(!validPassword(password))fail(400,'Введите текущий пароль.');
  const row=(await pool.query('SELECT password_hash,salt FROM ritm_users WHERE id=$1',[userId])).rows[0];
  if(!row)fail(401,'Войдите в аккаунт.','not_signed_in');
  const candidate=await derive(password,row.salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}),expected=Buffer.from(row.password_hash,'hex');
  if(expected.length!==candidate.length||!timingSafeEqual(expected,candidate))fail(401,'Текущий пароль указан неверно.','wrong_password');
  return row;
}
function fail(status,message,code){const error=Error(message);error.status=status;if(code)error.code=code;throw error;}
const limiter=createRateLimiter(pool);
const rateLimit=(key,limit)=>limiter.consume(key,limit);
let nextSessionCleanup=0;
async function maybePurgeSessions(){
  const now=Date.now();if(now<nextSessionCleanup)return;nextSessionCleanup=now+6*60*60*1000;
  try{await pool.query(sql.purgeSessions,[now]);}catch(error){nextSessionCleanup=now+60000;console.error('Очистка сессий:',error.code||error.name);}
}
function token(req){
  const match=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(cookieName+'='));
  const value=match?.slice(cookieName.length+1)||'';return /^[A-Za-z0-9_-]{43}$/.test(value)?value:null;
}
function cookie(value,remember,maxAge=ttl){
  return cookieName+'='+value+'; HttpOnly; SameSite=Strict; Path=/'+(remember?'; Max-Age='+Math.floor(maxAge/1000):'')+(production?'; Secure':'');
}
async function findSession(req){
  const value=token(req);if(!value)return null;
  return (await pool.query(sql.sessionUser,[hashToken(value),Date.now()])).rows[0]||null;
}
async function requireUser(req,res){
  const user=await findSession(req);if(!user)fail(401,'Войдите в аккаунт.','not_signed_in');
  const expected=req.headers['x-ritm-user'];
  if(expected&&expected!==user.username)fail(401,'Аккаунт изменился в другой вкладке.','account_changed');
  if(req.method!=='GET'&&!expected)fail(403,'Не указан текущий аккаунт.');
  if(user.remember&&Number(user.expires_at)-Date.now()<ttl/2){
    await pool.query(sql.renewSession,[Date.now()+ttl,hashToken(token(req))]);res.setHeader('Set-Cookie',cookie(token(req),true));
  }
  return user;
}
async function setSession(req,res,userId,remember=true){
  const old=token(req),value=randomBytes(32).toString('base64url'),life=remember?ttl:shortTTL;
  await transaction(async client=>{
    if(old)await client.query(sql.deleteSession,[hashToken(old)]);
    await client.query(sql.addSession,[hashToken(value),userId,Date.now()+life,remember]);
  });
  res.setHeader('Set-Cookie',cookie(value,remember,life));
  await maybePurgeSessions();
}
async function clearSession(req,res){
  const value=token(req);if(value)await pool.query(sql.deleteSession,[hashToken(value)]);
  res.setHeader('Set-Cookie',cookieName+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(production?'; Secure':''));
}
async function sessionPayload(user){
  const row=(await pool.query(sql.getPlan,[user.id])).rows[0];
  if(!row)throw Error('Отсутствует план аккаунта.');
  await archives.capture(user.id,row.plan_json,await reminders.accountDay(user.id));
  return {user:{username:user.username,name:user.name,membership:await memberships.forUser(user.id)},plan:row.plan_json,revision:row.revision,recoveryEnabled:row.recovery_enabled};
}
async function readJSON(req){
  if(!String(req.headers['content-type']||'').toLowerCase().startsWith('application/json'))fail(415,'Нужен JSON-запрос.');
  const parts=[];let size=0;for await(const part of req){size+=part.length;if(size>262144)fail(413,'План слишком большой.');parts.push(part);}
  try{const data=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!data||typeof data!=='object'||Array.isArray(data))fail(400,'Некорректный запрос.');return data;}
  catch(error){if(error.status)throw error;fail(400,'Некорректный JSON.');}
}
function headers(res){
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'none'; script-src 'sha256-"+scriptHash+"'; style-src 'unsafe-inline'; font-src 'self'; connect-src 'self'; img-src 'self' data:; worker-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
  if(production)res.setHeader('Strict-Transport-Security','max-age=31536000');
}
function send(res,status,data){res.writeHead(status,{'Content-Type':'application/json; charset=utf-8'});res.end(JSON.stringify(data));}
async function handle(req,res){
  headers(res);
  try{
    const url=new URL(req.url,appOrigin);
    if(['GET','HEAD'].includes(req.method)&&(url.pathname==='/'||url.pathname==='/index.html')){res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(req.method==='HEAD'?undefined:HTML);return;}
    if(req.method==='GET'&&url.pathname==='/healthz'){send(res,200,{ok:true,version:release});return;}
    if(['GET','HEAD'].includes(req.method)&&fonts.has(url.pathname)){const font=fonts.get(url.pathname);res.writeHead(200,{'Content-Type':'font/woff2','Content-Length':font.length,'Cache-Control':'public, max-age=31536000, immutable'});res.end(req.method==='HEAD'?undefined:font);return;}
    if(['GET','HEAD'].includes(req.method)&&publicFiles.has(url.pathname)){
      const file=publicFiles.get(url.pathname);
      if(url.pathname==='/sw.js')res.setHeader('Service-Worker-Allowed','/');
      res.writeHead(200,{'Content-Type':file.type,'Cache-Control':url.pathname==='/sw.js'?'no-cache':'public, max-age=0, must-revalidate'});
      const body=url.pathname==='/sw.js'?readFileSync(new URL('./public/sw.js',import.meta.url),'utf8').replaceAll('__RITM_RELEASE__',release):file.body;
      res.end(req.method==='HEAD'?undefined:body);return;
    }
    if(['GET','HEAD'].includes(req.method)&&appIcons.has(url.pathname)){
      const icon=appIcons.get(url.pathname);res.writeHead(200,{'Content-Type':'image/png','Content-Length':icon.length,'Cache-Control':'public, max-age=86400'});
      res.end(req.method==='HEAD'?undefined:icon);return;
    }
    if(req.method==='GET'&&url.pathname==='/robots.txt'){res.writeHead(200,{'Content-Type':'text/plain; charset=utf-8'});res.end('User-agent: *\nDisallow: /api/\nSitemap: '+appOrigin+'/sitemap.xml\n');return;}
    if(req.method==='GET'&&url.pathname==='/sitemap.xml'){res.writeHead(200,{'Content-Type':'application/xml; charset=utf-8'});res.end('<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">'+['/','/help','/privacy'].map(path=>'<url><loc>'+appOrigin+path+'</loc></url>').join('')+'</urlset>');return;}
    if(req.method==='GET'&&url.pathname==='/favicon.ico'){res.writeHead(204);res.end();return;}
    if(!url.pathname.startsWith('/api/'))fail(404,'Страница не найдена.');
    if(req.method==='POST'&&url.pathname==='/api/maintenance/backup'){
      try{await verifySchedulerToken((req.headers.authorization||'').replace(/^Bearer /,''),appOrigin,{workflow:'backup-daily'});}catch{fail(401,'Недействительная подпись резервного копирования.');}
      await rateLimit('maintenance-backup',4);
      send(res,200,await captureBackup(pool,process.env.RITM_BACKUP_KEY));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/reminders/dispatch'){
      try{await verifySchedulerToken((req.headers.authorization||'').replace(/^Bearer /,''),appOrigin);}catch{fail(401,'Недействительная подпись планировщика.');}
      send(res,200,await reminders.dispatch());return;
    }
    if(['POST','PUT','DELETE','PATCH'].includes(req.method)&&req.headers.origin!==appOrigin)fail(403,'Запрос пришёл с другого адреса.');
    if(req.method==='GET'&&url.pathname==='/api/membership'){
      const user=await requireUser(req,res);send(res,200,{membership:await memberships.forUser(user.id)});return;
    }
    if(req.method==='GET'&&url.pathname==='/api/subscription'){
      const user=await requireUser(req,res);send(res,200,await subscriptions.summary(user.id));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/subscription/orders'){
      const user=await requireUser(req,res);await rateLimit('subscription:'+user.id,30);
      send(res,200,await subscriptions.create(user.id,await readJSON(req)));return;
    }
    if(['GET','PATCH'].includes(req.method)&&url.pathname==='/api/developer/subscription'){
      const user=await requireUser(req,res);await subscriptions.developer(user.id);
      if(req.method==='GET'){send(res,200,await subscriptions.dashboard(user.id));return;}
      await rateLimit('merchant:'+user.id,10);const data=await readJSON(req);
      await checkCurrentPassword(user.id,data.currentPassword);
      send(res,200,await subscriptions.configure(user.id,data));return;
    }
    if(req.method==='POST'&&url.pathname.startsWith('/api/developer/orders/')){
      const user=await requireUser(req,res);await subscriptions.developer(user.id);await rateLimit('orders-admin:'+user.id,100);
      send(res,200,await subscriptions.decide(user.id,url.pathname.slice('/api/developer/orders/'.length),await readJSON(req)));return;
    }
    if(req.method==='GET'&&url.pathname==='/api/me'){send(res,200,await sessionPayload(await requireUser(req,res)));return;}
    if(req.method==='POST'&&['/api/signup','/api/login'].includes(url.pathname)){
      // Ограничение на логин действует и при смене IP. Лимит сервера выше,
      // поскольку у хостинга несколько посетителей могут иметь общий адрес прокси.
      await rateLimit('auth-address:'+(req.socket.remoteAddress||'unknown'),240);
      const data=await readJSON(req),username=data.username,password=data.password;
      if(!validUsername(username))fail(400,'Логин — только маленькие латинские буквы, от 1 до 32, без цифр и пробелов.');
      if(!validPassword(password))fail(400,'Введите пароль от 8 до 128 символов.');
      if(url.pathname==='/api/signup'&&!validNewPassword(password))fail(400,'Новый пароль — от 12 до 128 символов. Выберите длинную фразу или случайный пароль.');
      await rateLimit('auth-user:'+username,10);
      let user=(await pool.query(sql.byName,[username])).rows[0],recoveryCode;
      if(url.pathname==='/api/signup'){
        if(data.confirmPassword!==password)fail(400,'Пароли не совпадают. Проверьте оба поля.');
        if(!validName(data.name))fail(400,'Введите имя от 1 до 80 символов.');
        if(user)fail(409,'Этот логин уже занят. Выберите другой.');
        if(username===developerUsername)fail(403,'Этот логин зарезервирован для разработчика.');
        const salt=randomBytes(16).toString('hex'),key=await derive(password,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
        user={id:randomUUID(),username,name:data.name.trim()};recoveryCode=newRecoveryCode();
        try{await transaction(async client=>{
          await client.query(sql.addUser,[user.id,username,user.name,key.toString('hex'),salt,Date.now()]);
          await client.query(sql.addPlan,[user.id,JSON.stringify(Core.fresh())]);
          await client.query('INSERT INTO ritm_recovery_codes(user_id,code_hash) VALUES($1,$2)',[user.id,recoveryHash(recoveryCode)]);
        });}
        catch(error){if(error.code==='23505'&&error.constraint==='ritm_users_username_key')fail(409,'Этот логин уже занят. Выберите другой.');throw error;}
      }else{
        const candidate=await derive(password,user?.salt||dummySalt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
        const expected=user?Buffer.from(user.password_hash,'hex'):Buffer.alloc(64);
        if(!user||expected.length!==candidate.length||!timingSafeEqual(expected,candidate))fail(401,'Неверный логин или пароль.');
      }
      await setSession(req,res,user.id,data.remember!==false);send(res,200,{...await sessionPayload(user),...(recoveryCode?{recoveryCode}:{})});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/recovery-code'){
      const user=await requireUser(req,res);await rateLimit('recovery-create:'+user.id,10);
      const data=await readJSON(req),record=await checkCurrentPassword(user.id,data.currentPassword),code=newRecoveryCode();
      await transaction(async client=>{
        const current=(await client.query('SELECT password_hash,salt FROM ritm_users WHERE id=$1 FOR UPDATE',[user.id])).rows[0];
        if(!current||current.password_hash!==record.password_hash||current.salt!==record.salt)fail(409,'Пароль изменён. Войдите снова.');
        await client.query('INSERT INTO ritm_recovery_codes(user_id,code_hash) VALUES($1,$2) ON CONFLICT(user_id) DO UPDATE SET code_hash=EXCLUDED.code_hash',[user.id,recoveryHash(code)]);
      });
      send(res,200,{recoveryCode:code});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/recover'){
      await rateLimit('recover-address:'+(req.socket.remoteAddress||'unknown'),120);
      const data=await readJSON(req),code=normalizeRecovery(data.recoveryCode);
      if(!validUsername(data.username)||!/^[A-F0-9]{32}$/.test(code))fail(401,'Неверный логин или резервный код.');
      await rateLimit('recover-user:'+data.username,10);
      if(!validNewPassword(data.newPassword))fail(400,'Новый пароль — от 12 до 128 символов. Выберите длинную фразу или случайный пароль.');
      if(data.newPassword!==data.confirmPassword)fail(400,'Пароли не совпадают. Проверьте оба поля.');
      const record=(await pool.query('SELECT u.id,r.code_hash FROM ritm_users u JOIN ritm_recovery_codes r ON r.user_id=u.id WHERE u.username=$1',[data.username])).rows[0];
      const candidate=recoveryHash(code),expected=record?.code_hash||hashToken('no-recovery-code');
      if(!timingSafeEqual(Buffer.from(candidate,'hex'),Buffer.from(expected,'hex'))||!record)fail(401,'Неверный логин или резервный код.');
      const salt=randomBytes(16).toString('hex'),key=await derive(data.newPassword,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}),nextCode=newRecoveryCode();
      const value=randomBytes(32).toString('base64url'),remember=data.remember!==false,life=remember?ttl:shortTTL;
      const user=await transaction(async client=>{
        const locked=(await client.query('SELECT u.id,u.username,u.name,r.code_hash FROM ritm_users u JOIN ritm_recovery_codes r ON r.user_id=u.id WHERE u.id=$1 FOR UPDATE OF u,r',[record.id])).rows[0];
        if(!locked||locked.code_hash!==candidate)fail(401,'Неверный логин или резервный код.');
        await client.query('UPDATE ritm_users SET password_hash=$1,salt=$2 WHERE id=$3',[key.toString('hex'),salt,locked.id]);
        await client.query('UPDATE ritm_recovery_codes SET code_hash=$1 WHERE user_id=$2',[recoveryHash(nextCode),locked.id]);
        await client.query('DELETE FROM ritm_sessions WHERE user_id=$1',[locked.id]);
        await client.query(sql.addSession,[hashToken(value),locked.id,Date.now()+life,remember]);
        return locked;
      });
      res.setHeader('Set-Cookie',cookie(value,remember,life));
      send(res,200,{...await sessionPayload(user),recoveryCode:nextCode});return;
    }
    if(req.method==='DELETE'&&url.pathname==='/api/account'){
      const user=await requireUser(req,res);await rateLimit('delete-user:'+user.id,10);
      const data=await readJSON(req);
      if(data.confirmation!=='УДАЛИТЬ')fail(400,'Введите УДАЛИТЬ для подтверждения.');
      const record=await checkCurrentPassword(user.id,data.currentPassword);
      await transaction(async client=>{
        const result=await client.query('DELETE FROM ritm_users WHERE id=$1 AND password_hash=$2 AND salt=$3',[user.id,record.password_hash,record.salt]);
        if(!result.rowCount)fail(409,'Пароль изменён. Войдите снова.');
      });
      res.setHeader('Set-Cookie',cookieName+'=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0'+(production?'; Secure':''));
      send(res,200,{ok:true});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/logout'){
      await readJSON(req);const user=await findSession(req);
      if(user&&req.headers['x-ritm-user']!==user.username)fail(401,'Аккаунт изменился в другой вкладке.','account_changed');
      await clearSession(req,res);send(res,200,{ok:true});return;
    }

    if(req.method==='PATCH'&&url.pathname==='/api/profile'){
      const user=await requireUser(req,res);await rateLimit('profile-user:'+user.id,60);
      const data=await readJSON(req);
      if(!validName(data.name))fail(400,'Введите имя от 1 до 80 символов.');
      const result=await pool.query('UPDATE ritm_users SET name=$1 WHERE id=$2 RETURNING username,name',[data.name.trim(),user.id]);
      if(!result.rowCount)fail(401,'Войдите в аккаунт.','not_signed_in');
      send(res,200,{user:{...result.rows[0],membership:await memberships.forUser(user.id)}});return;
    }
    if(req.method==='POST'&&url.pathname==='/api/password'){
      const user=await requireUser(req,res);await rateLimit('password-user:'+user.id,10);
      const data=await readJSON(req);
      if(!validPassword(data.currentPassword))fail(400,'Введите текущий пароль.');
      if(!validNewPassword(data.newPassword))fail(400,'Новый пароль — от 12 до 128 символов. Выберите длинную фразу или случайный пароль.');
      if(data.newPassword!==data.confirmPassword)fail(400,'Пароли не совпадают. Проверьте оба поля.');
      const record=(await pool.query('SELECT password_hash,salt FROM ritm_users WHERE id=$1',[user.id])).rows[0];
      if(!record)fail(401,'Войдите в аккаунт.','not_signed_in');
      const candidate=await derive(data.currentPassword,record.salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
      const expected=Buffer.from(record.password_hash,'hex');
      if(expected.length!==candidate.length||!timingSafeEqual(expected,candidate))fail(401,'Текущий пароль указан неверно.','wrong_password');
      const salt=randomBytes(16).toString('hex'),key=await derive(data.newPassword,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024});
      const value=randomBytes(32).toString('base64url'),remember=user.remember,life=remember?ttl:shortTTL;
      const changed=await transaction(async client=>{
        const result=await client.query('UPDATE ritm_users SET password_hash=$1,salt=$2 WHERE id=$3 AND password_hash=$4 AND salt=$5 RETURNING username,name',[key.toString('hex'),salt,user.id,record.password_hash,record.salt]);
        if(!result.rowCount)fail(409,'Пароль уже изменён. Обновите страницу и войдите снова.','password_changed');
        await client.query('DELETE FROM ritm_sessions WHERE user_id=$1',[user.id]);
        await client.query(sql.addSession,[hashToken(value),user.id,Date.now()+life,remember]);
        return result.rows[0];
      });
      res.setHeader('Set-Cookie',cookie(value,remember,life));
      send(res,200,{user:{...changed,membership:await memberships.forUser(user.id)}});return;
    }


    if(['GET','POST'].includes(req.method)&&url.pathname==='/api/wish'){
      const user=await requireUser(req,res);
      if((await memberships.forUser(user.id)).tier!=='premium')fail(403,'Этот раздел доступен в Premium.','premium_required');
      const data=req.method==='POST'?await readJSON(req):null;
      const requestedZone=(data?data.timeZone:url.searchParams.get('timeZone'))||'UTC';
      try{wishDay(requestedZone);}catch(error){fail(400,error.message);}
      if(req.method==='GET'){
        const row=(await pool.query('SELECT lane,timezone,opened_date::text FROM ritm_wish_accounts WHERE user_id=$1',[user.id])).rows[0];
        const day=wishDay(row?.timezone||requestedZone),opened=Boolean(row&&row.opened_date===day.date);
        send(res,200,{...day,opened,...(opened?{text:wishForDay(row.lane,day.date)}:{})});return;
      }
      await rateLimit('wish-user:'+user.id,100);
      const result=await transaction(async client=>{
        // Serialise first-time lane assignments so the first five accounts get different collections.
        await client.query('SELECT pg_advisory_xact_lock(74691820)');
        let row=(await client.query('SELECT lane,timezone,opened_date::text FROM ritm_wish_accounts WHERE user_id=$1',[user.id])).rows[0];
        const day=wishDay(row?.timezone||requestedZone);
        if(!row){
          const lane=(await client.query('SELECT candidate.lane FROM generate_series(0,4) AS candidate(lane) LEFT JOIN ritm_wish_accounts a ON a.lane=candidate.lane GROUP BY candidate.lane ORDER BY count(a.user_id),candidate.lane LIMIT 1')).rows[0].lane;
          row={lane,timezone:requestedZone,opened_date:day.date};
          await client.query('INSERT INTO ritm_wish_accounts(user_id,lane,timezone,opened_date) VALUES($1,$2,$3,$4::date)',[user.id,lane,requestedZone,day.date]);
        }else if(row.opened_date!==day.date){
          await client.query('UPDATE ritm_wish_accounts SET opened_date=$1::date WHERE user_id=$2',[day.date,user.id]);
        }
        return {...day,opened:true,text:wishForDay(row.lane,day.date)};
      });
      send(res,200,result);return;
    }

    if(['GET','POST'].includes(req.method)&&url.pathname==='/api/personal'){
      const user=await requireUser(req,res);
      if((await memberships.forUser(user.id)).tier!=='premium')fail(403,'Этот раздел доступен в Premium.','premium_required');
      if(req.method==='GET')send(res,200,await personal.get(user.id,url.searchParams.get('timeZone')));
      else{await rateLimit('personal:'+user.id,600);send(res,200,await personal.mutate(user.id,await readJSON(req)));}
      return;
    }
    if(['GET','PUT'].includes(req.method)&&url.pathname==='/api/archive'){
      const user=await requireUser(req,res),now=await reminders.accountDay(user.id);
      if(req.method==='GET'){
        const year=Number(url.searchParams.get('year')||now.slice(0,4));
        let result;try{result=await archives.list(user.id,year,now);}catch(error){if(error.status)throw error;if(error.message.startsWith('Выберите'))fail(400,error.message);throw error;}
        send(res,200,result);
      }else{
        await rateLimit('archive:'+user.id,300);const data=await readJSON(req);
        let result;try{result=await archives.save(user.id,data,now);}catch(error){if(error.status)throw error;if(['В архиве','Выберите','Введите','Некорректная'].some(prefix=>error.message.startsWith(prefix)))fail(400,error.message);throw error;}
        send(res,200,{record:result});
      }return;
    }
    if(req.method==='GET'&&url.pathname==='/api/notifications'){
      const user=await requireUser(req,res);send(res,200,await notifications.list(user.id,{filter:url.searchParams.get('filter'),cursor:url.searchParams.get('cursor'),scope:url.searchParams.get('scope')}));return;
    }
    if(req.method==='GET'&&url.pathname.startsWith('/api/notifications/')){
      const user=await requireUser(req,res);send(res,200,await notifications.get(user.id,url.pathname.slice('/api/notifications/'.length)));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/notifications/read'){
      const user=await requireUser(req,res);await rateLimit('notification-read:'+user.id,600);send(res,200,await notifications.read(user.id,await readJSON(req)));return;
    }
    if(['GET','PATCH'].includes(req.method)&&url.pathname==='/api/reminders'){
      const user=await requireUser(req,res);
      send(res,200,req.method==='GET'?await reminders.settings(user.id,url.searchParams.get('timeZone')):await reminders.savePrefs(user.id,await readJSON(req)));return;
    }
    if(['POST','DELETE'].includes(req.method)&&url.pathname==='/api/push/subscription'){
      const user=await requireUser(req,res);await rateLimit('push:'+user.id,100);const data=await readJSON(req);
      send(res,200,req.method==='POST'?await reminders.subscribe(user.id,hashToken(token(req)),data):await reminders.unsubscribe(user.id,data.endpoint));return;
    }
    if(req.method==='POST'&&url.pathname==='/api/push/status'){
      const user=await requireUser(req,res),data=await readJSON(req);
      send(res,200,await reminders.status(user.id,hashToken(token(req)),data.endpoint));return;
    }

    if(req.method==='PUT'&&url.pathname==='/api/plan'){
      const user=await requireUser(req,res);await rateLimit('save-user:'+user.id,600);const data=await readJSON(req);
      if(!Number.isSafeInteger(data.revision)||data.revision<0||data.revision>=2147483647)fail(400,'Некорректная версия плана.');
      try{Core.validate(data.plan);}catch(error){fail(400,error.message);}
      const result=await transaction(async client=>{
        const updated=await client.query(sql.updatePlan,[JSON.stringify(data.plan),user.id,data.revision]);
        if(!updated.rowCount)fail(409,'План уже изменён в другой вкладке.');
        await archives.capture(user.id,data.plan,await reminders.accountDay(user.id,client),client);return updated;
      });
      send(res,200,{revision:result.rows[0].revision});return;
    }
    fail(404,'Запрос не найден.');
  }catch(error){
    if(error.retryAfter&&!res.headersSent)res.setHeader('Retry-After',String(error.retryAfter));
    if(!res.headersSent)send(res,error.status||500,{error:error.status?error.message:'Ошибка сервера. Попробуйте позже.',...(error.status&&error.code?{code:error.code}:{})});else res.end();
    if(!error.status)console.error('Ошибка Ритм:',error.code||error.name);
  }
}
const server=createServer((req,res)=>{void handle(req,res);});
server.requestTimeout=30000;server.headersTimeout=10000;server.maxHeadersCount=60;
async function start(){await initialize();server.listen(port,host,()=>console.log('Ритм: '+appOrigin));}
function stop(){
  const deadline=setTimeout(()=>{server.closeAllConnections();process.exit(1);},10000);deadline.unref();
  server.close(()=>{void pool.end().then(()=>process.exit(0)).catch(()=>process.exit(1));});
}
process.on('SIGTERM',stop);process.on('SIGINT',stop);
start().catch(error=>{console.error('Не удалось запустить Ритм:',error.code||error.name);void pool.end().finally(()=>process.exit(1));});
