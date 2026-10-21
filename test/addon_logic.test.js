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
