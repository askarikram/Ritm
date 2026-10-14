import pg from 'pg';
export function fixturePool(base){
 const endpoint=new URL(base),url=new URL(process.env.DATABASE_URL);
 if(endpoint.hostname!=='127.0.0.1'||!['localhost','127.0.0.1'].includes(url.hostname))throw Error('Premium fixtures require the disposable local test database');
 for(const option of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])url.searchParams.delete(option);
 return new pg.Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},max:3});
}
export async function grantFixturePremium(base,username,developer=false){
 const pool=fixturePool(base);
 try{
  const result=await pool.query('INSERT INTO ritm_memberships(user_id,lifetime,expires_at,developer) SELECT id,TRUE,NULL,$2 FROM ritm_users WHERE username=$1 ON CONFLICT(user_id) DO UPDATE SET lifetime=TRUE,expires_at=NULL,developer=EXCLUDED.developer',[username,developer]);
  if(result.rowCount!==1)throw Error('Premium test account not found');
 }finally{await pool.end();}
}
