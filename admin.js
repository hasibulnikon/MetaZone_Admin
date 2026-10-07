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
    for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return e;
  }
  const fmt = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleString(); };
  const fmtDay = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }); };
  const fmtShort = (iso) => { if (!iso) return '—'; const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }); };
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
    app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card gate', id: 'gate-signin' }, logoImg('gate-logo', 'assets/logo/metazone-logo.png'),
      h('h1', {}, 'MetaZone Admin'), h('p', {}, 'Administrator sign-in. Only accounts on the admin list can enter.'),
      msg ? h('p', { class: 'warn' }, msg) : null,
      h('button', { class: 'btn primary', id: 'btn-google', onclick: signIn }, 'Sign in with Google'))));
  }
  function screenDenied(email) {
    app.replaceChildren(h('div', { class: 'center' }, h('div', { class: 'card gate', id: 'gate-denied' }, logoImg('gate-logo', 'assets/logo/metazone-logo.png'),
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
  // v0.9.9.6: redesigned shell. Same tabs, same page functions; grouped nav with solid icons, real MetaZone logo.
  const ADMIN_VERSION = '0.9.9.6';
  const ICONS = {
    overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    users: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    limits: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    pages: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 14H4v-4h11v4zm0-5H4V9h11v4zm5 5h-4V9h4v9z',
    ai: 'M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8 5.8 21.3l2.4-7.4L2 9.4h7.6z',
    payment: 'M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    notices: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
    version: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  };
  function icon(id) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[id] || ICONS.overview); s.append(p); return s;
  }
  const logoImg = (cls, src) => h('img', { class: cls || '', src: src || 'assets/logo/metazone-icon.png', alt: 'MetaZone', width: '64', height: '64' });
  const NAV = [['Dashboard', [['overview', 'Overview'], ['users', 'Users']]],
               ['Plans & access', [['limits', 'Limits & Offers'], ['pages', 'Pages'], ['ai', 'API Configuration']]],
               ['Communication', [['payment', 'Premium payment info'], ['notices', 'Notices'], ['version', 'App version']]]];
  const TABS = NAV.flatMap(([, items]) => items);
  function shell() {
    const nav = h('div', { class: 'nav' }, NAV.map(([group, items]) => [h('div', { class: 'nav-group' }, group),
      items.map(([id, label]) => h('button', { 'data-tab': id, title: label, class: id === tab ? 'on' : '', onclick: () => go(id) }, icon(id), h('span', {}, label)))]));
    app.replaceChildren(h('div', { class: 'shell' },
      h('div', { class: 'side' },
        h('div', { class: 'brand' }, logoImg(), h('div', {}, h('b', {}, 'MetaZone'), h('small', {}, 'Admin'))),
        nav,
        h('div', { class: 'who' }, h('span', { class: 'email' }, adminEmail), h('span', { class: 'ver' }, 'Admin v' + ADMIN_VERSION),
          h('button', { class: 'btn small', id: 'btn-signout', title: 'Sign out', onclick: signOut }, 'Sign out'))),
      h('div', { class: 'main', id: 'main' })));
    go(tab);
  }
  function go(id) {
    tab = id; clearInterval(refreshTimer);
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    const main = document.getElementById('main'); main.replaceChildren(h('div', { class: 'skel' }, h('span', { class: 'spin' }), 'Loading…'));
    const page = { overview: pageOverview, users: pageUsers, limits: pageLimits, pages: pagePages, ai: pageAi, payment: pagePayment, notices: pageNotices, version: pageVersion }[id];
    page(main).catch((e) => main.replaceChildren(h('p', { class: 'warn' }, 'Error: ' + e.message)));
  }

  // -------------------------------------------------------------- overview
  // v0.9.9.6: hierarchy instead of four floating boxes -- KPI strip, then operational panels (generations / Tracker),
  // then secondary panels (accounts / subscriptions / app versions). Every number comes from admin_overview +
  // admin_tracker_search_stats; nothing is invented, and no time-series is drawn because the backend returns none.
  const stat = (n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l));
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const miniStat = (n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l));
  const barRow = (label, value, of, cls, shown) => h('div', { class: 'bar ' + (cls || '') }, h('span', { class: 'bl', title: label }, label),
    h('div', { class: 'bt' }, h('i', { style: `width:${Math.min(100, pct(value, of))}%` })), h('span', { class: 'bv' }, shown != null ? shown : num(value)));
  const panel = (title, aside, ...kids) => h('div', { class: 'panel' }, h('div', { class: 'p-head' }, h('h3', {}, title), aside ? h('span', {}, aside) : null), ...kids);
  async function pageOverview(main) {
    const draw = async () => {
      const o = await rpc('admin_overview'); const ts = await rpc('admin_tracker_search_stats'); const u = o.users, g = o.generations, s = o.subscriptions, a = o.app;
      const kpi = (n, l, sub, cls) => h('div', { class: 'stat ' + cls }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l, sub ? [' · ', h('small', {}, sub)] : null));
      const versions = Object.entries(a.users_by_version || {}).sort((x, y) => y[1] - x[1]);
      const vTotal = versions.reduce((t, [, c]) => t + c, 0);
      const plans = (u.free || 0) + (u.premium || 0);
      main.replaceChildren(
        h('div', { class: 'toolbar' }, h('h2', {}, 'Overview'), h('button', { class: 'btn small', id: 'btn-refresh', onclick: draw }, 'Refresh')),
        h('div', { class: 'kpis', id: 'stats-users' },
          kpi(u.total, 'Total users', `${num(u.active_today)} active today`, 'accent'),
          kpi(u.active_now, 'Active now', null, 'ok'),
          kpi(u.free, 'Free / Demo', `${pct(u.free, plans)}%`, ''),
          kpi(u.premium, 'Premium', `${pct(u.premium, plans)}%`, 'gold')),
        h('div', { class: 'ov-cols' },
          panel('Generations', 'AI metadata / prompt batches', h('div', { id: 'stats-gen' },
            h('div', { class: 'mini' }, miniStat(g.total, 'Total'), miniStat(g.today, 'Today'), miniStat(g.week, 'This week'), miniStat(g.month, 'This month')),
            h('div', { class: 'bars' }, barRow('Today', g.today, g.month, '', num(g.today)), barRow('This week', g.week, g.month, '', num(g.week)), barRow('This month', g.month, g.month, '', num(g.month))),
            h('div', { style: 'height:14px' }),
            h('div', { class: 'split', title: 'Share of all-time generations by plan' }, h('i', { class: 'a', style: `width:${pct(g.free, g.total)}%` }), h('i', { class: 'b', style: `width:${pct(g.premium, g.total)}%` })),
            h('div', { class: 'legend' }, h('span', {}, h('i', { style: 'background:var(--accent)' }), `Free ${num(g.free)}`), h('span', {}, h('i', { style: 'background:var(--warning)' }), `Premium ${num(g.premium)}`),
              h('span', { class: g.failed ? 'warn' : '' }, h('i', { style: 'background:var(--error)' }), `Failed ${num(g.failed)} (${pct(g.failed, g.total)}%)`)))),
          panel('Adobe Tracker searches', 'searches started in Tracker only', h('div', { id: 'stats-tracker' },
            h('div', { class: 'mini' }, miniStat(ts.total, 'Total searches'), miniStat(ts.today, 'Today'), miniStat(ts.week, 'This week'), miniStat(ts.month, 'This month')),
            h('div', { class: 'bars' }, barRow('Today', ts.today, ts.month, '', num(ts.today)), barRow('This week', ts.week, ts.month, '', num(ts.week)), barRow('This month', ts.month, ts.month, '', num(ts.month))),
            h('div', { style: 'height:12px' }),
            h('p', { class: 'hint', style: 'margin:0' }, `${num(ts.users_today)} user(s) searched today. Not generations, not Image-to-Prompt jobs, not Apify usage.`)))),
        h('div', { class: 'ov-cols three' },
          panel('Accounts', null, h('div', { class: 'mini' }, miniStat(u.active_today, 'Active today'), miniStat(u.expired_premium, 'Expired premium'), miniStat(u.suspended, 'Suspended'))),
          panel('Subscriptions', null, h('div', { id: 'stats-subs' }, h('div', { class: 'mini' },
            miniStat(s.active_premium, 'Active premium'), miniStat(s.expiring_soon, 'Expiring in 7 days'), miniStat(s.expired, 'Expired'), miniStat(s.recently_activated, 'Activated (7 days)')))),
          panel('Application', `Latest: ${a.latest_version || 'not set'}`, versions.length
            ? h('div', { class: 'bars', id: 'stats-versions' }, versions.slice(0, 8).map(([v, c]) => barRow(v, c, vTotal, v === a.latest_version ? 'ok' : '', `${num(c)}`)))
            : h('p', { class: 'hint', style: 'margin:0' }, 'No version data yet.'))));
    };
    await draw(); refreshTimer = setInterval(() => { if (tab === 'overview') draw().catch(() => {}); }, 60000);
  }

  // ----------------------------------------------------------------- users
  // v0.9.9.6: compact table -- one "User" cell (editable nickname over the email), badges grouped, usage as one block, a
  // single Actions cell. All data columns and every action from before are kept; filters are client-side over loaded rows.
  const PAGE = 50;
  async function pageUsers(main) {
    let offset = 0; let search = ''; let fPlan = ''; let fStatus = ''; let loaded = 0;
    const rows = h('tbody', { id: 'user-rows' }); const more = h('button', { class: 'btn', id: 'btn-more', onclick: () => load(true) }, 'Load more');
    const note = h('div', { class: 'count-note', id: 'user-count' });
    const box = h('input', { type: 'search', id: 'user-search', placeholder: 'Search by email or nickname…', style: 'width:260px' });
    let t; box.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => { search = box.value.trim(); load(false); }, 250); });
    const applyFilters = () => {
      let shown = 0;
      for (const tr of rows.children) { const ok = (!fPlan || tr.dataset.plan === fPlan) && (!fStatus || tr.dataset.status === fStatus); tr.hidden = !ok; if (ok) shown++; }
      note.textContent = loaded ? `Showing ${shown} of ${loaded} loaded user${loaded === 1 ? '' : 's'}${more.hidden ? '' : ' (more available)'}` : '';
    };
    const seg = (label, opts, set) => {
      const el = h('span', { class: 'seg', role: 'group', 'aria-label': label }, opts.map(([v, l]) => h('button', { type: 'button', 'data-v': v, class: v === '' ? 'on' : '', onclick: () => {
        set(v); el.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.v === v)); applyFilters(); } }, l)));
      return el;
    };
    const cfgNow = await rpc('admin_get_config');
    const threshold = Number(cfgNow.online_threshold_seconds || 600);
    main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'Users'), box,
        h('div', { class: 'filters' }, seg('Plan', [['', 'All'], ['free', 'Free'], ['premium', 'Premium']], (v) => { fPlan = v; }),
          seg('Status', [['', 'Any status'], ['active', 'Active'], ['suspended', 'Suspended']], (v) => { fStatus = v; })),
        h('button', { class: 'btn small', onclick: () => load(false) }, 'Refresh')),
      h('div', { class: 'tablewrap' }, h('table', { id: 'users-table' }, h('thead', {}, h('tr', {},
        ['Nickname', 'Email', 'Plan', 'Usage', 'Tracker', 'Last seen', 'Actions'].map((c) => h('th', {}, c)))), rows)),
      note, h('p', { style: 'margin-top:10px' }, more));
    async function load(append) {
      if (!append) { offset = 0; loaded = 0; rows.replaceChildren(); }
      const list = await act(() => rpc('admin_list_users', { p_search: search || null, p_limit: PAGE, p_offset: offset }));
      for (const u of list) rows.append(userRow(u, threshold, () => load(false)));
      offset += list.length; loaded += list.length; more.hidden = list.length < PAGE; applyFilters();
    }
    await load(false);
  }
  function userRow(u, threshold, reload) {
    const online = u.last_seen_at && (Date.now() - new Date(u.last_seen_at).getTime()) < threshold * 1000;
    const isPrem = u.plan === 'premium';
    const nick = h('input', { type: 'text', class: 'nick', maxlength: '60', placeholder: 'add nickname', value: u.nickname || '', 'aria-label': 'Nickname for ' + u.email, 'data-nick': u.id });
    let last = u.nickname || '';
    const saveNick = async () => {                       // admin-only display name: stored in profiles.nickname, never touches the sign-in identity
      const v = nick.value.trim(); if (v === last) { nick.value = v; return; }
      try { await act(() => rpc('admin_set_nickname', { p_user: u.id, p_nickname: v || null }), v ? 'Nickname saved' : 'Nickname cleared'); last = v; nick.value = v; }
      catch (e) { nick.value = last; }
    };
    nick.addEventListener('change', saveNick);
    nick.addEventListener('keydown', (e) => { if (e.key === 'Enter') nick.blur(); if (e.key === 'Escape') { nick.value = last; nick.blur(); } });
    const us = (label, v) => h('div', {}, h('span', {}, label), h('b', {}, num(v)));
    return h('tr', { 'data-email': u.email, 'data-plan': isPrem ? 'premium' : 'free', 'data-status': u.status },
      h('td', { class: 'nickcell c-nick' }, nick),
      h('td', { class: 'c-email' }, h('div', { class: 'uemail', title: u.email || u.id }, h('span', { class: 'dot' + (online ? ' on' : ''), title: online ? 'Online now' : 'Offline' }), u.email || u.id)),
      h('td', { class: 'c-plan' }, h('div', { class: 'badges' },
        h('span', { class: 'badge' + (isPrem ? ' premium' : '') }, isPrem ? 'Premium' : 'Free'),
        h('span', { class: 'badge' + (u.status === 'suspended' ? ' suspended' : '') }, u.status)),
        isPrem && u.premium_expires_at ? h('div', { class: 'meta2' }, h('small', {}, 'Expires ' + fmtDay(u.premium_expires_at))) : null),
      h('td', { class: 'c-usage' }, h('div', { class: 'usage' }, us('Today', u.today), us('Week', u.week), us('Month', u.month), us('Total', u.total))),
      h('td', { class: 'c-tracker' }, h('div', { class: 'meta2' }, num(u.tracker_searches), h('small', {}, 'searches'))),
      h('td', { class: 'c-seen' }, h('div', { class: 'meta2' }, fmtShort(u.last_seen_at), h('small', {}, u.app_version || '—'))),
      h('td', { class: 'actions c-act' }, h('div', { class: 'uact' },
        h('button', { class: 'btn small gold', 'data-act': 'premium', onclick: () => premiumModal(u, reload) }, isPrem ? 'Extend / edit' : 'Activate'),
        h('button', { class: 'btn small', 'data-act': 'pages', onclick: () => userPagesModal(u) }, 'Pages'),
        h('button', { class: 'btn small', 'data-act': 'suspend', onclick: () => suspendToggle(u, reload) }, u.status === 'suspended' ? 'Restore' : 'Suspend'),
        h('button', { class: 'btn small', 'data-act': 'details', onclick: () => detailsModal(u) }, 'Details'),
        u.is_admin ? null : h('button', { class: 'btn small danger', 'data-act': 'delete', onclick: () => deleteUserModal(u, reload) }, 'Delete'))));
  }
  // Delete user: typed-email confirmation; the SERVER re-checks admin rights, the email match, and refuses self/admin accounts.
  function deleteUserModal(u, reload) {
    const typed = h('input', { type: 'text', id: 'del-user-email', placeholder: 'Type the email to confirm', style: 'width:100%', autocomplete: 'off' });
    modal('Delete user permanently', h('div', {},
      h('p', {}, 'You are about to delete: ', h('b', {}, u.email || u.id), u.nickname ? ` (${u.nickname})` : ''),
      h('p', { class: 'warn' }, 'This removes the account, its plan/subscription, usage history and Tracker search history. It cannot be undone. The person can sign in again later and gets a fresh Free account.'),
      h('div', { class: 'field' }, h('label', {}, 'Type ', h('b', {}, u.email), ' to confirm'), typed)),
    [{ label: 'Cancel', run: (c) => c() }, { label: 'Delete user', cls: 'danger', run: async (c) => {
      if (typed.value.trim().toLowerCase() !== String(u.email || '').toLowerCase()) { toast('The email does not match — nothing was deleted', true); return true; }
      try { await act(() => rpc('admin_delete_user', { p_user: u.id, p_confirm_email: typed.value.trim() }), 'User deleted'); }
      catch (e) { return true; }
      c(); reload();
    } }]);
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

  // ------------------------------------------------------------------ pages
  // v0.9.9.4: switch the app's pages on/off -- for everyone (this tab) or for one user (Users -> Pages).
  // A per-user setting beats the global one. Home and Settings are locked (always on). The app hides a
  // switched-off page; for the three AI pages (Meta, Image to Prompt, Prompt-to-Prompt) the server also
  // refuses their generation batches.
  async function pagePages(main) {
    const list = await rpc('admin_list_pages');
    const rows = h('tbody', { id: 'page-rows' }, list.map((p) => h('tr', { 'data-page': p.page_key },
      h('td', {}, p.label), h('td', {}, h('code', {}, p.page_key)),
      h('td', {}, h('span', { class: 'dot' + (p.enabled ? ' on' : '') }), p.locked ? 'Always on' : (p.enabled ? 'On for everyone' : 'Off for everyone')),
      h('td', {}, p.overrides_on || p.overrides_off
        ? [p.overrides_on ? h('span', { class: 'badge', style: 'margin-right:6px' }, `${p.overrides_on} forced on`) : null,
           p.overrides_off ? h('span', { class: 'badge suspended' }, `${p.overrides_off} forced off`) : null]
        : '—'),
      h('td', { class: 'actions' }, p.locked ? '—' :
        h('button', { class: 'btn small' + (p.enabled ? ' danger' : ''), 'data-act': 'toggle', onclick: async () => {
          const go2 = async () => { await act(() => rpc('admin_set_page_enabled', { p_key: p.page_key, p_enabled: !p.enabled }), `${p.label} turned ${p.enabled ? 'off' : 'on'}`); go('pages'); };
          if (p.enabled) confirmBox(`Turn off ${p.label}?`, 'It disappears for every user, except accounts you have forced it ON for. Their data is not touched.', 'Turn off', go2); else go2();
        } }, p.enabled ? 'Turn off' : 'Turn on')))));
    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', {}, 'Pages')),
      h('p', { class: 'hint' }, 'The global switch decides whether a page exists for everybody. To sell a smaller plan, leave the page on here and switch it off for that one customer (Users → Pages); to beta-test a new page, switch it off here and force it on for your own account. Home and Settings can never be switched off. Users see the change within a few minutes (next heartbeat), or right away on their next generation attempt.'),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Page', 'Key', 'Global', 'Per-user exceptions', 'Actions'].map((x) => h('th', {}, x)))), rows)));
  }
  async function userPagesModal(u) {
    const body = h('div', { id: 'user-pages' });
    const render = (list) => body.replaceChildren(
      h('p', { class: 'hint' }, 'Force a page on or off for just this account. “Follow global” removes the exception.'),
      h('div', { class: 'tablewrap' }, h('table', { style: 'min-width:0' },
        h('thead', {}, h('tr', {}, ['Page', 'Global', 'This user', 'Result'].map((x) => h('th', {}, x)))),
        h('tbody', {}, list.map((p) => {
          const sel = h('select', { 'data-page': p.page_key, disabled: p.locked },
            [['', 'Follow global'], ['on', 'Force on'], ['off', 'Force off']].map(([v, l]) => h('option', { value: v }, l)));
          sel.value = p.override === true ? 'on' : p.override === false ? 'off' : '';
          sel.addEventListener('change', async () => {
            try {
              render(await act(() => rpc('admin_set_user_page', { p_user: u.id, p_key: p.page_key, p_enabled: sel.value === '' ? null : sel.value === 'on' }), `${p.label} updated`));
            } catch (e) { /* act() already toasted */ }
          });
          return h('tr', { 'data-page': p.page_key }, h('td', {}, p.label),
            h('td', {}, p.locked ? 'Always on' : (p.global_enabled ? 'On' : 'Off')),
            h('td', {}, p.locked ? '—' : sel),
            h('td', {}, h('span', { class: 'badge' + (p.effective ? '' : ' suspended') }, p.effective ? 'Enabled' : 'Disabled')));
        })))));
    render(await act(() => rpc('admin_get_user_pages', { p_user: u.id })));
    modal(`Pages — ${u.email}`, body, [
      { label: 'Reset all to global', run: async () => { render(await act(() => rpc('admin_reset_user_pages', { p_user: u.id }), 'Reset to global')); return true; } },
      { label: 'Close', run: (c) => c() }]);
  }

  // ------------------------------------------------------ API configuration
  // Admin ON/OFF for the Meta Generator providers/models (rows exist only for switched-OFF items). Apify belongs to Adobe Tracker and is NOT here.
  const AI_CATALOG = [["Gemini", [["Gemini 3.6 Flash", "gemini-3.6-flash"], ["Gemini 3.5 Flash", "gemini-3.5-flash"], ["Gemini 3.5 Flash-Lite", "gemini-3.5-flash-lite"], ["Gemini 3.1 Flash-Lite", "gemini-3.1-flash-lite"], ["Gemini 3 Flash (Preview)", "gemini-3-flash-preview"], ["Gemini 2.5 Flash", "gemini-2.5-flash"], ["Gemini 1.5 Flash", "gemini-1.5-flash"], ["Gemini 1.5 Pro", "gemini-1.5-pro"]]], ["Mistral", [["Pixtral 12B", "pixtral-12b-2409"], ["Pixtral Large", "pixtral-large-2411"]]], ["Groq", [["Qwen 3.6 27B (Vision)", "qwen/qwen3.6-27b"]]], ["Cerebras", [["Llama 3.3 70B", "llama-3.3-70b"], ["Llama 3.1 8B", "llama3.1-8b"]]], ["OpenAI", [["GPT-4o", "gpt-4o"], ["GPT-4o Mini", "gpt-4o-mini"], ["GPT-4.1 Nano", "gpt-4.1-nano"]]], ["OpenRouter", [["Inkling Small (Vision)", "thinkingmachines/inkling-small:free"], ["Ling 3.0 Flash VL", "inclusionai/ling-3.0-flash-vl:free"], ["Inkling (Vision)", "thinkingmachines/inkling:free"], ["Nemotron 3 Nano Omni", "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"]]]];   // [provider, [[label, id], ...]] from backend/core/constants.py; the app matches on the ID
  async function pageAi(main) {
    const rowsOff = await rpc('admin_list_ai_access');
    const off = new Set(rowsOff.filter((r) => !r.enabled).map((r) => r.provider + '\u0001' + r.model));
    const draw = (list) => {
      const offNow = new Set(list.filter((r) => !r.enabled).map((r) => r.provider + '\u0001' + r.model));
      const known = new Map(AI_CATALOG.map(([p, m]) => [p, new Map(m.map(([l, i]) => [i, l]))]));
      list.forEach((r) => { if (!known.has(r.provider)) known.set(r.provider, new Map()); if (r.model && !known.get(r.provider).has(r.model)) known.get(r.provider).set(r.model, r.model); });
      const sw = (provider, model) => {
        const on = !offNow.has(provider + '\u0001' + model);
        return h('button', { class: 'btn small' + (on ? '' : ' danger'), 'data-ai': provider + '|' + model, onclick: async () => {
          const apply = async () => { draw(await act(() => rpc('admin_set_ai_access', { p_provider: provider, p_model: model, p_enabled: !on }), `${model || provider} turned ${on ? 'off' : 'on'}`)); };
          if (on && !model) confirmBox(`Turn off ${provider}?`, 'It disappears from Meta Generator for every user and is skipped during generation. Their keys are not touched.', 'Turn off', apply); else apply();
        } }, on ? 'On' : 'Off');
      };
      const trs = [];
      for (const [prov, models] of known) {
        trs.push(h('tr', { class: 'prov', 'data-provider': prov }, h('td', {}, h('b', {}, prov)), h('td', {}, 'Provider'), h('td', {}, sw(prov, ''))));
        for (const [m, label] of models) trs.push(h('tr', { 'data-provider': prov, 'data-model': m }, h('td', { style: 'padding-left:28px' }, label, ' ', h('code', {}, m)), h('td', {}, 'Model'),
          h('td', {}, offNow.has(prov + '\u0001') ? h('span', { class: 'hint' }, 'Provider off') : sw(prov, m))));
      }
      main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'API Configuration — Meta Generator')),
        h('p', { class: 'hint' }, 'Decide which Meta Generator providers and models users can use. The app applies this when it starts and on every heartbeat; a switched-off provider/model is hidden and skipped during generation. Adobe Tracker’s Apify keys are separate and not controlled here.'),
        h('div', { class: 'tablewrap' }, h('table', { id: 'ai-rows' }, h('thead', {}, h('tr', {}, ['Provider / model', 'Level', 'Available'].map((x) => h('th', {}, x)))), h('tbody', {}, trs))));
    };
    draw(rowsOff);
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
        } }, v.is_active ? 'Deactivate' : 'Activate'),
        v.is_latest ? null : h('button', { class: 'btn small danger', 'data-act': 'delete', onclick: () => deleteVersionModal(v) }, 'Delete')))));
    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', {}, 'App version'),
        h('button', { class: 'btn primary', id: 'btn-new-version', onclick: () => versionModal(null) }, 'New version')),
      h('p', { class: 'hint' },
        'Only one version can be Latest, and Latest is always Active. MetaZone checks its own version against this list on every heartbeat and before every generation batch: Active keeps running, Inactive is forced to update — no “Later”.'),
      h('div', { class: 'tablewrap' }, h('table', {},
        h('thead', {}, h('tr', {}, ['Version', 'Status', 'Released', 'Update title', 'Actions'].map((x) => h('th', {}, x)))),
        rows)));
  }
  // Delete version: removes the version-control ROW only. The installer file at its download URL (Google Drive, GitHub, ...) is never touched.
  // The server refuses the Latest version, and a version people still run needs an explicit second confirmation (they would be told to update).
  function deleteVersionModal(v, force) {
    modal(force ? 'Delete a version still in use?' : 'Delete version', h('div', {},
      h('p', {}, 'Version: ', h('b', {}, v.version), v.download_url ? ' — ' + v.download_url : ''),
      h('p', {}, force ? 'Some accounts are still running this version. Deleting it makes it unregistered, so those accounts will be asked to update.' : 'Only this version-control record is removed. The installer file at its download link is NOT deleted.')),
    [{ label: 'Cancel', run: (c) => c() }, { label: force ? 'Delete anyway' : 'Delete version', cls: 'danger', run: async (c) => {
      try { await act(() => rpc('admin_delete_version', { p_version: v.version, p_force: !!force }), 'Version deleted'); }
      catch (e) {
        c();
        const m = /version_in_use:(\d+)/.exec(e.message || '');
        if (m) { toast(`${m[1]} account(s) still run ${v.version}`, true); deleteVersionModal(v, true); }
        return;
      }
      c(); go('version');
    } }]);
  }
  function versionModal(v) {
    const version = h('input', { type: 'text', id: 'ver-version', placeholder: 'v0.9.9.3', value: v ? v.version : '', disabled: !!v });
    const active = h('input', { type: 'checkbox', id: 'ver-active' }); active.checked = v ? v.is_active : true;
    const latest = h('input', { type: 'checkbox', id: 'ver-latest' }); latest.checked = v ? v.is_latest : false;
    const url = h('input', { type: 'url', id: 'ver-url', placeholder: 'https://…/MetaZone_Setup_0.9.9.6.exe  (direct installer link = in-app update)', value: v ? (v.download_url || '') : '' });
    const title = h('input', { type: 'text', id: 'ver-title', placeholder: 'What is new (short)', value: v ? (v.update_title || '') : '' });
    const features = h('textarea', { id: 'ver-features', placeholder: 'New features (one per line)' }, v ? (v.features || '') : '');
    const bugfixes = h('textarea', { id: 'ver-bugfixes', placeholder: 'Bug fixes (one per line)' }, v ? (v.bugfixes || '') : '');
    const notes = h('input', { type: 'text', id: 'ver-notes', placeholder: 'Internal notes (optional)', value: v ? (v.notes || '') : '' });
    modal(v ? `Edit ${v.version}` : 'New version', h('div', {},
      h('div', { class: 'field' }, h('label', {}, 'Version'), version),
      h('div', { class: 'row' }, h('label', {}, active, ' Active'), h('label', {}, latest, ' Latest')),
      h('div', { class: 'field' }, h('label', {}, 'Download URL'), url,
        h('p', { class: 'hint' }, 'Must be an https link to the installer .exe itself. Redirects are followed. Google Drive “Anyone with the link” share links and Dropbox share links are converted automatically. A web page (GitHub release page, a Drive folder, a landing page) opens in the user’s browser instead of updating in-app.')),
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
