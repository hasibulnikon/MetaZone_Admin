// Step 4.3A browser smoke test: the REAL admin.js / addon_logic.js / admin.css in Chromium against a STUBBED supabase client (a small stateful
// fake of get_my_dashboard_shortcuts / admin_set_dashboard_shortcuts). It proves UI behaviour only; it is NOT a SQL / Supabase test.
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/dashboard_shortcuts.smoke.js
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
    if (h.delay) await new Promise((r) => setTimeout(r, h.delay));
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.echo ? { shortcuts: params.p_keys } : h.data, error: null }; },
  storage: { from: () => ({}) },
}) };`;

const P = (k, label, o) => ({ page_key: k, label, kind: 'page', enabled: true, locked: false, protected: false, enabled_free: true, enabled_premium: true, overrides_on: 0, overrides_off: 0, ...o });
const PAGES = [P('dashboard', 'Home', { locked: true, protected: true }), P('meta', 'Meta'), P('prompt', 'Prompt'), P('embed', 'Embed'), P('p2p', 'Prompt to Prompt'), P('automation', 'Automation'),
  P('tracker', 'Tracker', { enabled: false }), P('converter', 'Converter'), P('appearance', 'Settings', { locked: true, protected: true }), P('converter_image', 'Image converter', { kind: 'addon' })];
const DEFAULT = ['dashboard', 'meta', 'embed', 'p2p', 'automation', 'appearance'];
const base = (get, set) => ({ rpc: { admin_overview: { data: {} }, admin_list_pages: { data: PAGES }, admin_list_control_audit: { data: [] }, get_my_dashboard_shortcuts: get, admin_set_dashboard_shortcuts: set } });
const ok = (keys) => ({ data: { shortcuts: keys } });
const SCENARIOS = {
  normal: base({ data: { shortcuts: DEFAULT } }, { delay: 500, echo: true }),
  save_error: base({ data: { shortcuts: DEFAULT } }, { error: 'shortcut list refused: forbidden' }),
  not_confirmed: base({ data: { shortcuts: DEFAULT } }, { data: { shortcuts: DEFAULT } }),
  nine: base({ data: { shortcuts: ['dashboard', 'meta', 'prompt', 'embed', 'p2p', 'automation', 'tracker', 'converter', 'appearance'] } }, { echo: true }),
  missing_get: base({ error: 'Could not find the function public.get_my_dashboard_shortcuts without parameters in the schema cache' }, { error: 'x' }),
  missing_set: base({ data: { shortcuts: DEFAULT } }, { error: 'Could not find the function public.admin_set_dashboard_shortcuts(p_keys) in the schema cache' }),
  load_error: base({ error: 'network down' }, { error: 'x' }),
  bad_shape: base({ data: { nope: 1 } }, { error: 'x' }),
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
  const open = async (name) => {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, SCENARIOS[name]);
    await page.goto(url);
    await page.waitForSelector('.nav button[data-tab="pages"]');
    await page.click('.nav button[data-tab="pages"]');
    await page.waitForSelector('#shortcuts-card');
    await page.waitForFunction(() => !document.querySelector('#shortcuts-body [data-state="loading"]'));
    return { page, errors };
  };
  const keys = (page) => page.$$eval('#shortcuts-list > li', (l) => l.map((x) => x.dataset.key));
  const writes = (page) => page.evaluate(() => window.__calls.filter((c) => c.name === 'admin_set_dashboard_shortcuts'));
  const text = (page) => page.$eval('#shortcuts-body', (e) => e.innerText);
  const dis = (page, sel) => page.$eval(sel, (e) => e.disabled);
  const run = async (label, fn) => { try { await fn(); results.push([label, 'PASS']); } catch (e) { results.push([label, 'FAIL ' + e.message]); } };

  await run('loads the list with get_my_dashboard_shortcuts; Home and Settings cannot be removed; Save disabled; nothing written', async () => {
    const { page, errors } = await open('normal');
    assert.deepEqual(await keys(page), DEFAULT);
    assert.ok((await page.evaluate(() => window.__calls.map((c) => c.name))).includes('get_my_dashboard_shortcuts'));
    for (const k of ['dashboard', 'appearance']) assert.equal(await dis(page, `#shortcuts-list li[data-key="${k}"] [data-act="sc-remove"]`), true);
    assert.equal(await dis(page, '#shortcuts-list li[data-key="meta"] [data-act="sc-remove"]'), false);
    assert.equal(await dis(page, '[data-act="sc-save"]'), true);
    assert.match(await text(page), /6 of 9/);
    assert.equal((await writes(page)).length, 0);
    const opts = await page.$$eval('#shortcuts-add-select option', (o) => o.map((x) => x.value));
    assert.deepEqual(opts, ['prompt', 'tracker', 'converter']);            // add-on switch converter_image and settings alias are not offered
    assert.deepEqual(errors, []); await page.close();
  });
  await run('add / move / remove edit only the draft (no write), then Save sends exactly { p_keys } once and success appears only AFTER the server answers', async () => {
    const { page, errors } = await open('normal');
    await page.selectOption('#shortcuts-add-select', 'prompt'); await page.click('[data-act="sc-add"]');
    await page.click('#shortcuts-list li[data-key="prompt"] [data-act="sc-up"]');
    await page.click('#shortcuts-list li[data-key="embed"] [data-act="sc-remove"]');
    assert.deepEqual(await keys(page), ['dashboard', 'meta', 'p2p', 'automation', 'prompt', 'appearance']);
    assert.equal((await writes(page)).length, 0);
    assert.match(await text(page), /Unsaved changes/);
    await page.click('[data-act="sc-save"]');
    await page.waitForFunction(() => /Saving/.test(document.querySelector('#shortcuts-body').innerText));
    assert.doesNotMatch(await text(page), /Saved\./);                        // the server has not answered yet (500 ms stub delay)
    assert.equal(await dis(page, '[data-act="sc-save"]'), true);
    assert.equal(await dis(page, '[data-act="sc-add"]'), true);
    await page.waitForFunction(() => /Saved\./.test(document.querySelector('#shortcuts-body').innerText));
    const w = await writes(page); assert.equal(w.length, 1);
    assert.deepEqual(w[0].params, { p_keys: ['dashboard', 'meta', 'p2p', 'automation', 'prompt', 'appearance'] });
    assert.deepEqual(await keys(page), w[0].params.p_keys);
    assert.equal(await dis(page, '[data-act="sc-save"]'), true);              // clean again
    assert.deepEqual(errors, []); await page.close();
  });
  await run('server error: no success message, draft kept, still unsaved, error shown', async () => {
    const { page, errors } = await open('save_error');
    await page.click('#shortcuts-list li[data-key="meta"] [data-act="sc-remove"]'); await page.click('[data-act="sc-save"]');
    await page.waitForFunction(() => /Not saved/.test(document.querySelector('#shortcuts-body').innerText));
    const t = await text(page); assert.doesNotMatch(t, /Saved\./); assert.match(t, /forbidden/);
    assert.deepEqual(await keys(page), ['dashboard', 'embed', 'p2p', 'automation', 'appearance']);
    assert.equal(await dis(page, '[data-act="sc-save"]'), false);             // can retry
    assert.equal((await writes(page)).length, 1);
    await page.click('[data-act="sc-reload"]'); await page.waitForFunction(() => !/Not saved/.test(document.querySelector('#shortcuts-body').innerText));
    assert.deepEqual(await keys(page), DEFAULT);                              // reload shows what the server really has
    assert.deepEqual(errors, []); await page.close();
  });
  await run('server answer that is not the list that was sent is NOT shown as success', async () => {
    const { page, errors } = await open('not_confirmed');
    await page.click('#shortcuts-list li[data-key="meta"] [data-act="sc-remove"]'); await page.click('[data-act="sc-save"]');
    await page.waitForFunction(() => /NOT confirmed/.test(document.querySelector('#shortcuts-body').innerText));
    assert.doesNotMatch(await text(page), /Saved\./);
    assert.deepEqual(errors, []); await page.close();
  });
  await run('limit of 9: Add is disabled when full; a full list can still be reordered', async () => {
    const { page, errors } = await open('nine');
    assert.equal(await dis(page, '[data-act="sc-add"]'), true); assert.equal(await dis(page, '#shortcuts-add-select'), true);
    assert.match(await text(page), /9 of 9 \(full\)/);
    await page.click('#shortcuts-list li[data-key="tracker"] [data-act="sc-up"]');
    assert.equal(await dis(page, '[data-act="sc-save"]'), false);
    assert.deepEqual(errors, []); await page.close();
  });
  await run('Reset to default only fills the editor (no write) until Save; Save then sends the default', async () => {
    const { page, errors } = await open('nine');
    await page.click('[data-act="sc-default"]');
    assert.deepEqual(await keys(page), DEFAULT); assert.equal((await writes(page)).length, 0);
    assert.match(await text(page), /NOT saved until you press Save/);
    await page.click('[data-act="sc-save"]'); await page.waitForFunction(() => /Saved\./.test(document.querySelector('#shortcuts-body').innerText));
    assert.deepEqual((await writes(page))[0].params, { p_keys: DEFAULT });
    assert.deepEqual(errors, []); await page.close();
  });
  await run('migration 0015 missing (reader): clear message, no editor, no write', async () => {
    const { page, errors } = await open('missing_get');
    assert.match(await text(page), /Migration 0015/); assert.equal(await page.$('#shortcuts-list'), null); assert.equal((await writes(page)).length, 0);
    assert.deepEqual(errors, []); await page.close();
  });
  await run('migration 0015 missing (writer): message instead of a fake success', async () => {
    const { page, errors } = await open('missing_set');
    await page.click('#shortcuts-list li[data-key="meta"] [data-act="sc-remove"]'); await page.click('[data-act="sc-save"]');
    await page.waitForFunction(() => /Migration 0015/.test(document.querySelector('#shortcuts-body').innerText));
    assert.doesNotMatch(await text(page), /Saved\./);
    assert.deepEqual(errors, []); await page.close();
  });
  await run('load error / unusable answer: error + Try again, no editor, rest of the Pages tab still renders', async () => {
    for (const n of ['load_error', 'bad_shape']) {
      const { page, errors } = await open(n);
      assert.match(await text(page), /Could not load|not with a shortcut list/); assert.equal(await page.$('#shortcuts-list'), null);
      assert.ok(await page.$('#page-rows tr[data-page="meta"]')); assert.deepEqual(errors, []); await page.close();
    }
  });

  await browser.close(); server.close();
  let bad = 0; for (const [l, r] of results) { console.log((r === 'PASS' ? 'PASS  ' : 'FAIL  ') + l + (r === 'PASS' ? '' : '\n      ' + r)); if (r !== 'PASS') bad++; }
  console.log(`\n${results.length - bad}/${results.length} scenarios passed`); process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
