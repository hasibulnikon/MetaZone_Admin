// node MetaZone_Admin/test/addon_logic.test.js   (no dependencies; uses node:test + node:assert)
const test = require('node:test'); const assert = require('node:assert/strict'); const crypto = require('node:crypto');
const L = require('../addon_logic.js');
const good = () => ({ addon_id: 'converter_image', version: '1.0.0', seq: 1, channel: 'stable', size: 1234, sha256: 'a'.repeat(64), feature_key: 'converter_image',
  title: 'Image Converter', summary: 's', min_core: 'v0.9.9.10', max_core: null, notes: { pages: ['p'], problems: [], fixes: ['f'] } });

test('valid sidecar normalises and derives the storage path', () => {
  const r = L.validateSidecar({ ...good(), sha256: 'A'.repeat(64), channel: undefined }, { featureKeys: new Set(['converter_image']) });
  assert.equal(r.ok, true, r.errors.join('; '));
  assert.equal(r.release.sha256, 'a'.repeat(64)); assert.equal(r.release.channel, 'stable');
  assert.equal(r.release.storage_path, 'converter_image/1.0.0/converter_image-1.0.0.mzaddon');
});
test('invalid sidecars are refused with a reason', () => {
  const bad = [[{ addon_id: 'Bad-Id' }, /addon_id/], [{ version: 'latest' }, /version/], [{ seq: 0 }, /seq/], [{ seq: '2' }, /seq/], [{ seq: 1.5 }, /seq/],
    [{ size: 0 }, /size/], [{ size: '10' }, /size/], [{ sha256: 'abc' }, /sha256/], [{ feature_key: 'x'.repeat(40) }, /feature_key/], [{ title: '' }, /title/],
    [{ min_core: 'x.y' }, /min_core/], [{ min_core: '2.0', max_core: '1.0' }, /newer than max_core/], [{ notes: [] }, /notes must be/],
    [{ notes: { bogus: [] } }, /not allowed/], [{ notes: { fixes: [1] } }, /list of up to 50/], [{ channel: 'Bad Channel' }, /channel/]];
  for (const [patch, re] of bad) { const r = L.validateSidecar({ ...good(), ...patch }); assert.equal(r.ok, false, JSON.stringify(patch)); assert.match(r.errors.join('|'), re); }
  for (const f of ['addon_id', 'version', 'seq', 'size', 'sha256', 'feature_key', 'title']) { const o = good(); delete o[f]; assert.equal(L.validateSidecar(o).ok, false, f); }
  assert.equal(L.validateSidecar([1]).ok, false); assert.equal(L.validateSidecar(null).ok, false);
  assert.equal(L.parseSidecar('{nope').ok, false);
  assert.equal(L.parseSidecar('﻿' + JSON.stringify(good())).ok, true);                     // Windows tools often write a BOM
  assert.equal(L.validateSidecar(good(), { featureKeys: new Set(['tracker']) }).ok, false);        // unknown feature on this server
});
test('core versions compare numerically', () => {
  assert.equal(L.cmpCore(L.parseCore('v0.9.9.10'), L.parseCore('0.9.9.9')), 1);
  assert.equal(L.cmpCore(L.parseCore('1.0'), L.parseCore('v1.0.0.0')), 0); assert.equal(L.parseCore('banana'), null);
});
test('package must match the sidecar exactly (size + sha-256 + zip + extension)', () => {
  const rel = L.validateSidecar(good()).release; const pkg = { name: 'x.mzaddon', size: 1234, sha256: 'a'.repeat(64), head: [0x50, 0x4b, 3, 4] };
  assert.deepEqual(L.checkPackage(rel, pkg), []);
  assert.match(L.checkPackage(rel, { ...pkg, size: 1235 }).join('|'), /Size differs/);
  assert.match(L.checkPackage(rel, { ...pkg, sha256: 'b'.repeat(64) }).join('|'), /SHA-256 differs/);
  assert.match(L.checkPackage(rel, { ...pkg, name: 'x.zip' }).join('|'), /\.mzaddon/);
  assert.match(L.checkPackage(rel, { ...pkg, head: [1, 2, 3, 4] }).join('|'), /not a ZIP/);
});
test('conflicts with published releases: same version, non-increasing seq; other add-ons ignored', () => {
  const rel = L.validateSidecar({ ...good(), seq: 3 }).release;
  const ex = [{ addon_id: 'converter_image', version: '1.0.0', seq: 3 }, { addon_id: 'converter_video', version: '1.0.0', seq: 9 }];
  const e = L.conflictsWith(rel, ex).join('|'); assert.match(e, /already published/); assert.match(e, /seq 3 is not higher/);
  assert.deepEqual(L.conflictsWith({ ...rel, version: '1.0.1', seq: 4 }, ex), []);
  assert.deepEqual(L.conflictsWith(rel, []), []);
});
test('sha256Hex matches node crypto and refuses without subtle crypto', async () => {
  const buf = Buffer.from('MetaZone add-on'); const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
  assert.equal(await L.sha256Hex(ab, crypto.webcrypto.subtle), crypto.createHash('sha256').update(buf).digest('hex'));
  await assert.rejects(() => L.sha256Hex(ab, undefined), /cannot compute SHA-256/);
});
test('formatting helpers, notes sections and page grouping', () => {
  assert.equal(L.fmtBytes(1234), '1.2 KB'); assert.equal(L.fmtBytes(5 * 1024 * 1024), '5.0 MB'); assert.equal(L.fmtBytes(null), '—'); assert.equal(L.shortHash('a'.repeat(64)), 'aaaaaaaaaa…');
  assert.deepEqual(L.noteSections({ fixes: ['f'], pages: ['p'], problems: [] }), [['Pages', ['p']], ['Fixes', ['f']]]);
  assert.deepEqual(L.noteSections(null), []);
  const g = L.groupPages([{ page_key: 'meta', kind: 'page' }, { page_key: 'settings', kind: 'page' }, { page_key: 'embed_video', kind: 'addon' }, { page_key: 'old' }]);
  assert.deepEqual(g.pages.map((p) => p.page_key), ['meta', 'old']); assert.deepEqual(g.addons.map((p) => p.page_key), ['embed_video']);
});
test('Task 2: protected pages, activation blocks, selection descriptions, audit lines', () => {
  assert.deepEqual(L.PROTECTED_PAGES, ['dashboard', 'appearance', 'settings']);
  assert.equal(L.isProtectedPage('appearance'), true); assert.equal(L.isProtectedPage('p2p'), false);
  assert.equal(L.activateBlock({ yanked: false, block_reason: null, selectable: true }), null);
  assert.match(L.activateBlock({ yanked: true }), /yanked/);
  assert.equal(L.activateBlock({ block_reason: 'needs app 0.9.9.11 or newer' }), 'needs app 0.9.9.11 or newer');
  assert.equal(L.activateBlock({ selectable: false }), 'not selectable'); assert.equal(L.activateBlock(null), 'unknown release');
  assert.equal(L.describeSelection({ mode: 'pinned', active_version: '1.0.0' }).kind, 'pinned');
  assert.match(L.describeSelection({ mode: 'pinned', active_version: '1.0.0' }).label, /v1\.0\.0/);
  assert.equal(L.describeSelection({ mode: 'auto', effective_version: '1.2.0' }).warn, null);
  assert.ok(L.describeSelection({ mode: 'auto', effective_version: null }).warn);
  assert.ok(L.describeSelection({ mode: 'withdrawn' }).warn); assert.equal(L.describeSelection(null).kind, 'none');
  assert.equal(L.selectionFor([{ addon_id: 'a' }], 'a').addon_id, 'a'); assert.equal(L.selectionFor([], 'a'), null);
  assert.equal(L.auditLine({ action: 'page_set', target: 'p2p', detail: { enabled: false }, actor_email: 'x@y' }), 'page_set · p2p (enabled=false) — x@y');
});

