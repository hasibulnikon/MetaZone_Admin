/* Helpers for the OpenAI-compatible Provider Builder and Model Import screens (7th Edition, Part 4). No DOM, no Supabase.
   The ONLY network code is `makeBridge`, which talks to the local provider bridge (MetaZone_App/MetaZone_js/scripts/provider_bridge.py) and refuses any
   address that is not loopback, so an API key typed into the Admin page can never be sent anywhere else by this file.
   Nothing here validates a provider's settings itself: the authoritative checks are the Python runtime (through the bridge) and the database function. */
(function (root) {
  'use strict';
  const ADAPTER_LABEL = { builtin: 'Built-in', openai_compat: 'OpenAI-Compatible', package: 'Downloaded Package' };
  const adapterLabel = (a) => ADAPTER_LABEL[a] || String(a || 'Built-in');
  const isCompat = (p) => !!p && p.adapter === 'openai_compat';

  const DEFAULTS = { base_url: '', chat_path: '/chat/completions', models_path: '/models', auth_scheme: 'bearer', auth_header: 'x-api-key', auth_prefix: '',
    extra_headers: {}, timeout_seconds: 30, max_tokens_field: 'max_tokens' };

  /* ---- custom headers: one "Name: value" per line ---- */
  const NAME_RE = /^[A-Za-z0-9_-]{1,64}$/;
  function parseHeaderLines(text) {
    const headers = {}, errors = [];
    const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (lines.length > 10) errors.push('At most 10 custom headers.');
    for (const line of lines.slice(0, 10)) {
      const i = line.indexOf(':');
      if (i < 1) { errors.push(`"${line.slice(0, 30)}" is not in the form Name: value.`); continue; }
      const name = line.slice(0, i).trim(), value = line.slice(i + 1).trim();
      if (!NAME_RE.test(name)) errors.push(`"${name.slice(0, 30)}" is not a valid header name.`);
      else if (!value) errors.push(`${name} has no value.`);
      else if (Object.keys(headers).some((k) => k.toLowerCase() === name.toLowerCase())) errors.push(`${name} appears twice.`);
      else headers[name] = value;
    }
    return { headers, errors };
  }
  const headersToText = (o) => Object.keys(o || {}).map((k) => `${k}: ${o[k]}`).join('\n');

  /** Form values -> the settings object used by BOTH the bridge checks and admin_upsert_ai_openai_provider (p_config). Empty models_path = no model list. */
  function buildConfig(v) {
    const header = v.auth_scheme === 'header';
    const cfg = {
      base_url: String(v.base_url || '').trim(),
      chat_path: String(v.chat_path || '').trim() || DEFAULTS.chat_path,
      models_path: String(v.models_path == null ? DEFAULTS.models_path : v.models_path).trim(),
      auth_scheme: header ? 'header' : 'bearer',
      extra_headers: v.extra_headers || {},
      timeout_seconds: parseInt(v.timeout_seconds, 10) || DEFAULTS.timeout_seconds,
      max_tokens_field: v.max_tokens_field === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
    };
    if (header) { cfg.auth_header = String(v.auth_header || '').trim(); cfg.auth_prefix = v.auth_prefix == null ? '' : String(v.auth_prefix); }
    return cfg;
  }
  /** Stored provider row (catalogue `compat`) -> form values. */
  const configToForm = (c) => Object.assign({}, DEFAULTS, c || {});

  /* ---- Part 80: provider presets (settings only: base URL, paths, links; never a key, never a model list baked into the app). Every value stays editable. ----
     The provider keys are suggestions that do not clash with the built-in Groq / OpenRouter providers; Cloudflare's URL carries a <ACCOUNT_ID> placeholder that must be replaced. */
  const PRESETS = [
    { id: 'custom', label: 'Custom (any OpenAI-compatible provider)', fill: null },
    { id: 'groq', label: 'Groq', fill: { provider: 'groq_compat', title: 'Groq (OpenAI-compatible)', base_url: 'https://api.groq.com/openai/v1', chat_path: '/chat/completions', models_path: '/models', key_url: 'https://console.groq.com/keys', key_hint: 'Starts with gsk_' } },
    { id: 'openrouter', label: 'OpenRouter', fill: { provider: 'openrouter_compat', title: 'OpenRouter (OpenAI-compatible)', base_url: 'https://openrouter.ai/api/v1', chat_path: '/chat/completions', models_path: '/models', key_url: 'https://openrouter.ai/keys', key_hint: 'Starts with sk-or-' } },
    { id: 'cloudflare', label: 'Cloudflare Workers AI', fill: { provider: 'cloudflare_workers_ai', title: 'Cloudflare Workers AI', base_url: 'https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1', chat_path: '/chat/completions', models_path: '', key_url: 'https://dash.cloudflare.com/profile/api-tokens', key_hint: 'An API token with Workers AI permission. Replace <ACCOUNT_ID> in the base URL with your Cloudflare account ID. This API has no OpenAI model list: add model IDs by hand.' } },
    { id: 'nvidia', label: 'NVIDIA NIM', fill: { provider: 'nvidia_nim', title: 'NVIDIA NIM', base_url: 'https://integrate.api.nvidia.com/v1', chat_path: '/chat/completions', models_path: '/models', key_url: 'https://build.nvidia.com/', key_hint: 'Starts with nvapi-' } },
  ];
  const presetById = (id) => PRESETS.find((p) => p.id === id) || PRESETS[0];
  /** True when the base URL still contains an unreplaced <PLACEHOLDER>. */
  const hasPlaceholder = (url) => /<[A-Za-z_]+>/.test(String(url || ''));
  /** Stable text for "is this the configuration that passed a check?" (key order independent). */
  function configSignature(cfg) {
    const o = cfg || {}; const keys = Object.keys(o).sort(); const out = {};
    for (const k of keys) out[k] = (o[k] && typeof o[k] === 'object') ? JSON.parse(configSignature(o[k])) : o[k];
    return JSON.stringify(out);
  }
  /** Enabled AND published only when a connection check passed for exactly this configuration, or the admin explicitly accepted publishing without one. */
  const publishEnabled = (wantEnabled, checkedSig, cfg, acceptUnchecked) => !!wantEnabled && (acceptUnchecked === true || (!!checkedSig && checkedSig === configSignature(cfg)));

  /** Required-field check only (the Python validator and the database re-check everything else). */
  function missingFields(v) {
    const p = [];
    if (hasPlaceholder(v.base_url)) p.push('Replace the <PLACEHOLDER> in the base URL with your real value (Cloudflare: your account ID).');
    else if (!String(v.base_url || '').trim()) p.push('Enter the base URL.');
    else if (!/^https:\/\//i.test(String(v.base_url).trim())) p.push('The base URL must start with https://');
    if (v.auth_scheme === 'header' && !String(v.auth_header || '').trim()) p.push('Enter the API key header name.');
    return p;
  }

  /* ---- what went wrong, in the Admin's words ---- */
  /** result of a bridge check -> { category, advice } for a FAILED result. */
  function explainFailure(r) {
    if (!r) return { category: 'No answer', advice: 'The check returned nothing.' };
    if (r.bridgeDown) return { category: 'Local bridge unavailable', advice: r.error };
    const cls = r.classification || '', stage = r.stage || '', msg = String(r.error || '');
    if (stage === 'request') return { category: 'Missing input', advice: msg };
    if (stage === 'config') return { category: 'Invalid settings', advice: msg + ' Fix the base URL / endpoint paths / headers and run Validate Configuration again.' };
    if (/endpoint was not found|HTTP 404/.test(msg) && stage !== 'model_test') return { category: 'Invalid endpoint', advice: 'The server answered but not at this path. Check the base URL and the chat / models path (do not repeat the path that is already in the base URL).' };
    switch (cls) {
      case 'PROVIDER_MISCONFIGURED': return { category: 'Invalid base URL or endpoint', advice: 'The address is not usable (a redirect, a wrong path or a wrong host). ' + msg };
      case 'NETWORK_ERROR': return { category: 'Network / connectivity failure', advice: 'The provider could not be reached (DNS, firewall, offline or timeout). Check the host name and this computer’s connection.' };
      case 'TLS_ERROR': return { category: 'Network / connectivity failure', advice: 'The secure (HTTPS) connection failed. Check the host name; the certificate must be valid.' };
      case 'INVALID_API_KEY': return { category: 'Authentication failure', advice: 'The key was refused or is missing. Check the key, and the authentication method / header name in this provider’s settings.' };
      case 'AUTHENTICATION_ERROR': return { category: 'Authentication failure', advice: 'The provider denied access. This is not always a wrong key: check the authentication method and the key’s permissions.' };
      case 'ACCESS_RESTRICTED': return { category: 'Authentication failure', advice: 'The request was blocked before it reached the provider (Cloudflare 1010). This does not prove the key is wrong.' };
      case 'NO_CREDITS': return { category: 'Provider account problem', advice: 'The provider reports no credits / quota left for this key.' };
      case 'RATE_LIMITED': return { category: 'Provider rate limit', advice: 'The provider is rate-limiting this key. The settings may still be correct; try again later.' };
      case 'INVALID_RESPONSE_FORMAT': case 'EMPTY_RESPONSE': return { category: 'Unsupported response format', advice: 'The server answered, but not in the OpenAI format this adapter understands. Check that this really is an OpenAI-compatible endpoint.' };
      case 'VISION_NOT_SUPPORTED': return { category: 'Model cannot read images', advice: 'This model does not accept image input; mark it Text only.' };
      case 'BAD_REQUEST': return stage === 'model_test' || stage === 'vision_test'
        ? { category: 'Invalid model ID', advice: 'The provider rejected the request. The model ID may be wrong or not available to this key (or the token-limit field name may not suit this provider).' }
        : { category: 'Provider rejected the request', advice: msg };
      default: return { category: 'Provider-side API error', advice: msg || 'The provider returned an error.' };
    }
  }

  const STAGE_LABEL = { config: 'Settings', connectivity: 'Connection', auth: 'Authentication', models: 'Model list', model_test: 'Model test', vision_test: 'Image test' };
  const stageLabel = (s) => STAGE_LABEL[s] || s;

  /* ---- bridge client ---- */
  const DEFAULT_BRIDGE_URL = 'http://127.0.0.1:8765';
  const START_HELP = 'Open a terminal in the MetaZone_App/MetaZone_js folder and run:  python3 scripts/provider_bridge.py  (Windows: py scripts\\provider_bridge.py). It prints an access code: paste it here. The bridge only listens on this computer and stops when you close that window.';
  /** The bridge address must be loopback http: this is what keeps the API key on this computer. -> normalised origin or null. */
  function bridgeOrigin(url) {
    let u; try { u = new URL(String(url || '').trim()); } catch (e) { return null; }
    if (u.protocol !== 'http:' || !(u.hostname === '127.0.0.1' || u.hostname === 'localhost') || !u.port || u.username || u.password || (u.pathname !== '/' && u.pathname !== '') || u.search || u.hash) return null;
    return `http://${u.hostname}:${u.port}`;
  }
  const TOKEN_RE = /^[A-Za-z0-9_-]{8,128}$/;

  /** One connection object per Admin session. The access code and the URL live in this object (memory) only - never in storage, never logged. */
  function makeBridge(fetchImpl) {
    const state = { url: DEFAULT_BRIDGE_URL, token: '' };
    const doFetch = fetchImpl || ((...a) => root.fetch(...a));
    const down = (why) => ({ ok: false, bridgeDown: true, stage: 'bridge', error: why });
    async function request(method, path, body, ms) {
      const origin = bridgeOrigin(state.url);
      if (!origin) return down('The bridge address must be http://127.0.0.1:<port> or http://localhost:<port>.');
      if (!TOKEN_RE.test(state.token)) return down('Paste the access code the bridge printed when it started.');
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = ctl ? setTimeout(() => ctl.abort(), ms || 150000) : null;
      try {
        const res = await doFetch(origin + path, { method, mode: 'cors', credentials: 'omit', cache: 'no-store', redirect: 'error', signal: ctl ? ctl.signal : undefined,
          headers: Object.assign({ Authorization: 'Bearer ' + state.token }, body ? { 'Content-Type': 'application/json' } : {}), body: body ? JSON.stringify(body) : undefined });
        let data = null; try { data = await res.json(); } catch (e) { /* not JSON */ }
        if (res.status === 401) return down('The access code is wrong. Copy the code the running bridge printed.');
        if (res.status === 403) return down('The bridge refused this page’s address. Start it with  --origin <this Admin page’s address>  if the Admin is not served from http://localhost:5173.');
        if (res.status === 429) return down('The bridge is busy with other checks. Wait a moment and try again.');
        if (!data || typeof data !== 'object') return down('The bridge answered in an unexpected way (HTTP ' + res.status + ').');
        return data;
      } catch (e) {
        return down(e && e.name === 'AbortError' ? 'The bridge did not answer in time.' : 'The local bridge is not running, the address is wrong, or this page’s address is not allowed by the bridge (--origin). ' + START_HELP);
      } finally { if (timer) clearTimeout(timer); }
    }
    return {
      state,
      configure(url, token) { state.url = String(url || DEFAULT_BRIDGE_URL).trim(); state.token = String(token || '').trim(); },
      health: () => request('GET', '/health', null, 8000),
      /** action: validate | connect | auth | models | test | all.  `apiKey` is sent in this one request and not kept. */
      run: (action, settings, apiKey, extra) => request('POST', '/' + action, Object.assign({ settings }, apiKey ? { api_key: apiKey } : {}, extra || {})),
    };
  }

  /* ---- model import ---- */
  const MODEL_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,120}$/;
  const validModelId = (id) => MODEL_ID_RE.test(String(id || ''));
  const norm = (s) => String(s == null ? '' : s).toLowerCase();
  const filterModels = (items, q) => { const s = norm(q).trim(); return (items || []).filter((m) => !s || norm(m.id).includes(s) || norm(m.label).includes(s)); };
  /** Never guessed from a model's name: only a capability the provider itself reported (true / false) counts. Unknown -> Text only, the safe default. */
  const defaultTextOnly = (providerHint) => providerHint !== true;
  const visionNote = (hint) => (hint === true ? 'Provider reports image input' : hint === false ? 'Provider reports text only' : 'Not verified');

  /** Join the fetched list with the catalogue. state: 'new' | 'exists' | 'removed' (removed earlier: restore it instead). */
  function planImport(fetched, existingIds, removedIds) {
    const ex = new Set(existingIds || []), rm = new Set(removedIds || []);
    return (fetched || []).map((m) => ({ id: m.id, owned_by: m.owned_by || '', hint: m.vision === true ? true : m.vision === false ? false : null,
      state: ex.has(m.id) ? 'exists' : rm.has(m.id) ? 'removed' : 'new', custom: !!m.custom }));
  }
  /** Rows the Admin ticked -> p_models of admin_import_ai_models. Existing / removed rows are never sent. */
  function buildImportPayload(rows, startOrder) {
    let n = parseInt(startOrder, 10); if (!(n >= 0)) n = 100;
    return rows.filter((r) => r.selected && r.state === 'new').map((r, i) => ({ id: r.id, label: String(r.label || r.id).trim().slice(0, 80) || r.id, enabled: r.enabled !== false, text_only: r.text_only !== false, sort_order: n + i * 10 }));
  }
  function importSummary(res) {
    const a = (res && res.added) || [], e = (res && res.skipped_existing) || [], r = (res && res.skipped_archived) || [], i = (res && res.invalid) || [];
    const parts = [`${a.length} model${a.length === 1 ? '' : 's'} added`];
    if (e.length) parts.push(`${e.length} already existed and were left unchanged`);
    if (r.length) parts.push(`${r.length} were removed earlier (restore them from Removed Providers & Models)`);
    if (i.length) parts.push(`${i.length} invalid`);
    return parts.join(' · ');
  }
  /** Friendly text for a database error of the Part 3 / Part 4 functions. */
  function friendlyDbError(msg) {
    const m = String(msg || '');
    if (/adapter_conflict/.test(m)) return 'That provider key already exists with a different adapter and is not converted. Use a new provider key.';
    if (/provider_is_archived/.test(m)) return 'That provider was removed earlier. Restore it from Removed Providers & Models instead of adding it again.';
    if (/could not find the function|PGRST202|schema cache/.test(m)) return 'The database is missing a function this screen needs. Apply the pending migration (0027 for the provider builder, 0028 for model import) first. Nothing was changed.';
    if (/import_requires_openai_compat/.test(m)) return 'Models can be imported only into OpenAI-compatible providers.';
    return m;
  }

  const api = { ADAPTER_LABEL, adapterLabel, isCompat, DEFAULTS, parseHeaderLines, headersToText, buildConfig, configToForm, missingFields, PRESETS, presetById, hasPlaceholder, configSignature, publishEnabled, explainFailure, stageLabel, DEFAULT_BRIDGE_URL, START_HELP,
    bridgeOrigin, makeBridge, validModelId, filterModels, defaultTextOnly, visionNote, planImport, buildImportPayload, importSummary, friendlyDbError };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.CompatLogic = api;
})(typeof window !== 'undefined' ? window : globalThis);
