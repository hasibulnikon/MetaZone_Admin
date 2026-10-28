// Step 4.2 - STATIC contract check for migration 0015 (configurable Dashboard shortcuts, server side only).
// It READS text only: no database, no Supabase, no network. It proves the two copies match, the RPC signatures / grants / authorisation order /
// validation order are as designed, the default list matches the five hard-coded Dashboard buttons, and migration 0014 is unchanged.
// It does NOT prove the SQL runs: that is what MetaZone_App/supabase/tests/test_dashboard_shortcuts.py is for (needs PostgreSQL).
// Run: node --test test/shortcuts_contract.test.js        (MZ_ADMIN_ROOT may point at another copy of MetaZone_Admin)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const APP = path.join(ROOT, '..', 'MetaZone_App');
const FILE = '0015_dashboard_shortcuts.sql';
const raw = fs.readFileSync(path.join(ROOT, 'database', FILE), 'utf8');
const sql = raw.replace(/--[^\n]*/g, '');
const body = (fn) => { const a = sql.indexOf(`function public.${fn}(`); assert.ok(a >= 0, `${fn} not found`); return sql.slice(a, sql.indexOf('end $$;', a)); };
const DEFAULT = ['dashboard', 'meta', 'embed', 'p2p', 'automation', 'appearance'];

test('the two copies of 0015 are byte-identical, and migration 0014 is unchanged', { skip: !fs.existsSync(APP) }, () => {
  const a = path.join(APP, 'supabase', 'migrations', FILE);
  assert.ok(fs.readFileSync(path.join(ROOT, 'database', FILE)).equals(fs.readFileSync(a)), `${FILE} differs between MetaZone_Admin/database and MetaZone_App/supabase/migrations`);
  for (const dir of [path.join(ROOT, 'database'), path.join(APP, 'supabase', 'migrations')]) {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, '0014_addon_manager.sql'))).digest('hex');
    assert.strictEqual(h, '239814f73d5fdb1d7cc375bf5245c3d2666d4517047b3ca6be7b3a1023129739', '0014 changed');
  }
});

test('signatures: get_my_dashboard_shortcuts() takes nothing, admin_set_dashboard_shortcuts takes exactly p_keys text[] with no default', () => {
  assert.ok(/create or replace function public\.get_my_dashboard_shortcuts\(\)\s+returns jsonb/.test(sql));
  assert.ok(/create or replace function public\.admin_set_dashboard_shortcuts\(p_keys text\[\]\)\s+returns jsonb/.test(sql));
  assert.ok(/create or replace function public\._dashboard_shortcuts_problem\(p_keys text\[\]\)\s+returns text/.test(sql));
  assert.ok(!/p_keys text\[\]\s+default/i.test(sql), 'p_keys must not have a default');
});

test('every function is SECURITY DEFINER with a pinned search_path', () => {
  for (const f of ['_dashboard_shortcuts_problem', 'get_my_dashboard_shortcuts', 'admin_set_dashboard_shortcuts']) {
    const a = sql.indexOf(`function public.${f}(`), head = sql.slice(a, sql.indexOf('$$', a));
    assert.ok(/security definer/i.test(head) && /set search_path = public, pg_temp/.test(head), `${f}: security definer / search_path`);
  }
});

test('privileges: all three revoked from public/anon/authenticated; only the reader and the admin writer granted, only to authenticated', () => {
  for (const f of ['_dashboard_shortcuts_problem(text[])', 'get_my_dashboard_shortcuts()', 'admin_set_dashboard_shortcuts(text[])'])
    assert.ok(new RegExp(`revoke all on function public\\.${f.replace(/[()[\]]/g, '\\$&')}\\s+from public, anon, authenticated`).test(sql), `${f} not revoked`);
  const grants = [...sql.matchAll(/grant\s+execute\s+on\s+function\s+([^;]+?)\s+to\s+([^;]+);/gi)];
  assert.deepStrictEqual(grants.map((g) => g[1].replace(/\s+/g, ' ')).sort(), ['public.admin_set_dashboard_shortcuts(text[])', 'public.get_my_dashboard_shortcuts()']);
  for (const g of grants) assert.strictEqual(g[2].trim(), 'authenticated');
});

