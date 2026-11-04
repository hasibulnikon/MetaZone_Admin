// v1.0.0 - STATIC + pure-function contract between the Admin "Upcoming features" panel (admin.js) and migrations 0024 / 0030 / 0031.
// No database, no network. Two supported schema generations:
//   0024-only : admin_upsert_upcoming_feature has 6 arguments (no p_image_data); no archive / reorder RPCs; list rows have no archived_at.
//   0030/0031 : 7 arguments, p_image_data OPTIONAL (default null); archive/restore + reorder RPCs exist; rows carry archived_at.
// Run: node --test test/upcoming_contract.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const strip = (t) => t.replace(/--[^\n]*/g, '');
const sql24 = strip(fs.readFileSync(path.join(ROOT, 'database', '0024_upcoming_features.sql'), 'utf8'));
const sql30 = strip(fs.readFileSync(path.join(ROOT, 'database', '0030_upcoming_features_management.sql'), 'utf8'));
const sql31 = strip(fs.readFileSync(path.join(ROOT, 'database', '0031_upcoming_features_release_lifecycle.sql'), 'utf8'));
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');

function params(sql, fn) {
  const m = new RegExp(`function public\\.${fn}\\(([^)]*)\\)`, 'i').exec(sql);
  assert.ok(m, `${fn} missing`);
  return m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ name: x.split(/\s+/)[0], hasDefault: /\bdefault\b/i.test(x) }));
}
// Evaluate the REAL helper functions out of admin.js (no DOM needed).
function helper(name) {
  const a = js.indexOf('function ' + name + '(');
  assert.ok(a > 0, name + ' missing from admin.js');
  let depth = 0, i = js.indexOf('{', a);
  for (let j = i; j < js.length; j++) { if (js[j] === '{') depth++; else if (js[j] === '}' && --depth === 0) { i = j; break; } }
  const ctx = {}; vm.runInNewContext(js.slice(a, i + 1) + `;this.fn=${name};`, ctx); return ctx.fn;
}
const upsertParams = helper('upcomingUpsertParams'), isMissingFn = helper('isMissingFunctionError');
const VALS = { title: 'T', description: 'D', addon_id: '', sort_order: 100 };
const IMG = 'data:image/png;base64,AAAA';
const KEYS_NO_IMG = ['p_id', 'p_title', 'p_description', 'p_addon_id', 'p_sort_order', 'p_expected_updated_at'];

test('schema generations: 0024 has 6 arguments, 0030 adds ONE optional p_image_data (default null)', () => {
  const p24 = params(sql24, 'admin_upsert_upcoming_feature'), p30 = params(sql30, 'admin_upsert_upcoming_feature');
  assert.equal(p24.length, 6); assert.ok(!p24.some((d) => d.name === 'p_image_data'));
  assert.equal(p30.length, 7); const img = p30[6];
  assert.equal(img.name, 'p_image_data'); assert.ok(img.hasDefault, 'p_image_data must stay optional in 0030');
  assert.deepEqual(p30.slice(0, 6).map((d) => d.name), p24.map((d) => d.name));
  assert.match(sql30, /drop function if exists public\.admin_upsert_upcoming_feature\(uuid, text, text, text, integer, timestamptz\)/i, '0030 drops only the old 6-argument overload');
});

test('no image => p_image_data is OMITTED (never sent, not even as null): the exact 6-key object 0024 accepts', () => {
  for (const u of [null, { id: 'x', updated_at: 't' }]) {
    const p = upsertParams(u, VALS, null);
    assert.deepEqual(Object.keys(p).sort(), KEYS_NO_IMG.slice().sort());
    assert.ok(!('p_image_data' in p));
    for (const k of Object.keys(p)) assert.ok(params(sql24, 'admin_upsert_upcoming_feature').some((d) => d.name === k), `0024 does not know ${k}`);
  }
  for (const empty of ['', undefined, 0]) assert.ok(!('p_image_data' in upsertParams(null, VALS, empty)));
});

