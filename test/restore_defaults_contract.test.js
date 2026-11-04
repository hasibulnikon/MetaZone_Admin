// v1.0.0 (7th Edition) - STATIC contract between the "Restore Default Providers" button (admin.js) and migration 0025. Text only: no database, no network.
// Run: node --test test/restore_defaults_contract.test.js      Real behaviour: MetaZone_App/supabase/tests/test_restore_default_ai_providers.py (PostgreSQL).
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const sql = fs.readFileSync(path.join(ROOT, 'database', '0025_restore_default_ai_providers.sql'), 'utf8').replace(/--[^\n]*/g, '');
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const pageAi = js.slice(js.indexOf('async function pageAi('), js.indexOf('// ------------------------------------------------------------ app version'));

test('the page has the button, labelled exactly, and it asks before it calls the RPC', () => {
  assert.ok(/id: 'ai-restore-defaults'[^)]*'Restore Default Providers'/.test(pageAi.replace(/\s+/g, ' ')) || pageAi.includes("'Restore Default Providers'"));
  const fn = pageAi.slice(pageAi.indexOf('function restoreDefaults()'), pageAi.indexOf('function restoreDefaults()') + 2500);
  assert.ok(fn.indexOf("modal('Restore default providers?'") >= 0 && fn.indexOf("modal('Restore default providers?'") < fn.indexOf("rpc('admin_restore_default_ai_catalog')"), 'the confirmation comes first');
  assert.ok(/existing|already exist/.test(fn) && /nothing is overwritten/i.test(fn), 'the dialog says existing configuration stays unchanged');
});
test('the RPC takes no parameters and is only ever called from the confirmed action', () => {
  const calls = [...js.matchAll(/rpc\('admin_restore_default_ai_catalog'([^)]*)\)/g)];
  assert.equal(calls.length, 1); assert.equal(calls[0][1], '');
  assert.ok(/function public\.admin_restore_default_ai_catalog\(\)/.test(sql));
});
test('the page redraws from the catalogue the RPC returns and shows the counts', () => {
  assert.ok(pageAi.includes('r.catalog') && pageAi.includes('restored_providers') && pageAi.includes('restored_models'));
});
test('0025 is Admin-gated, insert-only, closed to anon and PUBLIC', () => {
  const low = sql.toLowerCase();
  assert.ok(/begin\s+perform public\._require_admin\(\);/.test(low));
  assert.ok(!/do update/.test(low) && !/\bdelete\s+from\b/.test(low) && !/\btruncate\b/.test(low));
  assert.ok(/on conflict \(provider_key\) do nothing/.test(low) && /on conflict \(provider_key, model_id\) do nothing/.test(low));
  assert.ok(low.includes('revoke all on function public.admin_restore_default_ai_catalog() from public, anon, authenticated;'));
  assert.ok(low.includes('grant execute on function public.admin_restore_default_ai_catalog() to authenticated;'));
});
test('nothing in the restore path touches browser storage or an API key', () => {
  const fn = pageAi.slice(pageAi.indexOf('function restoreSummary'), pageAi.indexOf('function restoreDefaults()') + 2500);
  assert.ok(!/localStorage|sessionStorage|api_?key/i.test(fn));
});
