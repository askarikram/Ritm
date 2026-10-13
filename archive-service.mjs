export const archiveMonthKeys=(year,now)=>{
  const current=now.slice(0,7),lastYear=Number(now.slice(0,4));
  if(!Number.isInteger(year)||year<2026||year>lastYear)throw Error('Выберите год начиная с 2026.');
  return Array.from({length:12},(_,i)=>year+'-'+String(i+1).padStart(2,'0')).filter(month=>month<current).reverse();
};
export function validateArchiveEntry(data,now){
  if(!data||typeof data!=='object'||typeof data.month!=='string'||!/^\d{4}-(0[1-9]|1[0-2])$/.test(data.month)||data.month<'2026-01'||data.month>=now.slice(0,7))throw Error('В архиве можно заполнить только прошлые месяцы, начиная с января 2026.');
  if(!['KZT','USD'].includes(data.currency))throw Error('Выберите валюту.');
  const amount=(value,signed=false)=>{
    if(typeof value!=='string'||!(signed?/^-?\d{1,15}$/:/^\d{1,15}$/).test(value)||BigInt(value)>100000000000000n||BigInt(value)<(signed?-100000000000000n:0n))throw Error('Введите корректную сумму.');
    return BigInt(value).toString();
  };
  if(data.revision!==null&&(!Number.isInteger(data.revision)||data.revision<0||data.revision>=2147483646))throw Error('Некорректная версия месяца.');
  const opening=amount(data.opening,true),income=amount(data.income),expenses=amount(data.expenses),savings=amount(data.savings);
  return {month:data.month,currency:data.currency,opening,income,expenses,savings,remaining:(BigInt(opening)+BigInt(income)-BigInt(expenses)-BigInt(savings)).toString(),revision:data.revision};
}
export function createArchiveService({pool,Core}){
  const columns='month,currency,opening::text,income::text,expenses::text,savings::text,remaining::text,source,revision,updated_at::text';
  async function initialize(client){
    await client.query("CREATE TABLE IF NOT EXISTS ritm_month_archives(user_id UUID NOT NULL REFERENCES ritm_users(id) ON DELETE CASCADE,month CHAR(7) NOT NULL,currency TEXT NOT NULL CHECK(currency IN ('KZT','USD')),opening NUMERIC(22,0) NOT NULL,income NUMERIC(22,0) NOT NULL CHECK(income>=0),expenses NUMERIC(22,0) NOT NULL CHECK(expenses>=0),savings NUMERIC(22,0) NOT NULL CHECK(savings>=0),remaining NUMERIC(22,0) NOT NULL,source TEXT NOT NULL CHECK(source IN ('auto','manual')),revision INTEGER NOT NULL DEFAULT 0,updated_at BIGINT NOT NULL,PRIMARY KEY(user_id,month))");
  }
  async function capture(userId,plan,now,client=pool){
    const month=now.slice(0,7);if(month<'2026-01')return;
    const m=Core.monthOverview(plan,now),values=[m.opening,m.income,m.expenses,m.savings,m.remaining].map(String);
    await client.query("INSERT INTO ritm_month_archives(user_id,month,currency,opening,income,expenses,savings,remaining,source,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'auto',$9) ON CONFLICT(user_id,month) DO UPDATE SET currency=EXCLUDED.currency,opening=EXCLUDED.opening,income=EXCLUDED.income,expenses=EXCLUDED.expenses,savings=EXCLUDED.savings,remaining=EXCLUDED.remaining,revision=ritm_month_archives.revision+1,updated_at=EXCLUDED.updated_at WHERE ritm_month_archives.source='auto' AND (ritm_month_archives.currency,ritm_month_archives.opening,ritm_month_archives.income,ritm_month_archives.expenses,ritm_month_archives.savings,ritm_month_archives.remaining) IS DISTINCT FROM (EXCLUDED.currency,EXCLUDED.opening,EXCLUDED.income,EXCLUDED.expenses,EXCLUDED.savings,EXCLUDED.remaining)",[userId,month,plan.currency,...values,Date.now()]);
  }
  async function list(userId,year,now){
    const months=archiveMonthKeys(year,now);
    const rows=(await pool.query('SELECT '+columns+' FROM ritm_month_archives WHERE user_id=$1 AND month>=$2 AND month<=$3 ORDER BY month DESC',[userId,year+'-01',year+'-12'])).rows.filter(row=>months.includes(row.month));
    return {year,firstYear:2026,lastYear:Number(now.slice(0,4)),months,records:rows};
  }
  async function save(userId,data,now){
    const entry=validateArchiveEntry(data,now),values=[userId,entry.month,entry.currency,entry.opening,entry.income,entry.expenses,entry.savings,entry.remaining,Date.now()];
    const query=entry.revision===null
      ?"INSERT INTO ritm_month_archives(user_id,month,currency,opening,income,expenses,savings,remaining,source,updated_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9) ON CONFLICT(user_id,month) DO NOTHING RETURNING "+columns
      :"UPDATE ritm_month_archives SET currency=$3,opening=$4,income=$5,expenses=$6,savings=$7,remaining=$8,source='manual',updated_at=$9,revision=revision+1 WHERE user_id=$1 AND month=$2 AND revision=$10 RETURNING "+columns;
    const result=await pool.query(query,entry.revision===null?values:[...values,entry.revision]);
    if(!result.rowCount){const error=Error('Этот месяц уже изменён. Обновите архив перед сохранением.');error.status=409;throw error;}
    return result.rows[0];
  }
  return {initialize,capture,list,save};
}
