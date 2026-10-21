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

  // One line for the "Recent changes" view.
  function auditLine(a) {
    const who = a.actor_email || 'unknown admin';
    const d = a.detail && typeof a.detail === 'object' ? Object.entries(a.detail).map(([k, v]) => `${k}=${v === null ? '—' : v}`).join(', ') : '';
    return `${a.action}${a.target ? ' · ' + a.target : ''}${d ? ' (' + d + ')' : ''} — ${who}`;
  }

  return { PROTECTED_PAGES, isProtectedPage, activateBlock, describeSelection, selectionFor, auditLine, parseCore, cmpCore, parseSidecar, validateSidecar, checkPackage, conflictsWith, sha256Hex, fmtBytes, shortHash, noteSections, groupPages, storagePathFor };
});
