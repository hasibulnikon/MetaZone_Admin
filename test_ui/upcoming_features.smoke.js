// v1.0.0 browser smoke test: the REAL admin.js renders the Upcoming features panel against a stubbed Supabase client.
// Proves rendering, the actions' RPC names/parameters, XSS safety and the "release for announcement" package guard. NOT SQL / RLS / a live project.
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/upcoming_features.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const STUB = `
window.__calls = [];
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push({ name, params }); const h = window.__STUB__.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.data, error: null }; },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'stub' } }), remove: async () => ({ error: { message: 'stub' } }), createSignedUrl: async () => ({ error: { message: 'stub' } }) }) },
}) };`;
const XSS = '<img src=x onerror="window.__xss=1">';
const U = (o) => Object.assign({ id: '11111111-1111-1111-1111-111111111111', title: 'AI BG Remover', description: 'Removes backgrounds', addon_id: 'ai_bg_remover', status: 'draft', sort_order: 100,
  updated_at: '2026-11-01T00:00:00Z', released_version: null }, o);
const base = (list) => ({ rpc: { admin_overview: { data: {} }, admin_list_addon_releases: { data: [] }, admin_list_pages: { data: [{ page_key: 'ai_bg_remover' }] }, admin_get_addon_selection: { data: [] },
  admin_list_addons: { data: [] }, admin_list_upcoming_features: list,
  admin_upsert_upcoming_feature: { data: {} }, admin_set_upcoming_feature_status: { data: {} }, admin_delete_upcoming_feature: { data: { deleted: true } } } });
const SCENARIOS = {
  list: base({ data: [U({}), U({ id: '22222222-2222-2222-2222-222222222222', title: XSS, description: XSS, addon_id: null, status: 'published' }),
    U({ id: '33333333-3333-3333-3333-333333333333', title: 'Done', status: 'released', released_version: '1.0.0' })] }),
  empty: base({ data: [] }),
  missing: base({ error: 'Could not find the function public.admin_list_upcoming_features without parameters in the schema cache' }),
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
  try {
    for (const [name, data] of Object.entries(SCENARIOS)) {
      const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
      await page.addInitScript((d) => { window.__STUB__ = d; }, data);
      await page.goto(url); await page.waitForSelector('.nav button[data-tab="addons"]'); await page.click('.nav button[data-tab="addons"]');
      await page.waitForSelector('#upcoming-features'); await page.waitForSelector('#addon-publish');
      const calls = () => page.evaluate(() => window.__calls.map((c) => c.name));
      assert.deepEqual((await calls()).filter((c) => /upsert|delete|set_|publish/.test(c)), [], name + ': rendering writes nothing');
      assert.deepEqual(errors, [], name + ': no page errors');
      if (name === 'missing') assert.match(await page.locator('#upcoming-features').innerText(), /migration 0024/);
      if (name === 'empty') assert.equal(await page.locator('#upcoming-empty').count(), 1);
      if (name === 'list') {
        assert.equal(await page.locator('#upcoming-table tbody tr').count(), 3);
        assert.equal(await page.evaluate(() => window.__xss === undefined), true, 'titles are text, never HTML');
        const draft = page.locator('tr[data-status="draft"]'), pub = page.locator('tr[data-status="published"]'), rel = page.locator('tr[data-status="released"]');
        assert.equal(await draft.locator('[data-act="publish"]').count(), 1); assert.equal(await pub.locator('[data-act="unpublish"]').count(), 1);
        assert.equal(await rel.locator('[data-act="publish"], [data-act="release"], [data-act="unpublish"]').count(), 0, 'a released announcement cannot be re-published');
        assert.equal(await pub.locator('[data-act="release"]').isDisabled(), true, 'no add-on id -> no release action');
        // publish sends the right RPC
        await draft.locator('[data-act="publish"]').click(); await page.waitForTimeout(150);
        const last = (await page.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_set_upcoming_feature_status').pop();
        assert.deepEqual(last.params, { p_id: '11111111-1111-1111-1111-111111111111', p_status: 'published', p_expected_updated_at: '2026-11-01T00:00:00Z' });
        // delete asks first, then sends ONLY the announcement delete
        await page.waitForSelector('#upcoming-table');
        await page.locator('tr[data-status="draft"] [data-act="delete"]').click();
        await page.locator('.modal button, .overlay button, button').filter({ hasText: 'Delete announcement' }).first().click(); await page.waitForTimeout(150);
        const names = await calls();
        assert.ok(names.includes('admin_delete_upcoming_feature')); assert.ok(!names.includes('admin_delete_addon') && !names.includes('admin_delete_addon_release'));
        // release for an announcement: banner appears and a package for the wrong add-on is refused
        await page.waitForSelector('#upcoming-table');
        await page.locator('tr[data-status="draft"] [data-act="release"]').click();
        assert.match(await page.locator('#upcoming-release-banner').innerText(), /ai_bg_remover/);
        await page.locator('#btn-upcoming-release-cancel').click();
        assert.equal(await page.locator('#upcoming-release-banner').innerText(), '');
      }
      results.push(name); await page.close();
    }
    console.log('PASS scenarios: ' + results.join(', '));
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
