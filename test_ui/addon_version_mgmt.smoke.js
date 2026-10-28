// Step 2.3 browser check: version history + release selection. Renders the REAL admin.js / addon_logic.js / admin.css in Chromium against a
// STUBBED supabase client. It proves the UI: what is shown for each release / add-on state, which RPC is called with exactly which arguments
// (including the p_expected_revision it read), what the admin sees on success / refusal / stale data, and that the tab is reloaded afterwards.
// It does NOT test SQL, PostgreSQL, Supabase, RLS, _require_admin or the real functions. The stub keeps a small state machine that imitates what
// 0012 / 0013 / 0014 do (revision check, previous_version bookkeeping, yanking the active release withdraws the selection) so that the screen
// after an action can be checked; it is written from reading that SQL and is NOT evidence that the SQL works.
//
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/addon_version_mgmt.smoke.js
// (outside test/ on purpose, so a plain `node --test` does not need Playwright)
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT ? path.resolve(process.env.MZ_ADMIN_ROOT) : path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const STUB = `
window.__calls = [];
const C = window.__STUB__;
const S = window.__state = JSON.parse(JSON.stringify(C.state));      // {rels:[...], sels:{addon:{mode,active_version,previous_version,revision}}}
const YANKED = 'this release is yanked: restore it first (restoring does not activate it)';
const blockOf = (r) => r.yanked ? YANKED : ((C.blocked || {})[r.addon_id + '@' + r.version] || null);
const rels = (id) => S.rels.filter((r) => r.addon_id === id);
const effective = (id) => {
  const s = S.sels[id]; if (!s || s.mode === 'withdrawn' || s.mode === 'none') return null;
  if (s.mode === 'pinned') { const r = rels(id).find((x) => x.version === s.active_version); return r && !blockOf(r) ? r.version : null; }
  const ok = rels(id).filter((r) => !blockOf(r)).sort((a, b) => b.seq - a.seq); return ok.length ? ok[0].version : null;
};
const ids = () => [...new Set(S.rels.map((r) => r.addon_id))].sort();
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, p) => {
    window.__calls.push({ name, params: p ? JSON.parse(JSON.stringify(p)) : null });
    const err = (m) => ({ data: null, error: { message: m } }), ok = (d) => ({ data: JSON.parse(JSON.stringify(d)), error: null });
    const fail = (C.fail || {})[name]; if (fail) { if (fail.once) delete C.fail[name]; return err(fail.message); }
    switch (name) {
      case 'admin_overview': return ok({});
      case 'admin_list_pages': return ok(ids().map((k) => ({ page_key: k })));
      case 'admin_list_addon_releases': return ok(S.rels.map((r) => ({ ...r, is_active: r.version === effective(r.addon_id), block_reason: blockOf(r), selectable: !blockOf(r), size: 5000, sha256: 'c'.repeat(64), storage_path: 'x', channel: r.channel || 'stable', feature_key: r.addon_id, notes: r.notes || {}, min_core: r.min_core || null, max_core: null, published_at: '2026-01-0' + r.seq + 'T10:00:00Z' })));
      case 'admin_get_addon_selection': if (C.noSelection) return ok([]);
        return ok(ids().map((id) => { const s = S.sels[id] || { mode: 'none', active_version: null, previous_version: null, revision: 0 };
          const prev = s.previous_version ? rels(id).find((r) => r.version === s.previous_version) : null;
          return { addon_id: id, title: id, feature_key: id, mode: s.mode, active_version: s.active_version, previous_version: s.previous_version, revision: s.revision, updated_at: s.revision ? '2026-02-01T00:00:00Z' : null, updated_by_email: s.revision ? 'other@admin' : null, effective_version: effective(id), previous_block_reason: prev ? blockOf(prev) : null }; }));
      case 'admin_list_addons': if (C.managedError) return err(C.managedError);
        return ok(ids().map((id) => { const s = S.sels[id] || { mode: 'none', active_version: null, previous_version: null, revision: 0 }, rs = rels(id);
          return { addon_id: id, name: (C.names || {})[id] || id, description: '', registered: true, feature_key: id, release_count: rs.length, yanked_count: rs.filter((r) => r.yanked).length, latest_version: rs.sort((a, b) => b.seq - a.seq)[0].version, deleted_count: (C.deleted || {})[id] || 0, mode: s.mode, active_version: s.active_version, previous_version: s.previous_version, revision: s.revision, effective_version: effective(id), created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' }; }));
    }
    // ---- writes: imitate _set_addon_selection / admin_withdraw_addon / admin_yank_addon (read from 0013 / 0014)
    const id = p && p.p_addon, s = S.sels[id], cur = s ? s.revision : 0;
    const stale = () => p.p_expected_revision != null && p.p_expected_revision !== cur ? 'stale: the selection for ' + id + ' was changed by someone else (now revision ' + cur + '). Reload the page and try again.' : null;
    const put = (mode, active, prev) => { S.sels[id] = { mode, active_version: active, previous_version: prev, revision: cur + 1 }; return ok(S.sels[id]); };
    if (name === 'admin_set_addon_active') { const e = stale(); if (e) return err(e); const r = rels(id).find((x) => x.version === p.p_version); const b = r ? blockOf(r) : 'this release does not exist';
      if (b) return err('cannot activate ' + id + ' ' + p.p_version + ': ' + b); return put('pinned', p.p_version, s && s.active_version && s.active_version !== p.p_version ? s.active_version : (s ? s.previous_version : null)); }
    if (name === 'admin_clear_addon_active') { const e = stale(); if (e) return err(e); if (!rels(id).some((r) => !blockOf(r))) return err('cannot switch ' + id + ' to automatic: no eligible release exists'); return put('auto', null, s ? (s.active_version || s.previous_version) : null); }
    if (name === 'admin_restore_previous_addon_active') { if (!s || !s.previous_version) return err('there is no previous selection to restore for ' + id); const e = stale(); if (e) return err(e); return put('pinned', s.previous_version, s.active_version); }
    if (name === 'admin_withdraw_addon') { if (C.withdrawMissing) return err('Could not find the function public.admin_withdraw_addon(p_addon, p_expected_revision) in the schema cache'); if (!s) return err(id + ' has no selection to withdraw (publish a release first)');
      const e = stale(); if (e) return err(e); if (s.mode === 'withdrawn') return err(id + ' is already deactivated'); return put('withdrawn', null, effective(id) || s.active_version || s.previous_version); }
    if (name === 'admin_yank_addon') { const r = rels(id).find((x) => x.version === p.p_version); if (!r) return err('unknown release'); const e = stale(); if (e) return err(e); const eff = effective(id); r.yanked = p.p_yank;
      if (p.p_yank && eff === p.p_version && s) S.sels[id] = { mode: 'withdrawn', active_version: null, previous_version: p.p_version, revision: s.revision + 1 }; return ok(r); }
    return err('stub: unexpected call ' + name);
  },
  storage: { from: () => ({ upload: async () => { window.__calls.push({ name: 'STORAGE upload' }); return { error: { message: 'stub' } }; }, remove: async () => { window.__calls.push({ name: 'STORAGE remove' }); return { error: { message: 'stub' } }; }, createSignedUrl: async () => { window.__calls.push({ name: 'STORAGE signed url' }); return { error: { message: 'stub' } }; }, download: async () => { window.__calls.push({ name: 'STORAGE download' }); return { error: { message: 'stub' } }; } }) },
}) };`;

