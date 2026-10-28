// Step 2.5 browser check: delete one release / delete a whole add-on + Storage clean-up. Renders the REAL admin.js / addon_logic.js / admin.css in
// Chromium against a STUBBED supabase client (RPC + Storage). It proves the UI: which calls are made, in which ORDER and with exactly which
// arguments, what the admin sees at each step / on each failure, that the database function is called at most once, and that the retry button
// repeats ONLY the Storage removal. It does NOT test SQL, PostgreSQL, Supabase, Storage policies or the real admin_delete_addon_release() /
// admin_delete_addon(). The stub imitates those functions (active / offered refusal, revision check, tombstone, previous-pointer clearing,
// confirmation text, returned storage path(s), and since Step 2.7 the refusal of a whole add-on while it is offered) from READING 0014
// section F; that is NOT evidence that the SQL or Storage behave so.
//
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/addon_delete.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT ? path.resolve(process.env.MZ_ADMIN_ROOT) : path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const STUB = `
window.__calls = [];
const C = window.__STUB__;
const S = window.__state = JSON.parse(JSON.stringify(C.state));      // {rels, sels, registry, tombs, objects:{path:true}}
const rels = (id) => S.rels.filter((r) => r.addon_id === id);
const effective = (id) => { const s = S.sels[id]; if (!s || s.mode === 'withdrawn' || s.mode === 'none') return null;
  if (s.mode === 'pinned') return rels(id).some((r) => r.version === s.active_version && !r.yanked) ? s.active_version : null;
  const ok = rels(id).filter((r) => !r.yanked).sort((a, b) => b.seq - a.seq); return ok.length ? ok[0].version : null; };
// imitates the Step 2.7 guard of 0014 admin_delete_addon: selection not withdrawn AND a non-yanked stable release (pinned: the chosen one only)
const serverOffered = (id) => { const s = S.sels[id]; if (!s || s.mode === 'withdrawn') return null;
  const r = rels(id).filter((x) => !x.yanked && (s.mode !== 'pinned' || x.version === s.active_version)).sort((a, b) => b.seq - a.seq)[0]; return r ? { version: r.version, mode: s.mode } : null; };
const relIds = () => [...new Set(S.rels.map((r) => r.addon_id))].sort();
const allIds = () => [...new Set([...S.registry, ...S.rels.map((r) => r.addon_id)])].sort();
const NAMES = { converter_image: 'Image Converter', tracker: 'Tracker', empty_one: 'Empty One' };
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, p) => {
    window.__calls.push({ name, params: p ? JSON.parse(JSON.stringify(p)) : null });
    const err = (m) => ({ data: null, error: { message: m } }), ok = (d) => ({ data: JSON.parse(JSON.stringify(d)), error: null });
    const fail = (C.fail || {})[name]; if (fail) { if (fail.once) delete C.fail[name]; return err(fail.message); }
    switch (name) {
      case 'admin_overview': return ok({});
      case 'admin_list_pages': return ok(allIds().map((k) => ({ page_key: k })));
      case 'admin_list_addon_releases': return ok(S.rels.map((r) => ({ notes: {}, min_core: 'v0.9.9.10', max_core: null, channel: 'stable', summary: '', feature_key: r.addon_id, published_at: '2026-01-01T10:00:00Z', ...r, is_active: r.version === effective(r.addon_id), block_reason: r.yanked ? 'this release is yanked: restore it first (restoring does not activate it)' : null, selectable: !r.yanked })));
      case 'admin_get_addon_selection': return ok(relIds().map((id) => { const s = S.sels[id] || { mode: 'none', active_version: null, previous_version: null, revision: 0 };
        return { addon_id: id, title: id, feature_key: id, mode: s.mode, active_version: s.active_version, previous_version: s.previous_version, revision: s.revision, updated_at: null, updated_by_email: null, effective_version: effective(id), previous_block_reason: null }; }));
      case 'admin_list_addons': if (C.managedError) return err(C.managedError);
        return ok(allIds().map((id) => { const s = S.sels[id] || { mode: 'none', revision: 0 }, rs = rels(id); return { addon_id: id, name: NAMES[id] || id, description: '', registered: S.registry.includes(id), feature_key: id, release_count: rs.length, yanked_count: rs.filter((r) => r.yanked).length, latest_version: rs.length ? rs.slice().sort((a, b) => b.seq - a.seq)[0].version : null, deleted_count: S.tombs.filter((t) => t.addon_id === id).length, mode: s.mode, active_version: s.active_version, previous_version: s.previous_version, revision: s.revision, effective_version: effective(id), created_at: null, updated_at: null }; }));
      case 'admin_delete_addon_release': {                              // imitates 0014 section F (read from the SQL, never executed)
        const id = p.p_addon, ver = p.p_version;
        if (C.onDelete && !C.onDelete.done) { C.onDelete.done = true;
          if (C.onDelete.kind === 'activate') S.sels[id] = { mode: 'pinned', active_version: C.onDelete.version, previous_version: null, revision: S.sels[id].revision };   // same revision on purpose: reaches the ACTIVE refusal itself (a real activation also bumps it: that is the 'bump' / stale scenario)
          if (C.onDelete.kind === 'bump') S.sels[id].revision += 1; }
        if (C.garbage) return ok({});
        const r = S.rels.find((x) => x.addon_id === id && x.version === ver); if (!r) return err('unknown release');
        const s = S.sels[id];
        if (p.p_expected_revision != null && p.p_expected_revision !== (s ? s.revision : 0)) return err('stale: the selection for ' + id + ' was changed by someone else (now revision ' + (s ? s.revision : 0) + '). Reload the page and try again.');
        if (s && s.mode === 'pinned' && s.active_version === ver) return err('cannot delete ' + ver + ': it is the ACTIVE version. Make another version active, or deactivate the add-on, first.');
        if (effective(id) === ver) return err('cannot delete ' + ver + ': users are being offered it right now (automatic mode). Choose another version or deactivate the add-on first.');
        if (s && s.previous_version === ver) { s.previous_version = null; s.revision += 1; }
        S.tombs.push({ addon_id: id, version: ver, seq: r.seq, revoked: r.yanked, storage_path: r.storage_path });
        S.rels = S.rels.filter((x) => x !== r);
        return ok({ addon_id: id, version: ver, storage_path: C.badPath || r.storage_path, was_yanked: r.yanked, revocation_kept: r.yanked }); }
      case 'admin_delete_addon': {
        const id = p.p_addon;
        if (p.p_confirm !== id) return err('confirmation text does not match the add-on id');
        if (C.onDeleteAddon && !C.onDeleteAddon.done) { C.onDeleteAddon.done = true;           // a change by someone else AFTER the window's fresh check
          if (C.onDeleteAddon.kind === 'offer') S.sels[id] = { mode: C.onDeleteAddon.mode || 'auto', active_version: C.onDeleteAddon.version || null, previous_version: null, revision: (S.sels[id] ? S.sels[id].revision : 0) + 1 }; }
        if (C.garbage) return ok({});
        if (!S.registry.includes(id) && !rels(id).length) return err('unknown add-on');
        { const off = serverOffered(id); if (off) return err('cannot delete add-on ' + id + ': users are being offered it right now (version ' + off.version + ', selection mode ' + off.mode + '). Deactivate the add-on first (Versions > Deactivate), then delete it.'); }
        const rs = rels(id).slice().sort((a, b) => a.seq - b.seq);
        rs.forEach((r) => S.tombs.push({ addon_id: id, version: r.version, seq: r.seq, revoked: r.yanked, storage_path: r.storage_path }));
        S.rels = S.rels.filter((x) => x.addon_id !== id); delete S.sels[id]; S.registry = S.registry.filter((x) => x !== id);
        return ok({ addon_id: id, storage_paths: rs.map((r) => r.storage_path).concat(C.extraPaths || []), releases_deleted: rs.length, revocations_kept: rs.filter((r) => r.yanked).length }); }
    }
    return err('stub: unexpected call ' + name);
  },
  storage: { from: (bucket) => ({
    remove: async (ps) => { window.__calls.push({ name: 'STORAGE remove', bucket, path: ps.slice() });
      if (C.holdRemove) await new Promise((r) => { window.__releaseRemove = r; });
      if (C.removeError && C.removeError.times > 0) { C.removeError.times--; return { data: null, error: { message: C.removeError.message } }; }
      const gone = []; for (const q of ps) { if ((C.refuse || []).includes(q)) continue; if (S.objects[q]) { delete S.objects[q]; gone.push({ name: C.basenameNames ? q.split('/').pop() : q }); } }
      return { data: gone, error: null }; },
    list: async (dir, opts) => { window.__calls.push({ name: 'STORAGE list', bucket, dir, search: opts && opts.search });
      if (C.listError) return { data: null, error: { message: C.listError } };
      return { data: Object.keys(S.objects).filter((k) => k.startsWith(dir + '/') && !k.slice(dir.length + 1).includes('/')).map((k) => ({ name: k.slice(dir.length + 1) })).filter((o) => !(opts && opts.search) || o.name.includes(opts.search)), error: null }; },
    upload: async (p) => { window.__calls.push({ name: 'STORAGE upload', bucket, path: p }); return { data: null, error: { message: 'stub: not expected' } }; },
    download: async (p) => { window.__calls.push({ name: 'STORAGE download', bucket, path: p }); return { data: null, error: { message: 'stub: not expected' } }; },
    createSignedUrl: async (p) => { window.__calls.push({ name: 'STORAGE signed url', bucket, path: p }); return { data: null, error: { message: 'stub: not expected' } }; },
  }) },
}) };`;

