// Step 2.4 browser check: package download + package replacement. Renders the REAL admin.js / addon_logic.js / admin.css in Chromium against a
// STUBBED supabase client (RPC + Storage). It proves the UI: which calls are made, in which ORDER and with exactly which arguments, what the admin
// sees at each step / on each failure, and what the recovery buttons really do. It does NOT test SQL, PostgreSQL, Supabase, Storage policies or
// the real admin_replace_addon_release(). The stub imitates that function (not-active / not-offered rule, expected_sha256 stale check, Storage
// object must exist and have the same size, yanked flag untouched) from READING 0014 section G; that is NOT evidence that the SQL behaves so.
//
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/addon_package_replace.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), crypto = require('node:crypto');
const { chromium } = require('playwright');
const ROOT = process.env.MZ_ADMIN_ROOT ? path.resolve(process.env.MZ_ADMIN_ROOT) : path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };

const STUB = `
window.__calls = [];
const C = window.__STUB__;
const S = window.__state = JSON.parse(JSON.stringify(C.state));      // {rels, sels, objects:{path: base64}}
const u8 = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const b64 = (buf) => { let s = ''; const a = new Uint8Array(buf); for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]); return btoa(s); };
const hex = async (buf) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buf)), (x) => x.toString(16).padStart(2, '0')).join('');
const rels = (id) => S.rels.filter((r) => r.addon_id === id);
const effective = (id) => { const s = S.sels[id]; if (!s || s.mode === 'withdrawn' || s.mode === 'none') return null;
  if (s.mode === 'pinned') return rels(id).some((r) => r.version === s.active_version && !r.yanked) ? s.active_version : null;
  const ok = rels(id).filter((r) => !r.yanked).sort((a, b) => b.seq - a.seq); return ok.length ? ok[0].version : null; };
const ids = () => [...new Set(S.rels.map((r) => r.addon_id))].sort();
const cfgUrl = () => window.MZ_ADMIN_CONFIG.supabaseUrl;
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}), signInWithOAuth: async () => ({}) },
  rpc: async (name, p) => {
    window.__calls.push({ name, params: p ? JSON.parse(JSON.stringify(p)) : null });
    const err = (m) => ({ data: null, error: { message: m } }), ok = (d) => ({ data: JSON.parse(JSON.stringify(d)), error: null });
    const fail = (C.fail || {})[name]; if (fail) { if (fail.once) delete C.fail[name]; return err(fail.message); }
    switch (name) {
      case 'admin_overview': return ok({});
      case 'admin_list_pages': return ok(ids().map((k) => ({ page_key: k })));
      case 'admin_list_addon_releases': return ok(S.rels.map((r) => ({ notes: {}, min_core: 'v0.9.9.10', max_core: null, channel: 'stable', summary: '', feature_key: r.addon_id, title: 'Image Converter', published_at: '2026-01-01T10:00:00Z', ...r, is_active: r.version === effective(r.addon_id), block_reason: r.yanked ? 'this release is yanked: restore it first (restoring does not activate it)' : null, selectable: !r.yanked })));
      case 'admin_get_addon_selection': return ok(ids().map((id) => { const s = S.sels[id] || { mode: 'none', active_version: null, previous_version: null, revision: 0 };
        return { addon_id: id, title: id, feature_key: id, mode: s.mode, active_version: s.active_version, previous_version: s.previous_version, revision: s.revision, updated_at: null, updated_by_email: null, effective_version: effective(id), previous_block_reason: null }; }));
      case 'admin_list_addons': if (C.managedError) return err(C.managedError);
        return ok(ids().map((id) => { const s = S.sels[id] || { mode: 'none', revision: 0 }, rs = rels(id); return { addon_id: id, name: 'Image Converter', description: '', registered: true, feature_key: id, release_count: rs.length, yanked_count: rs.filter((r) => r.yanked).length, latest_version: '1.1.0', deleted_count: 0, mode: s.mode, active_version: s.active_version, previous_version: s.previous_version, revision: s.revision, effective_version: effective(id), created_at: null, updated_at: null }; }));
      case 'admin_replace_addon_release': {                               // imitates 0014 section G (read from the SQL, never executed)
        const q = p.p; if (!q || typeof q !== 'object') return err('request must be a JSON object');
        if (typeof q.size !== 'number' || q.size < 1) return err('invalid size (bytes > 0)'); if (!/^[0-9a-f]{64}$/.test(String(q.sha256 || '').toLowerCase())) return err('invalid sha256 (64 hex characters)');
        const r = S.rels.find((x) => x.addon_id === q.addon_id && x.version === q.version); if (!r) return err('unknown release');
        const s = S.sels[q.addon_id];
        if (s && s.mode === 'pinned' && s.active_version === q.version) return err('cannot replace the package of ' + q.addon_id + ' ' + q.version + ': it is the ACTIVE version. Publish a new version instead.');
        if (effective(q.addon_id) === q.version) return err('cannot replace the package of ' + q.addon_id + ' ' + q.version + ': users are being offered it right now. Publish a new version instead.');
        if (q.expected_sha256 && q.expected_sha256 !== r.sha256) return err('stale: this release was changed by someone else. Reload the page and try again.');
        const o = S.objects[r.storage_path]; if (!o) return err('package not found in Storage at ' + r.storage_path + ': upload it first');
        if (u8(o).length !== q.size) return err('size in Storage (' + u8(o).length + ') differs from the given size (' + q.size + ')');
        r.size = q.size; r.sha256 = q.sha256; return ok({ addon_id: r.addon_id, version: r.version, seq: r.seq, size_bytes: r.size, sha256: r.sha256, yanked: r.yanked, storage_path: r.storage_path }); }
    }
    return err('stub: unexpected call ' + name);
  },
  storage: { from: (bucket) => ({
    createSignedUrl: async (p, secs, opts) => { window.__calls.push({ name: 'STORAGE signed url', bucket, path: p, secs, opts });
      if (C.signedError) return { data: null, error: { message: C.signedError } };
      return { data: { signedUrl: (C.evilUrl ? 'https://evil.example' : cfgUrl()) + '/storage/v1/object/sign/' + bucket + '/' + p + '?token=T&download=' + encodeURIComponent((opts && opts.download) || '') }, error: null }; },
    download: async (p) => { window.__calls.push({ name: 'STORAGE download', bucket, path: p });
      if (C.downloadError) return { data: null, error: { message: C.downloadError } };
      return S.objects[p] ? { data: new Blob([u8(S.objects[p])]), error: null } : { data: null, error: { message: 'Object not found' } }; },
    upload: async (p, buf, opts) => { const sha = await hex(buf); window.__calls.push({ name: 'STORAGE upload', bucket, path: p, contentType: opts && opts.contentType, upsert: opts && opts.upsert, size: buf.byteLength, sha });
      if (C.holdUpload) await new Promise((r) => { window.__releaseUpload = r; });
      if (C.uploadError && C.uploadError.times > 0) { C.uploadError.times--; return { data: null, error: { message: C.uploadError.message } }; }
      S.objects[p] = b64(buf);
      if (C.onUpload === 'activate') S.sels[C.raceAddon] = { mode: 'pinned', active_version: C.raceVersion, previous_version: null, revision: 99 };       // another admin made it active in the gap
      if (C.onUpload === 'bump') S.rels.find((r) => r.storage_path === p).sha256 = 'd'.repeat(64);                                                      // another admin replaced it in the gap
      return { data: { path: p }, error: null }; },
    remove: async (ps) => { window.__calls.push({ name: 'STORAGE remove', path: ps }); return { error: { message: 'stub' } }; },
  }) },
}) };`;

