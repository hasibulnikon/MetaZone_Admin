// Step 22A browser smoke test: the REAL admin.js / addon_logic.js / admin.css in Chromium against a STUBBED supabase client.
// It proves that Overview and Users render and behave WITHOUT any Adobe Tracker database dependency. It is NOT a SQL / Supabase test.
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/overview_users.smoke.js
// The stub has NO handler for admin_tracker_search_stats (a call to it is answered with an error and recorded), and the stubbed
// admin_list_users still returns a `tracker_searches` field exactly like the current server does (0008): the page must ignore it.
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT || path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const STUB = `
window.__calls = [];
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push({ name, params }); const h = window.__STUB__.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.data, error: null }; },
  storage: { from: () => ({}) },
}) };`;

const OVERVIEW = { users: { total: 12, active_now: 3, active_today: 5, free: 9, premium: 3, expired_premium: 1, suspended: 2 },
  generations: { total: 400, today: 20, week: 90, month: 300, free: 250, premium: 150, failed: 8 },
  subscriptions: { active_premium: 3, expiring_soon: 1, expired: 1, recently_activated: 2 },
  app: { latest_version: 'v1.0.0', users_by_version: { 'v1.0.0': 7, 'v0.9.9.10': 5 } } };
const U = (n, o) => ({ id: 'id-' + n, email: n + '@x.com', nickname: '', plan: 'free', status: 'active', premium_expires_at: null, today: 1, week: 2, month: 3, total: 4,
  last_seen_at: new Date().toISOString(), app_version: 'v1.0.0', is_admin: false, tracker_searches: 77, tracker_searches_today: 5, ...o });
const USERS = [U('free1'), U('prem1', { plan: 'premium', premium_expires_at: '2030-01-01T00:00:00Z' }), U('sus1', { status: 'suspended' })];
const SCENARIOS = {
  normal: { rpc: { admin_overview: { data: OVERVIEW }, admin_get_config: { data: { online_threshold_seconds: 600 } }, admin_list_users: { data: USERS },
    admin_user_detail: { data: { plan: 'free', profile: { status: 'active', created_at: '2026-01-01T00:00:00Z' }, usage_by_day: [], subscription_history: [], recent_events: [] } } } },
};

(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch();
  const results = [];
  const open = async (tab, ready) => {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, SCENARIOS.normal);
    await page.goto(url);
    await page.waitForSelector(`.nav button[data-tab="${tab}"]`);
    await page.click(`.nav button[data-tab="${tab}"]`);
    await page.waitForSelector(ready);
    return { page, errors };
  };
  const calls = (page) => page.evaluate(() => window.__calls.map((c) => c.name));
  const run = async (label, fn) => { try { await fn(); results.push([label, 'PASS']); } catch (e) { results.push([label, 'FAIL ' + e.message]); } };

  await run('Overview: renders every generic panel, no Tracker panel, no admin_tracker_search_stats call, no page error', async () => {
    const { page, errors } = await open('overview', '#stats-versions');
    for (const id of ['#stats-users', '#stats-gen', '#stats-subs', '#stats-versions']) assert.ok(await page.$(id), id + ' missing');
    assert.equal(await page.$('#stats-tracker'), null);
    const text = await page.$eval('main, #main, body', (e) => e.innerText);
    assert.ok(!/tracker/i.test(text), 'Overview still mentions Tracker: ' + text.match(/.{0,30}tracker.{0,30}/i));
    assert.match(text, /total users/i); assert.match(text, /generations/i); assert.match(text, /subscriptions/i); assert.match(text, /latest: v1\.0\.0/i);   // headings are upper-cased by CSS
    assert.equal(await page.$$eval('#stats-gen .mini .stat', (l) => l.length), 4);
    const c = await calls(page); assert.ok(!c.includes('admin_tracker_search_stats'), 'admin_tracker_search_stats was called'); assert.ok(c.includes('admin_overview'));
    assert.deepEqual(errors, []); await page.close();
  });

  await run('Overview: Refresh keeps working and still never calls the Tracker RPC', async () => {
    const { page, errors } = await open('overview', '#btn-refresh');
    await page.click('#btn-refresh'); await page.waitForTimeout(300);
    const c = await calls(page); assert.ok(c.filter((n) => n === 'admin_overview').length >= 2); assert.ok(!c.includes('admin_tracker_search_stats'));
    assert.ok(await page.$('#stats-gen')); assert.deepEqual(errors, []); await page.close();
  });

  await run('Users: six generic columns, no Tracker column, tracker_searches from the server is ignored', async () => {
    const { page, errors } = await open('users', '#user-rows tr');
    const heads = await page.$$eval('#users-table thead th', (l) => l.map((x) => x.innerText.trim()));
    assert.deepEqual(heads, ['Nickname', 'Email', 'Plan', 'Usage', 'Last seen', 'Actions']);
    assert.equal(await page.$$eval('#user-rows tr', (l) => l.length), 3);
    assert.deepEqual(await page.$$eval('#user-rows tr', (l) => l.map((r) => r.children.length)), [6, 6, 6]);
    assert.equal(await page.$('#user-rows td.c-tracker'), null);
    const tableText = await page.$eval('#users-table', (e) => e.innerText);
    assert.ok(!/tracker|searches|\b77\b/i.test(tableText), 'Users table shows Tracker data: ' + tableText.slice(0, 200));
    assert.match(tableText, /free1@x\.com/); assert.match(tableText, /premium/i); assert.match(tableText, /suspended/i);
    for (const act of ['premium', 'pages', 'suspend', 'details', 'delete']) assert.equal(await page.$$eval(`#user-rows [data-act="${act}"]`, (l) => l.length), 3, act);
    assert.ok(!(await calls(page)).includes('admin_tracker_search_stats')); assert.deepEqual(errors, []); await page.close();
  });

  await run('Users: plan / status filters and the Details and Delete dialogs still work and mention no Tracker', async () => {
    const { page, errors } = await open('users', '#user-rows tr');
    await page.click('#users-table ~ * [data-v="premium"], .filters [data-v="premium"]');
    assert.deepEqual(await page.$$eval('#user-rows tr:not([hidden])', (l) => l.map((r) => r.dataset.email)), ['prem1@x.com']);
    await page.click('.filters [data-v=""]');                                   // first "All" segment resets the plan filter
    assert.equal(await page.$$eval('#user-rows tr:not([hidden])', (l) => l.length), 3);
    await page.click('#user-rows tr[data-email="free1@x.com"] [data-act="details"]');
    await page.waitForSelector('.modal, .overlay');
    const dtext = await page.$eval('.modal, .overlay', (e) => e.innerText); assert.ok(!/tracker/i.test(dtext), 'Details dialog mentions Tracker');
    await page.keyboard.press('Escape'); await page.evaluate(() => document.querySelectorAll('.modal, .overlay').forEach((e) => e.remove()));
    await page.click('#user-rows tr[data-email="free1@x.com"] [data-act="delete"]');
    await page.waitForSelector('#del-user-email');
    const del = await page.$eval('.modal, .overlay', (e) => e.innerText);
    assert.ok(!/tracker/i.test(del), 'Delete dialog mentions Tracker'); assert.match(del, /usage history/i); assert.match(del, /cannot be undone/i);
    assert.deepEqual(errors, []); await page.close();
  });

  await browser.close(); server.close();
  let bad = 0; for (const [l, r] of results) { console.log((r === 'PASS' ? 'PASS  ' : 'FAIL  ') + l + (r === 'PASS' ? '' : '\n      ' + r)); if (r !== 'PASS') bad++; }
  console.log(`\n${results.length - bad}/${results.length} scenarios passed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
