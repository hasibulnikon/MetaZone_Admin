// V5 Part 13 browser smoke: the REAL admin.js / addon_tools_admin.js / addon_tools_logic.js in Chromium against a STUBBED supabase client that imitates the
// 0038 answers. UI behaviour only; NOT a SQL test and NOT a real Supabase test (the SQL was run separately on a scratch PostgreSQL).
//   NODE_PATH=$(npm root -g) node test_ui/developer_requests.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT || path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const STUB = `
window.__calls = [];
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push({ name, params }); const S = window.__SRV__; const h = S.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.fn ? h.fn(params, S) : h.data, error: null }; },
  storage: { from: () => ({}) },
}) };`;
const U1 = '11111111-1111-4111-8111-111111111111', U2 = '22222222-2222-4222-8222-222222222222', U3 = '33333333-3333-4333-8333-333333333333';
const R1 = 'aaaaaaa1-0000-4000-8000-000000000001', R2 = 'aaaaaaa2-0000-4000-8000-000000000002', R3 = 'aaaaaaa3-0000-4000-8000-000000000003';
const SRV_SRC = `(${function (cfg) {
  const S = { requests: cfg.requests, global: cfg.global, decideMode: cfg.decideMode || 'normal', rpc: {} };
  const view = (r) => ({ id: r.id, user_id: r.user_id, email: r.email, nickname: r.nickname || null, plan: 'free', status: r.status, message: r.message || null, created_at: r.created_at,
    decided_at: r.decided_at || null, decided_by_email: r.decided_by_email || null, allowed_now: !!r.allowed, reason: r.allowed ? 'override_on' : (S.global ? 'plan_off' : 'global_off') });
  const pending = () => S.requests.filter((r) => r.status === 'pending');
  const missing = 'Could not find the function public.admin_addon_tools_list_developer_requests in the schema cache';
  S.rpc.admin_overview = { data: {} }; S.rpc.admin_addon_tools_list = { data: [] }; S.rpc.admin_addon_tools_list_audit = { data: [] };
  S.rpc.admin_addon_tools_get_developer_settings = { data: { enabled: !!S.global, allow_free: false, allow_premium: false, updated_at: null, updated_by_email: null, overrides_on: 0, overrides_off: 0 } };
  S.rpc.admin_addon_tools_list_developer_import = { data: [] };
  S.rpc.admin_addon_tools_get_developer_import = { data: [] };
  S.rpc.admin_addon_tools_developer_request_summary = cfg.noRpc ? { error: missing } : { fn: () => ({ pending_count: pending().length, newest: pending().slice().reverse().slice(0, 5).map((r) => ({ id: r.id, user_id: r.user_id, email: r.email, created_at: r.created_at })) }) };
  S.rpc.admin_addon_tools_list_developer_requests = cfg.noRpc ? { error: missing } : { fn: (p) => S.requests.filter((r) => !p.p_status || r.status === p.p_status).map(view) };
  S.rpc.admin_addon_tools_decide_developer_request = { fn: (p) => {
    const r = S.requests.find((x) => x.id === p.p_request_id);
    if (S.decideMode === 'personal_off') return { ok: false, code: 'personal_off', request: view(r), allowed_now: false, reason: 'override_off' };
    if (S.decideMode === 'already') { r.status = 'declined'; r.decided_at = '2026-11-10T10:00:00Z'; r.decided_by_email = 'other-admin@x.test'; return { ok: false, code: 'already_decided', request: view(r) }; }
    if (S.decideMode === 'unconfirmed') return { ok: true, code: p.p_decision, granted: true, request: view(S.requests[S.requests.length - 1]) };
    if (!r || r.status !== 'pending') return { ok: false, code: 'already_decided', request: r ? view(r) : null };
    r.status = p.p_decision; r.decided_at = '2026-11-10T11:00:00Z'; r.decided_by_email = 'admin@test'; r.allowed = p.p_decision === 'approved' && S.global;
    return { ok: true, code: p.p_decision, granted: p.p_decision === 'approved', request: view(r), allowed_now: !!r.allowed, reason: r.allowed ? 'override_on' : (S.global ? 'plan_off' : 'global_off') };
  } };
  window.__SRV__ = S;
}})`;
const mk = (extra) => ({ global: true, requests: [
  { id: R1, user_id: U1, email: 'alice@x.test', nickname: 'Alice', status: 'pending', message: 'I make add-ons for stock work <img src=x onerror="window.__xss=1">', created_at: '2026-11-09T08:00:00Z' },
  { id: R2, user_id: U2, email: 'bob@x.test', status: 'pending', message: '', created_at: '2026-11-10T09:00:00Z' },
  { id: R3, user_id: U3, email: 'carol@x.test', status: 'declined', created_at: '2026-11-01T09:00:00Z', decided_at: '2026-11-02T09:00:00Z', decided_by_email: 'admin2@x.test' }], ...extra });
(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(); const results = [];
  const open = async (cfg, goDev) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript(`(${SRV_SRC})(${JSON.stringify(cfg)})`);
    await page.goto(url); await page.waitForSelector('.nav button[data-tab="addontools"]');
    if (goDev !== false) { await page.click('.nav button[data-tab="addontools"]'); await page.waitForSelector('#at-root .toolbar'); }
    return { page, errors };
  };
  const calls = (page, n) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), n);
  const toastText = (page) => page.$$eval('#toasts .toast', (e) => e.map((x) => x.innerText));
  const rows = (page) => page.$$eval('#at-req-table tbody tr', (r) => r.map((x) => ({ id: x.dataset.request, status: x.dataset.status, text: x.innerText, focus: x.dataset.focus || null, btns: [...x.querySelectorAll('button')].map((b) => b.dataset.act) })));
  const run = async (l, fn) => { try { await fn(); results.push([l, 'PASS']); } catch (e) { results.push([l, 'FAIL ' + e.message]); } };

  await run('notification: nav badge + banner name the newest user and open the request', async () => {
    const { page, errors } = await open(mk());
    await page.waitForFunction(() => document.querySelector('.nav button[data-tab="addontools"] .nav-badge'));
    assert.equal(await page.$eval('.nav button[data-tab="addontools"] .nav-badge', (e) => e.textContent), '2');
    await page.waitForSelector('#at-req-notice');
    const t = await page.$eval('#at-req-notice', (e) => e.innerText); assert.match(t, /2 Developer Import access requests/); assert.match(t, /bob@x\.test/);
    await page.click('#at-req-notice [data-act="req-open"]'); await page.waitForSelector('#at-req-table');
    const r = await rows(page); assert.equal(r.length, 2); assert.equal(r.filter((x) => x.focus).length, 1); assert.equal(r.find((x) => x.focus).id, R2);
    assert.equal(await page.$('#at-req-notice'), null, 'banner is not shown inside the Developer Options view');
    assert.deepEqual(errors, []); await page.close();
  });
  await run('list: identity, date, message, status, rule state; actions only on pending; message is text not HTML', async () => {
    const { page, errors } = await open(mk()); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    const r = await rows(page); const a = r.find((x) => x.id === R1);
    assert.match(a.text, /alice@x\.test/); assert.match(a.text, /Alice/); assert.match(a.text, /I make add-ons/); assert.match(a.text, /Pending/); assert.match(a.text, /Nov/);
    if (process.env.MZ_SHOT) await page.screenshot({ path: process.env.MZ_SHOT });
    assert.deepEqual(a.btns, ['req-approve', 'req-decline']); assert.equal(r.find((x) => x.id === R2).text.includes('No message'), true);
    assert.equal(await page.evaluate(() => window.__xss), undefined, 'message HTML must not run'); assert.equal(await page.$('#at-req-table img'), null);
    await page.click('[data-req-filter="declined"]'); await page.waitForFunction(() => document.querySelectorAll('#at-req-table tbody tr').length === 1);
    const d = (await rows(page))[0]; assert.match(d.text, /Declined/); assert.match(d.text, /by admin2@x\.test/); assert.deepEqual(d.btns, []);
    await page.click('[data-req-filter="all"]'); await page.waitForFunction(() => document.querySelectorAll('#at-req-table tbody tr').length === 3);
    assert.deepEqual((await calls(page, 'admin_addon_tools_list_developer_requests')).map((c) => c.params.p_status).slice(-2), ['declined', null]);
    assert.deepEqual(errors, []); await page.close();
  });
  await run('approve: confirmation first (cancel = no call), then ONE call with request id + decision only, list + badge refresh', async () => {
    const { page, errors } = await open(mk()); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    await page.click(`tr[data-request="${R1}"] [data-act="req-approve"]`); await page.waitForSelector('.overlay');
    assert.match(await page.$eval('.overlay', (e) => e.innerText), /alice@x\.test gets a personal ON/);
    await page.click('.overlay .foot button:first-child'); await page.waitForFunction(() => !document.querySelector('.overlay'));
    assert.equal((await calls(page, 'admin_addon_tools_decide_developer_request')).length, 0, 'cancel must not call the server');
    await page.click(`tr[data-request="${R1}"] [data-act="req-approve"]`); await page.waitForSelector('.overlay');
    await page.click('.overlay .foot button:last-child'); await page.waitForFunction((id) => !document.querySelector(`tr[data-request="${id}"]`), R1);
    const c = await calls(page, 'admin_addon_tools_decide_developer_request'); assert.equal(c.length, 1);
    assert.deepEqual(c[0].params, { p_request_id: R1, p_decision: 'approved' }, 'no user id is sent');
    assert.match((await toastText(page)).join('|'), /Approved\. alice@x\.test now has Developer Options/);
    await page.waitForFunction(() => document.querySelector('.nav button[data-tab="addontools"] .nav-badge').textContent === '1');
    assert.equal((await rows(page)).length, 1); assert.deepEqual(errors, []); await page.close();
  });
  await run('approve while the global switch is OFF: says it is NOT active', async () => {
    const { page } = await open(mk({ global: false })); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    await page.click(`tr[data-request="${R1}"] [data-act="req-approve"]`); await page.waitForSelector('.overlay');
    assert.match(await page.$eval('.overlay', (e) => e.innerText), /switched off globally/);
    await page.click('.overlay .foot button:last-child'); await page.waitForFunction(() => document.querySelector('#toasts .toast'));
    const t = (await toastText(page)).join('|'); assert.match(t, /NOT allowed right now/); assert.doesNotMatch(t, /now has Developer Options/); await page.close();
  });
  await run('decline: confirmation, one call, says no access granted', async () => {
    const { page } = await open(mk()); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    await page.click(`tr[data-request="${R2}"] [data-act="req-decline"]`); await page.waitForSelector('.overlay');
    assert.match(await page.$eval('.overlay', (e) => e.innerText), /No access is granted/);
    await page.click('.overlay .foot button:last-child'); await page.waitForFunction(() => document.querySelector('#toasts .toast'));
    assert.deepEqual((await calls(page, 'admin_addon_tools_decide_developer_request')).map((c) => c.params), [{ p_request_id: R2, p_decision: 'declined' }]);
    assert.match((await toastText(page)).join('|'), /declined\. No access was granted/); await page.close();
  });
  await run('already decided by someone else: no success message, list refreshed', async () => {
    const { page } = await open(mk({ decideMode: 'already' })); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    await page.click(`tr[data-request="${R1}"] [data-act="req-approve"]`); await page.click('.overlay .foot button:last-child');
    await page.waitForFunction(() => document.querySelector('#toasts .toast')); const t = (await toastText(page)).join('|');
    assert.match(t, /already decided by other-admin@x\.test/); assert.doesNotMatch(t, /Approved\./);
    await page.waitForFunction((id) => !document.querySelector(`tr[data-request="${id}"]`), R1); await page.close();
  });
  await run('personal OFF refusal is shown as an error and nothing is reported as approved', async () => {
    const { page } = await open(mk({ decideMode: 'personal_off' })); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    await page.click(`tr[data-request="${R1}"] [data-act="req-approve"]`); await page.click('.overlay .foot button:last-child');
    await page.waitForFunction(() => document.querySelector('#toasts .toast.err')); assert.match((await toastText(page)).join('|'), /personal OFF/); await page.close();
  });
  await run('a reply that does not confirm this request is NOT shown as success', async () => {
    const { page } = await open(mk({ decideMode: 'unconfirmed' })); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-req-table');
    await page.click(`tr[data-request="${R1}"] [data-act="req-approve"]`); await page.click('.overlay .foot button:last-child');
    await page.waitForFunction(() => document.querySelector('#toasts .toast.err')); assert.match((await toastText(page)).join('|'), /did not confirm/); await page.close();
  });
  await run('server without 0038: clear message, rest of Developer Options still works, no badge / banner', async () => {
    const { page, errors } = await open(mk({ noRpc: true })); await page.click('[data-view="developer"]'); await page.waitForSelector('#at-dev-settings');
    await page.waitForFunction(() => /not installed on this server/.test(document.querySelector('#at-dev-requests').innerText));
    assert.match(await page.$eval('#at-dev-requests', (e) => e.innerText), /0038/); assert.ok(await page.$('#at-dev-search'));
    assert.equal(await page.$('.nav button[data-tab="addontools"] .nav-badge'), null); assert.deepEqual(errors, []); await page.close();
  });
  await run('empty pending list', async () => {
    const { page } = await open(mk({ requests: [] })); await page.click('[data-view="developer"]'); await page.waitForFunction(() => /No pending requests/.test(document.querySelector('#at-dev-requests').innerText));
    assert.equal(await page.$('.nav button[data-tab="addontools"] .nav-badge'), null); await page.close();
  });
  await browser.close(); server.close();
  let bad = 0; for (const [l, r] of results) { console.log((r === 'PASS' ? 'ok   ' : 'FAIL ') + l + (r === 'PASS' ? '' : '  ' + r)); if (r !== 'PASS') bad++; }
  console.log(`\n${results.length - bad}/${results.length} passed`); process.exit(bad ? 1 : 0);
})();
