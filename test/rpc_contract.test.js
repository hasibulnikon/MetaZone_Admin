// Step 2.6 - STATIC contract check between the Admin frontend and the SQL function signatures.
// It READS text only: no database, no Supabase, no network. It proves that every add-on RPC the frontend can send names a function that
// is defined in database/*.sql and uses only parameter names that function declares (and supplies every parameter that has no default).
// It does NOT prove the SQL runs, that return values have the expected shape, or that permissions work: those need a real PostgreSQL.
// Run: node --test test/rpc_contract.test.js        (MZ_ADMIN_ROOT may point at another copy of MetaZone_Admin)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

// ---- SQL side: { fnName: { params: [{name, hasDefault}], file } } (later files override earlier ones, like re-running the migrations)
function sqlSignatures() {
  const dir = path.join(ROOT, 'database'), out = {};
  for (const f of fs.readdirSync(dir).filter((x) => /^\d+_.*\.sql$/.test(x)).sort()) {
    const sql = fs.readFileSync(path.join(dir, f), 'utf8').replace(/--[^\n]*/g, '');
    const re = /create\s+or\s+replace\s+function\s+public\.(\w+)\s*\(/gi; let m;
    while ((m = re.exec(sql))) {
      let i = re.lastIndex, depth = 1, start = i;
      while (i < sql.length && depth > 0) { if (sql[i] === '(') depth++; else if (sql[i] === ')') depth--; i++; }
      const inner = sql.slice(start, i - 1).trim(), params = [];
      if (inner) {
        let d = 0, cur = '';
        for (const ch of inner) { if (ch === '(') d++; if (ch === ')') d--; if (ch === ',' && d === 0) { params.push(cur); cur = ''; } else cur += ch; }
        params.push(cur);
      }
      out[m[1]] = { file: f, params: params.map((p) => { const t = p.trim().replace(/\s+/g, ' '); return { name: t.split(' ')[0], hasDefault: /\bdefault\b/i.test(t) }; }) };
    }
  }
  return out;
}

// ---- JS side: top-level keys of an object literal that starts at text[open] === '{'
function topLevelKeys(text, open) {
  const keys = []; let depth = 0, i = open, q = null, expectKey = false, tok = '';
  const flush = () => { tok = ''; };
  for (; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '\\') { i++; continue; } if (c === q) q = null; continue; }
    if (c === '\'' || c === '"' || c === '`') { q = c; continue; }
    if (c === '{' || c === '[' || c === '(') { depth++; if (depth === 1) { expectKey = true; flush(); } continue; }
    if (c === '}' || c === ']' || c === ')') { depth--; if (depth === 0) break; continue; }
    if (depth === 1) {
      if (c === ',') { expectKey = true; flush(); continue; }
      if (expectKey && /[\w$]/.test(c)) { tok += c; continue; }
      if (expectKey && c === ':' && tok) { keys.push(tok); expectKey = false; flush(); continue; }
      if (expectKey && /\s/.test(c)) continue;
      if (expectKey && tok && (c === ',' || c === '}')) { keys.push(tok); flush(); continue; }
      if (!/\s/.test(c)) { expectKey = false; flush(); }
    }
  }
  return keys;
}

