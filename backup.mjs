import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
export const backupTables={
 ritm_users:['id','username','name','password_hash','salt','created_at'],
 ritm_plans:['user_id','plan_json','revision'],
 ritm_wish_accounts:['user_id','lane','timezone','opened_date'],
 ritm_recovery_codes:['user_id','code_hash'],
 ritm_month_archives:['user_id','month','currency','opening','income','expenses','savings','remaining','source','revision','updated_at'],
 ritm_personal:['user_id','state','revision'],
 ritm_reminder_prefs:['user_id','prefs'],
 ritm_push_keys:['id','public_key','private_key'],
 ritm_memberships:['user_id','lifetime','expires_at','developer'],
 ritm_payment_settings:['id','phone','name','revision','updated_at'],
 ritm_notifications:['id','user_id','cause_key','kind','payload','created_at','read_at','resolved_at'],
 ritm_subscription_orders:['id','user_id','period','amount','currency','recipient_phone','recipient_name','sender_name','status','created_at','decided_at','developer_id','reason']
};
const ephemeral=new Set(['ritm_sessions','ritm_push_subscriptions','ritm_push_deliveries','ritm_rate_limits']);
const limit=64*1024*1024;
function keyBytes(key){
 if(typeof key!=='string'||!/^[a-f0-9]{64}$/i.test(key))throw Object.assign(Error('Настройте отдельный 256-битный ключ резервных копий.'),{status:503});
 return Buffer.from(key,'hex');
}
export function encryptBackup(snapshot,key){
 const plain=Buffer.from(JSON.stringify(snapshot));if(plain.length>limit)throw Error('Backup exceeds size limit');
 const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',keyBytes(key),iv);cipher.setAAD(Buffer.from('ritm-full-backup:v1'));
 const body=Buffer.concat([cipher.update(gzipSync(plain)),cipher.final()]);
 return {format:'ritm-encrypted-backup',version:1,createdAt:snapshot.createdAt,iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:body.toString('base64')};
}
export function decryptBackup(envelope,key){
 if(envelope?.format!=='ritm-encrypted-backup'||envelope.version!==1||typeof envelope.data!=='string'||envelope.data.length>limit*2)throw Error('Invalid backup envelope');
 const iv=Buffer.from(envelope.iv||'','base64'),tag=Buffer.from(envelope.tag||'','base64');
 if(iv.length!==12||tag.length!==16)throw Error('Invalid backup authentication');
 const cipher=createDecipheriv('aes-256-gcm',keyBytes(key),iv);cipher.setAAD(Buffer.from('ritm-full-backup:v1'));cipher.setAuthTag(tag);
 const compressed=Buffer.concat([cipher.update(Buffer.from(envelope.data,'base64')),cipher.final()]);
 const snapshot=JSON.parse(gunzipSync(compressed,{maxOutputLength:limit}).toString('utf8'));
 // Earlier releases contain eight or nine permanent tables.
 if(snapshot?.format==='ritm-full-backup'&&snapshot.version===1&&snapshot.tables&&!Object.hasOwn(snapshot.tables,'ritm_memberships'))snapshot.tables.ritm_memberships=[];
 if(snapshot?.format==='ritm-full-backup'&&snapshot.version===1&&snapshot.tables)for(const table of ['ritm_payment_settings','ritm_subscription_orders','ritm_notifications'])if(!Object.hasOwn(snapshot.tables,table))snapshot.tables[table]=[];
 if(snapshot?.format!=='ritm-full-backup'||snapshot.version!==1||!snapshot.tables||Object.keys(snapshot.tables).sort().join(',')!==Object.keys(backupTables).sort().join(','))throw Error('Invalid backup tables');
 for(const [table,columns] of Object.entries(backupTables)){
  const rows=snapshot.tables[table];
  if(!Array.isArray(rows)||rows.length>100000||rows.some(row=>!row||Object.keys(row).sort().join(',')!==columns.slice().sort().join(',')))throw Error('Invalid backup rows');
 }
 return snapshot;
}
export async function captureBackup(pool,key){
 keyBytes(key);const client=await pool.connect();
 try{
  await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
  const found=(await client.query("SELECT table_name FROM information_schema.tables WHERE table_schema=current_schema() AND table_name LIKE 'ritm_%' AND table_type='BASE TABLE'")).rows;
  if(found.some(row=>!Object.hasOwn(backupTables,row.table_name)&&!ephemeral.has(row.table_name)))throw Error('Unknown application table; update backup coverage');
  const snapshot={format:'ritm-full-backup',version:1,createdAt:new Date().toISOString(),tables:{}};
  for(const [table,columns] of Object.entries(backupTables))snapshot.tables[table]=(await client.query('SELECT '+columns.map(c=>'"'+c+'"').join(',')+' FROM "'+table+'" ORDER BY 1')).rows;
  await client.query('COMMIT');
  const encrypted=encryptBackup(snapshot,key),verified=decryptBackup(encrypted,key);
  for(const table of Object.keys(backupTables))if(verified.tables[table].length!==snapshot.tables[table].length)throw Error('Backup round-trip failed');
  return encrypted;
 }catch(error){try{await client.query('ROLLBACK');}catch{}throw error;}finally{client.release();}
}
export async function restoreBackup(client,snapshot){
 await client.query('BEGIN');
 try{
  await client.query('LOCK TABLE '+Object.keys(backupTables).map(t=>'"'+t+'"').join(',')+' IN ACCESS EXCLUSIVE MODE');
  for(const table of Object.keys(backupTables)){
   if(table!=='ritm_push_keys'&&Number((await client.query('SELECT count(*) AS n FROM "'+table+'"')).rows[0].n)!==0)throw Error('Restore target is not empty');
  }
  for(const [table,columns] of Object.entries(backupTables))for(const row of snapshot.tables[table]){
   await client.query('INSERT INTO "'+table+'"('+columns.map(c=>'"'+c+'"').join(',')+') VALUES('+columns.map((_,i)=>'$'+(i+1)).join(',')+')'+(table==='ritm_push_keys'?' ON CONFLICT(id) DO UPDATE SET public_key=EXCLUDED.public_key,private_key=EXCLUDED.private_key':''),columns.map(c=>row[c]));
  }
  for(const table of Object.keys(backupTables))if(Number((await client.query('SELECT count(*) AS n FROM "'+table+'"')).rows[0].n)!==snapshot.tables[table].length)throw Error('Restored row count mismatch');
  await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
}
