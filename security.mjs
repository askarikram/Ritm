import { createHash, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
const rawDerive=promisify(scrypt);
let active=0;
export async function derivePassword(...args){
 if(active>=2)throw Object.assign(Error('Вход сейчас занят. Повторите через несколько секунд.'),{status:429});
 active++;try{return await rawDerive(...args);}finally{active--;}
}
export const validLoginPassword=value=>typeof value==='string'&&value.length>=8&&value.length<=128&&!/[\u0000-\u001f\u007f]/.test(value);
const common=new Set(['password1234','password12345','password123456','qwerty123456','qwertyuiop12','123456789012','1234567890123','12345678901234','123456789012345','1234567890123456','abcdefghijkl','administrator','letmein123456','iloveyou12345','пароль1234567']);
export function validNewPassword(value){
 return validLoginPassword(value)&&value.length>=12&&!common.has(value.toLowerCase())&&!/^(.)\1+$/u.test(value);
}
export function createRateLimiter(pool,{windowMs=900000,now=Date.now}={}){
 let nextCleanup=0;
 async function initialize(client=pool){await client.query('CREATE TABLE IF NOT EXISTS ritm_rate_limits(key_hash TEXT PRIMARY KEY,window_start BIGINT NOT NULL,attempts INTEGER NOT NULL CHECK(attempts>0))');await client.query('CREATE INDEX IF NOT EXISTS ritm_rate_limits_expiry ON ritm_rate_limits(window_start)');}
 async function consume(key,limit){
  const time=now(),keyHash=createHash('sha256').update(key).digest('hex');
  const row=(await pool.query('INSERT INTO ritm_rate_limits(key_hash,window_start,attempts) VALUES($1,$2,1) ON CONFLICT(key_hash) DO UPDATE SET window_start=CASE WHEN ritm_rate_limits.window_start<=$2-$3 THEN $2 ELSE ritm_rate_limits.window_start END,attempts=CASE WHEN ritm_rate_limits.window_start<=$2-$3 THEN 1 ELSE LEAST(ritm_rate_limits.attempts+1,$4+1) END RETURNING attempts,window_start',[keyHash,time,windowMs,limit])).rows[0];
  if(time>=nextCleanup){nextCleanup=time+3600000;void pool.query('DELETE FROM ritm_rate_limits WHERE window_start<$1',[time-86400000]).catch(()=>{nextCleanup=0;});}
  if(row.attempts>limit)throw Object.assign(Error('Слишком много попыток. Повторите позже.'),{status:429,retryAfter:Math.max(1,Math.ceil((Number(row.window_start)+windowMs-time)/1000))});
 }
 return {initialize,consume};
}
