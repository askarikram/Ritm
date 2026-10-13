import webpush from 'web-push';
import { createHash } from 'node:crypto';
import { defaultReminderPrefs, validateReminderPrefs, validatePushSubscription, localReminderClock, duePushEvents } from './reminder-domain.mjs';
import { Personal } from './personal-domain.mjs';
const hash=value=>createHash('sha256').update(value).digest('hex');
const bad=(message,status=400)=>Object.assign(Error(message),{status});
export const reminderOwner=userId=>hash('ritm-device:'+userId).slice(0,32);
export function createReminderService({pool,Core,appOrigin,testMode=false,sendNotification=webpush.sendNotification.bind(webpush)}){
  let vapid;
  const eventsFor=(row,prefs,now)=>[...duePushEvents(Core,row.plan_json,prefs,now),...(row.personal_state?Personal.dueEvents(row.personal_state,now):[])];
  async function initialize(client){
    await client.query("CREATE TABLE IF NOT EXISTS ritm_reminder_prefs(user_id UUID PRIMARY KEY REFERENCES ritm_users(id) ON DELETE CASCADE,prefs JSONB NOT NULL)");
    await client.query("CREATE TABLE IF NOT EXISTS ritm_push_keys(id INTEGER PRIMARY KEY CHECK(id=1),public_key TEXT NOT NULL,private_key TEXT NOT NULL)");
    const generated=webpush.generateVAPIDKeys();
    await client.query('INSERT INTO ritm_push_keys(id,public_key,private_key) VALUES(1,$1,$2) ON CONFLICT DO NOTHING',[generated.publicKey,generated.privateKey]);
    const keys=(await client.query('SELECT public_key,private_key FROM ritm_push_keys WHERE id=1')).rows[0];
    vapid={subject:appOrigin.startsWith('https:')?appOrigin:'https://ritm.local',publicKey:keys.public_key,privateKey:keys.private_key};
    await client.query("CREATE TABLE IF NOT EXISTS ritm_push_subscriptions(endpoint TEXT PRIMARY KEY,endpoint_hash TEXT NOT NULL,user_id UUID NOT NULL REFERENCES ritm_users(id) ON DELETE CASCADE,session_hash TEXT NOT NULL REFERENCES ritm_sessions(token_hash) ON DELETE CASCADE,subscription JSONB NOT NULL,created_at BIGINT NOT NULL)");
    await client.query('CREATE INDEX IF NOT EXISTS ritm_push_subscriptions_owner ON ritm_push_subscriptions(user_id)');
    await client.query("CREATE TABLE IF NOT EXISTS ritm_push_deliveries(user_id UUID NOT NULL REFERENCES ritm_users(id) ON DELETE CASCADE,endpoint_hash TEXT NOT NULL,event_key TEXT NOT NULL,notify_date CHAR(10) NOT NULL,lead SMALLINT NOT NULL,state TEXT NOT NULL CHECK(state IN ('sending','sent','failed')),claim_at BIGINT NOT NULL,PRIMARY KEY(user_id,endpoint_hash,event_key,notify_date,lead))");
  }
  async function prefs(userId,zone,client=pool){
    const row=(await client.query('SELECT prefs FROM ritm_reminder_prefs WHERE user_id=$1',[userId])).rows[0];
    if(row)return validateReminderPrefs(row.prefs);
    let result=defaultReminderPrefs(zone);
    try{result=validateReminderPrefs(result);}catch{result=defaultReminderPrefs();}
    return result;
  }
  async function accountDay(userId,client=pool,now=new Date()){
    const p=(await client.query("SELECT COALESCE(r.prefs->>'timeZone',w.timezone,'Asia/Qyzylorda') AS zone FROM ritm_users u LEFT JOIN ritm_reminder_prefs r ON r.user_id=u.id LEFT JOIN ritm_wish_accounts w ON w.user_id=u.id WHERE u.id=$1",[userId])).rows[0];
    return localReminderClock(p?.zone||'Asia/Qyzylorda',now).date;
  }
  async function settings(userId,zone){
    const value=await prefs(userId,zone);
    await pool.query('INSERT INTO ritm_reminder_prefs(user_id,prefs) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[userId,JSON.stringify(value)]);
    return {prefs:await prefs(userId),publicKey:vapid.publicKey,owner:reminderOwner(userId)};
  }
  async function savePrefs(userId,data){
    let p;try{p=validateReminderPrefs(data);}catch(error){throw bad(error.message);}
    await pool.query('INSERT INTO ritm_reminder_prefs(user_id,prefs) VALUES($1,$2::jsonb) ON CONFLICT(user_id) DO UPDATE SET prefs=EXCLUDED.prefs',[userId,JSON.stringify(p)]);
    return {prefs:p};
  }
  async function subscribe(userId,sessionHash,input){
    let subscription;try{subscription=validatePushSubscription(input,{allowLoopback:testMode});}catch(error){throw bad(error.message);}
    const result=await pool.query("INSERT INTO ritm_push_subscriptions(endpoint,endpoint_hash,user_id,session_hash,subscription,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(endpoint) DO UPDATE SET user_id=EXCLUDED.user_id,session_hash=EXCLUDED.session_hash,subscription=EXCLUDED.subscription,created_at=EXCLUDED.created_at WHERE ritm_push_subscriptions.user_id=EXCLUDED.user_id OR NOT EXISTS(SELECT 1 FROM ritm_sessions s WHERE s.token_hash=ritm_push_subscriptions.session_hash AND s.expires_at>$6) RETURNING user_id",[subscription.endpoint,hash(subscription.endpoint),userId,sessionHash,JSON.stringify(subscription),Date.now()]);
    if(!result.rowCount)throw bad('Сначала отключите уведомления для предыдущего аккаунта на этом устройстве.',409);
    return {enabled:true,owner:reminderOwner(userId)};
  }
  async function unsubscribe(userId,endpoint){
    if(typeof endpoint!=='string'||endpoint.length>2048)throw bad('Некорректное устройство.');
    await pool.query('DELETE FROM ritm_push_subscriptions WHERE user_id=$1 AND endpoint=$2',[userId,endpoint]);
    return {enabled:false};
  }
  async function status(userId,sessionHash,endpoint){
    if(typeof endpoint!=='string'||endpoint.length>2048)throw bad('Некорректное устройство.');
    const row=(await pool.query('SELECT 1 FROM ritm_push_subscriptions p JOIN ritm_sessions s ON s.token_hash=p.session_hash WHERE p.user_id=$1 AND p.endpoint=$2 AND p.session_hash=$3 AND s.expires_at>$4',[userId,endpoint,sessionHash,Date.now()])).rows[0];
    return {enabled:!!row,owner:reminderOwner(userId)};
  }
  async function dispatch(now=new Date()){
    const started=Date.now(),counts={sent:0,failed:0,removed:0,skipped:0};
    const rows=(await pool.query('SELECT p.*,r.prefs AS settings FROM ritm_push_subscriptions p JOIN ritm_sessions s ON s.token_hash=p.session_hash LEFT JOIN ritm_reminder_prefs r ON r.user_id=p.user_id WHERE s.expires_at>$1 ORDER BY p.created_at LIMIT 200',[now.getTime()])).rows;
    // Small batches keep both the server request and the free database connection pool bounded.
    let index=0;
    async function worker(){
      while(index<rows.length&&Date.now()-started<20000){
        const row=rows[index++],p=row.settings?validateReminderPrefs(row.settings):defaultReminderPrefs();
        const planRow=(await pool.query('SELECT x.plan_json,l.state AS personal_state FROM ritm_plans x LEFT JOIN ritm_personal l ON l.user_id=x.user_id WHERE x.user_id=$1',[row.user_id])).rows[0];if(!planRow)continue;
        const clock=localReminderClock(p.timeZone,now),events=eventsFor(planRow,p,now);
        for(const event of events){
          if(Date.now()-started>=20000)break;
          const personalEvent=event.type==='task'||event.type==='habit',notifyDate=personalEvent?event.date:clock.date,lead=personalEvent?-1:p.lead;
          const values=[row.user_id,row.endpoint_hash,event.key,notifyDate,lead,now.getTime()];
          const claim=await pool.query("INSERT INTO ritm_push_deliveries(user_id,endpoint_hash,event_key,notify_date,lead,state,claim_at) VALUES($1,$2,$3,$4,$5,'sending',$6) ON CONFLICT(user_id,endpoint_hash,event_key,notify_date,lead) DO UPDATE SET state='sending',claim_at=EXCLUDED.claim_at WHERE ritm_push_deliveries.state='failed' AND ritm_push_deliveries.claim_at<$6-120000 OR ritm_push_deliveries.state='sending' AND ritm_push_deliveries.claim_at<$6-900000 RETURNING state",values);
          if(!claim.rowCount){counts.skipped++;continue;}
          const fresh=(await pool.query('SELECT x.plan_json,l.state AS personal_state FROM ritm_plans x JOIN ritm_push_subscriptions p ON p.user_id=x.user_id JOIN ritm_sessions s ON s.token_hash=p.session_hash LEFT JOIN ritm_personal l ON l.user_id=x.user_id WHERE x.user_id=$1 AND p.endpoint=$2 AND s.expires_at>$3',[row.user_id,row.endpoint,now.getTime()])).rows[0];
          if(!fresh||!eventsFor(fresh,p,now).some(item=>item.key===event.key)){
            await pool.query("UPDATE ritm_push_deliveries SET state='failed' WHERE user_id=$1 AND endpoint_hash=$2 AND event_key=$3 AND notify_date=$4 AND lead=$5",values.slice(0,5));counts.skipped++;continue;
          }
          const when=p.lead===0?'Сегодня':p.lead===1?'Завтра':'Через 3 дня';
          const genericBody=personalEvent?(event.type==='habit'?'Пора выполнить привычку.':'У вас запланирована задача.')+' Откройте Ритм, чтобы посмотреть.':when+' запланирован платёж. Откройте Ритм, чтобы посмотреть.';
          const amount=personalEvent?'':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(event.amount/100)+' '+(fresh.plan_json.currency==='KZT'?'теңге':'$');
          const body=!personalEvent&&p.showAmounts?when+': '+event.title+' — '+amount:genericBody;
          try{
            await sendNotification(row.subscription,JSON.stringify({title:'Ритм · Напоминание',body,genericBody,owner:reminderOwner(row.user_id),tag:hash(event.key+notifyDate+lead).slice(0,24),route:personalEvent?'personal':'payment'}),{vapidDetails:vapid,TTL:21600,timeout:8000});
            await pool.query("UPDATE ritm_push_deliveries SET state='sent' WHERE user_id=$1 AND endpoint_hash=$2 AND event_key=$3 AND notify_date=$4 AND lead=$5",values.slice(0,5));counts.sent++;
          }catch(error){
            if([404,410].includes(error.statusCode)){await pool.query('DELETE FROM ritm_push_subscriptions WHERE user_id=$1 AND endpoint=$2',[row.user_id,row.endpoint]);counts.removed++;}
            await pool.query("UPDATE ritm_push_deliveries SET state='failed' WHERE user_id=$1 AND endpoint_hash=$2 AND event_key=$3 AND notify_date=$4 AND lead=$5",values.slice(0,5));counts.failed++;
          }
        }
      }
    }
    await Promise.all(Array.from({length:Math.min(3,rows.length)},worker));return counts;
  }
  return {initialize,prefs,settings,savePrefs,accountDay,subscribe,unsubscribe,status,dispatch};
}
