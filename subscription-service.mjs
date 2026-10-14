import { randomUUID } from 'node:crypto';
export const subscriptionPlans=Object.freeze({
 month:Object.freeze({id:'month',title:'Месяц',amount:99000,months:1,currency:'KZT'}),
 year:Object.freeze({id:'year',title:'Год',amount:990000,months:12,currency:'KZT'})
});
const bad=(message,status=400,code)=>Object.assign(Error(message),{status,...(code?{code}:{})});
const clean=(value,max)=>typeof value==='string'&&value.trim().length>0&&value.trim().length<=max&&!/[\u0000-\u001f\u007f]/.test(value);
const uuid=value=>typeof value==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
// Calendar billing in Kazakhstan: preserve local time and clamp the end of the month.
export function extendSubscription(start,months){
 if(!Number.isSafeInteger(start)||start<0||![1,12].includes(months))throw bad('Некорректный срок.');
 const offset=5*60*60*1000,d=new Date(start+offset),day=d.getUTCDate();
 d.setUTCDate(1);d.setUTCMonth(d.getUTCMonth()+months);
 const end=new Date(d.getTime());end.setUTCMonth(end.getUTCMonth()+1);end.setUTCDate(0);
 d.setUTCDate(Math.min(day,end.getUTCDate()));return d.getTime()-offset;
}
const orderJSON=row=>({
 id:row.id,period:row.period,amount:Number(row.amount),currency:row.currency,status:row.status,
 senderName:row.sender_name,createdAt:new Date(Number(row.created_at)).toISOString(),
 decidedAt:row.decided_at==null?null:new Date(Number(row.decided_at)).toISOString(),
 reason:row.reason||'',recipient:{phone:row.recipient_phone,name:row.recipient_name},
 ...(row.username?{username:row.username,name:row.name}:{})
});
export function createSubscriptionService({pool,memberships}){
 async function transaction(work){
  const client=await pool.connect();
  try{await client.query('BEGIN');const result=await work(client);await client.query('COMMIT');return result;}
  catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
 }
 async function initialize(client=pool){
  await client.query("CREATE TABLE IF NOT EXISTS ritm_payment_settings(id INTEGER PRIMARY KEY CHECK(id=1),phone TEXT NOT NULL,name TEXT NOT NULL,revision INTEGER NOT NULL,updated_at BIGINT NOT NULL)");
  await client.query("CREATE TABLE IF NOT EXISTS ritm_subscription_orders(id UUID PRIMARY KEY,user_id UUID NOT NULL REFERENCES ritm_users(id) ON DELETE CASCADE,period TEXT NOT NULL CHECK(period IN ('month','year')),amount INTEGER NOT NULL CHECK(amount IN (99000,990000)),currency TEXT NOT NULL CHECK(currency='KZT'),recipient_phone TEXT NOT NULL,recipient_name TEXT NOT NULL,sender_name TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected')),created_at BIGINT NOT NULL,decided_at BIGINT,developer_id UUID REFERENCES ritm_users(id) ON DELETE SET NULL,reason TEXT NOT NULL DEFAULT '',CHECK((period='month' AND amount=99000) OR (period='year' AND amount=990000)),CHECK((status='pending' AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL)))");
  await client.query("CREATE UNIQUE INDEX IF NOT EXISTS ritm_subscription_one_pending ON ritm_subscription_orders(user_id) WHERE status='pending'");
  await client.query('CREATE INDEX IF NOT EXISTS ritm_subscription_orders_recent ON ritm_subscription_orders(created_at DESC)');
 }
 const merchant=row=>({ready:Boolean(row?.phone&&row?.name),phone:row?.phone||'',name:row?.name||'',revision:row?.revision||0});
 async function summary(userId){
  const contact=(await pool.query('SELECT phone,name,revision FROM ritm_payment_settings WHERE id=1')).rows[0];
  const orders=(await pool.query('SELECT * FROM ritm_subscription_orders WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 20',[userId])).rows.map(orderJSON);
  return {membership:await memberships.forUser(userId),plans:Object.values(subscriptionPlans),merchant:merchant(contact),orders};
 }
 async function developer(userId){
  if(!(await memberships.forUser(userId)).developer)throw bad('Доступ только для разработчика.',403,'developer_required');
 }
 async function configure(userId,data){
  await developer(userId);
  const phone=typeof data.phone==='string'?data.phone.replace(/[\s()-]/g,''):'';
  if(!/^\+7\d{10}$/.test(phone)||!clean(data.name,100))throw bad('Введите номер Kaspi в формате +7 и имя получателя.');
  if(!Number.isInteger(data.revision)||data.revision<0)throw bad('Обновите реквизиты и повторите.');
  return transaction(async client=>{
   await client.query('SELECT pg_advisory_xact_lock(74691821)');
   const old=(await client.query('SELECT revision FROM ritm_payment_settings WHERE id=1 FOR UPDATE')).rows[0];
   if((old?.revision||0)!==data.revision)throw bad('Реквизиты изменились. Обновите страницу.',409,'settings_conflict');
   const row=(await client.query('INSERT INTO ritm_payment_settings(id,phone,name,revision,updated_at) VALUES(1,$1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET phone=EXCLUDED.phone,name=EXCLUDED.name,revision=EXCLUDED.revision,updated_at=EXCLUDED.updated_at RETURNING phone,name,revision',[phone,data.name.trim(),data.revision+1,Date.now()])).rows[0];
   return {merchant:merchant(row)};
  });
 }
 async function create(userId,data){
  const plan=typeof data.period==='string'&&Object.hasOwn(subscriptionPlans,data.period)?subscriptionPlans[data.period]:null;
  if(!plan)throw bad('Выберите месяц или год.');
  if(!clean(data.senderName,100))throw bad('Укажите имя отправителя перевода.');
  if(!Number.isInteger(data.merchantRevision)||data.merchantRevision<1)throw bad('Обновите реквизиты.',409,'merchant_changed');
  return transaction(async client=>{
   await client.query('SELECT id FROM ritm_users WHERE id=$1 FOR UPDATE',[userId]);
   const membership=await memberships.forUser(userId,Date.now(),client);
   if(membership.lifetime)throw bad('У вас уже пожизненный Premium.',409,'lifetime_premium');
   const pending=(await client.query("SELECT * FROM ritm_subscription_orders WHERE user_id=$1 AND status='pending'",[userId])).rows[0];
   if(pending)return {order:orderJSON(pending)};
   const contact=(await client.query('SELECT phone,name,revision FROM ritm_payment_settings WHERE id=1 FOR SHARE')).rows[0];
   if(!contact?.phone||!contact?.name)throw bad('Реквизиты оплаты пока не добавлены.',409,'payment_unavailable');
   if(contact.revision!==data.merchantRevision)throw bad('Реквизиты изменились. Проверьте их перед переводом.',409,'merchant_changed');
   const row=(await client.query("INSERT INTO ritm_subscription_orders(id,user_id,period,amount,currency,recipient_phone,recipient_name,sender_name,status,created_at) VALUES($1,$2,$3,$4,'KZT',$5,$6,$7,'pending',$8) RETURNING *",[randomUUID(),userId,plan.id,plan.amount,contact.phone,contact.name,data.senderName.trim(),Date.now()])).rows[0];
   return {order:orderJSON(row)};
  });
 }
 async function dashboard(userId){
  await developer(userId);
  const contact=(await pool.query('SELECT phone,name,revision FROM ritm_payment_settings WHERE id=1')).rows[0];
  const rows=(await pool.query("SELECT o.*,u.username,u.name FROM ritm_subscription_orders o JOIN ritm_users u ON u.id=o.user_id ORDER BY (o.status='pending') DESC,o.created_at DESC,o.id LIMIT 100")).rows;
  return {merchant:merchant(contact),orders:rows.map(orderJSON)};
 }
 async function decide(userId,id,data){
  await developer(userId);
  if(!uuid(id)||!['approved','rejected'].includes(data.status))throw bad('Некорректная заявка.');
  if(data.reason!==undefined&&data.reason!==''&&!clean(data.reason,200))throw bad('Причина — до 200 символов.');
  return transaction(async client=>{
   const row=(await client.query('SELECT * FROM ritm_subscription_orders WHERE id=$1 FOR UPDATE',[id])).rows[0];
   if(!row)throw bad('Заявка не найдена.',404);
   if(row.status!=='pending'){
    if(row.status!==data.status)throw bad('Заявка уже обработана.',409,'order_decided');
    return {order:orderJSON(row)};
   }
   await client.query('SELECT id FROM ritm_users WHERE id=$1 FOR UPDATE',[row.user_id]);
   const now=Date.now();
   if(data.status==='approved'){
    const old=(await client.query('SELECT lifetime,expires_at FROM ritm_memberships WHERE user_id=$1 FOR UPDATE',[row.user_id])).rows[0];
    if(!old?.lifetime){
     const start=Math.max(now,Number(old?.expires_at)||0),end=extendSubscription(start,subscriptionPlans[row.period].months);
     await client.query('INSERT INTO ritm_memberships(user_id,lifetime,expires_at,developer) VALUES($1,FALSE,$2,FALSE) ON CONFLICT(user_id) DO UPDATE SET expires_at=EXCLUDED.expires_at',[row.user_id,end]);
    }
   }
   const updated=(await client.query("UPDATE ritm_subscription_orders SET status=$1,decided_at=$2,developer_id=$3,reason=$4 WHERE id=$5 RETURNING *",[data.status,now,userId,data.status==='rejected'?(data.reason||'Перевод не подтверждён.').trim():'',id])).rows[0];
   return {order:orderJSON(updated)};
  });
 }
 return {initialize,summary,configure,create,dashboard,decide,developer};
}
