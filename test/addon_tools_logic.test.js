// node --test MetaZone_Admin/test/addon_tools_logic.test.js   (no dependencies; NOT run when written -- Part 5 was delivered without running tests)
const test = require('node:test'); const assert = require('node:assert/strict');
const L = require('../addon_tools_logic.js');
const rel = (v, seq, o) => ({ release_id: 'r' + seq, version: v, seq, revoked: false, ...(o || {}) });
const tool = (o) => ({ tool_id: 'demo-tool', name: 'Demo', revision: 7, published: true, enabled: true, access_free: true, access_premium: true, current_release_id: 'r2', previous_release_id: 'r1',
  force_update_below: null, rollback: null, user_access: [], releases: [rel('1.0.0', 1), rel('1.1.0', 2), rel('1.2.0', 3)], ...(o || {}) });

test('tool draft rules mirror the RPC', () => {
  assert.equal(L.validateToolDraft({ tool_id: 'ab', name: 'x' }).ok, false);
  assert.equal(L.validateToolDraft({ tool_id: 'Demo', name: 'x' }).ok, false);
  assert.equal(L.validateToolDraft({ tool_id: 'demo-tool', name: '' }).ok, false);
  assert.equal(L.validateToolDraft({ tool_id: 'demo-tool', name: 'x' }, { existingIds: ['demo-tool'] }).ok, false);
  assert.equal(L.validateToolDraft({ tool_id: 'demo-tool', name: 'x' }, { existingIds: [] }).ok, true);
  assert.equal(L.validateToolDraft({ tool_id: 'whatever', name: 'x' }, { editing: true }).ok, true);
});
test('publish pre-flight checks only name, size and notes (never the package)', () => {
  const f = (name, size) => ({ name, size });
  assert.equal(L.validatePublishInput({ tool_id: 'demo-tool', file: f('a.zip', 10) }).ok, true);
  assert.equal(L.validatePublishInput({ tool_id: 'demo-tool', file: f('a.exe', 10) }).ok, false);
  assert.equal(L.validatePublishInput({ tool_id: 'demo-tool', file: f('a.zip', 0) }).ok, false);
  assert.equal(L.validatePublishInput({ tool_id: 'demo-tool', file: f('a.zip', 50 * 1024 * 1024 + 1) }).ok, false);
  assert.equal(L.validatePublishInput({ tool_id: '', file: f('a.zip', 1) }).ok, false);
  assert.equal(L.validatePublishInput({ tool_id: 'demo-tool', file: f('a.zip', 1), notes: 'x'.repeat(2001) }).ok, false);
});
test('version comparison ignores pre-release like the database', () => {
  assert.equal(L.compareVersions('1.2.0', '1.10.0'), -1);
  assert.equal(L.compareVersions('1.0.0-beta', '1.0.0'), 0);
  assert.equal(L.compareVersions('1.0', '1.0.0'), null);
});
test('selecting a release: update vs rollback vs refused', () => {
  const t = tool();
  assert.equal(L.selectKind(t, t.releases[2]).kind, 'update');
  assert.equal(L.selectKind(t, t.releases[0]).kind, 'rollback');
  assert.equal(L.selectKind(t, t.releases[1]).kind, 'none');                            // current
  assert.equal(L.selectKind(tool({ releases: [rel('1.0.0', 1), rel('1.1.0', 2), rel('1.2.0', 3, { revoked: true })] }), { ...rel('1.2.0', 3), revoked: true }).kind, 'none');
  assert.equal(L.selectKind(tool({ force_update_below: '1.1.0' }), t.releases[0]).kind, 'none');
  assert.equal(L.setCurrentCall(t, t.releases[0], '').ok, false);                       // rollback needs a reason
  const c = L.setCurrentCall(t, t.releases[0], ' bug in 1.1.0 ');
  assert.equal(c.ok, true); assert.deepEqual(c.args, { p_tool_id: 'demo-tool', p_version: '1.0.0', p_reason: 'bug in 1.1.0', p_expected_revision: 7 });
});
test('revoke rules', () => {
  const t = tool();
  assert.equal(L.revokeCall(t, t.releases[1], true, 'x').ok, false);                    // current
  assert.equal(L.revokeCall(t, t.releases[0], true, '').ok, false);                     // reason
  assert.equal(L.revokeCall(t, t.releases[0], true, 'bad').ok, true);
  assert.equal(L.revokeCall(t, { ...t.releases[0], revoked: true }, true, 'bad').ok, false);
  assert.equal(L.revokeCall(t, { ...t.releases[0], revoked: true }, false, '').ok, true);
});
test('force update rules', () => {
  const t = tool();
  assert.equal(L.forceUpdateCall(t, '1.1.0', '').ok, false);                            // reason
  assert.equal(L.forceUpdateCall(t, '9.0.0', 'r').ok, false);                           // above current (1.1.0)
  assert.equal(L.forceUpdateCall(t, 'abc', 'r').ok, false);
  const ok = L.forceUpdateCall(t, '1.0.0', 'security'); assert.equal(ok.ok, true); assert.equal(ok.args.p_min_version, '1.0.0');
  const clear = L.forceUpdateCall(t, '', ''); assert.equal(clear.ok, true); assert.equal(clear.args.p_min_version, null); assert.equal(clear.args.p_reason, null);
});
test('state / plan / user access call shapes send NULL for "unchanged" and the revision', () => {
  const t = tool();
  assert.deepEqual(L.stateCall(t, { published: false }), { p_tool_id: 'demo-tool', p_published: false, p_enabled: null, p_expected_revision: 7 });
  assert.deepEqual(L.planCall(t, { premium: true }), { p_tool_id: 'demo-tool', p_free: null, p_premium: true, p_expected_revision: 7 });
  assert.equal(L.userAccessCall(t, 'nope', true).ok, false);
  assert.equal(L.userAccessCall(t, '123e4567-e89b-12d3-a456-426614174000', null).ok, true);
});
test('status and blockers', () => {
  assert.equal(L.toolStatus(tool()).key, 'live');
  assert.equal(L.toolStatus(tool({ published: false })).key, 'unpublished');
  assert.equal(L.toolStatus(tool({ enabled: false })).key, 'disabled');
  assert.equal(L.toolStatus(tool({ access_free: false, access_premium: false })).key, 'noaccess');
  assert.equal(L.toolStatus(tool({ current_release_id: null })).key, 'norelease');
  assert.ok(L.publishBlockers(tool({ current_release_id: null })).length);
  assert.equal(L.publishBlockers(tool()).length, 0);
});
test('RPC error classification', () => {
  assert.equal(L.describeRpcError('stale: demo changed (now revision 9). Reload').kind, 'stale');
  assert.equal(L.describeRpcError('Could not find the function public.admin_addon_tools_list in the schema cache').kind, 'missing');
  assert.equal(L.describeRpcError('forbidden').kind, 'forbidden');
});
test('Edge Function failure description: problems, uncertain, orphan', () => {
  const d = L.describeEdgeFailure({ status: 422, body: { ok: false, error: { code: 'invalid_package', message: 'm' }, problems: [{ code: 'x', message: 'bad', path: 'a.js' }], problem_count: 3, warnings: ['w'] } });
  assert.equal(d.problems.length, 1); assert.equal(d.problemCount, 3); assert.deepEqual(d.warnings, ['w']); assert.equal(d.orphan, null);
  const u = L.describeEdgeFailure({ status: 502, body: { ok: false, error: { code: 'register_unavailable', message: 'm' }, registration_state: 'uncertain', storage: { uploaded: true, path: 'a/1.0.0/a-1.0.0.zip', registered: null } } });
  assert.equal(u.uncertain, true); assert.equal(u.canRecover, false);
  const o = L.describeEdgeFailure({ status: 422, body: { ok: false, error: { code: 'register_rejected', message: 'm' }, storage: { uploaded: true, path: 'a/1.0.0/a-1.0.0.zip', registered: false } } });
  assert.equal(o.canRecover, true);
  assert.equal(L.describeEdgeFailure({ status: 0, body: null }).code, 'unknown');
});
test('callEdge: bearer token only, JSON or form body, never throws on HTTP/network errors', async () => {
  const seen = [];
  const mk = (res) => ({ url: 'https://x.supabase.co/functions/v1/addon-tools-publish', token: 'T', anonKey: 'A', fetch: async (u, init) => { seen.push({ u, init }); if (res instanceof Error) throw res; return res; } });
  const ok = await L.edgeJson(mk({ ok: true, status: 200, json: async () => ({ ok: true, action: 'key_info', key: { key_id: 'k', alg: 'ed25519', fingerprint: 'f' } }) }), { action: 'key_info' });
  assert.equal(ok.ok, true); assert.equal(seen[0].init.headers.Authorization, 'Bearer T'); assert.equal(seen[0].init.headers['Content-Type'], 'application/json');
  assert.equal(L.describeKeyInfo(ok).key_id, 'k');
  const net = await L.edgeJson(mk(new Error('down')), { action: 'status' }); assert.equal(net.ok, false); assert.equal(net.status, 0); assert.equal(net.body.error.code, 'network');
  const bad = await L.edgeJson(mk({ ok: false, status: 502, json: async () => { throw new Error('x'); } }), { action: 'status' }); assert.equal(bad.body.error.code, 'bad_response');
  assert.ok(!JSON.stringify(seen).includes('service_role'));
});
test('audit text and filter', () => {
  assert.equal(L.auditLine({ action: 'release_rollback', detail: { from_version: '1.2.0', reason: 'bug' } }).extra, 'from 1.2.0 · reason: bug');
  const rows = [{ action: 'tool_create', actor_email: 'a@x.com', tool_id: 't1', detail: {} }, { action: 'release_revoke', actor_email: 'b@x.com', tool_id: 't2', detail: {} }];
  assert.equal(L.filterAudit(rows, { q: 'b@x' }).length, 1); assert.equal(L.filterAudit(rows, { action: 'tool_create' }).length, 1);
});

