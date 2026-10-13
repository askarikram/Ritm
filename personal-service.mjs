import { Personal } from './personal-domain.mjs';
const error=(message,status=400)=>Object.assign(Error(message),{status});
export function createPersonalService({pool}){
 async function initialize(client){await client.query('CREATE TABLE IF NOT EXISTS ritm_personal(user_id UUID PRIMARY KEY REFERENCES ritm_users(id) ON DELETE CASCADE,state JSONB NOT NULL,revision INTEGER NOT NULL DEFAULT 0)');}
 async function get(userId,zone){
  const initial=Personal.fresh(zone);
  await pool.query('INSERT INTO ritm_personal(user_id,state) VALUES($1,$2::jsonb) ON CONFLICT DO NOTHING',[userId,JSON.stringify(initial)]);
  const row=(await pool.query('SELECT state,revision FROM ritm_personal WHERE user_id=$1',[userId])).rows[0];
  return {state:Personal.validate(row.state),revision:row.revision};
 }
 async function mutate(userId,data,now=new Date()){
  if(!Number.isInteger(data.revision)||data.revision<0||data.revision>=2147483646)throw error('Некорректная версия личного раздела.');
  const client=await pool.connect();
  try{
   await client.query('BEGIN');
   const row=(await client.query('SELECT state,revision FROM ritm_personal WHERE user_id=$1 FOR UPDATE',[userId])).rows[0];
   if(!row)throw error('Обновите личный раздел.',409);
   if(row.revision!==data.revision)throw error('Личные дела изменились в другой вкладке. Обновите раздел и повторите действие.',409);
   let state;try{state=Personal.apply(row.state,data,now);}catch(cause){throw error(cause.message);}
   const saved=(await client.query('UPDATE ritm_personal SET state=$2::jsonb,revision=revision+1 WHERE user_id=$1 RETURNING revision',[userId,JSON.stringify(state)])).rows[0];
   await client.query('COMMIT');return {state,revision:saved.revision};
  }catch(cause){try{await client.query('ROLLBACK');}catch{}throw cause;}finally{client.release();}
 }
 return {initialize,get,mutate};
}
