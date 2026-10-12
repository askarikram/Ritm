import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyIsolation } from './verify-isolation.mjs';

const child = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env });
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { shuttingDown = true; child.kill(signal); });
}
child.on('error', () => { console.error('RITM_START_FAILED'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exit(shuttingDown ? 0 : (process.exitCode || code || 1)); });

async function waitForHealth(base, version) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw Error('Application exited');
    try {
      const response = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(10000) });
      if (response.ok) { const data = await response.json(); if (data.ok === true && (!version || data.version === version)) return; }
    } catch {}
    await delay(2000);
  }
  throw Error('Health check timed out');
}
if (process.env.RITM_VERIFY_DEPLOY === '1') {
  void (async () => {
    try {
      const local = 'http://127.0.0.1:' + (process.env.PORT || '3000');
      const publicOrigin = new URL(process.env.APP_ORIGIN || process.env.RENDER_EXTERNAL_URL).origin;
      await waitForHealth(local);
      const version = process.env.RENDER_GIT_COMMIT || createHash('sha256').update(readFileSync(new URL('../public/index.html', import.meta.url))).digest('hex').slice(0, 16);
      await waitForHealth(publicOrigin, version);
      await verifyIsolation(publicOrigin, publicOrigin, true);
    } catch (error) {
      // Do not log request bodies, passwords, session cookies, or DATABASE_URL.
      const details=String(error.message).split(process.env.DATABASE_URL||'__no_database_url__').join('[DATABASE_URL]').slice(0,220);
      console.error('RITM_ISOLATION_FAILED ' + error.name + ': ' + details);
      child.kill('SIGTERM');
      process.exitCode = 1;
    }
  })();
}
