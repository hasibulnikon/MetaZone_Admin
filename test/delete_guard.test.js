// Step 2.7 - STATIC check of the whole-add-on delete guard in migration 0014 (section F, admin_delete_addon).
// It READS the SQL text only: no database, no Supabase, no network. It proves the guard is present, comes BEFORE any write, uses the same
// rule text as addon_catalog(), keeps the signature / grants / tombstone / audit parts, and that its refusal text is understood by the
// frontend. It does NOT run the SQL: whether the guard behaves as described needs PostgreSQL (supabase/tests/test_addon_manager.py, section E2,
// written in this step and NOT executed).
// Run: node --test test/delete_guard.test.js        (MZ_ADMIN_ROOT may point at another copy of MetaZone_Admin)
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..');
const L = require(path.join(ROOT, 'addon_logic.js'));
const raw = fs.readFileSync(path.join(ROOT, 'database', '0014_addon_manager.sql'), 'utf8');
const sql = raw.replace(/--[^\n]*/g, '');
const norm = (t) => t.replace(/\s+/g, ' ');
function body(fn, text = sql) { const a = text.indexOf(`function public.${fn}(`); assert.ok(a >= 0, `${fn} not found`); const b = text.indexOf('end $$;', a); assert.ok(b > a); return text.slice(a, b); }
const del = body('admin_delete_addon'), delN = norm(del);
const at = (needle) => { const i = delN.indexOf(needle); assert.ok(i >= 0, `admin_delete_addon does not contain: ${needle}`); return i; };

test('admin_delete_addon keeps its two-parameter signature, its revoke and its grant (the frontend call is unchanged)', () => {
  assert.ok(/function public\.admin_delete_addon\(p_addon text, p_confirm text\) returns jsonb/.test(sql));
  assert.ok(/revoke all on function public\.admin_delete_addon\(text, text\) from public, anon, authenticated;/.test(sql));
  const grant = sql.slice(sql.indexOf('grant execute on function'));
  assert.ok(grant.includes('public.admin_delete_addon(text, text)'));
  assert.ok(!/function public\.admin_delete_addon\([^)]*bigint/.test(sql), 'no new overload / parameter was added');
});

test('the guard runs after authorisation, validation, confirmation and the per-add-on lock, and BEFORE any write', () => {
  const order = ['perform public._require_admin();', "p_addon !~ '^[a-z0-9_]{1,32}$'", 'p_confirm is distinct from p_addon', "pg_advisory_xact_lock(hashtext('mz_addon:' || p_addon))",
    "and not exists (select 1 from public.addon_releases where addon_id = p_addon) then raise exception 'unknown add-on'", 'from public.addon_active_release where addon_id = p_addon for update', "raise exception 'cannot delete add-on %: users are being offered it right now",
    'insert into public.addon_release_tombstones', 'delete from public.addon_active_release', 'delete from public.addon_releases', 'delete from public.addons', "perform public._audit('addon_delete'"];
  let last = -1;
  for (const n of order) { const i = at(n); assert.ok(i > last, `out of order: "${n}" must come after the previous step`); last = i; }
  assert.equal((delN.match(/insert into|delete from|update public\./g) || []).length, 4, 'exactly the original writes: 1 tombstone insert + 3 deletes; the guard adds none');
  assert.ok(!/update public\./.test(delN), 'the guard must not update anything');
});

test('the guard rule is the addon_catalog() rule (minus the per-app core filter), and a catalogue change makes this test fail', () => {
  const cat = norm(body('addon_catalog'));
  const lateral = cat.slice(cat.indexOf('left join lateral'));
  const rules = ["not x.yanked and x.channel = 'stable'", "s.mode <> 'withdrawn'", "(s.mode <> 'pinned' or x.version = s.active_version)"];
  for (const r of rules) { assert.ok(lateral.includes(r), `addon_catalog() no longer contains: ${r}`); assert.ok(delN.includes(r.replace(/^\(|\)$/g, '')) || delN.includes(r), `admin_delete_addon does not contain: ${r}`); }
  assert.ok(delN.includes("found and s.mode <> 'withdrawn'"), 'the guard only applies when a selection row exists and is not withdrawn');
  assert.ok(!/min_core|max_core|_mz_ver|_addon_block_reason|_addon_effective_version/.test(delN), 'the guard is deliberately NOT narrowed by core ranges or block reasons (it is a superset of the panel\'s effective version)');
});

test('the refusal text is classified as in_use by the frontend and says what to do', () => {
  const m = /raise exception '(cannot delete add-on %: users are being offered it right now[^']*)'/.exec(delN);
  assert.ok(m, 'refusal text not found');
  assert.equal((m[1].match(/%/g) || []).length, 3, 'three placeholders: add-on id, offered version, selection mode');
  const text = m[1].replace('%', 'converter_image').replace('%', '1.1.0').replace('%', 'auto');
  assert.equal(L.classifyDeleteError(text, 'admin_delete_addon'), 'in_use');
  assert.match(text, /Deactivate the add-on first/);
  assert.ok(/, p_addon, v_offered, s\.mode;/.test(delN), 'the message arguments match the placeholders');
});

test('tombstones, revocations, active-selection removal, the returned Storage paths and the audit entry are still produced', () => {
  assert.ok(delN.includes('x.yanked, x.yanked, x.storage_path'), 'tombstone keeps was_yanked and revoked = yanked');
  assert.ok(delN.includes("jsonb_agg(x.storage_path order by x.seq)"), 'storage paths are collected before deletion');
  assert.ok(delN.includes("jsonb_build_object('addon_id', p_addon, 'storage_paths', paths, 'releases_deleted', n_rel, 'revocations_kept', n_rev)"), 'result keys unchanged');
  assert.ok(delN.includes("jsonb_build_object('releases', n_rel, 'yanked_kept_revoked', n_rev)"), 'audit payload unchanged');
  assert.ok(!/page_flags/.test(delN), 'the shared page switch is still not touched');
  // addon_catalog() still folds revoked tombstones in (the revocation part of the migration was not touched)
  assert.ok(norm(body('addon_catalog')).includes('t.revoked'), 'catalogue still lists revoked tombstones');
});

test('the per-release delete function was not changed by Step 2.7 (same refusals as before)', () => {
  const r = norm(body('admin_delete_addon_release'));
  for (const n of ["it is the ACTIVE version", "users are being offered it right now (automatic mode)", "stale: the selection for", "previous_version is not distinct from p_version", "insert into public.addon_release_tombstones"]) assert.ok(r.includes(n), `admin_delete_addon_release lost: ${n}`);
});

test('the SQL test file lists the Step 2.7 cases (they exist in text; they are NOT executed without PostgreSQL)', () => {
  const p = path.join(ROOT, '..', 'MetaZone_App', 'supabase', 'tests', 'test_addon_manager.py');
  if (!fs.existsSync(p)) return;
  const py = fs.readFileSync(p, 'utf8');
  for (const n of ['test_a_pinned_offered_addon_cannot_be_deleted_and_nothing_changes', 'test_an_addon_offered_by_automatic_mode_cannot_be_deleted', 'test_a_deactivated_addon_can_be_deleted_and_both_actions_are_audited',
    'test_an_addon_with_only_yanked_releases_in_automatic_mode_is_not_offered_and_can_be_deleted', 'test_an_addon_whose_only_release_is_not_stable_is_not_offered_and_can_be_deleted',
    'test_the_guard_is_wider_than_the_admin_panels_effective_version', 'test_unauthorised_callers_are_refused_before_the_guard_and_learn_nothing_about_the_offer']) assert.ok(py.includes(`def ${n}(`), `missing SQL test ${n}`);
});
