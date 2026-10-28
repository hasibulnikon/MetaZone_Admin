// Step 2.2 browser check: create / edit add-on metadata. Renders the REAL admin.js / addon_logic.js / admin.css in Chromium against a STUBBED
// supabase client. It proves the UI: which RPC is called, with exactly which arguments, in which order, what the admin sees on success / error,
// and that the list is re-loaded after a save. It does NOT test SQL, PostgreSQL, Supabase, RLS or the real admin_upsert_addon() function:
// the stub's admin_upsert_addon only stores what it is given (it deliberately does NOT re-implement the server's validation).
//
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/addon_manager_edit.smoke.js
// (outside test/ on purpose, so a plain `node --test` does not need Playwright)
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT ? path.resolve(process.env.MZ_ADMIN_ROOT) : path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const STUB = `
window.__calls = []; window.__listCalls = 0;
window.__db = JSON.parse(JSON.stringify(window.__STUB__.list || []));
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, params) => {
    window.__calls.push({ name, params: params ? JSON.parse(JSON.stringify(params)) : null });
    const cfg = window.__STUB__, err = (m) => ({ data: null, error: { message: m } });
    if (name === 'admin_list_addons') {
      window.__listCalls++;
      if (cfg.listError) return err(cfg.listError);
      if (cfg.listErrorAfter != null && window.__listCalls > cfg.listErrorAfter) return err('network down');
      return { data: JSON.parse(JSON.stringify(window.__db)), error: null };
    }
    if (name === 'admin_upsert_addon') {
      if (cfg.upsertError) return err(cfg.upsertError);
      if (cfg.upsertNull) return { data: null, error: null };
      let r = window.__db.find((x) => x.addon_id === params.p_addon);
      if (r) { r.name = params.p_name; r.description = params.p_description; r.registered = true; r.updated_at = '2026-10-25T10:00:00Z'; }
      else { r = { addon_id: params.p_addon, name: params.p_name, description: params.p_description, registered: true, feature_key: null, release_count: 0, yanked_count: 0, latest_version: null, deleted_count: 0, mode: 'none', active_version: null, previous_version: null, revision: 0, effective_version: null, created_at: '2026-10-25T10:00:00Z', updated_at: '2026-10-25T10:00:00Z' }; window.__db.push(r); }
      return { data: { addon_id: r.addon_id, name: r.name, description: r.description }, error: null };
    }
    const h = cfg.rpc[name];
    if (!h) return err('stub: no handler for ' + name);
    return h.error ? err(h.error) : { data: h.data, error: null };
  },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'stub' } }), remove: async () => ({ error: { message: 'stub' } }), createSignedUrl: async () => ({ error: { message: 'stub' } }) }) },
}) };`;