test('publication state is its own answer, separate from status (Part 10)', () => {
  assert.equal(L.publicationState(tool()).key, 'published');
  assert.equal(L.publicationState(tool({ enabled: false })).key, 'published');                  // disabled does not hide that it is published
  assert.equal(L.publicationState(tool({ access_free: false, access_premium: false })).key, 'published');
  const u = L.publicationState(tool({ published: false }));
  assert.equal(u.key, 'unpublished'); assert.equal(u.published, false); assert.equal(u.blockers.length, 0);
  assert.ok(L.publicationState(tool({ published: false, current_release_id: null })).blockers.length);     // not eligible: no current release
  assert.ok(L.publicationState(tool({ published: false, releases: [rel('1.0.0', 2, { revoked: true })] })).blockers.length);
  assert.equal(L.publicationState(tool({ published: undefined })).key, 'unpublished');          // only an explicit true is published
  assert.equal(L.publicationState(null).key, 'unknown');
});
test('publish / unpublish send exactly the published flag with the revision the screen saw', () => {
  assert.deepEqual(L.stateCall(tool({ published: false }), { published: true }), { p_tool_id: 'demo-tool', p_published: true, p_enabled: null, p_expected_revision: 7 });
  assert.deepEqual(L.stateCall(tool(), { published: false }), { p_tool_id: 'demo-tool', p_published: false, p_enabled: null, p_expected_revision: 7 });
});