// ---- Step 2.1: read-only Add-on manager list (shape = admin_list_addons() in 0014_addon_manager.sql) ----
const listRow = (o) => ({ addon_id: 'converter_image', name: 'Image Converter', description: 'Converts images', registered: true, feature_key: 'converter_image',
  release_count: 3, yanked_count: 1, latest_version: '1.2.0', deleted_count: 2, mode: 'pinned', active_version: '1.1.0', previous_version: null, revision: 4,
  effective_version: '1.1.0', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-02-01T00:00:00Z', ...o });

test('Step 2.1: a list row becomes a view model (counts, offered version, registry flag)', () => {
  const v = L.describeManagedAddon(listRow());
  assert.equal(v.id, 'converter_image'); assert.equal(v.name, 'Image Converter'); assert.equal(v.description, 'Converts images');
  assert.equal(v.registered, true); assert.equal(v.featureKey, 'converter_image'); assert.equal(v.latestVersion, '1.2.0');
  assert.deepEqual(v.releases, { total: 3, yanked: 1, deleted: 2 });
  assert.equal(v.offered.kind, 'pinned'); assert.equal(v.offered.version, '1.1.0'); assert.equal(v.offered.warn, null);
  const auto = L.describeManagedAddon(listRow({ mode: 'auto', active_version: null, effective_version: '1.2.0' }));
  assert.equal(auto.offered.kind, 'auto'); assert.equal(auto.offered.version, '1.2.0');
  const wd = L.describeManagedAddon(listRow({ mode: 'withdrawn', active_version: null, effective_version: null }));
  assert.equal(wd.offered.kind, 'withdrawn'); assert.equal(wd.offered.version, null); assert.ok(wd.offered.warn);
  const none = L.describeManagedAddon(listRow({ mode: 'none', active_version: null, effective_version: null }));
  assert.equal(none.offered.kind, 'none'); assert.equal(none.offered.version, null); assert.ok(none.offered.warn);
});

test('Step 2.1: unregistered / empty / malformed rows are safe', () => {
  const un = L.describeManagedAddon(listRow({ registered: false, name: 'fallback_title', description: null, created_at: null, updated_at: null }));
  assert.equal(un.registered, false); assert.equal(un.description, ''); assert.equal(un.updatedAt, null);
  const empty = L.describeManagedAddon(listRow({ release_count: 0, yanked_count: 0, latest_version: null, feature_key: null, mode: 'none', active_version: null, effective_version: null }));
  assert.equal(empty.latestVersion, null); assert.equal(empty.featureKey, null); assert.equal(empty.offered.version, null); assert.equal(empty.offered.warn, null);
  assert.match(empty.offered.label, /No releases/);
  const blankName = L.describeManagedAddon(listRow({ name: '   ' })); assert.equal(blankName.name, 'converter_image');            // falls back to the id
  for (const bad of [null, undefined, 5, 'x', [], {}, { addon_id: 7, release_count: -1, yanked_count: 'a', registered: 'yes' }]) {
    const v = L.describeManagedAddon(bad); assert.equal(typeof v.id, 'string'); assert.deepEqual(v.releases, { total: 0, yanked: 0, deleted: 0 }); assert.equal(v.registered, false);
  }
});

test('Step 2.1: list and summary', () => {
  const data = [listRow(), listRow({ addon_id: 'tracker', name: 'Tracker', mode: 'none', active_version: null, effective_version: null }), null, { name: 'no id' }];
  const list = L.describeManagedAddons(data);
  assert.deepEqual(list.map((a) => a.id), ['converter_image', 'tracker']);                           // entries without an id are dropped
  assert.deepEqual(L.summarizeManagedAddons(list), { total: 2, offered: 1, notOffered: 1 });
  assert.deepEqual(L.describeManagedAddons(null), []); assert.deepEqual(L.describeManagedAddons({}), []); assert.deepEqual(L.describeManagedAddons([]), []);
  assert.deepEqual(L.summarizeManagedAddons([]), { total: 0, offered: 0, notOffered: 0 }); assert.deepEqual(L.summarizeManagedAddons(undefined), { total: 0, offered: 0, notOffered: 0 });
});

test('Step 2.1: a missing RPC (migration not applied) is told apart from other errors', () => {
  assert.equal(L.isMissingRpcError('Could not find the function public.admin_list_addons without parameters in the schema cache', 'admin_list_addons'), true);
  assert.equal(L.isMissingRpcError('function public.admin_list_addons() does not exist', 'admin_list_addons'), true);
  assert.equal(L.isMissingRpcError('PGRST202: admin_list_addons', 'admin_list_addons'), true);
  assert.equal(L.isMissingRpcError('Could not find the function public.admin_overview without parameters', 'admin_list_addons'), false);      // another function
  assert.equal(L.isMissingRpcError('forbidden', 'admin_list_addons'), false); assert.equal(L.isMissingRpcError('Failed to fetch', 'admin_list_addons'), false);
  assert.equal(L.isMissingRpcError(null, 'admin_list_addons'), false); assert.equal(L.isMissingRpcError(undefined), false);
});

// ---- Step 2.2: create / edit validation (mirrors admin_upsert_addon in 0014_addon_manager.sql; the server stays the authority) ----
const managed = (rows) => L.describeManagedAddons(rows);
const existingList = managed([listRow(), listRow({ addon_id: 'tracker', name: 'Tracker', description: '', registered: false, updated_at: null })]);

test('Step 2.2: id rule is exactly ^[a-z0-9_]{1,32}$', () => {
  for (const ok of ['a', 'converter_image', 'a1_b2', '_', '0', 'x'.repeat(32)]) assert.equal(L.validateAddonId(ok), null, ok);
  for (const bad of ['', '   ', null, undefined, 'x'.repeat(33), 'Upper', 'has space', 'a-b', 'a.b', 'é', 'a/b', "a'b", '<b>']) assert.ok(L.validateAddonId(bad), JSON.stringify(bad));
  assert.equal(L.validateAddonId('  trimmed_ok  '), null);                                           // surrounding blanks are trimmed (and the trimmed id is what is sent)
});

test('Step 2.2: name 1-80 and description 0-400 characters after trimming (code points, like char_length)', () => {
  assert.equal(L.validateAddonName('x'), null); assert.equal(L.validateAddonName('x'.repeat(80)), null); assert.equal(L.validateAddonName('  Name  '), null);
  assert.ok(L.validateAddonName('')); assert.ok(L.validateAddonName('   ')); assert.ok(L.validateAddonName(null)); assert.match(L.validateAddonName('x'.repeat(81)), /81 characters, maximum 80/);
  assert.equal(L.validateAddonName('😀'.repeat(80)), null); assert.ok(L.validateAddonName('😀'.repeat(81)));      // 1 emoji = 1 character, not 2 UTF-16 units
  assert.equal(L.validateAddonDescription(''), null); assert.equal(L.validateAddonDescription(null), null); assert.equal(L.validateAddonDescription('d'.repeat(400)), null);
  assert.equal(L.validateAddonDescription('  ' + 'd'.repeat(400) + '  '), null); assert.match(L.validateAddonDescription('d'.repeat(401)), /401 characters, maximum 400/);
  assert.deepEqual(L.ADDON_LIMITS, { id: 32, name: 80, description: 400 });
});

test('Step 2.2: create builds the exact RPC arguments and refuses duplicate / invalid ids', () => {
  const ok = L.checkAddonDraft({ id: ' new_addon ', name: '  My Add-on ', description: '  Does things  ' }, 'create', existingList);
  assert.equal(ok.ok, true); assert.deepEqual(ok.params, { p_addon: 'new_addon', p_name: 'My Add-on', p_description: 'Does things' });
  assert.deepEqual(Object.keys(ok.params), ['p_addon', 'p_name', 'p_description']);                    // the real parameter names of admin_upsert_addon
  assert.equal(L.checkAddonDraft({ id: 'new_addon', name: 'N' }, 'create', existingList).params.p_description, '');   // description is optional
  const dupReg = L.checkAddonDraft({ id: 'converter_image', name: 'X', description: '' }, 'create', existingList);
  assert.equal(dupReg.ok, false); assert.equal(dupReg.params, null); assert.match(dupReg.errors.id, /already exists.*overwrite/);
  const dupUnreg = L.checkAddonDraft({ id: 'tracker', name: 'X' }, 'create', existingList);
  assert.equal(dupUnreg.ok, false); assert.match(dupUnreg.errors.id, /already has releases but no name\/description record/);
  const bad = L.checkAddonDraft({ id: 'Bad Id', name: '', description: 'd'.repeat(401) }, 'create', existingList);
  assert.equal(bad.ok, false); assert.ok(bad.errors.id && bad.errors.name && bad.errors.description);
  assert.equal(L.checkAddonDraft({ id: 'ab', name: 'N' }, 'create', null).ok, true); assert.equal(L.checkAddonDraft(null, 'create', []).ok, false);
});

test('Step 2.2: edit keeps the id, needs a real change, and refuses an id that no longer exists', () => {
  const ch = L.checkAddonDraft({ id: 'converter_image', name: 'Image Converter 2', description: 'Converts images' }, 'edit', existingList);
  assert.equal(ch.ok, true); assert.deepEqual(ch.params, { p_addon: 'converter_image', p_name: 'Image Converter 2', p_description: 'Converts images' });
  const same = L.checkAddonDraft({ id: 'converter_image', name: ' Image Converter ', description: 'Converts images' }, 'edit', existingList);
  assert.equal(same.ok, false); assert.equal(same.errors.form, 'Nothing was changed.');
  assert.equal(L.checkAddonDraft({ id: 'tracker', name: 'Tracker', description: '' }, 'edit', existingList).ok, true);   // unregistered: saving unchanged text creates its record
  const gone = L.checkAddonDraft({ id: 'deleted_meanwhile', name: 'N', description: '' }, 'edit', existingList);
  assert.equal(gone.ok, false); assert.match(gone.errors.id, /no longer exists/);
  assert.equal(L.checkAddonDraft({ id: 'converter_image', name: '', description: '' }, 'edit', existingList).ok, false);
  assert.equal(L.checkAddonDraft({ id: 'converter_image', name: 'N', description: 'd'.repeat(401) }, 'edit', existingList).ok, false);
});

test('Step 2.2: a save counts as confirmed only when the server returns the row for that id', () => {
  assert.equal(L.savedRowMatches({ addon_id: 'a', name: 'N' }, 'a'), true);
  for (const bad of [null, undefined, 'ok', 5, [], {}, { addon_id: 'other' }]) assert.equal(L.savedRowMatches(bad, 'a'), false);
});

// ---------------- Step 2.3: version history + release selection ----------------
const rel = (v, seq, o = {}) => ({ addon_id: 'converter_image', version: v, seq, channel: 'stable', feature_key: 'converter_image', title: 'Image Converter', summary: '', size: 5000, sha256: 'b'.repeat(64),
  published_at: '2026-01-0' + seq + 'T00:00:00Z', yanked: false, is_active: false, block_reason: null, selectable: true, min_core: null, max_core: null, notes: {}, ...o });
const selRow = (o) => ({ addon_id: 'converter_image', mode: 'pinned', active_version: '1.1.0', previous_version: '1.0.0', revision: 7, effective_version: '1.1.0', previous_block_reason: null, updated_at: '2026-02-01T00:00:00Z', updated_by_email: 'a@x', ...o });
const labelsOf = (row) => row.badges.map((b) => b.label);

test('Step 2.3: history is newest first, only this add-on, and labels active / offered / previous / published', () => {
  const rels = [rel('1.0.0', 1), rel('1.1.0', 2, { is_active: true }), rel('1.2.0', 3), { ...rel('9.9.9', 9), addon_id: 'other' }, null];
  const v = L.describeVersionHistory('converter_image', rels, [selRow()], null);
  assert.deepEqual(v.rows.map((r) => r.version), ['1.2.0', '1.1.0', '1.0.0']);
  assert.deepEqual(labelsOf(v.rows[1]), ['Active', 'Offered']); assert.deepEqual(labelsOf(v.rows[2]), ['Previous selection']); assert.deepEqual(labelsOf(v.rows[0]), ['Published']);
  assert.equal(v.state.kind, 'pinned'); assert.equal(v.state.label, 'Active: v1.1.0'); assert.equal(v.state.warn, null); assert.equal(v.state.revision, 7);
  assert.deepEqual(v.counts, { total: 3, yanked: 0, offered: 1, deleted: null });
  assert.equal(v.rows[1].activate.show, false, 'the chosen version has no Make active button'); assert.equal(v.rows[0].activate.show, true); assert.equal(v.rows[0].activate.block, null);
  assert.deepEqual([v.controls.auto.show, v.controls.restorePrevious.show, v.controls.restorePrevious.version, v.controls.withdraw.block], [true, true, '1.0.0', null]);
});

test('Step 2.3: yanked releases are marked and cannot be activated; a chosen release that is not offered is a warning, not "ok"', () => {
  const rels = [rel('1.0.0', 1, { yanked: true, block_reason: 'this release is yanked: restore it first (restoring does not activate it)', selectable: false }),
    rel('1.1.0', 2, { block_reason: 'it does not support any app version that is currently active', selectable: false })];
  const v = L.describeVersionHistory('converter_image', rels, [selRow({ previous_version: '1.0.0', effective_version: null })], null);
  const y = v.rows.find((r) => r.version === '1.0.0'), c = v.rows.find((r) => r.version === '1.1.0');
  assert.ok(labelsOf(y).includes('Yanked')); assert.equal(y.canRestore, true); assert.equal(y.canYank, false); assert.match(y.activate.block, /yanked/);
  assert.deepEqual(labelsOf(c), ['Active, not offered']); assert.equal(c.badges[0].kind, 'warn'); assert.match(c.badges[0].title, /does not support any app version/);
  assert.equal(v.state.label, 'Active: v1.1.0 (not offered)'); assert.match(v.state.warn, /NOT offered it: it does not support any app version/);
  assert.equal(L.describeVersionHistory('converter_image', rels, [selRow({ active_version: '1.1.0' })], null).rows.some((r) => r.offered), false);
});

test('Step 2.3: automatic mode marks the offered release as automatic, Automatic control is hidden', () => {
  const v = L.describeVersionHistory('converter_image', [rel('1.0.0', 1), rel('1.1.0', 2, { is_active: true })], [selRow({ mode: 'auto', active_version: null, previous_version: null, effective_version: '1.1.0' })], null);
  assert.deepEqual(labelsOf(v.rows[0]), ['Offered (automatic)']); assert.equal(v.state.kind, 'auto'); assert.equal(v.state.label, 'Automatic: v1.1.0');
  assert.equal(v.controls.auto.show, false); assert.equal(v.controls.restorePrevious.show, false); assert.equal(v.rows[0].activate.show, true);
  const none = L.describeVersionHistory('converter_image', [rel('1.0.0', 1, { yanked: true, block_reason: 'yanked', selectable: false })], [selRow({ mode: 'auto', active_version: null, effective_version: null })], null);
  assert.equal(none.state.label, 'Automatic: nothing eligible'); assert.ok(none.state.warn);
});

test('Step 2.3: withdrawn is a state of the add-on, shown distinctly; Deactivate is blocked; Restore previous is the way back', () => {
  const v = L.describeVersionHistory('converter_image', [rel('1.0.0', 1), rel('1.1.0', 2)], [selRow({ mode: 'withdrawn', active_version: null, previous_version: '1.1.0', effective_version: null, revision: 9 })], null);
  assert.equal(v.state.kind, 'withdrawn'); assert.equal(v.state.label, 'Withdrawn'); assert.match(v.state.warn, /offered nothing/); assert.match(v.state.note, /Previous selection: v1\.1\.0/);
  assert.deepEqual(labelsOf(v.rows[0]), ['Active before withdrawal']); assert.equal(v.rows.some((r) => r.offered), false);
  assert.match(v.controls.withdraw.block, /Already deactivated/); assert.equal(v.controls.restorePrevious.show, true); assert.equal(v.controls.auto.show, true); assert.equal(v.state.revision, 9);
  const blocked = L.describeVersionHistory('converter_image', [rel('1.0.0', 1)], [selRow({ mode: 'withdrawn', active_version: null, previous_version: '1.0.0', previous_block_reason: 'this release is yanked' })], null);
  assert.equal(blocked.controls.restorePrevious.block, 'this release is yanked'); assert.match(blocked.rows[0].badges.find((b) => b.label === 'Active before withdrawal').title, /Cannot be restored: this release is yanked/);
});

test('Step 2.3: no selection row yet (mode none) and no selection data at all (unknown)', () => {
  const rels = [rel('1.0.0', 1)];
  const none = L.describeVersionHistory('converter_image', rels, [selRow({ mode: 'none', active_version: null, previous_version: null, effective_version: null, revision: 0 })], null);
  assert.equal(none.state.kind, 'none'); assert.equal(none.state.revision, 0); assert.match(none.controls.withdraw.block, /nothing to deactivate/); assert.equal(none.controls.auto.block, null);
  const noneBlocked = L.describeVersionHistory('converter_image', [rel('1.0.0', 1, { block_reason: 'x', selectable: false })], [selRow({ mode: 'none', active_version: null, previous_version: null, revision: 0 })], null);
  assert.match(noneBlocked.controls.auto.block, /No release can be offered yet/);
  const unk = L.describeVersionHistory('converter_image', rels, [], null);                  // server without 0013 / no data: nothing is guessed, no selection controls
  assert.equal(unk.state.kind, 'unknown'); assert.equal(unk.state.revision, null);
  assert.deepEqual([unk.controls.auto.show, unk.controls.restorePrevious.show, unk.controls.withdraw.show], [false, false, false]); assert.equal(unk.rows[0].activate.show, true);
  assert.equal(L.describeVersionHistory('nope', rels, [], null).rows.length, 0);
  for (const bad of [null, undefined, 'x', {}]) assert.equal(L.describeVersionHistory('converter_image', bad, bad, bad).rows.length, 0);   // never throws
});

test('Step 2.3: release metadata is passed through as data (not markup), with the registry name and deleted count when 0014 is there', () => {
  const rels = [rel('1.0.0', 1, { summary: '<b>s</b>', min_core: 'v0.9.9.10', max_core: null, channel: 'beta', notes: { pages: ['p1'], problems: [], fixes: ['f1'] } })];
  const m = L.describeManagedAddon({ addon_id: 'converter_image', name: 'Image Converter', description: 'd', registered: true, release_count: 1, deleted_count: 2 });
  const v = L.describeVersionHistory('converter_image', rels, [selRow()], m);
  assert.deepEqual([v.rows[0].channel, v.rows[0].minCore, v.rows[0].maxCore, v.rows[0].summary, v.rows[0].size, v.rows[0].sha256], ['beta', 'v0.9.9.10', null, '<b>s</b>', 5000, 'b'.repeat(64)]);
  assert.deepEqual(v.rows[0].notes, [['Pages', ['p1']], ['Fixes', ['f1']]]); assert.equal(v.counts.deleted, 2); assert.equal(v.registered, true);
});

test('Step 2.3: every selection action uses the real function and parameter names; the revision is passed through (null when unknown); yank sends it only when known (Step 8, 0017)', () => {
  const S = L.selectionCall;
  assert.deepEqual(S.activate('a', '1.0.0', 7), { fn: 'admin_set_addon_active', params: { p_addon: 'a', p_version: '1.0.0', p_expected_revision: 7 } });
  assert.deepEqual(S.activate('a', '1.0.0', 0).params.p_expected_revision, 0); assert.equal(S.activate('a', '1.0.0', undefined).params.p_expected_revision, null);
  assert.deepEqual(S.auto('a', 3), { fn: 'admin_clear_addon_active', params: { p_addon: 'a', p_expected_revision: 3 } });
  assert.deepEqual(S.restorePrevious('a', 3), { fn: 'admin_restore_previous_addon_active', params: { p_addon: 'a', p_expected_revision: 3 } });
  assert.deepEqual(S.withdraw('a', 3), { fn: 'admin_withdraw_addon', params: { p_addon: 'a', p_expected_revision: 3 } });
  assert.deepEqual(S.yank('a', '1.0.0', true), { fn: 'admin_yank_addon', params: { p_addon: 'a', p_version: '1.0.0', p_yank: true } });
  assert.deepEqual(S.yank('a', '1.0.0', false).params, { p_addon: 'a', p_version: '1.0.0', p_yank: false });
  assert.deepEqual(S.yank('a', '1.0.0', true, 7), { fn: 'admin_yank_addon', params: { p_addon: 'a', p_version: '1.0.0', p_yank: true, p_expected_revision: 7 } });
  assert.equal(S.yank('a', '1.0.0', true, 0).params.p_expected_revision, 0, 'revision 0 is a real value');
  assert.ok(!('p_expected_revision' in S.yank('a', '1.0.0', false, null).params) && !('p_expected_revision' in S.yank('a', '1.0.0', false, undefined).params), 'unknown revision: key omitted');
});

test('Step 2.3: a "stale:" refusal from the server is recognised, other errors are not', () => {
  assert.equal(L.isStaleError('stale: the selection for converter_image was changed by someone else (now revision 8). Reload the page and try again.'), true);
  assert.equal(L.isStaleError('cannot activate converter_image 1.0.0: this release is yanked'), false); assert.equal(L.isStaleError(null), false); assert.equal(L.isStaleError('forbidden'), false);
});

// ---------------------------------------------------------------- Step 2.4: package download + replace
const cur24 = () => ({ addon_id: 'converter_image', version: '1.0.0', seq: 2, channel: 'stable', size: 1234, sha256: 'a'.repeat(64), feature_key: 'converter_image', title: 'Image Converter', summary: 's', min_core: 'v0.9.9.10', max_core: null, yanked: false, is_active: false, storage_path: 'converter_image/1.0.0/converter_image-1.0.0.mzaddon' });
const side24 = (o) => ({ addon_id: 'converter_image', version: '1.0.0', seq: 2, channel: 'stable', size: 2000, sha256: 'b'.repeat(64), feature_key: 'converter_image', title: 'Image Converter', summary: 's', min_core: 'v0.9.9.10', max_core: null, ...o });
const pkg24 = (o) => ({ name: 'converter_image-1.0.0.mzaddon', size: 2000, sha256: 'b'.repeat(64), head: [0x50, 0x4b, 3, 4], ...o });

test('Step 2.4: replace is blocked for the pinned-active version and for the offered version, allowed otherwise (same rules as 0014 section G)', () => {
  const rels = [cur24(), { ...cur24(), version: '1.1.0', seq: 3 }, { ...cur24(), version: '0.9.0', seq: 1, yanked: true }];
  const sel = (o) => ({ addon_id: 'converter_image', mode: 'pinned', active_version: '1.1.0', previous_version: null, revision: 1, effective_version: '1.1.0', ...o });
  const v = L.describeVersionHistory('converter_image', rels.map((r) => ({ ...r, is_active: r.version === '1.1.0' })), [sel()], null);
  const by = (x) => v.rows.find((r) => r.version === x);
  assert.match(by('1.1.0').replace.block, /ACTIVE version/); assert.equal(by('1.0.0').replace.block, null); assert.equal(by('0.9.0').replace.block, null, 'a yanked release may be replaced');
  const auto = L.describeVersionHistory('converter_image', rels.map((r) => ({ ...r, is_active: r.version === '1.1.0' })), [sel({ mode: 'auto', active_version: null })], null);
  assert.match(auto.rows.find((r) => r.version === '1.1.0').replace.block, /offered this version right now/);
  const pinnedNotOffered = L.describeVersionHistory('converter_image', rels, [sel()], null);          // pinned but is_active false: the SERVER still refuses (pinned)
  assert.match(pinnedNotOffered.rows.find((r) => r.version === '1.1.0').replace.block, /ACTIVE version/);
  const unknown = L.describeVersionHistory('converter_image', rels, [], null);
  assert.match(unknown.rows[0].replace.block, /selection state could not be read/);
  assert.equal(by('1.0.0').storagePath, 'converter_image/1.0.0/converter_image-1.0.0.mzaddon');
});

test('Step 2.4: replaceEligibility re-checks fresh data (missing release, missing selection, pinned, offered)', () => {
  const s = { mode: 'pinned', active_version: '1.1.0' };
  assert.equal(L.replaceEligibility(cur24(), s), null); assert.match(L.replaceEligibility(null, s), /no longer exists/); assert.match(L.replaceEligibility(cur24(), null), /could not be read/);
  assert.match(L.replaceEligibility({ ...cur24(), version: '1.1.0' }, s), /ACTIVE/); assert.match(L.replaceEligibility({ ...cur24(), is_active: true }, { mode: 'auto' }), /offered/);
  assert.equal(L.replaceEligibility({ ...cur24(), version: '1.1.0' }, { mode: 'withdrawn', active_version: null }), null, 'withdrawn: nothing is pinned, nothing offered');
});

test('Step 2.4: checkReplacement accepts a matching new package and refuses every mismatch the RPC could not apply', () => {
  assert.deepEqual(L.checkReplacement(cur24(), side24(), pkg24()), { errors: [], warnings: [] });
  const errs = (s, p, c) => L.checkReplacement(c || cur24(), s, p).errors.join(' | ');
  assert.match(errs(side24({ addon_id: 'other' }), pkg24()), /for add-on other/); assert.match(errs(side24({ version: '1.0.1' }), pkg24()), /for version 1\.0\.1/);
  assert.match(errs(side24({ seq: 9 }), pkg24()), /seq in release\.json \(9\)/); assert.match(errs(side24({ feature_key: 'x' }), pkg24()), /feature_key/);
  assert.match(errs(side24({ channel: 'beta' }), pkg24()), /channel/); assert.match(errs(side24({ min_core: 'v0.9.9.11' }), pkg24()), /min_core/); assert.match(errs(side24({ max_core: 'v1.0.0' }), pkg24()), /max_core/);
  assert.equal(errs(side24({ min_core: '0.9.9.10' }), pkg24()), '', '"v" prefix is not a difference');
  assert.match(errs(side24(), pkg24({ sha256: 'c'.repeat(64) })), /SHA-256 differs/); assert.match(errs(side24(), pkg24({ size: 5 })), /Size differs/);
  assert.match(errs(side24(), pkg24({ name: 'x.zip' })), /\.mzaddon/); assert.match(errs(side24(), pkg24({ head: [0, 0, 0, 0] })), /not a ZIP/);
  assert.match(errs(side24({ sha256: 'a'.repeat(64), size: 1234 }), pkg24({ sha256: 'a'.repeat(64), size: 1234 })), /identical to the one already stored/);
  const w = L.checkReplacement(cur24(), side24({ title: 'New title', summary: 'new' }), pkg24()); assert.equal(w.errors.length, 0); assert.equal(w.warnings.length, 2);
  assert.match(L.checkReplacement(null, side24(), pkg24()).errors[0], /no longer exists/); assert.match(L.checkReplacement(cur24(), null, pkg24()).errors[0], /release\.json is missing/);
});

test('Step 2.4: the RPC call has the exact real name and field names (0014: addon_id, version, size, sha256, expected_sha256), nothing else', () => {
  const c = L.replaceCall(cur24(), pkg24());
  assert.deepEqual(c, { fn: 'admin_replace_addon_release', params: { p: { addon_id: 'converter_image', version: '1.0.0', size: 2000, sha256: 'b'.repeat(64), expected_sha256: 'a'.repeat(64) } } });
  assert.equal(typeof c.params.p.size, 'number'); assert.equal(L.replaceCall({ ...cur24(), sha256: undefined }, pkg24()).params.p.expected_sha256, null);
});

test('Step 2.4: a save is only believed when the returned release row carries the values that were sent', () => {
  const c = L.replaceCall(cur24(), pkg24()), row = { addon_id: 'converter_image', version: '1.0.0', size_bytes: 2000, sha256: 'b'.repeat(64), yanked: false };
  assert.equal(L.savedReplaceMatches(row, c), true); assert.equal(L.savedReplaceMatches({ ...row, sha256: 'a'.repeat(64) }, c), false); assert.equal(L.savedReplaceMatches({ ...row, size_bytes: 1 }, c), false);
  assert.equal(L.savedReplaceMatches({ ...row, version: '2.0.0' }, c), false); assert.equal(L.savedReplaceMatches(null, c), false); assert.equal(L.savedReplaceMatches([row], c), false); assert.equal(L.savedReplaceMatches('ok', c), false);
});

test('Step 2.4: server refusals are classified from the real 0014 texts', () => {
  const k = (m) => L.classifyReplaceError(m);
  assert.equal(k('stale: this release was changed by someone else. Reload the page and try again.'), 'stale');
  assert.equal(k('cannot replace the package of converter_image 1.0.0: it is the ACTIVE version. Publish a new version instead.'), 'in_use');
  assert.equal(k('cannot replace the package of converter_image 1.0.0: users are being offered it right now. Publish a new version instead.'), 'in_use');
  assert.equal(k('package not found in Storage at converter_image/1.0.0/x.mzaddon: upload it first'), 'storage'); assert.equal(k('size in Storage (5) differs from the given size (6)'), 'storage');
  assert.equal(k('Could not find the function public.admin_replace_addon_release(p) in the schema cache'), 'missing'); assert.equal(k('forbidden'), 'other'); assert.equal(k(null), 'other');
  assert.equal(L.packageFileName('converter_image', '1.0.0'), 'converter_image-1.0.0.mzaddon');
});

// ---------------------------------------------------------------- Step 2.5: delete + Storage clean-up (pure rules; SQL is NOT run here)
test('Step 2.5: delete eligibility mirrors the server (pinned-active / offered refused), also on fresh data', () => {
  assert.match(L.deleteBlock({ mode: 'pinned', chosen: true, offered: true }), /ACTIVE version/);
  assert.match(L.deleteBlock({ mode: 'auto', chosen: false, offered: true }), /offered this version right now/);
  assert.match(L.deleteBlock({ mode: 'unknown', chosen: false, offered: false }), /could not be read/);
  assert.equal(L.deleteBlock({ mode: 'pinned', chosen: false, offered: false }), null);
  const rel = { addon_id: 'a', version: '1.0.0', is_active: false };
  assert.equal(L.deleteEligibility(rel, { mode: 'pinned', active_version: '1.1.0' }), null);
  assert.match(L.deleteEligibility(rel, { mode: 'pinned', active_version: '1.0.0' }), /ACTIVE/);
  assert.match(L.deleteEligibility({ ...rel, is_active: true }, { mode: 'auto' }), /offered/);
  assert.match(L.deleteEligibility(null, {}), /no longer exists/); assert.match(L.deleteEligibility(rel, null), /could not be read/);
  const h = L.describeVersionHistory('converter_image', [
    { addon_id: 'converter_image', version: '1.0.0', seq: 1, is_active: false, yanked: false }, { addon_id: 'converter_image', version: '1.1.0', seq: 2, is_active: true, yanked: false }],
    [{ addon_id: 'converter_image', mode: 'pinned', active_version: '1.1.0', previous_version: '1.0.0', revision: 4, effective_version: '1.1.0' }], null);
  const by = (v) => h.rows.find((r) => r.version === v);
  assert.equal(by('1.0.0').del.block, null); assert.match(by('1.1.0').del.block, /ACTIVE/);
});

test('Step 2.5: exact RPC names and parameters; typed confirmation is exact and is what the server receives', () => {
  assert.deepEqual(L.deleteReleaseCall('a', '1.0.0', 7), { fn: 'admin_delete_addon_release', params: { p_addon: 'a', p_version: '1.0.0', p_expected_revision: 7 } });
  assert.equal(L.deleteReleaseCall('a', '1.0.0', undefined).params.p_expected_revision, null);
  assert.deepEqual(L.deleteAddonCall('a', 'a '), { fn: 'admin_delete_addon', params: { p_addon: 'a', p_confirm: 'a ' } });   // not trimmed, not replaced by the id
  assert.equal(L.confirmMatches('abc', 'abc'), true);
  for (const t of ['ABC', 'abc ', ' abc', 'ab', '', null, undefined]) assert.equal(L.confirmMatches(t, 'abc'), false, String(t));
  assert.equal(L.confirmMatches('', ''), false);
});

test('Step 2.5: only the exact server-enforced Storage path of THIS release/add-on is ever passed to Storage', () => {
  const P = 'converter_image/1.0.0/converter_image-1.0.0.mzaddon';
  assert.equal(L.isReleasePath(P, 'converter_image', '1.0.0'), true);
  for (const bad of ['converter_image/1.0.0/other.mzaddon', 'other/1.0.0/other-1.0.0.mzaddon', 'converter_image/1.0.1/converter_image-1.0.1.mzaddon', '../' + P, P + '/', '', null, 5]) assert.equal(L.isReleasePath(bad, 'converter_image', '1.0.0'), false, String(bad));
  const ok = L.parseDeleteReleaseResult({ addon_id: 'converter_image', version: '1.0.0', storage_path: P, was_yanked: true, revocation_kept: true }, 'converter_image', '1.0.0');
  assert.deepEqual(ok, { ok: true, path: P, rejected: null, wasYanked: true, revocationKept: true });
  const odd = L.parseDeleteReleaseResult({ addon_id: 'converter_image', version: '1.0.0', storage_path: 'other/x.mzaddon' }, 'converter_image', '1.0.0');
  assert.equal(odd.ok, true); assert.equal(odd.path, null); assert.equal(odd.rejected, 'other/x.mzaddon');         // DB deletion confirmed, nothing sent to Storage
  assert.equal(L.parseDeleteReleaseResult({ addon_id: 'converter_image', version: '1.0.0', storage_path: null }, 'converter_image', '1.0.0').path, null);
  for (const bad of [null, [], 'x', {}, { addon_id: 'x', version: '1.0.0' }, { addon_id: 'converter_image', version: '9.9.9' }]) assert.equal(L.parseDeleteReleaseResult(bad, 'converter_image', '1.0.0').ok, false);
  const r = L.parseDeleteAddonResult({ addon_id: 'converter_image', storage_paths: [P, P, 'converter_image/1.1.0/converter_image-1.1.0.mzaddon', 'other/1.0.0/other-1.0.0.mzaddon', 'converter_image/../x/converter_image-..mzaddon', 'converter_image/1.0.0/evil.mzaddon', 7, null], releases_deleted: 3, revocations_kept: 1 }, 'converter_image');
  assert.equal(r.ok, true); assert.deepEqual(r.paths, [P, 'converter_image/1.1.0/converter_image-1.1.0.mzaddon']); assert.equal(r.rejected.length, 5);
  assert.equal(r.releasesDeleted, 3); assert.equal(r.revocationsKept, 1);
  for (const bad of [null, [], {}, { addon_id: 'converter_image' }, { addon_id: 'converter_image', storage_paths: 'x' }, { addon_id: 'other', storage_paths: [] }]) assert.equal(L.parseDeleteAddonResult(bad, 'converter_image').ok, false);
});

test('Step 2.5: server refusals are classified from the real 0014 section F texts', () => {
  const k = (m, f) => L.classifyDeleteError(m, f);
  assert.equal(k('cannot delete 1.0.0: it is the ACTIVE version. Make another version active, or deactivate the add-on, first.'), 'in_use');
  assert.equal(k('cannot delete 1.0.0: users are being offered it right now (automatic mode). Choose another version or deactivate the add-on first.'), 'in_use');
  assert.equal(k('stale: the selection for converter_image was changed by someone else (now revision 9). Reload the page and try again.'), 'stale');
  assert.equal(k('unknown release'), 'unknown'); assert.equal(k('unknown add-on', 'admin_delete_addon'), 'unknown');
  assert.equal(k('confirmation text does not match the add-on id', 'admin_delete_addon'), 'confirm');
  assert.equal(k('Could not find the function public.admin_delete_addon_release(p_addon, p_version, p_expected_revision) in the schema cache'), 'missing');
  assert.equal(k('Could not find the function public.admin_delete_addon(p_addon, p_confirm) in the schema cache', 'admin_delete_addon'), 'missing');
  assert.equal(k('forbidden'), 'other'); assert.equal(k(null), 'other');
});

test('Step 2.5: Storage remove() result is split by what Storage reported; add-on impact is counted from the release list', () => {
  const a = 'x/1.0.0/x-1.0.0.mzaddon', b = 'x/1.1.0/x-1.1.0.mzaddon';
  assert.deepEqual(L.splitRemoved([a, b], [{ name: a }]), { removed: [a], notReported: [b] });
  assert.deepEqual(L.splitRemoved([a, b], []), { removed: [], notReported: [a, b] });
  assert.deepEqual(L.splitRemoved([a], null), { removed: [], notReported: [a] });
  assert.deepEqual(L.splitRemoved([a], [{ name: 'other' }, null, 5]), { removed: [], notReported: [a] });
  const imp = L.addonDeleteImpact([{ version: '1.1.0', yanked: false, is_active: true }, { version: '1.0.0', yanked: true }, { version: '0.9.0', yanked: false }]);
  assert.deepEqual(imp, { total: 3, yanked: 1, notYanked: 2, offeredVersion: '1.1.0', versions: ['0.9.0', '1.0.0', '1.1.0'] });
  assert.equal(L.addonDeleteImpact(null).total, 0); assert.equal(L.addonDeleteImpact([]).offeredVersion, null);
});

test('Step 2.7: the whole-add-on delete is blocked in the UI while an offered version is known, and the server refusal is explained', () => {
  assert.equal(L.deleteAddonBlock(null), null); assert.equal(L.deleteAddonBlock(''), null); assert.equal(L.deleteAddonBlock(undefined), null);
  const b = L.deleteAddonBlock('1.1.0');
  assert.match(b, /offered version 1\.1\.0 right now/); assert.match(b, /refuses to delete an add-on while it is offered/); assert.match(b, /Deactivate/); assert.match(b, /nothing is yanked or deleted/);
  // the real 0014 refusal text (section F, Step 2.7) is classified as 'in_use' and wrapped with what to do next
  const server = 'cannot delete add-on converter_image: users are being offered it right now (version 1.1.0, selection mode pinned). Deactivate the add-on first (Versions > Deactivate), then delete it.';
  assert.equal(L.classifyDeleteError(server, 'admin_delete_addon'), 'in_use');
  const t = L.addonDeleteRefusalText(server);
  assert.match(t, /^Nothing was deleted: the server refuses to delete an add-on while users are offered it\./); assert.ok(t.includes(server), 'the server text is kept');
  assert.match(t, /press Deactivate[\s\S]*installed copies on PCs are untouched[\s\S]*Nothing in Storage was touched/);
  assert.match(L.addonDeleteRefusalText(null), /^Nothing was deleted/);                  // never throws
  // the call itself is unchanged: still exactly two parameters, the typed text is passed through
  assert.deepEqual(L.deleteAddonCall('a', 'a'), { fn: 'admin_delete_addon', params: { p_addon: 'a', p_confirm: 'a' } });
});
