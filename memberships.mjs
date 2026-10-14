export const developerUsername='askar';
export function membershipStatus(row,now=Date.now()){
 const lifetime=row?.lifetime===true,expires=row?.expires_at===null||row?.expires_at===undefined?null:Number(row.expires_at);
 const validExpiry=Number.isSafeInteger(expires)&&expires>0&&expires<=8640000000000000;
 const premium=lifetime||validExpiry&&expires>now;
 return {tier:premium?'premium':'basic',lifetime:premium&&lifetime,expiresAt:validExpiry?new Date(expires).toISOString():null,developer:premium&&lifetime&&row?.developer===true};
}
export function createMembershipService({pool}){
 async function initialize(client=pool){
  await client.query("CREATE TABLE IF NOT EXISTS ritm_memberships(user_id UUID PRIMARY KEY REFERENCES ritm_users(id) ON DELETE CASCADE,lifetime BOOLEAN NOT NULL DEFAULT FALSE,expires_at BIGINT,developer BOOLEAN NOT NULL DEFAULT FALSE,CHECK((lifetime AND expires_at IS NULL) OR (NOT lifetime AND expires_at BETWEEN 1 AND 8640000000000000)),CHECK(NOT developer OR lifetime))");
  const granted=await client.query("INSERT INTO ritm_memberships(user_id,lifetime,expires_at,developer) SELECT id,TRUE,NULL,TRUE FROM ritm_users WHERE username=$1 ON CONFLICT(user_id) DO UPDATE SET lifetime=TRUE,expires_at=NULL,developer=TRUE",[developerUsername]);
  return granted.rowCount>0;
 }
 async function forUser(userId,now=Date.now(),client=pool){
  const row=(await client.query('SELECT lifetime,expires_at,developer FROM ritm_memberships WHERE user_id=$1',[userId])).rows[0];
  return membershipStatus(row,now);
 }
 return {initialize,forUser};
}
