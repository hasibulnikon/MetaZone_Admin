// Step 2.1 browser smoke test (updated in Step 2.2: the panel now has exactly two kinds of controls, see below): renders the REAL admin.js / addon_logic.js / admin.css in Chromium against a STUBBED supabase client.
// It proves rendering + error isolation + "nothing is written while rendering" only. It does NOT test SQL, PostgreSQL, Supabase, RLS or any real RPC.
//
// Needs Playwright for Node and a Chromium build, e.g.:
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/addon_manager_list.smoke.js
// (kept outside test/ on purpose, so a plain `node --test` does not pick it up and fail where Playwright is missing)
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const STUB = `
window.__calls = [];
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push(name); const h = window.__STUB__.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.data, error: null }; },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'stub' } }), remove: async () => ({ error: { message: 'stub' } }), createSignedUrl: async () => ({ error: { message: 'stub' } }) }) },
}) };`;

const release = { addon_id: 'converter_image', version: '1.0.0', seq: 1, channel: 'stable', size: 5000, sha256: 'a'.repeat(64), title: 'Image Converter', feature_key: 'converter_image',
  published_at: '2026-01-01T00:00:00Z', yanked: false, is_active: true, selectable: true };
const base = (listRpc) => ({ rpc: { admin_overview: { data: {} }, admin_list_addon_releases: { data: [release] }, admin_list_pages: { data: [{ page_key: 'converter_image' }] },
  admin_get_addon_selection: { data: [] }, admin_list_addons: listRpc } });
const row = (o) => ({ addon_id: 'converter_image', name: 'Image Converter', description: 'Converts images', registered: true, feature_key: 'converter_image', release_count: 3, yanked_count: 1,
  latest_version: '1.2.0', deleted_count: 2, mode: 'pinned', active_version: '1.1.0', previous_version: null, revision: 4, effective_version: '1.1.0', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', ...o });
const XSS = '<img src=x onerror="window.__xss=1"><b>bold</b>';
const SCENARIOS = {
  list: base({ data: [row(), row({ addon_id: 'tracker', name: XSS, description: XSS, registered: false, release_count: 1, yanked_count: 0, deleted_count: 0, latest_version: '0.3.0', mode: 'none', active_version: null, effective_version: null, updated_at: null }),
    row({ addon_id: 'auto_one', name: 'Auto One', mode: 'auto', active_version: null, effective_version: '2.0.0', latest_version: '2.0.0' }),
    row({ addon_id: 'empty_one', name: 'Empty One', release_count: 0, yanked_count: 0, deleted_count: 0, latest_version: null, feature_key: null, mode: 'none', active_version: null, effective_version: null })] }),
  empty: base({ data: [] }),
  missing: base({ error: 'Could not find the function public.admin_list_addons without parameters in the schema cache' }),
  failed: base({ error: 'forbidden' }),
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
  const outDir = process.env.MZ_SHOTS || null;
  try {
    for (const [name, data] of Object.entries(SCENARIOS)) {
      const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
      await page.addInitScript((d) => { window.__STUB__ = d; }, data);
      await page.goto(url);
      await page.waitForSelector('.nav button[data-tab="addons"]');
      await page.click('.nav button[data-tab="addons"]');
      await page.waitForSelector('#addon-manager');
      await page.waitForSelector('#addon-release-rows tr[data-addon="converter_image"]');         // the pre-existing release table still renders in EVERY scenario
      const calls = await page.evaluate(() => window.__calls);
      assert.ok(calls.includes('admin_list_addons'), name + ': the real RPC name was called');
      const writes = calls.filter((c) => /upsert|delete|replace|withdraw|publish|yank|set_addon|clear_addon|restore/.test(c));
      assert.deepEqual(writes, [], name + ': rendering must not call any write RPC, got ' + writes);
      // Step 2.2: the panel may contain ONLY the "New add-on" button and one Edit/Register button per row (plus Step 2.3's Versions) (when the list loaded); no inputs/links while rendering
      assert.equal(await page.locator('#addon-manager input, #addon-manager a, #addon-manager textarea, #addon-manager select').count(), 0, name + ': no inputs or links in the panel');
      const btns = await page.locator('#addon-manager button').evaluateAll((els) => els.map((e) => e.id || e.getAttribute('data-act')));
      // Step 2.3: a row with releases also has a "Versions" button (scrolls to the version history); a row without releases has only Edit
      const listButtons = ['btn-addon-new', 'show-versions', 'edit-addon', 'delete-addon', 'show-versions', 'edit-addon', 'delete-addon', 'show-versions', 'edit-addon', 'delete-addon', 'edit-addon', 'delete-addon'];   // Step 2.5 added 'delete-addon' per row (opens a window only; rendering still calls no write RPC). converter_image, tracker, auto_one (3 releases / 1 / 3), empty_one (0)
      assert.deepEqual(btns, name === 'list' ? listButtons : name === 'empty' ? ['btn-addon-new'] : [], name + ': only the expected buttons, got ' + btns);
      assert.deepEqual(errors, [], name + ': no page errors');

      if (name === 'list') {
        const rows = page.locator('#addon-manager-rows tr');
        assert.equal(await rows.count(), 4);
        const t = (id) => page.locator(`#addon-manager-rows tr[data-addon="${id}"]`).innerText();
        const a = await t('converter_image');
        assert.match(a, /Image Converter/); assert.match(a, /3 releases/); assert.match(a, /1 yanked/); assert.match(a, /2 deleted/); assert.match(a, /1\.2\.0/); assert.match(a, /v1\.1\.0 \(chosen by you\)/); assert.match(a, /Registered/);
        const tr = await t('tracker'); assert.match(tr, /Not registered/); assert.match(tr, /Not set: users are offered nothing/); assert.match(tr, /1 release\b/);
        assert.match(await t('auto_one'), /Automatic: newest = v2\.0\.0/);
        assert.match(await t('empty_one'), /No releases: nothing offered/);
        assert.match(await page.locator('#addon-manager-summary').innerText(), /4 add-ons · 2 offered to users · 2 not offered\./);
        assert.equal(await page.evaluate(() => window.__xss === undefined), true, 'description/name from the server must never be executed');
        assert.equal(await page.locator('#addon-manager img, #addon-manager b:text-is("bold")').count(), 0, 'HTML in a name/description is shown as text, not parsed');
        assert.ok((await t('tracker')).includes('<img src=x'), 'the raw text is visible');
      }
      if (name === 'empty') assert.match(await page.locator('#addon-manager-rows').innerText(), /No add-ons yet\./);
      if (name === 'missing') { const e = page.locator('#addon-manager-error'); assert.match(await e.innerText(), /migration 0014 has not been applied/); assert.equal(await e.getAttribute('data-missing'), '1'); assert.equal(await page.locator('#addon-manager-table').count(), 0); }
      if (name === 'failed') { const e = page.locator('#addon-manager-error'); assert.match(await e.innerText(), /Could not load the add-on list: forbidden/); assert.equal(await e.getAttribute('data-missing'), '0'); }
      if (outDir) await page.screenshot({ path: path.join(outDir, `addons_${name}.png`), fullPage: true });
      results.push(name); await page.close();
    }
    console.log('PASS scenarios: ' + results.join(', '));
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
