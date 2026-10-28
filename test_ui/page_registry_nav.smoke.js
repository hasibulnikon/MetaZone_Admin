// Step 4.B browser smoke: the REAL admin.js / addon_logic.js in Chromium against a STUBBED supabase client. UI behaviour only; NOT a SQL test.
//   NODE_PATH=$(npm root -g) node test_ui/page_registry_nav.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT || path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const STUB = `
window.__calls = [];
window.__FN__ = { nav: (p) => ({ page_key: p.p_key, nav_visible: p.p_visible }), reg: (p) => ({ page_key: p.p_key, kind: 'page', label: p.p_label, enabled: false }) };
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push({ name, params }); const h = window.__STUB__.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.fn ? window.__FN__[h.fn](params) : h.data, error: null }; },
  storage: { from: () => ({}) },
}) };`;
const P = (k, label, o) => ({ page_key: k, label, kind: 'page', enabled: true, locked: false, protected: false, enabled_free: true, enabled_premium: true, overrides_on: 0, overrides_off: 0, ...o });
const PAGES = [P('dashboard', 'Home', { locked: true, protected: true }), P('meta', 'Meta'), P('tracker', 'Tracker'), P('appearance', 'Settings', { locked: true, protected: true }), P('converter_image', 'Img', { kind: 'addon' })];
const PL = [{ page_key: 'dashboard', nav_visible: true, core: true, protected: true }, { page_key: 'meta', nav_visible: true, core: true, protected: false },
  { page_key: 'tracker', nav_visible: false, core: false, protected: false }, { page_key: 'appearance', nav_visible: true, core: true, protected: true }];
const base = (extra) => ({ rpc: { admin_overview: { data: {} }, admin_list_pages: { data: PAGES }, admin_list_control_audit: { data: [] }, get_my_dashboard_shortcuts: { data: { shortcuts: ['dashboard', 'appearance'] } },
  admin_list_page_placement: { data: PL }, ...extra } });
const SC = {
  normal: base({ admin_set_page_nav_visible: { fn: 'nav' }, admin_register_page: { fn: 'reg' } }),
  missing: base({ admin_list_page_placement: { error: 'Could not find the function public.admin_list_page_placement without parameters in the schema cache' }, admin_register_page: { error: 'Could not find the function public.admin_register_page(p_key, p_label) in the schema cache' } }),
  unconfirmed: base({ admin_set_page_nav_visible: { data: { page_key: 'meta', nav_visible: true } } }),
};
(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(); const results = [];
  const open = async (name) => {
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, SC[name]);
    await page.goto(url); await page.waitForSelector('.nav button[data-tab="pages"]'); await page.click('.nav button[data-tab="pages"]');
    await page.waitForSelector('#register-page-card'); await page.waitForSelector('#page-rows tr[data-page="meta"]');
    return { page, errors };
  };
  const calls = (page, n) => page.evaluate((n) => window.__calls.filter((c) => c.name === n), n);
  const run = async (l, fn) => { try { await fn(); results.push([l, 'PASS']); } catch (e) { results.push([l, 'FAIL ' + e.message]); } };

  await run('nav column: Home/Settings always shown, others switchable, add-on features have none', async () => {
    const { page, errors } = await open('normal');
    const t = (k) => page.$eval(`#page-rows tr[data-page="${k}"] [data-col="nav"]`, (e) => e.innerText.trim());
    assert.equal(await t('dashboard'), 'Always shown'); assert.equal(await t('appearance'), 'Always shown');
    assert.equal(await t('meta'), 'Shown'); assert.equal(await t('tracker'), 'Hidden');
    assert.equal(await page.$eval('#addon-rows tr[data-page="converter_image"] [data-col="nav"]', (e) => e.innerText.trim()), '—');
    assert.deepEqual(errors, []); await page.close();
  });
  await run('clicking Shown calls admin_set_page_nav_visible(false) and never touches enabled', async () => {
    const { page } = await open('normal');
    await page.click('#page-rows tr[data-page="meta"] [data-act="nav"]'); await page.waitForTimeout(300);
    const c = await calls(page, 'admin_set_page_nav_visible'); assert.deepEqual(c.map((x) => x.params), [{ p_key: 'meta', p_visible: false }]);
    assert.equal((await calls(page, 'admin_set_page_enabled')).length, 0); await page.close();
  });
  await run('a server answer that does not echo the change is shown as NOT changed', async () => {
    const { page } = await open('unconfirmed');
    await page.click('#page-rows tr[data-page="meta"] [data-act="nav"]'); await page.waitForTimeout(200);
    assert.match(await page.$eval('body', (e) => e.innerText), /Not changed/); await page.close();
  });
  await run('register: bad / core keys are refused in the browser before any RPC', async () => {
    const { page } = await open('normal');
    for (const [k, l] of [['meta', 'X'], ['Bad Key', 'X'], ['tracker', 'X'], ['zz_ok', '']]) {
      await page.fill('#reg-key', k); await page.fill('#reg-label', l); await page.click('[data-act="register-page"]');
      assert.ok((await page.$eval('#reg-msg', (e) => e.innerText)).length > 0, k);
    }
    assert.equal((await calls(page, 'admin_register_page')).length, 0); await page.close();
  });
  await run('register: valid key sends exactly p_key / p_label and the page list reloads', async () => {
    const { page } = await open('normal');
    await page.fill('#reg-key', 'zz_new'); await page.fill('#reg-label', '  New tool '); await page.click('[data-act="register-page"]'); await page.waitForTimeout(1200);
    assert.deepEqual((await calls(page, 'admin_register_page')).map((x) => x.params), [{ p_key: 'zz_new', p_label: 'New tool' }]);
    assert.ok((await calls(page, 'admin_list_pages')).length >= 2); await page.close();
  });
  await run('migration 0016 missing: clear messages, no fake success, rest of Pages still renders', async () => {
    const { page, errors } = await open('missing');
    assert.match(await page.$eval('#register-page-card', (e) => e.innerText), /0016/);
    assert.equal(await page.$eval('#page-rows tr[data-page="meta"] [data-col="nav"]', (e) => e.innerText.trim()), 'needs 0016');
    await page.fill('#reg-key', 'zz_new'); await page.fill('#reg-label', 'N'); await page.click('[data-act="register-page"]'); await page.waitForTimeout(200);
    assert.match(await page.$eval('#reg-msg', (e) => e.innerText), /0016.*not applied/); assert.deepEqual(errors, []); await page.close();
  });
  await browser.close(); server.close();
  let fail = 0; for (const [l, r] of results) { console.log(r.startsWith('PASS') ? 'PASS ' : 'FAIL ', l, r.startsWith('PASS') ? '' : r); if (!r.startsWith('PASS')) fail++; }
  console.log(`${results.length - fail}/${results.length} scenarios passed`); process.exit(fail ? 1 : 0);
})();
