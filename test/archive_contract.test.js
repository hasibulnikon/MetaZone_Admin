// v1.0.0 (7th Edition, Part 2) - STATIC contract of the Removed Providers & Models archive: migration 0026 text + admin.js. Text only: no database, no network.
// It proves how the SQL and the page are WRITTEN (archive instead of delete, Admin gate, no hard delete, restore rules). It does NOT execute the SQL:
// the behaviour is covered by MetaZone_App/supabase/tests/test_removed_providers_models.py (real PostgreSQL, NOT run in this build).
// Run: node --test test/archive_contract.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const FILE = '0026_removed_providers_models_archive.sql';
const raw = fs.readFileSync(path.join(ROOT, 'database', FILE), 'utf8');
const sql = raw.replace(/--[^\n]*/g, '');
const low = sql.toLowerCase();
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const pageAi = js.slice(js.indexOf('async function pageAi('), js.indexOf('// ------------------------------------------------------------ app version'));
function body(fn, text = sql) { const a = text.indexOf(`function public.${fn}(`); assert.ok(a >= 0, `${fn} not found`); const b = text.indexOf('end $$;', a); assert.ok(b > a, fn + ' has no end'); return text.slice(a, b); }

test('0026 is the next migration after 0025, one transaction, balanced, with safety stops', () => {
  const names = fs.readdirSync(path.join(ROOT, 'database')).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort();
  const i = names.indexOf(FILE); assert.ok(i > 0 && names[i - 1].startsWith('0025_'));
  assert.ok(/^\s*begin;/m.test(low) && /commit;\s*$/.test(low.trim()));
  assert.equal(sql.split('$$').length % 2, 1, 'dollar quotes balanced');
  assert.equal(sql.split('(').length, sql.split(')').length, 'parentheses balanced');
  for (const n of ['0021', '0022', '0025']) assert.ok(raw.includes(`0026 stopped:`) && raw.includes(n), 'safety stop mentions ' + n);
});
test('the archive is additive: new columns, nothing dropped, truncated or hard-deleted anywhere in 0026', () => {
  for (const c of ['archived_at timestamptz', 'archived_by uuid', 'archived_with_provider boolean']) assert.ok(low.includes(c), c);
  assert.ok(!/\bdelete\s+from\b/.test(low), '0026 contains a DELETE FROM');
  assert.ok(!/\bdrop\s+(table|column|function|constraint)\b/.test(low) && !/\btruncate\b/.test(low));
  assert.ok(!/\bcascade\b/.test(low), 'no cascade in 0026');
  assert.ok(!/on\s+conflict[^;]*do\s+update/.test(low) || /admin_upsert_ai_(provider|model)/.test(low));      // only the (guarded) upserts keep their ON CONFLICT DO UPDATE
});
test('every new / replaced admin function calls _require_admin() first and is closed to anon / PUBLIC', () => {
  for (const fn of ['admin_list_removed_ai_catalog', 'admin_archive_ai_provider', 'admin_restore_ai_provider', 'admin_archive_ai_model', 'admin_restore_ai_model', 'admin_delete_ai_provider', 'admin_delete_ai_model']) {
    assert.ok(/begin\s+(perform public\._require_admin\(\);|perform public\._require_admin\(\); )/.test(body(fn).replace(/\s+/g, ' ').replace('begin ', 'begin ')) || /_require_admin\(\)/.test(body(fn).split('begin')[1].slice(0, 120)), fn + ' is not admin gated first');
  }
  assert.ok(low.includes('revoke all on function public._ai_removed_json() from public, anon, authenticated;'));
  assert.ok(/revoke all on function public\.admin_list_removed_ai_catalog\(\), public\.admin_archive_ai_provider\(text\), public\.admin_restore_ai_provider\(text\),\s*public\.admin_archive_ai_model\(text, text\), public\.admin_restore_ai_model\(text, text\) from public, anon, authenticated;/.test(low));
  assert.ok(/grant execute on function public\.admin_list_removed_ai_catalog\(\)[^;]*to authenticated;/.test(low));
  assert.ok(!/grant[^;]*\bto\s+(anon|public)\b/.test(low));
});
test('archiving only sets archive columns (provider + its models); the delete functions are now thin archive wrappers', () => {
  const ap = body('admin_archive_ai_provider').toLowerCase();
  assert.ok(/update public\.ai_providers set archived_at = now\(\)/.test(ap) && /update public\.ai_provider_models set archived_at = now\(\)/.test(ap) && ap.includes('archived_with_provider = true'));
  assert.ok(!/\bdelete\b/.test(ap));
  const am = body('admin_archive_ai_model').toLowerCase();
  assert.ok(/update public\.ai_provider_models set archived_at = now\(\)/.test(am) && !/update public\.ai_providers/.test(am) && !/\bdelete\b/.test(am), 'model archive leaves the provider alone');
  for (const [fn, target] of [['admin_delete_ai_provider', 'admin_archive_ai_provider'], ['admin_delete_ai_model', 'admin_archive_ai_model']]) {
    const b = body(fn).toLowerCase(); assert.ok(b.includes('public.' + target + '(') && !/\bdelete\b/.test(b.replace(/admin_delete_ai_\w+/g, '')), fn);
  }
  assert.ok(/function public\.admin_delete_ai_provider\(p_key text\) returns jsonb/.test(sql) && /function public\.admin_delete_ai_model\(p_provider text, p_model text\) returns jsonb/.test(sql), 'signatures unchanged');
});
test('restore: provider restores only the models archived with it; model restore never writes the provider row; neither touches settings', () => {
  const rp = body('admin_restore_ai_provider').toLowerCase();
  assert.ok(/where provider_key = p_key and archived_with_provider returning/.test(rp), 'only cascade-archived models come back');
  const rm = body('admin_restore_ai_model').toLowerCase();
  assert.ok(!/update public\.ai_providers/.test(rm), 'model restore does not write ai_providers');
  assert.ok(rm.includes('parent_provider_archived'), 'a model under a removed provider is refused, not silently restored');
  for (const b of [rp, rm]) { assert.ok(!/set[^;]*\b(enabled|hidden|sort_order|failover_order|updated_at|label)\s*=/.test(b.replace(/archived_with_provider/g, '')), 'a restore changes no setting'); assert.ok(!/\bdelete\b/.test(b)); }
});
test('repeat-safe: archive of an archived row and restore of an active row answer already_* without writing', () => {
  assert.ok(/already_archived', true/.test(body('admin_archive_ai_provider')) && /already_archived', true/.test(body('admin_archive_ai_model')));
  assert.ok(/already_active', true/.test(body('admin_restore_ai_provider')) && /already_active', true/.test(body('admin_restore_ai_model')));
});
test('no silent overwrite: creating or editing an archived key is refused', () => {
  assert.ok(body('admin_upsert_ai_provider').includes('provider_is_archived') && body('admin_upsert_ai_model').includes('model_is_archived') && body('admin_upsert_ai_model').includes('provider_is_archived'));
  assert.ok(body('admin_set_ai_provider_enabled').includes('provider_is_archived') && body('admin_set_ai_model_enabled').includes('model_is_archived'));
  assert.ok(body('admin_push_ai_force_update').includes('provider_is_archived'));
});
test('the app-facing catalogue and package download hide archived providers / models', () => {
  const c = body('_ai_catalog_json').replace(/\s+/g, ' ');
  assert.ok(c.includes('m.provider_key = p.provider_key and m.archived_at is null') && /from public\.ai_providers p where p\.archived_at is null/.test(c));
  assert.ok(body('get_ai_package_download').includes('pr.archived_at is not null'));
  assert.ok(/p\.enabled and p\.archived_at is null/.test(body('mz_ai_pkg_allowed')));
});
test('Part 1 compatibility: 0025 default restore keeps its signature, stays insert-only and never touches an archived provider', () => {
  const r = body('admin_restore_default_ai_catalog'); const rl = r.toLowerCase();
  assert.ok(/function public\.admin_restore_default_ai_catalog\(\) returns jsonb/.test(sql));
  assert.ok(rl.includes('on conflict (provider_key) do nothing') && rl.includes('on conflict (provider_key, model_id) do nothing'));
  assert.ok(rl.includes('p.archived_at is null'), 'no default model is added under an archived provider');
  assert.ok(!/do update/.test(rl) && !/\bdelete\s+from\b/.test(rl) && !/archived_at\s*=\s*null/.test(rl), 'it can never un-archive');
  assert.ok(rl.includes('restored_providers') && rl.includes('restored_models') && rl.includes("'catalog'"), 'same return contract as 0025');
});
test('the Admin page: Remove archives (never the legacy delete RPCs), asks first, and keeps the Removed section', () => {
  assert.ok(!/rpc\('admin_delete_ai_(provider|model)'/.test(js), 'admin.js must not call a delete RPC');
  assert.ok(!/admin_delete_ai_(provider|model)/.test(pageAi));
  const prov = pageAi.indexOf("rpc('admin_archive_ai_provider'"), model = pageAi.indexOf("rpc('admin_archive_ai_model'");
  assert.ok(prov > 0 && model > 0);
  assert.ok(pageAi.slice(prov - 500, prov).includes('confirmBox('), 'provider remove is confirmed');
  assert.ok(pageAi.slice(model - 600, model).includes('confirmBox('), 'model remove is confirmed');
  assert.ok(!/bucket\(\)\.remove\(r\.storage_paths/.test(pageAi), 'removing a provider no longer deletes Storage files');
  for (const s of ["'Removed Providers & Models'", "'Removed Providers'", "'Removed Models'", "id: 'ai-rm-search'", "'restore-provider'", "'restore-model'"]) assert.ok(pageAi.includes(s), s);
});
test('every restore is behind a confirmation dialog and calls only the restore RPCs', () => {
  for (const [dlg, rpcName] of [['function restoreProviderDialog', "rpc('admin_restore_ai_provider'"], ['function restoreModelDialog', "rpc('admin_restore_ai_model'"]]) {
    const a = pageAi.indexOf(dlg); assert.ok(a > 0, dlg); const seg = pageAi.slice(a, a + 2600);
    assert.ok(seg.indexOf('modal(') >= 0 && seg.indexOf('modal(') < seg.indexOf(rpcName), dlg + ': the dialog comes first');
    assert.ok(seg.includes("label: 'Cancel'"), dlg + ' has Cancel');
  }
  assert.equal([...pageAi.matchAll(/rpc\('admin_restore_ai_provider'/g)].length, 1); assert.equal([...pageAi.matchAll(/rpc\('admin_restore_ai_model'/g)].length, 1);
});
test('if migration 0026 is missing the Remove buttons are disabled (no fallback to any delete path)', () => {
  assert.ok(pageAi.includes('archiveReady') && /disabled: !archiveReady/.test(pageAi));
  assert.ok(/catch \(e\) \{ removed = \{ providers: \[\], models: \[\] \}; archiveReady = false; \}/.test(pageAi));
});
test('restore never touches browser storage or an API key', () => {
  const a = pageAi.indexOf('function restoreProviderDialog'), b = pageAi.indexOf('function draw()');
  assert.ok(!/localStorage|sessionStorage|api_?key/i.test(pageAi.slice(a, b)));
});
