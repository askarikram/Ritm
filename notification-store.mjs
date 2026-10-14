import { randomUUID } from 'node:crypto';
import { defaultReminderPrefs,validateReminderPrefs,localReminderClock,reminderEvents } from './reminder-domain.mjs';
import { Personal } from './personal-domain.mjs';
import { membershipStatus } from './memberships.mjs';
const bad=(message,status=400)=>Object.assign(Error(message),{status});
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const premium=(row,now)=>membershipStatus(row,now.getTime()).tier==='premium';
export function notificationCandidates(Core,row,prefs,now=new Date()){
 const clock=localReminderClock(prefs.timeZone,now);
 const payments=reminderEvents(Core,row.plan_json,prefs,now).filter(e=>{
  const date=Core.addDays(e.originalDate,-prefs.lead);
  return date<clock.date||date===clock.date&&clock.time>=prefs.time;
 });
 const personal=row.personal_state&&premium(row,now)?Personal.dueEvents(row.personal_state,now):[];
 return [...payments,...personal];
}
const snapshot=(event,prefs,plan)=>({
 type:event.type,title:event.title,itemId:event.itemId||event.id,date:event.originalDate||event.date,
 time:event.type==='payment'?prefs.time:event.time,lead:event.type==='payment'?prefs.lead:0,
 ...(event.type==='payment'?{amount:event.amount,currency:plan.currency}:{})
});
const json=row=>({id:row.id,...row.payload,createdAt:new Date(Number(row.created_at)).toISOString(),readAt:row.read_at==null?null:new Date(Number(row.read_at)).toISOString(),resolvedAt:row.resolved_at==null?null:new Date(Number(row.resolved_at)).toISOString()});
export function createNotificationService({pool,Core}){
 async function initialize(client=pool){
  await client.query("CREATE TABLE IF NOT EXISTS ritm_notifications(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES ritm_users(id) ON DELETE CASCADE,cause_key TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('payment','task','habit')),payload JSONB NOT NULL,created_at BIGINT NOT NULL,read_at BIGINT,resolved_at BIGINT,UNIQUE(user_id,cause_key))");
  await client.query('CREATE INDEX IF NOT EXISTS ritm_notifications_recent ON ritm_notifications(user_id,created_at DESC,id DESC)');
 }
 async function record(userId,event,prefs,plan,now=new Date()){
  const row=(await pool.query("INSERT INTO ritm_notifications(id,user_id,cause_key,kind,payload,created_at) VALUES($1,$2,$3,$4,$5::jsonb,$6) ON CONFLICT(user_id,cause_key) DO UPDATE SET cause_key=EXCLUDED.cause_key RETURNING *",[randomUUID(),userId,event.key,event.type,JSON.stringify(snapshot(event,prefs,plan)),now.getTime()])).rows[0];
  return json(row);
 }
 async function source(userId){
  const row=(await pool.query('SELECT p.plan_json,l.state AS personal_state,r.prefs,m.lifetime,m.expires_at FROM ritm_plans p LEFT JOIN ritm_personal l ON l.user_id=p.user_id LEFT JOIN ritm_reminder_prefs r ON r.user_id=p.user_id LEFT JOIN ritm_memberships m ON m.user_id=p.user_id WHERE p.user_id=$1',[userId])).rows[0];
  if(!row)throw bad('Аккаунт не найден.',401);return row;
 }
 async function sync(userId,row,now){
  const prefs=row.prefs?validateReminderPrefs(row.prefs):defaultReminderPrefs();
  if(prefs.inApp){
   const events=notificationCandidates(Core,row,prefs,now),values=events.map(e=>({id:randomUUID(),cause_key:e.key,kind:e.type,payload:snapshot(e,prefs,row.plan_json)}));
   if(values.length)await pool.query("INSERT INTO ritm_notifications(id,user_id,cause_key,kind,payload,created_at) SELECT x.id,$1,x.cause_key,x.kind,x.payload,$3 FROM jsonb_to_recordset($2::jsonb) AS x(id UUID,cause_key TEXT,kind TEXT,payload JSONB) ON CONFLICT(user_id,cause_key) DO NOTHING",[userId,JSON.stringify(values),now.getTime()]);
  }
  const unread=(await pool.query("SELECT id,kind,payload FROM ritm_notifications WHERE user_id=$1 AND read_at IS NULL AND (kind='payment' OR $2)",[userId,premium(row,now)])).rows;
  const clock=localReminderClock(prefs.timeZone,now);
  const resolved=unread.filter(n=>{
   const p=n.payload;
   if(n.kind==='payment'){const item=row.plan_json.items.find(i=>i.id===p.itemId&&i.type==='payment');return !item||!!row.plan_json.done[p.itemId+'@'+p.date]||!Core.dates(item,p.date,p.date).length||item.repeat==='monthly'&&p.date<clock.date.slice(0,7)+'-01';}
   const state=row.personal_state;if(!state)return true;
   if(n.kind==='task'){const task=state.tasks.find(t=>t.id===p.itemId);return !task||task.done||task.date!==p.date||task.time!==p.time;}
   const habit=state.habits.find(h=>h.id===p.itemId);
   return !habit||habit.time!==p.time||p.date<habit.date||habit.repeat==='once'&&p.date!==habit.date||!!state.checks[p.itemId+'@'+p.date];
  }).map(n=>n.id);
  if(resolved.length)await pool.query('UPDATE ritm_notifications SET read_at=COALESCE(read_at,$3),resolved_at=$3 WHERE user_id=$1 AND id=ANY($2::uuid[]) AND read_at IS NULL',[userId,resolved,now.getTime()]);
 }
 async function counts(userId,active){
  const r=(await pool.query("SELECT count(*) AS total,count(*) FILTER(WHERE read_at IS NULL) AS unread FROM ritm_notifications WHERE user_id=$1 AND (kind='payment' OR $2)",[userId,active])).rows[0];
  return {totalCount:Number(r.total),unreadCount:Number(r.unread),readCount:Number(r.total)-Number(r.unread)};
 }
 async function list(userId,options={},now=new Date()){
  const filter=options.filter||'all';if(!['all','unread','read'].includes(filter))throw bad('Неизвестный список уведомлений.');
  let before=null,beforeId=null;
  if(options.cursor){
   const parts=options.cursor.split('.');before=Number(parts[0]);beforeId=parts[1];
   if(parts.length!==2||!Number.isSafeInteger(before)||before<1||!uuid(beforeId))throw bad('Обновите список уведомлений.');
  }
  const row=await source(userId);await sync(userId,row,now);const active=premium(row,now)&&options.scope!=='payments';
  const found=(await pool.query("SELECT * FROM ritm_notifications WHERE user_id=$1 AND (kind='payment' OR $2) AND ($3::bigint IS NULL OR (created_at,id)<($3::bigint,$4::uuid)) AND ($5='all' OR $5='unread' AND read_at IS NULL OR $5='read' AND read_at IS NOT NULL) ORDER BY created_at DESC,id DESC LIMIT 51",[userId,active,before,beforeId,filter])).rows;
  const rows=found.slice(0,50),last=rows.at(-1);
  return {...await counts(userId,active),notifications:rows.map(json),nextCursor:found.length>50?last.created_at+'.'+last.id:null};
 }
 async function get(userId,id,now=new Date()){
  if(!uuid(id))throw bad('Уведомление не найдено.',404);
  const sourceRow=await source(userId);await sync(userId,sourceRow,now);
  const row=(await pool.query("SELECT * FROM ritm_notifications WHERE user_id=$1 AND id=$2 AND (kind='payment' OR $3)",[userId,id,premium(sourceRow,now)])).rows[0];
  if(!row)throw bad('Уведомление не найдено.',404);return {notification:json(row)};
 }
 async function read(userId,data,now=new Date()){
  const row=await source(userId),active=premium(row,now)&&data.scope!=='payments';
  if(data.action==='read_all')await pool.query("UPDATE ritm_notifications SET read_at=COALESCE(read_at,$3) WHERE user_id=$1 AND (kind='payment' OR $2) AND read_at IS NULL",[userId,active,now.getTime()]);
  else{
   if(!uuid(data.id))throw bad('Уведомление не найдено.',404);
   const changed=await pool.query("UPDATE ritm_notifications SET read_at=COALESCE(read_at,$4) WHERE user_id=$1 AND id=$2 AND (kind='payment' OR $3) RETURNING id",[userId,data.id,active,now.getTime()]);
   if(!changed.rowCount)throw bad('Уведомление не найдено.',404);
  }
  return {...await counts(userId,active),readAt:new Date(now.getTime()).toISOString()};
 }
 return {initialize,record,list,get,read};
}
