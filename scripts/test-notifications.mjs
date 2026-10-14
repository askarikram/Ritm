import assert from 'node:assert/strict';
import { randomBytes,createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fixturePool,grantFixturePremium } from './premium-fixture.mjs';
import { createNotificationService,notificationCandidates } from '../notification-store.mjs';
import { createReminderService } from '../reminder-store.mjs';
import { captureBackup,decryptBackup,encryptBackup,backupTables } from '../backup.mjs';
export async function verifyNotifications(base){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_NOTIFICATION_CHECK '+label);};
 const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8'),Core=new Function('return '+html.match(/const Core = (\(\(\) => \{[\s\S]*?\}\)\(\));/)[1])();
 const pool=fixturePool(base),suffix=[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='NotificationPass123',users=['inboxa','inboxb','inboxpremium'].map(p=>({username:p+suffix})),created=[];
 const [a,b,p]=users,day=new Date().toISOString().slice(0,10),prefs={inApp:true,lead:0,time:'00:00',timeZone:'UTC',showAmounts:false};
 const request=async(user,path,method='GET',data,extra={})=>{
  const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{Origin:base}:{}),...(user?{Cookie:user.cookie||'','X-Ritm-User':user.username}:{}),...(data?{'Content-Type':'application/json'}:{}),...extra},body:data?JSON.stringify(data):undefined});
  const cookie=response.headers.get('set-cookie');if(cookie&&user)user.cookie=cookie.split(';')[0];
  return {status:response.status,body:await response.json()};
 };
 try{
  for(const user of users){const r=await request(user,'/api/signup','POST',{username:user.username,password,confirmPassword:password,name:'Проверка уведомлений'});assert.equal(r.status,200);created.push(user.username);user.id=(await pool.query('SELECT id FROM ritm_users WHERE username=$1',[user.username])).rows[0].id;}
  await grantFixturePremium(base,p.username);
  for(const user of users)assert.equal((await request(user,'/api/reminders','PATCH',prefs)).status,200);
  const plan=Core.fresh();plan.items=[
   {id:'today',title:'Аренда',type:'payment',date:day,repeat:'none',amount:850000},
   {id:'past',title:'Интернет',type:'payment',date:Core.addDays(day,-1),repeat:'none',amount:450000},
   {id:'future',title:'Будущий платёж',type:'payment',date:Core.addDays(day,1),repeat:'none',amount:10000},
   {id:'income',title:'Зарплата',type:'income',date:day,repeat:'none',amount:1000000}
  ];
  assert.equal((await request(a,'/api/plan','PUT',{revision:0,plan})).status,200);
  check((await request(null,'/api/notifications')).status===401,'anonymous inbox is denied');
  const first=(await request(a,'/api/notifications')).body;
  check(first.unreadCount===2&&first.notifications.every(n=>!n.readAt&&n.type==='payment'),'only due and overdue arrivals count as unread');
  check(first.notifications.some(n=>n.title==='Аренда'&&n.amount===850000&&n.currency==='KZT'),'notification contains actual reminder and amount');
  check(!(await request(b,'/api/notifications?userId='+a.id)).body.totalCount,'another owner cannot select the first inbox');
  const note=first.notifications.find(n=>n.itemId==='today'),other=first.notifications.find(n=>n.itemId==='past');
  check((await request(a,'/api/notifications/'+note.id)).body.notification.readAt===null&&(await request(a,'/api/notifications')).body.unreadCount===2,'opening list or detail does not bulk mark notifications');
  check((await request(b,'/api/notifications/'+note.id)).status===404&&(await request(b,'/api/notifications/read','POST',{id:note.id})).status===404,'another user cannot read or mark an owned notification');
  check((await request(a,'/api/notifications/read','POST',{id:note.id},{Origin:'https://attacker.invalid'})).status===403,'read receipt requires same origin');
  check((await request(a,'/api/notifications/read','POST',{id:note.id},{'X-Ritm-User':b.username})).status===401,'read receipt is bound to current account');
  check((await request(a,'/api/notifications/read','POST',{id:note.id})).body.unreadCount===1,'reading one notification reduces badge by one');
  const readAt=(await request(a,'/api/notifications/'+note.id)).body.notification.readAt;
  await request(a,'/api/notifications/read','POST',{id:note.id});
  check((await request(a,'/api/notifications/'+note.id)).body.notification.readAt===readAt,'repeat reads preserve original read timestamp');
  const service=createNotificationService({pool,Core}),after=await service.list(a.id);
  check(after.unreadCount===1&&after.notifications.find(n=>n.id===note.id).readAt===readAt,'a new service instance retains read state for another device');
  const again=(await request(a,'/api/notifications')).body;
  check(again.totalCount===2&&new Set(again.notifications.map(n=>n.id)).size===2,'refresh does not recreate read notifications');
  check((await request(a,'/api/notifications?filter=unread')).body.notifications[0].id===other.id&&(await request(a,'/api/notifications?filter=read')).body.notifications[0].id===note.id,'unread and read filters are distinct');
  const curve=createECDH('prime256v1');curve.generateKeys();
  const subscription={endpoint:'https://fcm.googleapis.com/fcm/send/inbox-'+suffix,keys:{p256dh:curve.getPublicKey().toString('base64url'),auth:randomBytes(16).toString('base64url')}};
  await request(a,'/api/push/subscription','POST',subscription);
  const pushed=[],reminders=createReminderService({pool,Core,notifications:service,appOrigin:base,testMode:true,sendNotification:async(s,payload)=>{pushed.push(JSON.parse(payload));return {statusCode:201};}});
  await reminders.initialize(pool);await reminders.dispatch();
  check(pushed.length===1&&pushed[0].notificationId===note.id,'phone push points to the same persisted inbox receipt');
  await reminders.dispatch();check(pushed.length===1&&(await service.list(a.id)).totalCount===2,'multiple deliveries or refreshes do not duplicate inbox records');
  Core.record(plan,Core.currentEvents(plan,'payment',day).find(e=>e.id==='past'),450000,day,day);
  await request(a,'/api/plan','PUT',{revision:1,plan});
  const completed=(await request(a,'/api/notifications')).body;
  check(completed.unreadCount===0&&completed.notifications.find(n=>n.id===other.id).resolvedAt,'completing payment clears stale unread badge and retains history');
  let personal=(await request(p,'/api/personal?timeZone=UTC')).body;
  personal=(await request(p,'/api/personal','POST',{revision:personal.revision,action:'add_task',item:{title:'Документы',date:day,time:'00:00'}})).body;
  personal=(await request(p,'/api/personal','POST',{revision:personal.revision,action:'add_habit',item:{title:'Читать',date:day,time:'00:00',repeat:'daily'}})).body;
  const personalInbox=(await request(p,'/api/notifications')).body;
  check(personalInbox.unreadCount===2&&personalInbox.notifications.some(n=>n.type==='task')&&personalInbox.notifications.some(n=>n.type==='habit'),'premium inbox identifies task and habit arrivals');
  check((await request(p,'/api/notifications?scope=payments')).body.totalCount===0,'developer Basic preview may restrict inbox to finance');
  await pool.query('UPDATE ritm_memberships SET lifetime=FALSE,expires_at=$2 WHERE user_id=$1',[p.id,Date.now()-1]);
  check((await request(p,'/api/notifications?scope=all')).body.totalCount===0&&(await request(p,'/api/notifications/'+personalInbox.notifications[0].id)).status===404,'Basic cannot bypass personal notification restrictions');
  check((await pool.query('SELECT count(*) AS n FROM ritm_notifications WHERE user_id=$1',[p.id])).rows[0].n==='2','expiry preserves personal inbox history');
  await grantFixturePremium(base,p.username);
  check((await request(p,'/api/notifications')).body.totalCount===2,'renewal restores personal notification history');
  const monthPlan=Core.fresh();monthPlan.items=[{id:'monthly',title:'Ежемесячный платёж',type:'payment',date:'2026-10-01',repeat:'monthly',amount:10000}];
  await pool.query('UPDATE ritm_plans SET plan_json=$2::jsonb WHERE user_id=$1',[b.id,JSON.stringify(monthPlan)]);
  await pool.query('UPDATE ritm_reminder_prefs SET prefs=$2::jsonb WHERE user_id=$1',[b.id,JSON.stringify({...prefs,lead:1})]);
  const octEnd=await service.list(b.id,{},new Date('2026-10-31T12:00:00Z'));
  const november=octEnd.notifications.find(n=>n.date==='2026-11-01');
  check(november&&!november.readAt,'advance reminder for next month is not prematurely resolved');
  await service.read(b.id,{id:november.id},new Date('2026-10-31T12:01:00Z'));
  const december=await service.list(b.id,{},new Date('2026-12-01T12:00:00Z'));
  check(december.notifications.some(n=>n.date==='2026-12-01'&&!n.readAt)&&december.notifications.find(n=>n.id===november.id).readAt,'next monthly occurrence has its own read state');
  const early={plan_json:monthPlan};
  check(notificationCandidates(Core,early,{...prefs,lead:1,time:'09:00'},new Date('2026-10-31T08:59:00Z')).length===1&&!notificationCandidates(Core,early,{...prefs,lead:1,time:'09:00'},new Date('2026-10-31T08:59:00Z')).some(n=>n.originalDate==='2026-11-01'),'future reminder is not received before configured time');
  const bulk=Core.fresh();bulk.items=Array.from({length:65},(_,i)=>({id:'many-'+i,title:'Платёж '+i,type:'payment',date:day,repeat:'none',amount:100}));
  await pool.query('UPDATE ritm_plans SET plan_json=$2::jsonb WHERE user_id=$1',[a.id,JSON.stringify(bulk)]);
  const page1=await service.list(a.id),page2=await service.list(a.id,{cursor:page1.nextCursor});
  check(page1.notifications.length===50&&page1.nextCursor&&page2.notifications.length>0&&page2.notifications.every(n=>!page1.notifications.some(a=>a.id===n.id)),'pagination preserves all notifications with equal creation timestamps');
  await service.read(a.id,{action:'read_all'});check((await service.list(a.id)).unreadCount===0,'read all includes unloaded pages');
  const key=randomBytes(32).toString('hex'),backup=decryptBackup(await captureBackup(pool,key),key);
  check(backup.tables.ritm_notifications.some(n=>n.id===note.id&&n.read_at),'encrypted backup includes persisted read receipts');
  const oldTables=Object.fromEntries(Object.keys(backupTables).filter(t=>t!=='ritm_notifications').map(t=>[t,[]]));
  check(decryptBackup(encryptBackup({format:'ritm-full-backup',version:1,createdAt:new Date().toISOString(),tables:oldTables},key),key).tables.ritm_notifications.length===0,'previous eleven-table backups migrate without losing old data');
 }finally{await pool.query('DELETE FROM ritm_users WHERE username=ANY($1::text[])',[created]);await pool.end();}
 console.log('RITM_NOTIFICATION_PASS '+checks);
}
