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
  rpc: async (name, params) => { window.__calls.push({ name, params });
    if (window.__SERVER__) { const r = window.__serverRpc(name, params || {}); return r.error ? { data: null, error: { message: r.error } } : { data: r.data, error: null }; }
    const h = window.__STUB__.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    if (h.error) return { data: null, error: { message: h.error } };
    return { data: h.data, error: null }; },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'stub' } }), remove: async () => ({ error: { message: 'stub' } }), createSignedUrl: async () => ({ error: { message: 'stub' } }) }) },
}) };`;
// Stateful stand-in for the database: gen '0024' = original 6-argument upsert, rows without archived_at, no archive/reorder RPCs;
// gen '0030' = 7-argument upsert (p_image_data optional, written as image_data = argument), archived_at on every row, archive + reorder RPCs. (0031 changes release/promotion only.)
const SERVER = `
window.__serverRpc = (name, p) => {
  const S = window.__SERVER__, rows = S.rows, g30 = S.gen === '0030';
  const nf = (args) => ({ error: 'Could not find the function public.' + name + '(' + args + ') in the schema cache' });
  const shape = (r) => { const o = Object.assign({}, r); if (!g30) { delete o.archived_at; delete o.image_data; } return o; };
  const find = (id) => rows.find((r) => r.id === id);
  if (S.fail && S.fail[name]) return { error: S.fail[name] };
  switch (name) {
    case 'admin_overview': return { data: {} };
    case 'admin_list_addon_releases': case 'admin_get_addon_selection': case 'admin_list_addons': return { data: [] };
    case 'admin_list_pages': return { data: [{ page_key: 'ai_bg_remover' }] };
    case 'admin_list_upcoming_features': return { data: rows.map(shape) };
    case 'admin_upsert_upcoming_feature': {
      const allowed = g30 ? ['p_id','p_title','p_description','p_addon_id','p_sort_order','p_expected_updated_at','p_image_data'] : ['p_id','p_title','p_description','p_addon_id','p_sort_order','p_expected_updated_at'];
      const bad = Object.keys(p).filter((k) => !allowed.includes(k)); if (bad.length) return nf(Object.keys(p).sort().join(', '));
      if (p.p_id) { const r = find(p.p_id); if (!r) return { error: 'unknown announcement' };
        if (p.p_expected_updated_at && p.p_expected_updated_at !== r.updated_at) return { error: 'stale: this announcement was changed by someone else. Reload the page and try again.' };
        Object.assign(r, { title: p.p_title, description: p.p_description, addon_id: p.p_addon_id, sort_order: p.p_sort_order, updated_at: '2026-11-03T00:00:00Z' }); if (g30) r.image_data = p.p_image_data || null; return { data: r }; }
      const r = { id: 'aaaaaaaa-0000-0000-0000-' + String(rows.length + 1).padStart(12, '0'), title: p.p_title, description: p.p_description, addon_id: p.p_addon_id, status: 'draft', sort_order: p.p_sort_order, updated_at: '2026-11-03T00:00:00Z', released_version: null };
      if (g30) { r.image_data = p.p_image_data || null; r.archived_at = null; } rows.push(r); return { data: r }; }
    case 'admin_set_upcoming_feature_archived': if (!g30) return nf('p_archived, p_expected_updated_at, p_id');
      { const r = find(p.p_id); r.archived_at = p.p_archived ? '2026-11-03T00:00:00Z' : null; if (p.p_archived) r.status = 'draft'; r.updated_at = '2026-11-03T00:00:01Z'; return { data: r }; }
    case 'admin_reorder_upcoming_features': if (!g30) return nf('p_ids');
      p.p_ids.forEach((id, i) => { find(id).sort_order = (i + 1) * 10; }); rows.sort((a, b) => a.sort_order - b.sort_order); return { data: {} };
    case 'admin_set_upcoming_feature_status': { const r = find(p.p_id); r.status = p.p_status; r.updated_at = '2026-11-03T00:00:02Z'; return { data: r }; }
    case 'admin_delete_upcoming_feature': rows.splice(rows.findIndex((r) => r.id === p.p_id), 1); return { data: { deleted: true } };
    default: return { error: 'stub: no handler for ' + name };
  }
};`;
// a 1x1 PNG the browser can decode (the real annThumb shrinks it via canvas)
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const IMG_OK = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const ROW = (o) => Object.assign({ id: '11111111-1111-1111-1111-111111111111', title: 'AI BG Remover', description: 'Removes backgrounds', addon_id: 'ai_bg_remover', status: 'draft', sort_order: 100,
  updated_at: '2026-11-01T00:00:00Z', released_version: null, image_data: null, archived_at: null }, o);
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
    // ------------------------------------------------------------------ stateful scenarios (0024-only vs 0030/0031 servers)
    const open = async (server) => {
      const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB + SERVER }));
      await page.addInitScript((sv) => { window.__SERVER__ = sv; window.__STUB__ = { rpc: {} }; }, server);
      await page.goto(url); await page.waitForSelector('.nav button[data-tab="addons"]'); await page.click('.nav button[data-tab="addons"]');
      await page.waitForSelector('#upcoming-features'); await page.waitForSelector('#addon-publish');
      page.errors = errors; page.upserts = async () => (await page.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_upsert_upcoming_feature');
      page.calls = async (n) => (await page.evaluate(() => window.__calls)).filter((c) => c.name === n);
      page.toastText = async () => (await page.locator('#toasts').innerText());
      return page;
    };
    const fillNew = async (page, title) => { await page.click('#btn-upcoming-new'); await page.waitForSelector('#upcoming-title'); await page.fill('#upcoming-title', title); await page.fill('#upcoming-desc', 'Text for ' + title); };
    const save = async (page) => { await page.locator('.overlay button.primary', { hasText: 'Save' }).click(); await page.waitForTimeout(250); };
    const NO_IMG_KEYS = ['p_addon_id', 'p_description', 'p_expected_updated_at', 'p_id', 'p_sort_order', 'p_title'];
    const IMG_FILE = { name: 'a.png', mimeType: 'image/png', buffer: PNG_1x1 };

    {   // A. 0024-only server, EMPTY list: schema cannot be detected -> neutral hint, no false 0030 claim; a no-image create works
      const page = await open({ gen: '0024', rows: [] });
      assert.equal(await page.locator('#upcoming-needs-0030').count(), 0, 'empty list must not claim 0030 is missing');
      assert.equal(await page.locator('#upcoming-schema-unknown').count(), 1, 'empty list shows the neutral "cannot be detected" hint');
      assert.match(await page.locator('#upcoming-schema-unknown').innerText(), /without an image save normally/);
      await fillNew(page, 'First idea'); await save(page);
      const up = await page.upserts(); assert.equal(up.length, 1);
      assert.deepEqual(Object.keys(up[0].params).sort(), NO_IMG_KEYS, '0024 no-image create sends exactly the 6 parameters, no p_image_data');
      assert.equal(await page.locator('.overlay').count(), 0, 'dialog closes after a successful save');
      assert.equal(await page.locator('#upcoming-table tbody tr').count(), 1);
      assert.equal(await page.locator('#upcoming-needs-0030').count(), 1, 'once a 0024-shaped row exists the real limitation is shown');
      assert.deepEqual(page.errors, []); results.push('0024-empty-noimage-create'); await page.close();
    }
    {   // B. 0024-only server WITH rows: honest warning, 0030-only controls hidden, manual Order + no-image edit still work
      const page = await open({ gen: '0024', rows: [ROW({}), ROW({ id: '22222222-2222-2222-2222-222222222222', title: 'Second', addon_id: null, sort_order: 200, status: 'published' })] });
      const warn = await page.locator('#upcoming-needs-0030').innerText();
      assert.match(warn, /Thumbnails, Archive \/ Restore and the ▲ ▼ reorder buttons need migration 0030/); assert.match(warn, /Order number/);
      assert.ok(!/ordering need/i.test(warn), 'must not claim all ordering needs 0030');
      assert.equal(await page.locator('[data-act="archive"], [data-act="restore"], [data-act="up"], [data-act="down"]').count(), 0);
      await page.locator('tr[data-upcoming="11111111-1111-1111-1111-111111111111"] [data-act="edit"]').click(); await page.waitForSelector('#upcoming-title');
      await page.fill('#upcoming-title', 'Renamed'); await page.fill('#upcoming-sort', '150'); await save(page);
      const up = await page.upserts(); assert.equal(up.length, 1);
      assert.deepEqual(Object.keys(up[0].params).sort(), NO_IMG_KEYS);
      assert.equal(up[0].params.p_id, '11111111-1111-1111-1111-111111111111'); assert.equal(up[0].params.p_sort_order, 150); assert.equal(up[0].params.p_expected_updated_at, '2026-11-01T00:00:00Z');
      assert.match(await page.locator('#upcoming-table').innerText(), /Renamed/); assert.deepEqual(page.errors, []);
      results.push('0024-rows-noimage-edit'); await page.close();
    }
    {   // C. image upload against a 0024-only server: clear migration message, nothing discarded, retry without the image works
      const page = await open({ gen: '0024', rows: [ROW({})] });
      await fillNew(page, 'With picture'); await page.setInputFiles('#upcoming-image', IMG_FILE);
      await page.waitForSelector('#upcoming-preview img'); await save(page);
      const up = await page.upserts(); assert.equal(up.length, 1); assert.match(up[0].params.p_image_data, /^data:image\/(webp|jpeg);base64,/, 'image upload sends p_image_data');
      const t = await page.toastText();
      assert.match(t, /0030_upcoming_features_management\.sql/); assert.match(t, /Nothing was saved/); assert.ok(!/schema cache/.test(t), 'no unexplained raw RPC error');
      assert.equal(await page.locator('.overlay').count(), 1, 'dialog stays open'); assert.equal(await page.inputValue('#upcoming-title'), 'With picture');
      assert.equal(await page.inputValue('#upcoming-desc'), 'Text for With picture'); assert.equal(await page.locator('#upcoming-preview img').count(), 1, 'selected image kept');
      assert.equal(await page.locator('#upcoming-table tbody tr').count(), 1, 'nothing was created');
      await page.click('#upcoming-image-clear'); await save(page);                      // retry without the image
      const up2 = await page.upserts(); assert.equal(up2.length, 2); assert.ok(!('p_image_data' in up2[1].params));
      assert.equal(await page.locator('#upcoming-table tbody tr').count(), 2); assert.equal(await page.locator('.overlay').count(), 0);
      assert.deepEqual(page.errors, []); results.push('0024-image-rejected-then-retry'); await page.close();
    }
    {   // D. 0030/0031 server: images, edit keeps/removes the image, archive / restore, ordering
      const A = ROW({ id: 'aaaaaaaa-1111-1111-1111-111111111111', title: 'Alpha', sort_order: 10, image_data: IMG_OK, status: 'published' });
      const B = ROW({ id: 'bbbbbbbb-2222-2222-2222-222222222222', title: 'Beta', addon_id: null, sort_order: 20 });
      const C = ROW({ id: 'cccccccc-3333-3333-3333-333333333333', title: 'Gamma', addon_id: null, sort_order: 30, archived_at: '2026-10-30T00:00:00Z' });
      const page = await open({ gen: '0030', rows: [A, B, C] });
      assert.equal(await page.locator('#upcoming-needs-0030').count(), 0); assert.equal(await page.locator('#upcoming-schema-unknown').count(), 0);
      assert.equal(await page.locator('#upcoming-table tbody tr img.ann-thumb').count(), 1, 'stored thumbnail is shown');
      assert.equal(await page.locator('tr[data-upcoming="cccccccc-3333-3333-3333-333333333333"] [data-act="restore"]').count(), 1);
      assert.equal(await page.locator('tr[data-upcoming="bbbbbbbb-2222-2222-2222-222222222222"] [data-act="archive"]').count(), 1);
      // edit Alpha without touching the image -> the existing image is re-sent (kept)
      await page.locator('tr[data-upcoming="aaaaaaaa-1111-1111-1111-111111111111"] [data-act="edit"]').click(); await page.waitForSelector('#upcoming-title');
      await page.fill('#upcoming-title', 'Alpha 2'); await save(page);
      let up = await page.upserts(); assert.equal(up[0].params.p_image_data, IMG_OK, 'edit keeps the stored image');
      // edit again and press Remove image -> p_image_data omitted -> 0030 clears it
      await page.locator('tr[data-upcoming="aaaaaaaa-1111-1111-1111-111111111111"] [data-act="edit"]').click(); await page.waitForSelector('#upcoming-title');
      await page.click('#upcoming-image-clear'); assert.equal(await page.locator('#upcoming-preview img').count(), 0); await save(page);
      up = await page.upserts(); assert.ok(!('p_image_data' in up[1].params), 'Remove image omits p_image_data');
      assert.equal(await page.locator('#upcoming-table tbody tr img.ann-thumb').count(), 0, 'server cleared the image');
      // new announcement WITH an image works on 0030
      await fillNew(page, 'Delta'); await page.setInputFiles('#upcoming-image', IMG_FILE); await page.waitForSelector('#upcoming-preview img'); await save(page);
      up = await page.upserts(); assert.match(up[2].params.p_image_data, /^data:image\//); assert.equal(await page.locator('#upcoming-table tbody tr img.ann-thumb').count(), 1);
      // ordering: move Beta up, exact RPC + ids (archived row excluded), then archive + restore
      await page.locator('tr[data-upcoming="bbbbbbbb-2222-2222-2222-222222222222"] [data-act="up"]').click(); await page.waitForTimeout(250);
      const ro = await page.calls('admin_reorder_upcoming_features'); assert.equal(ro.length, 1);
      assert.deepEqual(ro[0].params.p_ids.slice(0, 2), ['bbbbbbbb-2222-2222-2222-222222222222', 'aaaaaaaa-1111-1111-1111-111111111111']); assert.ok(!ro[0].params.p_ids.includes('cccccccc-3333-3333-3333-333333333333'));
      await page.locator('tr[data-upcoming="bbbbbbbb-2222-2222-2222-222222222222"] [data-act="archive"]').click();
      await page.locator('button', { hasText: /^Archive$/ }).last().click(); await page.waitForTimeout(250);
      let ar = await page.calls('admin_set_upcoming_feature_archived'); assert.equal(ar.length, 1); assert.equal(ar[0].params.p_archived, true);
      assert.equal(await page.locator('tr[data-upcoming="bbbbbbbb-2222-2222-2222-222222222222"]').getAttribute('data-archived'), '1');
      await page.locator('tr[data-upcoming="bbbbbbbb-2222-2222-2222-222222222222"] [data-act="restore"]').click(); await page.waitForTimeout(250);
      ar = await page.calls('admin_set_upcoming_feature_archived'); assert.equal(ar[1].params.p_archived, false);
      assert.equal(await page.locator('tr[data-upcoming="bbbbbbbb-2222-2222-2222-222222222222"]').getAttribute('data-status'), 'draft', 'restored as an unpublished draft');
      assert.deepEqual(page.errors, []); results.push('0030-image-edit-remove-archive-reorder'); await page.close();
    }
    {   // E. RPC errors on a 0030 server are shown as they are (not mislabelled as a missing migration) and never lose the form
      const page = await open({ gen: '0030', rows: [ROW({})], fail: { admin_upsert_upcoming_feature: 'stale: this announcement was changed by someone else. Reload the page and try again.' } });
      await page.locator('[data-act="edit"]').click(); await page.waitForSelector('#upcoming-title');
      await page.fill('#upcoming-title', 'Typed text'); await page.setInputFiles('#upcoming-image', IMG_FILE); await page.waitForSelector('#upcoming-preview img'); await save(page);
      const t = await page.toastText(); assert.match(t, /stale: this announcement was changed/); assert.ok(!/0030_upcoming_features_management/.test(t), 'a stale error is not a migration problem');
      assert.equal(await page.locator('.overlay').count(), 1); assert.equal(await page.inputValue('#upcoming-title'), 'Typed text'); assert.equal(await page.locator('#upcoming-preview img').count(), 1);
      // a second failing attempt can be retried from the same open form (button re-enabled)
      assert.equal(await page.locator('.overlay button.primary', { hasText: 'Save' }).isDisabled(), false);
      assert.deepEqual(page.errors, []); results.push('0030-rpc-error-keeps-form'); await page.close();
    }
    {   // F. 0024-only server: archive/reorder RPC answers 'function not found' (e.g. stale page) -> clear message, not a raw error
      const page = await open({ gen: '0030', rows: [ROW({})], fail: { admin_set_upcoming_feature_archived: 'Could not find the function public.admin_set_upcoming_feature_archived(p_archived, p_expected_updated_at, p_id) in the schema cache' } });
      await page.locator('[data-act="archive"]').click(); await page.locator('button', { hasText: /^Archive$/ }).last().click(); await page.waitForTimeout(250);
      const t = await page.toastText(); assert.match(t, /Archive needs migration 0030_upcoming_features_management\.sql/); assert.ok(!/schema cache/.test(t));
      assert.deepEqual(page.errors, []); results.push('archive-missing-function-message'); await page.close();
    }
    console.log('PASS scenarios: ' + results.join(', '));
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