const P = (id, v) => `${id}/${v}/${id}-${v}.mzaddon`;
const REL = (id, title, version, seq, yanked) => ({ addon_id: id, title, version, seq, yanked: !!yanked, size: 100 + seq, sha256: String(seq).repeat(64).slice(0, 64), storage_path: P(id, version) });
const STATE = () => {
  const rels = [REL('converter_image', 'Image Converter', '0.9.0', 1, true), REL('converter_image', 'Image Converter', '1.0.0', 2), REL('converter_image', 'Image Converter', '1.1.0', 3), REL('tracker', 'Tracker', '1.0.0', 1)];
  return {
    rels, registry: ['converter_image', 'tracker', 'empty_one'], tombs: [],
    sels: { converter_image: { mode: 'pinned', active_version: '1.1.0', previous_version: '1.0.0', revision: 7 }, tracker: { mode: 'withdrawn', active_version: null, previous_version: '1.0.0', revision: 3 } },
    objects: Object.fromEntries(rels.map((r) => [r.storage_path, true])),
  };
};
const cfg = (o) => { const st = STATE(); if (o && o.deactivate) st.sels.converter_image = { mode: 'withdrawn', active_version: null, previous_version: '1.1.0', revision: 8 };   // 'deactivate' = the Step 2.7 precondition for deleting
  return { state: st, ...o }; };