test('authorisation order: the writer calls _require_admin() first, then validates, then writes, then audits; the reader needs a signed-in user', () => {
  const w = body('admin_set_dashboard_shortcuts');
  assert.ok(/begin\s+perform public\._require_admin\(\);/.test(w), 'writer does not call _require_admin() first');
  const at = (s) => { const i = w.indexOf(s); assert.ok(i >= 0, `writer misses ${s}`); return i; };
  assert.ok(at('_dashboard_shortcuts_problem') < at('insert into public.app_config') && at('insert into public.app_config') < at("_audit('dashboard_shortcuts_set'"));
  assert.ok(/begin\s+perform public\._require_user\(\);/.test(body('get_my_dashboard_shortcuts')), 'reader does not require a signed-in user');
  assert.ok(!/delete\s+from|truncate|drop\s+/i.test(w), 'writer must not delete');
});

test('validation rules and their order: required, at most 9, no empty entry, no duplicate, supported pages only, Home, Settings', () => {
  const v = body('_dashboard_shortcuts_problem');
  const order = ['is null then return', '> 9', 'is null) then return', 'duplicate shortcut', "f.kind = 'page'", "f.page_key <> 'settings'", "'dashboard' = any", "'appearance' = any"].map((s) => v.indexOf(s));
  order.forEach((i, n) => assert.ok(i >= 0, `validation misses rule #${n}`));
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'validation rules are in a different order');
});

test('the seed and the reader fallback are the same default: Home plus the five current buttons, in the current order', () => {
  const lits = [...sql.matchAll(/'(\["dashboard"[^']*\])'/g)].map((m) => JSON.parse(m[1]));
  assert.strictEqual(lits.length, 2, 'expected exactly the seed and the fallback literal');
  lits.forEach((l) => assert.deepStrictEqual(l, DEFAULT));
  assert.ok(/on conflict \(key\) do nothing/.test(sql.slice(sql.indexOf('insert into public.app_config'), sql.indexOf('create or replace function'))), 'the seed must never overwrite an admin choice');
});

test('the default matches the five hard-coded Dashboard buttons (plus Home) in the app source', { skip: !fs.existsSync(APP) }, () => {
  const html = fs.readFileSync(path.join(APP, 'MetaZone_js', 'frontend', 'pages', 'dashboard', 'page.html'), 'utf8');
  const buttons = [...html.matchAll(/<button class="quick-btn" data-page="(\w+)"/g)].map((m) => m[1]);
  assert.deepStrictEqual(buttons, ['meta', 'embed', 'p2p', 'automation', 'appearance']);
  assert.deepStrictEqual(DEFAULT.filter((k) => k !== 'dashboard'), buttons);
});

test('Home and Settings are the same protected keys the Admin logic and the app already use', () => {
  const logic = fs.readFileSync(path.join(ROOT, 'addon_logic.js'), 'utf8');
  assert.ok(/PROTECTED_PAGES = \['dashboard', 'appearance', 'settings'\]/.test(logic));
  if (fs.existsSync(APP)) {
    const pc = fs.readFileSync(path.join(APP, 'MetaZone_js', 'backend', 'core', 'page_control.py'), 'utf8');
    assert.ok(/PROTECTED_PAGES = frozenset\(\{"dashboard", "appearance", "settings"\}\)/.test(pc));
  }
});

test('scope guard: the main-app Dashboard page.html does not reference the new RPCs (the static markup stays the fallback)', () => {
  // Step 4.3A: admin.js / addon_logic.js now legitimately reference dashboard_shortcuts (the Admin UI), so they are no longer listed here.
  // Step 4.3B-2A: dashboard.js now legitimately reads dashboard_shortcuts (Dashboard rendering, Step 4.3B-2), so it is no longer listed here either. page.html stays guarded.
  const files = [];
  if (fs.existsSync(APP)) { const fr = path.join(APP, 'MetaZone_js', 'frontend'); files.push(path.join(fr, 'pages', 'dashboard', 'page.html')); }
  for (const f of files) assert.ok(!/dashboard_shortcuts/.test(fs.readFileSync(f, 'utf8')), `${path.basename(f)} already references the new RPCs`);
});
