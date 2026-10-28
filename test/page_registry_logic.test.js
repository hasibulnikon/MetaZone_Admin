// Step 4.B - pure logic of the page registry / left-navigation controls, plus a STATIC contract check against 0016 (text only: no database).
// It does NOT prove the SQL runs (that needs PostgreSQL: supabase/tests/test_page_registry_nav.py, not run in the authoring environment).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ADDON = require('../addon_logic.js');
const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const sql16 = fs.readFileSync(path.join(ROOT, 'database', '0016_page_registry_and_nav.sql'), 'utf8').replace(/--[^\n]*/g, '');

test('registerPageProblems: accepts a valid new key', () => {
  assert.deepStrictEqual(ADDON.registerPageProblems('zz_new_1', 'New page', ['tracker']), []);
});
test('registerPageProblems: refuses every built-in page key', () => {
  for (const k of ADDON.CORE_PAGE_KEYS) assert.ok(ADDON.registerPageProblems(k, 'X', []).length, k);
  assert.deepStrictEqual([...ADDON.CORE_PAGE_KEYS].sort(), ['appearance', 'automation', 'dashboard', 'embed', 'meta', 'p2p', 'p2p_niche', 'prompt', 'settings']);
});
test('CORE_PAGE_KEYS (JS) equals both built-in key lists inside 0016 (Step 8 drift check)', () => {
  const lists = [...sql16.matchAll(/in\s*\(((?:\s*'[a-z0-9_]+'\s*,?)+)\)/g)].map((m) => [...m[1].matchAll(/'([a-z0-9_]+)'/g)].map((x) => x[1]))
    .filter((l) => l.includes('p2p_niche'));
  assert.strictEqual(lists.length, 2);
  for (const l of lists) assert.deepStrictEqual([...l].sort(), [...ADDON.CORE_PAGE_KEYS].sort());
});
test('registerPageProblems: bad formats, existing keys, bad labels', () => {
  for (const k of ['', 'Zz', 'zz-x', 'zz x', 'a'.repeat(33), 'zz\n', null, undefined, 5]) assert.ok(ADDON.registerPageProblems(k, 'X', []).length, String(k));
  assert.ok(ADDON.registerPageProblems('tracker', 'X', ['tracker']).length);
  for (const l of ['', '   ', 'x'.repeat(41), 'a\tb', null, undefined, 7]) assert.ok(ADDON.registerPageProblems('zz_a', l, []).length, String(l));
});
test('calls carry exactly the SQL parameter names and trim the label', () => {
  assert.deepStrictEqual(ADDON.registerPageCall('zz_a', '  A  '), { fn: 'admin_register_page', args: { p_key: 'zz_a', p_label: 'A' } });
  assert.deepStrictEqual(ADDON.navVisibleCall('meta', 0), { fn: 'admin_set_page_nav_visible', args: { p_key: 'meta', p_visible: false } });
});
test('parsePlacement: shape, protected pages, malformed rows', () => {
  assert.strictEqual(ADDON.parsePlacement(null), null);
  assert.strictEqual(ADDON.parsePlacement({}), null);
  const p = ADDON.parsePlacement([{ page_key: 'meta', nav_visible: false, core: true }, { page_key: 'dashboard', nav_visible: true }, null, { nav_visible: true }, { page_key: 'zz', nav_visible: true, protected: false }]);
  assert.deepStrictEqual(Object.keys(p).sort(), ['dashboard', 'meta', 'zz']);
  assert.strictEqual(p.meta.nav_visible, false); assert.strictEqual(p.meta.core, true);
  assert.strictEqual(p.dashboard.protected, true); assert.strictEqual(p.zz.protected, false);
});
test('confirmations require the server to echo the requested state', () => {
  assert.ok(ADDON.registerConfirmed({ page_key: 'zz', kind: 'page' }, 'zz'));
  assert.ok(!ADDON.registerConfirmed({ page_key: 'other', kind: 'page' }, 'zz'));
  assert.ok(!ADDON.registerConfirmed(null, 'zz'));
  assert.ok(ADDON.navConfirmed({ page_key: 'meta', nav_visible: false }, 'meta', false));
  assert.ok(!ADDON.navConfirmed({ page_key: 'meta', nav_visible: true }, 'meta', false));
});
test('contract: 0016 defines the RPCs with the parameter names the Admin sends', () => {
  assert.match(sql16, /function public\.admin_register_page\(p_key text, p_label text\)/);
  assert.match(sql16, /function public\.admin_set_page_nav_visible\(p_key text, p_visible boolean\)/);
  assert.match(sql16, /function public\.admin_list_page_placement\(\)/);
  assert.match(sql16, /function public\.get_my_nav_hidden\(\)/);
});
test('contract: the SQL reserved-key list equals the Admin / app core list', () => {
  const m = /if p_key in \(([^)]*)\) then\s+raise exception 'this key belongs to a built-in page/.exec(sql16);
  assert.ok(m);
  const keys = m[1].split(',').map((x) => x.trim().replace(/'/g, '')).sort();
  assert.deepStrictEqual(keys, [...ADDON.CORE_PAGE_KEYS].sort());
});
test('contract: every new function is admin-guarded or user-guarded and revoked from public/anon', () => {
  for (const f of ['admin_register_page', 'admin_set_page_nav_visible', 'admin_list_page_placement']) {
    const body = new RegExp('function public\\.' + f + '[\\s\\S]*?end \\$\\$;').exec(sql16)[0];
    assert.match(body, /_require_admin\(\)/, f);
    assert.match(body, /security definer set search_path = public, pg_temp/, f);
  }
  assert.match(/function public\.get_my_nav_hidden[\s\S]*?end \$\$;/.exec(sql16)[0], /_require_user\(\)/);
  assert.match(sql16, /revoke all on function public\.admin_register_page\(text, text\)\s+from public, anon, authenticated/);
});
