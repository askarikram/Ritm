import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
export async function verifyLaunch(base){
  let checks=0;const check=(value,label)=>{assert.ok(value,label);checks++;console.log('RITM_LAUNCH_CHECK '+label);};
  const suffix=[...randomBytes(9)].map(n=>String.fromCharCode(97+n%26)).join(''),created=[];
  const a={username:'launcha'+suffix},b={username:'launchb'+suffix},password='LaunchPassword123',nextPassword='LaunchNewPassword456';
  const request=async(account,path,method='GET',data,extra={})=>{
    const response=await fetch(base+path,{method,headers:{...(method==='GET'?{}:{Origin:base}),...(data?{'Content-Type':'application/json'}:{}),...(account?.cookie?{Cookie:account.cookie}:{}),...(account?{'X-Ritm-User':account.username}:{}),...extra},body:data?JSON.stringify(data):undefined});
    const body=await response.json(),cookie=response.headers.get('set-cookie');if(account&&cookie)account.cookie=cookie.split(';')[0];
    return {status:response.status,body};
  };
  const fresh={version:1,balance:125000,daily:500,currency:'KZT',items:[],goals:[],done:{},ledger:[]};
  try{
    const root=await fetch(base),html=await root.text(),csp=root.headers.get('content-security-policy');
    check(root.ok&&html.includes('rel="manifest"')&&html.includes('apple-touch-icon'),'site advertises installable app and iOS icon');
    check(csp.includes("worker-src 'self'")&&csp.includes("manifest-src 'self'"),'CSP permits only same-origin worker and manifest');
    const manifestResponse=await fetch(base+'/manifest.webmanifest'),manifest=await manifestResponse.json();
    check(manifestResponse.headers.get('content-type').includes('application/manifest+json')&&manifest.display==='standalone'&&manifest.start_url==='/'&&manifest.scope==='/','valid standalone manifest');
    for(const [path,size] of [['/icons/icon-192.png',192],['/icons/icon-512.png',512],['/icons/apple-touch-icon.png',180]]){
      const response=await fetch(base+path),data=Buffer.from(await response.arrayBuffer());
      check(response.ok&&data.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&data.readUInt32BE(16)===size&&data.readUInt32BE(20)===size,'valid app icon '+size);
    }
    for(const path of ['/help','/privacy','/offline.html']){
      const response=await fetch(base+path);check(response.ok&&response.headers.get('content-type').includes('text/html'),'public information page '+path);
    }
    const worker=await fetch(base+'/sw.js'),source=await worker.text();
    check(worker.ok&&worker.headers.get('cache-control')==='no-cache'&&!source.includes('__RITM_RELEASE__'),'worker receives release version and revalidates');
    check((await (await fetch(base+'/sitemap.xml')).text()).includes(base+'/help'),'sitemap uses configured origin');
    check((await (await fetch(base+'/robots.txt')).text()).includes('Disallow: /api/'),'search crawlers exclude private API');
    const codes=[];
    for(const account of [a,b]){
      const response=await request(account,'/api/signup','POST',{username:account.username,name:'Проверка запуска',password,confirmPassword:password});
      check(response.status===200,'launch account created');created.push(account.username);codes.push(response.body.recoveryCode);
      check(/^[A-F0-9]{4}(?:-[A-F0-9]{4}){7}$/.test(response.body.recoveryCode)&&response.body.recoveryEnabled===true,'signup supplies a personal recovery code once');
      const me=await request(account,'/api/me');check(!('recoveryCode' in me.body),'session read never discloses code');
    }
    const saved=await request(a,'/api/plan','PUT',{revision:0,plan:fresh});check(saved.status===200,'nonempty plan saved before recovery');
    const otherDevice={username:a.username};await request(otherDevice,'/api/login','POST',{username:a.username,password});
    check((await request(null,'/api/recovery-code','POST',{currentPassword:password})).status===401,'anonymous code generation denied');
    check((await request(a,'/api/recovery-code','POST',{currentPassword:password},{Origin:'https://example.invalid'})).status===403,'cross-origin code generation denied');
    check((await request(a,'/api/recovery-code','POST',{currentPassword:password},{'X-Ritm-User':b.username})).status===401,'code generation bound to session owner');
    check((await request(a,'/api/recovery-code','POST',{currentPassword:'WrongPassword123'})).status===401,'code generation requires current password');
    const generated=await request(a,'/api/recovery-code','POST',{currentPassword:password}),code=generated.body.recoveryCode;
    check(generated.status===200&&code!==codes[0],'regeneration produces a different code');
    const recovery={username:a.username,recoveryCode:code,newPassword:nextPassword,confirmPassword:nextPassword};
    check((await request(null,'/api/recover','POST',{...recovery,recoveryCode:codes[0]})).status===401,'replaced recovery code denied');
    check((await request(null,'/api/recover','POST',{...recovery,recoveryCode:codes[1]})).status===401,'another account code denied');
    check((await request(null,'/api/recover','POST',recovery,{Origin:'https://example.invalid'})).status===403,'cross-origin recovery denied');
    check((await request(null,'/api/recover','POST',{...recovery,confirmPassword:'MismatchPassword123'})).status===400,'recovery validates password confirmation');
    const recovered={username:a.username},response=await request(recovered,'/api/recover','POST',{...recovery,recoveryCode:code.toLowerCase().replaceAll('-',' ')});
    check(response.status===200&&response.body.recoveryCode!==code,'recovery accepts formatted code and rotates it');
    assert.deepEqual(response.body.plan,fresh);check(response.body.revision===1,'recovery preserves plan and revision');
    check((await request(a,'/api/me')).status===401&&(await request(otherDevice,'/api/me')).status===401,'recovery revokes all previous sessions');
    check((await request(null,'/api/recover','POST',recovery)).status===401,'used recovery code cannot be reused');
    check((await request(null,'/api/login','POST',{username:a.username,password})).status===401,'old password denied after recovery');
    const login={username:a.username};check((await request(login,'/api/login','POST',{username:a.username,password:nextPassword})).status===200,'new password accepted');
    check((await request(b,'/api/me')).status===200,'other account remains signed in');
    // Two concurrent uses of a valid code must produce exactly one successful reset.
    const concurrentData={...recovery,recoveryCode:response.body.recoveryCode},attempts=await Promise.all([request(null,'/api/recover','POST',concurrentData),request(null,'/api/recover','POST',concurrentData)]);
    check(attempts.filter(x=>x.status===200).length===1&&attempts.filter(x=>x.status===401).length===1,'recovery code is atomic and single-use under concurrency');
    const finalLogin={username:a.username};await request(finalLogin,'/api/login','POST',{username:a.username,password:nextPassword});
    await request(finalLogin,'/api/wish','POST',{timeZone:'Asia/Qyzylorda'});
    check((await request(finalLogin,'/api/account','DELETE',{currentPassword:'WrongPassword123',confirmation:'УДАЛИТЬ'})).status===401,'account deletion requires correct password');
    check((await request(finalLogin,'/api/account','DELETE',{currentPassword:nextPassword,confirmation:'no'})).status===400,'account deletion requires explicit confirmation');
    check((await request(finalLogin,'/api/account','DELETE',{currentPassword:nextPassword,confirmation:'УДАЛИТЬ'},{'X-Ritm-User':b.username})).status===401,'account deletion cannot target another owner');
    check((await request(finalLogin,'/api/account','DELETE',{currentPassword:nextPassword,confirmation:'УДАЛИТЬ'})).status===200,'confirmed account deletion succeeds');
    check((await request(finalLogin,'/api/me')).status===401,'deleted account session revoked');
    check((await request(b,'/api/me')).status===200,'deleting A preserves B');
    const dbURL=new URL(process.env.DATABASE_URL);for(const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])dbURL.searchParams.delete(key);
    const pool=new pg.Pool({connectionString:dbURL.toString(),ssl:{rejectUnauthorized:true},max:1});
    try{
      const row=(await pool.query('SELECT count(*)::int AS n FROM ritm_users WHERE username=$1',[a.username])).rows[0];
      check(row.n===0,'account removed from working database');
      const record=(await pool.query('SELECT r.code_hash FROM ritm_recovery_codes r JOIN ritm_users u ON u.id=r.user_id WHERE u.username=$1',[b.username])).rows[0];
      check(record.code_hash!==codes[1]&&/^[a-f0-9]{64}$/.test(record.code_hash),'database stores only recovery hash');
    }finally{await pool.end();}
  }finally{
    if(created.length){
      const url=new URL(process.env.DATABASE_URL);for(const key of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])url.searchParams.delete(key);
      const pool=new pg.Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},max:1});
      try{await pool.query('DELETE FROM ritm_users WHERE username=ANY($1::text[])',[created]);}finally{await pool.end();}
    }
  }
  console.log('RITM_LAUNCH_PASS '+checks+' checks');
}
