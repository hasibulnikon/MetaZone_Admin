/* Pure helpers for the API Providers admin page (no DOM, no network) - unit tested in test/provider_logic.test.js.
   The browser cannot run Python, so a package is checked by scripts/provider_pkg.py (the SAME validator the app runs) and the Admin
   uploads the package together with the report that tool wrote. These helpers check that the two belong together before anything is uploaded;
   the database re-checks the binding (admin_register_ai_package / admin_record_ai_package_test), and every user's app re-validates the file. */
(function (root) {
  'use strict';
  const HEX64 = /^[0-9a-f]{64}$/;
  const KEY = /^[A-Za-z][A-Za-z0-9_.-]{0,39}$/;
  const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  const MAX_BYTES = 5 * 1024 * 1024;            // one limit for every layer: providers/limits.py, migration 0022 (size_bytes, bucket file_size_limit)
  const MAX_UNPACKED_BYTES = 20 * 1024 * 1024;

  const STATUS = {
    validated: 'Validated, not tested', tested: 'Tested, not published', published: 'Published',
    superseded: 'Replaced by a newer package', retired: 'Retired',
  };
  const statusLabel = (s) => STATUS[s] || String(s || '');

  async function sha256Hex(buf) {
    const d = await root.crypto.subtle.digest('SHA-256', buf);
    return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  const storagePath = (provider, sha) => `${provider}/${sha}.mzprovider`;

  /** Parse the text of a report written by `provider_pkg.py check`. -> { ok, report?, errors[] } */
  function parseReport(text) {
    let r;
    try { r = JSON.parse(text); } catch (e) { return { ok: false, errors: ['The report is not valid JSON.'] }; }
    const errors = [];
    if (!r || typeof r !== 'object') errors.push('The report is empty.');
    else {
      if (r.ok !== true) errors.push('The report says the package did not pass.');
      if (!HEX64.test(r.sha256 || '')) errors.push('The report has no valid SHA-256.');
      if (!r.validation || r.validation.ok !== true) errors.push('The report has no passing validation.');
      if (!r.test || r.test.ok !== true) errors.push('The report has no passing test.');
      if (r.validation && r.validation.sha256 !== r.sha256) errors.push('The validation in the report is for another file.');
      if (r.test && r.test.sha256 !== r.sha256) errors.push('The test in the report is for another file.');
      if (!r.provider || !KEY.test(r.provider)) errors.push('The report has no valid provider key.');
      if (!r.version || !SEMVER.test(r.version)) errors.push('The package has no version (x.y.z) in provider.json.');
      if (r.unpacked_size && r.unpacked_size > MAX_UNPACKED_BYTES) errors.push('The unpacked package is larger than 20 MB.');
      const sg = r.signature, m = sg && sg.manifest;
      if (!sg || sg.alg !== 'ed25519' || !m) errors.push('The report is not signed. Run: python3 scripts/provider_pkg.py check <package> --sign (the signing key comes from your secret store).');
      else {
        if (m.sha256 !== r.sha256) errors.push('The signature is for another file than the report.');
        if (m.provider !== r.provider || m.version !== r.version) errors.push('The signature names another provider / version.');
      }
    }
    return errors.length ? { ok: false, errors } : { ok: true, report: r, errors: [] };
  }

  /** Everything that must be true before upload. -> string[] of problems (empty = go). */
  function checkUpload({ provider, size, sha, report }) {
    const p = [];
    if (!provider || !KEY.test(provider)) p.push('Choose the provider this package is for.');
    if (!size || size > MAX_BYTES) p.push('The package must be between 1 byte and 5 MB.');
    if (!HEX64.test(sha || '')) p.push('Could not compute the package SHA-256.');
    if (!report) p.push('Choose the report file written by provider_pkg.py check.');
    else {
      if (report.sha256 !== sha) p.push('The report belongs to a different file than the package you chose (SHA-256 differs).');
      if (report.provider !== provider) p.push(`The package is for "${report.provider}", not "${provider}".`);
    }
    return p;
  }

  const canTest = (pkg) => pkg && (pkg.status === 'validated' || pkg.status === 'tested');
  const canPublish = (pkg) => !!pkg && pkg.status === 'tested' && !!pkg.test_report && pkg.test_report.sha256 === pkg.sha256;
  const canRetire = (pkg) => !!pkg && pkg.status !== 'retired';
  const canDeletePackage = (pkg) => !!pkg && pkg.status !== 'published';
  const canDeleteProvider = (prov) => !(prov.packages || []).some((k) => k.status === 'published');

  /** Which model/provider switches does a catalogue row show? */
  const effective = (prov, model) => !!prov.enabled && (!model || !!model.enabled);

  const validKey = (k) => KEY.test(String(k || '').trim());

  /* ---- Force Update (migration 0022) ---- */
  const JOB_STATES = ['queued', 'pending', 'downloading', 'installing', 'completed', 'failed', 'retrying', 'cancelled'];
  const STATE_LABEL = { queued: 'Queued', pending: 'Pending', downloading: 'Downloading', installing: 'Installing', completed: 'Completed', failed: 'Failed', retrying: 'Retrying', cancelled: 'Cancelled' };
  const fmtSize = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : (n || 0) + ' B');
  /** Why the Force Update button is unavailable for a provider (null = available). Model rows are always allowed when the model exists. */
  function forceProviderBlocked(prov) {
    const pub = (prov.packages || []).find((k) => k.status === 'published');
    if (!pub) return 'No published package';
    if (!pub.signed) return 'The published package is not signed';
    return null;
  }
  /** Text lines of the confirmation dialog from admin_preview_ai_force_update. */
  function previewLines(pv) {
    const L = [['Target', pv.scope === 'model' ? `Model ${pv.model_id} of ${pv.title}` : `Provider package of ${pv.title}`]];
    if (pv.scope === 'provider') L.push(['Package', `${pv.package_title}`], ['Target version', pv.version || '—'], ['Package size', fmtSize(pv.size)], ['Signed by', pv.signer || '—']);
    else L.push(['Model label', pv.model.label], ['Model state', pv.model.enabled ? 'on' : 'off'], ['Definition revision', String(pv.version)]);
    L.push(['Devices', `${pv.affected_users} active account(s); each online device installs automatically, offline ones when they are back`], ['Summary', pv.summary]);
    return L.concat((pv.warnings || []).map((w) => ['Warning', w]));
  }
  const canCancelJob = (j) => !!j && j.status === 'active';
  const canRollbackJob = (j) => !!j && j.kind === 'update' && j.scope === 'provider' && (j.counts || {}).completed > 0;
  /** One-line progress text for a job row. */
  function jobSummary(j) {
    const c = j.counts || {}; const parts = JOB_STATES.filter((s) => c[s]).map((s) => `${c[s]} ${STATE_LABEL[s].toLowerCase()}`);
    return parts.length ? parts.join(' · ') : 'no device has contacted the server yet';
  }

  const api = { JOB_STATES, STATE_LABEL, fmtSize, forceProviderBlocked, previewLines, canCancelJob, canRollbackJob, jobSummary, MAX_UNPACKED_BYTES, statusLabel, sha256Hex, storagePath, parseReport, checkUpload, canTest, canPublish, canRetire, canDeletePackage, canDeleteProvider, effective, validKey, MAX_BYTES };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ProviderLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
