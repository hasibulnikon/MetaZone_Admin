/* MetaZone Admin -- Addon Tools Manager: pure logic (no DOM, no Supabase client). Loaded by index.html as window.MZ_ADDON_TOOLS and by the node
   unit test (test/addon_tools_logic.test.js) via require().
   This file NEVER validates a package, hashes for trust, builds or signs a release: that is the `addon-tools-publish` Edge Function (Part 2D).
   It only (a) checks form input before a call is made, (b) describes what the database RPCs (0032) returned, and (c) talks to the Edge
   Function through an injected fetch with the admin's own access token. The server stays the authority for every rule mirrored here. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.MZ_ADDON_TOOLS = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';

  const TOOL_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;                                   // 0032: addon_tools_catalog.tool_id
  const VERSION_RE = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})(-[0-9A-Za-z.-]{1,20})?$/;   // 0032: _addon_tools_ver
  const LIMITS = { name: 60, description: 280, author: 80, notes: 2000, reason: 400, zipBytes: 50 * 1024 * 1024, audit: 500 };
  const EDGE_FUNCTION = 'addon-tools-publish';

  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const trim = (s) => String(s == null ? '' : s).trim();

  // ------------------------------------------------------------------ versions
  function parseVersion(v) { const m = VERSION_RE.exec(String(v == null ? '' : v)); return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null; }
  function compareVersions(a, b) {                                                // pre-release suffix ignored, exactly like _addon_tools_ver
    const x = parseVersion(a), y = parseVersion(b); if (!x || !y) return null;
    for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
    return 0;
  }

  // ------------------------------------------------------------------ form validation (mirrors the RPC messages; server decides)
  function validateToolDraft(d, o) {
    const errors = []; const x = d || {}; const existing = (o && o.existingIds) || [];
    const id = trim(x.tool_id), name = trim(x.name), desc = trim(x.description), author = trim(x.author);
    if (!(o && o.editing)) {
      if (!TOOL_ID_RE.test(id)) errors.push('Tool id: 3-40 characters, a-z, 0-9 and hyphen, starting with a letter. It cannot be changed later.');
      else if (existing.includes(id)) errors.push('A tool with this id already exists. Edit it from the list instead.');
    }
    if (!name) errors.push('Name is required.'); else if (name.length > LIMITS.name) errors.push('Name is too long (max ' + LIMITS.name + ' characters).');
    if (desc.length > LIMITS.description) errors.push('Description is too long (max ' + LIMITS.description + ' characters).');
    if (author.length > LIMITS.author) errors.push('Author is too long (max ' + LIMITS.author + ' characters).');
    return { ok: errors.length === 0, errors, value: { tool_id: id, name, description: desc, author } };
  }
  const upsertCall = (v) => ({ p_tool_id: v.tool_id, p_name: v.name, p_description: v.description, p_author: v.author });

  // Light, honest pre-flight for the upload form. NO package inspection here: a ZIP is only accepted or refused by the Edge Function.
  function validatePublishInput(i) {
    const errors = []; const x = i || {}; const tool = trim(x.tool_id); const notes = String(x.notes == null ? '' : x.notes);
    if (!TOOL_ID_RE.test(tool)) errors.push('Choose the tool this release belongs to.');
    const f = x.file;
    if (!f) errors.push('Choose a .zip package.');
    else {
      if (!/\.zip$/i.test(String(f.name || ''))) errors.push('The package must be a .zip file.');
      if (!(f.size >= 1)) errors.push('The file is empty.');
      else if (f.size > LIMITS.zipBytes) errors.push('The file is larger than 50 MB (' + fmtBytes(f.size) + ').');
    }
    if (notes.length > LIMITS.notes) errors.push('Release notes are too long (max ' + LIMITS.notes + ' characters).');
    return { ok: errors.length === 0, errors, value: { tool_id: tool, notes: notes.trim() } };
  }

  // ------------------------------------------------------------------ tool state
  // 'draft' = no current release or never published; 'live' = users who pass the access rule are offered it now.
  function toolStatus(t) {
    if (!isObj(t)) return { key: 'unknown', label: 'Unknown', cls: '' };
    if (!t.current_release_id) return { key: 'norelease', label: 'No current release', cls: '' };
    if (!t.published) return { key: 'unpublished', label: 'Unpublished', cls: '' };
    if (!t.enabled) return { key: 'disabled', label: 'Disabled', cls: 'suspended' };
    if (!t.access_free && !t.access_premium && !(t.user_access || []).some((u) => u.allowed === true)) return { key: 'noaccess', label: 'Live, but nobody has access', cls: 'premium' };
    return { key: 'live', label: 'Live', cls: 'ok' };
  }
  // Publication on its own (Part 10). toolStatus() folds this together with enabled / plan access, so a published-but-disabled tool reads only
  // "Disabled". This answers just one question: has an administrator explicitly published this tool? Display only; the database decides.
  function publicationState(t) {
    if (!isObj(t)) return { key: 'unknown', label: 'Unknown', cls: '', published: false, blockers: ['Unknown tool.'] };
    const blockers = publishBlockers(t);
    if (t.published === true) return { key: 'published', label: 'Published', cls: 'ok', published: true, blockers: [] };
    return { key: 'unpublished', label: 'Unpublished', cls: '', published: false, blockers };
  }
  function accessSummary(t) {
    const p = []; if (t.access_free) p.push('Free'); if (t.access_premium) p.push('Premium');
    const allow = (t.user_access || []).filter((u) => u.allowed === true).length, deny = (t.user_access || []).filter((u) => u.allowed === false).length;
    const extra = []; if (allow) extra.push(allow + ' user' + (allow === 1 ? '' : 's') + ' allowed'); if (deny) extra.push(deny + ' denied');
    return (p.length ? p.join(' + ') : 'No plan') + (extra.length ? ' · ' + extra.join(', ') : '');
  }
  // What stops "Publish" right now (the RPC checks again). Empty list = the button may be offered.
  function publishBlockers(t) {
    const out = []; if (!isObj(t)) return ['Unknown tool.'];
    if (!t.current_release_id) out.push('Make a release current first (Releases tab).');
    else { const cur = (t.releases || []).find((r) => r.release_id === t.current_release_id); if (cur && cur.revoked) out.push('The current release is revoked: choose another current release first.'); }
    return out;
  }
  const currentRelease = (t) => (t.releases || []).find((r) => r.release_id === t.current_release_id) || null;

  // ------------------------------------------------------------------ releases
  // Labels for the history table. A release can carry several (e.g. Current + Rolled back).
  function releaseLabels(t, r) {
    const l = [];
    if (r.release_id === t.current_release_id) l.push({ key: 'current', text: 'Current', cls: 'ok' });
    if (r.release_id === t.previous_release_id && r.release_id !== t.current_release_id) l.push({ key: 'previous', text: 'Previous', cls: '' });
    if (t.rollback && t.rollback.from_version === r.version) l.push({ key: 'replaced', text: 'Replaced by rollback', cls: 'premium' });
    if (r.revoked) l.push({ key: 'revoked', text: 'Revoked', cls: 'suspended' });
    if (!l.length) l.push({ key: 'available', text: r.revoked ? 'Revoked' : 'Available', cls: '' });
    return l;
  }
  // 'update' = newer than current, 'rollback' = older than current, 'none' = cannot be selected (current / revoked / below force floor).
  function selectKind(t, r) {
    if (!isObj(t) || !isObj(r)) return { kind: 'none', why: 'Unknown release.' };
    if (r.release_id === t.current_release_id) return { kind: 'none', why: 'Already the current release.' };
    if (r.revoked) return { kind: 'none', why: 'Revoked: restore it first.' };
    if (t.force_update_below && compareVersions(r.version, t.force_update_below) === -1) return { kind: 'none', why: 'Below the force-update minimum (' + t.force_update_below + ').' };
    const cur = currentRelease(t);
    if (!cur) return { kind: 'update', why: '' };
    return { kind: r.seq < cur.seq ? 'rollback' : 'update', why: '' };
  }
  function setCurrentCall(t, r, reason) {
    const k = selectKind(t, r); const why = trim(reason);
    const errors = [];
    if (k.kind === 'none') errors.push(k.why);
    if (k.kind === 'rollback' && !why) errors.push('A rollback needs a reason.');
    if (why.length > LIMITS.reason) errors.push('Reason is too long (max ' + LIMITS.reason + ' characters).');
    return { ok: errors.length === 0, errors, kind: k.kind, args: { p_tool_id: t.tool_id, p_version: r.version, p_reason: why || null, p_expected_revision: t.revision } };
  }
  function revokeCall(t, r, revoked, reason) {
    const why = trim(reason); const errors = [];
    if (revoked && r.release_id === t.current_release_id) errors.push('This is the current release: make another version current (or unpublish the tool) before revoking it.');
    if (revoked && !why) errors.push('Revoking needs a reason.');
    if (why.length > LIMITS.reason) errors.push('Reason is too long (max ' + LIMITS.reason + ' characters).');
    if (!!r.revoked === !!revoked) errors.push('The release is already ' + (revoked ? 'revoked' : 'not revoked') + '.');
    return { ok: errors.length === 0, errors, args: { p_tool_id: t.tool_id, p_version: r.version, p_revoked: !!revoked, p_reason: revoked ? why : null } };
  }

  // ------------------------------------------------------------------ plan / user access / force update / state
  const stateCall = (t, patch) => ({ p_tool_id: t.tool_id, p_published: patch.published === undefined ? null : patch.published, p_enabled: patch.enabled === undefined ? null : patch.enabled, p_expected_revision: t.revision });
  const planCall = (t, patch) => ({ p_tool_id: t.tool_id, p_free: patch.free === undefined ? null : patch.free, p_premium: patch.premium === undefined ? null : patch.premium, p_expected_revision: t.revision });
  function userAccessCall(t, userId, allowed) {                                    // allowed: true / false / null (= remove the override)
    const errors = [];
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(userId || ''))) errors.push('Choose a user.');
    if (allowed !== true && allowed !== false && allowed !== null) errors.push('Invalid access value.');
    return { ok: errors.length === 0, errors, args: { p_tool_id: t.tool_id, p_user: userId, p_allowed: allowed } };
  }
  // ------------------------------------------------------------------ Developer Import permission (Part 11): per USER, not per tool
  // One switch for a future Developer ZIP Import. It grants no catalog access and no publishing right; the server (0035) is the only authority.
  const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  // Part 11 (V5): enabled = true (personal ON) / false (personal OFF) / null (remove the personal decision: the plan switch decides again).
  function developerImportCall(userId, enabled) {
    const errors = [];
    if (!UUID_RE.test(String(userId || ''))) errors.push('Choose a user.');
    if (enabled !== true && enabled !== false && enabled !== null) errors.push('Choose ON, OFF or reset.');
    return { ok: errors.length === 0, errors, args: { p_user: userId, p_enabled: enabled } };
  }
  // Global + Free / Premium switches (0036). patch keys: enabled, allow_free, allow_premium; undefined = leave unchanged. Booleans only.
  function developerSettingsCall(patch) {
    const errors = []; const p = isObj(patch) ? patch : {}; const args = { p_enabled: null, p_allow_free: null, p_allow_premium: null }; let n = 0;
    [['enabled', 'p_enabled'], ['allow_free', 'p_allow_free'], ['allow_premium', 'p_allow_premium']].forEach(([k, a]) => {
      if (p[k] === undefined) return; if (p[k] !== true && p[k] !== false) { errors.push('Invalid value for ' + k + '.'); return; } args[a] = p[k]; n++;
    });
    if (!n && !errors.length) errors.push('Nothing to change.');
    return { ok: errors.length === 0, errors, args };
  }
  // What the server answered for admin_addon_tools_get_developer_settings. Anything but a real boolean reads as OFF (fail closed); null = unreadable.
  function parseDeveloperSettings(raw) {
    if (!isObj(raw)) return null;
    const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
    return { enabled: raw.enabled === true, allow_free: raw.allow_free === true, allow_premium: raw.allow_premium === true, updated_at: raw.updated_at || null,
      updated_by_email: typeof raw.updated_by_email === 'string' ? raw.updated_by_email : '', overrides_on: n(raw.overrides_on), overrides_off: n(raw.overrides_off) };
  }
  // The server's reason codes (0036 _addon_tools_developer_import_reason), in plain words. Unknown code = "not allowed", never "allowed".
  const DEV_REASONS = {
    global_off: { allowed: false, text: 'Blocked: Developer Options is switched off for everybody', cls: 'suspended' },
    override_on: { allowed: true, text: 'Allowed: personal ON', cls: 'ok' },
    override_off: { allowed: false, text: 'Blocked: personal OFF', cls: 'suspended' },
    plan_on: { allowed: true, text: 'Allowed: by plan', cls: 'ok' },
    plan_off: { allowed: false, text: 'Not allowed: plan switch is off', cls: 'premium' },
  };
  function developerReason(code) { return DEV_REASONS[code] || { allowed: false, text: 'Not allowed (state unknown)', cls: 'suspended' }; }
  const developerImportBadge = (on) => (on ? { text: 'Developer Options: allowed', cls: 'ok' } : { text: 'Developer Options: not allowed', cls: 'suspended' });
  function developerSettingsSummary(st) {
    if (!isObj(st)) return 'Unknown';
    if (!st.enabled) return 'OFF for everybody';
    const p = []; if (st.allow_free) p.push('Free'); if (st.allow_premium) p.push('Premium');
    return 'ON · ' + (p.length ? p.join(' + ') + ' by plan' : 'no plan allowed, personal ON only');
  }
  // {user_id: {enabled (effective), override (true/false/null), reason, plan, updated_at}}; malformed rows are ignored (the user then shows as not allowed).
  function parseDeveloperStates(raw) {
    const out = {};
    (Array.isArray(raw) ? raw : []).forEach((r) => { if (isObj(r) && UUID_RE.test(String(r.user_id || ''))) out[String(r.user_id).toLowerCase()] = {
      enabled: r.enabled === true, override: r.override === true ? true : r.override === false ? false : null, reason: typeof r.reason === 'string' ? r.reason : '',
      plan: typeof r.plan === 'string' ? r.plan : '', updated_at: r.updated_at || null }; });
    return out;
  }
  // Users with a PERSONAL decision (ON or OFF).
  function parseDeveloperList(raw) {
    return (Array.isArray(raw) ? raw : []).filter((r) => isObj(r) && UUID_RE.test(String(r.user_id || '')) && (r.override === true || r.override === false || r.enabled === true || r.enabled === false))
      .map((r) => ({ user_id: String(r.user_id).toLowerCase(), email: typeof r.email === 'string' ? r.email : '', override: r.override === true || r.override === false ? r.override : r.enabled === true,
        effective: r.effective === true, reason: typeof r.reason === 'string' ? r.reason : '', plan: typeof r.plan === 'string' ? r.plan : '', updated_at: r.updated_at || null }));
  }
  // ------------------------------------------------------------------ Developer Options access REQUESTS (V5 Part 13, migration 0038)
  // Everything here is display / argument building. The server (0038) decides: it checks the admin, the pending status, the personal-OFF rule and the grant.
  const REQ_STATUS = { pending: { text: 'Pending', cls: 'premium' }, approved: { text: 'Approved', cls: 'ok' }, declined: { text: 'Declined', cls: 'suspended' } };
  const REQ_FILTERS = ['pending', 'approved', 'declined', 'all'];
  const requestStatus = (s) => REQ_STATUS[s] || { text: 'Unknown', cls: 'suspended' };
  function developerRequestListCall(filter, limit) {
    const f = REQ_FILTERS.includes(filter) ? filter : 'pending'; const n = Number.isInteger(limit) && limit >= 1 && limit <= 200 ? limit : 100;
    return { p_status: f === 'all' ? null : f, p_limit: n };
  }
  function developerRequestDecisionCall(requestId, decision) {
    const errors = [];
    if (!UUID_RE.test(String(requestId || ''))) errors.push('Choose a request.');
    if (decision !== 'approved' && decision !== 'declined') errors.push('Choose Approve or Decline.');
    return { ok: errors.length === 0, errors, args: { p_request_id: requestId, p_decision: decision } };
  }
  // One request as the Admin screen shows it. Malformed rows are dropped. Only a real status counts; allowed_now only when the server said a boolean true.
  function parseDeveloperRequests(raw) {
    return (Array.isArray(raw) ? raw : []).filter((r) => isObj(r) && UUID_RE.test(String(r.id || '')) && UUID_RE.test(String(r.user_id || '')) && REQ_STATUS[r.status])
      .map((r) => ({ id: String(r.id).toLowerCase(), user_id: String(r.user_id).toLowerCase(), email: typeof r.email === 'string' ? r.email : '', nickname: typeof r.nickname === 'string' ? r.nickname : '',
        plan: typeof r.plan === 'string' ? r.plan : '', status: r.status, message: typeof r.message === 'string' ? r.message : '', created_at: r.created_at || null, decided_at: r.decided_at || null,
        decided_by_email: typeof r.decided_by_email === 'string' ? r.decided_by_email : '', allowed_now: r.allowed_now === true, reason: typeof r.reason === 'string' ? r.reason : '' }));
  }
  // The "new request" notice: {count, newest:[{id, user_id, email, created_at}]}. Unreadable = null (no notice, never a wrong number).
  function parseDeveloperRequestSummary(raw) {
    if (!isObj(raw)) return null; const c = Number(raw.pending_count);
    if (!Number.isInteger(c) || c < 0) return null;
    return { count: c, newest: (Array.isArray(raw.newest) ? raw.newest : []).filter((r) => isObj(r) && UUID_RE.test(String(r.id || ''))).map((r) => ({ id: String(r.id).toLowerCase(),
      user_id: String(r.user_id || ''), email: typeof r.email === 'string' ? r.email : '', created_at: r.created_at || null })) };
  }
  function developerRequestNotice(sum) {
    if (!sum || !sum.count) return null; const n = sum.newest[0]; const who = n && (n.email || n.user_id);
    return { count: sum.count, firstId: n ? n.id : null, text: sum.count === 1 ? 'A Developer Import access request is waiting' + (who ? ' from ' + who : '') + '.'
      : sum.count + ' Developer Import access requests are waiting' + (who ? ' (newest from ' + who + ')' : '') + '.' };
  }
  // Reads the server's answer to a decision. Success only when the server says ok AND returns this very request in the decided state (and, for an approval,
  // confirms the grant). The text never claims the user has access unless the server's own rule says allowed_now === true.
  function interpretDecision(res, decision, requestId) {
    const who = res && res.request && (res.request.email || res.request.user_id) ? (res.request.email || res.request.user_id) : 'the user';
    if (!isObj(res)) return { ok: false, kind: 'err', text: 'The server did not confirm the decision. Reload and check the list.' };
    if (res.code === 'already_decided') return { ok: false, kind: 'info', refresh: true, text: 'This request was already decided' + (res.request && res.request.decided_by_email ? ' by ' + res.request.decided_by_email : '') + '. Nothing was changed.' };
    if (res.code === 'not_found') return { ok: false, kind: 'info', refresh: true, text: 'This request no longer exists. The list was refreshed.' };
    if (res.code === 'personal_off') return { ok: false, kind: 'err', refresh: true, text: who + ' has a personal OFF (an Admin blocked them). Nothing was changed: reset or allow them in "Find a user" below first, or decline the request.' };
    const r = res.request;
    const same = res.ok === true && res.code === decision && isObj(r) && String(r.id || '').toLowerCase() === String(requestId).toLowerCase() && r.status === decision;
    if (!same || (decision === 'approved' && res.granted !== true) || (decision === 'declined' && res.granted === true)) return { ok: false, kind: 'err', text: 'The server did not confirm the decision. Reload and check the list.' };
    if (decision === 'declined') return { ok: true, kind: 'ok', refresh: true, text: 'Request declined. No access was granted.' };
    return res.allowed_now === true ? { ok: true, kind: 'ok', refresh: true, text: 'Approved. ' + who + ' now has Developer Options.' }
      : { ok: true, kind: 'ok', refresh: true, text: 'Approved and saved as a personal ON, but ' + who + ' is NOT allowed right now: ' + developerReason(res.reason).text + '.' };
  }
  function forceUpdateCall(t, version, reason) {                                   // version '' / null = clear
    const errors = []; const v = trim(version); const why = trim(reason);
    if (v) {
      if (!parseVersion(v)) errors.push('Version must look like 1.2.3.');
      const cur = currentRelease(t);
      if (!cur) errors.push('This tool has no current release to update to.');
      else if (parseVersion(v) && compareVersions(v, cur.version) === 1) errors.push('The minimum version (' + v + ') is above the current release (' + cur.version + ').');
      if (!why) errors.push('Give a reason: it is shown to people whose copy is too old.');
      if (why.length > LIMITS.reason) errors.push('Reason is too long (max ' + LIMITS.reason + ' characters).');
    }
    return { ok: errors.length === 0, errors, args: { p_tool_id: t.tool_id, p_min_version: v || null, p_reason: v ? why : null, p_expected_revision: t.revision } };
  }

  // ------------------------------------------------------------------ results / errors
  const isStaleError = (m) => /^stale:/i.test(String(m || '')) || /\bstale:/i.test(String(m || ''));
  const isMissingRpcError = (m) => /could not find the function|PGRST202|function\b[^\n]*\bdoes not exist|in the schema cache|relation "?public\.addon_tools|schema cache/i.test(String(m || ''));
  const isForbiddenError = (m) => /forbidden/i.test(String(m || ''));
  function describeRpcError(m) {
    const s = String(m || '');
    if (isStaleError(s)) return { kind: 'stale', text: 'Someone else changed this tool. The list was reloaded: check it and try again.' };
    if (isMissingRpcError(s)) return { kind: 'missing', text: 'The Addon Tools database functions are not installed on this server (migration 0032 is missing).' };
    if (isForbiddenError(s)) return { kind: 'forbidden', text: 'This account is not an administrator.' };
    return { kind: 'other', text: s || 'The server refused the request.' };
  }
  // The tool object returned by upsert/set_state/set_plan_access/set_current_release/set_force_update confirms the write.
  const confirmedRevision = (res, before) => isObj(res) && typeof res.tool_id === 'string' && Number(res.revision) > Number(before);

  function parseTools(data) {
    if (!Array.isArray(data)) throw new Error('Unexpected answer from admin_addon_tools_list.');
    return data.filter((t) => isObj(t) && typeof t.tool_id === 'string').map((t) => ({
      ...t, releases: Array.isArray(t.releases) ? t.releases : [], user_access: Array.isArray(t.user_access) ? t.user_access : [],
    }));
  }

  // ------------------------------------------------------------------ Edge Function client
  const edgeUrl = (supabaseUrl) => String(supabaseUrl || '').replace(/\/+$/, '') + '/functions/v1/' + EDGE_FUNCTION;
  // deps: { fetch, url, token, anonKey }. The admin's own access token is the ONLY credential; no service key exists in the Admin site.
  // Returns { ok, status, body } and never throws for an HTTP error. A network failure resolves as { ok:false, status:0, body:{ error:{code:'network'} } }.
  async function callEdge(deps, init) {
    const headers = { Authorization: 'Bearer ' + deps.token, apikey: deps.anonKey };
    let res;
    try { res = await deps.fetch(deps.url, { method: 'POST', headers: { ...headers, ...(init.json ? { 'Content-Type': 'application/json' } : {}) }, body: init.json ? JSON.stringify(init.json) : init.form }); }
    catch (_e) { return { ok: false, status: 0, body: { ok: false, error: { code: 'network', message: 'The publishing service could not be reached.' } } }; }
    let body = null; try { body = await res.json(); } catch (_e) { body = null; }
    if (!isObj(body)) body = { ok: false, error: { code: 'bad_response', message: 'The publishing service answered with something unreadable (HTTP ' + res.status + ').' } };
    return { ok: res.ok && body.ok === true, status: res.status, body };
  }
  const edgeJson = (deps, json) => callEdge(deps, { json });
  function publishForm(v, file) { const f = new FormData(); f.append('action', 'publish'); f.append('tool_id', v.tool_id); if (v.notes) f.append('notes', v.notes); f.append('package', file, file.name || 'package.zip'); return f; }
  const publishEdge = (deps, v, file) => callEdge(deps, { form: publishForm(v, file) });

  // Turn any Edge Function answer into something the UI can show without knowing the codes.
  const EDGE_HINTS = {
    signing_not_configured: 'Publishing is not set up yet: the signing secrets are missing on the server (see ADDON_TOOLS_SIGNING.md). Nothing was uploaded.',
    signing_config_invalid: 'The signing secrets on the server are invalid. Nothing was uploaded.',
    invalid_package: 'The package was refused. Fix the problems below and pack it again. Nothing was uploaded.',
    tool_id_mismatch: 'The id inside tool.json is not the tool you selected. Nothing was uploaded.',
    record_invalid: 'The release record could not be built. Nothing was uploaded.',
    package_exists: 'A package for this exact version already exists in storage. Publish a higher version (a stored package is never overwritten).',
    storage_forbidden: 'Storage refused the upload for this account.',
    storage_failed: 'Storage failed. Nothing was registered.', storage_unavailable: 'Storage did not answer. Nothing was registered.', storage_unexpected: 'Storage answered unexpectedly. Check before retrying.',
    register_rejected: 'The database refused the release. The uploaded package is NOT registered.',
    register_failed: 'The database could not register the release. The uploaded package is NOT registered.',
    register_unavailable: 'The database did not answer, so it is not known whether the release was registered. Check Releases before retrying.',
    register_unexpected: 'The database answer was unexpected, so it is not known whether the release was registered. Check Releases before retrying.',
    release_registered: 'This package belongs to a registered release and is never deleted.',
    too_large: 'The package is empty or larger than 50 MB.', length_required: 'The browser did not send a file size. Try again.',
    unauthenticated: 'Your session expired. Reload the page and sign in again.', forbidden: 'This account is not an administrator.', forbidden_origin: 'This Admin site is not allowed to call the publishing service.',
    network: 'The publishing service could not be reached. Nothing is known to have changed: check Releases before retrying.',
    lookup_unavailable: 'The release list could not be read, so nothing was deleted.', lookup_incomplete: 'The release list was incomplete, so nothing was deleted.',
  };
  function describeEdgeFailure(resp) {
    const b = isObj(resp && resp.body) ? resp.body : {}; const e = isObj(b.error) ? b.error : {};
    const code = String(e.code || 'unknown');
    const problems = (Array.isArray(b.problems) ? b.problems : []).filter(isObj).map((p) => ({ code: String(p.code || ''), message: String(p.message || ''), path: p.path ? String(p.path) : '' }));
    const st = isObj(b.storage) ? b.storage : null;
    return {
      code, status: resp ? resp.status : 0,
      title: EDGE_HINTS[code] || (e.message ? String(e.message) : 'The request failed.'),
      detail: e.message && EDGE_HINTS[code] && String(e.message) !== EDGE_HINTS[code] ? String(e.message) : '',
      problems, problemCount: Number(b.problem_count) || problems.length,
      warnings: (Array.isArray(b.warnings) ? b.warnings : []).map(warningText),
      uncertain: b.registration_state === 'uncertain' || code === 'register_unavailable' || code === 'register_unexpected',
      orphan: st && st.uploaded === true && st.registered !== true ? { path: String(st.path || ''), registered: st.registered } : null,
      canRecover: !!(st && st.uploaded === true && st.registered === false && code !== 'register_unavailable' && code !== 'register_unexpected'),
    };
  }
  function warningText(w) { if (typeof w === 'string') return w; if (isObj(w)) return String(w.message || w.code || JSON.stringify(w)).slice(0, 300); return String(w); }
  function describePublishSuccess(resp) {
    const b = resp.body; const r = isObj(b.release) ? b.release : {};
    return { version: String(r.version || ''), tool_id: String(r.tool_id || ''), seq: r.seq, zip_sha256: String(r.zip_sha256 || ''), zip_size: Number(r.zip_size) || 0, key_id: String(r.key_id || ''),
      offered: r.offered === true, files: Number(b.file_count) || 0, warnings: (Array.isArray(b.warnings) ? b.warnings : []).map(warningText), warningCount: Number(b.warning_count) || 0,
      reconciled: b.reconciled === true, note: b.note ? String(b.note) : '',
      metadata: releaseMeta(b.metadata), author: isObj(b.metadata) && typeof b.metadata.author === 'string' ? b.metadata.author : '', metadataKnown: isObj(b.metadata) };
  }
  // ------------------------------------------------------------------ Part 9: signed release metadata + plan switches (display only)
  // Category / tags / icon exist ONLY as values read back from the server (admin_addon_tools_list rows or the publish answer, both derived from the
  // SIGNED manifest). Nothing here builds a request from them: there is no input for them anywhere in the Admin site.
  function releaseMeta(r) {
    const x = isObj(r) ? r : {};
    const tags = Array.isArray(x.tags) ? x.tags.filter((t) => typeof t === 'string' && t).slice(0, 8) : [];
    const category = typeof x.category === 'string' ? x.category : ''; const icon = typeof x.icon === 'string' ? x.icon : '';
    return { category, tags, icon, any: !!(category || tags.length || icon) };
  }
  // Free / Premium availability, one wording everywhere: "Free: On" / "Premium: Off".
  function planStates(t) {
    const x = isObj(t) ? t : {};
    return [{ plan: 'Free', on: x.access_free === true }, { plan: 'Premium', on: x.access_premium === true }].map((p) => ({ ...p, text: p.plan + ': ' + (p.on ? 'On' : 'Off'), cls: p.on ? 'ok' : '' }));
  }
  function planText(t) { return planStates(t).map((p) => p.text).join(' · '); }
  function recoverRequest(toolId, version) { return { action: 'recover_orphan', tool_id: toolId, version }; }
  function describeKeyInfo(resp) {
    if (resp.ok && isObj(resp.body.key)) { const k = resp.body.key; return { ok: true, key_id: String(k.key_id || ''), alg: String(k.alg || ''), fingerprint: String(k.fingerprint || ''), public_key: String(k.public_key || '') }; }
    return { ok: false, ...describeEdgeFailure(resp) };
  }

  // ------------------------------------------------------------------ audit
  const AUDIT_TEXT = {
    tool_create: 'Tool created', tool_edit: 'Tool details edited', tool_publish: 'Tool published', tool_unpublish: 'Tool unpublished', tool_enable: 'Tool enabled', tool_disable: 'Tool disabled',
    release_register: 'Release uploaded', release_set_current: 'Release made current', release_rollback: 'Rolled back', release_revoke: 'Release revoked', release_unrevoke: 'Release restored',
    access_plan: 'Plan access changed', access_user_set: 'User override set', access_user_clear: 'User override removed', force_update_set: 'Force update set', force_update_clear: 'Force update cleared',
    developer_import_set: 'Developer Options: personal setting changed',
    developer_settings_set: 'Developer Options: global / plan settings changed',
    developer_request_decided: 'Developer Options: access request decided',
  };
  function auditLine(a) {
    const d = isObj(a && a.detail) ? a.detail : {}; const bits = [];
    if (a.action === 'access_plan') bits.push('Free ' + (d.was_free ? 'on' : 'off') + ' → ' + (d.free ? 'on' : 'off') + ', Premium ' + (d.was_premium ? 'on' : 'off') + ' → ' + (d.premium ? 'on' : 'off'));
    if (a.action === 'access_user_set') bits.push((d.allowed ? 'allow' : 'deny') + ' user ' + shortId(d.user_id));
    if (a.action === 'access_user_clear') bits.push('user ' + shortId(d.user_id));
    const tri = (v) => (v === true ? 'ON' : v === false ? 'OFF' : 'none');
    const bi = (v) => (v ? 'on' : 'off');
    if (a.action === 'developer_import_set') bits.push('user ' + shortId(d.user_id) + ': ' + tri(d.was_enabled) + ' → ' + tri(d.enabled));
    if (a.action === 'developer_request_decided') bits.push('user ' + shortId(d.user_id) + ': ' + (d.decision === 'approved' ? 'approved' : 'declined') + (d.granted ? ' (personal ON saved)' : '') + ', now ' + (d.allowed_now ? 'allowed' : 'not allowed'));
    if (a.action === 'developer_settings_set') bits.push('global ' + bi(d.was_enabled) + ' → ' + bi(d.enabled) + ', Free ' + bi(d.was_allow_free) + ' → ' + bi(d.allow_free) + ', Premium ' + bi(d.was_allow_premium) + ' → ' + bi(d.allow_premium));
    if (d.from_version) bits.push('from ' + d.from_version);
    if (a.action === 'force_update_set' && d.below) bits.push('minimum ' + d.below);
    if (d.reason) bits.push('reason: ' + d.reason);
    return { text: AUDIT_TEXT[a.action] || String(a.action || ''), extra: bits.join(' · ') };
  }
  const shortId = (s) => (s ? String(s).slice(0, 8) : '');
  function filterAudit(rows, f) {
    const q = trim(f && f.q).toLowerCase(); const act = f && f.action;
    return (rows || []).filter((a) => (!act || a.action === act) && (!q || [a.actor_email, a.tool_id, a.version, a.action, JSON.stringify(a.detail || {})].join(' ').toLowerCase().includes(q)));
  }

  // ------------------------------------------------------------------ display helpers
  function fmtBytes(n) { n = Number(n); if (!isFinite(n)) return '—'; if (n < 1024) return n + ' B'; if (n < 1048576) return (n / 1024).toFixed(1) + ' KB'; return (n / 1048576).toFixed(1) + ' MB'; }
  const shortHash = (h) => (h ? String(h).slice(0, 12) + '…' : '—');
  async function sha256Hex(buf, subtle) { const d = await (subtle || globalThis.crypto.subtle).digest('SHA-256', buf); return Array.from(new Uint8Array(d), (b) => b.toString(16).padStart(2, '0')).join(''); }
  const confirmMatches = (typed, expected) => trim(typed) === String(expected);

  return { TOOL_ID_RE, VERSION_RE, LIMITS, EDGE_FUNCTION, parseVersion, compareVersions, validateToolDraft, upsertCall, validatePublishInput,
    toolStatus, publicationState, accessSummary, publishBlockers, currentRelease, releaseLabels, selectKind, setCurrentCall, revokeCall, stateCall, planCall, userAccessCall, developerImportCall, developerSettingsCall, requestStatus, developerRequestListCall, developerRequestDecisionCall, parseDeveloperRequests, parseDeveloperRequestSummary, developerRequestNotice, interpretDecision, parseDeveloperSettings, developerSettingsSummary, developerReason, developerImportBadge, parseDeveloperStates, parseDeveloperList, forceUpdateCall,
    isStaleError, isMissingRpcError, isForbiddenError, describeRpcError, confirmedRevision, parseTools,
    edgeUrl, callEdge, edgeJson, publishEdge, publishForm, describeEdgeFailure, describePublishSuccess, releaseMeta, planStates, planText, recoverRequest, describeKeyInfo, warningText,
    auditLine, filterAudit, fmtBytes, shortHash, sha256Hex, confirmMatches };
});