// ---- real bytes, real hashes
const zip = (tag) => Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from((tag + '|').repeat(40))]);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const OLD = { '0.9.0': zip('old-0.9.0'), '1.0.0': zip('old-1.0.0'), '1.1.0': zip('old-1.1.0') };
const NEW100 = zip('NEW-1.0.0-rebuilt-with-more-bytes');
const SEQ = { '0.9.0': 1, '1.0.0': 2, '1.1.0': 3 };
const P = (v) => `converter_image/${v}/converter_image-${v}.mzaddon`;
const STATE = () => ({
  rels: Object.keys(OLD).map((v) => ({ addon_id: 'converter_image', version: v, seq: SEQ[v], yanked: v === '0.9.0', size: OLD[v].length, sha256: sha(OLD[v]), storage_path: P(v) })),
  sels: { converter_image: { mode: 'pinned', active_version: '1.1.0', previous_version: '1.0.0', revision: 7 } },
  objects: Object.fromEntries(Object.keys(OLD).map((v) => [P(v), OLD[v].toString('base64')])),
});
const cfg = (o) => ({ state: STATE(), ...o });
const sidecar = (buf, o = {}) => Buffer.from(JSON.stringify({ addon_id: 'converter_image', version: '1.0.0', seq: 2, channel: 'stable', size: buf.length, sha256: sha(buf), feature_key: 'converter_image', title: 'Image Converter', summary: '', min_core: 'v0.9.9.10', max_core: null, ...o }));
const files = (v, buf, o) => ({ pkg: { name: `converter_image-${v}.mzaddon`, mimeType: 'application/zip', buffer: buf }, side: { name: 'release.json', mimeType: 'application/json', buffer: sidecar(buf, { version: v, seq: SEQ[v], ...(o || {}) }) } });

