import assert from 'node:assert/strict';
import { randomBytes,createHash,generateKeyPairSync,sign,createECDH } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:https';
import pg from 'pg';
import ece from 'http_ece';
import { archiveMonthKeys,validateArchiveEntry,createArchiveService } from '../archive-service.mjs';
import { defaultReminderPrefs,validateReminderPrefs,localReminderClock,duePushEvents,validatePushSubscription } from '../reminder-domain.mjs';
import { createReminderService } from '../reminder-store.mjs';
import { verifySchedulerToken } from '../scheduler-auth.mjs';
const extract=()=>{const html=readFileSync(new URL('../public/index.html',import.meta.url),'utf8');return new Function('return '+html.match(/const Core = (\(\(\) => \{[\s\S]*?\}\)\(\));/)[1])();};
export async function verifyFeatures(base){
 let checks=0;const check=(condition,label)=>{assert.ok(condition,label);checks++;console.log('RITM_FEATURE_CHECK '+label);};
 const Core=extract(),date=localReminderClock('UTC').date;
 check(archiveMonthKeys(2026,'2026-10-13').length===9&&archiveMonthKeys(2026,'2026-10-13').at(-1)==='2026-01','archive begins January 2026 and excludes current and future months');
 assert.throws(()=>archiveMonthKeys(2025,date));check(true,'earlier archive years rejected');
 const entry={month:'2026-01',currency:'KZT',opening:'100000',income:'1000000',expenses:'700000',savings:'100000',revision:null};
 check(validateArchiveEntry(entry,date).remaining==='300000','archive computes opening plus income minus expenses minus goals');
 for(const change of [{month:date.slice(0,7)},{income:'-1'},{opening:'100000000000001'},{currency:'EUR'},{revision:-1}])assert.throws(()=>validateArchiveEntry({...entry,...change},date));
 check(true,'archive rejects future dates, invalid amounts, currency and revision');
 const prefs={...defaultReminderPrefs('UTC'),time:'09:00'};
 const plan=Core.fresh();plan.items=[{id:'rent',title:'Аренда',type:'payment',amount:850000,date:Core.addDays(date,1),repeat:'monthly'},{id:'salary',title:'Зарплата',type:'income',amount:1500000,date:Core.addDays(date,1),repeat:'monthly'}];
 check(duePushEvents(Core,plan,prefs,new Date(date+'T08:59:00Z')).length===0&&duePushEvents(Core,plan,prefs,new Date(date+'T09:00:00Z')).length===1,'push follows local time and payment lead');
 plan.done['rent@'+Core.addDays(date,1)]=true;check(duePushEvents(Core,plan,prefs,new Date(date+'T09:01:00Z')).length===0,'paid event no longer generates a reminder');plan.done={};
 check(localReminderClock('Asia/Qyzylorda',new Date('2026-10-13T23:30:00Z')).date==='2026-10-14','notification date respects time zone rollover');
 assert.throws(()=>validateReminderPrefs({...prefs,lead:2}));assert.throws(()=>validateReminderPrefs({...prefs,timeZone:'Invalid/Zone'}));check(true,'reminder preference validation');
 const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048}),jwk={...publicKey.export({format:'jwk'}),kid:'fixture'};
 const seconds=Math.floor(Date.now()/1000),claims={iss:'https://token.actions.githubusercontent.com',aud:base,repository:'askarikram/Ritm',repository_id:'1415973682',ref:'refs/heads/main',workflow_ref:'askarikram/Ritm/.github/workflows/reminder-delivery.yml@refs/heads/main',event_name:'schedule',iat:seconds,exp:seconds+300};
 const jwt=(value,header={alg:'RS256',kid:'fixture'})=>{const start=Buffer.from(JSON.stringify(header)).toString('base64url')+'.'+Buffer.from(JSON.stringify(value)).toString('base64url');return start+'.'+sign('RSA-SHA256',Buffer.from(start),privateKey).toString('base64url');};
 check((await verifySchedulerToken(jwt(claims),base,{keys:[jwk]})).repository==='askarikram/Ritm','signed scheduler identity accepted');
 for(const change of [{aud:'https://other.invalid'},{repository_id:'1'},{ref:'refs/heads/other'},{exp:seconds-1},{workflow_ref:'askarikram/Ritm/.github/workflows/other.yml@refs/heads/main'}])await assert.rejects(verifySchedulerToken(jwt({...claims,...change}),base,{keys:[jwk]}));
 await assert.rejects(verifySchedulerToken(jwt(claims,{alg:'none',kid:'fixture'}),base,{keys:[jwk]}));check(true,'scheduler rejects foreign workflows, stale tokens and algorithm substitution');
 const database=new URL(process.env.DATABASE_URL);for(const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])database.searchParams.delete(key);
 const pool=new pg.Pool({connectionString:database.toString(),ssl:{rejectUnauthorized:true},max:3});
 const suffix=[...randomBytes(8)].map(n=>String.fromCharCode(97+n%26)).join(''),password='FeaturePassword123',a={username:'featurea'+suffix},b={username:'featureb'+suffix};
 const accounts=[],request=async(account,path,method='GET',data,headers={})=>{
 const response=await fetch(base+path,{method,headers:{...(method!=='GET'?{Origin:base}:{}),...(account?.cookie?{Cookie:account.cookie,'X-Ritm-User':account.username}:{}),...(data?{'Content-Type':'application/json'}:{}),...headers},body:data?JSON.stringify(data):undefined});
 const cookie=response.headers.get('set-cookie');if(cookie&&account)account.cookie=cookie.split(';')[0];
 return {status:response.status,body:await response.json()};
 };
 let transport;
 try{
 for(const account of [a,b]){const reply=await request(account,'/api/signup','POST',{username:account.username,name:'Тест архива',password,confirmPassword:password});check(reply.status===200,'disposable feature account created');accounts.push(account.username);}
 check((await request(null,'/api/archive?year=2026')).status===401,'anonymous archive read denied');
 const before=await request(a,'/api/me');
 let saved=await request(a,'/api/archive','PUT',entry);check(saved.status===200&&saved.body.record.remaining==='300000','manual historical month saved');
 check((await request(a,'/api/archive','PUT',entry)).status===409,'concurrent initial fill cannot overwrite another month entry');
 const edited=await request(a,'/api/archive','PUT',{...entry,income:'1200000',revision:saved.body.record.revision});check(edited.status===200&&edited.body.record.remaining==='500000','owned historical entry can be edited');
 check((await request(a,'/api/archive','PUT',{...entry,revision:0})).status===409,'stale edit rejected with revision lease');
 check((await request(b,'/api/archive?year=2026')).body.records.length===0,'archive records isolated per account');
 check((await request(a,'/api/archive','PUT',entry,{'X-Ritm-User':b.username})).status===401,'archive rejects account mismatch');
 check((await request(a,'/api/archive','PUT',entry,{Origin:'https://other.invalid'})).status===403,'archive write protected from cross-origin request');
 const after=await request(a,'/api/me');assert.deepEqual(after.body.plan,before.body.plan);check(after.body.revision===before.body.revision,'manual archive leaves live balance, history and plan revision untouched');
 const user=(await pool.query('SELECT id FROM ritm_users WHERE username=$1',[a.username])).rows[0];
 const archive=createArchiveService({pool,Core});
 const auto=Core.fresh();auto.balance=200000;auto.items=[{id:'january',title:'Доход',type:'income',amount:700000,date:'2026-01-10',repeat:'none'}];
 await archive.capture(user.id,auto,'2026-01-15');
 check((await archive.list(user.id,2026,date)).records.find(r=>r.month==='2026-01').income==='1200000','automatic snapshot never overwrites a manual month');
 const setting=await request(a,'/api/reminders?timeZone=UTC');check(setting.status===200&&setting.body.prefs.showAmounts===false&&setting.body.publicKey.length>60&&!JSON.stringify(setting.body).includes('private'),'device setup discloses public key only and defaults to hidden amounts');
 const configured=await request(a,'/api/reminders','PATCH',prefs);check(configured.status===200,'reminder settings saved per account');
 check((await request(b,'/api/reminders?timeZone=Asia%2FQyzylorda')).body.prefs.timeZone==='Asia/Qyzylorda','other account keeps independent reminder settings');
 check((await request(a,'/api/reminders','PATCH',{...prefs,lead:2})).status===400,'invalid reminder settings rejected through API');
 check((await request(null,'/api/reminders/dispatch','POST',{}, {Authorization:'Bearer invalid'})).status===401,'unsigned background scheduler denied');
 // Receive and decrypt an actual RFC 8291 Web Push message on a disposable HTTPS endpoint.
 const receiver=createECDH('prime256v1');receiver.generateKeys();const auth=randomBytes(16),received=[];
 transport=createServer({key:readFileSync('/tmp/ritm-test.key'),cert:readFileSync('/tmp/ritm-test.crt')},async(req,res)=>{
  const parts=[];for await(const part of req)parts.push(part);
  try{received.push({payload:JSON.parse(ece.decrypt(Buffer.concat(parts),{version:'aes128gcm',privateKey:receiver,authSecret:auth}).toString()),authorization:req.headers.authorization});res.writeHead(201);res.end();}
  catch{res.writeHead(400);res.end();}
 });
 await new Promise(resolve=>transport.listen(0,'127.0.0.1',resolve));
 const subscription={endpoint:'https://127.0.0.1:'+transport.address().port+'/push',keys:{p256dh:receiver.getPublicKey().toString('base64url'),auth:auth.toString('base64url')}};
 assert.throws(()=>validatePushSubscription(subscription));check(true,'production rejects localhost push destinations');
 for(const endpoint of ['http://fcm.googleapis.com/path','https://attacker.invalid/push','https://fcm.googleapis.com:8443/push'])assert.throws(()=>validatePushSubscription({...subscription,endpoint}));
 check(true,'push registration rejects arbitrary and insecure destinations');
 check((await request(a,'/api/push/subscription','POST',subscription)).status===200,'test device binds to authenticated session');
 const sessionHash=createHash('sha256').update(a.cookie.split('=')[1]).digest('hex');
 check((await request(b,'/api/push/status','POST',{endpoint:subscription.endpoint})).body.enabled===false,'another account cannot see ownership of a device');
 check((await request(b,'/api/push/subscription','POST',subscription)).status===409,'active device cannot silently move to another account');
 check((await request(a,'/api/plan','PUT',{revision:0,plan})).status===200,'plan saved for background payment reminder');
 const service=createReminderService({pool,Core,appOrigin:base,testMode:true});await service.initialize(pool);
 const now=new Date(date+'T09:00:00Z');
 const dispatched=await service.dispatch(now);
 check(dispatched.sent===1&&received.length===1&&received[0].authorization.startsWith('vapid '),'actual encrypted Web Push transport and VAPID authentication verified');
 check(!received[0].payload.body.includes('8500')&&!received[0].payload.body.includes('Аренда'),'default push hides financial amount and title');
 check((await service.dispatch(now)).sent===0&&received.length===1,'repeated scheduler dispatch cannot resend same reminder');
 // A different advance window is a new reminder; showing the amount requires explicit opt-in.
 await service.savePrefs(user.id,{...prefs,lead:0,showAmounts:true});const earlier=new Date(Core.addDays(date,1)+'T09:00:00Z');
 check((await service.dispatch(earlier)).sent===1&&received.at(-1).payload.body.includes('Аренда'),'explicit amount preference included only in a new scheduled reminder');
 const confirmed=structuredClone(plan);Core.record(confirmed,Core.scheduled(confirmed,Core.addDays(date,1),Core.addDays(date,1))[0],850000,date,date);
 check((await request(a,'/api/plan','PUT',{revision:1,plan:confirmed})).status===200,'confirmed payment stored');
 const count=received.length;check((await service.dispatch(earlier)).sent===0&&received.length===count,'confirmed payment excluded from background delivery');
 await request(a,'/api/logout','POST',{});
 check((await pool.query('SELECT 1 FROM ritm_push_subscriptions WHERE session_hash=$1',[sessionHash])).rowCount===0,'logout immediately removes associated phone notification subscription');
 console.log('PASS '+checks+' archive and reminder checks');
 }finally{
 if(transport)await new Promise(resolve=>transport.close(resolve));
 for(const username of accounts)await pool.query('DELETE FROM ritm_users WHERE username=$1',[username]);
 await pool.end();
 }
}