test('Developer Options: per-user call allows ON / OFF / reset only', () => {
  const id = '11111111-2222-3333-4444-555555555555';
  assert.deepEqual(L.developerImportCall(id, null).args, { p_user: id, p_enabled: null }); assert.equal(L.developerImportCall(id, true).ok, true); assert.equal(L.developerImportCall(id, false).ok, true);
  assert.equal(L.developerImportCall(id, undefined).ok, false); assert.equal(L.developerImportCall(id, 'yes').ok, false); assert.equal(L.developerImportCall('x', true).ok, false);
});
test('Developer Options: settings call sends only what changes, booleans only', () => {
  assert.deepEqual(L.developerSettingsCall({ enabled: false }).args, { p_enabled: false, p_allow_free: null, p_allow_premium: null });
  assert.deepEqual(L.developerSettingsCall({ allow_premium: true }).args, { p_enabled: null, p_allow_free: null, p_allow_premium: true });
  assert.equal(L.developerSettingsCall({}).ok, false); assert.equal(L.developerSettingsCall({ enabled: 'on' }).ok, false); assert.equal(L.developerSettingsCall(null).ok, false);
});
test('Developer Options: unreadable or odd server answers fail closed', () => {
  assert.equal(L.parseDeveloperSettings(null), null); assert.equal(L.parseDeveloperSettings('x'), null);
  assert.deepEqual(L.parseDeveloperSettings({ enabled: 'true', allow_free: 1, allow_premium: true }), { enabled: false, allow_free: false, allow_premium: true, updated_at: null, updated_by_email: '', overrides_on: 0, overrides_off: 0 });
  assert.equal(L.developerReason('plan_on').allowed, true); assert.equal(L.developerReason('override_on').allowed, true);
  for (const c of ['global_off', 'override_off', 'plan_off', '', 'weird', undefined]) assert.equal(L.developerReason(c).allowed, false);
  const id = '11111111-2222-3333-4444-555555555555';
  const st = L.parseDeveloperStates([{ user_id: id, enabled: true, override: null, reason: 'plan_on', plan: 'free' }, { user_id: 'bad', enabled: true }])[id];
  assert.deepEqual([st.enabled, st.override, st.reason], [true, null, 'plan_on']);
  assert.equal(L.parseDeveloperList([{ user_id: id, email: 'a@b.c', override: false, reason: 'override_off' }, { user_id: id, reason: 'plan_on' }]).length, 1);
  assert.match(L.developerSettingsSummary({ enabled: false, allow_free: true, allow_premium: true }), /OFF for everybody/);
  assert.match(L.developerSettingsSummary({ enabled: true, allow_free: false, allow_premium: true }), /Premium by plan/);
});
test('Developer Options: audit lines read well, including a removed personal setting', () => {
  assert.match(L.auditLine({ action: 'developer_import_set', detail: { user_id: 'abcdef12-0', enabled: null, was_enabled: true } }).extra, /ON → none/);
  assert.match(L.auditLine({ action: 'developer_settings_set', detail: { enabled: false, was_enabled: true, allow_free: false, was_allow_free: false, allow_premium: true, was_allow_premium: true } }).extra, /global on → off/);
});

