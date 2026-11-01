'use strict';
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const PL = require('../provider_logic.js');

const sha = crypto.createHash('sha256').update('pkg').digest('hex');
const good = () => ({ ok: true, sha256: sha, provider: 'Acme', title: 'Acme', version: '1.0.0', signature: { alg: 'ed25519', key_id: 'k-1', manifest: { sha256: sha, provider: 'Acme', version: '1.0.0' } }, validation: { ok: true, sha256: sha }, test: { ok: true, sha256: sha } });

test('parseReport accepts only a complete, consistent, passing report', () => {
  assert.ok(PL.parseReport(JSON.stringify(good())).ok);
  assert.ok(!PL.parseReport('{').ok);
  assert.ok(!PL.parseReport('null').ok);
  for (const [name, mut] of [
    ['not ok', (r) => { r.ok = false; }], ['no sha', (r) => { r.sha256 = 'x'; }], ['validation failed', (r) => { r.validation.ok = false; }],
    ['test failed', (r) => { r.test.ok = false; }], ['validation other file', (r) => { r.validation.sha256 = '0'.repeat(64); }],
    ['test other file', (r) => { r.test.sha256 = '1'.repeat(64); }], ['bad provider', (r) => { r.provider = 'bad key!'; }], ['no test', (r) => { delete r.test; }],
    ['unsigned', (r) => { delete r.signature; }], ['signature other file', (r) => { r.signature.manifest.sha256 = '2'.repeat(64); }], ['signature other version', (r) => { r.signature.manifest.version = '2.0.0'; }],
    ['no version', (r) => { delete r.version; }], ['unpacked too large', (r) => { r.unpacked_size = 21 * 1024 * 1024; }]]) {
    const r = good(); mut(r);
    assert.ok(!PL.parseReport(JSON.stringify(r)).ok, name);
  }
});

test('checkUpload requires the package and report to belong together', () => {
  const ok = { provider: 'Acme', size: 100, sha, report: good() };
  assert.deepStrictEqual(PL.checkUpload(ok), []);
  assert.ok(PL.checkUpload({ ...ok, sha: '2'.repeat(64) }).some((x) => /different file/.test(x)));
  assert.ok(PL.checkUpload({ ...ok, provider: 'Other' }).some((x) => /not "Other"/.test(x)));
  assert.ok(PL.checkUpload({ ...ok, report: null }).some((x) => /report/.test(x)));
  assert.ok(PL.checkUpload({ ...ok, size: PL.MAX_BYTES + 1 }).some((x) => /5 MB/.test(x)));
  assert.ok(PL.checkUpload({ ...ok, provider: '' }).length);
});

test('storage path matches the SQL rule provider/sha256.mzprovider', () => {
  assert.strictEqual(PL.storagePath('Acme', sha), `Acme/${sha}.mzprovider`);
  assert.ok(/^[A-Za-z0-9_.-]+\/[0-9a-f]{64}\.mzprovider$/.test(PL.storagePath('Acme', sha)));
});

test('publish / retire / delete rules mirror the database', () => {
  const k = (status, rep) => ({ status, sha256: sha, test_report: rep });
  assert.ok(PL.canPublish(k('tested', { sha256: sha })));
  assert.ok(!PL.canPublish(k('validated', null)) && !PL.canPublish(k('tested', { sha256: 'x' })) && !PL.canPublish(k('published', { sha256: sha })));
  assert.ok(PL.canTest(k('validated')) && !PL.canTest(k('published')));
  assert.ok(!PL.canDeletePackage(k('published')) && PL.canDeletePackage(k('retired')));
  assert.ok(!PL.canRetire(k('retired')) && PL.canRetire(k('published')));
  assert.ok(!PL.canDeleteProvider({ packages: [k('published')] }) && PL.canDeleteProvider({ packages: [k('superseded')] }) && PL.canDeleteProvider({}));
});

test('provider keys and effective state', () => {
  assert.ok(PL.validKey('Gemini') && PL.validKey('a.b-c_1') && !PL.validKey('has space') && !PL.validKey('1abc') && !PL.validKey(''));
  assert.ok(PL.effective({ enabled: true }, { enabled: true }) && !PL.effective({ enabled: false }, { enabled: true }) && !PL.effective({ enabled: true }, { enabled: false }));
});

test('sha256Hex matches node crypto (WebCrypto path)', async () => {
  const buf = new TextEncoder().encode('pkg');
  assert.strictEqual(await PL.sha256Hex(buf.buffer), sha);
});

test('one size limit: 5 MB packed, 20 MB unpacked (same as providers/limits.py and migration 0022)', () => {
  assert.strictEqual(PL.MAX_BYTES, 5242880); assert.strictEqual(PL.MAX_UNPACKED_BYTES, 20971520);
  assert.deepStrictEqual(PL.checkUpload({ provider: 'Acme', size: 3 * 1024 * 1024, sha, report: good() }), []);       // 3 MB: refused by the old 2 MB limit, fine now
});

test('force update helpers', () => {
  assert.strictEqual(PL.forceProviderBlocked({ packages: [] }), 'No published package');
  assert.match(PL.forceProviderBlocked({ packages: [{ status: 'published', signed: false }] }), /not signed/);
  assert.strictEqual(PL.forceProviderBlocked({ packages: [{ status: 'published', signed: true }] }), null);
  const lines = PL.previewLines({ scope: 'provider', title: 'Gemini', package_title: 'Gemini adapter', version: '1.1.0', size: 2048, signer: 'k', affected_users: 5, summary: 'S', warnings: ['off'] });
  const m = Object.fromEntries(lines.map(([k, v]) => [k, v]));
  assert.strictEqual(m['Target version'], '1.1.0'); assert.strictEqual(m['Package size'], '2.0 KB'); assert.strictEqual(m.Summary, 'S'); assert.strictEqual(m.Warning, 'off');
  const model = PL.previewLines({ scope: 'model', title: 'Mistral', model_id: 'm1', model: { label: 'M', enabled: false }, version: 7, affected_users: 1, summary: 'x' });
  assert.ok(model.some(([k, v]) => k === 'Model state' && v === 'off'));
  assert.ok(PL.canCancelJob({ status: 'active' }) && !PL.canCancelJob({ status: 'cancelled' }) && !PL.canCancelJob(null));
  assert.ok(PL.canRollbackJob({ kind: 'update', scope: 'provider', counts: { completed: 2 } }) && !PL.canRollbackJob({ kind: 'update', scope: 'provider', counts: { completed: 0 } })
    && !PL.canRollbackJob({ kind: 'rollback', scope: 'provider', counts: { completed: 2 } }) && !PL.canRollbackJob({ kind: 'update', scope: 'model', counts: { completed: 2 } }));
  assert.strictEqual(PL.jobSummary({ counts: { completed: 3, failed: 1 } }), '3 completed · 1 failed');
  assert.match(PL.jobSummary({ counts: {} }), /no device/);
  assert.deepStrictEqual(PL.JOB_STATES, ['queued', 'pending', 'downloading', 'installing', 'completed', 'failed', 'retrying', 'cancelled']);
});