const FORBIDDEN = /admin_publish_addon|admin_upsert_addon|admin_yank_addon|admin_set_addon_active|admin_clear_addon_active|admin_restore_previous|admin_withdraw_addon|admin_replace_addon_release|STORAGE upload|STORAGE download|STORAGE signed url/;

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
    const page = await browser.newPage({ viewport: { width: 1300, height: 1100 } });
    page.errors = []; page.on('pageerror', (e) => page.errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, data);
    await page.goto(url);
    await page.waitForSelector('.nav button[data-tab="addons"]'); await page.click('.nav button[data-tab="addons"]');
    await page.waitForSelector('#addon-history'); await page.waitForSelector('#addon-history-rows tr'); await page.waitForSelector(data.managedError ? '#addon-manager-error' : '#addon-manager-rows tr');
    return page;
  }
  const calls = (page) => page.evaluate(() => window.__calls);
  const names = async (page) => (await calls(page)).map((c) => c.name);
  const clearCalls = (page) => page.evaluate(() => { window.__calls.length = 0; });
  const state = (page) => page.evaluate(() => window.__state);
  const row = (page, v) => page.locator(`#addon-history-rows tr[data-version="${v}"]`);
  const mrow = (page, id) => page.locator(`#addon-manager-rows tr[data-addon="${id}"]`);
  const toasts = (page) => page.locator('.toast').allInnerTexts();
  const status = (page) => page.locator('#delete-status').innerText();
  const dlg = (page) => page.locator('#delete-dialog');
  const dbCalls = async (page) => (await calls(page)).filter((c) => /^admin_delete_/.test(c.name));
  const rmCalls = async (page) => (await calls(page)).filter((c) => c.name === 'STORAGE remove');
  const noForbidden = async (page, label) => assert.deepEqual((await names(page)).filter((n) => FORBIDDEN.test(n)), [], label + ': no publish / upsert / selection / yank / replace / upload / download call');
  const done = (n, page) => { assert.deepEqual(page.errors, [], n + ': no page errors'); results.push(n); return page.close(); };
  async function openRelease(page, v) { await row(page, v).locator('[data-act="hist-delete"]').click(); await page.waitForSelector('#delete-dialog'); }
  async function openAddon(page, id) { await mrow(page, id).locator('[data-act="delete-addon"]').click(); await page.waitForSelector('#delete-dialog'); }
  const run = (page) => page.click('#btn-delete-run');
  const closeIsRefused = async (page) => { await page.keyboard.press('Escape'); await page.mouse.click(5, 5); await page.click('.overlay .foot button'); assert.equal(await dlg(page).count(), 1, 'the window stayed open'); };

  try {
    // ---------- 1. rendering: Delete on every row, disabled with the server's reason for the ACTIVE version; rendering never deletes anything
    { const page = await open(cfg({}));
      for (const v of ['0.9.0', '1.0.0', '1.1.0']) assert.equal(await row(page, v).locator('[data-act="hist-delete"]').count(), 1);
      const act = row(page, '1.1.0').locator('[data-act="hist-delete"]');
      assert.equal(await act.isDisabled(), true); assert.match(await act.getAttribute('title'), /ACTIVE version[\s\S]*make another version active, or deactivate the add-on/);
      assert.equal(await row(page, '1.0.0').locator('[data-act="hist-delete"]').isDisabled(), false); assert.equal(await row(page, '0.9.0').locator('[data-act="hist-delete"]').isDisabled(), false, 'a yanked release may be deleted');
      for (const id of ['converter_image', 'tracker', 'empty_one']) assert.equal(await mrow(page, id).locator('[data-act="delete-addon"]').count(), 1);
      { const off = mrow(page, 'converter_image').locator('[data-act="delete-addon"]');          // Step 2.7: offered (pinned 1.1.0) -> disabled, with the reason
        assert.equal(await off.isDisabled(), true); assert.match(await off.getAttribute('title'), /offered version 1\.1\.0 right now[\s\S]*refuses to delete an add-on while it is offered[\s\S]*Deactivate/);
        assert.equal(await mrow(page, 'tracker').locator('[data-act="delete-addon"]').isDisabled(), false, 'withdrawn add-on: allowed'); assert.equal(await mrow(page, 'empty_one').locator('[data-act="delete-addon"]').isDisabled(), false, 'registry-only add-on: allowed'); }
      const hidden = await page.evaluate(() => [...document.querySelectorAll('#addon-manager [data-act="delete-addon"], #addon-history [data-act="hist-delete"]')].filter((b) => { const r = b.getBoundingClientRect(), w = b.closest('.tablewrap').getBoundingClientRect(); return r.right > w.right + 1 || r.left < w.left - 1; }).length);
      assert.equal(hidden, 0, 'every Delete button is fully visible, not hidden behind a horizontal scroll (found at 1300px: the 3-button manager row)');
      assert.deepEqual((await names(page)).filter((n) => /^admin_delete_|STORAGE/.test(n)), [], 'rendering touches neither the delete functions nor Storage'); await noForbidden(page, 'render'); await done('render', page); }
    { const page = await open(cfg({ managedError: 'Could not find the function public.admin_list_addons() in the schema cache' }));
      assert.equal(await row(page, '1.0.0').locator('[data-act="hist-delete"]').isDisabled(), true); assert.match(await row(page, '1.0.0').locator('[data-act="hist-delete"]').getAttribute('title'), /migration 0014/);
      await done('render-0014-missing', page); }

    // ---------- 2. delete a NOT yanked release: typed version must match exactly; order of calls; exact arguments; Storage removed; lists + counts refresh
    { const page = await open(cfg({})); await openRelease(page, '1.0.0'); await clearCalls(page);
      const text = await dlg(page).innerText();
      assert.match(text, /Permanently deletes the release converter_image 1\.0\.0 \(seq 2\)/); assert.match(text, /does NOT delete the copies already installed on users’ PCs/);
      assert.match(text, /NOT yanked, so no revocation is kept[\s\S]*Yank it first/); assert.match(text, /burnt for good/); assert.match(text, /converter_image\/1\.0\.0\/converter_image-1\.0\.0\.mzaddon/);
      assert.equal(await page.locator('#btn-delete-run').isDisabled(), true);
      for (const wrong of ['1.0', '1.0.0 ', ' 1.0.0', '1.0.1', 'converter_image']) { await page.fill('#delete-confirm', wrong); assert.equal(await page.locator('#btn-delete-run').isDisabled(), true, 'wrong text: ' + JSON.stringify(wrong)); }
      await page.fill('#delete-confirm', '1.0.0'); assert.equal(await page.locator('#btn-delete-run').isDisabled(), false);
      await run(page); await page.waitForSelector('#delete-status [data-kind="ok"]');
      { const n = await names(page); assert.deepEqual(n.slice(0, 3), ['admin_list_addon_releases', 'admin_get_addon_selection', 'admin_delete_addon_release'], 'fresh check first, then the database');
        assert.ok(n.indexOf('STORAGE remove') > n.indexOf('admin_delete_addon_release'), 'Storage is touched only AFTER the database deletion was confirmed'); }
      assert.deepEqual(await dbCalls(page), [{ name: 'admin_delete_addon_release', params: { p_addon: 'converter_image', p_version: '1.0.0', p_expected_revision: 7 } }], 'exact RPC and arguments, once');
      assert.deepEqual(await rmCalls(page), [{ name: 'STORAGE remove', bucket: 'addons', path: [P('converter_image', '1.0.0')] }]);
      const ok = await status(page); assert.match(ok, /Deleted converter_image 1\.0\.0\./); assert.match(ok, /not yanked, so no revocation is kept/); assert.match(ok, /package file was removed from Storage/); assert.match(ok, /audit entry/); assert.match(ok, /NOT removed/);
      const st = await state(page); assert.equal(st.rels.some((r) => r.version === '1.0.0' && r.addon_id === 'converter_image'), false); assert.equal(!!st.objects[P('converter_image', '1.0.0')], false);
      assert.deepEqual(st.tombs.map((t) => [t.version, t.revoked]), [['1.0.0', false]]); assert.equal(st.sels.converter_image.active_version, '1.1.0', 'selection untouched');
      await page.waitForFunction(() => !document.querySelector('#addon-history-rows tr[data-version="1.0.0"]'));
      assert.match(await page.locator('#addon-history-counts').innerText(), /^2 releases · 1 yanked · 1 deleted \(no longer listed\)/);
      assert.match(await mrow(page, 'converter_image').innerText(), /2 releases[\s\S]*1 yanked[\s\S]*1 deleted/);
      assert.equal(await page.locator('#btn-delete-run').isDisabled(), true, 'cannot be run twice'); await noForbidden(page, 'delete release');
      await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' }); assert.equal((await dbCalls(page)).length, 1); await done('delete-release-success', page); }

    // ---------- 3. a YANKED release: its revocation is kept (the server says so), stated honestly
    { const page = await open(cfg({})); await openRelease(page, '0.9.0'); assert.match(await dlg(page).innerText(), /This release is yanked\. It stays on the revoked list/);
      await page.fill('#delete-confirm', '0.9.0'); await run(page); await page.waitForSelector('#delete-status [data-kind="ok"]');
      assert.match(await status(page), /It was yanked and stays on the revoked list/); assert.deepEqual((await state(page)).tombs.map((t) => [t.version, t.revoked]), [['0.9.0', true]]); await done('delete-yanked-release', page); }

    // ---------- 4. Storage removal fails AFTER the database deletion: honest message, window locked, retry repeats ONLY the Storage removal
    { const page = await open(cfg({ removeError: { times: 1, message: 'storage backend unavailable' } })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page);
      await run(page); await page.waitForSelector('#btn-delete-retry');
      const t = await status(page); assert.match(t, /database deletion WAS done and is not repeated, but 1 package file could not be removed from Storage/); assert.match(t, /converter_image\/1\.0\.0\/converter_image-1\.0\.0\.mzaddon — storage backend unavailable/);
      assert.deepEqual((await state(page)).rels.filter((r) => r.addon_id === 'converter_image' && r.version === '1.0.0').length, 0, 'the database record is gone'); assert.equal(!!(await state(page)).objects[P('converter_image', '1.0.0')], true, 'the file is still in Storage');
      await closeIsRefused(page); assert.match((await toasts(page)).join('|'), /still in Storage/);
      await clearCalls(page); await page.click('#btn-delete-retry'); await page.waitForSelector('#delete-status [data-kind="ok"]');
      assert.equal((await dbCalls(page)).length, 0, 'the retry did NOT call the database again'); assert.deepEqual(await rmCalls(page), [{ name: 'STORAGE remove', bucket: 'addons', path: [P('converter_image', '1.0.0')] }]);
      assert.equal(!!(await state(page)).objects[P('converter_image', '1.0.0')], false); assert.match(await status(page), /Deleted converter_image 1\.0\.0\./);
      await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' }); await done('storage-failure-then-retry', page); }

    // ---------- 5. Storage "removes" without an error but the file is still there (policy refusal): NOT reported as success; retry works once allowed
    { const page = await open(cfg({ refuse: [P('converter_image', '1.0.0')] })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page);
      await run(page); await page.waitForSelector('#btn-delete-retry'); assert.match(await status(page), /Storage did not remove it \(the delete was refused or did not happen\)/);
      assert.equal((await page.locator('#delete-status [data-kind="ok"]').count()), 0, 'not shown as success'); assert.ok((await names(page)).includes('STORAGE list'), 'it was checked, not assumed');
      await page.evaluate(() => { window.__STUB__.refuse = []; }); await clearCalls(page); await page.click('#btn-delete-retry'); await page.waitForSelector('#delete-status [data-kind="ok"]'); assert.equal((await dbCalls(page)).length, 0); await done('storage-silent-refusal', page); }
    // ... a file that is already gone counts as cleaned (checked with list), and a remove() answer with different names is still verified
    { const st = STATE(); delete st.objects[P('converter_image', '1.0.0')]; const page = await open(cfg({ state: st })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await run(page);
      await page.waitForSelector('#delete-status [data-kind="ok"]'); assert.ok((await names(page)).includes('STORAGE list')); await done('storage-already-absent', page); }
    { const page = await open(cfg({ basenameNames: true })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await run(page);
      await page.waitForSelector('#delete-status [data-kind="ok"]'); assert.equal(!!(await state(page)).objects[P('converter_image', '1.0.0')], false); await done('storage-reported-names-differ', page); }
    { const page = await open(cfg({ refuse: [P('converter_image', '1.0.0')], listError: 'permission denied' })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await run(page);
      await page.waitForSelector('#btn-delete-retry'); assert.match(await status(page), /could not check whether it still exists: permission denied/); await done('storage-cannot-verify', page); }

    // ---------- 6. "Close without cleaning up" is explicit and says where the files are; the paths can be copied
    { const page = await open(cfg({ removeError: { times: 5, message: 'down' } })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await run(page); await page.waitForSelector('#btn-delete-leave');
      assert.equal(await page.locator('#btn-delete-copy').count(), 1); assert.equal(await page.locator('#delete-leftovers li').count(), 1);
      await page.click('#btn-delete-leave'); await page.waitForSelector('.overlay', { state: 'detached' }); assert.match((await toasts(page)).join('|'), /1 package file is still in Storage \(private\)\. Paths: converter_image\/1\.0\.0\//); await done('close-without-cleaning', page); }

    // ---------- 7. the server refuses: nothing is deleted, Storage is never touched, the real reason is shown
    { const page = await open(cfg({ onDelete: { kind: 'activate', version: '1.0.0' } })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page); await run(page);
      await page.waitForFunction(() => /Nothing was deleted/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /it is the ACTIVE version/);
      assert.equal((await rmCalls(page)).length, 0); assert.equal((await state(page)).rels.filter((r) => r.addon_id === 'converter_image' && r.version === '1.0.0').length, 1); assert.equal((await state(page)).tombs.length, 0);
      await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' }); await done('server-refuses-active-in-gap', page); }
    { const page = await open(cfg({ onDelete: { kind: 'bump' } })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page); await run(page);
      await page.waitForFunction(() => /Nothing was deleted/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /stale: the selection for converter_image was changed by someone else/); assert.equal((await rmCalls(page)).length, 0); await done('server-refuses-stale', page); }
    { const page = await open(cfg({ fail: { admin_delete_addon_release: { message: 'Could not find the function public.admin_delete_addon_release(p_addon, p_version, p_expected_revision) in the schema cache' } } })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page); await run(page);
      await page.waitForFunction(() => /Nothing was deleted/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /migration 0014 has not been applied yet/); assert.equal((await rmCalls(page)).length, 0); await done('migration-0014-missing', page); }
    // the fresh re-check stops BEFORE any write when the release became active while the window was open
    { const page = await open(cfg({})); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0');
      await page.evaluate(() => { window.__state.sels.converter_image = { mode: 'pinned', active_version: '1.0.0', previous_version: null, revision: 8 }; }); await clearCalls(page); await run(page);
      await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /ACTIVE version/); assert.equal((await dbCalls(page)).length, 0); assert.equal((await rmCalls(page)).length, 0); await done('recheck-stops-before-write', page); }
    { const page = await open(cfg({})); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0');
      await page.evaluate(() => { window.__state.sels.converter_image.revision = 8; }); await clearCalls(page); await run(page);
      await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /selection of this add-on was changed by someone else/); assert.equal((await dbCalls(page)).length, 0); await done('recheck-selection-changed', page); }

    // ---------- 8. the outcome of the database call is unknown / not a confirmation: Storage is NOT touched, no automatic second deletion
    { const page = await open(cfg({ fail: { admin_delete_addon_release: { message: 'connection reset', once: true } } })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page); await run(page);
      await page.waitForSelector('#btn-delete-reload'); const t = await status(page); assert.match(t, /did not confirm the deletion \(connection reset\)[\s\S]*may or may not have been deleted[\s\S]*Storage was NOT touched/); assert.match(t, /converter_image\/1\.0\.0\/converter_image-1\.0\.0\.mzaddon may still be in Storage/);
      assert.equal((await rmCalls(page)).length, 0); assert.equal((await dbCalls(page)).length, 1); assert.equal((await state(page)).rels.filter((r) => r.addon_id === 'converter_image' && r.version === '1.0.0').length, 1); await done('unconfirmed-database-call', page); }
    { const page = await open(cfg({ garbage: true })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page); await run(page);
      await page.waitForSelector('#btn-delete-reload'); assert.match(await status(page), /not with a confirmation of this deletion, so Storage was NOT touched/); assert.equal((await rmCalls(page)).length, 0); await done('answer-is-not-a-confirmation', page); }

    // ---------- 9. a path from the server that is not the release's own path is NEVER sent to Storage
    { const page = await open(cfg({ badPath: 'tracker/1.0.0/tracker-1.0.0.mzaddon' })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await clearCalls(page); await run(page);
      await page.waitForSelector('#delete-status [data-kind="ok"]'); assert.equal((await rmCalls(page)).length, 0, 'nothing sent to Storage'); assert.match(await status(page), /not the expected path of this release; they were NOT sent to Storage: tracker\/1\.0\.0\/tracker-1\.0\.0\.mzaddon/);
      assert.equal(!!(await state(page)).objects[P('tracker', '1.0.0')], true, 'the other add-on file is untouched'); await done('foreign-path-not-sent', page); }

    // ---------- 10. delete a whole add-on that is NOT offered: exact id typed, p_confirm is the typed text, files of all versions removed in one call
    { const page = await open(cfg({})); await openAddon(page, 'tracker'); await clearCalls(page);
      const text = await dlg(page).innerText(); assert.match(text, /Permanently deletes the add-on tracker[\s\S]*1 release record/); assert.match(text, /does NOT delete the copies already installed on users’ PCs/); assert.match(text, /0 of 1 release is yanked[\s\S]*The other 1 is NOT yanked/);
      assert.equal(await page.locator('#delete-ack').count(), 0, 'no acknowledgement needed: it is not offered');
      for (const wrong of ['', 'Tracker', 'tracker ', ' tracker', 'track', 'converter_image']) { await page.fill('#delete-confirm', wrong); assert.equal(await page.locator('#btn-delete-run').isDisabled(), true, 'wrong id: ' + JSON.stringify(wrong)); }
      await page.fill('#delete-confirm', 'tracker'); await run(page); await page.waitForSelector('#delete-status [data-kind="ok"]');
      { const n = await names(page); assert.deepEqual(n.slice(0, 3), ['admin_list_addon_releases', 'admin_list_addons', 'admin_delete_addon'], 'fresh check first, then the database');
        assert.ok(n.indexOf('STORAGE remove') > n.indexOf('admin_delete_addon'), 'Storage is touched only AFTER the database deletion was confirmed'); }
      assert.deepEqual(await dbCalls(page), [{ name: 'admin_delete_addon', params: { p_addon: 'tracker', p_confirm: 'tracker' } }]); assert.deepEqual(await rmCalls(page), [{ name: 'STORAGE remove', bucket: 'addons', path: [P('tracker', '1.0.0')] }]);
      const ok = await status(page); assert.match(ok, /Deleted add-on tracker: 1 release record deleted, 0 revocations kept, 1 package file removed from Storage\./); assert.match(ok, /audit entry/);
      const st = await state(page); assert.deepEqual(st.registry.sort(), ['converter_image', 'empty_one']); assert.equal(st.rels.some((r) => r.addon_id === 'tracker'), false); assert.equal(!!st.objects[P('tracker', '1.0.0')], false);
      assert.equal(!!st.objects[P('converter_image', '1.1.0')], true, 'other add-ons untouched'); assert.equal(st.rels.filter((r) => r.addon_id === 'converter_image').length, 3);
      await page.waitForFunction(() => !document.querySelector('#addon-manager-rows tr[data-addon="tracker"]')); assert.match(await page.locator('#addon-manager-summary').innerText(), /^2 add-ons/);
      await noForbidden(page, 'delete add-on'); await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' }); await done('delete-addon-success', page); }

    // ---------- 11. Step 2.7: an add-on users are offered RIGHT NOW cannot be deleted (button disabled, dialog preflight refuses, server refuses);
    //             once it is deactivated it can be: no tick any more, yanked versions keep their revocation
    { const page = await open(cfg({})); await clearCalls(page);
      const btn = mrow(page, 'converter_image').locator('[data-act="delete-addon"]'); assert.equal(await btn.isDisabled(), true, 'disabled while offered');
      await page.evaluate(() => { document.querySelector('#addon-manager-rows tr[data-addon="converter_image"] [data-act="delete-addon"]').disabled = false; });   // force it past the UI
      await btn.click(); await page.waitForSelector('#delete-dialog');
      assert.match(await page.locator('#delete-offered-warning').innerText(), /offered version 1\.1\.0 right now[\s\S]*refuses to delete an add-on while it is offered/); assert.equal(await page.locator('#delete-ack').count(), 0, 'no tick that could bypass the refusal');
      await page.fill('#delete-confirm', 'converter_image'); await run(page); await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#delete-status').innerText));
      assert.match(await status(page), /Nothing was changed\. Users are offered version 1\.1\.0 right now/); assert.equal((await dbCalls(page)).length, 0, 'the UI did not even call the server'); assert.equal((await rmCalls(page)).length, 0);
      assert.equal((await state(page)).rels.filter((r) => r.addon_id === 'converter_image').length, 3, 'nothing deleted'); await noForbidden(page, 'delete offered add-on (refused by UI)'); await done('delete-addon-offered-refused-by-ui', page); }
    { const page = await open(cfg({ deactivate: true })); await openAddon(page, 'converter_image'); await clearCalls(page);
      assert.equal(await page.locator('#delete-offered-warning').count(), 0); assert.equal(await page.locator('#delete-ack').count(), 0); assert.match(await dlg(page).innerText(), /1 of 3 releases are yanked[\s\S]*The other 2 are NOT yanked/); assert.match(await dlg(page).innerText(), /refuses to delete an add-on that users are offered right now/);
      await page.fill('#delete-confirm', 'converter_image'); assert.equal(await page.locator('#btn-delete-run').isDisabled(), false);
      await run(page); await page.waitForSelector('#delete-status [data-kind="ok"]');
      const rm = await rmCalls(page); assert.equal(rm.length, 1); assert.deepEqual(rm[0].path.slice().sort(), ['0.9.0', '1.0.0', '1.1.0'].map((v) => P('converter_image', v)), 'all three files in ONE remove call');
      assert.match(await status(page), /3 release records deleted, 1 revocation kept, 3 package files removed from Storage/); const st = await state(page);
      assert.deepEqual(st.tombs.map((t) => [t.version, t.revoked]).sort(), [['0.9.0', true], ['1.0.0', false], ['1.1.0', false]], 'only the yanked version stays revoked'); assert.deepEqual(Object.keys(st.objects), [P('tracker', '1.0.0')]);
      await page.waitForFunction(() => !document.querySelector('#addon-manager-rows tr[data-addon="converter_image"]')); assert.equal(await page.locator('#addon-history-select option').count(), 1, 'history now lists only the remaining add-on');
      await noForbidden(page, 'delete deactivated add-on'); await done('delete-addon-after-deactivate', page); }

    // ---------- 11b. Step 2.7: the add-on became offered AFTER the window's fresh check (second tab / another admin): the SERVER refuses, nothing is touched,
    //               and the message explains what to do. Also: automatic mode is refused the same way.
    for (const kind of [{ mode: 'auto', version: null, label: 'auto' }, { mode: 'pinned', version: '1.0.0', label: 'pinned' }]) {
      const page = await open(cfg({ onDeleteAddon: { kind: 'offer', mode: kind.mode, version: kind.version } })); await openAddon(page, 'tracker'); await page.fill('#delete-confirm', 'tracker'); await clearCalls(page); await run(page);
      await page.waitForSelector('#btn-delete-reload'); const msg = await status(page);
      assert.match(msg, /Nothing was deleted: the server refuses to delete an add-on while users are offered it\./);
      assert.ok(msg.includes('cannot delete add-on tracker: users are being offered it right now (version 1.0.0, selection mode ' + kind.mode + ')'), 'the server text is shown: ' + msg);
      assert.match(msg, /press Deactivate[\s\S]*installed copies on PCs are untouched[\s\S]*Nothing in Storage was touched/);
      assert.equal((await dbCalls(page)).length, 1, 'the server was asked once'); assert.equal((await rmCalls(page)).length, 0, 'Storage untouched');
      const st = await state(page); assert.equal(st.rels.filter((r) => r.addon_id === 'tracker').length, 1); assert.equal(!!st.objects[P('tracker', '1.0.0')], true); assert.equal(st.tombs.length, 0); assert.equal(st.registry.includes('tracker'), true);
      assert.equal(await page.locator('#btn-delete-run').isDisabled(), false, 'the window is usable again (nothing was done)'); await noForbidden(page, 'server refusal ' + kind.label); await done('delete-addon-server-refuses-offered-' + kind.label, page); }

    // ---------- 12. add-on delete, partial Storage failure: exactly the failed file is listed and retried; the database function ran once
    { const page = await open(cfg({ deactivate: true, refuse: [P('converter_image', '1.0.0')] })); await openAddon(page, 'converter_image'); await page.fill('#delete-confirm', 'converter_image'); await clearCalls(page);
      await run(page); await page.waitForSelector('#btn-delete-retry'); assert.match(await status(page), /1 package file could not be removed from Storage \(2 other files were removed\)/);
      assert.deepEqual(await page.locator('#delete-leftovers li code').allInnerTexts(), [P('converter_image', '1.0.0')]); assert.equal((await dbCalls(page)).length, 1);
      await closeIsRefused(page); await page.evaluate(() => { window.__STUB__.refuse = []; }); await clearCalls(page); await page.click('#btn-delete-retry'); await page.waitForSelector('#delete-status [data-kind="ok"]');
      assert.equal((await dbCalls(page)).length, 0, 'retry does not delete again'); assert.deepEqual((await rmCalls(page)).map((c) => c.path), [[P('converter_image', '1.0.0')]], 'only the failed file is retried');
      assert.match(await status(page), /3 package files removed from Storage/); await done('delete-addon-partial-storage-failure', page); }

    // ---------- 13. the server returns extra / foreign paths: they are not sent to Storage, other add-ons keep their files
    { const page = await open(cfg({ deactivate: true, extraPaths: ['tracker/1.0.0/tracker-1.0.0.mzaddon', 'converter_image/../x/y', 'converter_image/1.0.0/evil.mzaddon'] })); await openAddon(page, 'converter_image'); await page.fill('#delete-confirm', 'converter_image'); await clearCalls(page); await run(page);
      await page.waitForSelector('#delete-status [data-kind="ok"]'); const sent = (await rmCalls(page)).flatMap((c) => c.path); assert.ok(sent.every((q) => q.startsWith('converter_image/') && /^converter_image\/(0\.9\.0|1\.0\.0|1\.1\.0)\/converter_image-\1\.mzaddon$/.test(q)), 'only exact paths were sent: ' + sent);
      assert.match(await status(page), /3 Storage path\(s\) that are not the expected path of this add-on; they were NOT sent to Storage/); assert.equal(!!(await state(page)).objects[P('tracker', '1.0.0')], true); await done('foreign-paths-not-sent', page); }

    // ---------- 14. add-on delete: refusals / unknown outcomes / changed data
    { const page = await open(cfg({ deactivate: true })); await openAddon(page, 'converter_image'); await page.fill('#delete-confirm', 'converter_image');
      await page.evaluate(() => { window.__state.rels.push({ addon_id: 'converter_image', title: 'Image Converter', version: '1.2.0', seq: 4, yanked: false, size: 9, sha256: 'e'.repeat(64), storage_path: 'converter_image/1.2.0/converter_image-1.2.0.mzaddon' }); });
      await clearCalls(page); await run(page); await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /releases of converter_image changed since this window opened \(now 4 releases/); assert.equal((await dbCalls(page)).length, 0); await done('addon-recheck-changed', page); }
    { const page = await open(cfg({ fail: { admin_delete_addon: { message: 'connection reset', once: true } } })); await openAddon(page, 'tracker'); await page.fill('#delete-confirm', 'tracker'); await clearCalls(page); await run(page);
      await page.waitForSelector('#btn-delete-reload'); assert.match(await status(page), /did not confirm the deletion \(connection reset\)[\s\S]*folder tracker\/ in the private “addons” bucket\) may still be in Storage/); assert.equal((await rmCalls(page)).length, 0); await done('addon-unconfirmed', page); }
    { const page = await open(cfg({ garbage: true })); await openAddon(page, 'tracker'); await page.fill('#delete-confirm', 'tracker'); await clearCalls(page); await run(page); await page.waitForSelector('#btn-delete-reload'); assert.equal((await rmCalls(page)).length, 0); await done('addon-answer-is-not-a-confirmation', page); }
    { const page = await open(cfg({ fail: { admin_delete_addon: { message: 'Could not find the function public.admin_delete_addon(p_addon, p_confirm) in the schema cache' } } })); await openAddon(page, 'tracker'); await page.fill('#delete-confirm', 'tracker'); await run(page);
      await page.waitForFunction(() => /Nothing was deleted/.test(document.querySelector('#delete-status').innerText)); assert.match(await status(page), /admin_delete_addon is not available on this server/); assert.equal((await rmCalls(page)).length, 0); await done('addon-migration-0014-missing', page); }
    { const page = await open(cfg({})); await openAddon(page, 'empty_one'); assert.match(await dlg(page).innerText(), /0 release records[\s\S]*no releases, so only its name record is deleted/); await page.fill('#delete-confirm', 'empty_one'); await clearCalls(page); await run(page);
      await page.waitForSelector('#delete-status [data-kind="ok"]'); assert.equal((await rmCalls(page)).length, 0, 'nothing to remove from Storage'); assert.match(await status(page), /0 release records deleted[\s\S]*no package files to remove/); assert.equal((await state(page)).registry.includes('empty_one'), false); await done('delete-addon-without-releases', page); }

    // ---------- 15. while a step runs the window cannot be closed or edited
    { const page = await open(cfg({ holdRemove: true })); await openRelease(page, '1.0.0'); await page.fill('#delete-confirm', '1.0.0'); await run(page);
      await page.waitForFunction(() => /Step 3 of 3/.test(document.querySelector('#delete-status').innerText)); assert.equal(await page.locator('#btn-delete-run').isDisabled(), true); assert.equal(await page.locator('#delete-confirm').isDisabled(), true);
      await closeIsRefused(page); await page.evaluate(() => window.__releaseRemove()); await page.waitForSelector('#delete-status [data-kind="ok"]'); await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' });
      assert.equal((await dbCalls(page)).length, 1); await done('busy-window-cannot-close', page); }

    // ---------- 16. phone layout (dialogs and the six-button history rows)
    { const page = await open(cfg({ deactivate: true })); await page.setViewportSize({ width: 390, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal page scroll with the extra buttons');
      await openAddon(page, 'converter_image'); await page.fill('#delete-confirm', 'converter_image'); await page.waitForTimeout(100);
      const over = await page.evaluate(() => { const m = document.querySelector('#delete-dialog').closest('.modal'); return [...m.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > m.getBoundingClientRect().right + 1).map((e) => e.tagName + '#' + e.id); });
      assert.deepEqual(over, [], 'nothing in the dialog sticks out of it at 390px'); await done('phone-layout', page); }
  } finally { await browser.close(); server.close(); }
  console.log('PASS scenarios: ' + results.join(', '));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