const FORBIDDEN = /admin_publish_addon|admin_delete|admin_upsert_addon|admin_yank_addon|admin_set_addon_active|admin_clear_addon_active|admin_restore_previous|admin_withdraw_addon|STORAGE remove/;

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
    await page.route('**/storage/v1/object/sign/**', (r) => r.fulfill({ status: 200, headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="served.mzaddon"' }, body: OLD['1.0.0'] }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, data);
    await page.goto(url);
    await page.waitForSelector('.nav button[data-tab="addons"]'); await page.click('.nav button[data-tab="addons"]');
    await page.waitForSelector('#addon-history'); await page.waitForSelector('#addon-history-rows tr');
    return page;
  }
  const calls = (page) => page.evaluate(() => window.__calls);
  const names = async (page) => (await calls(page)).map((c) => c.name);
  const count = async (page, n) => (await calls(page)).filter((c) => c.name === n).length;
  const row = (page, v) => page.locator(`#addon-history-rows tr[data-version="${v}"]`);
  const toasts = (page) => page.locator('.toast').allInnerTexts();
  const dlg = (page) => page.locator('#replace-dialog');
  const statusText = (page) => page.locator('#replace-status').innerText();
  const state = (page) => page.evaluate(() => window.__state);
  const noForbidden = async (page, label) => assert.deepEqual((await names(page)).filter((n) => FORBIDDEN.test(n)), [], label + ': no publish / delete / upsert / selection / yank / Storage remove call');
  const done = (n, page) => { assert.deepEqual(page.errors, [], n + ': no page errors'); results.push(n); return page.close(); };
  async function openReplace(page, v, f) {
    await row(page, v).locator('[data-act="hist-replace"]').click(); await page.waitForSelector('#replace-dialog');
    if (f) { await page.setInputFiles('#replace-pkg', f.pkg); await page.setInputFiles('#replace-sidecar', f.side); await page.waitForFunction(() => document.querySelector('#replace-checks li') && !document.querySelector('#btn-replace-run').disabled || document.querySelectorAll('#replace-checks li.bad').length > 0); }
  }
  const clearCalls = (page) => page.evaluate(() => { window.__calls.length = 0; });
  const replaceCalls = async (page) => (await calls(page)).filter((c) => c.name === 'admin_replace_addon_release');
  const uploads = async (page) => (await calls(page)).filter((c) => c.name === 'STORAGE upload');

  try {
    // ---------- 1. rendering: buttons + eligibility; rendering touches neither Storage nor the replace RPC
    { const page = await open(cfg({}));
      for (const v of ['0.9.0', '1.0.0', '1.1.0']) { assert.equal(await row(page, v).locator('[data-act="hist-download"]').count(), 1); assert.equal(await row(page, v).locator('[data-act="hist-replace"]').count(), 1); }
      assert.equal(await row(page, '1.1.0').locator('[data-act="hist-replace"]').isDisabled(), true); assert.match(await row(page, '1.1.0').locator('[data-act="hist-replace"]').getAttribute('title'), /ACTIVE version[\s\S]*publish a new version/);
      assert.equal(await row(page, '1.0.0').locator('[data-act="hist-replace"]').isDisabled(), false); assert.equal(await row(page, '0.9.0').locator('[data-act="hist-replace"]').isDisabled(), false, 'a yanked release may be replaced');
      assert.equal(await row(page, '1.1.0').locator('[data-act="hist-download"]').isDisabled(), false, 'the active version can still be downloaded');
      assert.deepEqual((await names(page)).filter((n) => /STORAGE|replace/.test(n)), [], 'rendering never touches Storage or replace'); await noForbidden(page, 'render'); await done('render', page); }

    // ---------- 2. download: short-lived signed URL (60 s) from the admin session, real browser download; failures are shown; foreign host refused
    { const page = await open(cfg({}));
      const [dl] = await Promise.all([page.waitForEvent('download'), row(page, '0.9.0').locator('[data-act="hist-download"]').click()]);
      const c = (await calls(page)).filter((x) => x.name === 'STORAGE signed url');
      assert.deepEqual(c, [{ name: 'STORAGE signed url', bucket: 'addons', path: P('0.9.0'), secs: 60, opts: { download: 'converter_image-0.9.0.mzaddon' } }], 'yanked version too; 60 seconds; file name set');
      assert.ok(dl.url().includes('/storage/v1/object/sign/addons/'), 'the browser followed the signed URL'); assert.match((await toasts(page)).join('|'), /Download of converter_image-0\.9\.0\.mzaddon started \(link valid for 60 seconds\)/);
      assert.equal(await row(page, '0.9.0').locator('[data-act="hist-download"]').isDisabled(), false, 'button is usable again');
      assert.deepEqual((await names(page)).filter((n) => /STORAGE (upload|download|remove)|replace/.test(n)), [], 'a download changes nothing'); await noForbidden(page, 'download'); await done('download', page); }
    { const page = await open(cfg({ signedError: 'Object not found' })); await row(page, '1.0.0').locator('[data-act="hist-download"]').click();
      await page.waitForFunction(() => document.querySelector('.toast.err')); assert.match((await toasts(page)).join('|'), /⚠ Could not download converter_image 1\.0\.0: Object not found/); await done('download-failure', page); }
    { const page = await open(cfg({ evilUrl: true })); let started = false; page.on('download', () => { started = true; });
      await row(page, '1.0.0').locator('[data-act="hist-download"]').click(); await page.waitForFunction(() => document.querySelector('.toast.err'));
      assert.match((await toasts(page)).join('|'), /unexpected address, so it was not opened/); assert.equal(started, false); await done('download-foreign-host', page); }

    // ---------- 3. replace success: order of calls, exact arguments, honest result, table shows the new hash, release stays not-yanked
    { const page = await open(cfg({})); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      assert.match(await dlg(page).innerText(), /Replaces the package file of converter_image 1\.0\.0[\s\S]*Its yanked status does not change[\s\S]*keeps the old files/);
      assert.match(await page.locator('#replace-checks').innerText(), /The package matches release\.json \(size and SHA-256\) and describes this exact release/);
      await page.click('#btn-replace-run'); await page.waitForSelector('#replace-status [data-kind="ok"]');
      assert.deepEqual((await names(page)).filter((n) => /STORAGE|replace|admin_get_addon_selection|admin_list_addon_releases/.test(n)).slice(0, 5),
        ['admin_list_addon_releases', 'admin_get_addon_selection', 'STORAGE download', 'STORAGE upload', 'admin_replace_addon_release'], 'check, backup copy, upload, database step -- in that order');
      assert.deepEqual((await uploads(page)), [{ name: 'STORAGE upload', bucket: 'addons', path: P('1.0.0'), contentType: 'application/zip', upsert: true, size: NEW100.length, sha: sha(NEW100) }]);
      assert.deepEqual(await replaceCalls(page), [{ name: 'admin_replace_addon_release', params: { p: { addon_id: 'converter_image', version: '1.0.0', size: NEW100.length, sha256: sha(NEW100), expected_sha256: sha(OLD['1.0.0']) } } }]);
      const ok = await statusText(page); assert.match(ok, /Package replaced\./); assert.ok(ok.includes(sha(NEW100)) && ok.includes(sha(OLD['1.0.0'])), 'old and new SHA-256 shown'); assert.match(ok, /It is not yanked\./); assert.match(ok, /audit entry/);
      assert.match((await toasts(page)).join('|'), /✓ converter_image 1\.0\.0: package replaced/);
      await page.waitForFunction((h) => document.querySelector('#addon-history-rows tr[data-version="1.0.0"] code').title === h, sha(NEW100));      // the tab reloaded from the server
      const st = await state(page); assert.equal(st.rels.find((r) => r.version === '1.0.0').yanked, false); assert.equal(st.objects[P('1.0.0')], NEW100.toString('base64'));
      assert.equal(st.sels.converter_image.active_version, '1.1.0', 'selection untouched'); assert.equal(await page.locator('#btn-replace-run').isDisabled(), true, 'cannot be run twice');
      await noForbidden(page, 'replace'); await page.click('.overlay .foot button'); await page.waitForSelector('.overlay', { state: 'detached' }); await done('replace-success', page); }

    // ---------- 4. a yanked release is replaced and STAYS yanked (no yank call at all)
    { const page = await open(cfg({})); const NEW090 = zip('NEW-0.9.0'); await openReplace(page, '0.9.0', files('0.9.0', NEW090)); await clearCalls(page);
      assert.match(await dlg(page).innerText(), /This release is yanked and stays yanked/); await page.click('#btn-replace-run'); await page.waitForSelector('#replace-status [data-kind="ok"]');
      assert.match(await statusText(page), /It is still yanked\./); const st = await state(page); assert.equal(st.rels.find((r) => r.version === '0.9.0').yanked, true); assert.equal(st.rels.find((r) => r.version === '0.9.0').sha256, sha(NEW090));
      await page.waitForFunction(() => document.querySelector('#addon-history-rows tr[data-version="0.9.0"]').dataset.yanked === '1'); await noForbidden(page, 'yanked replace'); await done('replace-yanked-stays-yanked', page); }

    // ---------- 5. wrong files: nothing is enabled, nothing is sent
    { const page = await open(cfg({})); await openReplace(page, '1.0.0', files('1.0.0', NEW100, { version: '1.1.0' })); await clearCalls(page);
      assert.match(await page.locator('#replace-checks').innerText(), /release\.json is for version 1\.1\.0, not 1\.0\.0/); assert.equal(await page.locator('#btn-replace-run').isDisabled(), true);
      await page.setInputFiles('#replace-sidecar', { name: 'release.json', mimeType: 'application/json', buffer: sidecar(NEW100, { size: 7, sha256: 'e'.repeat(64) }) });
      await page.waitForFunction(() => /Size differs/.test(document.querySelector('#replace-checks').innerText)); assert.match(await page.locator('#replace-checks').innerText(), /SHA-256 differs/); assert.equal(await page.locator('#btn-replace-run').isDisabled(), true);
      await page.setInputFiles('#replace-pkg', { name: 'x.zip', mimeType: 'application/zip', buffer: Buffer.from('not a zip') }); await page.waitForFunction(() => /\.mzaddon/.test(document.querySelector('#replace-checks').innerText));
      await page.setInputFiles('#replace-pkg', files('1.0.0', OLD['1.0.0']).pkg); await page.setInputFiles('#replace-sidecar', files('1.0.0', OLD['1.0.0']).side);
      await page.waitForFunction(() => /identical to the one already stored/.test(document.querySelector('#replace-checks').innerText)); assert.equal(await page.locator('#btn-replace-run').isDisabled(), true);
      await page.setInputFiles('#replace-pkg', files('1.0.0', NEW100).pkg); await page.setInputFiles('#replace-sidecar', files('1.0.0', NEW100, { seq: 99 }).side);
      await page.waitForFunction(() => /seq in release\.json \(99\)/.test(document.querySelector('#replace-checks').innerText)); assert.equal(await page.locator('#btn-replace-run').isDisabled(), true);
      assert.deepEqual(await calls(page), [], 'nothing sent'); await done('replace-validation', page); }

    // ---------- 6. the release became active while the window was open: the fresh check stops BEFORE touching Storage
    { const page = await open(cfg({})); await openReplace(page, '1.0.0', files('1.0.0', NEW100));
      await page.evaluate(() => { window.__state.sels.converter_image = { mode: 'pinned', active_version: '1.0.0', previous_version: '1.1.0', revision: 8 }; }); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#replace-status').innerText));
      assert.match(await statusText(page), /Nothing was changed\. This is the ACTIVE version/); assert.deepEqual((await names(page)).filter((n) => /STORAGE|replace/.test(n)), []);
      assert.equal(await page.locator('#btn-replace-run').isDisabled(), false, 'nothing changed, so the admin may adjust and retry'); await done('replace-became-active-before-start', page); }

    // ---------- 7. upload fails: database untouched, honest wording, Retry upload works
    { const page = await open(cfg({ uploadError: { message: 'Payload too large', times: 1 } })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-retry');
      const t = await statusText(page); assert.match(t, /Upload failed: Payload too large/); assert.match(t, /The database was NOT changed/); assert.match(t, /cannot be guaranteed/);
      assert.equal((await replaceCalls(page)).length, 0, 'no database step after a failed upload'); assert.equal(await page.locator('#btn-replace-restore').count(), 1); assert.equal(await page.locator('#btn-replace-save').count(), 1);
      await page.click('#btn-replace-retry'); await page.waitForSelector('#replace-status [data-kind="ok"]');
      assert.equal((await uploads(page)).length, 2); assert.equal((await replaceCalls(page)).length, 1); assert.equal(await count(page, 'STORAGE download'), 1, 'the copy is made once, not on every retry'); await noForbidden(page, 'upload failure'); await done('replace-upload-failure-retry', page); }

    // ---------- 8. database step fails after the upload: Storage-and-database mismatch is explained; Retry database step; or Restore previous package
    { const page = await open(cfg({ fail: { admin_replace_addon_release: { message: 'connection reset', once: true } } })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-retry');
      assert.match(await statusText(page), /The new package IS in Storage, but the database was NOT updated: connection reset/); assert.equal((await state(page)).rels.find((r) => r.version === '1.0.0').sha256, sha(OLD['1.0.0']));
      assert.equal(await page.locator('#btn-replace-run').isDisabled(), true, 'cannot start another replace in this state');
      await page.keyboard.press('Escape'); assert.equal(await dlg(page).count(), 1, 'Escape does not close the window while Storage and the database disagree');
      await page.mouse.click(5, 5); assert.equal(await dlg(page).count(), 1, 'clicking outside does not close it either'); await page.click('.overlay .foot button'); assert.equal(await dlg(page).count(), 1, 'Close refuses too');
      await page.click('#btn-replace-retry'); await page.waitForSelector('#replace-status [data-kind="ok"]');
      assert.equal((await replaceCalls(page)).length, 2, 'only the database step was repeated'); assert.equal((await uploads(page)).length, 1, 'the file was not uploaded again'); await done('replace-db-failure-retry', page); }
    { const page = await open(cfg({ fail: { admin_replace_addon_release: { message: 'connection reset', once: true } } })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-restore'); await page.click('#btn-replace-restore'); await page.waitForSelector('#replace-status [data-kind="ok"]');
      const ups = await uploads(page); assert.equal(ups.length, 2); assert.equal(ups[1].sha, sha(OLD['1.0.0']), 'the saved previous package was uploaded again'); assert.equal(ups[1].path, P('1.0.0')); assert.equal(ups[1].upsert, true);
      assert.equal((await replaceCalls(page)).length, 1, 'restoring does not call the database'); const st = await state(page);
      assert.equal(st.objects[P('1.0.0')], OLD['1.0.0'].toString('base64')); assert.equal(st.rels.find((r) => r.version === '1.0.0').sha256, sha(OLD['1.0.0']), 'Storage and database describe the same package again');
      assert.match(await statusText(page), /previous package was uploaded to Storage again[\s\S]*never changed[\s\S]*Nothing was replaced/);
      await page.click('.overlay .foot button'); await page.waitForSelector('.overlay', { state: 'detached' }); await noForbidden(page, 'restore'); await done('replace-db-failure-restore', page); }

    // ---------- 9. THE GAP: the release became active between upload and database step -> server refuses -> urgent restore, and it works
    { const page = await open(cfg({ onUpload: 'activate', raceAddon: 'converter_image', raceVersion: '1.0.0' })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-restore');
      const t = await statusText(page); assert.match(t, /it is the ACTIVE version/); assert.match(t, /fail to install it: put the previous package back now/); assert.equal(await page.locator('#btn-replace-retry').count(), 0, 'retrying cannot help');
      assert.match(await page.locator('#btn-replace-restore').getAttribute('class'), /primary/);
      await page.click('#btn-replace-restore'); await page.waitForSelector('#replace-status [data-kind="ok"]'); const st = await state(page);
      assert.equal(st.objects[P('1.0.0')], OLD['1.0.0'].toString('base64')); assert.equal(st.rels.find((r) => r.version === '1.0.0').sha256, sha(OLD['1.0.0'])); await noForbidden(page, 'gap'); await done('replace-race-active-in-gap', page); }

    // ---------- 10. somebody else changed the release in the gap: "stale" -> no blind restore; Reload; leaving needs the explicit button
    { const page = await open(cfg({ onUpload: 'bump' })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-reload');
      assert.match(await statusText(page), /database was NOT updated: stale: this release was changed by someone else[\s\S]*restoring automatically is not offered/);
      assert.equal(await page.locator('#btn-replace-restore').count(), 0, 'no restore after a stale refusal'); assert.equal(await page.locator('#btn-replace-retry').count(), 0);
      await page.click('#btn-replace-leave'); await page.waitForSelector('.overlay', { state: 'detached' }); assert.match((await toasts(page)).join('|'), /Storage and the database may disagree\. Run Replace package again with the same two files/); await done('replace-stale-in-gap', page); }

    // ---------- 11. migration 0014 missing: Replace is disabled with the reason, Download still works; and if the function vanishes mid-way the dialog says so
    { const page = await open(cfg({ managedError: 'Could not find the function public.admin_list_addons without parameters in the schema cache' }));
      assert.equal(await row(page, '1.0.0').locator('[data-act="hist-replace"]').isDisabled(), true); assert.match(await row(page, '1.0.0').locator('[data-act="hist-replace"]').getAttribute('title'), /migration 0014/);
      assert.equal(await row(page, '1.0.0').locator('[data-act="hist-download"]').isDisabled(), false); await done('migration-0014-missing', page); }
    { const page = await open(cfg({ fail: { admin_replace_addon_release: { message: 'Could not find the function public.admin_replace_addon_release(p) in the schema cache' } } })); await openReplace(page, '1.0.0', files('1.0.0', NEW100));
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-restore'); assert.match(await statusText(page), /admin_replace_addon_release is not available on this server \(database migration 0014 has not been applied yet\)/);
      assert.match(await page.locator('#btn-replace-restore').getAttribute('class'), /primary/); await page.click('#btn-replace-restore'); await page.waitForSelector('#replace-status [data-kind="ok"]');
      assert.equal((await state(page)).objects[P('1.0.0')], OLD['1.0.0'].toString('base64')); await done('function-missing-midway', page); }

    // ---------- 12. no restore copy possible: refuses by default (nothing changed); proceeds only when the admin ticks the box
    { const page = await open(cfg({ downloadError: 'Object not found' })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page);
      await page.click('#btn-replace-run'); await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#replace-status').innerText)); assert.match(await statusText(page), /restore copy of the current package could not be made \(the stored package could not be read: Object not found\)/);
      assert.equal((await uploads(page)).length, 0); assert.equal((await replaceCalls(page)).length, 0);
      await page.check('#replace-no-backup'); await page.click('#btn-replace-run'); await page.waitForSelector('#replace-status [data-kind="ok"]'); assert.equal((await uploads(page)).length, 1); assert.equal((await replaceCalls(page)).length, 1); await done('replace-no-backup-optin', page); }
    { const page = await open(cfg({ fail: { admin_replace_addon_release: { message: 'connection reset', once: true } }, downloadError: 'Object not found' })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await page.check('#replace-no-backup');
      await page.click('#btn-replace-run'); await page.waitForSelector('#btn-replace-retry'); assert.equal(await page.locator('#btn-replace-restore').count(), 0, 'no restore button when there is no copy'); assert.equal(await page.locator('#btn-replace-save').count(), 0); await done('replace-no-backup-failure', page); }
    { const st = STATE(); st.objects[P('1.0.0')] = zip('somebody-uploaded-something-else').toString('base64');            // Storage already differs from the database record
      const page = await open(cfg({ state: st })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await clearCalls(page); await page.click('#btn-replace-run');
      await page.waitForFunction(() => /Nothing was changed/.test(document.querySelector('#replace-status').innerText)); assert.match(await statusText(page), /does not match the database record/); assert.equal((await uploads(page)).length, 0); await done('replace-storage-differs', page); }

    // ---------- 13. while a step runs the window cannot be closed; afterwards it can
    { const page = await open(cfg({ holdUpload: true })); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await page.click('#btn-replace-run');
      await page.waitForFunction(() => /Step 3 of 4/.test(document.querySelector('#replace-status').innerText)); assert.equal(await page.locator('#btn-replace-run').isDisabled(), true);
      await page.keyboard.press('Escape'); await page.mouse.click(5, 5); await page.click('.overlay .foot button'); assert.equal(await dlg(page).count(), 1, 'still open while uploading');
      assert.equal(await page.locator('#replace-pkg').isDisabled(), true); await page.evaluate(() => window.__releaseUpload()); await page.waitForSelector('#replace-status [data-kind="ok"]');
      await page.keyboard.press('Escape'); await page.waitForSelector('.overlay', { state: 'detached' }); assert.equal((await replaceCalls(page)).length, 1, 'one database call'); await done('busy-window-cannot-close', page); }

    // ---------- 14. phone layout
    { const page = await open(cfg({})); await page.setViewportSize({ width: 390, height: 900 }); await openReplace(page, '1.0.0', files('1.0.0', NEW100)); await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'no horizontal page scroll at 390px');
      const over = await page.evaluate(() => { const m = document.querySelector('#replace-dialog').closest('.modal'); return [...m.querySelectorAll('*')].filter((e) => e.getBoundingClientRect().right > m.getBoundingClientRect().right + 1 && getComputedStyle(e).position !== 'fixed').map((e) => e.tagName + '#' + e.id); });
      assert.deepEqual(over, [], 'nothing in the dialog sticks out of it at 390px'); await done('phone-layout', page); }
  } finally { await browser.close(); server.close(); }
  console.log('PASS scenarios: ' + results.join(', '));
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
