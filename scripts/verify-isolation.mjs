import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import pg from 'pg';

export async function verifyIsolation(baseURL, origin = baseURL, production = true) {
  const base = new URL(baseURL).origin;
  const appOrigin = new URL(origin).origin;
  let checks = 0;
  const check = (condition, label) => {
    assert.ok(condition, label);
    checks++;
    console.log('RITM_ISOLATION_CHECK ' + label);
  };
  const suffix = [...randomBytes(12)].map(n => String.fromCharCode(97 + n % 26)).join('');
  const accounts = [
    { username: 'ritmtesta' + suffix, password: randomBytes(24).toString('hex'), name: 'Проверка A' },
    { username: 'ritmtestb' + suffix, password: randomBytes(24).toString('hex'), name: 'Проверка B' }
  ];
  const created = [];
  const request = async (account, path, method = 'GET', data, extra = {}) => {
    const response = await fetch(base + path, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(20000),
      headers: {
        ...(method === 'GET' ? {} : { Origin: appOrigin }),
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(account?.cookie ? { Cookie: account.cookie } : {}),
        ...(account?.username ? { 'X-Ritm-User': account.username } : {}),
        ...extra
      },
      body: data === undefined ? undefined : JSON.stringify(data)
    });
    const raw = await response.text();
    let body;
    try { body = JSON.parse(raw); } catch { throw Error('Expected JSON for ' + path + ', status ' + response.status); }
    const setCookie = response.headers.get('set-cookie');
    if (account && setCookie) account.cookie = setCookie.split(';')[0];
    return { status: response.status, body, setCookie };
  };
  const fresh = () => ({ version: 1, balance: 0, daily: 0, currency: 'KZT', items: [], goals: [], done: {}, ledger: [] });
  const date = new Date().toISOString().slice(0, 10);
  const makePlan = (label, balance, currency) => ({
    ...fresh(), balance, daily: label === 'A' ? 100 : 200, currency,
    items: [
      { id: randomUUID(), title: 'Доход ' + label, type: 'income', amount: 300000, date, repeat: 'monthly' },
      { id: randomUUID(), title: 'Платёж ' + label, type: 'payment', amount: 50000, date, repeat: 'none' }
    ],
    goals: [{ id: randomUUID(), title: 'Цель ' + label, target: 200000, saved: 1000,
      mode: 'monthly', monthly: 10000, start: date, deadline: date, done: [] }]
  });
  const plans = [makePlan('A', 111111, 'KZT'), makePlan('B', 222222, 'USD')];
  const assertPlan = async (account, expected, label) => {
    const result = await request(account, '/api/me');
    check(result.status === 200 && result.body.user.username === account.username, label + ': session owner');
    assert.deepEqual(result.body.plan, expected, label + ': plan');
    check(true, label + ': private plan preserved');
    return result.body;
  };
  try {
    check((await request(null, '/api/me')).status === 401, 'anonymous read denied');
    check((await request(null, '/api/signup', 'POST', { username: 'ritmreject' + suffix, name: 'Проверка подтверждения', password: 'ConfirmPass123', confirmPassword: 'DifferentPass123' })).status === 400, 'signup mismatched passwords denied');
    check((await request(null, '/api/signup', 'POST', { username: 'ritmreject' + suffix, name: 'Проверка подтверждения', password: 'ConfirmPass123' })).status === 400, 'signup missing confirmation denied');
    for (const account of accounts) {
      const result = await request(account, '/api/signup', 'POST', {
        username: account.username, password: account.password, confirmPassword: account.password, name: account.name, remember: true
      });
      check(result.status === 200, account.name + ': signup');
      created.push(account.username);
      check(result.body.user.username === account.username, account.name + ': own user returned');
      assert.deepEqual(result.body.plan, fresh());
      check(result.body.revision === 0, account.name + ': new empty plan');
      check(/HttpOnly/i.test(result.setCookie) && /SameSite=Strict/i.test(result.setCookie), account.name + ': protected cookie');
      if (production) check(/Secure/i.test(result.setCookie) && result.setCookie.startsWith('__Host-ritm-session='), account.name + ': HTTPS cookie');
    }
    for (let i = 0; i < 2; i++) {
      const result = await request(accounts[i], '/api/plan', 'PUT', { plan: plans[i], revision: 0 });
      check(result.status === 200 && result.body.revision === 1, 'account ' + i + ': private save');
    }
    await assertPlan(accounts[0], plans[0], 'A after B save');
    await assertPlan(accounts[1], plans[1], 'B after A save');
    const aCookie = accounts[0].cookie;
    check((await request(accounts[0], '/api/me', 'GET', undefined, { 'X-Ritm-User': accounts[1].username })).status === 401, 'forged account read denied');
    check((await request(accounts[0], '/api/plan', 'PUT', { plan: plans[1], revision: 1 }, { 'X-Ritm-User': accounts[1].username })).status === 401, 'forged account write denied');
    check((await request(accounts[0], '/api/plan', 'PUT', { plan: plans[1], revision: 1 }, { 'X-Ritm-User': '' })).status === 403, 'save without account denied');
    check((await request(accounts[0], '/api/plan', 'PUT', { plan: plans[1], revision: 1 }, { Origin: 'https://unrelated.invalid' })).status === 403, 'foreign origin denied');
    check((await request(accounts[0], '/api/plan', 'PUT', { plan: plans[1], revision: 0 })).status === 409, 'stale revision denied');
    check((await request(null, '/api/me?username=' + accounts[0].username)).status === 401, 'URL account selector cannot bypass auth');
    const ownWithSelector = await request(accounts[1], '/api/me?username=' + accounts[0].username);
    assert.deepEqual(ownWithSelector.body.plan, plans[1]);
    check(ownWithSelector.status === 200 && ownWithSelector.body.user.username === accounts[1].username, 'URL account selector cannot read another plan');
    await assertPlan(accounts[0], plans[0], 'A after denied writes');
    await assertPlan(accounts[1], plans[1], 'B after denied writes');
    const switchResult = await request(accounts[0], '/api/login', 'POST', {
      username: accounts[1].username, password: accounts[1].password, remember: false
    });
    check(switchResult.status === 200 && switchResult.body.user.username === accounts[1].username, 'same browser switched to B');
    check((await request(accounts[0], '/api/plan', 'PUT', { plan: plans[0], revision: 1 })).status === 401, 'old A tab cannot save into B');
    check((await request(null, '/api/me', 'GET', undefined, { Cookie: aCookie })).status === 401, 'old A session invalidated on switch');
    const switched = { ...accounts[1], cookie: accounts[0].cookie };
    await assertPlan(switched, plans[1], 'B after account switch');
    check((await request(switched, '/api/logout', 'POST', {})).status === 200, 'logout succeeds');
    check((await request(switched, '/api/me')).status === 401, 'logged out session denied');
    const loginA = { ...accounts[0], cookie: undefined };
    const loginResult = await request(loginA, '/api/login', 'POST', { username: loginA.username, password: loginA.password });
    check(loginResult.status === 200, 'A login after logout');
    await assertPlan(loginA, plans[0], 'A persisted after relogin');
    await assertPlan(accounts[1], plans[1], 'B independent browser session');

    check((await request(null, '/api/profile', 'PATCH', { name: 'Чужое имя' })).status === 401, 'anonymous profile change denied');
    check((await request(loginA, '/api/profile', 'PATCH', { name: 'Чужое имя' }, { 'X-Ritm-User': accounts[1].username })).status === 401, 'forged profile change denied');
    check((await request(loginA, '/api/profile', 'PATCH', { name: 'Чужое имя' }, { Origin: 'https://unrelated.invalid' })).status === 403, 'foreign origin profile change denied');
    check((await request(loginA, '/api/profile', 'PATCH', { name: '   ' })).status === 400, 'empty profile name denied');
    const renamed = await request(loginA, '/api/profile', 'PATCH', { name: '  Обновлённый профиль A  ', user_id: accounts[1].username });
    check(renamed.status === 200 && renamed.body.user.name === 'Обновлённый профиль A' && renamed.body.user.username === loginA.username, 'profile name updated only for session owner');
    const aProfile = await assertPlan(loginA, plans[0], 'A plan after profile change');
    check(aProfile.user.name === 'Обновлённый профиль A' && aProfile.revision === 1, 'profile name persisted without changing financial revision');
    const bProfile = await assertPlan(accounts[1], plans[1], 'B plan after A profile change');
    check(bProfile.user.name === accounts[1].name, 'B name unchanged after A profile change');
    const oldPassword = loginA.password, newPassword = randomBytes(24).toString('hex');
    check((await request(loginA, '/api/password', 'POST', { currentPassword: oldPassword, newPassword, confirmPassword: 'DifferentPass123' })).status === 400, 'password confirmation mismatch denied');
    check((await request(loginA, '/api/password', 'POST', { currentPassword: oldPassword, newPassword: 'short', confirmPassword: 'short' })).status === 400, 'invalid new password denied');
    const wrongPassword = await request(loginA, '/api/password', 'POST', { currentPassword: 'WrongCurrent123', newPassword, confirmPassword: newPassword });
    check(wrongPassword.status === 401 && wrongPassword.body.code === 'wrong_password', 'wrong current password denied without logout');
    await assertPlan(loginA, plans[0], 'A session after wrong password');
    const otherA = { username: loginA.username };
    check((await request(otherA, '/api/login', 'POST', { username: loginA.username, password: oldPassword })).status === 200, 'second A device signed in before password change');
    const oldCookie = loginA.cookie;
    const changed = await request(loginA, '/api/password', 'POST', { currentPassword: oldPassword, newPassword, confirmPassword: newPassword });
    check(changed.status === 200 && changed.body.user.username === loginA.username, 'password changed for session owner');
    check(/HttpOnly/.test(changed.setCookie) && /SameSite=Strict/.test(changed.setCookie), 'password change rotates protected session cookie');
    if (production) check(/Secure/.test(changed.setCookie), 'password change keeps Secure cookie');
    check((await request(null, '/api/me', 'GET', undefined, { Cookie: oldCookie })).status === 401, 'pre-change A session revoked');
    check((await request(otherA, '/api/me')).status === 401, 'other A device revoked after password change');
    await assertPlan(loginA, plans[0], 'A stays signed in after password change');
    check((await request(null, '/api/login', 'POST', { username: loginA.username, password: oldPassword })).status === 401, 'old password no longer accepted');
    const newLogin = { username: loginA.username };
    check((await request(newLogin, '/api/login', 'POST', { username: loginA.username, password: newPassword })).status === 200, 'new password accepted');
    const finalA = await assertPlan(newLogin, plans[0], 'A plan after new password login');
    check(finalA.revision === 1, 'password change preserves financial revision');
    const finalB = await assertPlan(accounts[1], plans[1], 'B unaffected by A password change');
    check(finalB.user.name === accounts[1].name, 'B profile preserved after A password change');

    console.log('RITM_ISOLATION_HTTP_PASS ' + checks + ' checks ' + base);
  } finally {
    if (created.length && process.env.DATABASE_URL) {
      const url = new URL(process.env.DATABASE_URL);
      for (const key of ['sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl']) url.searchParams.delete(key);
      const pool = new pg.Pool({ connectionString: url.toString(), ssl: { rejectUnauthorized: true },
        enableChannelBinding: true, max: 1, connectionTimeoutMillis: 15000, query_timeout: 15000 });
      try {
        // Remove only the exact test accounts created by this invocation.
        const result = await pool.query('DELETE FROM ritm_users WHERE username = ANY($1::text[])', [created]);
        check(result.rowCount === created.length, 'test accounts cleaned up');
      } finally { await pool.end(); }
    }
  }
  console.log('RITM_ISOLATION_PASS ' + checks + ' checks ' + base);
  return checks;
}
