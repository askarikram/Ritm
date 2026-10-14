import { readFileSync } from 'node:fs';
import pg from 'pg';
import { decryptBackup, restoreBackup } from '../backup.mjs';
const file=process.argv[2],target=process.env.RITM_RESTORE_URL;
if(!file||!target||!process.env.RITM_BACKUP_KEY)throw Error('Provide a backup file, RITM_RESTORE_URL and RITM_BACKUP_KEY. Initialize a NEW empty Ritm database with this release first.');
if(target===process.env.DATABASE_URL)throw Error('Refusing to restore into the running application database');
const url=new URL(target);for(const option of ['sslmode','sslcert','sslkey','sslrootcert','ssl'])url.searchParams.delete(option);
const pool=new pg.Pool({connectionString:url.toString(),ssl:{rejectUnauthorized:true},max:1});
try{
 const snapshot=decryptBackup(JSON.parse(readFileSync(file,'utf8')),process.env.RITM_BACKUP_KEY);
 const client=await pool.connect();try{await restoreBackup(client,snapshot);}finally{client.release();}
 console.log('Backup restored into the empty target. Existing sessions and device subscriptions are not restored.');
}finally{await pool.end();}