const release = { addon_id: 'converter_image', version: '1.0.0', seq: 1, channel: 'stable', size: 5000, sha256: 'a'.repeat(64), title: 'Image Converter', feature_key: 'converter_image', published_at: '2026-01-01T00:00:00Z', yanked: false, is_active: true, selectable: true };
const row = (o) => ({ addon_id: 'converter_image', name: 'Image Converter', description: 'Converts images', registered: true, feature_key: 'converter_image', release_count: 3, yanked_count: 1, latest_version: '1.2.0', deleted_count: 0, mode: 'pinned', active_version: '1.1.0', previous_version: null, revision: 4, effective_version: '1.1.0', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', ...o });
const XSS = '<img src=x onerror="window.__xss=1"><b>bold</b>';
const LIST = () => [row(), row({ addon_id: 'tracker', name: XSS, description: '', registered: false, release_count: 1, yanked_count: 0, latest_version: '0.3.0', mode: 'none', active_version: null, effective_version: null, updated_at: null })];
const cfg = (o) => ({ list: LIST(), rpc: { admin_overview: { data: {} }, admin_list_addon_releases: { data: [release] }, admin_list_pages: { data: [{ page_key: 'converter_image' }] }, admin_get_addon_selection: { data: [] } }, ...o });

const WRITE_OTHER = /delete|replace|withdraw|publish|yank|set_addon|clear_addon|restore|version|notice|payment|limit|page_set|page_plan/;

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

  async function open(data) {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, data);
    await page.goto(url);
    await page.waitForSelector('.nav button[data-tab="addons"]');
    await page.click('.nav button[data-tab="addons"]');
    await page.waitForSelector('#addon-manager'); await page.waitForSelector('#addon-release-rows tr[data-addon="converter_image"]');
    return page;
  }
  const calls = (page) => page.evaluate(() => window.__calls);
  const names = async (page) => (await calls(page)).map((c) => c.name);
  const upserts = async (page) => (await calls(page)).filter((c) => c.name === 'admin_upsert_addon');
  const fill = async (page, id, name, desc) => { await page.waitForSelector('#addon-form'); await page.waitForTimeout(120); if (id != null) await page.fill('#addon-form-id', id); if (name != null) await page.fill('#addon-form-name', name); if (desc != null) await page.fill('#addon-form-description', desc); };
  const errText = async (page, k) => page.locator(`#addon-form [data-err="${k}"]`).evaluate((e) => (e.style.display === 'none' ? '' : e.textContent));
  const toasts = (page) => page.locator('.toast').allInnerTexts();
  const noOtherWrites = async (page, label) => assert.deepEqual((await names(page)).filter((n) => WRITE_OTHER.test(n)), [], label + ': no unrelated write RPC was called');
  const done = (n, page) => { assert.deepEqual(page.errors, [], n + ': no page errors'); results.push(n); return page.close(); };

  try {
    // ---------- 1. create: success -> real RPC, exact arguments, fresh re-check BEFORE the write, list refreshed, success message
    { const page = await open(cfg({}));
      await page.click('#btn-addon-new'); await page.waitForSelector('#addon-form');
      assert.equal(await page.locator('#addon-form-id').getAttribute('readonly'), null, 'id is editable when creating');
      const before = (await calls(page)).length;
      await fill(page, ' new_addon ', '  My New Add-on ', '  Does <b>things</b>  ');
      await page.click('.overlay .foot button.primary');
      await page.waitForSelector('.overlay', { state: 'detached' });
      await page.waitForSelector('#addon-manager-rows tr[data-addon="new_addon"]');
      const after = (await calls(page)).slice(before);
      const order = after.map((c) => c.name);
      assert.ok(order.indexOf('admin_list_addons') >= 0 && order.indexOf('admin_list_addons') < order.indexOf('admin_upsert_addon'), 'the list is re-read before the upsert: ' + order);
      const up = await upserts(page); assert.equal(up.length, 1, 'exactly one upsert');
      assert.deepEqual(up[0].params, { p_addon: 'new_addon', p_name: 'My New Add-on', p_description: 'Does <b>things</b>' });
      assert.ok(order.lastIndexOf('admin_list_addons') > order.indexOf('admin_upsert_addon'), 'the list is reloaded after the save: ' + order);
      assert.ok(order.includes('admin_list_addon_releases'), 'the whole Add-ons tab was reloaded');
      const t = (await toasts(page)).join('|'); assert.match(t, /✓ Add-on “My New Add-on” \(new_addon\) created/);
      const rowText = await page.locator('#addon-manager-rows tr[data-addon="new_addon"]').innerText();
      assert.match(rowText, /My New Add-on/); assert.match(rowText, /Registered/); assert.match(rowText, /Does <b>things<\/b>/);      // shown as text
      assert.equal(await page.locator('#addon-manager-rows tr[data-addon="new_addon"] b').count() >= 1, true);                // only the <b> of the name cell
      assert.equal(await page.locator('#addon-manager-rows tr[data-addon="new_addon"] .hint b').count(), 0, 'description HTML is not parsed');
      assert.match(await page.locator('#addon-manager-summary').innerText(), /3 add-ons/);
      await noOtherWrites(page, 'create'); await done('create-success', page); }

    // ---------- 2. create: client-side validation, nothing is sent
    { const page = await open(cfg({}));
      await page.click('#btn-addon-new'); await page.waitForSelector('#addon-form');
      const click = () => page.click('.overlay .foot button.primary');
      await click(); assert.match(await errText(page, 'id'), /Enter an add-on id/); assert.match(await errText(page, 'name'), /Enter a name/);
      await fill(page, 'Bad ID', 'ok', ''); await click(); assert.match(await errText(page, 'id'), /Invalid id/); assert.equal(await errText(page, 'name'), '');
      await fill(page, 'x'.repeat(33), 'ok', ''); await click(); assert.match(await errText(page, 'id'), /Invalid id/);
      await fill(page, 'good_id', 'n'.repeat(81), 'd'.repeat(401)); await click(); assert.match(await errText(page, 'name'), /81 characters, maximum 80/); assert.match(await errText(page, 'description'), /401 characters, maximum 400/);
      await fill(page, 'converter_image', 'Dup', ''); await click(); assert.match(await errText(page, 'id'), /already exists/);
      await fill(page, 'tracker', 'Dup', ''); await click(); assert.match(await errText(page, 'id'), /already has releases but no name\/description record/);
      assert.equal((await upserts(page)).length, 0, 'invalid / duplicate input never reaches admin_upsert_addon');
      assert.ok(await page.locator('.overlay').count() === 1, 'the form stays open');
      await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' });
      assert.equal((await upserts(page)).length, 0, 'closing the form writes nothing');
      await done('create-validation', page); }

    // ---------- 3. create: the list on screen is stale and another admin created the id meanwhile -> caught by the fresh re-read
    { const page = await open(cfg({}));
      await page.evaluate(() => window.__db.push({ addon_id: 'late_one', name: 'Created by someone else', description: '', registered: true, release_count: 0, yanked_count: 0, deleted_count: 0, mode: 'none' }));
      await page.click('#btn-addon-new'); await fill(page, 'late_one', 'Mine', 'would overwrite'); await page.click('.overlay .foot button.primary');
      await page.waitForFunction(() => document.querySelector('#addon-form [data-err="id"]').style.display !== 'none');
      assert.match(await errText(page, 'id'), /already exists/); assert.equal((await upserts(page)).length, 0, 'no overwrite of a record created meanwhile');
      assert.equal(await page.evaluate(() => window.__db.find((x) => x.addon_id === 'late_one').name), 'Created by someone else');
      await done('create-stale-duplicate', page); }

    // ---------- 4. edit a registered add-on: id fixed + prefilled, exact arguments, list refreshed, "unchanged" refused
    { const page = await open(cfg({}));
      await page.click('#addon-manager-rows tr[data-addon="converter_image"] button[data-act="edit-addon"]'); await page.waitForSelector('#addon-form');
      assert.equal(await page.locator('#addon-form-id').inputValue(), 'converter_image'); assert.notEqual(await page.locator('#addon-form-id').getAttribute('readonly'), null, 'id is read-only when editing');
      assert.equal(await page.locator('#addon-form-name').inputValue(), 'Image Converter'); assert.equal(await page.locator('#addon-form-description').inputValue(), 'Converts images');
      await page.click('.overlay .foot button.primary'); assert.equal(await errText(page, 'form'), 'Nothing was changed.'); assert.equal((await upserts(page)).length, 0);
      await fill(page, null, 'Image Converter v2', ''); await page.click('.overlay .foot button.primary');
      await page.waitForSelector('.overlay', { state: 'detached' });
      await page.waitForFunction(() => /Image Converter v2/.test(document.querySelector('#addon-manager-rows').innerText));
      const up = await upserts(page); assert.equal(up.length, 1); assert.deepEqual(up[0].params, { p_addon: 'converter_image', p_name: 'Image Converter v2', p_description: '' });
      assert.match((await toasts(page)).join('|'), /Add-on “Image Converter v2” \(converter_image\) updated/);
      assert.equal(await page.locator('#addon-manager-rows tr[data-addon="converter_image"]').innerText().then((t) => /Converts images/.test(t)), false, 'cleared description is gone');
      await noOtherWrites(page, 'edit'); await done('edit-success', page); }

    // ---------- 5. edit an add-on that has releases but no record: "Register", saves through the same RPC; HTML in the name is data, not markup
    { const page = await open(cfg({}));
      const b = page.locator('#addon-manager-rows tr[data-addon="tracker"] button[data-act="edit-addon"]'); assert.equal(await b.innerText(), 'Register');
      assert.equal(await page.locator('#addon-manager-rows tr[data-addon="converter_image"] button[data-act="edit-addon"]').innerText(), 'Edit');
      await b.click(); await page.waitForSelector('#addon-form');
      assert.equal(await page.locator('#addon-form-name').inputValue(), XSS, 'the raw text is in the input, not parsed'); assert.equal(await page.evaluate(() => window.__xss === undefined), true);
      assert.match(await page.locator('#addon-form').innerText(), /has releases but no name\/description record yet/);
      await fill(page, null, 'Tracker', 'Tracks things'); await page.click('.overlay .foot button.primary'); await page.waitForSelector('.overlay', { state: 'detached' });
      await page.waitForFunction(() => /Registered/.test(document.querySelector('#addon-manager-rows tr[data-addon="tracker"]').innerText));
      assert.deepEqual((await upserts(page))[0].params, { p_addon: 'tracker', p_name: 'Tracker', p_description: 'Tracks things' });
      assert.match((await toasts(page)).join('|'), /“Tracker” \(tracker\) registered/); await done('register-unregistered', page); }

    // ---------- 6. server error on the real RPC: shown in the form AND as an error toast, form stays open with the input, list NOT reloaded, nothing claimed
    { const page = await open(cfg({ upsertError: 'forbidden' }));
      await page.click('#btn-addon-new'); await fill(page, 'new_addon', 'N', 'D');
      const rel = (await names(page)).filter((n) => n === 'admin_list_addon_releases').length;
      await page.click('.overlay .foot button.primary'); await page.waitForSelector('#addon-form-error', { state: 'visible' });
      assert.equal(await page.locator('#addon-form-error').innerText(), 'Not saved: forbidden'); assert.match((await toasts(page)).join('|'), /⚠ Not saved: forbidden/);
      assert.ok(!(await toasts(page)).some((t) => /created/.test(t)), 'no success message');
      assert.equal(await page.locator('#addon-form-name').inputValue(), 'N', 'input kept'); assert.equal(await page.locator('.overlay .foot button.primary').isDisabled(), false, 'can retry');
      assert.equal((await names(page)).filter((n) => n === 'admin_list_addon_releases').length, rel, 'list not reloaded after a failed save');
      assert.equal(await page.locator('#addon-manager-rows tr[data-addon="new_addon"]').count(), 0); await done('server-error', page); }

    // ---------- 7. migration 0014 missing on the server (upsert function not found): clear message
    { const page = await open(cfg({ upsertError: 'Could not find the function public.admin_upsert_addon(p_addon, p_description, p_name) in the schema cache' }));
      await page.click('#btn-addon-new'); await fill(page, 'new_addon', 'N', ''); await page.click('.overlay .foot button.primary'); await page.waitForSelector('#addon-form-error', { state: 'visible' });
      assert.match(await page.locator('#addon-form-error').innerText(), /migration 0014 has not been applied/); await done('upsert-missing', page); }

    // ---------- 8. the pre-save re-read fails: fail closed, nothing is written
    { const page = await open(cfg({ listErrorAfter: 1 }));
      await page.click('#btn-addon-new'); await fill(page, 'new_addon', 'N', ''); await page.click('.overlay .foot button.primary'); await page.waitForSelector('#addon-form-error', { state: 'visible' });
      assert.match(await page.locator('#addon-form-error').innerText(), /Could not check the current add-on list, nothing was saved: network down/); assert.equal((await upserts(page)).length, 0); await done('recheck-fails', page); }

    // ---------- 9. the server answers without the saved row: do not claim success
    { const page = await open(cfg({ upsertNull: true }));
      await page.click('#btn-addon-new'); await fill(page, 'new_addon', 'N', ''); await page.click('.overlay .foot button.primary'); await page.waitForSelector('#addon-form-error', { state: 'visible' });
      assert.match(await page.locator('#addon-form-error').innerText(), /did not confirm the save/); assert.ok(!(await toasts(page)).some((t) => /created/.test(t))); await done('unconfirmed', page); }

    // ---------- 10. edit of an add-on that was removed meanwhile is refused (the upsert would silently re-create it)
    { const page = await open(cfg({}));
      await page.click('#addon-manager-rows tr[data-addon="converter_image"] button[data-act="edit-addon"]'); await page.waitForSelector('#addon-form');
      await page.evaluate(() => { window.__db = window.__db.filter((x) => x.addon_id !== 'converter_image'); });
      await fill(page, null, 'Renamed', ''); await page.click('.overlay .foot button.primary');
      await page.waitForFunction(() => document.querySelector('#addon-form [data-err="id"]').style.display !== 'none');
      assert.match(await errText(page, 'id'), /no longer exists/); assert.equal((await upserts(page)).length, 0); await done('edit-removed-meanwhile', page); }

    // ---------- 11. no list (migration 0014 missing / list failed): no create or edit controls at all, existing release table untouched
    for (const [n, e] of [['no-list-missing', 'Could not find the function public.admin_list_addons without parameters in the schema cache'], ['no-list-failed', 'forbidden']]) {
      const page = await open(cfg({ listError: e }));
      assert.equal(await page.locator('#addon-manager button').count(), 0, n + ': no buttons without a list'); assert.equal(await page.locator('#btn-addon-new').count(), 0);
      assert.equal((await upserts(page)).length, 0); assert.ok(await page.locator('#addon-release-rows tr[data-addon="converter_image"]').count() === 1); await done(n, page);
    }

    // ---------- 12. Cancel writes nothing
    { const page = await open(cfg({}));
      await page.click('#btn-addon-new'); await fill(page, 'new_addon', 'N', 'D'); await page.click('.overlay .foot button:not(.primary)'); await page.waitForSelector('.overlay', { state: 'detached' });
      assert.equal((await upserts(page)).length, 0); await done('cancel', page); }

    console.log('PASS scenarios: ' + results.join(', '));
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
