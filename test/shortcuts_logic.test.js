// Step 4.3A - focused unit tests for the Dashboard Shortcuts list rules in addon_logic.js (pure: no DOM, no network, no database).
// Run: node --test test/shortcuts_logic.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const L = require('../addon_logic.js');

const PAGES = ['dashboard', 'meta', 'prompt', 'embed', 'p2p', 'automation', 'tracker', 'converter', 'appearance']
  .map((k) => ({ page_key: k, label: k.toUpperCase(), kind: 'page', enabled: true }));
const LIST = [...PAGES, { page_key: 'converter_image', label: 'Image converter', kind: 'addon', enabled: true }, { page_key: 'settings', label: 'Settings', kind: 'page' }];
const SUP = L.supportedShortcutPages(LIST);

test('supported pages: only kind page, never the settings alias or add-on switches, each key once; junk rows are ignored', () => {
  assert.deepStrictEqual(SUP.map((p) => p.key), PAGES.map((p) => p.page_key));
  assert.deepStrictEqual(L.supportedShortcutPages([...LIST, { page_key: 'meta', kind: 'page' }, null, {}, { page_key: 5, kind: 'page' }]).map((p) => p.key), PAGES.map((p) => p.page_key));
  assert.deepStrictEqual(L.supportedShortcutPages(null), []);
  assert.strictEqual(SUP.find((p) => p.key === 'meta').label, 'META');
});

test('the built-in default is Home + the five current buttons, valid, and the same as the 0015 seed', () => {
  assert.deepStrictEqual(L.SHORTCUT_DEFAULT, ['dashboard', 'meta', 'embed', 'p2p', 'automation', 'appearance']);
  assert.deepStrictEqual(L.shortcutProblems(L.SHORTCUT_DEFAULT, SUP), []);
  assert.strictEqual(L.SHORTCUT_MAX, 9);
});

test('problems: Home and Settings required, max 9, no duplicates, unsupported keys, wrong shape', () => {
  assert.deepStrictEqual(L.shortcutProblems(PAGES.map((p) => p.page_key), SUP), []);                       // exactly 9 is fine
  assert.ok(L.shortcutProblems(['appearance', 'meta'], SUP).some((m) => /Home/.test(m)));
  assert.ok(L.shortcutProblems(['dashboard', 'meta'], SUP).some((m) => /Settings/.test(m)));
  assert.ok(L.shortcutProblems(['dashboard', 'appearance', 'meta', 'meta'], SUP).some((m) => /more than once/.test(m)));
  assert.ok(L.shortcutProblems(['dashboard', 'appearance', 'converter_image'], SUP).some((m) => /converter_image/.test(m)));
  assert.ok(L.shortcutProblems(['dashboard', 'appearance', 'settings'], SUP).some((m) => /settings/.test(m)));
  assert.ok(L.shortcutProblems([...PAGES.map((p) => p.page_key), 'meta'], SUP).some((m) => /At most 9/.test(m)));
  assert.ok(L.shortcutProblems(null, SUP).length && L.shortcutProblems('x', SUP).length);
  assert.ok(L.shortcutProblems(['dashboard', 'appearance', ' meta'], SUP).length, 'keys are not trimmed');
});

test('add: appends, refuses duplicates / unsupported / a 10th entry, never mutates its input', () => {
  const base = Object.freeze(['dashboard', 'appearance']);
  assert.deepStrictEqual(L.shortcutAdd(base, 'meta', SUP), { list: ['dashboard', 'appearance', 'meta'], error: null });
  assert.ok(L.shortcutAdd(base, 'appearance', SUP).error);
  assert.ok(L.shortcutAdd(base, 'converter_image', SUP).error);
  const nine = PAGES.map((p) => p.page_key);
  const SUP10 = L.supportedShortcutPages([...LIST, { page_key: 'tenth', label: 'Tenth', kind: 'page' }]);       // a 10th valid page, so only the size limit can refuse it
  const r = L.shortcutAdd(nine, 'tenth', SUP10); assert.match(r.error, /full/); assert.strictEqual(r.list, nine);
  assert.ok(L.shortcutProblems([...nine, 'tenth'], SUP10).some((m) => /At most 9/.test(m)));
  assert.strictEqual(L.shortcutAdd(['dashboard', 'appearance', 'meta', 'embed', 'p2p', 'automation', 'tracker', 'prompt'], 'converter', SUP).list.length, 9);   // 8 -> 9 is allowed
});