test('with an image => p_image_data is included, and every key exists in 0030', () => {
  const p = upsertParams({ id: 'x', updated_at: 't' }, VALS, IMG);
  assert.equal(p.p_image_data, IMG);
  const declared = params(sql30, 'admin_upsert_upcoming_feature');
  for (const k of Object.keys(p)) assert.ok(declared.some((d) => d.name === k), `0030 does not know ${k}`);
  for (const d of declared) if (!d.hasDefault) assert.ok(k0(p, d.name), `required ${d.name} missing`);
  function k0(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
});

test('edit semantics: p_id / p_expected_updated_at carried; empty add-on id becomes null; 0030 writes image_data = the argument, so omitting clears (= Remove image)', () => {
  const p = upsertParams({ id: 'abc', updated_at: '2026-11-01T00:00:00Z' }, { ...VALS, addon_id: '' }, null);
  assert.equal(p.p_id, 'abc'); assert.equal(p.p_expected_updated_at, '2026-11-01T00:00:00Z'); assert.equal(p.p_addon_id, null);
  assert.equal(upsertParams(null, VALS, null).p_id, null);
  const body = sql30.slice(sql30.indexOf('create or replace function public.admin_upsert_upcoming_feature'));
  assert.match(body, /image_data = v_img/);
  assert.match(body, /v_img text := nullif\(p_image_data, ''\)/);
});

test('missing-function detection: PostgREST / Postgres wording is recognised, ordinary errors are not', () => {
  assert.ok(isMissingFn('Could not find the function public.admin_upsert_upcoming_feature(p_addon_id, p_description, p_expected_updated_at, p_id, p_image_data, p_sort_order, p_title) in the schema cache'));
  assert.ok(isMissingFn('PGRST202'));
  assert.ok(isMissingFn('function public.admin_reorder_upcoming_features(uuid[]) does not exist'));
  for (const msg of ['stale: this announcement was changed by someone else.', 'title is required (max 80 characters)', 'forbidden', '', null, undefined]) assert.ok(!isMissingFn(msg), String(msg));
});

test('admin.js: the Save path uses the helper, shows the migration-required message only for an image + missing function, keeps the dialog open', () => {
  assert.match(js, /rpc\('admin_upsert_upcoming_feature', params\)/);
  assert.ok(!/p_image_data: image/.test(js.slice(js.indexOf('function upcomingModal'), js.indexOf('function upcomingPanel'))), 'p_image_data must never be sent unconditionally');
  const save = js.slice(js.indexOf("const params = upcomingUpsertParams"), js.indexOf("toast('Announcement saved')"));
  assert.match(save, /params\.p_image_data && isMissingFunctionError\(e\.message\)/);
  assert.match(save, /MIG_0030_IMAGE_MSG/);
  assert.match(save, /return true;/, 'returning true keeps the modal (typed values + chosen image) so the user can retry');
  assert.ok(!/image = null/.test(save), 'a failed save must not discard the chosen image');
  assert.match(js, /const MIG_0030_IMAGE_MSG = '[^']*0030_upcoming_features_management\.sql[^']*Nothing was saved[^']*'/);
});

test('capability detection: an empty list is "unknown" (never claimed 0024, never claimed 0030); rows decide; ordering is not wrongly said to need 0030', () => {
  const panel = js.slice(js.indexOf('function upcomingPanel'), js.indexOf('// ---- publish form'));
  assert.match(panel, /list\.length \? \(list\.every\(/);
  assert.match(panel, /: 'unknown'/);
  assert.ok(!/list\.length > 0 && !\('archived_at' in list\[0\]\)/.test(panel), 'old first-row-only detection must be gone');
  assert.match(panel, /id: 'upcoming-schema-unknown'/);
  const warn = /id: 'upcoming-needs-0030'[^)]*?'([^']*)'/.exec(panel);
  assert.ok(warn, 'needs-0030 warning present');
  assert.match(warn[1], /Thumbnails, Archive \/ Restore and the ▲ ▼ reorder buttons need migration 0030/);
  assert.match(warn[1], /Order number/); assert.ok(!/all ordering/i.test(warn[1]));
});

test('0030 features: archive/restore + dedicated reorder RPCs exist only in 0030; the panel calls them with exactly their parameters', () => {
  for (const fn of ['admin_set_upcoming_feature_archived', 'admin_reorder_upcoming_features']) {
    assert.ok(!new RegExp(`function public\\.${fn}\\(`, 'i').test(sql24), `${fn} must not exist in 0024`);
    assert.ok(new RegExp(`function public\\.${fn}\\(`, 'i').test(sql30), `${fn} missing in 0030`);
  }
  const re = /rpc\('(admin_(?:set_upcoming_feature_archived|reorder_upcoming_features|set_upcoming_feature_status|delete_upcoming_feature|list_upcoming_features))'(?:,\s*\{([^}]*)\})?/g; let m, n = 0;
  while ((m = re.exec(js))) {
    n++; const sql = /status|delete|list/.test(m[1]) ? sql24 : sql30;
    const declared = params(/set_upcoming_feature_status/.test(m[1]) ? sql31 + sql30 + sql24 : sql, m[1]);
    const keys = (m[2] || '').split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
    for (const k of keys) assert.ok(declared.some((d) => d.name === k), `${m[1]} called with unknown parameter ${k}`);
    for (const d of declared) if (!d.hasDefault) assert.ok(keys.includes(d.name), `${m[1]} called without required ${d.name}`);
  }
  assert.ok(n >= 6, `only ${n} call sites found`);
});

test('manual sort_order editing already exists in 0024 (the Order field)', () => {
  assert.ok(params(sql24, 'admin_upsert_upcoming_feature').some((d) => d.name === 'p_sort_order'));
  assert.match(js, /id: 'upcoming-sort'/);
});

test('the panel never calls a delete/upload path for add-ons from the announcement code', () => {
  const code = js.slice(js.indexOf('function upcomingPanel'), js.indexOf('// ---- publish form'));
  for (const bad of ['admin_delete_addon', 'admin_publish_addon', 'storage.from', 'admin_withdraw_addon']) assert.ok(!code.includes(bad), `announcement code must not use ${bad}`);
});

test('delete scope: 0024 deletes only its own table; 0030/0031 do not widen it', () => {
  const a = sql24.indexOf('function public.admin_delete_upcoming_feature'), body = sql24.slice(a, sql24.indexOf('end $$;', a));
  assert.ok(/delete from public\.upcoming_features/.test(body));
  assert.ok(!/addon_releases|addons|storage/.test(body));
  for (const s of [sql30, sql31]) assert.ok(!/function public\.admin_delete_upcoming_feature/i.test(s), 'delete function must not be redefined');
});

test('the Admin copy of 0023 / 0024 / 0030 / 0031 is byte-identical to the App copy when both are present', () => {
  for (const f of ['0023_retire_stale_adobe_tracker_identity.sql', '0024_upcoming_features.sql', '0030_upcoming_features_management.sql', '0031_upcoming_features_release_lifecycle.sql']) {
    const mine = path.join(ROOT, 'database', f), app = path.join(ROOT, '..', 'MetaZone_App', 'supabase', 'migrations', f);
    assert.ok(fs.existsSync(mine), f);
    if (fs.existsSync(app)) assert.strictEqual(fs.readFileSync(mine, 'utf8'), fs.readFileSync(app, 'utf8'), f);
  }
});
