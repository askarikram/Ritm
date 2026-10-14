import assert from 'node:assert/strict';
import { randomBytes, randomUUID, scryptSync } from 'node:crypto';
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { createRateLimiter, validNewPassword, validLoginPassword } from '../security.mjs';
import { createMembershipService, membershipStatus } from '../memberships.mjs';
import { backupTables, captureBackup, decryptBackup, encryptBackup, restoreBackup } from '../backup.mjs';
export async function verifySecurity(base){
 let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_SECURITY_CHECK '+label);};
 const source=readFileSync(new URL('../server.js',import.meta.url),'utf8'),begin=source.indexOf('const Core = (() => {'),end=source.indexOf('\n})();',begin)+6;
 const C=new Function(source.slice(begin,end)+';return Core;')(),plan=C.fresh();
 plan.items=Array.from({length:500},(_,i)=>({id:'ancient-'+i,title:'Old recurring item',amount:100,date:'1000-01-01',type:'payment',repeat:'monthly'}));C.validate(plan);
 const started=performance.now(),overview=C.monthOverview(plan,'2026-10-13');
 check(overview.payments===50000n&&performance.now()-started<1000,'500 old anchors are counted correctly without iterating through historical months');
 check(C.dates({repeat:'weekly',date:'1900-01-01'},'2026-10-01','2026-10-31').length>=4,'old weekly repeats still occur beyond the former iteration cutoff');
 check(validLoginPassword('OldPass123')&&!validNewPassword('OldPass123'),'existing short passwords remain valid only for login');
 check(validNewPassword('Тихий вечер и ясные цели 2026!'),'new passwords allow Unicode phrases and punctuation');
 for(const value of ['password1234','123456789012','AAAAAAAAAAAA'])check(!validNewPassword(value),'common or repeated passwords rejected');
 const url=new URL(process.env.DATABASE_URL);for(const opt of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])url.searchParams.delete(opt);
 const pool=new pg.Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},max:5}),nonce=randomBytes(8).toString('hex'),schema='ritm_restore_'+nonce;
 const username='legacy'+[...randomBytes(8)].map(x=>String.fromCharCode(97+x%26)).join(''),owner=randomUUID(),salt=randomBytes(16).toString('hex'),oldPassword='OldPass123';
 let created=false,schemaCreated=false;
 check(membershipStatus(null).tier==='basic','no membership defaults to basic');
 check(membershipStatus({lifetime:true,expires_at:null,developer:true}).developer===true,'developer lifetime membership stays premium');
 check(membershipStatus({lifetime:false,expires_at:Date.now()-1,developer:false}).tier==='basic','expired premium is not treated as active');
 const request=async(path,method='GET',body,headers={})=>{const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{Origin:base,'Content-Type':'application/json'}:{}),...headers},body:body?JSON.stringify(body):undefined});return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};};
 try{
  let time=Date.now();const a=createRateLimiter(pool,{windowMs:60000,now:()=>time}),b=createRateLimiter(pool,{windowMs:60000,now:()=>time});
  await a.initialize();const attempts=await Promise.allSettled(Array.from({length:20},(_,i)=>(i%2?a:b).consume('security-fixture:'+nonce,5)));
  check(attempts.filter(x=>x.status==='fulfilled').length===5&&attempts.filter(x=>x.status==='rejected').every(x=>x.reason.status===429),'parallel limiter instances atomically share a five-attempt budget');
  const restarted=createRateLimiter(pool,{windowMs:60000,now:()=>time});
  await assert.rejects(restarted.consume('security-fixture:'+nonce,5),e=>e.status===429&&e.retryAfter>0);check(true,'a fresh limiter preserves exhausted budgets and retry timing');
  time+=60001;await restarted.consume('security-fixture:'+nonce,5);check(true,'budget reopens after its window expires');
  const key=randomBytes(32).toString('hex'),sample={format:'ritm-full-backup',version:1,createdAt:new Date().toISOString(),tables:Object.fromEntries(Object.keys(backupTables).map(t=>[t,[]]))};
  const encrypted=encryptBackup(sample,key);assert.deepEqual(decryptBackup(encrypted,key),sample);check(!JSON.stringify(encrypted).includes('ritm_users'),'backup contents are encrypted and authenticated');
  assert.throws(()=>decryptBackup(encrypted,randomBytes(32).toString('hex')));assert.throws(()=>decryptBackup({...encrypted,data:Buffer.from('tampered').toString('base64')},key));check(true,'wrong keys and changed backup bytes are rejected');
  check((await request('/api/maintenance/backup','POST',{}, {Authorization:'Bearer invalid'})).status===401,'anonymous database backup access denied');
  check((await request('/api/membership')).status===401,'anonymous membership reads denied');
  check((await request('/api/signup','POST',{username:'askar',name:'Not the developer',password:'StrongFixturePass123',confirmPassword:'StrongFixturePass123',membership:{tier:'premium',developer:true}})).status===403,'reserved developer login cannot be claimed by a new signup');
  check((await request('/api/signup','POST',{username,name:'Legacy fixture',password:oldPassword,confirmPassword:oldPassword})).status===400,'short passwords rejected for new registrations');
  const hash=scryptSync(oldPassword,salt,64,{N:32768,r:8,p:3,maxmem:64*1024*1024}).toString('hex');
  await pool.query('INSERT INTO ritm_users(id,username,name,password_hash,salt,created_at) VALUES($1,$2,$3,$4,$5,$6)',[owner,username,'Legacy fixture',hash,salt,Date.now()]);created=true;
  await pool.query('INSERT INTO ritm_plans(user_id,plan_json,revision) VALUES($1,$2::jsonb,0)',[owner,JSON.stringify(C.fresh())]);
  const login=await request('/api/login','POST',{username,password:oldPassword});check(login.status===200,'legacy password still signs in');
  check(login.body.user.membership.tier==='basic'&&!login.body.user.membership.developer,'regular users do not receive developer membership');
  check((await request('/api/membership?username=askar','GET',undefined,{Cookie:login.cookie})).body.membership.tier==='basic','URL account selector cannot read developer membership');
  const newPassword='Тихий вечер и ясные цели 2026!',headers={Cookie:login.cookie,'X-Ritm-User':username};
  check((await request('/api/password','POST',{currentPassword:oldPassword,newPassword,confirmPassword:newPassword},headers)).status===200,'password changes accept a Unicode phrase');
  check((await request('/api/login','POST',{username,password:newPassword})).status===200,'Unicode phrase signs in successfully');
  const emptyTables=Object.fromEntries(Object.keys(backupTables).filter(t=>t!=='ritm_memberships').map(t=>[t,[]]));
  const oldBackup=encryptBackup({format:'ritm-full-backup',version:1,createdAt:new Date().toISOString(),tables:emptyTables},key);
  check(decryptBackup(oldBackup,key).tables.ritm_memberships.length===0,'older eight-table encrypted backups remain recoverable');
  const snapshot=decryptBackup(await captureBackup(pool,key),key);check(Object.keys(snapshot.tables).length===Object.keys(backupTables).length&&snapshot.tables.ritm_users.some(r=>r.id===owner),'complete backup includes every permanent application table, including membership rights');
  await pool.query('CREATE SCHEMA "'+schema+'"');schemaCreated=true;
  for(const table of Object.keys(backupTables))await pool.query('CREATE TABLE "'+schema+'"."'+table+'" (LIKE public."'+table+'" INCLUDING ALL)');
  for(const table of Object.keys(backupTables).filter(t=>backupTables[t].includes('user_id')))await pool.query('ALTER TABLE "'+schema+'"."'+table+'" ADD FOREIGN KEY(user_id) REFERENCES "'+schema+'"."ritm_users"(id)');
  const client=await pool.connect();
  try{
   await client.query('SET search_path TO "'+schema+'"');
   await client.query('INSERT INTO ritm_push_keys(id,public_key,private_key) VALUES(1,$1,$2)',['initial-public','initial-private']);
   await restoreBackup(client,snapshot);
   for(const table of Object.keys(backupTables)){
    const actual=(await client.query('SELECT '+backupTables[table].map(c=>'"'+c+'"').join(',')+' FROM "'+table+'" ORDER BY 1')).rows;
    assert.deepEqual(JSON.parse(JSON.stringify(actual)),JSON.parse(JSON.stringify(snapshot.tables[table])));
   }
   check(true,'encrypted full backup restores every row exactly into a disposable empty schema');
   const fixtureOwner=randomUUID();await client.query('INSERT INTO ritm_users(id,username,name,password_hash,salt,created_at) VALUES($1,$2,$3,$4,$5,$6)',[fixtureOwner,'askar','Developer fixture','unused','unused',Date.now()]);
   const memberService=createMembershipService({pool:client});await memberService.initialize(client);
   const developer=await memberService.forUser(fixtureOwner);check(developer.tier==='premium'&&developer.lifetime&&developer.developer&&developer.expiresAt===null,'askar receives persisted lifetime premium bound to his account id');
   check((await memberService.forUser(owner)).tier==='basic','developer grant does not promote other accounts');
   await memberService.initialize(client);check((await client.query('SELECT count(*) AS n FROM ritm_memberships WHERE user_id=$1',[fixtureOwner])).rows[0].n==='1','repeated startup does not duplicate or shorten the lifetime grant');
   await assert.rejects(restoreBackup(client,snapshot),/not empty/);check(true,'restore refuses populated targets');
   await client.query('SET search_path TO public');
  }finally{client.release();}
 }finally{
  if(schemaCreated)await pool.query('DROP SCHEMA "'+schema+'" CASCADE');
  if(created)await pool.query('DELETE FROM ritm_users WHERE id=$1',[owner]);await pool.end();
 }
 console.log('RITM_SECURITY_PASSED '+checks);
}
