// node --test MetaZone_Admin/test/addon_tools_contract.test.js   (STATIC; reads text only; NOT run when written)
// Every database function / Edge Function action the Admin Addon Tools screen sends must exist in 0032 (or 0035 for Developer Import) / the function with the same parameter names.
const test = require('node:test'); const assert = require('node:assert/strict'); const fs = require('node:fs'); const path = require('node:path');
const ui = fs.readFileSync(path.join(__dirname, '..', 'addon_tools_admin.js'), 'utf8');
const logic = fs.readFileSync(path.join(__dirname, '..', 'addon_tools_logic.js'), 'utf8');
const sql = fs.readFileSync(path.join(__dirname, '..', 'database', '0032_addon_tools.sql'), 'utf8');
const mirror = path.join(__dirname, '..', '..', 'MetaZone_App', 'supabase', 'migrations', '0032_addon_tools.sql');
const sql35 = fs.readFileSync(path.join(__dirname, '..', 'database', '0035_addon_tools_developer_import_permission.sql'), 'utf8');       // Part 11
const mirror35 = path.join(__dirname, '..', '..', 'MetaZone_App', 'supabase', 'migrations', '0035_addon_tools_developer_import_permission.sql');
const sql36 = fs.readFileSync(path.join(__dirname, '..', 'database', '0036_addon_tools_developer_options_access.sql'), 'utf8');       // V5 Part 11
const mirror36 = path.join(__dirname, '..', '..', 'MetaZone_App', 'supabase', 'migrations', '0036_addon_tools_developer_options_access.sql');
const edge = path.join(__dirname, '..', '..', 'MetaZone_App', 'supabase', 'functions', 'addon-tools-publish', 'index.ts');
const sig = (name) => { const m = new RegExp('create or replace function public\\.' + name + '\\(([^)]*)\\)', 'i').exec(sql + '\n' + sql35 + '\n' + sql36 + '\n' + sql38); return m ? m[1].split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean) : null; };

