// v1.0.0 - STATIC contract between the Admin "Upcoming features" panel (admin.js) and migration 0024. Text only: no database, no network.
// Run: node --test test/upcoming_contract.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'database', '0024_upcoming_features.sql'), 'utf8');
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');

function params(fn) {
  const m = new RegExp(`function public\\.${fn}\\(([^)]*)\\)`, 'i').exec(sql.replace(/--[^\n]*/g, ''));
  assert.ok(m, `${fn} missing from 0024`);
  return m[1].split(',').map((x) => x.trim()).filter(Boolean).map((x) => ({ name: x.split(/\s+/)[0], hasDefault: /\bdefault\b/i.test(x) }));
}

test('every upcoming RPC the panel sends exists in 0024 with exactly the declared parameter names', () => {
  const re = /rpc\('(admin_[a-z_]*upcoming[a-z_]*)'(?:,\s*\{([^}]*)\})?/g; let m; let n = 0;
  while ((m = re.exec(js))) {
    n++;
    const declared = params(m[1]), keys = (m[2] || '').split(',').map((x) => x.trim().split(':')[0].trim()).filter(Boolean);
    for (const k of keys) assert.ok(declared.some((d) => d.name === k), `${m[1]} called with unknown parameter ${k}`);
    for (const d of declared) if (!d.hasDefault) assert.ok(keys.includes(d.name), `${m[1]} called without required ${d.name}`);
  }
  assert.ok(n >= 5, `only ${n} call sites found`);
});

test('the panel never calls a delete/upload path for add-ons from the announcement code', () => {
  const a = js.indexOf('function upcomingPanel'), b = js.indexOf('// ---- publish form');
  const code = js.slice(a, b);
  for (const bad of ['admin_delete_addon', 'admin_publish_addon', 'storage.from', 'admin_withdraw_addon']) assert.ok(!code.includes(bad), `announcement code must not use ${bad}`);
});

test('0024 deletes only its own table and never references add-on tables in the delete path', () => {
  const a = sql.indexOf('function public.admin_delete_upcoming_feature'), body = sql.slice(a, sql.indexOf('end $$;', a));
  assert.ok(/delete from public\.upcoming_features/.test(body));
  assert.ok(!/addon_releases|addons|storage/.test(body.replace(/--[^\n]*/g, '')));
});

test('the Admin copy of 0023 / 0024 is byte-identical to the App copy when both are present', () => {
  for (const f of ['0023_retire_stale_adobe_tracker_identity.sql', '0024_upcoming_features.sql']) {
    const mine = path.join(ROOT, 'database', f), app = path.join(ROOT, '..', 'MetaZone_App', 'supabase', 'migrations', f);
    assert.ok(fs.existsSync(mine), f);
    if (fs.existsSync(app)) assert.strictEqual(fs.readFileSync(mine, 'utf8'), fs.readFileSync(app, 'utf8'), f);
  }
});