const XSS = '<img src=x onerror="window.__xss=1"><b>bold</b>';
const rl = (addon, version, seq, o = {}) => ({ addon_id: addon, version, seq, title: addon === 'tracker' ? 'Tracker' : 'Image Converter', summary: '', yanked: false, ...o });
const STATE = () => ({
  rels: [rl('converter_image', '0.9.0', 1, { yanked: true }), rl('converter_image', '1.0.0', 2), rl('converter_image', '1.1.0', 3), rl('converter_image', '1.2.0', 4, { summary: XSS, channel: 'stable', min_core: 'v0.9.9.10', notes: { fixes: ['fix <i>one</i>'] } }),
    rl('tracker', '0.3.0', 1)],
  sels: { converter_image: { mode: 'pinned', active_version: '1.1.0', previous_version: '1.0.0', revision: 7 } },       // tracker: no selection row (mode none, revision 0)
});
const cfg = (o) => ({ state: STATE(), names: { converter_image: 'Image Converter', tracker: 'Tracker' }, deleted: { converter_image: 2 }, ...o });

const WRITE_OTHER = /upsert|delete|replace|publish|STORAGE|signed|download/;
const ACTION = /admin_set_addon_active|admin_clear_addon_active|admin_restore_previous_addon_active|admin_withdraw_addon|admin_yank_addon/;

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
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, data);
    await page.goto(url);
    await page.waitForSelector('.nav button[data-tab="addons"]');
    await page.click('.nav button[data-tab="addons"]');
    await page.waitForSelector('#addon-history'); await page.waitForSelector('#addon-release-rows tr, #addon-history-empty');
    return page;
  }
  const calls = (page) => page.evaluate(() => window.__calls);
  const actions = async (page) => (await calls(page)).filter((c) => ACTION.test(c.name));
  const reloads = async (page) => (await calls(page)).filter((c) => c.name === 'admin_list_addon_releases').length;
  const row = (page, v) => page.locator(`#addon-history-rows tr[data-version="${v}"]`);
  const badges = (page, v) => row(page, v).locator('td:nth-child(2) .badge').allInnerTexts();
  const stateText = (page) => page.locator('#addon-history-state').innerText();
  const toasts = (page) => page.locator('.toast').allInnerTexts();
  const confirmBtn = (page) => page.locator('.overlay .foot button.danger');
  const reloaded = (page, n) => page.waitForFunction((k) => window.__calls.filter((c) => c.name === 'admin_list_addon_releases').length >= k, n);
  const noOther = async (page, label) => assert.deepEqual((await calls(page)).filter((c) => WRITE_OTHER.test(c.name)).map((c) => c.name), [], label + ': no upsert / delete / replace / publish / Storage / download call');
  const done = (n, page) => { assert.deepEqual(page.errors, [], n + ': no page errors'); results.push(n); return page.close(); };

  try {
    // ---------- 1. history is shown from the real lists; rendering writes nothing; the existing table and selection panels are untouched
    { const page = await open(cfg({}));
      assert.equal(await page.locator('#addon-history-select option').count(), 2);
      assert.deepEqual(await page.locator('#addon-history-select option').allInnerTexts(), ['Image Converter (converter_image)', 'Tracker (tracker)']);
      assert.deepEqual(await page.locator('#addon-history-rows tr').evaluateAll((t) => t.map((r) => r.dataset.version)), ['1.2.0', '1.1.0', '1.0.0', '0.9.0'], 'newest (highest seq) first');
      assert.deepEqual(await badges(page, '1.2.0'), ['Published']); assert.deepEqual(await badges(page, '1.1.0'), ['Active', 'Offered']);
      assert.deepEqual(await badges(page, '1.0.0'), ['Previous selection']); assert.deepEqual(await badges(page, '0.9.0'), ['Yanked']);
      assert.equal(await stateText(page), 'Active: v1.1.0'); assert.equal(await page.locator('#addon-history-state').getAttribute('data-kind'), 'pinned');
      assert.match(await page.locator('#addon-history-state').getAttribute('class'), /\bok\b/);
      assert.match(await page.locator('#addon-history-counts').innerText(), /4 releases · 1 yanked · 2 deleted \(no longer listed\) · feature converter_image · selection last changed .* by other@admin/);
      const r12 = await row(page, '1.2.0').innerText();                                                   // metadata + text-only rendering
      assert.match(r12, /<img src=x onerror="window\.__xss=1"><b>bold<\/b>/); assert.match(r12, /v0\.9\.9\.10 to any/); assert.match(r12, /4\.9 KB/); assert.match(r12, /cccccccccc…/);
      assert.equal(await row(page, '1.2.0').locator('img, td > b ~ b').count(), 0, 'HTML in a summary is not parsed'); assert.equal(await page.evaluate(() => window.__xss), undefined);
      await row(page, '1.2.0').locator('details summary').click(); assert.match(await row(page, '1.2.0').locator('details').innerText(), /Fixes[\s\S]*fix <i>one<\/i>/);
      assert.equal(await row(page, '0.9.0').locator('[data-act="hist-restore"]').count(), 1); assert.equal(await row(page, '0.9.0').locator('[data-act="hist-yank"]').count(), 0);
      assert.equal(await row(page, '0.9.0').locator('[data-act="hist-activate"]').isDisabled(), true); assert.match(await row(page, '0.9.0').locator('[data-act="hist-activate"]').getAttribute('title'), /yanked/);
      assert.equal(await row(page, '1.1.0').locator('[data-act="hist-activate"]').count(), 0, 'the chosen version has no Make active');
      assert.deepEqual(await page.locator('#addon-history-controls button').evaluateAll((b) => b.map((x) => x.dataset.act)), ['hist-auto', 'hist-restore-previous', 'hist-withdraw']);
      assert.equal(await page.locator('#addon-history-controls [data-act="hist-withdraw"]').isDisabled(), false);
      assert.equal(await page.locator('#addon-history-controls [data-act="hist-restore-previous"]').innerText(), 'Restore previous selection (v1.0.0)');
      // the pre-existing UI still renders as before
      assert.equal(await page.locator('#addon-release-rows tr').count(), 5); assert.equal(await page.locator('[data-addon-sel="converter_image"] .badge').innerText(), 'v1.1.0 (chosen by you)');
      assert.equal(await page.locator('#addon-release-rows tr[data-version="1.1.0"] [data-act="activate"]').count(), 0);
      assert.deepEqual((await actions(page)), [], 'rendering calls no action RPC'); await noOther(page, 'render'); await done('history-render', page); }

    // ---------- 2. Make active: confirm text, exact RPC + the revision that was read, success toast, reload, same add-on stays selected
    { const page = await open(cfg({}));
      await page.selectOption('#addon-history-select', 'tracker'); assert.equal(await stateText(page), 'Not set'); assert.match(await page.locator('#addon-history-warn').innerText(), /No version has been chosen/);
      assert.equal(await page.locator('#addon-history-controls [data-act="hist-withdraw"]').isDisabled(), true); assert.match(await page.locator('#addon-history-controls [data-act="hist-withdraw"]').getAttribute('title'), /nothing to deactivate/);
      assert.deepEqual(await page.locator('#addon-history-controls button').evaluateAll((b) => b.map((x) => x.dataset.act)), ['hist-auto', 'hist-withdraw'], 'no previous selection yet');
      const n = await reloads(page);
      await row(page, '0.3.0').locator('[data-act="hist-activate"]').click();
      assert.match(await page.locator('.modal').innerText(), /Make tracker 0\.3\.0 the active version\?[\s\S]*last known good one/);
      assert.deepEqual(await actions(page), [], 'nothing is sent before confirming');
      await confirmBtn(page).click(); await reloaded(page, n + 1); await page.waitForSelector('.overlay', { state: 'detached' });
      assert.deepEqual(await actions(page), [{ name: 'admin_set_addon_active', params: { p_addon: 'tracker', p_version: '0.3.0', p_expected_revision: 0 } }]);
      assert.match((await toasts(page)).join('|'), /✓ tracker 0\.3\.0 is now active/);
      await page.waitForFunction(() => document.querySelector('#addon-history-state') && document.querySelector('#addon-history-state').textContent === 'Active: v0.3.0');
      assert.equal(await page.inputValue('#addon-history-select'), 'tracker', 'the add-on being managed stays selected after the reload');
      assert.deepEqual(await badges(page, '0.3.0'), ['Active', 'Offered']); await noOther(page, 'activate'); await done('activate', page); }

    // ---------- 3. Cancel / Escape sends nothing; a blocked release cannot be activated (disabled, reason shown, no call)
    { const page = await open(cfg({ blocked: { 'converter_image@1.2.0': 'it does not support any app version that is currently active' } }));
      assert.equal(await row(page, '1.2.0').locator('[data-act="hist-activate"]').isDisabled(), true);
      assert.match(await row(page, '1.2.0').locator('[data-act="hist-activate"]').getAttribute('title'), /does not support any app version/);
      assert.match(await row(page, '1.2.0').locator('[data-role="block-reason"]').innerText(), /Cannot be made active: it does not support any app version/);
      await row(page, '1.0.0').locator('[data-act="hist-activate"]').click(); await page.click('.overlay .foot button:not(.danger)'); await page.waitForSelector('.overlay', { state: 'detached' });
      await row(page, '1.0.0').locator('[data-act="hist-yank"]').click(); await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' });
      await page.locator('[data-act="hist-withdraw"]').click(); await page.click('.overlay .foot button:not(.danger)'); await page.waitForSelector('.overlay', { state: 'detached' });
      assert.deepEqual(await actions(page), [], 'cancelling sends nothing'); await done('cancel-and-blocked', page); }

    // ---------- 4. Restore previous: exact RPC with revision, state afterwards
    { const page = await open(cfg({})); const n = await reloads(page);
      await page.click('#addon-history-controls [data-act="hist-restore-previous"]'); await reloaded(page, n + 1);
      assert.deepEqual(await actions(page), [{ name: 'admin_restore_previous_addon_active', params: { p_addon: 'converter_image', p_expected_revision: 7 } }]);
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Active: v1.0.0');
      assert.deepEqual(await badges(page, '1.0.0'), ['Active', 'Offered']); assert.deepEqual(await badges(page, '1.1.0'), ['Previous selection']);
      assert.match((await toasts(page)).join('|'), /converter_image: restored previous selection/); await noOther(page, 'restore-previous'); await done('restore-previous', page); }

    // ---------- 5. Automatic: confirm, RPC, "Offered (automatic)" is not "Active"
    { const page = await open(cfg({})); const n = await reloads(page);
      await page.click('#addon-history-controls [data-act="hist-auto"]'); assert.match(await page.locator('.modal').innerText(), /Switch converter_image to Automatic\?/); await confirmBtn(page).click(); await reloaded(page, n + 1);
      assert.deepEqual(await actions(page), [{ name: 'admin_clear_addon_active', params: { p_addon: 'converter_image', p_expected_revision: 7 } }]);
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Automatic: v1.2.0');
      assert.deepEqual(await badges(page, '1.2.0'), ['Offered (automatic)']); assert.deepEqual(await badges(page, '1.1.0'), ['Previous selection']);
      assert.equal(await page.locator('#addon-history-controls [data-act="hist-auto"]').count(), 0, 'already automatic'); await done('automatic', page); }

    // ---------- 6. Deactivate (withdraw): confirmation text, RPC with revision, Withdrawn shown as a warning state, then the way back
    { const page = await open(cfg({})); let n = await reloads(page);
      await page.click('#addon-history-controls [data-act="hist-withdraw"]');
      const mt = await page.locator('.modal').innerText(); assert.match(mt, /Deactivate converter_image\?/); assert.match(mt, /No release is yanked or deleted/); assert.match(mt, /not removed or stopped/);
      await confirmBtn(page).click(); await reloaded(page, n + 1);
      assert.deepEqual(await actions(page), [{ name: 'admin_withdraw_addon', params: { p_addon: 'converter_image', p_expected_revision: 7 } }]);
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Withdrawn');
      assert.equal(await page.locator('#addon-history-state').getAttribute('data-kind'), 'withdrawn'); assert.match(await page.locator('#addon-history-state').getAttribute('class'), /suspended/);
      assert.match(await page.locator('#addon-history-warn').innerText(), /Deactivated: users are offered nothing/);
      assert.deepEqual(await badges(page, '1.1.0'), ['Active before withdrawal']); assert.equal(await page.locator('#addon-history-rows .badge', { hasText: /^Offered/ }).count(), 0, 'nothing is offered');
      assert.equal(await page.locator('[data-addon-sel="converter_image"] .badge').innerText(), 'Withdrawn: users are offered nothing', 'the existing panel agrees');
      assert.equal(await page.locator('#addon-history-controls [data-act="hist-withdraw"]').isDisabled(), true); assert.match(await page.locator('#addon-history-controls [data-act="hist-withdraw"]').getAttribute('title'), /Already deactivated/);
      assert.match((await toasts(page)).join('|'), /✓ converter_image deactivated/);
      n = await reloads(page);                                                                        // reactivate only through the EXISTING control
      await page.click('#addon-history-controls [data-act="hist-restore-previous"]'); await reloaded(page, n + 1);
      assert.deepEqual((await actions(page)).map((a) => [a.name, a.params.p_expected_revision]), [['admin_withdraw_addon', 7], ['admin_restore_previous_addon_active', 8]]);
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Active: v1.1.0'); await noOther(page, 'withdraw'); await done('withdraw-and-reactivate', page); }

    // ---------- 7. Yank / Restore (Step 8: p_expected_revision is sent, 0017): yanking the active release withdraws; restoring never activates
    { const page = await open(cfg({})); let n = await reloads(page);
      await row(page, '1.1.0').locator('[data-act="hist-yank"]').click(); assert.match(await page.locator('.modal').innerText(), /Yank converter_image 1\.1\.0\?[\s\S]*nothing is chosen for you/); await confirmBtn(page).click(); await reloaded(page, n + 1);
      assert.deepEqual(await actions(page), [{ name: 'admin_yank_addon', params: { p_addon: 'converter_image', p_version: '1.1.0', p_yank: true, p_expected_revision: 7 } }]);
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Withdrawn');
      assert.ok((await badges(page, '1.1.0')).includes('Yanked')); assert.equal(await row(page, '1.1.0').getAttribute('data-yanked'), '1');
      n = await reloads(page); await row(page, '1.1.0').locator('[data-act="hist-restore"]').click(); await reloaded(page, n + 1);
      assert.deepEqual((await actions(page)).slice(1), [{ name: 'admin_yank_addon', params: { p_addon: 'converter_image', p_version: '1.1.0', p_yank: false, p_expected_revision: 8 } }]);
      await page.waitForFunction(() => !document.querySelector('#addon-history-rows tr[data-version="1.1.0"]').dataset.yanked.includes('1'));
      assert.equal(await stateText(page), 'Withdrawn', 'restoring a yanked release does not activate anything'); assert.equal(await row(page, '1.1.0').getAttribute('data-offered'), '0'); await done('yank-restore', page); }

    // ---------- 8. stale data: the server refuses, the admin sees the server message, the tab reloads with the current state, a retry then works
    { const page = await open(cfg({}));
      await page.evaluate(() => { window.__state.sels.converter_image.revision = 8; window.__state.sels.converter_image.active_version = '1.0.0'; window.__state.sels.converter_image.previous_version = '1.1.0'; });   // "someone else" changed it
      const n = await reloads(page);
      await row(page, '1.2.0').locator('[data-act="hist-activate"]').click(); await confirmBtn(page).click(); await reloaded(page, n + 1);
      assert.deepEqual(await actions(page), [{ name: 'admin_set_addon_active', params: { p_addon: 'converter_image', p_version: '1.2.0', p_expected_revision: 7 } }], 'the revision it READ (7) was sent');
      assert.match((await toasts(page)).join('|'), /⚠ stale: the selection for converter_image was changed by someone else \(now revision 8\)/);
      await page.waitForSelector('.overlay', { state: 'detached' });
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Active: v1.0.0');       // fresh data is shown
      assert.equal((await toasts(page)).filter((t) => /is now active/.test(t)).length, 0, 'no success is claimed');
      const n2 = await reloads(page); await row(page, '1.2.0').locator('[data-act="hist-activate"]').click(); await confirmBtn(page).click(); await reloaded(page, n2 + 1);
      assert.equal((await actions(page)).pop().params.p_expected_revision, 8, 'the retry carries the fresh revision');
      await page.waitForFunction(() => document.querySelector('#addon-history-state').textContent === 'Active: v1.2.0'); await done('stale-revision', page); }

    // ---------- 8b. Step 8: Yank on stale data is refused by the (stubbed) server, nothing is yanked, the admin sees the message, no success is claimed
    { const page = await open(cfg({}));
      await page.evaluate(() => { window.__state.sels.converter_image.revision = 8; });                                   // \"someone else\" changed the selection
      const n = await reloads(page);
      await row(page, '1.0.0').locator('[data-act=\"hist-yank\"]').click(); await confirmBtn(page).click(); await reloaded(page, n + 1);
      assert.deepEqual(await actions(page), [{ name: 'admin_yank_addon', params: { p_addon: 'converter_image', p_version: '1.0.0', p_yank: true, p_expected_revision: 7 } }], 'the revision it READ (7) was sent');
      assert.match((await toasts(page)).join('|'), /⚠ stale: the selection for converter_image was changed by someone else \(now revision 8\)/);
      assert.equal((await toasts(page)).filter((t) => /yanked$/.test(t)).length, 0, 'no success is claimed');
      assert.equal(await row(page, '1.0.0').getAttribute('data-yanked'), '0', 'nothing was yanked'); await done('yank-stale-revision', page); }

    // ---------- 9. any other server refusal: shown as is, window stays open, no reload, no success
    { const page = await open(cfg({ fail: { admin_set_addon_active: { message: 'cannot activate converter_image 1.2.0: forbidden by test' } } })); const n = await reloads(page);
      await row(page, '1.2.0').locator('[data-act="hist-activate"]').click(); await confirmBtn(page).click();
      await page.waitForSelector('.toast.err'); assert.match((await toasts(page)).join('|'), /⚠ cannot activate converter_image 1\.2\.0: forbidden by test/);
      assert.equal(await page.locator('.overlay').count(), 1, 'the window stays open so the admin can retry or cancel'); assert.equal(await confirmBtn(page).isEnabled(), true);
      assert.equal(await reloads(page), n, 'no reload after a plain refusal'); assert.equal((await toasts(page)).filter((t) => /is now active/.test(t)).length, 0);
      await page.keyboard.press('Escape'); await done('server-refusal', page); }

    // ---------- 10. 0014 not applied: history and the existing controls work, Deactivate is disabled with the reason, nothing is called for it
    { const page = await open(cfg({ managedError: 'Could not find the function public.admin_list_addons without parameters in the schema cache' }));
      assert.equal(await page.locator('#addon-manager-error').getAttribute('data-missing'), '1'); assert.equal(await page.locator('[data-act="show-versions"]').count(), 0);
      assert.equal(await stateText(page), 'Active: v1.1.0'); assert.deepEqual(await page.locator('#addon-history-select option').allInnerTexts(), ['Image Converter (converter_image)', 'Tracker (tracker)'].map((s) => s.replace('Image Converter', 'Image Converter')));
      assert.doesNotMatch(await page.locator('#addon-history-counts').innerText(), /deleted/);
      const w = page.locator('#addon-history-controls [data-act="hist-withdraw"]'); assert.equal(await w.isDisabled(), true); assert.match(await w.getAttribute('title'), /migration 0014/);
      const n = await reloads(page); await page.click('#addon-history-controls [data-act="hist-restore-previous"]'); await reloaded(page, n + 1);
      assert.equal((await actions(page))[0].name, 'admin_restore_previous_addon_active'); assert.equal((await actions(page)).some((a) => a.name === 'admin_withdraw_addon'), false); await done('migration-0014-missing', page); }

    // ---------- 11. 0014 reported present but the function is missing when called: plain explanation, nothing claimed
    { const page = await open(cfg({ withdrawMissing: true }));
      await page.click('#addon-history-controls [data-act="hist-withdraw"]'); await confirmBtn(page).click(); await page.waitForSelector('.toast.err');
      assert.match((await toasts(page)).join('|'), /admin_withdraw_addon is not available on this server: the database migration that adds it has not been applied yet/);
      assert.equal(await stateText(page), 'Active: v1.1.0'); assert.equal((await toasts(page)).filter((t) => /deactivated/.test(t)).length, 0); await page.keyboard.press('Escape'); await done('withdraw-function-missing', page); }

    // ---------- 12. no selection data (server without 0013 or the call failed): history still shown, no selection controls, no revision invented
    { const page = await open(cfg({ noSelection: true }));
      assert.equal(await stateText(page), 'Selection state not available'); assert.equal(await page.locator('#addon-history-controls button').count(), 0);
      assert.deepEqual(await badges(page, '1.2.0'), ['Published']);
      await row(page, '1.2.0').locator('[data-act="hist-activate"]').click(); await confirmBtn(page).click(); await page.waitForSelector('.toast');
      assert.deepEqual(await actions(page), [{ name: 'admin_set_addon_active', params: { p_addon: 'converter_image', p_version: '1.2.0', p_expected_revision: null } }]); await page.keyboard.press('Escape'); await done('no-selection-data', page); }

    // ---------- 13. the manager row's Versions button switches the history; an add-on without releases has none
    { const page = await open(cfg({}));
      await page.click('#addon-manager-rows tr[data-addon="tracker"] [data-act="show-versions"]');
      assert.equal(await page.inputValue('#addon-history-select'), 'tracker'); assert.equal(await page.locator('#addon-history-body [data-history-for="tracker"]').count(), 1);
      await page.selectOption('#addon-history-select', 'converter_image'); assert.equal(await page.locator('#addon-history-body [data-history-for="converter_image"]').count(), 1);
      assert.deepEqual(await actions(page), []); await done('versions-button', page); }
    { const page = await open(cfg({ state: { rels: [], sels: {} } }));
      assert.match(await page.locator('#addon-history-empty').innerText(), /No releases published yet/); assert.equal(await page.locator('#addon-history-select').count(), 0); await done('no-releases', page); }

    // ---------- 14. phone layout: the history table becomes cards and nothing overflows the page horizontally
    { const page = await open(cfg({})); await page.setViewportSize({ width: 390, height: 900 }); await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal page scroll at 390px');
      assert.equal(await row(page, '1.1.0').locator('td').first().getAttribute('data-label'), 'Version');
      await row(page, '1.2.0').locator('details summary').click();
      const over = await page.evaluate(() => [...document.querySelectorAll('#addon-history-rows tr, #addon-history-rows td, #addon-history-rows td > div')].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.tagName + ':' + (e.dataset.version || e.textContent.slice(0, 20))));
      assert.deepEqual(over, [], 'nothing inside a history card is clipped or sticks out at 390px'); await done('phone-layout', page); }
  } finally { await browser.close(); server.close(); }
  console.log('PASS scenarios: ' + results.join(', '));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