test('every RPC named in the screen exists in 0032', () => {
  const names = [...new Set([...ui.matchAll(/admin_addon_tools_[a-z_]+/g)].map((m) => m[0]))];
  assert.ok(names.length >= 8, names.join(','));
  for (const n of names) assert.ok(sig(n), n + ' is not defined in 0032');
});
test('parameter names built by the logic module are real parameters', () => {
  const want = { admin_addon_tools_upsert_tool: ['p_tool_id', 'p_name', 'p_description', 'p_author'], admin_addon_tools_set_state: ['p_tool_id', 'p_published', 'p_enabled', 'p_expected_revision'],
    admin_addon_tools_set_plan_access: ['p_tool_id', 'p_free', 'p_premium', 'p_expected_revision'], admin_addon_tools_set_user_access: ['p_tool_id', 'p_user', 'p_allowed'],
    admin_addon_tools_set_force_update: ['p_tool_id', 'p_min_version', 'p_reason', 'p_expected_revision'], admin_addon_tools_set_current_release: ['p_tool_id', 'p_version', 'p_reason', 'p_expected_revision'],
    admin_addon_tools_set_release_revoked: ['p_tool_id', 'p_version', 'p_revoked', 'p_reason'], admin_addon_tools_list_audit: ['p_tool_id', 'p_limit'],
    admin_addon_tools_set_developer_import: ['p_user', 'p_enabled'], admin_addon_tools_get_developer_import: ['p_user_ids'], admin_addon_tools_set_developer_settings: ['p_enabled', 'p_allow_free', 'p_allow_premium'], admin_addon_tools_get_developer_settings: [] };
  for (const [fn, params] of Object.entries(want)) { assert.deepEqual(sig(fn), params, fn); for (const p of params) assert.ok((logic + ui).includes(p), fn + ' ' + p + ' is never sent'); }
});
test('Admin copy of 0032 equals the App copy', () => { if (fs.existsSync(mirror)) assert.equal(fs.readFileSync(mirror, 'utf8'), sql); });
test('Admin copy of 0035 equals the App copy', () => { if (fs.existsSync(mirror35)) assert.equal(fs.readFileSync(mirror35, 'utf8'), sql35); });
test('0035: default OFF, own-state-only user RPC, every admin RPC checks the admin first, nothing granted to anon', () => {
  assert.ok(/enabled\s+boolean not null default false/i.test(sql35)); assert.ok(/coalesce\(\(select d\.enabled[^;]*false\)/i.test(sql35));
  for (const n of ['admin_addon_tools_set_developer_import', 'admin_addon_tools_get_developer_import', 'admin_addon_tools_list_developer_import']) {
    const body = sql35.slice(sql35.indexOf('function public.' + n)); assert.ok(/begin\s+perform public\._require_admin\(\)|declare[^$]*begin\s+perform public\._require_admin\(\)/i.test(body.slice(0, 600)), n + ' must call _require_admin first');
  }
  const mine = sql35.slice(sql35.indexOf('function public.addon_tools_my_developer_import')); assert.ok(/_require_user\(\)/.test(mine.slice(0, 300)) && !/p_user/.test(mine.slice(0, 300)), 'user RPC takes no user argument');
  assert.ok(/revoke all on function[\s\S]*from public, anon, authenticated/i.test(sql35)); assert.ok(!/grant[^;]*to\s+(anon|public)\b/i.test(sql35));
});
test('screen never reads or writes the Addon Tools tables directly, and holds no secret', () => {
  assert.ok(!/\.from\(\s*['"]addon_tools/.test(ui + logic)); assert.ok(!/service_role|SERVICE_ROLE|PRIVATE_KEY|storage\/v1\/object/i.test(ui + logic));
  assert.ok(!/addon_releases|admin_publish_addon|admin_yank_addon|MZ_ADDON\b/.test(ui + logic), 'must stay separate from the old Add-on System');
});
test('Edge Function actions used by the screen are accepted by the function', () => {
  if (!fs.existsSync(edge)) return; const src = fs.readFileSync(edge, 'utf8');
  for (const a of ['key_info', 'publish', 'recover_orphan']) assert.ok(src.includes('"' + a + '"'), a);
  assert.ok(/"package"/.test(src) && /"tool_id"/.test(src) && /"notes"/.test(src));
});

test('Admin copy of 0036 equals the App copy', () => { if (fs.existsSync(mirror36)) assert.equal(fs.readFileSync(mirror36, 'utf8'), sql36); });
test('0036: ONE rule, global OFF is checked first and cannot be bypassed by a personal ON; everything seeded OFF', () => {
  const r = sql36.slice(sql36.indexOf('function public._addon_tools_developer_import_reason'), sql36.indexOf('function public._addon_tools_developer_import_allowed'));
  const iGlobal = r.indexOf("'global_off'"), iOn = r.indexOf("'override_on'"), iOff = r.indexOf("'override_off'"), iPlan = r.indexOf("'plan_on'");
  assert.ok(iGlobal > 0 && iGlobal < iOn && iOn < iOff && iOff < iPlan, 'order: global, personal ON, personal OFF, plan');
  assert.ok(/s\.enabled is not true then 'global_off'/.test(r), 'a missing or false global switch is global_off (fail closed)');
  assert.ok(/mz_plan\(p_user\) = 'premium'/.test(r));
  const a = sql36.slice(sql36.indexOf('function public._addon_tools_developer_import_allowed'));
  assert.ok(/_reason\(p_user\) in \('override_on', 'plan_on'\)/.test(a.slice(0, 400)), 'allowed is defined only from the reason');
  assert.ok(/enabled\s+boolean not null default false/.test(sql36) && /allow_free\s+boolean not null default false/.test(sql36) && /allow_premium\s+boolean not null default false/.test(sql36));
  assert.ok(/id\s+boolean primary key default true check \(id\)/.test(sql36), 'single-row table');
});
test('0036: new / changed admin RPCs check the admin first, tables stay closed, nothing granted to anon, user RPC unchanged', () => {
  for (const n of ['admin_addon_tools_get_developer_settings', 'admin_addon_tools_set_developer_settings', 'admin_addon_tools_set_developer_import', 'admin_addon_tools_get_developer_import', 'admin_addon_tools_list_developer_import']) {
    const body = sql36.slice(sql36.indexOf('function public.' + n)); assert.ok(/begin\s+perform public\._require_admin\(\)/i.test(body.slice(0, 700)), n + ' must call _require_admin first');
  }
  assert.ok(/alter table public\.addon_tools_developer_settings enable row level security/.test(sql36) && /revoke all on public\.addon_tools_developer_settings from public, anon, authenticated/.test(sql36));
  assert.ok(!/grant[^;]*to\s+(anon|public)\b/i.test(sql36)); assert.ok(!/create or replace function public\.addon_tools_my_developer_import/.test(sql36), 'the user RPC (own state only) is not redefined');
  assert.ok(!/grant execute on function[^;]*_addon_tools_developer_import_(reason|allowed)/.test(sql36), 'internal rule functions are not granted');
  assert.ok(/p_enabled is null then\s+delete from public\.addon_tools_developer_access/.test(sql36), 'NULL removes the personal decision');
});
test('Admin screen calls the new settings RPCs and shows the server reason, not a guess', () => {
  assert.ok(/admin_addon_tools_set_developer_settings/.test(ui) && /admin_addon_tools_get_developer_settings/.test(ui));
  assert.ok(/L\.developerReason\(/.test(ui) && /developerSettingsCall/.test(ui));
});

// V5 Part 12: 0037 (user-side Developer Options access requests). The Admin folder only keeps the identical copy; the Admin screen does not use it yet (Part 13).
const sql37 = fs.readFileSync(path.join(__dirname, '..', 'database', '0037_addon_tools_developer_access_requests.sql'), 'utf8');
const mirror37 = path.join(__dirname, '..', '..', 'MetaZone_App', 'supabase', 'migrations', '0037_addon_tools_developer_access_requests.sql');
test('Admin copy of 0037 equals the App copy', () => { if (fs.existsSync(mirror37)) assert.equal(fs.readFileSync(mirror37, 'utf8'), sql37); });
test('0037: closed table, one pending request per user, user RPCs use the session, nothing writes access or settings', () => {
  assert.ok(/enable row level security/.test(sql37) && /revoke all on public\.addon_tools_developer_requests from public, anon, authenticated/.test(sql37));
  assert.ok(/unique index if not exists \w+ on public\.addon_tools_developer_requests \(user_id\) where status = 'pending'/.test(sql37));
  assert.ok(!/grant[^;]*to\s+(anon|public)\b/i.test(sql37));
  const code = sql37.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  assert.ok(!/(insert into|update|delete from)\s+public\.addon_tools_developer_(access|settings)/i.test(code), 'a request never changes access');
  assert.ok(/addon_tools_request_developer_access\(p_message text default null\)/.test(code) && /addon_tools_my_developer_request\(\)/.test(code));
  assert.ok(/values \(uid, v_msg\)/.test(code), 'user_id is the session user');
});

// V5 Part 13: 0038 (Admin side of the access requests)
const sql38 = fs.readFileSync(path.join(__dirname, '..', 'database', '0038_addon_tools_developer_request_admin.sql'), 'utf8');
const mirror38 = path.join(__dirname, '..', '..', 'MetaZone_App', 'supabase', 'migrations', '0038_addon_tools_developer_request_admin.sql');
const code38 = sql38.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
const sig38 = (name) => { const m = new RegExp('create or replace function public\\.' + name + '\\(([^)]*)\\)', 'i').exec(sql38); return m ? m[1].split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean) : null; };
test('Admin copy of 0038 equals the App copy', () => { assert.ok(fs.existsSync(mirror38), 'the App copy of 0038 must exist'); assert.equal(fs.readFileSync(mirror38, 'utf8'), sql38); });
test('0038: reuses the 0037 table (no new table), never redefines 0035-0037 functions or the 0036 rule', () => {
  assert.ok(!/create table/i.test(code38), 'no new table');
  for (const n of ['_addon_tools_developer_import_reason', '_addon_tools_developer_import_allowed', 'admin_addon_tools_set_developer_import', 'addon_tools_request_developer_access', 'addon_tools_my_developer_request', '_addon_tools_developer_request_gate', '_addon_tools_developer_request_json'])
    assert.ok(!new RegExp('create or replace function public\\.' + n + '\\(').test(code38), n + ' must not be redefined');
  assert.ok(!/(insert into|update|delete from)\s+public\.addon_tools_developer_(access|settings)\b/i.test(code38), 'access is granted ONLY through the 0036 RPC');
});
test('0038: every admin function checks the admin first; nothing granted to anon / public; the internal helper has no grant', () => {
  for (const n of ['admin_addon_tools_list_developer_requests', 'admin_addon_tools_developer_request_summary', 'admin_addon_tools_decide_developer_request']) {
    const body = sql38.slice(sql38.indexOf('function public.' + n)); assert.ok(/begin\s+perform public\._require_admin\(\)/i.test(body.slice(0, 500)), n + ' must call _require_admin first');
  }
  assert.ok(!/grant[^;]*to\s+(anon|public)\b/i.test(code38)); assert.ok(/revoke all on function[\s\S]*_addon_tools_developer_request_admin_json[\s\S]*from public, anon, authenticated/.test(code38));
  assert.ok(!/grant execute on function[^;]*_admin_json/.test(code38), 'the helper that returns decided_by is not callable by clients');
  assert.ok(!/p_user\b|p_decided_by|p_admin/.test(code38.slice(code38.indexOf('function public.admin_addon_tools_decide_developer_request'), code38.indexOf('-- ====', code38.indexOf('function public.admin_addon_tools_decide_developer_request')))), 'no client-supplied identity');
});
test('0038: decision is one guarded transaction: locks, pending-only, decided_by = session, grant through the existing RPC, one audit row', () => {
  const b = code38.slice(code38.indexOf('function public.admin_addon_tools_decide_developer_request'));
  assert.ok(/pg_advisory_xact_lock\(hashtext\('mz_addon_tools_dev_request:' \|\| v_user::text\)\)/.test(b), 'same advisory key as the user-side submit');
  assert.ok(/from public\.addon_tools_developer_requests where id = p_request_id for update/.test(b));
  assert.ok(b.indexOf("'already_decided'") > 0 && b.indexOf("'already_decided'") < b.indexOf('admin_addon_tools_set_developer_import'), 'a decided request is refused BEFORE anything is granted');
  assert.ok(/'personal_off'/.test(b) && b.indexOf("'personal_off'") < b.indexOf('admin_addon_tools_set_developer_import'), 'personal OFF refusal happens before the grant');
  assert.ok(/admin_addon_tools_set_developer_import\(r\.user_id, true\)/.test(b));
  assert.ok(/set status = p_decision, decided_at = now\(\), decided_by = auth\.uid\(\)\s+where id = r\.id and status = 'pending'/.test(b));
  assert.ok(/_addon_tools_audit\('developer_request_decided'/.test(b));
  assert.ok(/p_decision not in \('approved', 'declined'\)/.test(b));
});
test('0038: parameter names sent by the Admin screen are real parameters', () => {
  assert.deepEqual(sig38('admin_addon_tools_list_developer_requests'), ['p_status', 'p_limit']);
  assert.deepEqual(sig38('admin_addon_tools_decide_developer_request'), ['p_request_id', 'p_decision']);
  assert.deepEqual(sig38('admin_addon_tools_developer_request_summary'), []);
  for (const p of ['p_status', 'p_limit', 'p_request_id', 'p_decision']) assert.ok(logic.includes(p), p);
  for (const n of ['admin_addon_tools_list_developer_requests', 'admin_addon_tools_decide_developer_request', 'admin_addon_tools_developer_request_summary']) assert.ok(ui.includes(n) || fs.readFileSync(path.join(__dirname, '..', 'admin.js'), 'utf8').includes(n), n);
});
test('Admin screen never writes the request table directly and sends no user id with a decision', () => {
  assert.ok(!/\.from\(\s*['"]addon_tools_developer_requests/.test(ui + logic));
  const c = L.developerRequestDecisionCall('aaaaaaa1-0000-4000-8000-000000000001', 'approved'); assert.deepEqual(Object.keys(c.args), ['p_request_id', 'p_decision']);
});
const L = require('../addon_tools_logic.js');
