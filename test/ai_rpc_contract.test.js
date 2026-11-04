// STATIC check (reads text only; no database): every RPC the API Configuration page sends names a function defined in database/0021 and uses
// only parameter names that function declares, supplying every parameter that has no default. Real behaviour is proven by
// MetaZone_App/supabase/tests/test_ai_provider_catalog.py against PostgreSQL.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const sql = ['0021_ai_provider_catalog.sql', '0022_ai_provider_force_update.sql', '0025_restore_default_ai_providers.sql', '0026_removed_providers_models_archive.sql', '0027_openai_compatible_providers.sql', '0028_bulk_import_ai_models.sql'].map((f) => fs.readFileSync(path.join(ROOT, 'database', f), 'utf8')).join('\n').replace(/--[^\n]*/g, '');   // 0022 redefines some: the later definition wins (object keys)
const js = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');

function signatures() {
  const out = {}; const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi; let m;
  while ((m = re.exec(sql))) {
    let i = re.lastIndex, d = 1; const s = i;
    while (d > 0) { if (sql[i] === '(') d++; else if (sql[i] === ')') d--; i++; }
    const inner = sql.slice(s, i - 1).trim(); const params = [];
    if (inner) { let dd = 0, cur = ''; for (const ch of inner) { if (ch === '(') dd++; if (ch === ')') dd--; if (ch === ',' && dd === 0) { params.push(cur); cur = ''; } else cur += ch; } params.push(cur); }
    out[m[1]] = params.map((p) => { const t = p.trim().replace(/\s+/g, ' '); return { name: t.split(' ')[0], def: /\bdefault\b/i.test(t) }; });
  }
  return out;
}
const sig = signatures();
const calls = [];
// Provider Builder (Part 4) builds one call as rpc('fn', Object.assign(base_, { ... })): the keys are those of the `const base_ = { ... }` literal plus the extras.
const baseLit = /const base_ = \{([^}]*)\};/.exec(js);
for (const m of js.matchAll(/rpc\('((?:admin_[a-z_]*ai_[a-z_]*))',\s*Object\.assign\(base_,\s*\{([^}]*)\}\)\)/g)) {
  assert.ok(baseLit, 'base_ literal not found');
  calls.push({ fn: m[1], keys: [...(baseLit[1] + ',' + m[2]).matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]) });
}
for (const m of js.matchAll(/rpc\('((?:admin_[a-z_]*ai_[a-z_]*|get_ai_[a-z_]*))'(?:,\s*\{([^}]*)\})?\)/g)) {
  calls.push({ fn: m[1], keys: m[2] ? [...m[2].matchAll(/\b(p_\w+)\s*:/g)].map((x) => x[1]) : [] });
}

test('the page sends every catalogue admin RPC at least once', () => {
  for (const fn of ['admin_list_ai_catalog', 'admin_upsert_ai_provider', 'admin_set_ai_provider_enabled', 'admin_upsert_ai_model', 'admin_set_ai_model_enabled', 'admin_archive_ai_model',
    'admin_archive_ai_provider', 'admin_restore_ai_model', 'admin_restore_ai_provider', 'admin_list_removed_ai_catalog', 'admin_register_ai_package', 'admin_record_ai_package_test', 'admin_publish_ai_package', 'admin_retire_ai_package', 'admin_delete_ai_package',
    'admin_preview_ai_force_update', 'admin_push_ai_force_update', 'admin_cancel_ai_force_update', 'admin_rollback_ai_force_update', 'admin_list_ai_force_updates', 'admin_list_ai_force_update_targets', 'admin_restore_default_ai_catalog'])
    assert.ok(calls.some((c) => c.fn === fn), fn + ' is never called');
});
test('each call matches the SQL signature', () => {
  for (const c of calls) {
    const p = sig[c.fn]; assert.ok(p, c.fn + ' is not defined in 0021/0022/0025/0026/0027/0028');
    const names = p.map((x) => x.name);
    for (const k of c.keys) assert.ok(names.includes(k), `${c.fn}: unknown parameter ${k}`);
    for (const x of p) if (!x.def) assert.ok(c.keys.includes(x.name), `${c.fn}: missing required parameter ${x.name}`);
  }
});
test('the Admin page never calls the two legacy delete functions (0026: they only archive, and the page uses the archive RPCs)', () => {
  assert.ok(!/rpc\('admin_delete_ai_(provider|model)'/.test(js));
});
test('the old hard-coded catalogue is gone from the Admin page', () => {
  assert.ok(!/const AI_CATALOG\s*=/.test(js));
  assert.ok(!/admin_set_ai_access/.test(js));
});
