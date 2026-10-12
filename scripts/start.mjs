import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { verifyIsolation } from './verify-isolation.mjs';

const child = spawn(process.execPath, ['server.js'], { stdio: 'inherit', env: process.env });
let shuttingDown = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => { shuttingDown = true; child.kill(signal); });
}
child.on('error', () => { console.error('RITM_START_FAILED'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exit(shuttingDown ? 0 : (process.exitCode || code || 1)); });

async function waitForHealth(base) {
  for (let attempt = 0; attempt < 120; attempt++) {
    if (child.exitCode !== null) throw Error('Application exited');
    try {
      const response = await fetch(new URL('/healthz', base), { signal: AbortSignal.timeout(10000) });
      if (response.ok && (await response.json()).ok === true) return;
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
      await waitForHealth(publicOrigin);
      await verifyIsolation(publicOrigin, publicOrigin, true);
    } catch (error) {
      // Do not log request bodies, passwords, session cookies, or DATABASE_URL.
      console.error('RITM_ISOLATION_FAILED ' + error.name);
      child.kill('SIGTERM');
      process.exitCode = 1;
    }
  })();
}