test('remove: Home and Settings can never be removed; others can; unknown key is refused', () => {
  const l = ['dashboard', 'meta', 'appearance'];
  assert.ok(L.shortcutRemove(l, 'dashboard').error); assert.ok(L.shortcutRemove(l, 'appearance').error);
  assert.strictEqual(L.shortcutRemove(l, 'dashboard').list, l);
  assert.deepStrictEqual(L.shortcutRemove(l, 'meta'), { list: ['dashboard', 'appearance'], error: null });
  assert.ok(L.shortcutRemove(l, 'p2p').error);
});

test('move: swaps with the neighbour, does nothing at the edges, keeps every key, never mutates', () => {
  const l = Object.freeze(['dashboard', 'meta', 'embed', 'appearance']);
  assert.deepStrictEqual(L.shortcutMove(l, 'embed', -1).list, ['dashboard', 'embed', 'meta', 'appearance']);
  assert.deepStrictEqual(L.shortcutMove(l, 'meta', 1).list, ['dashboard', 'embed', 'meta', 'appearance']);
  assert.strictEqual(L.shortcutMove(l, 'dashboard', -1).list, l);
  assert.strictEqual(L.shortcutMove(l, 'appearance', 1).list, l);
  assert.strictEqual(L.shortcutMove(l, 'nope', 1).list, l);
  assert.deepStrictEqual([...L.shortcutMove(l, 'meta', -1).list].sort(), [...l].sort());
});

test('save call: exact RPC name and the single parameter p_keys (a copy of the list)', () => {
  const keys = ['dashboard', 'meta', 'appearance'], c = L.shortcutsSaveCall(keys);
  assert.deepStrictEqual(c, { fn: 'admin_set_dashboard_shortcuts', params: { p_keys: keys } });
  assert.deepStrictEqual(Object.keys(c.params), ['p_keys']);
  assert.notStrictEqual(c.params.p_keys, keys);
});

test('confirmation: only the exact list (same keys, same order) in the documented shape counts', () => {
  const sent = ['dashboard', 'meta', 'appearance'];
  assert.strictEqual(L.shortcutsConfirmed({ shortcuts: ['dashboard', 'meta', 'appearance'] }, sent), true);
  for (const bad of [null, undefined, {}, [], 'ok', { shortcuts: 'x' }, { shortcuts: ['dashboard', 'appearance', 'meta'] }, { shortcuts: ['dashboard', 'appearance'] },
    { shortcuts: ['dashboard', 'meta', 'appearance', 'p2p'] }, { shortcuts: ['dashboard', 'meta', 5] }]) assert.strictEqual(L.shortcutsConfirmed(bad, sent), false, JSON.stringify(bad));
  assert.deepStrictEqual(L.parseShortcutsResult({ shortcuts: ['a'] }), ['a']);
  assert.strictEqual(L.parseShortcutsResult({ shortcuts: [1] }), null);
});

test('missing-migration detection works for both new RPCs', () => {
  assert.ok(L.isMissingRpcError('Could not find the function public.get_my_dashboard_shortcuts without parameters in the schema cache', 'get_my_dashboard_shortcuts'));
  assert.ok(L.isMissingRpcError('PGRST202 admin_set_dashboard_shortcuts', 'admin_set_dashboard_shortcuts'));
  assert.ok(!L.isMissingRpcError('forbidden', 'admin_set_dashboard_shortcuts'));
});