// ---- V5 Part 13: access requests (display / argument logic only; the server decides)
const RID = 'aaaaaaa1-0000-4000-8000-000000000001', UID = '11111111-1111-4111-8111-111111111111';
const reqRow = (o) => ({ id: RID, user_id: UID, email: 'a@x.test', nickname: 'A', plan: 'free', status: 'pending', message: 'hi', created_at: '2026-11-10T00:00:00Z', decided_at: null, decided_by_email: null, allowed_now: false, reason: 'plan_off', ...(o || {}) });
test('requests: list / decision call building is strict', () => {
  assert.deepEqual(L.developerRequestListCall('pending'), { p_status: 'pending', p_limit: 100 });
  assert.deepEqual(L.developerRequestListCall('all', 50), { p_status: null, p_limit: 50 });
  assert.equal(L.developerRequestListCall('weird', 9999).p_status, 'pending'); assert.equal(L.developerRequestListCall('declined', 9999).p_limit, 100);
  assert.deepEqual(L.developerRequestDecisionCall(RID, 'approved'), { ok: true, errors: [], args: { p_request_id: RID, p_decision: 'approved' } });
  assert.equal(L.developerRequestDecisionCall('nope', 'approved').ok, false); assert.equal(L.developerRequestDecisionCall(RID, 'maybe').ok, false); assert.equal(L.developerRequestDecisionCall(RID, null).ok, false);
});
test('requests: parsing drops malformed rows, fails closed on allowed_now, never reads decided_by', () => {
  const p = L.parseDeveloperRequests([reqRow(), reqRow({ id: 'bad' }), reqRow({ status: 'weird' }), null, reqRow({ id: 'aaaaaaa2-0000-4000-8000-000000000002', allowed_now: 'true', decided_by: 'secret-admin-id', status: 'approved', decided_at: 'x', decided_by_email: 'adm@x.test' })]);
  assert.equal(p.length, 2); assert.equal(p[1].allowed_now, false); assert.equal(p[1].decided_by_email, 'adm@x.test'); assert.ok(!('decided_by' in p[1]));
  assert.deepEqual(L.parseDeveloperRequests('x'), []);
  assert.equal(L.requestStatus('approved').text, 'Approved'); assert.equal(L.requestStatus('???').text, 'Unknown');
});
test('requests: the notice names the user, counts, and is null when unreadable or empty', () => {
  assert.equal(L.parseDeveloperRequestSummary(null), null); assert.equal(L.parseDeveloperRequestSummary({ pending_count: -1 }), null); assert.equal(L.parseDeveloperRequestSummary({ pending_count: 'x' }), null);
  assert.equal(L.developerRequestNotice(L.parseDeveloperRequestSummary({ pending_count: 0, newest: [] })), null); assert.equal(L.developerRequestNotice(null), null);
  const one = L.developerRequestNotice(L.parseDeveloperRequestSummary({ pending_count: 1, newest: [{ id: RID, user_id: UID, email: 'a@x.test' }] }));
  assert.match(one.text, /a@x\.test/); assert.equal(one.firstId, RID); assert.equal(one.count, 1);
  assert.match(L.developerRequestNotice({ count: 3, newest: [{ id: RID, user_id: UID, email: 'b@x.test' }] }).text, /3 Developer Import access requests.*b@x\.test/);
});
test('requests: a decision counts as done ONLY if the server confirms this request in the decided state', () => {
  const ok = (o) => ({ ok: true, code: 'approved', granted: true, allowed_now: true, reason: 'override_on', request: reqRow({ status: 'approved' }), ...(o || {}) });
  assert.equal(L.interpretDecision(ok(), 'approved', RID).ok, true); assert.match(L.interpretDecision(ok(), 'approved', RID).text, /now has Developer Options/);
  const blocked = L.interpretDecision(ok({ allowed_now: false, reason: 'global_off' }), 'approved', RID); assert.equal(blocked.ok, true); assert.match(blocked.text, /NOT allowed right now/); assert.doesNotMatch(blocked.text, /now has Developer Options/);
  assert.equal(L.interpretDecision(ok({ granted: false }), 'approved', RID).ok, false, 'approval without a confirmed grant');
  assert.equal(L.interpretDecision(ok({ code: 'declined', granted: false, request: reqRow({ status: 'declined' }) }), 'declined', RID).ok, true);
  assert.equal(L.interpretDecision(ok({ code: 'declined', granted: true, request: reqRow({ status: 'declined' }) }), 'declined', RID).ok, false, 'a decline must never report a grant');
  assert.equal(L.interpretDecision(ok({ request: reqRow({ id: 'aaaaaaa9-0000-4000-8000-000000000009', status: 'approved' }) }), 'approved', RID).ok, false, 'other request');
  assert.equal(L.interpretDecision(ok({ request: reqRow({ status: 'pending' }) }), 'approved', RID).ok, false, 'still pending');
  assert.equal(L.interpretDecision(ok({ code: 'declined', request: reqRow({ status: 'declined' }) }), 'approved', RID).ok, false, 'other decision');
  for (const bad of [null, undefined, 'ok', {}, { ok: true }]) assert.equal(L.interpretDecision(bad, 'approved', RID).ok, false);
  const dup = L.interpretDecision({ ok: false, code: 'already_decided', request: reqRow({ status: 'declined', decided_by_email: 'o@x.test' }) }, 'approved', RID); assert.equal(dup.ok, false); assert.match(dup.text, /already decided by o@x\.test/); assert.equal(dup.kind, 'info');
  assert.equal(L.interpretDecision({ ok: false, code: 'personal_off', request: reqRow() }, 'approved', RID).kind, 'err');
  assert.equal(L.interpretDecision({ ok: false, code: 'not_found' }, 'approved', RID).ok, false);
});
test('requests: audit line for a decided request', () => {
  assert.match(L.auditLine({ action: 'developer_request_decided' }).text, /access request decided/);
  assert.match(L.auditLine({ action: 'developer_request_decided', detail: { user_id: 'abcdef12-0', decision: 'approved', granted: true, allowed_now: false } }).extra, /approved \(personal ON saved\), now not allowed/);
});