// every call site: { fn, keys: null | [..], where }
function callSites() {
  const sites = [];
  const al = read('addon_logic.js'), ad = read('admin.js');
  let re = /fn:\s*'(admin_\w+)'\s*,\s*params:\s*(\{)/g, m;
  while ((m = re.exec(al))) sites.push({ fn: m[1], keys: topLevelKeys(al, m.index + m[0].length - 1), where: 'addon_logic.js' });
  // checkAddonDraft() builds the admin_upsert_addon parameters; admin.js sends them as a variable (rpc('admin_upsert_addon', chk.params))
  re = /params:\s*ok\s*\?\s*(\{)/g;
  while ((m = re.exec(al))) sites.push({ fn: 'admin_upsert_addon', keys: topLevelKeys(al, m.index + m[0].length - 1), where: 'addon_logic.js (checkAddonDraft)' });
  // rpc('fn') = no arguments; rpc('fn', {literal}) = keys are checked; rpc('fn', variable) = dynamic, checked where the variable is built
  re = /\brpc\(\s*'(admin_\w+|addon_\w+)'\s*(,\s*(\{)?)?/g;
  while ((m = re.exec(ad))) {
    if (m[3]) sites.push({ fn: m[1], keys: topLevelKeys(ad, m.index + m[0].length - 1), where: 'admin.js' });
    else if (!m[2]) sites.push({ fn: m[1], keys: [], where: 'admin.js' });
    else sites.push({ fn: m[1], keys: null, where: 'admin.js (dynamic arguments)' });
  }
  // the selection helper in admin.js: call('admin_clear_addon_active', { ... }, message)
  re = /\bcall\(\s*'(admin_\w+)'\s*,\s*(\{)/g;
  while ((m = re.exec(ad))) sites.push({ fn: m[1], keys: topLevelKeys(ad, m.index + m[0].length - 1), where: 'admin.js (call helper)' });
  return sites.filter((s) => /addon/.test(s.fn));
}

const SQL = sqlSignatures();
const SITES = callSites();
const MANAGER_FNS = ['admin_upsert_addon', 'admin_list_addons', 'admin_withdraw_addon', 'admin_delete_addon_release', 'admin_delete_addon', 'admin_replace_addon_release'];

test('the parser finds the expected SQL functions and call sites (guards against a silently empty check)', () => {
  for (const f of MANAGER_FNS) assert.ok(SQL[f], `${f} not found in database/*.sql`);
  assert.ok(SITES.filter((x) => x.keys !== null).length >= 20, `only ${SITES.length} add-on RPC call sites were found`);
  const seen = new Set(SITES.map((s) => s.fn));
  for (const f of MANAGER_FNS) assert.ok(seen.has(f), `no frontend call site found for ${f}`);
  assert.deepStrictEqual(SQL.admin_delete_addon_release.params.map((p) => p.name), ['p_addon', 'p_version', 'p_expected_revision']);
});

test('every add-on RPC the frontend sends exists in the SQL and uses only declared parameter names', () => {
  const bad = [];
  for (const s of SITES) {
    const sig = SQL[s.fn];
    if (!sig) { bad.push(`${s.where}: ${s.fn} is not defined in database/*.sql`); continue; }
    const names = sig.params.map((p) => p.name);
    for (const k of s.keys || []) if (!names.includes(k)) bad.push(`${s.where}: ${s.fn} is called with unknown parameter "${k}" (SQL declares: ${names.join(', ') || 'none'})`);
  }
  assert.deepStrictEqual(bad, []);
});

test('every parameter without a default is supplied at every call site', () => {
  const bad = [];
  for (const s of SITES) {
    const sig = SQL[s.fn]; if (!sig || s.keys === null) continue;
    for (const p of sig.params) if (!p.hasDefault && !s.keys.includes(p.name)) bad.push(`${s.where}: ${s.fn} is called without required parameter "${p.name}"`);
  }
  assert.deepStrictEqual(bad, []);
});

test('the Step 2.4 replace call sends one jsonb argument "p" with the keys the SQL reads', () => {
  assert.deepStrictEqual(SQL.admin_replace_addon_release.params.map((p) => p.name), ['p']);
  const al = read('addon_logic.js'), i = al.indexOf("fn: 'admin_replace_addon_release'");
  assert.ok(i > 0);
  const inner = al.indexOf('{', al.indexOf('p:', i));
  assert.deepStrictEqual(topLevelKeys(al, inner).sort(), ['addon_id', 'expected_sha256', 'sha256', 'size', 'version']);
  const sql = fs.readFileSync(path.join(ROOT, 'database', '0014_addon_manager.sql'), 'utf8');
  for (const k of ['addon_id', 'version', 'size', 'sha256', 'expected_sha256']) assert.ok(sql.includes(`p->>'${k}'`), `0014 does not read p->>'${k}'`);
});

test('the result keys the frontend relies on are produced by the SQL (text check only, NOT an execution)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'database', '0014_addon_manager.sql'), 'utf8');
  const need = {
    admin_delete_addon_release: ['addon_id', 'version', 'storage_path', 'was_yanked', 'revocation_kept'],
    admin_delete_addon: ['addon_id', 'storage_paths', 'releases_deleted', 'revocations_kept'],
    admin_list_addons: ['addon_id', 'name', 'description', 'registered', 'feature_key', 'release_count', 'yanked_count', 'latest_version', 'deleted_count', 'mode', 'active_version', 'previous_version', 'revision', 'effective_version'],
  };
  for (const [fn, keys] of Object.entries(need)) {
    const a = sql.indexOf(`function public.${fn}(`), b = sql.indexOf('end $$;', a), body = sql.slice(a, b);
    for (const k of keys) assert.ok(body.includes(`'${k}'`), `${fn} does not build the key "${k}"`);
  }
});

test('the two copies of migration 0014 (and 0012 / 0013) are byte-identical', () => {
  const app = path.join(ROOT, '..', 'MetaZone_App', 'supabase', 'migrations');
  if (!fs.existsSync(app)) return;                       // Admin folder delivered on its own: nothing to compare
  for (const f of ['0012_addons.sql', '0013_task2_admin_controls.sql', '0014_addon_manager.sql']) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'database', f)).equals(fs.readFileSync(path.join(app, f))), `${f} differs between MetaZone_Admin/database and MetaZone_App/supabase/migrations`);
  }
});

test('every function the 0014 migration creates is revoked from public and granted only to authenticated (text check)', () => {
  const sql = fs.readFileSync(path.join(ROOT, 'database', '0014_addon_manager.sql'), 'utf8').replace(/--[^\n]*/g, '');
  for (const f of MANAGER_FNS.concat(['_guard_deleted_release'])) assert.ok(new RegExp(`revoke all on function public\\.${f}\\(`).test(sql), `${f} is not revoked from public`);
  const grant = sql.slice(sql.indexOf('grant execute on function'));
  for (const f of MANAGER_FNS) assert.ok(grant.includes(`public.${f}(`), `${f} is not granted to authenticated`);
  assert.ok(!grant.includes('_guard_deleted_release'), 'the trigger function must not be granted');
  assert.ok(!/grant[^;]*\bto\s+(anon|public)\b/i.test(sql), 'something is granted to anon / public');
  for (const f of MANAGER_FNS) {                          // each admin function checks _require_admin() first
    const a = sql.indexOf(`function public.${f}(`), body = sql.slice(a, sql.indexOf('end $$;', a));
    assert.ok(/begin\s+perform public\._require_admin\(\);/.test(body), `${f} does not call _require_admin() first`);
  }
});
