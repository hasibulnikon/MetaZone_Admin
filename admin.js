/* MetaZone Admin -- static single-page app. No secrets here: every action is a database function
   (supabase/migrations) that refuses anyone who is not in admin_users. Hiding a button is cosmetic;
   the server is the authority. All dynamic text is rendered with textContent (never innerHTML). */
(() => {
  'use strict';
  const cfg = window.MZ_ADMIN_CONFIG || {};
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Clickjacking guard (GitHub Pages cannot send frame-ancestors headers): never render inside another site's frame.
  if (window.top !== window.self) { document.body.textContent = 'MetaZone Admin cannot be shown inside a frame.'; throw new Error('framed'); }
  const app = document.getElementById('app');
  let adminEmail = '';
  let tab = 'overview';
  let refreshTimer = null;

  // ---------------------------------------------------------------- helpers
  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else if (k === 'value') e.value = v;
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString(); };
  const fmtDay = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString());
  function toast(msg, err) {
    const t = h('div', { class: 'toast' + (err ? ' err' : '') }, (err ? '⚠ ' : '✓ ') + msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), err ? 7000 : 3500);
  }
  async function rpc(name, params) {
    const { data, error } = await sb.rpc(name, params || {});
    if (error) throw new Error(error.message || String(error));
    return data;
  }
  async function act(fn, okMsg) {                          // run an admin action with uniform error/ok handling
    try { const r = await fn(); if (okMsg) toast(okMsg); return r; }
    catch (e) { toast(e.message, true); throw e; }
  }
  function modal(title, body, buttons) {
    const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    const foot = h('div', { class: 'foot' }, buttons.map((b) => h('button', {
      class: 'btn ' + (b.cls || ''), type: 'button',
      onclick: async (ev) => { ev.target.disabled = true; try { const keep = await b.run(close); if (keep === true) ev.target.disabled = false; } catch (e) { ev.target.disabled = false; } },
    }, b.label)));
    const ov = h('div', { class: 'overlay', role: 'dialog' }, h('div', { class: 'modal' }, h('h2', {}, title), body, foot));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov) close(); });
    document.addEventListener('keydown', onKey);
    document.body.append(ov);
    const first = ov.querySelector('input, textarea, select');
    if (first) setTimeout(() => first.focus(), 30);
    return close;
  }
  const confirmBox = (title, text, label, run) => modal(title, h('p', {}, text), [
    { label: 'Cancel', run: (c) => c() }, { label, cls: 'danger', run: async (c) => { await run(); c(); } }]);

  // ------------------------------------------------------------------ auth
  function screenSignIn(msg) {
    app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card gate', id: 'gate-signin' },
      h('h1', {}, 'MetaZone Admin'), h('p', {}, 'Administrator sign-in. Only accounts on the admin list can enter.'),
      msg ? h('p', { class: 'warn' }, msg) : null,
      h('button', { class: 'btn primary', id: 'btn-google', onclick: signIn }, 'Sign in with Google'))));
  }
  function screenDenied(email) {
    app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card gate', id: 'gate-denied' },
      h('h1', {}, 'Not an administrator'), h('p', {}, `${email || 'This account'} is not on the admin list. Nothing was loaded.`),
      h('button', { class: 'btn', onclick: signOut }, 'Sign out'))));
  }
  async function signIn() {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname } });
    if (error) toast(error.message, true);
  }
  async function signOut() { clearInterval(refreshTimer); await sb.auth.signOut(); screenSignIn(); }

  async function boot() {
    const { data } = await sb.auth.getSession();
    const session = data && data.session;
    if (!session) return screenSignIn();
    adminEmail = (session.user && session.user.email) || '';
    try { await rpc('admin_overview'); }                     // the server decides: non-admins get 'forbidden'
    catch (e) { return /forbidden/i.test(e.message) ? screenDenied(adminEmail) : screenSignIn('Could not reach the server: ' + e.message); }
    shell();
  }

  // ----------------------------------------------------------------- shell
  const TABS = [['overview', 'Overview'], ['users', 'Users'], ['limits', 'Limits & Offers'], ['payment', 'Premium payment info'],
                ['notices', 'Notices'], ['version', 'App version']];
  function shell() {
    const nav = h('div', { class: 'nav' }, TABS.map(([id, label]) => h('button', { 'data-tab': id, class: id === tab ? 'on' : '', onclick: () => go(id) }, label)));
    app.replaceChildren(h('div', { class: 'shell' },
      h('div', { class: 'side' }, h('div', { class: 'brand' }, 'Meta', h('span', {}, 'Zone'), ' Admin'), nav,
        h('div', { class: 'who' }, adminEmail, h('button', { class: 'btn small', id: 'btn-signout', onclick: signOut }, 'Sign out'))),
      h('div', { class: 'main', id: 'main' })));
    go(tab);
  }
  function go(id) {
    tab = id; clearInterval(refreshTimer);
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    const main = document.getElementById('main'); main.replaceChildren(h('div', { class: 'skel' }, h('span', { class: 'spin' }), 'Loading…'));
    const page = { overview: pageOverview, users: pageUsers, limits: pageLimits, payment: pagePayment, notices: pageNotices, version: pageVersion }[id];
    page(main).catch((e) => main.replaceChildren(h('p', { class: 'warn' }, 'Error: ' + e.message)));
  }

  // -------------------------------------------------------------- overview
  const stat = (n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l));
  async function pageOverview(main) {
    const draw = async () => {
      const o = await rpc('admin_overview'); const u = o.users, g = o.generations, s = o.subscriptions, a = o.app;
      main.replaceChildren(
        h('div', { class: 'toolbar' }, h('h2', {}, 'Overview'), h('button', { class: 'btn small', onclick: draw }, 'Refresh')),
        h('h3', {}, 'Users'), h('div', { class: 'grid', id: 'stats-users' },
          stat(u.total, 'Total users'), stat(u.active_now, 'Active now'), stat(u.active_today, 'Active today'), stat(u.free, 'Free users'),
          stat(u.premium, 'Premium users', 'gold'), stat(u.expired_premium, 'Expired premium'), stat(u.suspended, 'Suspended')),
        h('h3', {}, 'Generations'), h('div', { class: 'grid', id: 'stats-gen' },
          stat(g.total, 'Total'), stat(g.today, 'Today'), stat(g.week, 'This week'), stat(g.month, 'This month'),
          stat(g.free, 'Free plan'), stat(g.premium, 'Premium plan', 'gold'), stat(g.failed, 'Failed')),
        h('h3', {}, 'Subscriptions'), h('div', { class: 'grid', id: 'stats-subs' },
          stat(s.active_premium, 'Active premium', 'gold'), stat(s.expiring_soon, 'Expiring in 7 days'), stat(s.expired, 'Expired'), stat(s.recently_activated, 'Activated (7 days)')),
        h('h3', {}, 'Application'),
        h('p', {}, 'Latest version: ', h('b', {}, a.latest_version || 'not set')),
        h('div', { class: 'tablewrap' }, h('table', { style: 'min-width:0' }, h('tr', {}, h('th', {}, 'Version in use'), h('th', {}, 'Users')),
          ...Object.entries(a.users_by_version || {}).sort((x, y) => y[1] - x[1]).map(([v, c]) => h('tr', {}, h('td', {}, v), h('td', {}, num(c)))))));
    };
    await draw(); refreshTimer = setInterval(() => { if (tab === 'overview') draw().catch(() => {}); }, 60000);
  }

  // ----------------------------------------------------------------- users
  const PAGE = 50;
  async function pageUsers(main) {
    let offset = 0; let search = ''; const rows = h('tbody', { id: 'user-rows' }); const more = h('button', { class: 'btn', id: 'btn-more', onclick: () => load(true) }, 'Load more');
    const box = h('input', { type: 'search', id: 'user-search', placeholder: 'Search by Google email…', style: 'width:280px' });
    let t; box.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { search = box.value.trim(); load(false); }, 250); });
    const cfgNow = await rpc('admin_get_config');
    const threshold = Number(cfgNow.online_threshold_seconds || 600);
    main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'Users'), box, h('button', { class: 'btn small', onclick: () => load(false) }, 'Refresh')),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {},
        ['Google account', 'Plan', 'Status', 'Last seen', 'Version', 'Today', 'Week', 'Month', 'Total', 'Premium expires', 'Actions'].map((c) => h('th', {}, c)))), rows)),
      h('p', {}, more));
    async function load(append) {
      if (!append) { offset = 0; rows.replaceChildren(); }
      const list = await act(() => rpc('admin_list_users', { p_search: search || null, p_limit: PAGE, p_offset: offset }));
      for (const u of list) rows.append(userRow(u, threshold, () => load(false)));
      offset += list.length; more.hidden = list.length < PAGE;
    }
    await load(false);
  }
  function userRow(u, threshold, reload) {
    const online = u.last_seen_at && (Date.now() - new Date(u.last_seen_at).getTime()) < threshold * 1000;
    const isPrem = u.plan === 'premium';
    return h('tr', { 'data-email': u.email },
      h('td', {}, h('span', { class: 'dot' + (online ? ' on' : '') }), u.email || u.id),
      h('td', {}, h('span', { class: 'badge' + (isPrem ? ' premium' : '') }, isPrem ? 'Premium' : 'Free')),
      h('td', {}, h('span', { class: 'badge' + (u.status === 'suspended' ? ' suspended' : '') }, u.status)),
      h('td', {}, fmt(u.last_seen_at)), h('td', {}, u.app_version || '—'),
      h('td', {}, num(u.today)), h('td', {}, num(u.week)), h('td', {}, num(u.month)), h('td', {}, num(u.total)),
      h('td', {}, u.premium_expires_at ? fmtDay(u.premium_expires_at) : '—'),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small gold', 'data-act': 'premium', onclick: () => premiumModal(u, reload) }, isPrem ? 'Extend / edit' : 'Activate Premium'),
        h('button', { class: 'btn small', 'data-act': 'suspend', onclick: () => suspendToggle(u, reload) }, u.status === 'suspended' ? 'Restore' : 'Suspend'),
        h('button', { class: 'btn small', 'data-act': 'details', onclick: () => detailsModal(u) }, 'Details')));
  }
  function suspendToggle(u, reload) {
    const to = u.status === 'suspended' ? 'active' : 'suspended';
    const run = async () => { await act(() => rpc('admin_set_status', { p_user: u.id, p_status: to }), to === 'active' ? 'Account restored' : 'Account suspended'); reload(); };
    if (to === 'active') run(); else confirmBox('Suspend account', `${u.email} will not be able to generate until restored.`, 'Suspend', run);
  }
  async function premiumModal(u, reload) {
    const cfgNow = await rpc('admin_get_config');
    const days = h('input', { type: 'number', id: 'prem-days', min: '1', max: '3660', value: String(cfgNow.premium_default_days || 30) });
    const note = h('input', { type: 'text', id: 'prem-note', placeholder: 'Payment reference / note (optional)', style: 'width:100%' });
    const exp = h('input', { type: 'datetime-local', id: 'prem-expiry' });
    const isPrem = u.plan === 'premium';
    const body = h('div', {},
      h('p', {}, u.email, isPrem ? ` — Premium until ${fmtDay(u.premium_expires_at)}` : ' — Free'),
      h('div', { class: 'row' }, h('label', { class: 'name' }, isPrem ? 'Add days (extends from current expiry)' : 'Premium for (days)'), days,
        [30, 60, 90, 365].map((d) => h('span', { class: 'chip', onclick: () => { days.value = d; } }, d + ' d'))),
      h('div', { class: 'field' }, h('label', {}, 'Note'), note),
      h('div', { class: 'row' }, h('label', { class: 'name' }, 'Or set an exact expiry'), exp,
        h('button', { class: 'btn small', id: 'btn-set-expiry', onclick: async () => {
          if (!exp.value) return toast('Pick a date and time first', true);
          await act(() => rpc('admin_set_expiry', { p_user: u.id, p_expiry: new Date(exp.value).toISOString(), p_note: note.value || null }), 'Expiry updated');
          document.querySelector('.overlay').remove(); reload();
        } }, 'Set expiry')));
    const buttons = [{ label: 'Close', run: (c) => c() }];
    if (isPrem) buttons.push({ label: 'Deactivate Premium', cls: 'danger', run: async (c) => {
      await act(() => rpc('admin_deactivate_premium', { p_user: u.id, p_note: note.value || null }), 'Premium deactivated'); c(); reload(); } });
    buttons.push({ label: isPrem ? 'Extend' : 'Activate', cls: 'gold', run: async (c) => {
      const r = await act(() => rpc('admin_set_premium', { p_user: u.id, p_days: Number(days.value), p_note: note.value || null }));
      toast(`Premium active until ${fmtDay(r.expires_at)}`); c(); reload(); } });
    modal('Premium subscription', body, buttons);
  }
  async function detailsModal(u) {
    const d = await act(() => rpc('admin_user_detail', { p_user: u.id }));
    const tbl = (head, rows) => h('div', { class: 'tablewrap' }, h('table', { style: 'min-width:0' }, h('tr', {}, head.map((x) => h('th', {}, x))), rows));
    modal(`${u.email}`, h('div', {},
      h('p', {}, `Plan: ${d.plan} · Status: ${d.profile ? d.profile.status : '—'} · Registered ${fmt(d.profile && d.profile.created_at)}`),
      h('h3', {}, 'Usage by day'), tbl(['Day', 'Plan', 'OK', 'Failed'], (d.usage_by_day || []).slice(0, 30).map((r) => h('tr', {}, h('td', {}, r.day), h('td', {}, r.plan), h('td', {}, num(r.ok)), h('td', {}, num(r.failed))))),
      h('h3', { style: 'margin-top:14px' }, 'Subscription history'), tbl(['When', 'Action', 'New expiry', 'Note'], (d.subscription_history || []).map((r) => h('tr', {}, h('td', {}, fmt(r.at)), h('td', {}, r.action), h('td', {}, fmtDay(r.new_expiry)), h('td', {}, r.note || '')))),
      h('h3', { style: 'margin-top:14px' }, 'Recent generations'), tbl(['When', 'Plan', 'Kind', 'OK', 'Provider', 'Model'], (d.recent_events || []).slice(0, 20).map((r) => h('tr', {}, h('td', {}, fmt(r.at)), h('td', {}, r.plan), h('td', {}, r.kind || ''), h('td', {}, r.ok ? 'yes' : 'no'), h('td', {}, r.provider || ''), h('td', {}, r.model || ''))))),
      [{ label: 'Close', run: (c) => c() }]);
  }

  // ------------------------------------------------------- limits & offers
  // A limit field: "Unlimited" checkbox + number. null = unlimited. Returns {node, get, dirty}.
  function limitField(label, initial, presets, key) {
    const unl = h('input', { type: 'checkbox', 'data-key': key + ':unl' }); unl.checked = initial == null;
    const n = h('input', { type: 'number', min: '0', step: '1', 'data-key': key, value: initial == null ? '' : String(initial) });
    const sync = () => { n.disabled = unl.checked; }; unl.addEventListener('change', sync); sync();
    const node = h('div', { class: 'row limit' }, h('label', { class: 'name' }, label), n, h('label', {}, unl, ' Unlimited'),
      h('div', { class: 'limit-chips' }, (presets || []).map((p) => h('span', { class: 'chip', onclick: () => { unl.checked = false; sync(); n.value = p; } }, String(p)))));
    const get = () => (unl.checked ? null : (n.value === '' ? undefined : Number(n.value)));
    return { node, get, initial };
  }
  async function pageLimits(main) {
    const c = await rpc('admin_get_config');
    const f = {
      fd: limitField('Daily generations', c.free_daily_limit, [20, 50, 100], 'free_daily_limit'),
      fw: limitField('Weekly generations', c.free_weekly_limit, [100, 300, 500], 'free_weekly_limit'),
      fk: limitField('API keys per provider', c.free_max_keys_per_provider, [1, 2, 3], 'free_max_keys_per_provider'),
      pd: limitField('Daily generations', c.premium_daily_limit, [500, 1000, 2000], 'premium_daily_limit'),
      pw: limitField('Weekly generations', c.premium_weekly_limit, [3000, 7000], 'premium_weekly_limit'),
      pk: limitField('API keys per provider', c.premium_max_keys_per_provider, [3, 5, 10], 'premium_max_keys_per_provider'),
    };
    const keyOf = { fd: 'free_daily_limit', fw: 'free_weekly_limit', fk: 'free_max_keys_per_provider', pd: 'premium_daily_limit', pw: 'premium_weekly_limit', pk: 'premium_max_keys_per_provider' };
    const adv = {
      premium_max_reservation: h('input', { type: 'number', min: '1', id: 'adv-batch', value: String(c.premium_max_reservation) }),
      reservation_ttl_minutes: h('input', { type: 'number', min: '1', id: 'adv-ttl', value: String(c.reservation_ttl_minutes) }),
      online_threshold_seconds: h('input', { type: 'number', min: '30', id: 'adv-online', value: String(c.online_threshold_seconds) }),
      heartbeat_interval_seconds: h('input', { type: 'number', min: '30', id: 'adv-heartbeat', value: String(c.heartbeat_interval_seconds) }),
    };
    const bonusUntil = c.free_unlimited_until ? new Date(c.free_unlimited_until) : null;
    const bonusOn = bonusUntil && bonusUntil > new Date();
    const setBonus = async (iso) => { await act(() => rpc('admin_set_config', { p_key: 'free_unlimited_until', p_value: iso }), iso ? 'Free bonus set' : 'Free bonus turned off'); go('limits'); };
    const custom = h('input', { type: 'datetime-local', id: 'bonus-custom' });
    const save = h('button', { class: 'btn primary', id: 'btn-save-limits', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        for (const [k, fld] of Object.entries(f)) {
          const v = fld.get(); if (v === undefined) throw new Error('Enter a number or tick Unlimited');
          if (v !== fld.initial) await rpc('admin_set_config', { p_key: keyOf[k], p_value: v });
        }
        for (const [k, el] of Object.entries(adv)) if (Number(el.value) !== Number(c[k])) await rpc('admin_set_config', { p_key: k, p_value: Number(el.value) });
        toast('Limits saved — apps pick them up on their next refresh'); go('limits');
      } catch (e) { toast(e.message, true); ev.target.disabled = false; }
    } }, 'Save limits');
    main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'Limits & Offers')),
      h('p', { class: 'hint' }, 'Each limit is optional: tick Unlimited to remove it. Changes apply to everyone at once; desktop apps see them on their next refresh (a few minutes) and always at the start of a batch.'),
      h('div', { class: 'card', id: 'bonus-card', style: 'margin-bottom:16px' }, h('h3', {}, 'Bonus — unlimited Free generations'),
        bonusOn ? h('p', { class: 'warn', id: 'bonus-status' }, `Active until ${fmt(bonusUntil)}`) : h('p', { class: 'hint', id: 'bonus-status' }, 'Off. Free users use the limits below.'),
        h('div', { class: 'row' }, [['1 day', 1], ['3 days', 3], ['7 days', 7], ['30 days', 30]].map(([l, d]) =>
          h('button', { class: 'btn small gold', 'data-bonus': d, onclick: () => setBonus(new Date(Date.now() + d * 864e5).toISOString()) }, '+' + l)),
          custom, h('button', { class: 'btn small', id: 'btn-bonus-custom', onclick: () => custom.value ? setBonus(new Date(custom.value).toISOString()) : toast('Pick a date and time', true) }, 'Until…'),
          h('button', { class: 'btn small danger', id: 'btn-bonus-off', onclick: () => setBonus(null) }, 'Turn off')),
        h('p', { class: 'hint' }, 'While a bonus is active Free has no daily/weekly cap (API-key limit is unchanged). It ends by itself at the chosen time.')),
      h('div', { class: 'two' },
        h('div', { class: 'card', id: 'free-card' }, h('h3', {}, 'Free plan'), f.fd.node, f.fw.node, f.fk.node),
        h('div', { class: 'card', id: 'premium-card' }, h('h3', {}, 'Premium plan'), f.pd.node, f.pw.node, f.pk.node)),
      h('div', { class: 'card', style: 'margin-bottom:16px' }, h('h3', {}, 'Advanced'),
        [['Max files per batch (everyone)', 'premium_max_reservation'], ['Hold unused slots for (minutes)', 'reservation_ttl_minutes'],
         ['"Online" if seen within (seconds)', 'online_threshold_seconds'], ['App heartbeat every (seconds)', 'heartbeat_interval_seconds']]
          .map(([l, k]) => h('div', { class: 'row' }, h('label', { class: 'name' }, l), adv[k]))),
      save);
  }

  // -------------------------------------------------------- payment info
  async function pagePayment(main) {
    const c = await rpc('admin_get_config');
    const inputs = {
      premium_bkash_number: h('input', { type: 'text', id: 'pay-bkash', value: c.premium_bkash_number || '', maxlength: '600' }),
      premium_price_text: h('input', { type: 'text', id: 'pay-price', value: c.premium_price_text || '', maxlength: '600' }),
      premium_contact_text: h('input', { type: 'text', id: 'pay-contact', value: c.premium_contact_text || '', maxlength: '600' }),
      premium_instructions: h('textarea', { id: 'pay-instructions', maxlength: '600' }, c.premium_instructions || ''),
    };
    main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'Premium payment info')),
      h('p', { class: 'hint' }, 'Shown to users on the “I have Premium Access” screen inside MetaZone. Nothing here is stored in the app.'),
      h('div', { class: 'card' },
        h('div', { class: 'field' }, h('label', {}, 'bKash number'), inputs.premium_bkash_number),
        h('div', { class: 'field' }, h('label', {}, 'Price text (e.g. “Premium: 30 days — 500 BDT”)'), inputs.premium_price_text),
        h('div', { class: 'field' }, h('label', {}, 'Contact line (e.g. WhatsApp / Facebook)'), inputs.premium_contact_text),
        h('div', { class: 'field' }, h('label', {}, 'Instructions'), inputs.premium_instructions),
        h('button', { class: 'btn primary', id: 'btn-save-payment', onclick: async (ev) => {
          ev.target.disabled = true;
          try { for (const [k, el] of Object.entries(inputs)) if ((el.value || '') !== (c[k] || '')) await rpc('admin_set_config', { p_key: k, p_value: el.value });
                toast('Payment info saved'); go('payment'); }
          catch (e) { toast(e.message, true); ev.target.disabled = false; } } }, 'Save')));
  }

  // -------------------------------------------------------------- notices
  async function pageNotices(main) {
    const list = await rpc('admin_list_notices');
    const rows = h('tbody', { id: 'notice-rows' }, list.map((n) => h('tr', { 'data-id': n.id },
      h('td', { style: 'white-space:normal;max-width:380px' }, n.body), h('td', {}, n.archived ? 'archived' : (n.active ? 'active' : 'off')),
      h('td', {}, n.show_immediately ? 'yes' : '—'), h('td', {}, fmt(n.starts_at)), h('td', {}, fmt(n.ends_at)), h('td', {}, String(n.priority)),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small', 'data-act': 'edit', onclick: () => noticeModal(n) }, 'Edit'),
        h('button', { class: 'btn small', 'data-act': 'toggle', onclick: async () => { await act(() => rpc('admin_upsert_notice', { p_id: n.id, p_body: n.body, p_active: !n.active, p_starts_at: n.starts_at, p_ends_at: n.ends_at, p_show_immediately: n.show_immediately, p_priority: n.priority })); go('notices'); } }, n.active ? 'Deactivate' : 'Activate'),
        h('button', { class: 'btn small', 'data-act': 'archive', onclick: async () => { await act(() => rpc('admin_archive_notice', { p_id: n.id, p_archived: !n.archived })); go('notices'); } }, n.archived ? 'Unarchive' : 'Archive'),
        h('button', { class: 'btn small danger', 'data-act': 'delete', onclick: () => confirmBox('Delete notice', 'This cannot be undone.', 'Delete', async () => { await act(() => rpc('admin_delete_notice', { p_id: n.id }), 'Deleted'); go('notices'); }) }, 'Delete')))));
    main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'Notices'), h('button', { class: 'btn primary', id: 'btn-new-notice', onclick: () => noticeModal(null) }, 'New notice')),
      h('p', { class: 'banner' }, 'Shown in MetaZone as a ticker under the header: each active notice once per day per user, highest priority first. Apps pick new notices up within ~5 minutes.'),
      h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Text', 'State', 'Show now', 'Starts', 'Ends', 'Priority', 'Actions'].map((x) => h('th', {}, x)))), rows)));
  }
  const localVal = (iso) => { if (!iso) return ''; const d = new Date(iso); const p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  function noticeModal(n) {
    const body = h('textarea', { id: 'notice-body', maxlength: '300', placeholder: '🚀 MetaZone v1.0.0 is now available — please update.' }, n ? n.body : '');
    const active = h('input', { type: 'checkbox', id: 'notice-active' }); active.checked = n ? n.active : true;
    const now = h('input', { type: 'checkbox', id: 'notice-now' }); now.checked = n ? n.show_immediately : false;
    const st = h('input', { type: 'datetime-local', id: 'notice-start', value: n ? localVal(n.starts_at) : '' });
    const en = h('input', { type: 'datetime-local', id: 'notice-end', value: n ? localVal(n.ends_at) : '' });
    const pr = h('input', { type: 'number', id: 'notice-priority', value: n ? String(n.priority) : '0' });
    modal(n ? 'Edit notice' : 'New notice', h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Text (max 300 characters)'), body),
      h('div', { class: 'row' }, h('label', {}, active, ' Active'), h('label', {}, now, ' Show immediately (ignore start time)')),
      h('div', { class: 'row' }, h('label', { class: 'name' }, 'Starts'), st, h('label', { class: 'name' }, 'Ends'), en),
      h('div', { class: 'row' }, h('label', { class: 'name' }, 'Priority (higher first)'), pr)),
    [{ label: 'Cancel', run: (c) => c() }, { label: 'Save', cls: 'primary', run: async (c) => {
      if (!body.value.trim()) { toast('Write the notice text first', true); return true; }
      await act(() => rpc('admin_upsert_notice', { p_id: n ? n.id : null, p_body: body.value.trim(), p_active: active.checked,
        p_starts_at: st.value ? new Date(st.value).toISOString() : null, p_ends_at: en.value ? new Date(en.value).toISOString() : null,
        p_show_immediately: now.checked, p_priority: Number(pr.value || 0) }), 'Notice saved');
      c(); go('notices'); } }]);
  }

  // ------------------------------------------------------------ app version
  async function pageVersion(main) {
    const list = await rpc('admin_list_versions');
    const rows = h('tbody', { id: 'ver-rows' }, list.map((v) => h('tr', { 'data-version': v.version },
      h('td', {}, v.version),
      h('td', {},
        v.is_active ? h('span', { class: 'dot on' }) : h('span', { class: 'dot' }),
        v.is_active ? 'Active' : 'Inactive',
        v.is_latest ? h('span', { class: 'badge premium', style: 'margin-left:6px' }, 'Latest') : null),
      h('td', {}, fmtDay(v.released_at)),
      h('td', { style: 'white-space:normal;max-width:280px' }, v.update_title || '—'),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small', 'data-act': 'edit', onclick: () => versionModal(v) }, 'Edit'),
        h('button', { class: 'btn small' + (v.is_active ? ' danger' : ''), 'data-act': 'toggle', onclick: async () => {
          await act(() => rpc('admin_set_version_active', { p_version: v.version, p_active: !v.is_active })); go('version');
        } }, v.is_active ? 'Deactivate' : 'Activate')))));
    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', {}, 'App version'),
        h('button', { class: 'btn primary', id: 'btn-new-version', onclick: () => versionModal(null) }, 'New version')),
      h('p', { class: 'hint' },
        'Only one version can be Latest, and Latest is always Active. MetaZone checks its own version against this list on every heartbeat and before every generation batch: Active keeps running, Inactive is forced to update — no “Later”.'),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Version', 'Status', 'Released', 'Update title', 'Actions'].map((x) => h('th', {}, x)))),
        rows)));
  }
  function versionModal(v) {
    const version = h('input', { type: 'text', id: 'ver-version', placeholder: 'v0.9.9.3', value: v ? v.version : '', disabled: !!v });
    const active = h('input', { type: 'checkbox', id: 'ver-active' }); active.checked = v ? v.is_active : true;
    const latest = h('input', { type: 'checkbox', id: 'ver-latest' }); latest.checked = v ? v.is_latest : false;
    const url = h('input', { type: 'url', id: 'ver-url', placeholder: 'https://drive.google.com/…', value: v ? (v.download_url || '') : '' });
    const title = h('input', { type: 'text', id: 'ver-title', placeholder: 'What is new (short)', value: v ? (v.update_title || '') : '' });
    const features = h('textarea', { id: 'ver-features', placeholder: 'New features (one per line)' }, v ? (v.features || '') : '');
    const bugfixes = h('textarea', { id: 'ver-bugfixes', placeholder: 'Bug fixes (one per line)' }, v ? (v.bugfixes || '') : '');
    const notes = h('input', { type: 'text', id: 'ver-notes', placeholder: 'Internal notes (optional)', value: v ? (v.notes || '') : '' });
    modal(v ? `Edit ${v.version}` : 'New version', h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Version'), version),
      h('div', { class: 'row' }, h('label', {}, active, ' Active'), h('label', {}, latest, ' Latest')),
      h('div', { class: 'field' }, h('label', {}, 'Download URL'), url),
      h('div', { class: 'field' }, h('label', {}, 'Update title'), title),
      h('div', { class: 'field' }, h('label', {}, 'Features'), features),
      h('div', { class: 'field' }, h('label', {}, 'Bug fixes'), bugfixes),
      h('div', { class: 'field' }, h('label', {}, 'Notes'), notes)),
    [{ label: 'Cancel', run: (c) => c() }, { label: 'Save', cls: 'primary', run: async (c) => {
      const ver = (v ? v.version : version.value).trim();
      if (!ver) { toast('Enter the version', true); return true; }
      if (latest.checked && !active.checked) { toast('A version marked Latest must also be Active', true); return true; }
      await act(() => rpc('admin_upsert_version', {
        p_version: ver, p_active: active.checked, p_latest: latest.checked,
        p_download_url: url.value.trim() || null, p_update_title: title.value.trim() || null,
        p_features: features.value.trim() || null, p_bugfixes: bugfixes.value.trim() || null,
        p_notes: notes.value.trim() || null,
      }), 'Version saved');
      c(); go('version');
    } }]);
  }

  // --------------------------------------------------------------- start
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') screenSignIn(); });
  boot();
})();
