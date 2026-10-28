/* MetaZone Admin -- pure add-on release logic (no DOM, no network). Loaded by index.html as window.MZ_ADDON and by the node unit
   test (test/addon_logic.test.js) via require(). Everything here mirrors what admin_publish_addon() enforces on the server (0012_addons.sql);
   the server stays the authority -- this only lets the panel refuse a bad release BEFORE anything is uploaded. */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.MZ_ADDON = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  'use strict';
  const RE_ID = /^[a-z0-9_]{1,32}$/;
  const RE_VERSION = /^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]{1,24})?$/;
  const RE_CHANNEL = /^[a-z0-9_]{1,16}$/;
  const RE_SHA = /^[0-9a-f]{64}$/;
  const RE_CORE = /^v?[0-9]{1,9}(\.[0-9]{1,9}){0,5}$/i;
  const NOTE_SECTIONS = ['pages', 'problems', 'fixes'];

  const isInt = (n) => typeof n === 'number' && Number.isInteger(n);
  const storagePathFor = (id, version) => `${id}/${version}/${id}-${version}.mzaddon`;

  // 'v0.9.9.10' -> [0,9,9,10,0,0]; anything else -> null.  Numeric, so 0.9.9.10 > 0.9.9.9.
  function parseCore(s) {
    const t = String(s == null ? '' : s).trim().toLowerCase().replace(/^v/, '').split('-')[0].split('+')[0];
    if (!/^[0-9]{1,9}(\.[0-9]{1,9}){0,5}$/.test(t)) return null;
    const parts = t.split('.').map(Number); while (parts.length < 6) parts.push(0); return parts;
  }
  function cmpCore(a, b) { for (let i = 0; i < 6; i++) if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1; return 0; }

  // Text of release.json -> {ok, errors, release}. `known` (optional) = {featureKeys:Set} to also check the feature exists.
  function parseSidecar(text, known) {
    let obj;
    try { obj = JSON.parse(String(text).replace(/^﻿/, '')); }
    catch (e) { return { ok: false, errors: ['release.json is not valid JSON: ' + e.message], release: null }; }
    return validateSidecar(obj, known);
  }

  function validateSidecar(o, known) {
    const errors = [];
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { ok: false, errors: ['release.json must be a JSON object'], release: null };
    const str = (k) => (typeof o[k] === 'string' ? o[k].trim() : '');
    if (!RE_ID.test(o.addon_id || '')) errors.push('addon_id must be 1-32 characters: a-z, 0-9, underscore');
    if (!RE_VERSION.test(o.version || '')) errors.push('version must look like 1.2.3 (2 to 4 numeric parts, optional -suffix)');
    if (!isInt(o.seq) || o.seq < 1 || o.seq > 2000000000) errors.push('seq must be a whole number >= 1');
    const channel = o.channel == null || o.channel === '' ? 'stable' : o.channel;
    if (typeof channel !== 'string' || !RE_CHANNEL.test(channel)) errors.push('channel must be a-z, 0-9, underscore (default "stable")');
    if (!isInt(o.size) || o.size < 1) errors.push('size must be a whole number of bytes > 0');
    const sha = typeof o.sha256 === 'string' ? o.sha256.trim().toLowerCase() : '';
    if (!RE_SHA.test(sha)) errors.push('sha256 must be 64 hex characters');
    if (!/^[a-z0-9_]{1,32}$/.test(o.feature_key || '')) errors.push('feature_key is missing or invalid');
    else if (known && known.featureKeys && !known.featureKeys.has(o.feature_key)) errors.push(`feature_key "${o.feature_key}" is not a known page/add-on key on this server`);
    const title = str('title');
    if (!title || title.length > 80) errors.push('title is required (max 80 characters)');
    const summary = str('summary');
    if (summary.length > 400) errors.push('summary is too long (max 400 characters)');
    const core = (k) => { const v = o[k]; if (v == null || v === '') return null; if (typeof v !== 'string' || !RE_CORE.test(v.trim()) || !parseCore(v)) { errors.push(`${k} is not a version like 0.9.9.10`); return null; } return v.trim(); };
    const min_core = core('min_core'), max_core = core('max_core');
    if (min_core && max_core && cmpCore(parseCore(min_core), parseCore(max_core)) > 0) errors.push('min_core is newer than max_core');
    const notes = {};
    const rawNotes = o.notes == null ? {} : o.notes;
    if (typeof rawNotes !== 'object' || Array.isArray(rawNotes)) errors.push('notes must be an object {pages, problems, fixes}');
    else for (const [k, v] of Object.entries(rawNotes)) {
      if (!NOTE_SECTIONS.includes(k)) { errors.push(`notes.${k} is not allowed (only pages, problems, fixes)`); continue; }
      if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== 'string' || x.length > 400)) { errors.push(`notes.${k} must be a list of up to 50 text lines (max 400 characters each)`); continue; }
      notes[k] = v;
    }
    if (errors.length) return { ok: false, errors, release: null };
    return { ok: true, errors: [], release: {
      addon_id: o.addon_id, version: o.version, seq: o.seq, channel, size: o.size, sha256: sha, feature_key: o.feature_key,
      title, summary, min_core, max_core, notes, storage_path: storagePathFor(o.addon_id, o.version) } };
  }

  // The package the admin picked must be exactly what the sidecar describes.
  function checkPackage(release, pkg) {      // pkg = {name, size, sha256, head: first 4 bytes as array/Uint8Array}
    const errors = [];
    if (!/\.mzaddon$/i.test(pkg.name || '')) errors.push('The package file must end in .mzaddon');
    const h = Array.from(pkg.head || []);
    if (!(h[0] === 0x50 && h[1] === 0x4b && (h[2] === 0x03 || h[2] === 0x05) && (h[3] === 0x04 || h[3] === 0x06))) errors.push('The package is not a ZIP file (missing the PK header)');
    if (pkg.size !== release.size) errors.push(`Size differs: the package is ${pkg.size} bytes, release.json says ${release.size}`);
    if (pkg.sha256 !== release.sha256) errors.push(`SHA-256 differs: the package is ${pkg.sha256}, release.json says ${release.sha256}`);
    return errors;
  }

  // Against what is already published (list from admin_list_addon_releases). Server re-checks; this avoids an upload that cannot succeed.
  function conflictsWith(release, existing) {
    const errors = []; let maxSeq = 0;
    for (const r of existing || []) {
      if (r.addon_id !== release.addon_id) continue;
      if (r.version === release.version) errors.push(`${release.addon_id} ${release.version} is already published. Published releases are immutable: publish a new version with a higher seq.`);
      if (r.seq > maxSeq) maxSeq = r.seq;
    }
    if (maxSeq && release.seq <= maxSeq) errors.push(`seq ${release.seq} is not higher than the latest published seq (${maxSeq}) for ${release.addon_id}`);
    return errors;
  }

  async function sha256Hex(buffer, subtle) {
    if (!subtle || typeof subtle.digest !== 'function') throw new Error('This browser cannot compute SHA-256 here (needs https or localhost).');
    return Array.from(new Uint8Array(await subtle.digest('SHA-256', buffer)), (b) => b.toString(16).padStart(2, '0')).join('');
  }

  const fmtBytes = (n) => { if (n == null) return '—'; n = Number(n); if (n < 1024) return n + ' B'; const u = ['KB', 'MB', 'GB']; let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < 2); return n.toFixed(n >= 100 ? 0 : 1) + ' ' + u[i]; };
  const shortHash = (s) => (s ? String(s).slice(0, 10) + '…' : '—');

  // Notes -> [[heading, [lines]]] for non-empty sections, in fixed order.
  const NOTE_TITLES = { pages: 'Pages', problems: 'Known problems', fixes: 'Fixes' };
  function noteSections(notes) {
    const n = notes && typeof notes === 'object' ? notes : {};
    return NOTE_SECTIONS.filter((k) => Array.isArray(n[k]) && n[k].length).map((k) => [NOTE_TITLES[k], n[k].map(String)]);
  }

  // admin_list_pages / admin_get_user_pages rows -> {pages, addons}. 'settings' (the API Manager) is never shown; a row with no kind (older server) is a page.
  function groupPages(list) {
    const out = { pages: [], addons: [] };
    for (const p of list || []) { if (p.page_key === 'settings') continue; (p.kind === 'addon' ? out.addons : out.pages).push(p); }
    return out;
  }

  // ---- Task 2 (0013) ----
  const PROTECTED_PAGES = ['dashboard', 'appearance', 'settings'];     // Home + Settings (+ its API manager): the server refuses to switch these off
  const isProtectedPage = (key) => PROTECTED_PAGES.includes(key);

  // Why a release cannot be made active right now (null = it can). Mirrors _addon_block_reason(); the server is the authority.
  function activateBlock(r) {
    if (!r) return 'unknown release';
    if (r.yanked) return 'yanked: restore it first (restoring does not activate it)';
    if (r.block_reason) return r.block_reason;
    if (r.selectable === false) return 'not selectable';
    return null;
  }

  // admin_get_addon_selection row -> {label, kind, version, warn}. kind: pinned | auto | withdrawn | none
  function describeSelection(sel) {
    const mode = (sel && sel.mode) || 'none';
    if (mode === 'pinned') return { kind: 'pinned', version: sel.active_version, label: `v${sel.active_version} (chosen by you)`, warn: null };
    if (mode === 'auto') return { kind: 'auto', version: sel.effective_version || null, label: sel.effective_version ? `Automatic: newest = v${sel.effective_version}` : 'Automatic: nothing eligible', warn: sel.effective_version ? null : 'No release is eligible, so users are offered nothing.' };
    if (mode === 'withdrawn') return { kind: 'withdrawn', version: null, label: 'Withdrawn: users are offered nothing', warn: 'The active release was yanked. Choose a release to make active again.' };
    return { kind: 'none', version: null, label: 'Not set: users are offered nothing', warn: 'Choose a release to make active.' };
  }

  const selectionFor = (selections, addonId) => (selections || []).find((s) => s.addon_id === addonId) || null;

  // ---- Step 2.1 (0014): read-only Add-on manager list ----
  // True when an RPC error means "this function does not exist on the server" (migration not applied), not "the call failed".
  // PostgREST: "Could not find the function public.X without parameters in the schema cache" (PGRST202); Postgres: "function public.X() does not exist" (42883).
  function isMissingRpcError(message, fn) {
    const m = String(message == null ? '' : message);
    if (fn && !m.includes(fn)) return false;
    return /PGRST202|could not find the function|function [^\n]* does not exist/i.test(m);
  }

  // One row of admin_list_addons() -> what the manager list shows. Never throws; a malformed row still renders with safe defaults.
  function describeManagedAddon(row) {
    const r = row && typeof row === 'object' && !Array.isArray(row) ? row : {};
    const count = (v) => { const n = Number(v); return Number.isInteger(n) && n >= 0 ? n : 0; };
    const text = (v) => (typeof v === 'string' ? v : '');
    const total = count(r.release_count);
    const offered = total === 0
      ? { kind: 'none', version: null, label: 'No releases: nothing offered', warn: null }
      : describeSelection({ mode: r.mode, active_version: r.active_version, effective_version: r.effective_version });
    const id = text(r.addon_id);
    return {
      id, name: text(r.name).trim() || id, description: text(r.description).trim(),
      registered: r.registered === true, featureKey: text(r.feature_key) || null,
      releases: { total, yanked: count(r.yanked_count), deleted: count(r.deleted_count) },
      latestVersion: text(r.latest_version) || null, offered,
      createdAt: r.created_at || null, updatedAt: r.updated_at || null,
    };
  }

  // admin_list_addons() result -> list of view models (anything that is not an array, or an entry without an id, is dropped).
  function describeManagedAddons(data) {
    return (Array.isArray(data) ? data : []).map(describeManagedAddon).filter((a) => a.id);
  }

  // {total, offered, notOffered}: "offered" = users are offered a concrete version right now.
  function summarizeManagedAddons(list) {
    const l = Array.isArray(list) ? list : [];
    const offered = l.filter((a) => a && a.offered && a.offered.version).length;
    return { total: l.length, offered, notOffered: l.length - offered };
  }

  // ---- Step 2.2 (0014): create / edit add-on metadata via admin_upsert_addon(p_addon, p_name, p_description) ----
  // These mirror the checks INSIDE the real function (0014_addon_manager.sql); the server stays the authority and re-checks everything:
  //   id          ~ '^[a-z0-9_]{1,32}$'            -> 'invalid add-on id (a-z, 0-9, underscore, max 32)'
  //   name        btrim(name) not empty, <= 80      -> 'name is required (max 80 characters)'
  //   description btrim(description) <= 400         -> 'description too long (max 400 characters)'
  // IMPORTANT: admin_upsert_addon is an UPSERT (insert ... on conflict (addon_id) do update). The database does NOT reject an id that already
  // exists: it silently overwrites that record. "No duplicate ids" therefore has to be enforced HERE, before the call (checkAddonDraft + a fresh
  // re-read of admin_list_addons() right before saving, done in admin.js). The server's length counts are in characters (code points), so are these.
  const ADDON_ID_RE = /^[a-z0-9_]{1,32}$/;
  const ADDON_LIMITS = { id: 32, name: 80, description: 400 };
  const cpLen = (s) => Array.from(s).length;

  function validateAddonId(v) {
    const id = String(v == null ? '' : v).trim();
    if (!id) return 'Enter an add-on id.';
    if (!ADDON_ID_RE.test(id)) return 'Invalid id: use only lowercase letters a-z, digits 0-9 and underscore, 1 to 32 characters.';
    return null;
  }
  function validateAddonName(v) {
    const n = String(v == null ? '' : v).trim();
    if (!n) return 'Enter a name.';
    if (cpLen(n) > ADDON_LIMITS.name) return `The name is too long (${cpLen(n)} characters, maximum ${ADDON_LIMITS.name}).`;
    return null;
  }
  function validateAddonDescription(v) {
    const d = String(v == null ? '' : v).trim();
    if (cpLen(d) > ADDON_LIMITS.description) return `The description is too long (${cpLen(d)} characters, maximum ${ADDON_LIMITS.description}).`;
    return null;
  }

  // Full check of a form draft against the list the page last read (view models from describeManagedAddons).
  //   mode 'create': id must be valid AND not already in the list (registered, or known only through releases).
  //   mode 'edit'  : the id is fixed; it must still be in the list; saving with no change to a registered add-on is refused.
  // Returns { ok, errors: {id, name, description, form}, params } where params are the exact arguments for admin_upsert_addon.
  function checkAddonDraft(draft, mode, list) {
    const d = draft && typeof draft === 'object' ? draft : {};
    const known = Array.isArray(list) ? list : [];
    const id = String(d.id == null ? '' : d.id).trim(), name = String(d.name == null ? '' : d.name).trim(), description = String(d.description == null ? '' : d.description).trim();
    const errors = { id: null, name: validateAddonName(name), description: validateAddonDescription(description), form: null };
    const existing = known.find((a) => a && a.id === id) || null;
    if (mode === 'edit') {
      if (!existing) errors.id = id ? `${id} no longer exists. Close this window and refresh the list.` : 'Missing add-on id.';
      else if (!errors.name && !errors.description && existing.registered && existing.name === name && existing.description === description) errors.form = 'Nothing was changed.';
    } else {
      errors.id = validateAddonId(id);
      if (!errors.id && existing) errors.id = existing.registered
        ? `${id} already exists. Use Edit on that add-on instead of creating it again (saving would overwrite it).`
        : `${id} already has releases but no name/description record yet. Use Edit on that add-on to add one.`;
    }
    const ok = !errors.id && !errors.name && !errors.description && !errors.form;
    return { ok, errors, params: ok ? { p_addon: id, p_name: name, p_description: description } : null };
  }

  // The RPC returns the saved registry row as jsonb. Only treat the save as successful when it really is the row we asked for.
  function savedRowMatches(data, id) { return !!data && typeof data === 'object' && !Array.isArray(data) && data.addon_id === id; }

  // ---- Step 2.3: version history + release selection ----
  // Pure view model for ONE add-on. Inputs are the REAL server lists, nothing is invented:
  //   releases    = admin_list_addon_releases()  (is_active = "this is the version users are offered now", yanked, block_reason, ...)
  //   selections  = admin_get_addon_selection()  (mode pinned|auto|withdrawn|none, active_version, previous_version, revision, effective_version)
  //   managed     = the admin_list_addons() view model of this add-on (describeManagedAddon) or null (0014 not applied)
  // Words used on screen:  Active = a version an admin chose (mode 'pinned');  Offered = the version users really get right now
  // (can be an automatic choice, or nothing even though one is "active", e.g. it no longer fits the app);  Yanked = a release users cannot
  // download and running apps stop;  Withdrawn = the ADD-ON is deactivated (mode 'withdrawn'): users are offered nothing. Withdrawn is a state
  // of the add-on, not of a single release; the server uses it both for "Deactivate" and when the active release is yanked.
  const isStaleError = (message) => /(^|\W)stale:/i.test(String(message == null ? '' : message));

  // ---- Step 2.4: package download + replace ----
  // Mirrors admin_replace_addon_release() (0014 section G): refused for the PINNED active version and for the version users are offered right
  // now (is_active = _addon_effective_version). Yanked releases may be replaced and stay yanked. The server re-checks under a lock.
  function replaceBlock(s) {
    if (s.mode === 'unknown') return 'The selection state could not be read, so it is not known whether this version is in use.';
    if (s.chosen) return 'This is the ACTIVE version. It cannot be replaced: publish a new version instead.';
    if (s.offered) return 'Users are offered this version right now. It cannot be replaced: publish a new version instead.';
    return null;
  }
  // The SAME rule on fresh data (release row from admin_list_addon_releases + selection row from admin_get_addon_selection).
  function replaceEligibility(release, selection) {
    if (!release) return 'This release no longer exists.';
    if (!selection) return 'The selection state could not be read, so it is not known whether this version is in use.';
    return replaceBlock({ mode: selection.mode || 'none', chosen: selection.mode === 'pinned' && selection.active_version === release.version, offered: release.is_active === true });
  }
  const sameCore = (a, b) => { if (!a && !b) return true; if (!a || !b) return false; const x = parseCore(a), y = parseCore(b); return !!x && !!y && cmpCore(x, y) === 0; };
  // New package + its release.json against the release that is being replaced. The RPC only writes size + sha256: everything else stays as it is,
  // so anything that would DIFFER from the stored release is an error (it would not be applied and the files would disagree with the database).
  // Title / summary only describe the release: a difference is a warning. Returns {errors, warnings}.
  function checkReplacement(current, sidecar, pkg) {
    const errors = [], warnings = [];
    if (!current) return { errors: ['This release no longer exists.'], warnings };
    if (!sidecar) return { errors: ['release.json is missing or invalid.'], warnings };
    if (sidecar.addon_id !== current.addon_id) errors.push(`release.json is for add-on ${sidecar.addon_id}, not ${current.addon_id}`);
    if (sidecar.version !== current.version) errors.push(`release.json is for version ${sidecar.version}, not ${current.version}`);
    if (sidecar.seq !== current.seq) errors.push(`seq in release.json (${sidecar.seq}) differs from this release (${current.seq}); a replacement cannot change it`);
    if (sidecar.feature_key !== current.feature_key) errors.push(`feature_key in release.json (${sidecar.feature_key}) differs from this release (${current.feature_key})`);
    if ((sidecar.channel || 'stable') !== (current.channel || 'stable')) errors.push(`channel in release.json (${sidecar.channel}) differs from this release (${current.channel || 'stable'})`);
    if (!sameCore(sidecar.min_core, current.min_core)) errors.push(`min_core in release.json (${sidecar.min_core || 'any'}) differs from this release (${current.min_core || 'any'}); a replacement cannot change it`);
    if (!sameCore(sidecar.max_core, current.max_core)) errors.push(`max_core in release.json (${sidecar.max_core || 'any'}) differs from this release (${current.max_core || 'any'}); a replacement cannot change it`);
    if (sidecar.title !== current.title) warnings.push('title in release.json differs from the stored release; the stored title is kept');
    if ((sidecar.summary || '') !== (current.summary || '')) warnings.push('summary in release.json differs from the stored release; the stored summary is kept');
    for (const e of checkPackage(sidecar, pkg)) errors.push(e);                    // .mzaddon name, ZIP header, size + SHA-256 equal to release.json
    if (pkg && current.sha256 && pkg.sha256 === current.sha256) errors.push('This package is identical to the one already stored (same SHA-256): there is nothing to replace');
    return { errors, warnings };
  }
  // Exact RPC for the database step. `expected_sha256` = the hash the admin saw: the server refuses with "stale: ..." when it changed.
  const replaceCall = (current, pkg) => ({ fn: 'admin_replace_addon_release', params: { p: { addon_id: current.addon_id, version: current.version, size: pkg.size, sha256: pkg.sha256, expected_sha256: current.sha256 || null } } });
  // The RPC returns to_jsonb(addon_releases row): only believe the save when it is the row + values we sent.
  function savedReplaceMatches(data, call) {
    const p = call.params.p;
    return !!data && typeof data === 'object' && !Array.isArray(data) && data.addon_id === p.addon_id && data.version === p.version
      && data.sha256 === p.sha256 && Number(data.size_bytes) === p.size;
  }
  // What kind of refusal is this? (texts from 0014 section G and PostgREST)
  function classifyReplaceError(message, fn) {
    const m = String(message == null ? '' : message);
    if (isMissingRpcError(m, fn || 'admin_replace_addon_release')) return 'missing';
    if (isStaleError(m)) return 'stale';
    if (/it is the ACTIVE version|offered it right now|offered right now/i.test(m)) return 'in_use';
    if (/not found in Storage|size in Storage/i.test(m)) return 'storage';
    return 'other';
  }
  const packageFileName = (id, version) => `${id}-${version}.mzaddon`;

  // ---- Step 2.5: delete one release / a whole add-on + Storage clean-up ----
  // Mirrors admin_delete_addon_release(p_addon, p_version, p_expected_revision) and admin_delete_addon(p_addon, p_confirm) (0014 section F).
  // The server stays the authority. admin_delete_addon_release refuses the PINNED active version and the version users are offered right now;
  // since Step 2.7 admin_delete_addon refuses a whole add-on while it is offered too (0014 section F): the Admin site disables Delete and says
  // why, but a stale list, a second tab or a direct call is stopped by the server, and its message is explained by addonDeleteRefusalText.
  // Database first: the functions return the Storage path(s); the files are removed afterwards with the admin's session.
  function deleteBlock(s) {
    if (s.mode === 'unknown') return 'The selection state could not be read, so it is not known whether this version is in use.';
    if (s.chosen) return 'This is the ACTIVE version. It cannot be deleted: make another version active, or deactivate the add-on, first.';
    if (s.offered) return 'Users are offered this version right now (automatic mode). It cannot be deleted: choose another version or deactivate the add-on first.';
    return null;
  }
  function deleteEligibility(release, selection) {                 // the SAME rule on fresh data
    if (!release) return 'This release no longer exists.';
    if (!selection) return 'The selection state could not be read, so it is not known whether this version is in use.';
    return deleteBlock({ mode: selection.mode || 'none', chosen: selection.mode === 'pinned' && selection.active_version === release.version, offered: release.is_active === true });
  }
  // Whole-add-on delete: the UI's own view of "offered" (admin_list_addons effective_version / release is_active). The server's rule is wider
  // (see 0014): any non-yanked stable release of a non-withdrawn selection counts, so the server can still refuse when this returns null.
  function deleteAddonBlock(offeredVersion) {
    if (typeof offeredVersion !== 'string' || offeredVersion === '') return null;
    return `Users are offered version ${offeredVersion} right now. The server refuses to delete an add-on while it is offered: open Versions, press Deactivate (nothing is yanked or deleted), then delete it.`;
  }
  // The server refused admin_delete_addon because the add-on is offered (class 'in_use'): the server text plus what to do next.
  function addonDeleteRefusalText(message) {
    const m = String(message == null ? '' : message).trim();
    return `Nothing was deleted: the server refuses to delete an add-on while users are offered it. ${m} To stop offering it: close this window, open Versions for this add-on and press Deactivate (nothing is yanked or deleted; installed copies on PCs are untouched), reload, then delete it. Nothing in Storage was touched.`;
  }
  const deleteReleaseCall = (addon, version, revision) => ({ fn: 'admin_delete_addon_release', params: { p_addon: addon, p_version: version, p_expected_revision: revision == null ? null : revision } });
  // p_confirm is the text the admin TYPED (not the id), so the server really performs its own comparison.
  const deleteAddonCall = (addon, typed) => ({ fn: 'admin_delete_addon', params: { p_addon: addon, p_confirm: typed } });
  const confirmMatches = (typed, expected) => typeof typed === 'string' && typeof expected === 'string' && expected !== '' && typed === expected;   // exact: no trimming, no case folding
  const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
  const safeName = (id, version) => typeof id === 'string' && ADDON_ID_RE.test(id) && typeof version === 'string' && RE_VERSION.test(version);
  // A Storage path returned by the server is only removed when it is exactly the path the server itself enforces for that release
  // (<id>/<version>/<id>-<version>.mzaddon, 0012). Anything else is reported and NOT passed to Storage.
  const isReleasePath = (path, id, version) => safeName(id, version) && path === storagePathFor(id, version);
  function isAddonPath(path, id) {
    if (typeof path !== 'string' || typeof id !== 'string' || !ADDON_ID_RE.test(id)) return false;
    const parts = path.split('/'); if (parts.length !== 3 || parts[0] !== id) return false;
    return safeName(id, parts[1]) && parts[2] === `${id}-${parts[1]}.mzaddon`;
  }
  // admin_delete_addon_release returns {addon_id, version, storage_path, was_yanked, revocation_kept}. ok = the server confirmed THIS deletion.
  function parseDeleteReleaseResult(data, id, version) {
    if (!isObj(data) || data.addon_id !== id || data.version !== version) return { ok: false, path: null, rejected: null, wasYanked: null, revocationKept: null };
    const sp = data.storage_path, has = sp !== null && sp !== undefined && sp !== '';
    const good = has && isReleasePath(sp, id, version);
    return { ok: true, path: good ? sp : null, rejected: has && !good ? String(sp) : null, wasYanked: data.was_yanked === true, revocationKept: data.revocation_kept === true };
  }
  // admin_delete_addon returns {addon_id, storage_paths: [...], releases_deleted, revocations_kept}.
  function parseDeleteAddonResult(data, id) {
    if (!isObj(data) || data.addon_id !== id || !Array.isArray(data.storage_paths)) return { ok: false, paths: [], rejected: [], releasesDeleted: null, revocationsKept: null };
    const paths = [], rejected = [];
    for (const p of data.storage_paths) { if (isAddonPath(p, id)) { if (!paths.includes(p)) paths.push(p); } else rejected.push(String(p)); }
    const n = (v) => (Number.isInteger(v) && v >= 0 ? v : null);
    return { ok: true, paths, rejected, releasesDeleted: n(data.releases_deleted), revocationsKept: n(data.revocations_kept) };
  }
  // What kind of refusal is this? (texts from 0014 section F and PostgREST)
  function classifyDeleteError(message, fn) {
    const m = String(message == null ? '' : message);
    if (isMissingRpcError(m, fn || 'admin_delete_addon_release')) return 'missing';
    if (isStaleError(m)) return 'stale';
    if (/it is the ACTIVE version|offered right now|users are being offered/i.test(m)) return 'in_use';
    if (/confirmation text does not match/i.test(m)) return 'confirm';
    if (/unknown release|unknown add-on/i.test(m)) return 'unknown';
    return 'other';
  }
  // Storage remove() returns the objects it really deleted (objects it could not delete, e.g. refused by a policy, are simply missing from
  // the list, without an error). Split the requested paths into reported-as-removed and not-reported; the caller verifies the second group.
  function splitRemoved(paths, removed) {
    const got = new Set((Array.isArray(removed) ? removed : []).map((o) => (o && typeof o === 'object' ? o.name : o)).filter((x) => typeof x === 'string'));
    return { removed: paths.filter((p) => got.has(p)), notReported: paths.filter((p) => !got.has(p)) };
  }
  // Impact summary for the "delete add-on" window, from the releases of that add-on (admin_list_addon_releases rows).
  function addonDeleteImpact(rels) {
    const l = (Array.isArray(rels) ? rels : []);
    const yanked = l.filter((r) => r.yanked === true).length, offered = l.find((r) => r.is_active === true) || null;
    return { total: l.length, yanked, notYanked: l.length - yanked, offeredVersion: offered ? offered.version : null, versions: l.map((r) => r.version).sort() };
  }

  function describeVersionHistory(addonId, releases, selections, managed) {
    const list = (Array.isArray(releases) ? releases : []).filter((r) => r && r.addon_id === addonId)
      .slice().sort((a, b) => (Number(b.seq) || 0) - (Number(a.seq) || 0));
    const sel = selectionFor(Array.isArray(selections) ? selections : [], addonId);
    const mode = sel ? (sel.mode || 'none') : 'unknown';
    const activeV = (sel && sel.active_version) || null, prevV = (sel && sel.previous_version) || null;
    const offeredRow = list.find((r) => r.is_active === true) || null;
    const offeredV = (offeredRow && offeredRow.version) || (sel && sel.effective_version) || null;

    const rows = list.map((r) => {
      const yanked = r.yanked === true, offered = r.is_active === true;
      const chosen = mode === 'pinned' && activeV === r.version, previous = prevV === r.version;
      const block = activateBlock(r), badges = [];
      if (chosen && offered) badges.push({ kind: 'ok', label: 'Active', title: 'Chosen by an admin' });
      else if (chosen) badges.push({ kind: 'warn', label: 'Active, not offered', title: block || 'Chosen by an admin, but users are not offered it right now' });
      if (offered) badges.push({ kind: 'ok', label: !chosen && mode === 'auto' ? 'Offered (automatic)' : 'Offered', title: 'This is the version users are offered right now' });
      if (yanked) badges.push({ kind: 'warn', label: 'Yanked', title: 'Users cannot download it and apps running it stop it' });
      if (previous && !chosen) badges.push({ kind: 'plain', label: mode === 'withdrawn' ? 'Active before withdrawal' : 'Previous selection',
        title: sel && sel.previous_block_reason ? 'Cannot be restored: ' + sel.previous_block_reason : 'Restore previous selection goes back to this version' });
      if (!badges.length) badges.push({ kind: 'plain', label: 'Published', title: 'Published, not offered' });
      return {
        version: r.version, seq: r.seq, channel: r.channel || 'stable', size: r.size == null ? null : r.size, sha256: r.sha256 || null,
        publishedAt: r.published_at || null, minCore: r.min_core || null, maxCore: r.max_core || null, featureKey: r.feature_key || null,
        title: r.title || '', summary: r.summary || '', notes: noteSections(r.notes),
        yanked, offered, chosen, previous, badges,
        note: !yanked && block ? 'Cannot be made active: ' + block : null,
        activate: { show: !chosen, block },                       // block = null -> allowed (the server re-checks); same rule as the existing table
        canYank: !yanked, canRestore: yanked,
        storagePath: r.storage_path || null,                      // Step 2.4: download needs it
        replace: { block: replaceBlock({ chosen, offered, mode }) },   // Step 2.4: null -> the Replace button is enabled (the server re-checks)
        del: { block: deleteBlock({ chosen, offered, mode }) },          // Step 2.5: null -> the Delete button is enabled (the server re-checks)
      };
    });

    let state;
    if (mode === 'unknown') state = { kind: 'unknown', label: 'Selection state not available', note: null, warn: 'The selection state could not be read from the server, so selection controls are hidden.' };
    else if (mode === 'pinned') {
      const ar = rows.find((x) => x.version === activeV), why = ar && ar.note ? ar.note.replace(/^Cannot be made active: /, '') : 'it is not available';
      state = activeV && activeV === offeredV
        ? { kind: 'pinned', label: `Active: v${activeV}`, note: 'Chosen by an admin and offered to users.', warn: null }
        : { kind: 'pinned', label: `Active: v${activeV} (not offered)`, note: null, warn: `Chosen by an admin, but users are NOT offered it: ${why}.` };
    } else if (mode === 'auto') {
      state = offeredV ? { kind: 'auto', label: `Automatic: v${offeredV}`, note: 'Users are offered the newest eligible release.', warn: null }
                       : { kind: 'auto', label: 'Automatic: nothing eligible', note: null, warn: 'No release is eligible, so users are offered nothing.' };
    } else if (mode === 'withdrawn') {
      state = { kind: 'withdrawn', label: 'Withdrawn', note: prevV ? `Previous selection: v${prevV}.` : null,
        warn: 'Deactivated: users are offered nothing. An add-on is withdrawn when an admin deactivates it, or when its active release is yanked. Nothing is deleted.' };
    } else state = { kind: 'none', label: 'Not set', note: null, warn: 'No version has been chosen yet, so users are offered nothing.' };
    state.mode = mode; state.offeredVersion = offeredV; state.activeVersion = activeV; state.previousVersion = prevV;
    state.revision = sel ? sel.revision : null;                  // the p_expected_revision the existing controls send
    state.updatedAt = (sel && sel.updated_at) || null; state.updatedBy = (sel && sel.updated_by_email) || null;

    const eligible = list.some((r) => !activateBlock(r));
    const controls = {
      auto: sel && mode !== 'auto' ? { show: true, block: eligible ? null : 'No release can be offered yet, so Automatic would offer nothing.' } : { show: false, block: null },
      restorePrevious: sel && prevV ? { show: true, version: prevV, block: sel.previous_block_reason || null } : { show: false, version: null, block: null },
      withdraw: !sel ? { show: false, block: null }
        : mode === 'withdrawn' ? { show: true, block: 'Already deactivated: users are offered nothing.' }
        : mode === 'none' ? { show: true, block: 'No version has been chosen yet, so there is nothing to deactivate.' }
        : { show: true, block: null },
    };
    const m = managed && typeof managed === 'object' && managed.releases && typeof managed.releases === 'object' ? managed : null;     // a describeManagedAddon view model
    return {
      addonId, name: (m && m.name) || (list[0] && list[0].title) || addonId, description: m ? m.description : '',
      registered: m ? m.registered : null, featureKey: (list[0] && list[0].feature_key) || (m && m.featureKey) || null,
      counts: { total: rows.length, yanked: rows.filter((x) => x.yanked).length, offered: rows.filter((x) => x.offered).length, deleted: m ? m.releases.deleted : null },
      state, controls, rows,
    };
  }

  // The exact RPC + arguments for every selection action (names and parameter names as defined in 0013 / 0012 / 0014). `revision` is the
  // value read from admin_get_addon_selection; the server compares it with the current one and refuses with "stale: ..." when it differs.
  // Step 8: admin_yank_addon takes an OPTIONAL p_expected_revision (0017). It is sent only when the revision is known, so the call is also valid
  // for an add-on without a selection row yet (the server then does not check).
  const rev = (r) => (r == null ? null : r);
  const selectionCall = {
    activate: (addon, version, r) => ({ fn: 'admin_set_addon_active', params: { p_addon: addon, p_version: version, p_expected_revision: rev(r) } }),
    auto: (addon, r) => ({ fn: 'admin_clear_addon_active', params: { p_addon: addon, p_expected_revision: rev(r) } }),
    restorePrevious: (addon, r) => ({ fn: 'admin_restore_previous_addon_active', params: { p_addon: addon, p_expected_revision: rev(r) } }),
    withdraw: (addon, r) => ({ fn: 'admin_withdraw_addon', params: { p_addon: addon, p_expected_revision: rev(r) } }),   // 0014
    yank: (addon, version, yank, r) => ({ fn: 'admin_yank_addon', params: Object.assign({ p_addon: addon, p_version: version, p_yank: !!yank }, r == null ? {} : { p_expected_revision: r }) }),
  };

  // ---- Step 4.3A: Dashboard Shortcuts list rules (mirror _dashboard_shortcuts_problem() in 0015; the SERVER stays the authority).
  // Pure: no DOM, no network. The order of the checks matches the server's.
  const SHORTCUT_MAX = 9;
  const SHORTCUT_REQUIRED = ['dashboard', 'appearance'];                       // Home + Settings: always included, cannot be removed
  const SHORTCUT_DEFAULT = ['dashboard', 'meta', 'embed', 'p2p', 'automation', 'appearance'];   // same as the 0015 seed / reader fallback
  // admin_list_pages() rows -> the pages a shortcut may point at: kind 'page' only, never the 'settings' alias, each key once.
  function supportedShortcutPages(list) {
    const seen = new Set(), out = [];
    for (const p of Array.isArray(list) ? list : []) {
      if (!p || typeof p.page_key !== 'string' || p.kind !== 'page' || p.page_key === 'settings' || seen.has(p.page_key)) continue;
      seen.add(p.page_key); out.push({ key: p.page_key, label: typeof p.label === 'string' && p.label ? p.label : p.page_key, enabled: p.enabled !== false });
    }
    return out;
  }
  // Answer of get_my_dashboard_shortcuts / admin_set_dashboard_shortcuts -> array of keys, or null when it is not that shape.
  function parseShortcutsResult(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.shortcuts)) return null;
    return data.shortcuts.every((k) => typeof k === 'string') ? data.shortcuts.slice() : null;
  }
  // [] when the list would be accepted, else the reasons (strings).
  function shortcutProblems(keys, supported) {
    if (!Array.isArray(keys)) return ['The shortcut list is missing.'];
    const ok = new Set((supported || []).map((p) => p.key)), out = [];
    if (keys.length > SHORTCUT_MAX) out.push(`At most ${SHORTCUT_MAX} shortcuts (the 3 × 3 grid).`);
    if (new Set(keys).size !== keys.length) out.push('A page appears more than once.');
    const unknown = keys.filter((k) => !ok.has(k));
    if (unknown.length) out.push(`Not a supported page: ${[...new Set(unknown)].join(', ')}.`);
    for (const r of SHORTCUT_REQUIRED) if (!keys.includes(r)) out.push(`${r === 'dashboard' ? 'Home (dashboard)' : 'Settings (appearance)'} must stay in the list.`);
    return out;
  }
  const shortcutsEqual = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((k, i) => k === b[i]);
  // Each edit returns { list, error }; on refusal `list` is the unchanged input (never mutated).
  function shortcutAdd(keys, key, supported) {
    if (keys.includes(key)) return { list: keys, error: 'Already in the list.' };
    if (!(supported || []).some((p) => p.key === key)) return { list: keys, error: 'Not a supported page.' };
    if (keys.length >= SHORTCUT_MAX) return { list: keys, error: `The list is full (${SHORTCUT_MAX}).` };
    return { list: [...keys, key], error: null };
  }
  function shortcutRemove(keys, key) {
    if (SHORTCUT_REQUIRED.includes(key)) return { list: keys, error: 'Home and Settings cannot be removed.' };
    if (!keys.includes(key)) return { list: keys, error: 'Not in the list.' };
    return { list: keys.filter((k) => k !== key), error: null };
  }
  function shortcutMove(keys, key, dir) {
    const i = keys.indexOf(key), j = i + (dir < 0 ? -1 : 1);
    if (i < 0 || j < 0 || j >= keys.length) return { list: keys, error: null };       // at an edge: nothing to do
    const out = keys.slice(); out[i] = keys[j]; out[j] = key;
    return { list: out, error: null };
  }
  const shortcutsSaveCall = (keys) => ({ fn: 'admin_set_dashboard_shortcuts', params: { p_keys: keys.slice() } });
  // The server's answer counts as a confirmation only when it returns exactly the list that was sent (same keys, same order).
  const shortcutsConfirmed = (data, sent) => shortcutsEqual(parseShortcutsResult(data), sent);

  // One line for the "Recent changes" view.
  function auditLine(a) {
    const who = a.actor_email || 'unknown admin';
    const d = a.detail && typeof a.detail === 'object' ? Object.entries(a.detail).map(([k, v]) => `${k}=${v === null ? '—' : v}`).join(', ') : '';
    return `${a.action}${a.target ? ' · ' + a.target : ''}${d ? ' (' + d + ')' : ''} — ${who}`;
  }


  // ---- Step 4.B: page registry + left-navigation placement (migration 0016). Pure helpers; the server re-checks everything.
  const CORE_PAGE_KEYS = ['dashboard', 'meta', 'prompt', 'embed', 'p2p', 'p2p_niche', 'automation', 'appearance', 'settings'];
  const PAGE_KEY_RE = /^[a-z0-9_]{1,32}$/;
  // -> array of problems (empty = acceptable). `existing` = keys already in admin_list_pages().
  function registerPageProblems(key, label, existing) {
    const out = [];
    if (typeof key !== 'string' || !PAGE_KEY_RE.test(key)) out.push('Key: 1-32 characters, only a-z, 0-9 and underscore.');
    else if (CORE_PAGE_KEYS.includes(key)) out.push('Key: this is a built-in page and cannot be registered.');
    else if ((existing || []).includes(key)) out.push('Key: this page is already registered.');
    const l = typeof label === 'string' ? label.trim() : '';
    if (!l || l.length > 40 || /[\u0000-\u001f\u007f]/.test(l)) out.push('Label: 1-40 characters, no control characters.');
    return out;
  }
  function registerPageCall(key, label) { return { fn: 'admin_register_page', args: { p_key: key, p_label: String(label).trim() } }; }
  function navVisibleCall(key, visible) { return { fn: 'admin_set_page_nav_visible', args: { p_key: key, p_visible: !!visible } }; }
  // admin_list_page_placement() -> { key: {nav_visible, core, protected} }; null when the answer is not that shape.
  function parsePlacement(data) {
    if (!Array.isArray(data)) return null;
    const out = {};
    for (const r of data) {
      if (!r || typeof r.page_key !== 'string') continue;
      out[r.page_key] = { nav_visible: r.nav_visible !== false, core: r.core === true, protected: r.protected === true || isProtectedPage(r.page_key) };
    }
    return out;
  }
  function registerConfirmed(data, key) { return !!data && typeof data === 'object' && data.page_key === key && data.kind === 'page'; }
  function navConfirmed(data, key, visible) { return !!data && typeof data === 'object' && data.page_key === key && data.nav_visible === !!visible; }

  return { CORE_PAGE_KEYS, registerPageProblems, registerPageCall, navVisibleCall, parsePlacement, registerConfirmed, navConfirmed, SHORTCUT_MAX, SHORTCUT_REQUIRED, SHORTCUT_DEFAULT, supportedShortcutPages, parseShortcutsResult, shortcutProblems, shortcutsEqual, shortcutAdd, shortcutRemove, shortcutMove, shortcutsSaveCall, shortcutsConfirmed, PROTECTED_PAGES, isProtectedPage, activateBlock, describeSelection, selectionFor, isMissingRpcError, describeManagedAddon, describeManagedAddons, summarizeManagedAddons, ADDON_LIMITS, validateAddonId, validateAddonName, validateAddonDescription, checkAddonDraft, savedRowMatches, isStaleError, describeVersionHistory, selectionCall, replaceBlock, replaceEligibility, checkReplacement, replaceCall, savedReplaceMatches, classifyReplaceError, packageFileName, deleteBlock, deleteAddonBlock, addonDeleteRefusalText, deleteEligibility, deleteReleaseCall, deleteAddonCall, confirmMatches, isReleasePath, isAddonPath, parseDeleteReleaseResult, parseDeleteAddonResult, classifyDeleteError, splitRemoved, addonDeleteImpact, auditLine, parseCore, cmpCore, parseSidecar, validateSidecar, checkPackage, conflictsWith, sha256Hex, fmtBytes, shortHash, noteSections, groupPages, storagePathFor };
});
