/* MetaZone Admin -- static single-page app. No secrets here: every action is a database function
   (supabase/migrations) that refuses anyone who is not in admin_users. Hiding a button is cosmetic;
   the server is the authority. All dynamic text is rendered with textContent (never innerHTML). */
(() => {
  'use strict';
  const cfg = window.MZ_ADMIN_CONFIG || {};
  const ADDON = window.MZ_ADDON;                           // pure release logic (addon_logic.js)
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.publishableKey, {
    auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  // Clickjacking guard (GitHub Pages cannot send frame-ancestors headers): never render inside another site's frame.
  if (window.top !== window.self) { document.body.textContent = 'MetaZone Admin cannot be shown inside a frame.'; throw new Error('framed'); }
  const app = document.getElementById('app');
  let adminEmail = '';
  let tab = 'overview';
  let refreshTimer = null;
  let historyAddon = null;                                 // Step 2.3: which add-on's version history is shown (kept across reloads of the tab)

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
  function modal(title, body, buttons, canClose) {          // canClose (optional, Step 2.4): returns false while closing the window would lose work in progress
    const close = () => { document.removeEventListener('keydown', onKey); ov.remove(); };
    const onKey = (e) => { if (e.key === 'Escape' && (!canClose || canClose())) close(); };
    const foot = h('div', { class: 'foot' }, buttons.map((b) => h('button', {
      class: 'btn ' + (b.cls || ''), type: 'button',
      onclick: async (ev) => { ev.target.disabled = true; try { const keep = await b.run(close); if (keep === true) ev.target.disabled = false; } catch (e) { ev.target.disabled = false; } },
    }, b.label)));
    const ov = h('div', { class: 'overlay', role: 'dialog' }, h('div', { class: 'modal' }, h('h2', {}, title), body, foot));
    ov.addEventListener('mousedown', (e) => { if (e.target === ov && (!canClose || canClose())) close(); });
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
  const ADMIN_VERSION = '1.0.0';
  let closeMenu = () => {};
  const ICONS = {
    overview: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    users: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    limits: 'M3 17v2h6v-2H3zM3 5v2h10V5H3zm10 16v-2h8v-2h-8v-2h-2v6h2zM7 9v2H3v2h4v2h2V9H7zm14 4v-2H11v2h10zm-6-4h2V7h4V5h-4V3h-2v6z',
    pages: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-5 14H4v-4h11v4zm0-5H4V9h11v4zm5 5h-4V9h4v9z',
    ai: 'M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8 5.8 21.3l2.4-7.4L2 9.4h7.6z',
    payment: 'M20 4H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.11.89 2 2 2h16c1.11 0 2-.89 2-2V6c0-1.11-.89-2-2-2zm0 14H4v-6h16v6zm0-10H4V6h16v2z',
    notices: 'M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z',
    version: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
    addons: 'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5C13 2.12 11.88 1 10.5 1S8 2.12 8 3.5V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5c1.38 0 2.5-1.12 2.5-2.5S21.88 11 20.5 11z',
    addontools: 'M22 9V7h-2V5c0-1.1-.9-2-2-2H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2v-2h2v-2h-2v-2h2v-2h-2V9h2zm-4 10H4V5h14v14zM6 13h5v4H6zm6-6h4v3h-4zM6 7h5v5H6zm6 4h4v6h-4z',
    apiann: 'M3 11v2h3l5 4V7L6 11H3zm13.5 1c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
  };
  function icon(id) {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('aria-hidden', 'true');
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[id] || ICONS.overview); s.append(p); return s;
  }
  const logoImg = (cls, src) => h('img', { class: cls || '', src: src || 'assets/logo/metazone-icon.png', alt: 'MetaZone', width: '64', height: '64' });
  // Part 80: the same tabs (same ids, same screens), grouped by what the admin is doing.
  const NAV = [['Dashboard', [['overview', 'Overview']]],
               ['Pages & permissions', [['pages', 'Pages'], ['limits', 'Limits & Offers']]],
               ['Users & controls', [['users', 'Users']]],
               ['API Provider Manager', [['ai', 'API Provider Manager'], ['apiann', 'API Provider Announcements']]],
               ['Licensing', [['payment', 'Payment info']]],
               ['Publishing', [['version', 'App version'], ['addons', 'Add-ons'], ['addontools', 'Addon Tools']]],
               ['Other tools', [['notices', 'Notices']]]];
  const TABS = NAV.flatMap(([, items]) => items);
  function shell() {
    // Groups with more than one screen fold (state remembered per browser); the group holding the open screen is never hidden.
    const foldKey = 'mz_admin_nav_shut';
    let shut = []; try { shut = JSON.parse(localStorage.getItem(foldKey) || '[]'); } catch (e) { shut = []; }
    const nav = h('div', { class: 'nav' }, NAV.map(([group, items]) => {
      const btns = items.map(([id, label]) => h('button', { 'data-tab': id, title: label, class: id === tab ? 'on' : '', onclick: () => go(id) }, icon(id), h('span', {}, label)));
      if (items.length < 2) return [h('div', { class: 'nav-group' }, group), btns];
      const list = h('div', { class: 'nav-items' }, btns), head = h('div', { class: 'nav-group fold', role: 'button', tabindex: '0', 'aria-expanded': 'true' }, group);
      const apply = (isShut) => { list.classList.toggle('shut', isShut); head.classList.toggle('shut', isShut); head.setAttribute('aria-expanded', String(!isShut)); };
      const toggle = () => { const now = !list.classList.contains('shut'); apply(now); shut = shut.filter((g) => g !== group).concat(now ? [group] : []); try { localStorage.setItem(foldKey, JSON.stringify(shut)); } catch (e) { /* per-viewer convenience only */ } };
      head.addEventListener('click', toggle); head.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      apply(shut.includes(group) && !items.some(([id]) => id === tab));
      return [head, list];
    }));
    const shellEl = h('div', { class: 'shell' });
    const setMenu = (open) => { shellEl.classList.toggle('menu-open', open); const b = document.getElementById('btn-menu'); if (b) b.setAttribute('aria-expanded', String(open)); };
    closeMenu = () => setMenu(false);
    const topbar = h('div', { class: 'topbar' },
      h('button', { class: 'menu-btn', id: 'btn-menu', type: 'button', 'aria-label': 'Open menu', 'aria-expanded': 'false', onclick: () => setMenu(!shellEl.classList.contains('menu-open')) }, icon('menu')),
      logoImg('tb-logo'), h('div', { class: 'crumb', id: 'topbar-title' }), h('span', { class: 'tb-who', title: adminEmail }, adminEmail));
    shellEl.append(h('div', { class: 'scrim', onclick: closeMenu }),
      h('div', { class: 'side' },
        h('div', { class: 'brand' }, logoImg(), h('div', {}, h('b', {}, 'MetaZone'), h('small', {}, 'Admin'))),
        nav,
        h('div', { class: 'who' }, h('span', { class: 'email' }, adminEmail), h('span', { class: 'ver' }, 'Admin v' + ADMIN_VERSION),
          h('button', { class: 'btn small', id: 'btn-signout', title: 'Sign out', onclick: signOut }, 'Sign out'))),
      h('div', { class: 'stage' }, topbar, h('div', { class: 'main', id: 'main' })));
    app.replaceChildren(shellEl);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMenu(); });
    go(tab);
    refreshRequestBadge(); setInterval(refreshRequestBadge, 60000);          // V5 Part 13: pending Developer Import requests -> badge on the Addon Tools nav button (read-only call)
  }
  function setNavBadge(n) {
    const b = document.querySelector('.nav button[data-tab="addontools"]'); if (!b) return; let el = b.querySelector('.nav-badge');
    if (!(n > 0)) { if (el) el.remove(); b.title = 'Addon Tools'; return; }
    if (!el) { el = h('span', { class: 'badge premium nav-badge' }); b.append(el); }
    el.textContent = String(n); b.title = 'Addon Tools: ' + n + ' pending Developer Import request' + (n === 1 ? '' : 's');
  }
  async function refreshRequestBadge() {
    try { const s = await rpc('admin_addon_tools_developer_request_summary'); const n = Number(s && s.pending_count); setNavBadge(Number.isInteger(n) && n >= 0 ? n : 0); } catch (e) { /* 0038 not applied or offline: no badge */ }
  }
  function go(id) {
    tab = id; clearInterval(refreshTimer); closeMenu();
    const tt = document.getElementById('topbar-title');
    if (tt) { const g = NAV.find(([, its]) => its.some(([i]) => i === id)) || ['', []]; const lab = (TABS.find(([i]) => i === id) || [, ''])[1];
      tt.replaceChildren(...(g[0].toLowerCase() === lab.toLowerCase() ? [] : [h('span', { class: 'grp' }, g[0]), h('span', { class: 'sep' }, '›')]), h('b', {}, lab)); }
    const grpBtn = document.querySelector('.nav button[data-tab="' + id + '"]'); const grpList = grpBtn && grpBtn.parentElement;
    if (grpList && grpList.classList.contains('nav-items') && grpList.classList.contains('shut')) { grpList.classList.remove('shut'); if (grpList.previousElementSibling) grpList.previousElementSibling.classList.remove('shut'); }
    document.querySelectorAll('.nav button').forEach((b) => b.classList.toggle('on', b.dataset.tab === id));
    // v0.9.9.10 (Task 3 Phase A): every navigation renders into its OWN fresh #main element and swaps it in. A slower, earlier
    // load keeps a reference to its old (now detached) element, so when it finishes it can only write there -- never into the
    // tab the admin has since moved to. (Previously all loads shared one #main, so the last one to FINISH won, not the last clicked.)
    const old = document.getElementById('main');
    const main = h('div', { class: 'main', id: 'main' }, h('div', { class: 'skel' }, h('span', { class: 'spin' }), 'Loading…'));
    old.replaceWith(main);
    const page = { overview: pageOverview, users: pageUsers, limits: pageLimits, pages: pagePages, addons: pageAddons, addontools: pageAddonTools, ai: pageAi, payment: pagePayment, notices: pageNotices, apiann: pageApiAnn, version: pageVersion }[id];
    page(main).catch((e) => main.replaceChildren(h('p', { class: 'warn' }, 'Error: ' + e.message)));
  }

  // ------------------------------------------------------- Addon Tools (Part 5)
  // The new Addon Tools system (separate from the old Add-ons tab). The screen lives in addon_tools_admin.js / addon_tools_logic.js; this only hands over the
  // shared helpers so it looks and behaves like the other pages. It uses the admin's own session; the site holds no service key.
  async function pageAddonTools(main) {
    const ui = window.MZ_ADDON_TOOLS_UI;
    if (!ui || !window.MZ_ADDON_TOOLS) { main.replaceChildren(h('p', { class: 'warn' }, 'The Addon Tools screen files did not load (addon_tools_logic.js / addon_tools_admin.js).')); return; }
    await ui.mount(main, { h, rpc, toast, modal, fmt, fmtShort, sb, cfg, setNavBadge });
  }

  // -------------------------------------------------------------- overview
  // v0.9.9.6: hierarchy instead of four floating boxes -- KPI strip, then the operational panel (generations),
  // then secondary panels (accounts / subscriptions / app versions). Every number comes from admin_overview;
  // nothing is invented, and no time-series is drawn because the backend returns none.
  // Step 22A: the Adobe Tracker searches panel (admin_tracker_search_stats) was removed; Overview no longer depends on it.
  const stat = (n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l));
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
  const miniStat = (n, l, cls) => h('div', { class: 'stat ' + (cls || '') }, h('div', { class: 'n' }, num(n)), h('div', { class: 'l' }, l));
  const barRow = (label, value, of, cls, shown) => h('div', { class: 'bar ' + (cls || '') }, h('span', { class: 'bl', title: label }, label),
    h('div', { class: 'bt' }, h('i', { style: `width:${Math.min(100, pct(value, of))}%` })), h('span', { class: 'bv' }, shown != null ? shown : num(value)));
  const panel = (title, aside, ...kids) => h('div', { class: 'panel' }, h('div', { class: 'p-head' }, h('h3', {}, title), aside ? h('span', {}, aside) : null), ...kids);
  async function pageOverview(main) {
    const draw = async () => {
      const o = await rpc('admin_overview'); const u = o.users, g = o.generations, s = o.subscriptions, a = o.app;
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
              h('span', { class: g.failed ? 'warn' : '' }, h('i', { style: 'background:var(--error)' }), `Failed ${num(g.failed)} (${pct(g.failed, g.total)}%)`))))),
        h('div', { class: 'ov-cols three' },
          panel('Accounts', null, h('div', { class: 'mini' }, miniStat(u.active_today, 'Active today'), miniStat(u.expired_premium, 'Expired premium'), miniStat(u.suspended, 'Suspended'))),
          panel('Subscriptions', null, h('div', { id: 'stats-subs' }, h('div', { class: 'mini' },
            miniStat(s.active_premium, 'Active premium'), miniStat(s.expiring_soon, 'Expiring in 7 days'), miniStat(s.expired, 'Expired'), miniStat(s.recently_activated, 'Activated (7 days)')))),
          panel('Application', `Latest: ${a.latest_version || 'not set'}`, versions.length
            ? h('div', { class: 'bars', id: 'stats-versions' }, versions.slice(0, 8).map(([v, c]) => barRow(v, c, vTotal, v === a.latest_version ? 'ok' : '', `${num(c)}`)))
            : h('p', { class: 'hint', style: 'margin:0' }, 'No version data yet.'))));
    };
    await draw();
    if (!main.isConnected) return;                           // superseded by a newer navigation while loading: do not start a refresh timer
    refreshTimer = setInterval(() => { if (tab === 'overview') draw().catch(() => {}); }, 60000);
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
        ['Nickname', 'Email', 'Plan', 'Usage', 'Last seen', 'Actions'].map((c) => h('th', {}, c)))), rows)),
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
      h('p', { class: 'warn' }, 'This removes the account, its plan/subscription, usage history and other records tied to it. It cannot be undone. The person can sign in again later and gets a fresh Free account.'),
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

  // ------------------------------------------------- Step 4.3A: Dashboard Shortcuts (configuration only; the app Dashboard does not read this yet)
  // Reads get_my_dashboard_shortcuts(), edits a DRAFT in the browser, saves with admin_set_dashboard_shortcuts({ p_keys }). The list shown as
  // "saved" only ever changes after the server's answer matches what was sent; the draft never counts as saved. Needs migration 0015.
  function shortcutsCard(pageList) {
    const supported = ADDON.supportedShortcutPages(pageList);
    const info = new Map((Array.isArray(pageList) ? pageList : []).map((p) => [p.page_key, p]));
    const labelOf = (k) => (info.get(k) && info.get(k).label) || k;
    const box = h('div', { id: 'shortcuts-body' });
    const st = { phase: 'loading', saved: null, draft: null, msg: null, kind: null };   // phase: loading | ready | saving | missing | error
    const alive = () => box.isConnected;
    const say = (kind, msg) => { st.kind = kind; st.msg = msg; };

    async function load() {
      st.phase = 'loading'; say(null, null); draw();
      try {
        const keys = ADDON.parseShortcutsResult(await rpc('get_my_dashboard_shortcuts'));
        if (!alive()) return;
        if (!keys) { st.phase = 'error'; say('err', 'The server answered, but not with a shortcut list. Nothing was changed.'); }
        else { st.phase = 'ready'; st.saved = keys; st.draft = keys.slice(); }
      } catch (e) {
        if (!alive()) return;
        if (ADDON.isMissingRpcError(e.message, 'get_my_dashboard_shortcuts')) st.phase = 'missing';
        else { st.phase = 'error'; say('err', 'Could not load the shortcut list: ' + e.message); }
      }
      draw();
    }
    async function save() {
      const keys = st.draft.slice(), problems = ADDON.shortcutProblems(keys, supported);
      if (problems.length) { say('err', problems.join(' ')); draw(); return; }
      st.phase = 'saving'; say(null, 'Saving… waiting for the server to confirm.'); draw();
      const call = ADDON.shortcutsSaveCall(keys);
      try {
        const data = await rpc(call.fn, call.params);
        if (!alive()) return;
        if (ADDON.shortcutsConfirmed(data, keys)) {
          st.phase = 'ready'; st.saved = keys; st.draft = keys.slice(); say('ok', 'Saved. The server confirmed this list.'); toast('Dashboard shortcuts saved');
        } else {
          st.phase = 'error'; say('err', 'The server did not return the list that was sent, so the save is NOT confirmed. Use “Reload from server” to see what is stored.');
        }
      } catch (e) {
        if (!alive()) return;
        st.phase = ADDON.isMissingRpcError(e.message, 'admin_set_dashboard_shortcuts') ? 'missing' : 'ready';
        if (st.phase === 'ready') say('err', 'Not saved: ' + e.message + ' (If this was a network error the server may or may not have stored it: use “Reload from server”.)');
        if (st.phase === 'ready') toast('Dashboard shortcuts not saved', true);
      }
      draw();
    }
    const edit = (r) => { if (r.error) say('err', r.error); else { st.draft = r.list; say(null, null); } draw(); };
    function resetDefault() {
      const problems = ADDON.shortcutProblems(ADDON.SHORTCUT_DEFAULT, supported);
      if (problems.length) { say('err', 'The default list cannot be used here: ' + problems.join(' ')); draw(); return; }
      st.draft = ADDON.SHORTCUT_DEFAULT.slice(); say('info', 'Default list loaded into the editor. It is NOT saved until you press Save.'); draw();
    }

    function draw() {
      const kids = [];
      if (st.phase === 'loading') kids.push(h('p', { class: 'hint', 'data-state': 'loading' }, 'Loading shortcuts…'));
      else if (st.phase === 'missing') kids.push(h('p', { class: 'hint', 'data-state': 'missing' }, 'Migration 0015 (dashboard shortcuts) is not applied on this server, so the list cannot be loaded or saved. Apply 0015_dashboard_shortcuts.sql first.'));
      else if (st.phase === 'error' && !st.draft) kids.push(h('p', { class: 'hint', 'data-state': 'error' }, '⚠ ' + st.msg), h('button', { class: 'btn small', type: 'button', 'data-act': 'sc-reload', onclick: load }, 'Try again'));
      else {
        const busy = st.phase === 'saving', draft = st.draft, full = draft.length >= ADDON.SHORTCUT_MAX;
        const dirty = !ADDON.shortcutsEqual(draft, st.saved), problems = ADDON.shortcutProblems(draft, supported);
        const rows = draft.map((k, i) => {
          const req = ADDON.SHORTCUT_REQUIRED.includes(k), p = info.get(k);
          return h('li', { 'data-key': k, style: 'display:flex;align-items:center;gap:8px;padding:5px 0;flex-wrap:wrap' },
            h('span', { class: 'hint', style: 'width:1.6em' }, String(i + 1) + '.'), h('strong', {}, labelOf(k)), h('code', {}, k),
            req ? h('span', { class: 'badge' }, 'Always included') : null,
            p && p.enabled === false && !req ? h('span', { class: 'badge suspended', title: 'This page is switched off for everyone, so the app hides its button.' }, 'Page is off') : null,
            h('span', { style: 'margin-left:auto;display:flex;gap:5px' },
              h('button', { class: 'btn small', type: 'button', 'data-act': 'sc-up', disabled: busy || i === 0, title: 'Move up', onclick: () => edit(ADDON.shortcutMove(draft, k, -1)) }, '↑'),
              h('button', { class: 'btn small', type: 'button', 'data-act': 'sc-down', disabled: busy || i === draft.length - 1, title: 'Move down', onclick: () => edit(ADDON.shortcutMove(draft, k, 1)) }, '↓'),
              h('button', { class: 'btn small danger', type: 'button', 'data-act': 'sc-remove', disabled: busy || req, title: req ? 'Home and Settings cannot be removed' : 'Remove from the shortcuts', onclick: () => edit(ADDON.shortcutRemove(draft, k)) }, 'Remove')));
        });
        const choices = supported.filter((x) => !draft.includes(x.key));
        const sel = h('select', { id: 'shortcuts-add-select', disabled: busy || full || !choices.length, 'aria-label': 'Page to add' },
          choices.map((x) => h('option', { value: x.key }, `${x.label} (${x.key})`)));
        kids.push(
          h('ol', { id: 'shortcuts-list', style: 'list-style:none;margin:0 0 8px;padding:0' }, rows),
          h('div', { style: 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0' }, sel,
            h('button', { class: 'btn small', type: 'button', 'data-act': 'sc-add', disabled: busy || full || !choices.length, onclick: () => edit(ADDON.shortcutAdd(draft, sel.value, supported)) }, 'Add'),
            h('span', { class: 'hint', 'data-hint': 'sc-count' }, `${draft.length} of ${ADDON.SHORTCUT_MAX}` + (full ? ' (full)' : !choices.length ? ' (no other page to add)' : ''))),
          h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;margin-top:8px' },
            h('button', { class: 'btn primary', type: 'button', 'data-act': 'sc-save', disabled: busy || !dirty || problems.length > 0, onclick: save }, busy ? 'Saving…' : 'Save shortcuts'),
            h('button', { class: 'btn', type: 'button', 'data-act': 'sc-default', disabled: busy, onclick: resetDefault, title: 'Fills the editor with the default list; nothing is saved until you press Save' }, 'Reset to default'),
            h('button', { class: 'btn ghost', type: 'button', 'data-act': 'sc-reload', disabled: busy, onclick: load }, 'Reload from server')),
          dirty && !busy ? h('p', { class: 'hint', 'data-state': 'dirty' }, 'Unsaved changes.') : null,
          problems.length ? h('p', { class: 'hint', 'data-state': 'problems' }, '⚠ ' + problems.join(' ')) : null);
      }
      if (st.msg && st.phase !== 'loading') kids.push(h('p', { class: 'hint', 'data-state': st.kind || 'info', role: st.kind === 'err' ? 'alert' : 'status' }, (st.kind === 'ok' ? '✓ ' : st.kind === 'err' ? '⚠ ' : '') + st.msg));
      box.replaceChildren(...kids);
    }
    load();
    return h('div', { class: 'card', id: 'shortcuts-card', style: 'margin:14px 0' },
      h('h3', {}, 'Dashboard Shortcuts'),
      h('p', { class: 'hint' }, `The buttons of the app's Dashboard (up to ${ADDON.SHORTCUT_MAX}, in this order). Home and Settings always stay. A page that is switched off for a user is hidden for that user. This only saves the list on the server: the app's Dashboard does not use it yet.`),
      box);
  }

  // ------------------------------------------------------------------ pages
  // v0.9.9.4: switch the app's pages on/off -- for everyone (this tab) or for one user (Users -> Pages).
  // A per-user setting beats the global one. Home and Settings are locked (always on). The app hides a
  // switched-off page; for the three AI pages (Meta, Image to Prompt, Prompt-to-Prompt) the server also
  // refuses their generation batches.
  async function pagePages(main) {
    const list = await rpc('admin_list_pages');
    // Step 4.B (migration 0016): where a page shows. null = the server has no 0016 yet (the placement controls then say so).
    let placement = null;
    try { placement = ADDON.parsePlacement(await rpc('admin_list_page_placement')); } catch (e) { placement = null; }
    // v0.9.9.9: every page has a Free switch and a Premium switch (migration 0011). A page reaches a user when the "Everyone" master
    // switch is on AND the switch for the user's plan is on -- unless you forced it on/off for that one account (Users -> Pages), which wins.
    const planBtn = (p, plan) => {
      const key = plan === 'free' ? 'enabled_free' : 'enabled_premium', on = p[key] !== false;
      if (p.locked || p.protected || ADDON.isProtectedPage(p.page_key)) return 'Always on';
      return h('button', { class: 'btn small' + (on ? '' : ' danger'), 'data-act': 'plan-' + plan, title: `${on ? 'Switch off' : 'Switch on'} for ${plan} accounts`, onclick: async () => {
        const go2 = async () => { await act(() => rpc('admin_set_page_plan_access', { p_key: p.page_key, p_free: plan === 'free' ? !on : null, p_premium: plan === 'premium' ? !on : null }), `${p.label}: ${plan} ${on ? 'off' : 'on'}`); go('pages'); };
        if (on) confirmBox(`Switch ${p.label} off for ${plan} users?`, `Every ${plan} account loses it, except accounts you have forced it ON for (Users → Pages). Their data is not touched.`, 'Switch off', go2); else go2();
      } }, h('span', { class: 'dot' + (on ? ' on' : '') }), on ? 'On' : 'Off');
    };
    // Left navigation = PLACEMENT only. Hiding a page here does not disable it (use "Turn off for everyone" for that) and does not touch
    // the Dashboard shortcuts, which are configured separately above.
    const navCell = (p) => {
      if (p.kind !== 'page') return '—';
      if (placement === null) return h('span', { class: 'hint', 'data-state': 'missing', title: 'Apply migration 0016 first' }, 'needs 0016');
      const pl = placement[p.page_key];
      if (!pl) return '—';
      if (p.locked || p.protected || pl.protected) return 'Always shown';
      const on = pl.nav_visible;
      return h('button', { class: 'btn small' + (on ? '' : ' danger'), 'data-act': 'nav', title: on ? 'Remove from the left navigation (the page stays available)' : 'Show in the left navigation',
        onclick: async () => {
          const call = ADDON.navVisibleCall(p.page_key, !on);
          try { const data = await rpc(call.fn, call.args); if (!ADDON.navConfirmed(data, p.page_key, !on)) throw new Error('The server did not confirm the change.'); toast(`${p.label}: ${on ? 'hidden from' : 'shown in'} the left navigation`); }
          catch (e) { toast('Not changed: ' + e.message, true); }
          go('pages');
        } }, h('span', { class: 'dot' + (on ? ' on' : '') }), on ? 'Shown' : 'Hidden');
    };
    const hints = {};      // Tracker is a normal built-in page (migration 0020); no page needs an extra note
    const pageRow = (p) => h('tr', { 'data-page': p.page_key },
      h('td', {}, p.label, hints[p.page_key] ? h('div', { class: 'hint', 'data-hint': p.page_key }, hints[p.page_key]) : null), h('td', {}, h('code', {}, p.page_key)),
      h('td', { 'data-col': 'free' }, planBtn(p, 'free')),
      h('td', { 'data-col': 'premium' }, planBtn(p, 'premium')),
      h('td', {}, h('span', { class: 'dot' + (p.enabled || p.locked ? ' on' : '') }), p.locked || p.protected ? 'Always on (protected)' : (p.enabled ? 'On' : 'Off for everyone')),
      h('td', { 'data-col': 'nav' }, navCell(p)),
      h('td', {}, p.overrides_on || p.overrides_off
        ? [p.overrides_on ? h('span', { class: 'badge', style: 'margin-right:6px' }, `${p.overrides_on} forced on`) : null,
           p.overrides_off ? h('span', { class: 'badge suspended' }, `${p.overrides_off} forced off`) : null]
        : '—'),
      h('td', { 'data-col': 'changed', class: 'hint' }, p.updated_at ? [fmtShort(p.updated_at), p.updated_by_email ? h('div', {}, p.updated_by_email) : null] : '—'),
      h('td', { class: 'actions' }, p.locked || p.protected ? '—' :
        h('button', { class: 'btn small' + (p.enabled ? ' danger' : ''), 'data-act': 'toggle', onclick: async () => {
          const go2 = async () => { await act(() => rpc('admin_set_page_enabled', { p_key: p.page_key, p_enabled: !p.enabled }), `${p.label} turned ${p.enabled ? 'off' : 'on'}`); go('pages'); };
          if (p.enabled) confirmBox(`Turn off ${p.label} for everyone?`, 'It disappears for every user, whatever their plan - including accounts you forced it ON for. Their data is not touched.', 'Turn off', go2); else go2();
        } }, p.enabled ? 'Turn off for everyone' : 'Turn on')));
    const table = (id, items) => h('div', { class: 'tablewrap' }, h('table', {},
      h('thead', {}, h('tr', {}, ['Page', 'Key', 'Free plan', 'Premium plan', 'Everyone', 'Left navigation', 'Per-user exceptions', 'Last changed', 'Actions'].map((x) => h('th', {}, x)))),
      h('tbody', { id }, items.map(pageRow))));
    const groups = ADDON.groupPages(list);                   // v0.9.9.10 (0012): 'Pages' and 'Add-on features'; 'settings' is never shown
    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', {}, 'Pages')),
      h('p', { class: 'hint' }, 'Choose which plan gets each page: the Free and Premium switches are independent (for example Tracker: Free off, Premium on). The “Everyone” switch is a master switch: when it is OFF the page is gone for ALL accounts, even ones you forced it on for. While it is ON, you can give or take a page for ONE account whatever its plan (Users → Pages): that exception beats the Free/Premium switches. Home and Settings can never be switched off (protected). Users see the change within a few minutes (next heartbeat), or right away on their next generation attempt.'),
      shortcutsCard(list),
      registerPageCard(list, placement),
      h('h3', { id: 'grp-pages' }, 'Pages'), table('page-rows', groups.pages),
      h('h3', { id: 'grp-addons', style: 'margin-top:22px' }, 'Add-on features'),
      h('p', { class: 'hint' }, 'These control who can download and use each add-on. Free users still see locked add-ons in the app, with Download disabled.'),
      table('addon-rows', groups.addons),
      h('h3', { id: 'grp-audit', style: 'margin-top:22px' }, 'Recent changes'),
      h('p', { class: 'hint' }, 'The last page and add-on-version changes: who, what, when.'),
      h('div', { id: 'control-audit' }, h('p', { class: 'hint' }, 'Loading…')));
    loadAudit(main.querySelector('#control-audit'));         // this navigation's own box (a global lookup could hit a newer Pages screen)
  }
  // Step 4.B: create the page switch for an add-on page (no developer migration). The page starts OFF for everyone; publishing the add-on
  // package (Add-ons) and turning the page on are separate, explicit steps. Core page keys are refused here and again by the server.
  function registerPageCard(list, placement) {
    const existing = (Array.isArray(list) ? list : []).map((p) => p && p.page_key).filter(Boolean);
    const key = h('input', { id: 'reg-key', type: 'text', maxlength: '32', placeholder: 'page_key (a-z, 0-9, _)', 'aria-label': 'Page key', autocomplete: 'off', spellcheck: 'false' });
    const label = h('input', { id: 'reg-label', type: 'text', maxlength: '40', placeholder: 'Label shown in the Admin', 'aria-label': 'Page label', autocomplete: 'off' });
    const msg = h('p', { class: 'hint', id: 'reg-msg', 'aria-live': 'polite' }, '');
    const btn = h('button', { class: 'btn primary', type: 'button', 'data-act': 'register-page', onclick: async () => {
      const problems = ADDON.registerPageProblems(key.value, label.value, existing);
      if (problems.length) { msg.textContent = problems.join(' '); return; }
      const call = ADDON.registerPageCall(key.value, label.value);
      btn.disabled = true; msg.textContent = 'Registering…';
      try {
        const data = await rpc(call.fn, call.args);
        if (!ADDON.registerConfirmed(data, key.value)) throw new Error('The server did not confirm the registration.');
        toast(`Page ${key.value} registered (off until you turn it on)`); go('pages'); return;
      } catch (e) {
        msg.textContent = ADDON.isMissingRpcError(e.message, 'admin_register_page') ? 'Migration 0016 is not applied on this server, so pages cannot be registered. Apply 0016_page_registry_and_nav.sql first.' : 'Not registered: ' + e.message;
        btn.disabled = false;
      }
    } }, 'Register page');
    return h('div', { class: 'card', id: 'register-page-card', style: 'margin:14px 0' },
      h('h3', {}, 'Register an add-on page'),
      h('p', { class: 'hint' }, 'Creates the page switch an add-on needs before its package can be published (Add-ons → feature key). The page starts OFF for everyone. Built-in page keys are refused. Where it appears (Dashboard shortcuts, left navigation) is configured separately.'),
      placement === null ? h('p', { class: 'hint', 'data-state': 'missing' }, 'Migration 0016 does not seem to be applied on this server yet.') : null,
      h('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;align-items:center' }, key, label, btn), msg);
  }
  async function loadAudit(box) {
    if (!box) return;
    try {
      const rowsA = await rpc('admin_list_control_audit', { p_limit: 30 });
      box.replaceChildren(rowsA.length ? h('ul', { class: 'checks' }, rowsA.map((a) => h('li', {}, h('span', { class: 'hint' }, fmtShort(a.at) + ' '), ADDON.auditLine(a)))) : h('p', { class: 'hint' }, 'No changes recorded yet.'));
    } catch (e) { box.replaceChildren(h('p', { class: 'hint' }, 'Could not load recent changes (apply migration 0013).')); }
  }
  async function userPagesModal(u) {
    const body = h('div', { id: 'user-pages' });
    const rowFor = (p) => {
      const prot = p.locked || p.protected || ADDON.isProtectedPage(p.page_key);
      const sel = h('select', { 'data-page': p.page_key, disabled: prot },
        [['', 'Follow plan'], ['on', 'Force on'], ['off', 'Force off']].map(([v, l]) => h('option', { value: v }, l)));
      sel.value = p.override === true ? 'on' : p.override === false ? 'off' : '';
      sel.addEventListener('change', async () => {
        try {
          render(await act(() => rpc('admin_set_user_page', { p_user: u.id, p_key: p.page_key, p_enabled: sel.value === '' ? null : sel.value === 'on' }), `${p.label} updated`));
        } catch (e) { /* act() already toasted */ }
      });
      return h('tr', { 'data-page': p.page_key }, h('td', {}, p.label),
        h('td', {}, prot ? 'Always on (protected)' : p.global_enabled === false ? 'Off for everyone' : (p.plan_enabled === undefined ? (p.global_enabled ? 'On' : 'Off') : (p.plan_enabled ? 'On' : 'Off') + ' (' + p.plan + ')')),
        h('td', {}, prot ? '—' : sel, !prot && p.global_enabled === false ? h('div', { class: 'hint', 'data-hint': 'global-off' }, 'Off for everyone: this setting has no effect until the page is turned back on.') : null),
        h('td', {}, h('span', { class: 'badge' + (p.effective ? '' : ' suspended') }, p.effective ? 'Enabled' : 'Disabled')));
    };
    const tbl = (items) => h('div', { class: 'tablewrap' }, h('table', { style: 'min-width:0' },
      h('thead', {}, h('tr', {}, ['Page', 'Their plan gives', 'This user', 'Result'].map((x) => h('th', {}, x)))), h('tbody', {}, items.map(rowFor))));
    const render = (list) => { const g = ADDON.groupPages(list); body.replaceChildren(
      h('p', { class: 'hint' }, 'Force a page on or off for just this account, whatever its plan. “Follow plan” removes the exception and the page follows the Free/Premium switches again. A page that is OFF for everyone stays off whatever is set here.'),
      h('h3', {}, 'Pages'), tbl(g.pages),
      g.addons.length ? h('div', {}, h('h3', { style: 'margin-top:16px' }, 'Add-on features'),
        h('p', { class: 'hint' }, 'Who can download and use each add-on. Free users still see locked add-ons in the app.'), tbl(g.addons)) : null); };
    render(await act(() => rpc('admin_get_user_pages', { p_user: u.id })));
    modal(`Pages — ${u.email}`, body, [
      { label: 'Reset all to global', run: async () => { render(await act(() => rpc('admin_reset_user_pages', { p_user: u.id }), 'Reset to global')); return true; } },
      { label: 'Close', run: (c) => c() }]);
  }

  // ----------------------------------------------------------------- add-ons
  // v0.9.9.10 (0012): signed add-on packages (.mzaddon) live in the PRIVATE Storage bucket 'addons'. Publishing = (1) check the package against its
  // release.json sidecar in the browser, (2) upload with the admin's OWN session (Storage policy: admins only), (3) admin_publish_addon.
  // Who may download is NOT decided here: it is the add-on's feature switch under Pages -> Add-on features. A published release is immutable; to
  // change a package publish a new version (higher seq). The app still verifies the signed manifest + SHA-256, so Storage is only transport.
  async function pageAddons(main) {
    const [releases, pageList, selections, managed, upcoming] = await Promise.all([rpc('admin_list_addon_releases'), rpc('admin_list_pages'),
      rpc('admin_get_addon_selection').catch(() => []),                    // [] on a server without migration 0013
      rpc('admin_list_addons').then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: e.message })),   // Step 2.1 (0014): never breaks the tab
      rpc('admin_list_upcoming_features').then((data) => ({ ok: true, data }), (e) => ({ ok: false, error: e.message }))]);   // v1.0.0 (0024): same rule
    const known = { featureKeys: new Set(pageList.map((p) => p.page_key)) };
    const rows = h('tbody', { id: 'addon-release-rows' }, releases.map((r) => h('tr', { 'data-addon': r.addon_id, 'data-version': r.version, 'data-yanked': r.yanked ? '1' : '0' },
      h('td', {}, h('b', {}, r.title || r.addon_id), h('div', {}, h('code', {}, r.addon_id))),
      h('td', {}, r.version, r.channel !== 'stable' ? h('span', { class: 'badge', style: 'margin-left:6px' }, r.channel) : null),
      h('td', {}, String(r.seq)), h('td', {}, ADDON.fmtBytes(r.size)),
      h('td', {}, h('code', { title: r.sha256 || '' }, ADDON.shortHash(r.sha256))),
      h('td', {}, fmtShort(r.published_at)), h('td', {}, h('code', {}, r.feature_key)),
      h('td', {}, r.yanked ? h('span', { class: 'badge suspended' }, 'Yanked') : r.is_active ? h('span', { class: 'badge ok', 'data-active': '1' }, 'Active') : h('span', { class: 'badge' }, 'Published')),
      h('td', { class: 'actions' }, r.is_active ? null : (() => {
        const why = ADDON.activateBlock(r), sel = ADDON.selectionFor(selections, r.addon_id);
        return h('button', { class: 'btn small primary', 'data-act': 'activate', disabled: !!why, title: why || 'Offer this version to users', onclick: () => confirmBox(`Make ${r.addon_id} ${r.version} the active version?`,
          'Apps move to this version (older ones too) the next time they check in, about every 5 minutes, and it starts after their next restart. If a version fails to start, the app keeps its last known good one.', 'Make active',
          async () => { await act(() => rpc('admin_set_addon_active', { p_addon: r.addon_id, p_version: r.version, p_expected_revision: sel ? sel.revision : null }), `${r.addon_id} ${r.version} is now active`); go('addons'); }) }, 'Make active');
      })(), r.yanked
        ? h('button', { class: 'btn small', 'data-act': 'restore', onclick: async () => { await act(() => { const c = ADDON.selectionCall.yank(r.addon_id, r.version, false, (ADDON.selectionFor(selections, r.addon_id) || {}).revision); return rpc(c.fn, c.params); }, `${r.addon_id} ${r.version} restored`); go('addons'); } }, 'Restore')
        : h('button', { class: 'btn small danger', 'data-act': 'yank', onclick: () => confirmBox(`Yank ${r.addon_id} ${r.version}?`,
            'Users can no longer download this release. If it is the ACTIVE version, users are offered nothing until you choose another one (nothing is chosen for you), and apps running it stop it and use their last known good version. The file is kept; Restore never makes it active.', 'Yank',
            async () => { await act(() => { const c = ADDON.selectionCall.yank(r.addon_id, r.version, true, (ADDON.selectionFor(selections, r.addon_id) || {}).revision); return rpc(c.fn, c.params); }, `${r.addon_id} ${r.version} yanked`); go('addons'); }) }, 'Yank')))));

    // ---- per add-on: which version is active + Automatic / Restore previous
    function selectionPanels() {
      const ids = [...new Set(releases.map((r) => r.addon_id))];
      if (!ids.length || !selections.length) return null;
      return ids.map((id) => {
        const sel = ADDON.selectionFor(selections, id), d = ADDON.describeSelection(sel), rev = sel ? sel.revision : null;
        const title = (releases.find((r) => r.addon_id === id) || {}).title || id;
        const call = (fn, params, msg) => async () => { await act(() => rpc(fn, params), msg); go('addons'); };
        return h('div', { class: 'card', 'data-addon-sel': id, style: 'margin-bottom:10px' },
          h('p', { style: 'margin:0 0 4px' }, h('b', {}, title), ' ', h('code', {}, id), ' — ', h('span', { class: 'badge' + (d.warn ? ' suspended' : ' ok'), 'data-kind': d.kind }, d.label)),
          d.warn ? h('p', { class: 'warn', style: 'margin:0 0 6px' }, d.warn) : null,
          sel && sel.updated_at ? h('p', { class: 'hint', style: 'margin:0 0 6px' }, `Last changed ${fmtShort(sel.updated_at)}${sel.updated_by_email ? ' by ' + sel.updated_by_email : ''}`) : null,
          h('div', { class: 'row' },
            sel && sel.mode !== 'auto' ? h('button', { class: 'btn small', 'data-act': 'auto', title: 'Offer the newest eligible release automatically', onclick: () => confirmBox(`Switch ${id} to Automatic?`, 'Users are offered the newest eligible release, including future ones, as soon as you publish them.', 'Automatic', call('admin_clear_addon_active', { p_addon: id, p_expected_revision: rev }, `${id}: automatic`)) }, 'Automatic (newest)') : null,
            sel && sel.previous_version ? h('button', { class: 'btn small', 'data-act': 'restore-previous', disabled: !!sel.previous_block_reason, title: sel.previous_block_reason || `Go back to v${sel.previous_version}`,
              onclick: call('admin_restore_previous_addon_active', { p_addon: id, p_expected_revision: rev }, `${id}: restored previous selection`) }, `Restore previous selection (v${sel.previous_version})`) : null));
      });
    }

    // ---- Step 2.1: Add-on manager list (real admin_list_addons() data). Step 2.2 adds create / edit of name + description (admin_upsert_addon).
    function managerPanel() {
      const box = h('div', { class: 'card', id: 'addon-manager', style: 'margin-bottom:20px' }, h('h3', {}, 'Add-on manager'));
      if (!managed.ok) {
        const missing = ADDON.isMissingRpcError(managed.error, 'admin_list_addons');
        box.append(h('p', { class: 'warn', id: 'addon-manager-error', 'data-missing': missing ? '1' : '0' }, missing
          ? 'The add-on list is not available on this server: database migration 0014 has not been applied yet. The release table below works as before.'
          : 'Could not load the add-on list: ' + managed.error));
        return box;
      }
      const list = ADDON.describeManagedAddons(managed.data), sum = ADDON.summarizeManagedAddons(list);

      // ---- Step 2.2: create / edit name + description through the REAL admin_upsert_addon(p_addon, p_name, p_description).
      // The RPC is an upsert: it would silently overwrite an existing id. So the id is checked against the list here, AND against a fresh
      // admin_list_addons() read right before saving (the list on screen may be stale). Only name + description are written; no release,
      // selection, Storage object, signing key or forced-update setting is touched.
      function addonForm(mode, a) {
        const creating = mode === 'create';
        const idIn = h('input', { type: 'text', id: 'addon-form-id', autocomplete: 'off', spellcheck: 'false', placeholder: 'e.g. sample_addon', value: creating ? '' : a.id, readonly: !creating });
        const nameIn = h('input', { type: 'text', id: 'addon-form-name', autocomplete: 'off', value: creating ? '' : a.name });
        const descIn = h('textarea', { id: 'addon-form-description' }, creating ? '' : a.description);
        const err = (k) => h('div', { class: 'warn', 'data-err': k, style: 'display:none;margin-top:4px' });
        const errEls = { id: err('id'), name: err('name'), description: err('description'), form: h('p', { class: 'warn', id: 'addon-form-error', 'data-err': 'form', style: 'display:none' }) };
        const show = (errors) => { for (const k of Object.keys(errEls)) { const m = errors && errors[k]; errEls[k].textContent = m || ''; errEls[k].style.display = m ? '' : 'none'; } };
        const body = h('div', { id: 'addon-form' },
          creating ? null : h('p', { class: 'hint' }, a.registered ? 'The id cannot be changed.' : 'This add-on has releases but no name/description record yet. Saving creates that record.'),
          h('div', { class: 'field' }, h('label', { for: 'addon-form-id' }, 'Add-on id'), idIn, errEls.id,
            creating ? h('div', { class: 'hint' }, 'Lowercase letters a-z, digits 0-9 and underscore, 1 to 32 characters. Cannot be changed later. Use the same id as the add-on package.') : null),
          h('div', { class: 'field' }, h('label', { for: 'addon-form-name' }, 'Name (required, up to 80 characters)'), nameIn, errEls.name),
          h('div', { class: 'field' }, h('label', { for: 'addon-form-description' }, 'Description (optional, up to 400 characters)'), descIn, errEls.description),
          errEls.form,
          h('p', { class: 'hint' }, 'Saving writes only the name and description. It does not publish, activate or change any release, and it does not add the add-on to the MetaZone app (the app only offers add-ons it already knows by id).'));
        const fail = (msg) => { show({ form: msg }); toast(msg, true); return true; };     // true = keep the window open
        const save = async (close) => {
          show(null);
          const draft = { id: idIn.value, name: nameIn.value, description: descIn.value };
          let chk = ADDON.checkAddonDraft(draft, mode, list);
          if (!chk.ok) { show(chk.errors); return true; }
          let fresh;
          try { fresh = ADDON.describeManagedAddons(await rpc('admin_list_addons')); }               // never overwrite blindly: re-read the real list first
          catch (e) { return fail('Could not check the current add-on list, nothing was saved: ' + e.message); }
          chk = ADDON.checkAddonDraft(draft, mode, fresh);
          if (!chk.ok) { show(chk.errors); return true; }
          let saved;
          try { saved = await rpc('admin_upsert_addon', chk.params); }
          catch (e) { return fail(ADDON.isMissingRpcError(e.message, 'admin_upsert_addon') ? 'Not saved: database migration 0014 has not been applied on this server yet.' : 'Not saved: ' + e.message); }
          if (!ADDON.savedRowMatches(saved, chk.params.p_addon)) return fail('The server did not confirm the save. Close this window, refresh the list and check before trying again.');
          close();
          toast(`Add-on “${chk.params.p_name}” (${chk.params.p_addon}) ${creating ? 'created' : (a.registered ? 'updated' : 'registered')}`);
          go('addons');                                                                                 // reload the list from the server
          return false;
        };
        modal(creating ? 'New add-on' : `Edit add-on: ${a.id}`, body, [{ label: 'Cancel', run: (c) => c() }, { label: creating ? 'Create add-on' : 'Save changes', cls: 'primary', run: save }]);
      }

      const body = list.map((a) => h('tr', { 'data-addon': a.id },
        h('td', {}, h('b', {}, a.name), h('div', {}, h('code', {}, a.id)), a.description ? h('div', { class: 'hint' }, a.description) : null),
        h('td', {}, a.featureKey ? h('code', {}, a.featureKey) : '—'),
        h('td', {}, `${a.releases.total} release${a.releases.total === 1 ? '' : 's'}`,
          a.releases.yanked ? h('div', { class: 'hint' }, `${a.releases.yanked} yanked`) : null,
          a.releases.deleted ? h('div', { class: 'hint' }, `${a.releases.deleted} deleted`) : null),
        h('td', {}, a.latestVersion || '—'),
        h('td', {}, h('span', { class: 'badge' + (a.offered.version ? ' ok' : ''), 'data-kind': a.offered.kind }, a.offered.label), a.offered.warn ? h('div', { class: 'hint' }, a.offered.warn) : null),
        h('td', {}, a.registered ? h('span', { class: 'badge ok' }, 'Registered') : h('span', { class: 'badge', title: 'Releases exist but there is no name/description record for this add-on yet' }, 'Not registered')),
        h('td', {}, fmtShort(a.updatedAt)),
        h('td', { class: 'actions' },
          a.releases.total > 0 ? h('button', { class: 'btn small', type: 'button', 'data-act': 'show-versions', title: 'Show the version history of this add-on', onclick: () => showHistory(a.id) }, 'Versions') : null,
          h('button', { class: 'btn small', type: 'button', 'data-act': 'edit-addon', title: a.registered ? 'Edit the name and description' : 'Add a name and description record for this add-on', onclick: () => addonForm('edit', a) }, a.registered ? 'Edit' : 'Register'),
          (() => { const why = ADDON.deleteAddonBlock(a.offered.version);       // Step 2.7: the server refuses an offered add-on; the button says why
            return h('button', { class: 'btn small danger', type: 'button', 'data-act': 'delete-addon', disabled: !!why, title: why || 'Permanently delete this add-on, all its versions and their package files', onclick: () => deleteAddonDialog(a) }, 'Delete'); })())));
      box.replaceChildren(h('div', { class: 'toolbar', style: 'margin-bottom:8px' }, h('h3', { style: 'margin:0 auto 0 0' }, 'Add-on manager'),
        h('button', { class: 'btn small primary', type: 'button', id: 'btn-addon-new', onclick: () => addonForm('create') }, 'New add-on')));
      box.append(
        h('p', { class: 'hint', id: 'addon-manager-summary' }, `${sum.total} add-on${sum.total === 1 ? '' : 's'} · ${sum.offered} offered to users · ${sum.notOffered} not offered.`),
        h('div', { class: 'tablewrap' }, h('table', { id: 'addon-manager-table' }, h('thead', {}, h('tr', {}, ['Add-on', 'Feature key', 'Releases', 'Latest', 'Offered to users', 'Registry', 'Updated', ''].map((x) => h('th', {}, x)))),
          h('tbody', { id: 'addon-manager-rows' }, list.length ? body : h('tr', {}, h('td', { colspan: '8' }, 'No add-ons yet.'))))),
        h('p', { class: 'hint' }, 'The MetaZone app only offers add-ons it already knows by id; a record here does not add a new add-on to the app.'));
      return box;
    }

    // ---- Step 2.3: version history of one add-on + release selection, on the EXISTING functions only.
    // History = admin_list_addon_releases(); selection = admin_get_addon_selection() (its `revision` is sent as p_expected_revision, so the
    // server refuses a change made on stale data: "stale: ..."). Deactivate = admin_withdraw_addon (0014, same revision check).
    // Step 8: Yank / Restore send the same p_expected_revision (admin_yank_addon, 0017) when a selection exists. Authorization stays on the server
    // (_require_admin in every function); nothing here decides who may do what. No package download / replacement / deletion in this step.
    const managedList = managed.ok ? ADDON.describeManagedAddons(managed.data) : [];
    function historyPanel() {
      const box = h('div', { class: 'card', id: 'addon-history', style: 'margin-bottom:20px' });
      const ids = [...new Set(releases.map((r) => r.addon_id))].sort();
      if (!ids.length) { box.append(h('h3', {}, 'Version history'), h('p', { class: 'hint', id: 'addon-history-empty' }, 'No releases published yet.')); return box; }
      if (!ids.includes(historyAddon)) historyAddon = ids[0];
      const nameOf = (id) => { const m = managedList.find((a) => a.id === id); return m ? m.name : ((releases.find((r) => r.addon_id === id) || {}).title || id); };
      const pick = h('select', { id: 'addon-history-select', 'aria-label': 'Add-on' }, ids.map((id) => h('option', { value: id }, `${nameOf(id)} (${id})`)));
      pick.value = historyAddon;
      const body = h('div', { id: 'addon-history-body' });
      const draw = () => { pick.value = historyAddon; body.replaceChildren(historyBody(historyAddon)); };
      pick.addEventListener('change', () => { historyAddon = pick.value; draw(); });
      box.append(h('div', { class: 'toolbar', style: 'margin-bottom:8px' }, h('h3', { style: 'margin:0 auto 0 0' }, 'Version history'), pick), body);
      box.redraw = draw; draw();
      return box;
    }
    function showHistory(id) { historyAddon = id; const b = document.getElementById('addon-history'); if (b && b.redraw) { b.redraw(); b.scrollIntoView({ block: 'start' }); } }

    function historyBody(id) {
      const v = ADDON.describeVersionHistory(id, releases, selections, managedList.find((a) => a.id === id) || null), st = v.state, rev = st.revision;
      const missing0014 = !managed.ok && ADDON.isMissingRpcError(managed.error, 'admin_list_addons');
      // Run one of the existing functions. A server refusal is shown as it is; a "stale" refusal also reloads the tab so the admin sees
      // what the other admin did. A function that does not exist on this server (migration not applied) gets a plain explanation.
      const exec = async (c, okMsg) => {
        try {
          await act(async () => {                                          // act() shows the message, so the explanation has to be created inside it
            try { return await rpc(c.fn, c.params); }
            catch (e) { if (ADDON.isMissingRpcError(e.message, c.fn)) throw new Error(`${c.fn} is not available on this server: the database migration that adds it has not been applied yet.`); throw e; }
          }, okMsg);
        } catch (e) { if (ADDON.isStaleError(e.message)) go('addons'); throw e; }
        go('addons');
      };
      const doRun = (c, okMsg) => async (ev) => { const b = ev.currentTarget; b.disabled = true; try { await exec(c, okMsg); } catch (e) { if (b.isConnected) b.disabled = false; } };
      const ask = (title, text, label, c, okMsg) => confirmBox(title, text, label, async () => { try { await exec(c, okMsg); } catch (e) { if (ADDON.isStaleError(e.message)) return; throw e; } });
      const badge = (b) => h('span', { class: 'badge' + (b.kind === 'ok' ? ' ok' : b.kind === 'warn' ? ' suspended' : ''), title: b.title || null, 'data-state': b.label }, b.label);
      const stateBad = st.warn || st.kind === 'unknown' ? 'suspended' : 'ok';

      const rows = v.rows.map((r) => h('tr', { 'data-version': r.version, 'data-yanked': r.yanked ? '1' : '0', 'data-offered': r.offered ? '1' : '0', 'data-chosen': r.chosen ? '1' : '0' },
        h('td', {}, h('div', { style: 'min-width:0;overflow-wrap:anywhere' },                      // ONE child, so the phone card layout (flex) keeps it together
          h('b', {}, r.version), r.channel !== 'stable' ? h('span', { class: 'badge', style: 'margin-left:6px' }, r.channel) : null,
          r.title && r.title !== v.name ? h('div', { class: 'hint' }, r.title) : null,
          r.summary ? h('div', { class: 'hint' }, r.summary) : null,
          r.note ? h('div', { class: 'hint', 'data-role': 'block-reason' }, r.note) : null,
          r.notes.length ? h('details', {}, h('summary', { class: 'hint' }, 'Release notes'), r.notes.map(([t, lines]) => h('div', {}, h('b', { class: 'hint' }, t), h('ul', {}, lines.map((x) => h('li', {}, x)))))) : null)),
        h('td', {}, h('span', { class: 'badges', style: 'flex-wrap:wrap' }, r.badges.map(badge))),
        h('td', {}, String(r.seq)), h('td', {}, ADDON.fmtBytes(r.size)),
        h('td', {}, h('code', { title: r.sha256 || '' }, ADDON.shortHash(r.sha256))),
        h('td', {}, fmtShort(r.publishedAt)),
        h('td', {}, r.minCore || r.maxCore ? `${r.minCore || 'any'} to ${r.maxCore || 'any'}` : 'any'),
        h('td', { class: 'actions' },
          r.activate.show ? h('button', { class: 'btn small primary', type: 'button', 'data-act': 'hist-activate', disabled: !!r.activate.block, title: r.activate.block || 'Offer this version to users',
            onclick: () => ask(`Make ${id} ${r.version} the active version?`,
              'Apps move to this version (older ones too) the next time they check in, about every 5 minutes, and it starts after their next restart. If a version fails to start, the app keeps its last known good one.', 'Make active',
              ADDON.selectionCall.activate(id, r.version, rev), `${id} ${r.version} is now active`) }, 'Make active') : null,
          r.canRestore ? h('button', { class: 'btn small', type: 'button', 'data-act': 'hist-restore', title: 'Make it downloadable again (it does not become active)', onclick: doRun(ADDON.selectionCall.yank(id, r.version, false, rev), `${id} ${r.version} restored`) }, 'Restore')
            : h('button', { class: 'btn small danger', type: 'button', 'data-act': 'hist-yank', onclick: () => ask(`Yank ${id} ${r.version}?`,
              'Users can no longer download this release. If it is the ACTIVE version, users are offered nothing until you choose another one (nothing is chosen for you), and apps running it stop it and use their last known good version. The file is kept; Restore never makes it active.', 'Yank',
              ADDON.selectionCall.yank(id, r.version, true, rev), `${id} ${r.version} yanked`) }, 'Yank'),
          // Step 2.4: package download (short-lived signed URL, admin session) and replacement (never the active / offered version)
          h('button', { class: 'btn small', type: 'button', 'data-act': 'hist-download', disabled: !r.storagePath, title: r.storagePath ? 'Download the package file (admin-only link, valid for 60 seconds)' : 'This release has no package path',
            onclick: (ev) => downloadPackage(id, r, ev.currentTarget) }, 'Download'),
          h('button', { class: 'btn small', type: 'button', 'data-act': 'hist-replace', disabled: !!(missing0014 || r.replace.block),
            title: missing0014 ? 'Needs database migration 0014, which has not been applied on this server yet.' : (r.replace.block || 'Replace the package file of this version (not offered to users right now)'),
            onclick: () => replaceDialog(id, r) }, 'Replace package'),
          // Step 2.5: delete this version (never the ACTIVE / offered one: the server refuses it, and the button says why)
          h('button', { class: 'btn small danger', type: 'button', 'data-act': 'hist-delete', disabled: !!(missing0014 || r.del.block),
            title: missing0014 ? 'Needs database migration 0014, which has not been applied on this server yet.' : (r.del.block || 'Permanently delete this version and its package file'),
            onclick: () => deleteReleaseDialog(id, r, rev) }, 'Delete'))));

      const c = v.controls;
      const controls = h('div', { class: 'row', id: 'addon-history-controls' },
        c.auto.show ? h('button', { class: 'btn small', type: 'button', 'data-act': 'hist-auto', disabled: !!c.auto.block, title: c.auto.block || 'Offer the newest eligible release automatically',
          onclick: () => ask(`Switch ${id} to Automatic?`, 'Users are offered the newest eligible release, including future ones, as soon as you publish them.', 'Automatic',
            ADDON.selectionCall.auto(id, rev), `${id}: automatic`) }, 'Automatic (newest)') : null,
        c.restorePrevious.show ? h('button', { class: 'btn small', type: 'button', 'data-act': 'hist-restore-previous', disabled: !!c.restorePrevious.block, title: c.restorePrevious.block || `Go back to v${c.restorePrevious.version}`,
          onclick: doRun(ADDON.selectionCall.restorePrevious(id, rev), `${id}: restored previous selection`) }, `Restore previous selection (v${c.restorePrevious.version})`) : null,
        c.withdraw.show ? h('button', { class: 'btn small danger', type: 'button', 'data-act': 'hist-withdraw', disabled: !!c.withdraw.block || missing0014,
          title: missing0014 ? 'Needs database migration 0014, which has not been applied on this server yet.' : (c.withdraw.block || 'Offer nothing for this add-on'),
          onclick: () => ask(`Deactivate ${id}?`,
            'Users are offered nothing for this add-on: no Install or Update button. No release is yanked or deleted. Copies already installed on PCs are not removed or stopped by this (only Yank stops a version). Offer a version again with Restore previous selection, Make active or Automatic.', 'Deactivate',
            ADDON.selectionCall.withdraw(id, rev), `${id} deactivated`) }, 'Deactivate') : null);

      return h('div', { 'data-history-for': id },
        h('p', { style: 'margin:0 0 4px' }, h('b', {}, v.name), ' ', h('code', {}, id), ' — ',
          h('span', { class: 'badge ' + stateBad, id: 'addon-history-state', 'data-kind': st.kind }, st.label)),
        h('p', { class: 'hint', id: 'addon-history-counts', style: 'margin:0 0 6px' },
          `${v.counts.total} release${v.counts.total === 1 ? '' : 's'}` + (v.counts.yanked ? ` · ${v.counts.yanked} yanked` : '') + (v.counts.deleted ? ` · ${v.counts.deleted} deleted (no longer listed)` : '')
          + (v.featureKey ? ` · feature ${v.featureKey}` : '') + (st.updatedAt ? ` · selection last changed ${fmtShort(st.updatedAt)}${st.updatedBy ? ' by ' + st.updatedBy : ''}` : '')),
        st.warn ? h('p', { class: 'warn', id: 'addon-history-warn', style: 'margin:0 0 6px' }, st.warn) : null,
        st.note ? h('p', { class: 'hint', style: 'margin:0 0 6px' }, st.note) : null,
        controls,
        h('div', { class: 'tablewrap' }, h('table', { id: 'addon-history-table' }, h('thead', {}, h('tr', {}, ['Version', 'State', 'Seq', 'Size', 'SHA-256', 'Published', 'App versions', ''].map((x) => h('th', {}, x)))),
          h('tbody', { id: 'addon-history-rows' }, rows))),
        h('p', { class: 'hint' }, 'Active = chosen by an admin. Offered = what users are offered right now (can be automatic). Yanked = users cannot download it and apps running it stop it. Withdrawn = the add-on is deactivated and nothing is offered.'));
    }

    // ---- Step 2.4: download one package (admin only). The Storage policy lets only admins read a yanked / not-offered object, and the link is a
    // signed URL that expires after 60 seconds. Nothing is read into memory here; the browser saves the file.
    async function downloadPackage(id, r, btn) {
      btn.disabled = true;
      try {
        const name = ADDON.packageFileName(id, r.version);
        const { data, error } = await sb.storage.from('addons').createSignedUrl(r.storagePath, 60, { download: name });
        if (error || !data || !data.signedUrl) throw new Error((error && error.message) || 'the server returned no download link');
        const u = new URL(data.signedUrl, cfg.supabaseUrl);
        if (u.origin !== new URL(cfg.supabaseUrl).origin) throw new Error('the download link points to an unexpected address, so it was not opened');
        const a = h('a', { href: u.href, download: name, rel: 'noopener', style: 'display:none' }); document.body.append(a); a.click(); a.remove();
        toast(`Download of ${name} started (link valid for 60 seconds). Expected SHA-256 starts with ${ADDON.shortHash(r.sha256).replace('…', '')}.`);
      } catch (e) { toast(`Could not download ${id} ${r.version}: ${e.message}`, true); }
      finally { if (btn.isConnected) btn.disabled = false; }
    }

    // ---- Step 2.4: replace the package of ONE release that is neither active nor offered (0014 admin_replace_addon_release).
    // Order is forced by the backend: (1) check state, (2) keep a copy of what Storage holds now, (3) upload over the same path (admin session;
    // Storage policy admins only), (4) admin_replace_addon_release records size + SHA-256 (+ expected_sha256 = the hash the admin saw). The
    // server re-checks "not active / not offered" only in step 4, so if the release became active in between, Storage and the database disagree:
    // the dialog then offers to upload the saved copy again. Yanked stays yanked (the RPC does not touch it). SQL itself is NOT exercised here.
    function replaceDialog(id, vr) {
      const cur = releases.find((x) => x.addon_id === id && x.version === vr.version);
      if (!cur) return toast('This release is no longer in the list. Refresh the page.', true);
      const bucket = () => sb.storage.from('addons');
      const pkgIn = h('input', { type: 'file', id: 'replace-pkg', accept: '.mzaddon,application/zip' });
      const sideIn = h('input', { type: 'file', id: 'replace-sidecar', accept: '.json,application/json' });
      const noBackup = h('input', { type: 'checkbox', id: 'replace-no-backup' });
      const checks = h('div', { id: 'replace-checks' }, h('p', { class: 'hint' }, 'Choose the rebuilt, signed package (.mzaddon) and its release.json.'));
      const status = h('div', { id: 'replace-status', 'aria-live': 'polite' });
      const runBtn = h('button', { class: 'btn primary', id: 'btn-replace-run', type: 'button', disabled: true, onclick: () => runReplace() }, 'Replace package');
      let ready = null, busy = false, inconsistent = false, finished = false, backup = null, ctx = null, token = 0, closeDlg = () => {};
      const say = (kind, text, actions) => status.replaceChildren(text ? h('div', { class: kind === 'err' ? 'banner' : 'card', 'data-kind': kind, style: 'margin-top:12px' },
        h('p', { class: kind === 'err' ? 'warn' : '', style: 'margin:0 0 8px' }, text), actions && actions.length ? h('div', { class: 'row' }, actions) : null) : []);
      const lock = (on) => { pkgIn.disabled = sideIn.disabled = noBackup.disabled = on || inconsistent || finished; runBtn.disabled = on || inconsistent || finished || !ready; };
      const btn = (label, cls, id, fn) => h('button', { class: 'btn small ' + cls, type: 'button', id, onclick: fn }, label);
      const canLeave = () => !busy && !inconsistent;
      const stop = (msg) => { busy = false; lock(false); say('err', msg); toast(msg, true); };     // nothing was changed

      async function check() {
        const my = ++token; ready = null; runBtn.disabled = true; say();
        if (!pkgIn.files[0] || !sideIn.files[0]) { checks.replaceChildren(h('p', { class: 'hint' }, 'Choose the rebuilt, signed package (.mzaddon) and its release.json.')); return; }
        const out = []; let res, buf = null, pkg = null;
        try { res = ADDON.parseSidecar(await sideIn.files[0].text(), known); } catch (e) { res = { ok: false, errors: ['Could not read release.json: ' + e.message] }; }
        if (my !== token) return;
        if (!res.ok) res.errors.forEach((e) => out.push(line(false, e))); else out.push(line(true, 'release.json is valid'));
        try {
          buf = await pkgIn.files[0].arrayBuffer();
          pkg = { name: pkgIn.files[0].name, size: buf.byteLength, head: new Uint8Array(buf.slice(0, 4)), sha256: await ADDON.sha256Hex(buf, window.crypto && window.crypto.subtle) };
        } catch (e) { out.push(line(false, 'Could not read/hash the package: ' + e.message)); }
        if (my !== token) return;
        if (pkg) out.push(line(true, `New package: ${pkg.name}, ${ADDON.fmtBytes(pkg.size)} (${pkg.size} bytes), SHA-256 ${pkg.sha256}`));
        let cr = { errors: [], warnings: [] };
        if (res.ok && pkg) {
          cr = ADDON.checkReplacement(cur, res.release, pkg);
          if (!cr.errors.length) out.push(line(true, 'The package matches release.json (size and SHA-256) and describes this exact release'));
          cr.errors.forEach((e) => out.push(line(false, e)));
          cr.warnings.forEach((w) => out.push(h('li', {}, h('span', { class: 'badge' }, 'Note'), ' ', w)));
        }
        checks.replaceChildren(h('ul', { class: 'checks' }, out));
        if (res.ok && pkg && !cr.errors.length) { ready = { sidecar: res.release, pkg, buf }; runBtn.disabled = false; }
      }
      pkgIn.addEventListener('change', check); sideIn.addEventListener('change', check);

      const saveBackup = () => {
        if (!backup) return;
        const url = URL.createObjectURL(new Blob([backup.buf], { type: 'application/zip' }));
        const a = h('a', { href: url, download: `${id}-${vr.version}.previous.mzaddon`, style: 'display:none' }); document.body.append(a); a.click(); a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30000);
      };
      const leave = () => btn('Close without fixing', 'danger', 'btn-replace-leave', () => { inconsistent = false; toast(`${id} ${vr.version}: Storage and the database may disagree. Run Replace package again with the same two files to finish it.`, true); closeDlg(); });

      async function restore() {
        busy = true; lock(true); say('info', 'Uploading the saved previous package again…');
        let err = null; try { err = (await bucket().upload(ctx.fr.storage_path, backup.buf, { contentType: 'application/zip', upsert: true })).error; } catch (e) { err = e; }
        busy = false;
        if (err) return fail('restore', `Could not put the previous package back: ${err.message || err}. Storage still holds the NEW package.`);
        inconsistent = false; finished = true; lock(false); toast(`${id} ${vr.version}: previous package restored`);
        say('ok', 'The previous package was uploaded to Storage again (Storage accepted the upload). The database record was never changed, so both describe the previous package again. Nothing was replaced. Close this window; you can start over with a fresh Replace.');
      }
      // recovery panel after a failure. kind: upload | stale | in_use | missing | storage | other | unconfirmed | restore
      function fail(kind, msg) {
        busy = false; lock(false); toast(msg, true);
        const acts = [];
        if (kind === 'upload') acts.push(btn('Retry upload', 'primary', 'btn-replace-retry', () => uploadStep()));
        else if (kind === 'storage' || kind === 'other' || kind === 'unconfirmed') acts.push(btn('Retry database step', 'primary', 'btn-replace-retry', () => dbStep()));
        else if (kind === 'stale') acts.push(btn('Reload data', '', 'btn-replace-reload', () => go('addons')));
        if (backup && kind !== 'stale') acts.push(btn('Restore previous package', kind === 'in_use' || kind === 'missing' || kind === 'restore' ? 'primary' : '', 'btn-replace-restore', () => restore()));
        if (backup) acts.push(btn('Save a copy of the previous package', '', 'btn-replace-save', saveBackup));
        acts.push(leave());
        say('err', msg + (kind === 'upload' ? ' The database was NOT changed.' : ''), acts);
      }

      async function uploadStep() {
        busy = true; lock(true); inconsistent = true;                    // from here on Storage may differ from the database
        say('info', `Step 3 of 4: uploading the new package (${ADDON.fmtBytes(ctx.pkg.size)}) to Storage…`);
        let err = null; try { err = (await bucket().upload(ctx.fr.storage_path, ctx.buf, { contentType: 'application/zip', upsert: true })).error; } catch (e) { err = e; }
        if (err) return fail('upload', `Upload failed: ${err.message || err}. The previous package should still be in Storage, but a failed upload cannot be guaranteed to have left it untouched.${backup ? ' “Restore previous package” uploads the saved copy again to be sure.' : ''}`);
        return dbStep();
      }
      async function dbStep() {
        busy = true; lock(true);
        say('info', 'Step 4 of 4: saving the new size and SHA-256 in the database…');
        const call = ADDON.replaceCall(ctx.fr, ctx.pkg); let data;
        try { data = await rpc(call.fn, call.params); }
        catch (e) {
          const k = ADDON.classifyReplaceError(e.message, call.fn), head = 'The new package IS in Storage, but the database was NOT updated: ';
          if (k === 'missing') return fail('missing', head + `${call.fn} is not available on this server (database migration 0014 has not been applied yet). Put the previous package back.`);
          if (k === 'stale') return fail('stale', head + `${e.message} Someone else changed this release, so restoring automatically is not offered: reload and check the release first.`);
          if (k === 'in_use') return fail('in_use', head + `${e.message} Users may now be offered a release whose file no longer matches its recorded SHA-256 and fail to install it: put the previous package back now.`);
          return fail(k === 'storage' ? 'storage' : 'other', head + `${e.message}. You can retry the database step, or put the previous package back.`);
        }
        if (!ADDON.savedReplaceMatches(data, call)) return fail('unconfirmed', 'The new package IS in Storage, but the server did not confirm the new size and SHA-256 in the database. Retry the database step, or put the previous package back.');
        busy = false; inconsistent = false; finished = true; lock(false);
        const yankNote = data.yanked === ctx.fr.yanked ? (ctx.fr.yanked ? 'It is still yanked.' : 'It is not yanked.') : `WARNING: the yanked flag is now ${data.yanked}, it was ${ctx.fr.yanked}. Check it in the table.`;
        toast(`${id} ${vr.version}: package replaced`);
        say('ok', `Package replaced. ${id} ${vr.version} now has ${ADDON.fmtBytes(ctx.pkg.size)} (${ctx.pkg.size} bytes), SHA-256 ${ctx.pkg.sha256} (before: ${ctx.fr.sha256}). ${yankNote} The server wrote an audit entry. PCs that already installed this version keep the old files; apps still verify the signature and SHA-256 themselves.`);
        go('addons');
      }

      async function runReplace() {
        if (busy || !ready || finished || inconsistent) return;
        busy = true; lock(true); backup = null; const { sidecar, pkg, buf } = ready;
        say('info', 'Step 1 of 4: checking the release on the server…');
        let fr, sel;
        try {
          const [rl, sl] = await Promise.all([rpc('admin_list_addon_releases'), rpc('admin_get_addon_selection')]);
          fr = rl.find((x) => x.addon_id === id && x.version === vr.version); sel = ADDON.selectionFor(sl, id);
        } catch (e) { return stop('Nothing was changed. Could not read the current state: ' + e.message); }
        const why = ADDON.replaceEligibility(fr, sel); if (why) return stop('Nothing was changed. ' + why);
        if (fr.sha256 !== cur.sha256) return stop('Nothing was changed. This release was changed by someone else since this window opened. Close it, refresh the page and start again.');
        const cr = ADDON.checkReplacement(fr, sidecar, pkg); if (cr.errors.length) return stop('Nothing was changed. ' + cr.errors.join(' '));
        say('info', 'Step 2 of 4: keeping a copy of the package that is stored now…');
        let note = null;
        try {
          const { data, error } = await bucket().download(fr.storage_path);
          if (error) throw new Error(error.message || String(error));
          const b = await data.arrayBuffer(), sha = await ADDON.sha256Hex(b, window.crypto && window.crypto.subtle);
          if (b.byteLength === fr.size && sha === fr.sha256) backup = { buf: b };
          else note = `the stored file (${b.byteLength} bytes, SHA-256 ${sha.slice(0, 12)}…) does not match the database record (${fr.size} bytes, ${String(fr.sha256).slice(0, 12)}…)`;
        } catch (e) { note = 'the stored package could not be read: ' + e.message; }
        if (!backup && !noBackup.checked) return stop(`Nothing was changed. A restore copy of the current package could not be made (${note}). If you still want to replace it, tick “Replace even if no restore copy can be made” and try again.`);
        ctx = { fr, pkg, buf };
        return uploadStep();
      }

      const body = h('div', { id: 'replace-dialog' },
        h('p', {}, `Replaces the package file of ${id} ${vr.version} in Storage and records its new size and SHA-256. ` + (cur.yanked ? 'This release is yanked and stays yanked.' : 'Its yanked status does not change.')
          + ' It only works for a version that is neither the active nor the offered one (the server checks again).'),
        h('p', { class: 'hint' }, `Now stored: ${ADDON.fmtBytes(cur.size)} (${cur.size} bytes), SHA-256 ${cur.sha256}. Path: ${cur.storage_path}`),
        h('p', { class: 'hint' }, 'A PC that already installed this version keeps the old files; if that matters, publish a new version instead. The new file is uploaded BEFORE the database is updated; if this version became active in that moment, this window offers to put the saved previous package back.'),
        h('div', { class: 'field' }, h('label', { for: 'replace-pkg' }, 'New signed package (.mzaddon, a ZIP)'), pkgIn),
        h('div', { class: 'field' }, h('label', { for: 'replace-sidecar' }, 'Its release.json'), sideIn),
        h('div', { class: 'field' }, h('label', {}, noBackup, ' Replace even if no restore copy of the current package can be made')),
        checks, h('div', { class: 'row', style: 'margin-top:12px' }, runBtn), status);
      closeDlg = modal(`Replace package: ${id} ${vr.version}`, body, [{ label: 'Close', run: (c) => { if (canLeave()) c(); else toast(busy ? 'Wait until the current step has finished.' : 'Storage and the database may disagree: use the buttons in the message, or “Close without fixing”.', true); return true; } }], canLeave);
    }

    // ---- Step 2.5: delete ONE release (admin_delete_addon_release) or a WHOLE add-on (admin_delete_addon), then clean up Storage.
    // Order (forced by the backend, section F of 0014): (1) fresh re-check, nothing is written if it fails; (2) the database function, ONE
    // transaction on the server (tombstone + delete + audit; yanked releases keep their revocation); only when the server CONFIRMS it, (3) the
    // package file(s) it returned are removed from Storage with the admin's own session. The database function is called AT MOST ONCE per
    // window: if Storage cleanup fails the retry button repeats ONLY the Storage removal, never the deletion. Only a path that is exactly
    // the one the server enforces for that release (<id>/<version>/<id>-<version>.mzaddon) is ever sent to Storage. SQL / Storage are NOT
    // exercised by the browser check (stubbed client).
    async function storageAbsent(bucket, path) {                       // true = the object is not in the bucket; throws when it cannot be told
      const i = path.lastIndexOf('/'), dir = path.slice(0, i), name = path.slice(i + 1);
      const { data, error } = await bucket.list(dir, { limit: 100, search: name });
      if (error) throw new Error(error.message || String(error));
      return !(data || []).some((o) => o && o.name === name);
    }
    // remove() lists the objects it really deleted; one it could not delete (policy refusal) is just missing from that list, with no error.
    // So everything not reported as removed is checked, never assumed. Returns {done:[{path,how}], failed:[{path,reason}]}.
    async function removeFromStorage(paths) {
      const bucket = sb.storage.from('addons'), done = [], failed = [];
      let res = null, rerr = null;
      try { res = await bucket.remove(paths); if (res && res.error) rerr = res.error; } catch (e) { rerr = e; }
      const rmsg = rerr ? (rerr.message || String(rerr)) : '';
      const sp = ADDON.splitRemoved(paths, rerr ? [] : (res && res.data));
      sp.removed.forEach((p) => done.push({ path: p, how: 'removed' }));
      for (const p of sp.notReported) {
        try {
          if (await storageAbsent(bucket, p)) done.push({ path: p, how: 'already absent' });
          else failed.push({ path: p, reason: rerr ? rmsg : 'Storage did not remove it (the delete was refused or did not happen)' });
        } catch (e) { failed.push({ path: p, reason: 'could not check whether it still exists: ' + (e.message || e) + (rerr ? ` (remove error: ${rmsg})` : '') }); }
      }
      return { done, failed };
    }

    // c = { title, intro: [nodes], confirm (exact text), confirmLabel, ack (label | null), runLabel, preflight(): null | refusal text, call(typed): {fn, params},
    //       interpret(data): {ok, paths, rejected, ...}, success(out, cleaned): text, leftoverNote }
    function deleteDialog(c) {
      const typed = h('input', { type: 'text', id: 'delete-confirm', autocomplete: 'off', spellcheck: 'false', placeholder: c.confirm, 'aria-label': c.confirmLabel });
      const ack = c.ack ? h('input', { type: 'checkbox', id: 'delete-ack' }) : null;
      const status = h('div', { id: 'delete-status', 'aria-live': 'polite' });
      const runBtn = h('button', { class: 'btn danger', id: 'btn-delete-run', type: 'button', disabled: true, onclick: () => runDelete() }, c.runLabel);
      let busy = false, dbDone = false, finished = false, left = false, pending = [], cleaned = 0, out = null, closeDlg = () => {};
      const sync = () => { const lock = busy || dbDone || finished; typed.disabled = lock; if (ack) ack.disabled = lock;
        runBtn.disabled = lock || !ADDON.confirmMatches(typed.value, c.confirm) || (!!ack && !ack.checked); };
      typed.addEventListener('input', sync); if (ack) ack.addEventListener('change', sync);
      const say = (kind, text, actions, extra) => status.replaceChildren(text ? h('div', { class: kind === 'err' ? 'banner' : 'card', 'data-kind': kind, style: 'margin-top:12px' },
        h('p', { class: kind === 'err' ? 'warn' : '', style: 'margin:0 0 8px' }, text), extra || null, actions && actions.length ? h('div', { class: 'row' }, actions) : null) : []);
      const btn = (label, cls, id, fn) => h('button', { class: 'btn small ' + cls, type: 'button', id, onclick: fn }, label);
      const canLeave = () => !busy && !(dbDone && pending.length > 0 && !left);
      const rejNote = () => (out && out.rejected && out.rejected.length ? ` The server also returned ${out.rejected.length} Storage path(s) that are not the expected path of this ${c.what}; they were NOT sent to Storage: ${out.rejected.join(', ')}.` : '');
      const stop = (msg) => { busy = false; sync(); say('err', msg); toast(msg, true); };      // nothing was changed

      async function cleanup() {
        busy = true; sync();
        say('info', `Step 3 of 3: removing ${pending.length} package file${pending.length === 1 ? '' : 's'} from Storage…`);
        const res = await removeFromStorage(pending);
        cleaned += res.done.length; pending = res.failed.map((f) => f.path); busy = false; sync();
        if (!pending.length) {
          finished = true; sync();
          const msg = c.success(out, cleaned) + rejNote();
          toast(msg.split('. ')[0] + '.'); say('ok', msg); return;
        }
        const msg = `The database deletion WAS done and is not repeated, but ${pending.length} package file${pending.length === 1 ? '' : 's'} could not be removed from Storage` + (cleaned ? ` (${cleaned} other file${cleaned === 1 ? ' was' : 's were'} removed)` : '') + '. The files are private (users cannot reach them) but still take space. “Retry Storage clean-up” repeats only the Storage removal.' + rejNote();
        toast(`${pending.length} package file${pending.length === 1 ? '' : 's'} could not be removed from Storage. Retry the clean-up.`, true);
        say('err', msg, [
          btn('Retry Storage clean-up', 'primary', 'btn-delete-retry', () => cleanup()),
          btn('Copy file paths', '', 'btn-delete-copy', async () => { try { await navigator.clipboard.writeText(pending.join('\n')); toast('File paths copied'); } catch (e) { toast('Could not copy automatically: select the paths in the message and copy them.', true); } }),
          btn('Close without cleaning up', 'danger', 'btn-delete-leave', () => { left = true; toast(`${pending.length} package file${pending.length === 1 ? ' is' : 's are'} still in Storage (private). Paths: ${pending.join(', ')}`, true); closeDlg(); })],
        h('ul', { id: 'delete-leftovers' }, res.failed.map((f) => h('li', {}, h('code', {}, f.path), ' — ', f.reason))));
      }

      async function runDelete() {
        if (busy || dbDone || finished || runBtn.disabled) return;
        busy = true; sync(); say('info', 'Step 1 of 3: checking the current state on the server…');
        let why; try { why = await c.preflight(); } catch (e) { return stop('Nothing was changed. Could not read the current state: ' + e.message); }
        if (why) return stop('Nothing was changed. ' + why);
        say('info', 'Step 2 of 3: deleting from the database…');
        const call = c.call(typed.value); let data;
        try { data = await rpc(call.fn, call.params); }
        catch (e) {
          busy = false; sync();
          const k = ADDON.classifyDeleteError(e.message, call.fn);
          const msg = k === 'missing' ? `Nothing was deleted. ${call.fn} is not available on this server: database migration 0014 has not been applied yet.`
            : k === 'in_use' && call.fn === 'admin_delete_addon' ? ADDON.addonDeleteRefusalText(e.message)
            : k === 'stale' || k === 'in_use' || k === 'confirm' ? `Nothing was deleted. ${e.message}`
            : k === 'unknown' ? `The server says it does not know this ${c.what}: ${e.message}. If an earlier attempt did not get an answer, or someone else deleted it, it may be gone: reload the data to see. Storage was not touched.${c.leftoverNote}`
            : `The server did not confirm the deletion (${e.message}). It may or may not have been deleted. Storage was NOT touched. Reload the data to see what the server has now.${c.leftoverNote}`;
          toast(msg, true); say('err', msg, [btn('Reload data', '', 'btn-delete-reload', () => go('addons'))]); return;
        }
        out = c.interpret(data);
        if (!out.ok) {
          busy = false; sync();
          const msg = `The server answered, but not with a confirmation of this deletion, so Storage was NOT touched. Reload the data to see what the server has now.${c.leftoverNote}`;
          toast(msg, true); say('err', msg, [btn('Reload data', '', 'btn-delete-reload', () => go('addons'))]); return;
        }
        dbDone = true; pending = out.paths.slice(); go('addons');                // the deletion is confirmed: refresh the lists and counts in the background
        if (!pending.length) { busy = false; finished = true; sync(); const msg = c.success(out, 0) + rejNote(); toast(msg.split('. ')[0] + '.'); say('ok', msg); return; }
        return cleanup();
      }

      const body = h('div', { id: 'delete-dialog' }, c.intro,
        ack ? h('div', { class: 'field' }, h('label', {}, ack, ' ' + c.ack)) : null,
        h('div', { class: 'field' }, h('label', { for: 'delete-confirm' }, c.confirmLabel), typed),
        h('div', { class: 'row', style: 'margin-top:12px' }, runBtn), status);
      closeDlg = modal(c.title, body, [{ label: 'Close', run: (cl) => { if (canLeave()) cl(); else toast(busy ? 'Wait until the current step has finished.' : 'Package files are still in Storage: use Retry Storage clean-up, or “Close without cleaning up”.', true); return true; } }], canLeave);
    }

    const PC_WARNING = 'Deleting a server package does NOT delete the copies already installed on users’ PCs. Apps keep what they installed; only a YANKED version makes apps stop running it.';
    function deleteReleaseDialog(id, r, rev) {
      const where = `${id} ${r.version}`;
      deleteDialog({
        what: 'release', title: `Delete version: ${where}`, confirm: r.version, confirmLabel: `Type the version (${r.version}) to confirm`, runLabel: 'Delete this version',
        leftoverNote: r.storagePath ? ` If the release is gone after reloading, its package file ${r.storagePath} may still be in Storage (private; users cannot reach it).` : '',
        intro: [
          h('p', {}, `Permanently deletes the release ${where} (seq ${r.seq}) from the database and then removes its package file from Storage. This cannot be undone.`),
          h('p', { class: 'warn', id: 'delete-pc-warning' }, PC_WARNING),
          h('p', {}, r.yanked ? 'This release is yanked. It stays on the revoked list after deletion, so apps that run it are still told to stop it.'
            : 'This release is NOT yanked, so no revocation is kept: PCs that installed it keep running it. If apps must stop it, Cancel, Yank it first, and delete it afterwards.'),
          h('p', { class: 'hint' }, `The version number ${r.version} and seq ${r.seq} of ${id} are burnt for good: a new release needs a new version number and a higher seq. The server refuses the ACTIVE version and the version users are offered right now, and writes an audit entry. The database is changed first; if removing the file from Storage fails you can retry that part without deleting again.`),
          h('p', { class: 'hint' }, `Package file: ${r.storagePath || '(none recorded)'}`)],
        async preflight() {
          const [rl, sl] = await Promise.all([rpc('admin_list_addon_releases'), rpc('admin_get_addon_selection')]);
          const fr = rl.find((x) => x.addon_id === id && x.version === r.version), sel = ADDON.selectionFor(sl, id);
          const why = ADDON.deleteEligibility(fr, sel); if (why) return why;
          if (fr.sha256 !== r.sha256) return 'This release was changed since this window opened. Close it, refresh the page and review it again.';
          if ((sel.revision == null ? null : sel.revision) !== (rev == null ? null : rev)) return 'The selection of this add-on was changed by someone else since this window opened. Close it, refresh the page and review it again.';
          return null;
        },
        call: () => ADDON.deleteReleaseCall(id, r.version, rev),
        interpret: (data) => { const p = ADDON.parseDeleteReleaseResult(data, id, r.version); return { ok: p.ok, paths: p.path ? [p.path] : [], rejected: p.rejected ? [p.rejected] : [], wasYanked: p.wasYanked, revocationKept: p.revocationKept }; },
        success: (o, n) => `Deleted ${where}. ` + (o.revocationKept ? 'It was yanked and stays on the revoked list. ' : 'It was not yanked, so no revocation is kept. ')
          + (o.paths.length ? (n ? 'The package file was removed from Storage. ' : 'The package file is no longer in Storage. ') : 'There was no package file to remove. ')
          + 'The server wrote an audit entry. Copies already installed on PCs were NOT removed.',
      });
    }

    function deleteAddonDialog(a) {
      const id = a.id, imp = ADDON.addonDeleteImpact(releases.filter((x) => x.addon_id === id));
      deleteDialog({
        what: 'add-on', title: `Delete add-on: ${a.name} (${id})`, confirm: id, confirmLabel: `Type the add-on id (${id}) to confirm`, runLabel: 'Delete this add-on',
        leftoverNote: ` If the add-on is gone after reloading, its package files (folder ${id}/ in the private “addons” bucket) may still be in Storage.`,
        intro: [
          h('p', {}, `Permanently deletes the add-on ${id}: its name record, its selection (active / previous / deactivated), and ${imp.total} release record${imp.total === 1 ? '' : 's'}; then removes the package files from Storage. This cannot be undone.`),
          h('p', { class: 'warn', id: 'delete-pc-warning' }, PC_WARNING),
          imp.offeredVersion ? h('p', { class: 'warn', id: 'delete-offered-warning' }, ADDON.deleteAddonBlock(imp.offeredVersion)) : null,
          h('p', {}, imp.total ? `${imp.yanked} of ${imp.total} release${imp.total === 1 ? ' is' : 's are'} yanked and stay on the revoked list. ${imp.notYanked ? `The other ${imp.notYanked} ${imp.notYanked === 1 ? 'is' : 'are'} NOT yanked, so no revocation is kept for ${imp.notYanked === 1 ? 'it' : 'them'}: PCs that installed ${imp.notYanked === 1 ? 'it keeps' : 'them keep'} running ${imp.notYanked === 1 ? 'it' : 'them'}. If apps must stop a version, Cancel and Yank it first.` : ''}` : 'This add-on has no releases, so only its name record is deleted.'),
          h('p', { class: 'hint' }, `All ${imp.total} version numbers and seqs of ${id} are burnt for good. The feature switch${a.featureKey ? ' ' + a.featureKey : ''} on the Pages tab is not deleted. The server refuses to delete an add-on that users are offered right now (deactivate it first) and writes an audit entry. The database is changed first; if removing files from Storage fails you can retry that part without deleting again.`)],
        async preflight() {
          const [rl, ml] = await Promise.all([rpc('admin_list_addon_releases'), rpc('admin_list_addons')]);
          const mine = rl.filter((x) => x.addon_id === id);
          if (!mine.length && !ml.some((x) => x.addon_id === id)) return `${id} no longer exists. Close this window and refresh the page.`;
          const now = ADDON.addonDeleteImpact(mine);
          if (now.offeredVersion) return ADDON.deleteAddonBlock(now.offeredVersion);         // Step 2.7: do not even ask the server
          if (JSON.stringify(now) !== JSON.stringify(imp)) return `The releases of ${id} changed since this window opened (now ${now.total} release${now.total === 1 ? '' : 's'}${now.offeredVersion ? ', offered: ' + now.offeredVersion : ''}). Close it, refresh the page and review it again.`;
          return null;
        },
        call: (typedText) => ADDON.deleteAddonCall(id, typedText),
        interpret: (data) => { const p = ADDON.parseDeleteAddonResult(data, id); return { ok: p.ok, paths: p.paths, rejected: p.rejected, releasesDeleted: p.releasesDeleted, revocationsKept: p.revocationsKept }; },
        success: (o, n) => `Deleted add-on ${id}: ${o.releasesDeleted == null ? 'its' : o.releasesDeleted} release record${o.releasesDeleted === 1 ? '' : 's'} deleted, ${o.revocationsKept == null ? 'the' : o.revocationsKept} revocation${o.revocationsKept === 1 ? '' : 's'} kept, `
          + (o.paths.length ? `${n} package file${n === 1 ? '' : 's'} removed from Storage. ` : 'no package files to remove. ') + 'The server wrote an audit entry. Copies already installed on PCs were NOT removed.',
      });
    }

    // ---- v1.0.0 (migration 0024): Upcoming features notice board. Announcements are plain data; "Release" does NOT upload anything itself: it points the
    // existing "Publish a new release" form below at the linked add-on id, and the database promotes the announcement inside the publish transaction.
    let releaseFor = null;                                    // {id, addon_id, title} while the publish form below is releasing an announcement
    const releaseBanner = h('div', { id: 'upcoming-release-banner' });
    function drawReleaseBanner() {
      releaseBanner.replaceChildren(releaseFor ? h('div', { class: 'banner', style: 'margin:0 0 12px' },
        h('p', { style: 'margin:0 0 6px' }, h('b', {}, `Releasing “${releaseFor.title}”`), ' — the package must be for add-on ', h('code', {}, releaseFor.addon_id),
          '. Choose its signed .mzaddon and release.json below. When the release is published the announcement leaves Upcoming features and the add-on appears in Add-ons automatically.'),
        h('button', { class: 'btn small', id: 'btn-upcoming-release-cancel', type: 'button', onclick: () => { releaseFor = null; drawReleaseBanner(); check(); } }, 'Stop releasing this announcement')) : []);
    }
    const ADDON_ID_RE = /^[a-z0-9_]{1,32}$/;
    // 0024 has the 6-argument admin_upsert_upcoming_feature; 0030 replaced it with a 7-argument version whose p_image_data is optional (default null = no image).
    // So p_image_data is sent ONLY when there is an image: a no-image save then works on both schema generations. On 0030 an omitted image clears the stored one
    // (the function writes image_data = the argument), which is exactly what 'Remove image' means.
    function upcomingUpsertParams(u, v, image) {
      const params = { p_id: u ? u.id : null, p_title: v.title, p_description: v.description, p_addon_id: v.addon_id || null,
        p_sort_order: v.sort_order, p_expected_updated_at: u ? u.updated_at : null };
      if (image) params.p_image_data = image;
      return params;
    }
    // PostgREST answers PGRST202 / 'Could not find the function ... in the schema cache' (or Postgres 'function ... does not exist') when no overload matches the sent parameter names.
    function isMissingFunctionError(msg) { return /could not find the function|PGRST202|function\b[^\n]*\bdoes not exist|in the schema cache/i.test(String(msg || '')); }
    const MIG_0030_IMAGE_MSG = 'Thumbnails need migration 0030_upcoming_features_management.sql, which is not applied on this server. Nothing was saved. Your text and image are still in this form: apply 0030, or press Remove image to save without a thumbnail.';
    const MIG_0030_FEATURE_MSG = (what) => what + ' needs migration 0030_upcoming_features_management.sql, which is not applied on this server. Nothing was changed.';
    // ---- Part 8B (migration 0030): the announcement form now has an optional thumbnail (local file picker, re-encoded to a small data: image; no URL field).
    function upcomingModal(u) {
      let image = u && u.image_data && ANN_IMG_RE.test(u.image_data) ? u.image_data : null;
      const title = h('input', { type: 'text', id: 'upcoming-title', maxlength: '80', placeholder: 'Feature name', value: u ? u.title : '' });
      const desc = h('textarea', { id: 'upcoming-desc', maxlength: '400', placeholder: 'One or two sentences users will read. Plain text only.' }, u ? u.description : '');
      const addon = h('input', { type: 'text', id: 'upcoming-addon', maxlength: '32', placeholder: 'add-on id (optional until you release it)', value: u && u.addon_id ? u.addon_id : '' });
      const sort = h('input', { type: 'number', id: 'upcoming-sort', value: u ? String(u.sort_order) : '100', min: '0', max: '100000' });
      const preview = h('div', { class: 'ann-preview', id: 'upcoming-preview' });
      const drawPreview = () => preview.replaceChildren(image ? h('img', { class: 'ann-thumb', src: image, alt: '' }) : h('span', { class: 'hint' }, 'No image'));
      drawPreview();
      const file = h('input', { type: 'file', id: 'upcoming-image', accept: 'image/png,image/jpeg,image/webp' });
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0]; if (!f) return;
        try { image = await annThumb(f); drawPreview(); } catch (e) { toast(e.message, true); file.value = ''; }
      });
      modal(u ? 'Edit announcement' : 'New upcoming feature', h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Title (max 80 characters)'), title),
        h('div', { class: 'field' }, h('label', {}, 'Description (max 400 characters)'), desc),
        h('div', { class: 'field' }, h('label', {}, 'Thumbnail (optional; PNG, JPEG or WebP, shrunk to 128 px and stored inside the announcement)'), file,
          h('div', { class: 'row', style: 'margin-top:6px' }, preview, h('button', { class: 'btn small', type: 'button', id: 'upcoming-image-clear', onclick: () => { image = null; file.value = ''; drawPreview(); } }, 'Remove image'))),
        h('div', { class: 'field' }, h('label', {}, 'Add-on id (optional; lowercase letters, digits, underscore; the stable id the signed package will use)'), addon),
        h('div', { class: 'row' }, h('label', { class: 'name' }, 'Order (lower first; or use the ▲ ▼ buttons in the list)'), sort),
        h('p', { class: 'hint' }, 'New announcements are saved as a draft: users only see it after you press Publish.')),
      [{ label: 'Cancel', run: (c) => c() }, { label: 'Save', cls: 'primary', run: async (c) => {
        if (!title.value.trim()) { toast('Write the title first', true); return true; }
        const id = addon.value.trim();
        if (id && !ADDON_ID_RE.test(id)) { toast('Add-on id: lowercase letters, digits and underscore only (max 32)', true); return true; }
        const params = upcomingUpsertParams(u, { title: title.value.trim(), description: desc.value.trim(), addon_id: id, sort_order: Number(sort.value || 100) }, image);
        try { await rpc('admin_upsert_upcoming_feature', params); }
        catch (e) {                                                  // keep the dialog open: the typed values and the chosen image stay so the user can retry
          if (params.p_image_data && isMissingFunctionError(e.message)) { upcoming0030Missing = true; toast(MIG_0030_IMAGE_MSG, true); }
          else toast(e.message, true);
          return true;
        }
        toast('Announcement saved'); c(); go('addons'); } }]);
    }
    let upcoming0030Missing = false;                                // learned from a 'function not found' answer; survives go('addons') redraws
    let upcomingQuery = '', upcomingFilter = 'all';          // list view state; survives go('addons') redraws within this page session
    function upcomingPanel() {
      const box = h('div', { class: 'card', id: 'upcoming-features', style: 'margin-bottom:20px' }, h('h3', {}, 'Upcoming features'));
      if (!upcoming.ok) { box.append(h('p', { class: 'hint' }, 'Not available on this server yet (apply migration 0024_upcoming_features.sql). ' + upcoming.error)); return box; }
      const list = upcoming.data;
      // Schema generation: 0030 added archived_at to every row, so rows reveal it. An EMPTY list reveals nothing -> 'unknown' (never guessed).
      const schema = list.length ? (list.every((r) => r && typeof r === 'object' && 'archived_at' in r) ? '0030' : '0024') : 'unknown';
      const needs0030 = schema === '0024' || (upcoming0030Missing && schema !== '0030');   // true only when 0030 is KNOWN to be missing
      box.append(h('p', { class: 'hint' }, 'The notice board users see under Settings → Add-ons → Upcoming features. Only Published, non-archived announcements are shown, in the order below. Deleting an announcement only removes the announcement — never an add-on or a release. Announcements are separate from add-on packages and releases.'),
        needs0030 ? h('p', { class: 'warn', id: 'upcoming-needs-0030' }, 'Thumbnails, Archive / Restore and the ▲ ▼ reorder buttons need migration 0030_upcoming_features_management.sql (not applied on this server). Creating and editing announcements without an image, publishing, deleting, and typing the Order number all work with 0024.') : null,
        !needs0030 && schema === 'unknown' ? h('p', { class: 'hint', id: 'upcoming-schema-unknown' }, 'No announcements yet, so this server\'s schema cannot be detected. Announcements without an image save normally; thumbnails, Archive / Restore and ▲ ▼ reorder need migration 0030_upcoming_features_management.sql.') : null,
        h('div', { class: 'row', style: 'margin-bottom:8px; gap:8px; flex-wrap:wrap' },
          h('button', { class: 'btn primary small', id: 'btn-upcoming-new', type: 'button', onclick: () => upcomingModal(null) }, 'New announcement'),
          h('input', { type: 'search', id: 'upcoming-search', placeholder: 'Search title, text or add-on id', value: upcomingQuery, style: 'max-width:260px',
            oninput: (ev) => { upcomingQuery = ev.target.value; drawRows(); } }),
          ...[['all', 'All'], ['published', 'Published'], ['draft', 'Unpublished'], ['archived', 'Archived']].map(([k, lbl]) =>
            h('button', { class: 'btn small' + (upcomingFilter === k ? ' primary' : ''), type: 'button', 'data-filter': k, onclick: () => { upcomingFilter = k; drawRows(); drawChips(); } }, lbl))));
      const chipsHost = box.querySelectorAll('[data-filter]');
      function drawChips() { chipsHost.forEach((b) => b.classList.toggle('primary', b.getAttribute('data-filter') === upcomingFilter)); }
      const holder = h('div', { id: 'upcoming-list' });
      box.append(holder);
      const isArch = (u) => !!u.archived_at;
      const stateOf = (u) => isArch(u) ? 'archived' : u.status;
      const badge = (u) => { const st = stateOf(u);
        return h('span', { class: 'badge' + (st === 'published' ? ' ok' : st === 'released' ? '' : ' suspended'), 'data-state': st }, st === 'published' ? 'Published' : st === 'released' ? 'Released' : st === 'archived' ? 'Archived' : 'Unpublished'); };
      async function move(u, dir) {                                   // reorder among the NON-archived, non-released rows in the current order
        const ids = list.filter((x) => !isArch(x) && x.status !== 'released').map((x) => x.id);
        const i = ids.indexOf(u.id), j = i + dir; if (i < 0 || j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        try { await rpc('admin_reorder_upcoming_features', { p_ids: ids }); }
        catch (e) { if (isMissingFunctionError(e.message)) { upcoming0030Missing = true; toast(MIG_0030_FEATURE_MSG('Reordering with ▲ ▼'), true); go('addons'); return; } toast(e.message, true); return; }
        toast('Order saved'); go('addons');
      }
      function drawRows() {
        const q = upcomingQuery.trim().toLowerCase();
        const shown = list.filter((u) => {
          const st = stateOf(u);
          if (upcomingFilter === 'published' && st !== 'published') return false;
          if (upcomingFilter === 'draft' && st !== 'draft') return false;
          if (upcomingFilter === 'archived' && st !== 'archived') return false;
          return !q || (u.title + ' ' + (u.description || '') + ' ' + (u.addon_id || '')).toLowerCase().includes(q);
        });
        if (!list.length) { holder.replaceChildren(h('p', { class: 'hint', id: 'upcoming-empty' }, 'No announcements yet.')); return; }
        if (!shown.length) { holder.replaceChildren(h('p', { class: 'hint', id: 'upcoming-nomatch' }, 'No announcement matches this search / filter.')); return; }
        holder.replaceChildren(h('div', { class: 'tablewrap' }, h('table', { id: 'upcoming-table' }, h('thead', {}, h('tr', {}, ['', 'Title', 'Add-on id', 'Order', 'State', 'Actions'].map((x) => h('th', {}, x)))),
          h('tbody', {}, shown.map((u) => { const movable = !needs0030 && !isArch(u) && u.status !== 'released';
            return h('tr', { 'data-upcoming': u.id, 'data-status': u.status, 'data-archived': isArch(u) ? '1' : '0' },
            h('td', {}, u.image_data && ANN_IMG_RE.test(u.image_data) ? h('img', { class: 'ann-thumb', src: u.image_data, alt: '' }) : null),
            h('td', {}, h('b', {}, u.title), u.description ? h('div', { class: 'hint' }, u.description) : null, h('div', { class: 'hint' }, 'Updated ' + fmtShort(u.updated_at))),
            h('td', {}, u.addon_id ? h('code', {}, u.addon_id) : h('span', { class: 'hint' }, '—'), u.status === 'released' && u.released_version ? h('div', { class: 'hint' }, `released as v${u.released_version}`) : null),
            h('td', {}, String(u.sort_order),
              movable ? h('span', {}, ' ', h('button', { class: 'btn small', 'data-act': 'up', type: 'button', title: 'Show earlier', onclick: () => move(u, -1) }, '▲'),
                ' ', h('button', { class: 'btn small', 'data-act': 'down', type: 'button', title: 'Show later', onclick: () => move(u, 1) }, '▼')) : null),
            h('td', {}, badge(u)),
            h('td', { class: 'actions' },
              h('button', { class: 'btn small', 'data-act': 'edit', type: 'button', onclick: () => upcomingModal(u) }, 'Edit'),
              u.status === 'draft' && !isArch(u) ? h('button', { class: 'btn small primary', 'data-act': 'publish', type: 'button', onclick: async () => { await act(() => rpc('admin_set_upcoming_feature_status', { p_id: u.id, p_status: 'published', p_expected_updated_at: u.updated_at }), 'Published: users can now see it'); go('addons'); } }, 'Publish') : null,
              u.status === 'published' ? h('button', { class: 'btn small', 'data-act': 'unpublish', type: 'button', onclick: async () => { await act(() => rpc('admin_set_upcoming_feature_status', { p_id: u.id, p_status: 'draft', p_expected_updated_at: u.updated_at }), 'Hidden from users'); go('addons'); } }, 'Unpublish') : null,
              !needs0030 && u.status !== 'released' && !isArch(u) ? h('button', { class: 'btn small', 'data-act': 'archive', type: 'button', onclick: () => confirmBox(`Archive “${u.title}”?`, 'It is hidden from users (and unpublished) and moved to the Archived list. You can restore it later as an unpublished draft.', 'Archive',
                async () => { try { await rpc('admin_set_upcoming_feature_archived', { p_id: u.id, p_archived: true, p_expected_updated_at: u.updated_at }); } catch (e) { if (isMissingFunctionError(e.message)) { upcoming0030Missing = true; toast(MIG_0030_FEATURE_MSG('Archive'), true); go('addons'); return; } toast(e.message, true); throw e; } toast('Archived'); go('addons'); }) }, 'Archive') : null,
              !needs0030 && isArch(u) ? h('button', { class: 'btn small', 'data-act': 'restore', type: 'button', onclick: async () => { try { await rpc('admin_set_upcoming_feature_archived', { p_id: u.id, p_archived: false, p_expected_updated_at: u.updated_at }); } catch (e) { if (isMissingFunctionError(e.message)) { upcoming0030Missing = true; toast(MIG_0030_FEATURE_MSG('Restore'), true); go('addons'); return; } toast(e.message, true); return; } toast('Restored as an unpublished draft'); go('addons'); } }, 'Restore') : null,
              u.status !== 'released' && !isArch(u) ? h('button', { class: 'btn small', 'data-act': 'release', type: 'button', disabled: !u.addon_id, title: u.addon_id ? 'Release this add-on through the signed publish form below' : 'Add an add-on id first (Edit)',
                onclick: () => { releaseFor = { id: u.id, addon_id: u.addon_id, title: u.title }; drawReleaseBanner(); check(); const t = document.getElementById('addon-publish'); if (t && t.scrollIntoView) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); } }, 'Release…') : null,
              h('button', { class: 'btn small danger', 'data-act': 'delete', type: 'button', onclick: () => confirmBox(`Delete “${u.title}”?`,
                'Only this announcement is deleted and it disappears from users’ Upcoming features. Published add-ons and releases are not touched.', 'Delete announcement',
                async () => { await act(() => rpc('admin_delete_upcoming_feature', { p_id: u.id }), 'Announcement deleted'); go('addons'); }) }, 'Delete')));
          })))));
      }
      drawRows();
      return box;
    }

    // ---- publish form
    const activateIn =h('input', { type: 'checkbox', id: 'addon-activate', checked: true });
    const pkgIn = h('input', { type: 'file', id: 'addon-pkg', accept: '.mzaddon,application/zip' });
    const sideIn = h('input', { type: 'file', id: 'addon-sidecar', accept: '.json,application/json' });
    const checks = h('div', { id: 'addon-checks' });
    const preview = h('div', { id: 'addon-preview' });
    const status = h('div', { id: 'addon-status', 'aria-live': 'polite' });
    const publishBtn = h('button', { class: 'btn primary', id: 'btn-addon-publish', type: 'button', disabled: true, onclick: () => runPublish() }, 'Upload and publish');
    let ready = null;                                         // {release, buf} once every check passed
    let uploaded = false;                                     // the package is already in Storage (a retry then only repeats the publish step)
    let busy = false; let seqToken = 0;
    const setStatus = (kind, text, actions) => status.replaceChildren(text ? h('div', { class: kind === 'err' ? 'banner' : 'card', style: 'margin-top:12px' },
      h('p', { class: kind === 'err' ? 'warn' : '', style: 'margin:0 0 8px' }, text), actions ? h('div', { class: 'row' }, actions) : null) : []);
    const line = (ok, text) => h('li', { class: ok ? 'ok' : 'bad' }, h('span', { class: 'badge ' + (ok ? 'ok' : 'suspended') }, ok ? 'OK' : 'Problem'), ' ', text);

    async function check() {
      const my = ++seqToken; ready = null; uploaded = false; publishBtn.disabled = true; setStatus(); preview.replaceChildren();
      if (!pkgIn.files[0] || !sideIn.files[0]) { checks.replaceChildren(h('p', { class: 'hint' }, 'Choose the signed package (.mzaddon) and its release.json from your build tool.')); return; }
      const out = [];
      let res; try { res = ADDON.parseSidecar(await sideIn.files[0].text(), known); } catch (e) { res = { ok: false, errors: ['Could not read release.json: ' + e.message] }; }
      if (my !== seqToken) return;
      if (!res.ok) res.errors.forEach((e) => out.push(line(false, e))); else out.push(line(true, 'release.json is valid'));
      let buf = null, pkg = null;
      try {
        buf = await pkgIn.files[0].arrayBuffer();
        pkg = { name: pkgIn.files[0].name, size: buf.byteLength, head: new Uint8Array(buf.slice(0, 4)), sha256: await ADDON.sha256Hex(buf, window.crypto && window.crypto.subtle) };
      } catch (e) { out.push(line(false, 'Could not read/hash the package: ' + e.message)); }
      if (my !== seqToken) return;
      if (pkg) out.push(line(true, `Package: ${pkg.name}, ${ADDON.fmtBytes(pkg.size)} (${pkg.size} bytes), SHA-256 ${pkg.sha256}`));
      let errs = [];
      if (res.ok && pkg) {
        errs = ADDON.checkPackage(res.release, pkg).concat(ADDON.conflictsWith(res.release, releases));
        if (releaseFor && res.release.addon_id !== releaseFor.addon_id) errs.push(`This package is for add-on “${res.release.addon_id}”, but you are releasing “${releaseFor.title}” which is linked to “${releaseFor.addon_id}”. Choose the right package, or press “Stop releasing this announcement”.`);
        if (releaseFor && res.release.channel !== 'stable') errs.push('An announcement is only promoted by a STABLE release. Publish a stable release for it.');
        if (!errs.length) out.push(line(true, 'The package matches release.json (size and SHA-256), and the version/seq are new'));
        errs.forEach((e) => out.push(line(false, e)));
      }
      checks.replaceChildren(h('ul', { class: 'checks' }, out));
      if (res.ok) {
        const r = res.release;
        preview.replaceChildren(h('div', { class: 'card', style: 'margin-top:12px' }, h('h3', {}, 'Release preview'),
          h('p', { style: 'margin:0 0 4px' }, h('b', {}, r.title), ` — ${r.addon_id} ${r.version} (seq ${r.seq}, ${r.channel})`),
          h('p', {}, r.summary || '—'),
          h('p', { class: 'hint' }, `Unlocked by feature ${r.feature_key} · works with core ${r.min_core || 'any'} to ${r.max_core || 'any'} · uploads to ${r.storage_path}`),
          ADDON.noteSections(r.notes).map(([t, lines]) => h('div', {}, h('h3', { style: 'margin-top:10px' }, t), h('ul', {}, lines.map((x) => h('li', {}, x))))),
          ADDON.noteSections(r.notes).length ? null : h('p', { class: 'hint' }, 'No release notes in this release.')));
      }
      if (res.ok && pkg && !errs.length) { ready = { release: res.release, buf }; publishBtn.disabled = false; }
    }
    pkgIn.addEventListener('change', check); sideIn.addEventListener('change', check);

    async function runPublish() {
      if (busy || !ready) return;
      busy = true; publishBtn.disabled = true; pkgIn.disabled = sideIn.disabled = true;
      const { release, buf } = ready; const retry = () => runPublish();
      const fail = (stage, msg) => {
        busy = false; publishBtn.disabled = false; pkgIn.disabled = sideIn.disabled = false; toast(msg, true);
        const acts = [h('button', { class: 'btn small primary', id: 'btn-addon-retry', type: 'button', onclick: retry }, 'Retry')];
        if (uploaded) acts.push(h('button', { class: 'btn small danger', id: 'btn-addon-remove', type: 'button', onclick: async () => {
          const { error } = await sb.storage.from('addons').remove([release.storage_path]);
          if (error) return toast('Could not remove the uploaded file: ' + error.message, true);
          uploaded = false; toast('Uploaded file removed'); setStatus('err', 'The uploaded file was removed. Nothing is published.', [h('button', { class: 'btn small primary', type: 'button', onclick: retry }, 'Retry upload and publish')]);
        } }, 'Remove uploaded file'));
        setStatus('err', stage === 'upload'
          ? `Upload failed, so NOTHING was published: ${msg}`
          : `The package was uploaded to Storage but the release was NOT published: ${msg}. Users cannot see or download it. Retry will repeat only the publish step; or remove the uploaded file.`, acts);
      };
      try {
        const fresh = await rpc('admin_list_addon_releases');                 // someone may have published meanwhile: re-check before touching Storage
        const conflicts = ADDON.conflictsWith(release, fresh);
        if (conflicts.length) { busy = false; pkgIn.disabled = sideIn.disabled = false; setStatus('err', conflicts.join(' ')); toast('Not published: ' + conflicts[0], true); return; }
      } catch (e) { return fail('upload', 'Could not check the existing releases: ' + e.message); }
      if (!uploaded) {
        setStatus('info', `Uploading ${ADDON.fmtBytes(release.size)} to Storage…`);
        const { error } = await sb.storage.from('addons').upload(release.storage_path, buf, { contentType: 'application/zip', upsert: true });
        if (error) return fail('upload', error.message || String(error));
        uploaded = true;
      }
      setStatus('info', 'Package uploaded. Publishing the release…');
      try {
        await rpc('admin_publish_addon', { p: release });
      } catch (e) { return fail('publish', e.message); }
      let activated = false;
      if (activateIn.checked) {
        try {
          const cur = ADDON.selectionFor(await rpc('admin_get_addon_selection').catch(() => []), release.addon_id);
          await rpc('admin_set_addon_active', { p_addon: release.addon_id, p_version: release.version, p_expected_revision: cur ? cur.revision : null });
          activated = true;
        } catch (e) { toast(`Published, but could not make it active: ${e.message}. Use “Make active” in the table.`, true); }
      }
      busy = false; toast(`${release.addon_id} ${release.version} published${activated ? ' and active' : ''}${releaseFor && releaseFor.addon_id === release.addon_id ? '. The announcement was promoted to Add-ons.' : ''}`);
      go('addons');
    }

    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', {}, 'Add-ons'), h('button', { class: 'btn small', id: 'btn-addons-refresh', onclick: () => go('addons') }, 'Refresh')),
      h('p', { class: 'hint' }, 'Optional modules the app downloads. Who may download and use each one is set under Pages → Add-on features. Free users see every add-on in the app; locked ones have Download disabled. Publishing a release does not change what users get unless “Make active after publishing” is ticked: the ACTIVE version is the only one offered. You can make an older version active again (rollback).'),
      upcomingPanel(),
      managerPanel(),
      historyPanel(),
      h('div', { id: 'addon-selection' }, selectionPanels()),
      h('div', { class: 'tablewrap' }, h('table', { id: 'addon-releases' }, h('thead', {}, h('tr', {}, ['Add-on', 'Version', 'Seq', 'Size', 'SHA-256', 'Published', 'Feature key', 'State', 'Actions'].map((x) => h('th', {}, x)))),
        releases.length ? rows : h('tbody', {}, h('tr', {}, h('td', { colspan: '9' }, 'No releases published yet.'))))),
      h('div', { class: 'card', id: 'addon-publish', style: 'margin-top:20px' }, h('h3', {}, 'Publish a new release'), releaseBanner,
        h('p', { class: 'hint' }, 'Use the two files your build tool produced. The panel checks that the package is exactly what release.json describes (size and SHA-256 are computed here, in your browser) before anything is uploaded.'),
        h('div', { class: 'field' }, h('label', {}, 'Signed package (.mzaddon, a ZIP)'), pkgIn),
        h('div', { class: 'field' }, h('label', {}, 'Release sidecar (release.json)'), sideIn),
        h('div', { class: 'field' }, h('label', {}, activateIn, ' Make active after publishing (users are offered this version)')),
        checks, preview, h('div', { class: 'row', style: 'margin-top:12px' }, publishBtn), status));
    checks.replaceChildren(h('p', { class: 'hint' }, 'Choose the signed package (.mzaddon) and its release.json from your build tool.'));
    drawReleaseBanner();
  }

  // ------------------------------------------------------ API configuration
  // The Meta Generator provider / model CATALOGUE (migration 0021). Everything the app offers comes from here: add / rename / remove providers and
  // models, switch them on or off, and publish the adapter package a provider needs. Switching something off is mirrored into ai_access so older
  // apps keep honouring it. Apify belongs to Adobe Tracker and is NOT here. Users' API keys are never stored or shown here.
  async function pageAi(main) {
    const PL = window.ProviderLogic;
    const bucket = () => sb.storage.from('ai-providers');
    let list = await rpc('admin_list_ai_catalog');
    // Removed Providers & Models (migration 0026): "Remove" ARCHIVES (nothing is deleted) and the archive stays restorable forever. If the server does not
    // have 0026 yet the list cannot load: then every Remove button is disabled, so no older delete path can be used by accident.
    let removed = { providers: [], models: [] }, archiveReady = true, rmTab = 'providers', rmQuery = '';
    const loadRemoved = async () => { try { removed = await rpc('admin_list_removed_ai_catalog'); archiveReady = true; } catch (e) { removed = { providers: [], models: [] }; archiveReady = false; } };
    await loadRemoved();
    let jobs = [];
    const loadJobs = async () => { try { jobs = await rpc('admin_list_ai_force_updates', { p_limit: 30 }); } catch (e) { jobs = []; } };
    await loadJobs();
    const reload = async (fn, okMsg) => { const r = await act(fn, okMsg); list = (r && r.catalog) || (Array.isArray(r) ? r : list); if (r && r.removed) removed = r.removed; draw(); return r; };

    // Restore Default Providers (v1.0.0, 7th Edition): puts back ORIGINAL default providers / models that were deleted. The server function only INSERTS
    // what is missing (ON CONFLICT DO NOTHING): nothing that exists is changed, re-enabled or removed, and no user's API key is involved.
    const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
    function restoreSummary(r) {
      const np = Number(r && r.restored_providers) || 0, nm = Number(r && r.restored_models) || 0;
      const provs = (r && r.providers) || [], models = (r && r.models) || [];
      const body = np + nm === 0
        ? h('p', { id: 'ai-restore-summary' }, 'Nothing to restore: every default provider and model is already in the catalogue. Nothing was changed.')
        : h('div', { id: 'ai-restore-summary' },
          h('p', {}, `Restored ${plural(np, 'provider', 'providers')} and ${plural(nm, 'model', 'models')}.`),
          provs.length ? h('p', { class: 'hint' }, 'Providers: ' + provs.join(', ')) : null,
          models.length ? h('p', { class: 'hint' }, 'Models: ' + models.map((m) => `${m.provider} / ${m.model}`).join(', ')) : null,
          h('p', { class: 'hint' }, 'Existing providers and models were not changed.'));
      modal('Default providers restored', body, [{ label: 'OK', cls: 'primary', run: (c) => c() }]);
    }
    function restoreDefaults() {
      modal('Restore default providers?', h('div', {},
        h('p', {}, 'The original default providers (OpenRouter, Gemini, Mistral, Groq, Cerebras, OpenAI, Claude, Grok) and their default models that are missing from this catalogue will be added back, with their original settings.'),
        h('p', {}, 'Providers and models that already exist stay exactly as they are: nothing is overwritten, re-enabled or removed, and custom providers, custom models and provider packages are untouched. Default models you removed from a provider that still exists are added back too.'),
        h('p', { class: 'hint' }, 'Safe to repeat: it never creates duplicates. Users’ API keys are not involved.')), [
        { label: 'Cancel', run: (c) => c() },
        { label: 'Restore', cls: 'primary', run: async (c) => {
          const r = await act(() => rpc('admin_restore_default_ai_catalog'));
          if (r && Array.isArray(r.catalog)) list = r.catalog; else { try { list = await rpc('admin_list_ai_catalog'); } catch (e) { /* keep what is shown */ } }
          c(); draw(); restoreSummary(r);
        } }]);
    }

    // Force Update: preview first (target, version, size, summary), then an explicit confirmation. The server refuses a push whose confirmation value
    // is not the one the preview returned, so there is no way to push without having been shown the target.
    async function forceModal(scope, prov, model) {
      let pv;
      try { pv = await act(() => rpc('admin_preview_ai_force_update', { p_scope: scope, p_provider: prov.provider, p_model: model ? model.id : null, p_package_id: null })); } catch (e) { return; }
      const lines = PL.previewLines(pv);
      const note = h('input', { id: 'fu-note', class: 'input', placeholder: 'Optional note shown to you in the job list' });
      modal(scope === 'model' ? `Force update model ${model.id}` : `Force update ${prov.provider}`, h('div', { id: 'fu-preview' },
        h('p', {}, 'This is a mandatory update, not a notice: every device that is online installs it automatically; offline devices install it as soon as they are back online. API keys and user data are never touched.'),
        h('table', { class: 'inner-table' }, h('tbody', {}, lines.map(([k, v]) => h('tr', {}, h('th', {}, k), h('td', { style: k === 'Warning' ? 'color:#e5a24c' : '' }, String(v)))))),
        pv.duplicate_job ? h('p', { class: 'hint', id: 'fu-dup' }, 'The same update is already active. Confirming returns that job; nothing is duplicated.') : null,
        h('div', { class: 'field' }, h('label', {}, 'Note'), note)), [
        { label: 'Cancel', run: (c) => c() },
        { label: 'Push force update', cls: 'danger', run: async (c) => {
          try {
            const r = await act(() => rpc('admin_push_ai_force_update', { p_scope: scope, p_provider: prov.provider, p_model: model ? model.id : null, p_package_id: null, p_confirm: pv.confirm, p_note: note.value.trim() }),
              null);
            toast(r.duplicate ? 'Already active - no duplicate job was created' : 'Force update queued'); jobs = r.jobs || jobs; draw(); c();
          } catch (e) { return true; }
        } }]);
    }

    function targetsModal(j) {
      const body = h('div', { id: 'fu-targets' }, h('p', { class: 'hint' }, 'Loading…'));
      modal(`Devices for ${j.provider}${j.model_id ? ' / ' + j.model_id : ''} ${j.version || ''}`, body, [{ label: 'Close', run: (c) => c() }]);
      rpc('admin_list_ai_force_update_targets', { p_job: j.id, p_status: null, p_limit: 200 }).then((rows) => {
        body.replaceChildren(rows.length ? h('table', { class: 'inner-table' }, h('thead', {}, h('tr', {}, ['Account', 'Device', 'State', 'Tries', 'Version', 'Updated', 'Reason'].map((x) => h('th', {}, x)))),
          h('tbody', {}, rows.map((r) => h('tr', {}, h('td', {}, r.user || '—'), h('td', {}, h('code', {}, r.device)), h('td', {}, PL.STATE_LABEL[r.status] || r.status), h('td', {}, r.attempts), h('td', {}, r.version || '—'), h('td', {}, fmtShort(r.updated_at)), h('td', {}, r.error || ''))))) : h('p', {}, 'No device has contacted the server about this update yet.'));
      }).catch((e) => body.replaceChildren(h('p', { class: 'warn' }, e.message)));
    }

    function jobsPanel() {
      const rows = jobs.map((j) => h('tr', { 'data-job': j.id },
        h('td', {}, h('b', {}, j.provider), j.model_id ? h('div', {}, h('code', {}, j.model_id)) : null),
        h('td', {}, (j.kind === 'rollback' ? 'Rollback' : j.scope === 'model' ? 'Model update' : 'Package update') + (j.version ? ' ' + j.version : '')),
        h('td', {}, h('span', { class: 'badge' }, j.status), ' ', h('span', { class: 'hint' }, fmtShort(j.created_at))),
        h('td', { 'data-counts': '1' }, PL.jobSummary(j), j.last_error ? h('div', { class: 'hint', style: 'color:#e5686b' }, 'Last failure: ' + j.last_error) : null),
        h('td', { class: 'actions' }, h('button', { class: 'btn small', 'data-act': 'devices', onclick: () => targetsModal(j) }, 'Devices'),
          PL.canCancelJob(j) ? h('button', { class: 'btn small', 'data-act': 'cancel-job', onclick: () => confirmBox('Cancel this force update?', 'Devices that have not installed it yet stop. Devices that already installed it keep it (use Roll back to undo that).', 'Cancel update', async () => {
            jobs = await act(() => rpc('admin_cancel_ai_force_update', { p_job: j.id }), 'Cancelled'); draw(); }) }, 'Cancel') : null,
          PL.canRollbackJob(j) ? h('button', { class: 'btn small danger', 'data-act': 'rollback-job', onclick: () => confirmBox('Roll back this update?', 'Creates a separate rollback job: devices that installed this update go back to their previous copy. Other devices are not changed.', 'Roll back', async () => {
            const r = await act(() => rpc('admin_rollback_ai_force_update', { p_job: j.id, p_note: '' }), 'Rollback queued'); jobs = r.jobs || jobs; draw(); }) }, 'Roll back') : null)));
      return h('div', { id: 'fu-jobs' }, h('div', { class: 'toolbar' }, h('h3', {}, 'Force updates'),
        h('button', { class: 'btn small', id: 'fu-refresh', onclick: async () => { await loadJobs(); draw(); toast('Refreshed'); } }, 'Refresh')),
        jobs.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Target', 'Update', 'Job', 'Devices', ''].map((x) => h('th', {}, x)))), h('tbody', {}, rows)))
          : h('p', { class: 'hint' }, 'No force update has been pushed yet.'));
    }

    // ============ OpenAI-compatible Provider Builder + Model Import (v1.0.0, 7th Edition Part 4) ============
    // The provider settings are saved with admin_upsert_ai_openai_provider (0027) and models are imported with admin_import_ai_models (0028, insert-only).
    // The checks run the Part 3 Python runtime through the LOCAL BRIDGE (scripts/provider_bridge.py); this page never calls a provider itself.
    // The provider API key is typed into a password box, sent to the bridge in ONE request and dropped: it is never stored, logged or sent to Supabase.
    const CL = window.CompatLogic;
    const bridge = CL.makeBridge();
    const providerExists = (k) => list.find((x) => x.provider === String(k || '').trim());
    const compatProviders = () => list.filter(CL.isCompat);
    const applyCatalog = (r) => { list = (r && r.catalog) || (Array.isArray(r) ? r : list); if (r && r.removed) removed = r.removed; draw(); };
    const sel = (id, options, value) => { const s = h('select', { id, class: 'input' }, options.map(([v, t]) => h('option', { value: v }, t))); s.value = value; return s; };
    const colorOf = (ok) => (ok === true ? '#4caf7d' : ok === false ? '#e5686b' : '#9aa0aa');

    /** One result of a bridge check -> DOM. Failures say WHAT kind of problem it is (CompatLogic.explainFailure) and never contain the key. */
    function resultNode(label, r) {
      const box = h('div', { class: 'compat-result', style: 'margin:6px 0' });
      if (r && Array.isArray(r.stages)) {                                  // run_checks report
        for (const s of r.stages) box.append(resultNode(CL.stageLabel(s.name), Object.assign({ stage: s.name }, s)));
        box.append(h('div', { style: 'font-weight:600;color:' + colorOf(r.ok) }, r.ok ? '✓ All checks passed' : '✗ The checks stopped at the first failure'));
        return box;
      }
      if (r && r.skipped) { box.append(h('div', { style: 'color:' + colorOf(null) }, `– ${label}: skipped`), h('div', { class: 'hint' }, r.detail || '')); return box; }
      if (r && r.ok === true) {
        const bits = [];
        if (r.http_status) bits.push('HTTP ' + r.http_status);
        if (r.latency_ms != null) bits.push(r.latency_ms + ' ms');
        if (r.count != null) bits.push(r.count + ' models');
        if (r.supports_model_list === false) bits.push('no models endpoint');
        if (r.model) bits.push(r.model + (r.with_image ? ' (with image)' : ''));
        box.append(h('div', { style: 'color:' + colorOf(true) }, `✓ ${label} — OK`), bits.length ? h('div', { class: 'hint' }, bits.join(' · ')) : null,
          r.reply_preview ? h('div', { class: 'hint' }, 'Reply: ' + r.reply_preview) : null,
          r.urls ? h('div', { class: 'hint' }, 'Chat: ' + r.urls.chat + (r.urls.models ? ' · Models: ' + r.urls.models : '')) : null,
          r.detail ? h('div', { class: 'hint' }, r.detail) : null, r.note ? h('div', { class: 'hint' }, r.note) : null);
        for (const w of r.warnings || []) box.append(h('div', { class: 'hint', style: 'color:#e5a24c' }, '! ' + w));
        return box;
      }
      const ex = CL.explainFailure(r);
      box.append(h('div', { style: 'color:' + colorOf(false) }, `✗ ${label} — ${ex.category}`), h('div', { class: 'hint' }, ex.advice));
      if (r && r.error && r.error !== ex.advice && !r.bridgeDown && r.stage !== 'config') box.append(h('div', { class: 'hint' }, 'Details: ' + r.error));
      return box;
    }

    /** Connection box for the local bridge (shared by the provider dialog and the import dialog; address and code are kept in memory for this Admin session). */
    function bridgePanel() {
      const url = h('input', { class: 'input', id: 'br-url', value: bridge.state.url, 'aria-label': 'Bridge address' });
      const tok = h('input', { class: 'input', id: 'br-token', type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: 'Access code from the bridge window', value: bridge.state.token, 'aria-label': 'Bridge access code' });
      const status = h('span', { class: 'hint', id: 'br-status' }, bridge.state.token ? 'Not checked yet.' : 'Not connected.');
      const ensure = () => bridge.configure(url.value, tok.value);
      const btn = h('button', { class: 'btn small', type: 'button', id: 'br-connect', onclick: async () => {
        ensure(); btn.disabled = true; status.style.color = ''; status.textContent = 'Connecting…';
        const r = await bridge.health(); btn.disabled = false;
        status.style.color = colorOf(!!r.ok); status.textContent = r.ok ? '✓ Connected to the local bridge.' : '✗ ' + r.error;
      } }, 'Connect');
      const el = h('details', { class: 'compat-bridge', open: !bridge.state.token },
        h('summary', {}, 'Local bridge (needed for the checks and the model list)'),
        h('p', { class: 'hint' }, 'The checks run the same Python code as the app, on this computer. ' + CL.START_HELP + ' The API key you type below goes only to this bridge for one check; it is not saved.'),
        h('div', { class: 'row' }, url, tok, btn), status);
      return { el, ensure };
    }

    // ------------------------------------------------------------------ add / edit a provider (Built-in, OpenAI-Compatible or Downloaded Package)
    function providerModal(existing, startAdapter) {
      const f = existing || { provider: '', title: '', enabled: true, hidden: false, vision: true, key_url: '', key_hint: '', validate: '', adapter: startAdapter || 'openai_compat', sort_order: (list.length + 1) * 10, failover_order: (list.length + 1) * 10 };
      const inp = (id, v, ph) => h('input', { id, class: 'input', value: v == null ? '' : v, placeholder: ph || '' });
      const key = inp('aip-key', f.provider, 'LettersDigits'), title = inp('aip-title', f.title), url = inp('aip-url', f.key_url, 'https://…'), hint = inp('aip-hint', f.key_hint), val = inp('aip-val', f.validate, 'optional');
      if (existing) key.disabled = true;
      const vision = h('input', { type: 'checkbox', id: 'aip-vision' }); vision.checked = !!f.vision;
      const hidden = h('input', { type: 'checkbox', id: 'aip-hidden' }); hidden.checked = !!f.hidden;
      const enabled = h('input', { type: 'checkbox', id: 'aip-enabled' }); enabled.checked = f.enabled !== false;
      const adapter = h('select', { id: 'aip-adapter', class: 'input' },
        h('option', { value: 'openai_compat' }, 'OpenAI-Compatible (no package needed)'), h('option', { value: 'package' }, 'Downloaded Package'), h('option', { value: 'builtin' }, 'Built-in (part of the app)'));
      adapter.value = f.adapter || 'package';
      // an existing provider's adapter type is never switched silently: a compatible provider stays compatible; Built-in / Package providers cannot become compatible
      if (existing && CL.isCompat(existing)) adapter.disabled = true;
      if (existing && !CL.isCompat(existing)) adapter.querySelector('option[value="openai_compat"]').disabled = true;
      const sort = inp('aip-sort', f.sort_order), fail = inp('aip-fail', f.failover_order);
      const err = h('p', { class: 'hint', id: 'aip-err', style: 'color:#e5686b' });
      let checkedSig = '';   // Part 80: signature of the configuration a real connection check passed for in this dialog

      // ---- OpenAI-compatible section
      const c = CL.configToForm(existing && existing.compat);
      const base = inp('aip-base', c.base_url, 'https://api.example.com/v1');
      const authScheme = sel('aip-auth', [['bearer', 'Bearer token (Authorization header) — most providers'], ['header', 'Custom header (for example x-api-key)']], c.auth_scheme);
      const authHeader = inp('aip-authheader', c.auth_header, 'x-api-key'), authPrefix = inp('aip-authprefix', c.auth_prefix, 'optional text before the key');
      const chatPath = inp('aip-chat', c.chat_path), modelsPath = inp('aip-models', c.models_path, '/models  (empty = the provider has no model list)');
      const timeout = inp('aip-timeout', c.timeout_seconds), tokField = sel('aip-tokfield', [['max_tokens', 'max_tokens'], ['max_completion_tokens', 'max_completion_tokens']], c.max_tokens_field);
      const extra = h('textarea', { id: 'aip-extra', class: 'input', rows: '3', placeholder: 'Name: value   (one per line; never put a key or token here)' }); extra.value = CL.headersToText(c.extra_headers);
      const headerRow = h('div', { class: 'field', id: 'aip-header-row' }, h('label', {}, 'API key header name and optional prefix'), h('div', { class: 'row' }, authHeader, authPrefix));
      const testKey = h('input', { class: 'input', id: 'aip-testkey', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: 'API key for these checks (not saved)', 'aria-label': 'API key for the checks' });
      const testModel = h('input', { class: 'input', id: 'aip-testmodel', placeholder: 'Model ID to test', list: 'aip-model-list' });
      const modelList = h('datalist', { id: 'aip-model-list' }, ((existing && existing.models) || []).map((m) => h('option', { value: m.id })));
      const withImage = h('input', { type: 'checkbox', id: 'aip-testimage' });
      const out = h('div', { id: 'aip-check-out', 'aria-live': 'polite' });
      const panel = bridgePanel();
      const formValues = () => { const hd = CL.parseHeaderLines(extra.value); return { v: { base_url: base.value, chat_path: chatPath.value, models_path: modelsPath.value, auth_scheme: authScheme.value, auth_header: authHeader.value,
        auth_prefix: authPrefix.value, extra_headers: hd.headers, timeout_seconds: timeout.value, max_tokens_field: tokField.value }, headerErrors: hd.errors }; };
      const checkBtns = [];
      const checkBtn = (id, label, fn, counts) => { const b = h('button', { class: 'btn small', type: 'button', id, onclick: () => runIt(b, label, fn, counts !== false) }, label); checkBtns.push(b); return b; };
      async function runIt(btn, label, fn, counts) {
        const { v, headerErrors } = formValues();
        const problems = CL.missingFields(v).concat(headerErrors);
        if (problems.length) { out.replaceChildren(...problems.map((x) => h('div', { class: 'hint', style: 'color:#e5686b' }, '✗ ' + x))); return; }
        const old = btn.textContent; checkBtns.forEach((b) => { b.disabled = true; }); btn.textContent = 'Checking…'; out.replaceChildren(h('p', { class: 'hint' }, 'Working…'));
        try {
          panel.ensure(); const cfgNow = CL.buildConfig(v); const r = await fn(cfgNow, testKey.value.trim()); out.replaceChildren(resultNode(label.replace(/^(Test|Validate|Fetch|Run) /, ''), r));
          if (counts && r && r.ok === true && !r.skipped) checkedSig = CL.configSignature(cfgNow);   // Part 80: a real connection check passed for exactly this configuration
        }
        finally { checkBtns.forEach((b) => { b.disabled = false; }); btn.textContent = old; }
      }
      // Part 80: provider presets (new providers only): fill the settings, never a key. Everything stays editable.
      const preset = sel('aip-preset', CL.PRESETS.map((p) => [p.id, p.label]), 'custom');
      preset.addEventListener('change', () => {
        const p = CL.presetById(preset.value); if (!p.fill) return;
        adapter.value = 'openai_compat'; if (!existing) { key.value = p.fill.provider; title.value = p.fill.title; }
        base.value = p.fill.base_url; chatPath.value = p.fill.chat_path; modelsPath.value = p.fill.models_path; authScheme.value = 'bearer'; url.value = p.fill.key_url; hint.value = p.fill.key_hint;
        checkedSig = ''; out.replaceChildren(); syncKind();
      });
      const needKey = (k) => (k ? null : { ok: false, stage: 'request', classification: 'INVALID_API_KEY', error: 'Enter the API key for these checks first. It is used once and not saved.' });
      const needModel = () => testModel.value.trim();
      const checks = h('div', { class: 'card compat-checks', id: 'aip-checks', style: 'margin-top:10px' }, h('h3', {}, 'Check this provider'),
        h('p', { class: 'hint' }, 'Nothing is saved by these buttons. “Validate” and “Test Connection” need no key.'), panel.el,
        h('div', { class: 'field' }, h('label', {}, 'API key (only for this check; never stored or sent to the database)'), testKey),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
          checkBtn('aip-b-validate', 'Validate Configuration', (cfg) => bridge.run('validate', cfg), false),
          checkBtn('aip-b-connect', 'Test Connection', (cfg) => bridge.run('connect', cfg)),
          checkBtn('aip-b-auth', 'Test Authentication', async (cfg, k) => needKey(k) || bridge.run('auth', cfg, k)),
          checkBtn('aip-b-models', 'Fetch Models', async (cfg, k) => {
            const r = needKey(k) || await bridge.run('models', cfg, k);
            if (r.ok && Array.isArray(r.models)) { modelList.replaceChildren(...r.models.slice(0, 500).map((m) => h('option', { value: m.id }))); r.detail = 'Use “Import models” on the provider row to add them to the catalogue.'; }
            return r;
          })),
        h('div', { class: 'field' }, h('label', {}, 'Test one model'), h('div', { class: 'row' }, testModel, h('label', { class: 'hint', style: 'white-space:nowrap' }, withImage, ' also send an image')), modelList),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px' },
          checkBtn('aip-b-test', 'Test Selected Model', async (cfg, k) => needKey(k) || (needModel() ? bridge.run('test', cfg, k, { model: needModel(), with_image: withImage.checked }) : { ok: false, stage: 'request', error: 'Enter the model ID to test.' })),
          checkBtn('aip-b-all', 'Run All Checks', async (cfg, k) => bridge.run('all', cfg, k || undefined, { model: needModel() || undefined, with_image: withImage.checked }))), out);
      const compatSection = h('div', { id: 'aip-compat' },
        h('div', { class: 'field' }, h('label', {}, 'Base URL (the provider’s API address, https)'), base),
        h('div', { class: 'field' }, h('label', {}, 'Authentication'), authScheme), headerRow,
        h('details', { class: 'compat-advanced' }, h('summary', {}, 'Advanced settings (the defaults suit most providers)'),
          h('div', { class: 'field' }, h('label', {}, 'Chat completions path'), chatPath),
          h('div', { class: 'field' }, h('label', {}, 'Models listing path (empty = the provider cannot list its models)'), modelsPath),
          h('div', { class: 'field' }, h('label', {}, 'Request timeout in seconds (5–120)'), timeout),
          h('div', { class: 'field' }, h('label', {}, 'Token-limit field name'), tokField),
          h('div', { class: 'field' }, h('label', {}, 'Custom headers (non-secret only; this catalogue is readable by every signed-in user)'), extra)),
        checks);
      const keyCheckRow = h('div', { class: 'field', id: 'aip-val-row' }, h('label', {}, 'Key check type (built-in providers only)'), val);
      const syncKind = () => {
        const comp = adapter.value === 'openai_compat';
        compatSection.style.display = comp ? '' : 'none'; keyCheckRow.style.display = comp ? 'none' : '';
        headerRow.style.display = authScheme.value === 'header' ? '' : 'none';
      };
      adapter.addEventListener('change', syncKind); authScheme.addEventListener('change', syncKind); syncKind();

      const save = async (close) => {
        const comp = adapter.value === 'openai_compat';
        if (!PL.validKey(key.value)) { err.textContent = 'The key must start with a letter and use only letters, digits, . _ - (max 40).'; return true; }
        if (!title.value.trim()) { err.textContent = 'Enter a display title.'; return true; }
        const k = key.value.trim(), clash = !existing && providerExists(k);
        if (clash) { err.textContent = `A provider with the key “${k}” already exists (${CL.adapterLabel(clash.adapter)}). It is not changed or converted: use a new provider key.`; return true; }
        if (!existing && PL.isRemovedProviderKey(removed, k)) { err.textContent = `${k} was removed earlier. Restore it from Removed Providers & Models instead of adding it again; nothing was changed.`; return true; }
        const base_ = { p_key: k, p_title: title.value.trim(), p_hidden: hidden.checked, p_vision: vision.checked, p_key_url: url.value.trim(), p_key_hint: hint.value.trim(), p_sort: parseInt(sort.value, 10) || 100, p_failover: parseInt(fail.value, 10) || 100 };
        if (!comp) {
          try { await reload(() => rpc('admin_upsert_ai_provider', Object.assign(base_, { p_enabled: enabled.checked, p_validate_kind: val.value.trim(), p_adapter: adapter.value })), 'Provider saved'); close(); } catch (e) { err.textContent = CL.friendlyDbError(e.message); return true; }
          return;
        }
        const { v, headerErrors } = formValues(); const problems = CL.missingFields(v).concat(headerErrors);
        if (problems.length) { err.textContent = problems.join(' '); return true; }
        const cfg = CL.buildConfig(v);
        err.textContent = '';
        confirmSave(k, cfg, base_, enabled.checked, !!existing, close);
        return true;                                                         // the provider dialog stays open until the confirmation is accepted
      };
      modal(existing ? `Edit ${f.provider}` : 'Add provider', h('div', {},
        existing ? null : h('div', { class: 'field' }, h('label', {}, 'Start from'), preset),
        h('div', { class: 'field' }, h('label', {}, 'Adapter type'), adapter),
        h('div', { class: 'field' }, h('label', {}, 'Provider key (no spaces; cannot change later)'), key),
        h('div', { class: 'field' }, h('label', {}, 'Display name'), title),
        compatSection,
        h('div', { class: 'field' }, h('label', {}, 'Where to get a key (link)'), url),
        h('div', { class: 'field' }, h('label', {}, 'Key hint'), hint), keyCheckRow,
        h('div', { class: 'field' }, h('label', {}, vision, ' Understands images (a single model can still be marked Text only)')),
        h('div', { class: 'field' }, h('label', {}, enabled, ' Enabled')),
        h('div', { class: 'field' }, h('label', {}, hidden, ' Hidden (kept in the catalogue, not offered to users)')),
        h('div', { class: 'field' }, h('label', {}, 'Order in Settings / order tried (smaller first)'), h('div', { class: 'row' }, sort, fail)), err), [
        { label: 'Cancel', run: (cl) => cl() },
        { label: 'Save', cls: 'primary', run: save }]);

      function confirmSave(k, cfg, base_, isEnabled, isEdit, closeOuter) {
        // Part 80: a provider is published (enabled for users) only when a real connection check passed for exactly this configuration, or the admin accepts publishing without one.
        const verified = !!checkedSig && checkedSig === CL.configSignature(cfg);
        const accept = h('input', { type: 'checkbox', id: 'aip-publish-unchecked' });
        const gate = isEnabled && !verified ? h('div', { class: 'field', id: 'aip-gate' }, h('p', { class: 'hint', style: 'color:#e5a24c' }, 'No connection check has passed for this configuration in this dialog. Unless you tick the box below, it is saved DISABLED (not offered to users).'), h('label', {}, accept, ' Publish to users without a passing check')) : null;
        const lines = [['Provider', `${base_.p_title} (${k})`], ['Base URL', cfg.base_url], ['Authentication', cfg.auth_scheme === 'header' ? `Header ${cfg.auth_header}` : 'Bearer token'],
          ['Model list', cfg.models_path ? cfg.models_path : 'none'], ['Status', (isEnabled ? 'Enabled' : 'Disabled') + (base_.p_hidden ? ', hidden' : '')], ['Checked', verified ? 'Yes — a connection check passed' : 'No']];
        modal(isEdit ? `Save changes to ${k}?` : `Add ${k}?`, h('div', {},
          h('table', { class: 'inner-table' }, h('tbody', {}, lines.map(([a, b]) => h('tr', {}, h('th', {}, a), h('td', {}, String(b)))))),
          h('p', { class: 'hint' }, 'Only these settings are saved to the catalogue. No API key is stored: users keep their own keys on their computers. Saving may change what users see after their next catalogue refresh.'),
          gate, h('p', { class: 'hint', id: 'aip-confirm-err', style: 'color:#e5686b' })), [
          { label: 'Back', run: (cl) => cl() },
          { label: isEdit ? 'Save changes' : 'Add provider', cls: 'primary', run: async (cl) => {
            const box = document.getElementById('aip-confirm-err');
            try {
              const pub = CL.publishEnabled(isEnabled, checkedSig, cfg, accept.checked);
              const r = await rpc('admin_upsert_ai_openai_provider', Object.assign({}, base_, { p_config: cfg, p_enabled: pub }));
              applyCatalog(r); toast(isEnabled && !pub ? 'Provider saved disabled (not checked)' : 'Provider saved'); cl(); closeOuter();
            } catch (e) { if (box) box.textContent = CL.friendlyDbError(e.message); return true; }
          } }]);
      }
    }

    // ------------------------------------------------------------------ add / edit one model (a compatible provider also gets the Text only switch)
    function modelModal(prov, existing) {
      const m = existing || { id: '', label: '', enabled: true, sort_order: ((prov.models || []).length + 1) * 10, text_only: true };
      const comp = CL.isCompat(prov);
      const id = h('input', { id: 'aim-id', class: 'input', value: m.id }), label = h('input', { id: 'aim-label', class: 'input', value: m.label }), sort = h('input', { id: 'aim-sort', class: 'input', value: m.sort_order });
      const textOnly = h('input', { type: 'checkbox', id: 'aim-textonly' }); textOnly.checked = m.text_only !== false && (comp ? true : false);
      if (comp && existing) textOnly.checked = !!existing.text_only;
      if (existing) id.disabled = true;
      const err = h('p', { class: 'hint', style: 'color:#e5686b' });
      modal(existing ? `Edit model ${m.id}` : `Add model to ${prov.provider}`, h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Model ID sent to the provider (cannot change later)'), id),
        h('div', { class: 'field' }, h('label', {}, 'Name users see'), label),
        h('div', { class: 'field' }, h('label', {}, 'Order (smaller first)'), sort),
        comp ? h('div', { class: 'field' }, h('label', {}, textOnly, ' Text only (never sent images). Untick only for a model you know reads images; “Test Selected Model” with an image can confirm it.')) : null, err), [
        { label: 'Cancel', run: (c) => c() },
        { label: 'Save', cls: 'primary', run: async (c) => {
          if (!id.value.trim() || !label.value.trim()) { err.textContent = 'Enter the model ID and the name.'; return true; }
          if (!existing && (prov.models || []).some((x) => x.id === id.value.trim())) { err.textContent = `${id.value.trim()} already exists in ${prov.provider}. Use Edit on that model; nothing was changed.`; return true; }
          if (!existing && PL.isRemovedModelId(removed, prov.provider, id.value)) { err.textContent = `${id.value.trim()} was removed earlier. Restore it from Removed Providers & Models instead of adding it again; nothing was changed.`; return true; }
          try {
            let r = await rpc('admin_upsert_ai_model', { p_provider: prov.provider, p_model: id.value.trim(), p_label: label.value.trim(), p_enabled: m.enabled !== false, p_sort: parseInt(sort.value, 10) || 100 });
            if (comp && (!existing || !!existing.text_only !== textOnly.checked)) r = await rpc('admin_set_ai_model_text_only', { p_provider: prov.provider, p_model: id.value.trim(), p_text_only: textOnly.checked });
            applyCatalog(r); toast('Model saved'); c();
          } catch (e) { err.textContent = CL.friendlyDbError(e.message); return true; }
        } }]);
    }

    // ------------------------------------------------------------------ Model Import: fetch ids from the provider, search, select, add (insert-only)
    function importModal(start) {
      const providers = compatProviders();
      if (!providers.length) { modal('Import models', h('p', {}, 'There is no OpenAI-compatible provider yet. Add one first (Add provider → OpenAI-Compatible), then import its models.'), [{ label: 'Close', run: (c) => c() }]); return; }
      const pick = sel('imp-provider', providers.map((p) => [p.provider, `${p.title} (${p.provider})`]), (start && providers.some((p) => p.provider === start.provider)) ? start.provider : providers[0].provider);
      let rows = [], query = '', fetched = false;
      const prov = () => list.find((p) => p.provider === pick.value);
      const stateIds = () => ({ ex: ((prov() || {}).models || []).map((m) => m.id), rm: (removed.models || []).filter((m) => m.provider === pick.value).map((m) => m.id) });
      const replan = () => { const { ex, rm } = stateIds(); rows = rows.map((r) => Object.assign(r, { state: ex.includes(r.id) ? 'exists' : rm.includes(r.id) ? 'removed' : 'new' })); };
      const panel = bridgePanel();
      const apiKey = h('input', { class: 'input', id: 'imp-key', type: 'password', autocomplete: 'new-password', spellcheck: 'false', placeholder: 'API key (used once to list models; not saved)', 'aria-label': 'API key' });
      const status = h('p', { class: 'hint', id: 'imp-status', 'aria-live': 'polite' });
      const search = h('input', { class: 'input', id: 'imp-search', placeholder: 'Search model IDs…', 'aria-label': 'Search models' });
      const listBox = h('div', { id: 'imp-list', class: 'compat-model-list', style: 'max-height:300px;overflow:auto;margin:6px 0' });
      const countEl = h('span', { class: 'hint', id: 'imp-count' });
      const startOrder = h('input', { class: 'input', id: 'imp-order', style: 'width:90px' });
      const turnOn = h('input', { type: 'checkbox', id: 'imp-enabled' }); turnOn.checked = true;
      const bulk = sel('imp-bulk', [['text', 'Text only'], ['vision', 'Can read images']], 'text');
      const customId = h('input', { class: 'input', id: 'imp-custom-id', placeholder: 'Model ID', 'aria-label': 'Custom model ID' }), customLabel = h('input', { class: 'input', id: 'imp-custom-label', placeholder: 'Name users see (optional)', 'aria-label': 'Custom model name' });
      const fetchBtn = h('button', { class: 'btn small primary', type: 'button', id: 'imp-fetch' }, 'Fetch Models');
      const addBtn = h('button', { class: 'btn small', type: 'button', id: 'imp-custom-add' }, 'Add to list');
      const resetOrder = () => { startOrder.value = String((((prov() || {}).models || []).length + 1) * 10); };

      const shown = () => CL.filterModels(rows, query);
      const selectedRows = () => rows.filter((r) => r.selected && r.state === 'new');
      function drawList() {
        replan();
        const all = shown(), vis = all.slice(0, 300);
        countEl.textContent = `${rows.length} listed · ${selectedRows().length} selected` + (all.length > vis.length ? ` · showing the first ${vis.length} of ${all.length} matches` : '');
        if (!rows.length) { listBox.replaceChildren(h('p', { class: 'hint' }, fetched ? 'The provider returned no models.' : 'Fetch the list, or add a model ID by hand below.')); return; }
        if (!vis.length) { listBox.replaceChildren(h('p', { class: 'hint' }, 'No model matches the search.')); return; }
        listBox.replaceChildren(h('table', { class: 'inner-table' }, h('thead', {}, h('tr', {}, ['', 'Model ID', 'Name users see', 'Images', ''].map((x) => h('th', {}, x)))), h('tbody', {}, vis.map((r) => {
          const isNew = r.state === 'new';
          const cb = h('input', { type: 'checkbox', 'aria-label': 'Select ' + r.id, disabled: !isNew, onchange: () => { r.selected = cb.checked; countEl.textContent = `${rows.length} listed · ${selectedRows().length} selected`; } }); cb.checked = !!r.selected && isNew;
          const lab = h('input', { class: 'input', value: r.label, disabled: !isNew, 'aria-label': 'Name for ' + r.id, oninput: (e) => { r.label = e.target.value; } });
          const vs = sel('', [['text', 'Text only'], ['vision', 'Can read images']], r.text_only ? 'text' : 'vision'); vs.disabled = !isNew; vs.setAttribute('aria-label', 'Image support for ' + r.id); vs.addEventListener('change', () => { r.text_only = vs.value === 'text'; });
          return h('tr', { 'data-model-id': r.id }, h('td', {}, cb), h('td', {}, h('code', {}, r.id), h('div', { class: 'hint' }, r.custom ? 'Added by hand · not verified' : CL.visionNote(r.hint))), h('td', {}, lab), h('td', {}, vs),
            h('td', {}, r.state === 'exists' ? h('span', { class: 'badge', title: 'Already in this provider’s catalogue; import leaves it unchanged' }, 'Already added') : r.state === 'removed' ? h('span', { class: 'badge suspended', title: 'Removed earlier: restore it from Removed Providers & Models' }, 'Removed earlier') : null));
        }))));
      }
      search.addEventListener('input', () => { query = search.value; drawList(); });
      pick.addEventListener('change', () => { rows = []; fetched = false; status.textContent = ''; resetOrder(); syncFetch(); drawList(); });
      function syncFetch() { const p = prov(); const none = p && p.compat && p.compat.models_path === ''; fetchBtn.disabled = !!none; if (none) status.textContent = 'This provider has no models endpoint configured, so its models cannot be listed. Add model IDs by hand below.'; }

      fetchBtn.addEventListener('click', async () => {
        const p = prov(); if (!p || !p.compat) { status.style.color = colorOf(false); status.textContent = 'This provider has no saved OpenAI-compatible settings.'; return; }
        if (!apiKey.value.trim()) { status.style.color = colorOf(false); status.textContent = 'Enter the API key first. It is used once and not saved.'; return; }
        panel.ensure(); fetchBtn.disabled = true; fetchBtn.textContent = 'Fetching…'; status.style.color = ''; status.textContent = 'Asking the provider for its models…';
        try {
          const r = await bridge.run('models', p.compat, apiKey.value.trim());
          if (!r.ok) { const ex = CL.explainFailure(r); status.style.color = colorOf(false); status.textContent = `✗ ${ex.category}: ${ex.advice}`; return; }
          const keepCustom = rows.filter((x) => x.custom && !r.models.some((m) => m.id === x.id));
          const { ex, rm } = stateIds();
          rows = CL.planImport(r.models, ex, rm).map((x) => Object.assign(x, { selected: false, label: x.id, text_only: CL.defaultTextOnly(x.hint) })).concat(keepCustom);
          fetched = true; status.style.color = colorOf(true); status.textContent = `✓ ${r.count} model${r.count === 1 ? '' : 's'} returned by the provider.`; drawList();
        } finally { fetchBtn.textContent = 'Fetch Models'; syncFetch(); fetchBtn.disabled = !!(prov() && prov().compat && prov().compat.models_path === ''); }
      });
      addBtn.addEventListener('click', () => {
        const idv = customId.value.trim();
        if (!CL.validModelId(idv)) { status.style.color = colorOf(false); status.textContent = 'A model ID has 1–120 characters and no spaces.'; return; }
        const { ex, rm } = stateIds();
        if (ex.includes(idv)) { status.style.color = '#e5a24c'; status.textContent = `${idv} already exists in ${pick.value}; it is left unchanged.`; return; }
        if (rm.includes(idv)) { status.style.color = '#e5a24c'; status.textContent = `${idv} was removed earlier: restore it from Removed Providers & Models instead.`; return; }
        if (rows.some((r) => r.id === idv)) { status.style.color = '#e5a24c'; status.textContent = `${idv} is already in the list below.`; return; }
        rows.unshift({ id: idv, owned_by: '', hint: null, state: 'new', custom: true, selected: true, label: (customLabel.value.trim() || idv).slice(0, 80), text_only: true });
        customId.value = ''; customLabel.value = ''; status.style.color = ''; status.textContent = `${idv} added to the list (selected).`; drawList();
      });
      const setSel = (fn) => { for (const r of shown()) if (r.state === 'new') fn(r); drawList(); };
      resetOrder(); syncFetch(); drawList();

      modal('Import models', h('div', { id: 'imp-body' },
        h('p', { class: 'hint' }, 'Fetch the model IDs a provider offers, tick the ones to add and press “Add selected models”. Models that already exist are never overwritten. Image support is never guessed from a model’s name: unless the provider itself reports it, a model is added as Text only; change it per model if you know better.'),
        h('div', { class: 'field' }, h('label', {}, 'Provider'), pick), panel.el,
        h('div', { class: 'field' }, h('label', {}, 'API key (not saved)'), h('div', { class: 'row' }, apiKey, fetchBtn)), status,
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;align-items:center' }, search, countEl),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:6px;align-items:center' },
          h('button', { class: 'btn small', type: 'button', id: 'imp-sel-all', onclick: () => setSel((r) => { r.selected = true; }) }, 'Select all shown'),
          h('button', { class: 'btn small', type: 'button', id: 'imp-sel-none', onclick: () => setSel((r) => { r.selected = false; }) }, 'Clear selection'),
          h('span', { class: 'hint' }, 'Set selected to'), bulk, h('button', { class: 'btn small', type: 'button', id: 'imp-bulk-apply', onclick: () => { selectedRows().forEach((r) => { r.text_only = bulk.value === 'text'; }); drawList(); } }, 'Apply')),
        listBox,
        h('div', { class: 'field' }, h('label', {}, 'Add a model ID by hand'), h('div', { class: 'row' }, customId, customLabel, addBtn)),
        h('div', { class: 'row', style: 'flex-wrap:wrap;gap:12px;align-items:center' }, h('label', { class: 'hint' }, 'First order number ', startOrder), h('label', { class: 'hint' }, turnOn, ' Turn imported models on'))), [
        { label: 'Close', run: (c) => c() },
        { label: 'Add selected models', cls: 'primary', run: async () => {
          const chosen = selectedRows();
          if (!chosen.length) { status.style.color = colorOf(false); status.textContent = 'Tick at least one new model first.'; return true; }
          const payload = CL.buildImportPayload(chosen.map((r) => Object.assign({}, r, { enabled: turnOn.checked })), startOrder.value);
          modal(`Add ${payload.length} model${payload.length === 1 ? '' : 's'} to ${pick.value}?`, h('div', {},
            h('p', {}, `${payload.length} new model${payload.length === 1 ? '' : 's'} will be added (${turnOn.checked ? 'turned on' : 'turned off'}; ${payload.filter((x) => x.text_only).length} as Text only). Existing models and their settings are not touched.`),
            h('p', { class: 'hint', id: 'imp-confirm-err', style: 'color:#e5686b' })), [
            { label: 'Back', run: (c) => c() },
            { label: 'Add models', cls: 'primary', run: async (c) => {
              try {
                const r = await rpc('admin_import_ai_models', { p_provider: pick.value, p_models: payload });
                applyCatalog(r); replan(); rows.forEach((x) => { if (x.state !== 'new') x.selected = false; });
                status.style.color = colorOf(true); status.textContent = '✓ ' + CL.importSummary(r); toast(CL.importSummary(r)); drawList(); c();
              } catch (e) { const b = document.getElementById('imp-confirm-err'); if (b) b.textContent = CL.friendlyDbError(e.message); return true; }
            } }]);
          return true;
        } }]);
    }

    function uploadModal(prov) {
      const pkgIn = h('input', { type: 'file', id: 'aipk-file', accept: '.mzprovider,.zip' }), repIn = h('input', { type: 'file', id: 'aipk-report', accept: '.json' });
      const note = h('div', { id: 'aipk-checks' }), title = h('input', { id: 'aipk-title', class: 'input', placeholder: 'Display title, e.g. Gemini adapter' });
      let state = { buf: null, sha: '', report: null, problems: ['Choose the package and its report.'] };
      const show = () => { note.replaceChildren(...state.problems.map((x) => h('p', { class: 'hint', style: 'color:#e5686b' }, '✗ ' + x)), state.problems.length ? null : h('p', { class: 'hint', style: 'color:#4caf7d' }, '✓ The package and its report belong together and both passed.')); };
      const recompute = async () => {
        const pf = pkgIn.files[0], rf = repIn.files[0];
        state = { buf: null, sha: '', report: null, problems: [] };
        if (pf) { state.buf = await pf.arrayBuffer(); state.sha = await PL.sha256Hex(state.buf); }
        if (rf) { const pr = PL.parseReport(await rf.text()); if (pr.ok) state.report = pr.report; else state.problems.push(...pr.errors); }
        if (!state.problems.length) state.problems = PL.checkUpload({ provider: prov.provider, size: pf ? pf.size : 0, sha: state.sha, report: state.report });
        if (state.report && !title.value) title.value = state.report.title || '';
        show();
      };
      pkgIn.addEventListener('change', recompute); repIn.addEventListener('change', recompute); show();
      modal(`Upload package for ${prov.provider}`, h('div', {},
        h('p', { class: 'hint' }, 'Build and check the package on your computer first:  python3 scripts/provider_pkg.py pack <folder> out.mzprovider  then  … check out.mzprovider --sign (the signing key comes from your secret store, never from a file). That writes out.mzprovider.report.json with the publisher signature; the app refuses a package that is not signed by a trusted key. The report is an attestation from that tool; every user’s app validates the package again before installing it.'),
        h('div', { class: 'field' }, h('label', {}, 'Package (.mzprovider)'), pkgIn), h('div', { class: 'field' }, h('label', {}, 'Report (.json)'), repIn),
        h('div', { class: 'field' }, h('label', {}, 'Display title'), title), note), [
        { label: 'Cancel', run: (c) => c() },
        { label: 'Upload', cls: 'primary', run: async (c) => {
          if (state.problems.length || !state.buf) { toast(state.problems[0] || 'Choose the files first.', true); return true; }
          const path = PL.storagePath(prov.provider, state.sha);
          const up = await bucket().upload(path, state.buf, { contentType: 'application/zip', upsert: true });
          if (up.error) { toast('Upload failed: ' + up.error.message, true); return true; }
          try {
            await reload(() => rpc('admin_register_ai_package', { p_provider: prov.provider, p_title: title.value.trim() || state.report.title, p_storage_path: path, p_sha256: state.sha, p_size: state.buf.byteLength, p_validation: state.report.validation, p_signature: state.report.signature }), 'Package registered');
            const row = list.find((x) => x.provider === prov.provider);
            const k = row && (row.packages || []).find((x) => x.sha256 === state.sha);
            if (k) await reload(() => rpc('admin_record_ai_package_test', { p_id: k.id, p_report: state.report.test }), 'Test report recorded - you can publish it now');
            c();
          } catch (e) { return true; }
        } }]);
    }

    function packageRows(prov) {
      return (prov.packages || []).map((k) => h('tr', { 'data-package': k.id },
        h('td', {}, h('b', {}, k.title), ' ', k.version ? h('span', { class: 'badge' }, 'v' + k.version) : h('span', { class: 'hint' }, 'no version'), ' ', h('code', {}, k.sha256.slice(0, 12)), ' ', h('span', { class: 'hint' }, PL.fmtSize(k.size) + (k.signed ? ' · signed by ' + (k.signer || '?') : ' · NOT signed'))), h('td', {}, PL.statusLabel(k.status)), h('td', {}, fmtShort(k.created_at)),
        h('td', { class: 'actions' },
          PL.canPublish(k) ? h('button', { class: 'btn small primary', 'data-act': 'publish', onclick: () => confirmBox(`Publish ${k.title}?`, 'Users are offered this package the next time they check; nobody’s installed copy changes until they press Update. The previous published package is replaced.', 'Publish', async () => { await reload(() => rpc('admin_publish_ai_package', { p_id: k.id }), 'Published'); }) }, 'Publish') : null,
          PL.canRetire(k) ? h('button', { class: 'btn small', 'data-act': 'retire', onclick: () => reload(() => rpc('admin_retire_ai_package', { p_id: k.id }), 'Retired') }, 'Retire') : null,
          PL.canDeletePackage(k) ? h('button', { class: 'btn small danger', 'data-act': 'delpkg', onclick: () => confirmBox('Delete this package?', 'The file is removed from storage. Users who already installed it keep their copy.', 'Delete', async () => {
            const r = await act(() => rpc('admin_delete_ai_package', { p_id: k.id }), 'Deleted'); if (r && r.storage_path) { try { await bucket().remove([r.storage_path]); } catch (e) { /* the row is gone; an orphaned file is harmless */ } } list = r.catalog || list; draw(); }) }, 'Delete') : null)));
    }

    // ---- Removed Providers & Models: two views (providers / models), search, and Restore behind a confirmation. Restoring changes no setting: the row is
    // un-archived in place (same key, same On/Off, same order, same packages) and an existing active item is never overwritten.
    function restoreProviderDialog(p) {
      const plan = PL.restoreProviderPlan(p);
      modal(`Restore ${p.provider}?`, h('div', { id: 'ai-restore-confirm' },
        h('p', {}, `${p.title} (${p.provider}) returns to the provider list with its previous settings (${PL.originalStatus(p)}), order and packages.`),
        h('p', {}, plan.back.length ? `${plan.back.length} model(s) removed together with it come back: ${plan.back.join(', ')}.` : 'It has no models that were removed together with it.'),
        plan.stay.length ? h('p', { class: 'hint' }, `${plan.stay.length} model(s) that were removed on their own stay in Removed Models: ${plan.stay.join(', ')}.`) : null,
        h('p', { class: 'hint' }, 'Nothing active is overwritten. Safe to repeat.')), [
        { label: 'Cancel', run: (c) => c() },
        { label: 'Restore', cls: 'primary', run: async (c) => {
          try { const r = await act(() => rpc('admin_restore_ai_provider', { p_key: p.provider }), null); list = r.catalog || list; if (r.removed) removed = r.removed; toast(r.already_active ? `${p.provider} was already active - nothing changed` : `${p.provider} restored`); c(); draw(); } catch (e) { return true; }
        } }]);
    }
    function restoreModelDialog(m) {
      modal(`Restore model ${m.id}?`, h('div', { id: 'ai-restore-confirm' },
        h('p', {}, `${m.label} (${m.id}) returns to ${m.provider_title} with its previous settings (${PL.originalStatus(m)}).`),
        h('p', {}, `The provider ${m.provider} is not changed.`), h('p', { class: 'hint' }, 'Nothing active is overwritten. Safe to repeat.')), [
        { label: 'Cancel', run: (c) => c() },
        { label: 'Restore', cls: 'primary', run: async (c) => {
          try { const r = await act(() => rpc('admin_restore_ai_model', { p_provider: m.provider, p_model: m.id }), null); list = r.catalog || list; if (r.removed) removed = r.removed; toast(r.already_active ? `${m.id} was already active - nothing changed` : `${m.id} restored`); c(); draw(); } catch (e) { return true; }
        } }]);
    }
    function removedPanel() {
      const body = h('div', { id: 'ai-removed-body' });
      const tabBtn = (key, label, n) => h('button', { class: 'btn small' + (rmTab === key ? ' primary' : ''), id: 'ai-rm-tab-' + key, 'data-rm-tab': key, onclick: () => { rmTab = key; drawBody(); syncTabs(); } }, `${label} (${n})`);
      const tabs = h('div', { class: 'row', style: 'gap:6px' });
      const syncTabs = () => tabs.replaceChildren(tabBtn('providers', 'Removed Providers', (removed.providers || []).length), tabBtn('models', 'Removed Models', (removed.models || []).length));
      const search = h('input', { id: 'ai-rm-search', class: 'input', placeholder: 'Search name, key or model ID', value: rmQuery, style: 'max-width:260px', oninput: (e) => { rmQuery = e.target.value; drawBody(); } });
      const empty = (t) => h('p', { class: 'hint', id: 'ai-rm-empty' }, t);
      function drawBody() {
        if (!archiveReady) return body.replaceChildren(h('p', { class: 'warn', id: 'ai-rm-needs-0026' }, 'The server does not have migration 0026 yet, so removed items cannot be listed. Remove buttons are switched off until it is applied.'));
        if (rmTab === 'providers') {
          const rows = PL.filterRemoved(removed.providers, rmQuery);
          body.replaceChildren(rows.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'ai-removed-providers' }, h('thead', {}, h('tr', {}, ['Provider', 'Key', 'Models kept', 'Original status', 'Removed', ''].map((x) => h('th', {}, x)))),
            h('tbody', {}, rows.map((p) => h('tr', { 'data-removed-provider': p.provider },
              h('td', {}, h('b', {}, p.title), p.hidden ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'Hidden') : null), h('td', {}, h('code', {}, p.provider)),
              h('td', { title: (p.models || []).map((m) => m.id).join(', ') }, String((p.models || []).length)),
              h('td', {}, h('span', { class: 'badge' + (p.enabled ? ' ok' : '') }, PL.originalStatus(p))), h('td', {}, fmtShort(p.archived_at)),
              h('td', { class: 'actions' }, h('button', { class: 'btn small primary', 'data-act': 'restore-provider', onclick: () => restoreProviderDialog(p) }, 'Restore'))))))) : empty((removed.providers || []).length ? 'No removed provider matches the search.' : 'No removed providers.'));
        } else {
          const rows = PL.filterRemoved(removed.models, rmQuery);
          body.replaceChildren(rows.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'ai-removed-models' }, h('thead', {}, h('tr', {}, ['Model', 'Model ID', 'Provider', 'Original status', 'Removed', ''].map((x) => h('th', {}, x)))),
            h('tbody', {}, rows.map((m) => { const why = PL.restoreModelBlocked(m); return h('tr', { 'data-removed-model': m.id, 'data-provider': m.provider },
              h('td', {}, h('b', {}, m.label)), h('td', {}, h('code', {}, m.id)),
              h('td', {}, m.provider_title, ' ', h('code', {}, m.provider), m.provider_archived ? h('span', { class: 'badge suspended', style: 'margin-left:6px' }, 'Provider removed') : null),
              h('td', {}, h('span', { class: 'badge' + (m.enabled ? ' ok' : '') }, PL.originalStatus(m))), h('td', {}, fmtShort(m.archived_at)),
              h('td', { class: 'actions' }, h('button', { class: 'btn small primary', 'data-act': 'restore-model', disabled: !!why, title: why || 'Restore only this model', onclick: () => restoreModelDialog(m) }, 'Restore'))); })))) : empty((removed.models || []).length ? 'No removed model matches the search.' : 'No removed models.'));
        }
      }
      syncTabs(); drawBody();
      return h('div', { id: 'ai-removed' }, h('div', { class: 'toolbar' }, h('h3', {}, 'Removed Providers & Models'), search),
        h('p', { class: 'hint' }, 'Removing a provider or model never deletes it: it is kept here with its settings, models and packages, and can be restored at any time. Models that were removed together with a provider come back with it; models removed on their own are restored one by one.'),
        tabs, body);
    }

    function draw() {
      const trs = [];
      for (const p of list) {
        const sw = (on, fn, label) => h('button', { class: 'btn small' + (on ? '' : ' danger'), onclick: fn }, on ? 'On' : 'Off');
        trs.push(h('tr', { class: 'prov', 'data-provider': p.provider },
          h('td', {}, h('b', {}, p.title), ' ', h('code', {}, p.provider), p.hidden ? h('span', { class: 'badge', style: 'margin-left:6px' }, 'Hidden') : null, ' ', h('span', { class: 'badge' + (CL.isCompat(p) ? ' ok' : ''), 'data-adapter': p.adapter, style: 'margin-left:6px' }, CL.adapterLabel(p.adapter))),
          h('td', {}, 'Provider'),
          h('td', {}, sw(p.enabled, () => {
            const go = () => reload(() => rpc('admin_set_ai_provider_enabled', { p_key: p.provider, p_enabled: !p.enabled }), `${p.provider} turned ${p.enabled ? 'off' : 'on'}`);
            if (p.enabled) confirmBox(`Turn off ${p.provider}?`, 'It disappears from Meta Generator for every user and is skipped during generation. Their keys and installed packages are not touched.', 'Turn off', go); else go();
          })),
          h('td', { class: 'actions' }, h('button', { class: 'btn small', 'data-act': 'edit', onclick: () => providerModal(p) }, 'Edit'), h('button', { class: 'btn small', 'data-act': 'addmodel', onclick: () => modelModal(p) }, '+ Model'),
            CL.isCompat(p) ? h('button', { class: 'btn small primary', 'data-act': 'import-models', title: 'Fetch this provider’s model list and add models to the catalogue', onclick: () => importModal(p) }, 'Import models')
              : p.adapter === 'package' ? h('button', { class: 'btn small', 'data-act': 'upload', onclick: () => uploadModal(p) }, 'Upload package') : null,
            (() => { const why = PL.forceProviderBlocked(p); return h('button', { class: 'btn small danger', 'data-act': 'force-provider', disabled: !!why, title: why || 'Push the published package to every device now', onclick: () => forceModal('provider', p) }, 'Force Update'); })(),
            h('button', { class: 'btn small danger', 'data-act': 'delete', disabled: !archiveReady, title: archiveReady ? 'Move to Removed Providers & Models (restorable at any time)' : 'Needs migration 0026 (Removed Providers & Models)',
              onclick: () => confirmBox(`Remove ${p.provider}?`, 'It is moved to Removed Providers & Models, with all its models, settings and packages kept. Users no longer see it. Nothing is deleted: you can restore it at any time. Saved keys stay on users’ computers.', 'Remove', async () => {
                const r = await act(() => rpc('admin_archive_ai_provider', { p_key: p.provider }), 'Provider moved to Removed Providers & Models'); list = r.catalog || list; if (r.removed) removed = r.removed; draw(); }) }, 'Remove'))));
        for (const m of p.models || []) trs.push(h('tr', { 'data-provider': p.provider, 'data-model': m.id },
          h('td', { style: 'padding-left:28px' }, m.label, ' ', h('code', {}, m.id), CL.isCompat(p) && m.text_only ? h('span', { class: 'badge', style: 'margin-left:6px', title: 'Never sent images' }, 'Text only') : null), h('td', {}, 'Model'),
          h('td', {}, p.enabled ? h('button', { class: 'btn small' + (m.enabled ? '' : ' danger'), onclick: () => reload(() => rpc('admin_set_ai_model_enabled', { p_provider: p.provider, p_model: m.id, p_enabled: !m.enabled }), `${m.id} turned ${m.enabled ? 'off' : 'on'}`) }, m.enabled ? 'On' : 'Off') : h('span', { class: 'hint' }, 'Provider off')),
          h('td', { class: 'actions' }, h('button', { class: 'btn small', 'data-act': 'editmodel', onclick: () => modelModal(p, m) }, 'Edit'), h('button', { class: 'btn small danger', 'data-act': 'force-model', title: 'Push this model definition to every device now', onclick: () => forceModal('model', p, m) }, 'Force Update'),
            h('button', { class: 'btn small danger', 'data-act': 'delmodel', disabled: !archiveReady, title: archiveReady ? 'Move to Removed Providers & Models (restorable at any time)' : 'Needs migration 0026 (Removed Providers & Models)',
              onclick: () => confirmBox(`Remove model ${m.id}?`, `Users can no longer choose it. It is moved to Removed Providers & Models, with its settings kept, and ${p.provider} stays as it is. You can restore it at any time.`, 'Remove', () => reload(() => rpc('admin_archive_ai_model', { p_provider: p.provider, p_model: m.id }), 'Model moved to Removed Providers & Models')) }, 'Remove'))));
        if ((p.packages || []).length) trs.push(h('tr', { 'data-provider': p.provider, class: 'pkgs' }, h('td', { colspan: 4, style: 'padding-left:28px' },
          h('table', { class: 'inner-table' }, h('thead', {}, h('tr', {}, ['Package', 'State', 'Added', ''].map((x) => h('th', {}, x)))), h('tbody', {}, packageRows(p))))));
      }
      main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'API Configuration — Meta Generator'), h('button', { class: 'btn', id: 'ai-restore-defaults', onclick: restoreDefaults, title: 'Add back missing original default providers and models; existing ones are not changed' }, 'Restore Default Providers'), h('button', { class: 'btn', id: 'ai-import-models', onclick: () => importModal(null), title: 'Fetch model IDs from an OpenAI-compatible provider and add them' }, 'Import models'), h('button', { class: 'btn primary', id: 'ai-add-provider', onclick: () => providerModal(null) }, '+ Add provider')),
        h('p', { class: 'hint' }, 'This is the catalogue the app uses: the providers, their models, and which of them are on. The app reads it when it starts and on every heartbeat; a switched-off provider or model is hidden and skipped during generation. Each provider is Built-in (part of the app), OpenAI-Compatible (the app’s generic runtime; no package, only settings stored here) or a Downloaded Package (users download it from Settings → API Manager → Providers). Adobe Tracker’s Apify keys are not part of this page.'),
        h('div', { class: 'tablewrap' }, h('table', { id: 'ai-rows' }, h('thead', {}, h('tr', {}, ['Provider / model', 'Level', 'Available', ''].map((x) => h('th', {}, x)))), h('tbody', {}, trs))),
        removedPanel(), jobsPanel());
    }
    draw();
  }

  // ------------------------------------------------------------ app version
  // ---------------------------------------------------------------- API Provider Announcements (v1.0.0 Part 8A, migration 0029)
  // Admin-managed notices about an AI API provider, shown to users in Settings -> API -> Options -> Provider. Linked to the provider's STABLE key
  // (never its display name). Created as a draft; only the Publish button makes it visible. Every action is a database function that checks the
  // admin list itself. All text is rendered with textContent; the optional thumbnail is re-encoded here to a small data: image (no remote URL).
  const ANN_IMG_RE = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
  function annThumb(file) {
    return new Promise((resolve, reject) => {
      if (!file || !/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('Choose a PNG, JPEG or WebP image.'));
      if (file.size > 5 * 1024 * 1024) return reject(new Error('That image file is too large (max 5 MB).'));
      const fr = new FileReader();
      fr.onerror = () => reject(new Error('Could not read the image.'));
      fr.onload = () => {
        const img = new Image();
        img.onerror = () => reject(new Error('That file is not a readable image.'));
        img.onload = () => {
          const k = Math.min(1, 128 / Math.max(img.width, img.height, 1));
          const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.width * k)); c.height = Math.max(1, Math.round(img.height * k));
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          let out = c.toDataURL('image/webp', 0.82);
          if (!/^data:image\/webp/.test(out)) out = c.toDataURL('image/jpeg', 0.82);
          if (!ANN_IMG_RE.test(out) || out.length > 60000) return reject(new Error('The thumbnail is still too big after shrinking. Try a simpler image.'));
          resolve(out);
        };
        img.src = String(fr.result);
      };
      fr.readAsDataURL(file);
    });
  }
  async function pageApiAnn(main) {
    let data;
    try { data = await rpc('admin_list_api_provider_announcements'); }
    catch (e) { main.replaceChildren(h('div', { class: 'toolbar' }, h('h2', {}, 'API Provider Announcements')), h('p', { class: 'warn', id: 'apiann-needs-0029' }, 'Not available on this server yet (apply migration 0029_api_provider_announcements.sql). ' + e.message)); return; }
    let query = '', filter = 'all';
    const providers = data.providers || [];
    function modalFor(u) {
      let image = u && u.image_data && ANN_IMG_RE.test(u.image_data) ? u.image_data : null;
      const sel = h('select', { id: 'apiann-provider' });
      const opts = providers.slice();
      if (u && !opts.some((p) => p.provider === u.provider_key)) opts.unshift({ provider: u.provider_key, title: u.provider_title + ' (removed)' });
      for (const p of opts) sel.append(h('option', { value: p.provider }, `${p.title} (${p.provider})`));
      if (u) sel.value = u.provider_key;
      const title = h('input', { type: 'text', id: 'apiann-title', maxlength: '80', placeholder: 'New model available', value: u ? u.title : '' });
      const desc = h('textarea', { id: 'apiann-desc', maxlength: '400', placeholder: 'One or two sentences users will read. Plain text only.' }, u ? u.description : '');
      const preview = h('div', { class: 'ann-preview', id: 'apiann-preview' });
      const drawPreview = () => preview.replaceChildren(image ? h('img', { class: 'ann-thumb', src: image, alt: '' }) : h('span', { class: 'hint' }, 'No image'));
      drawPreview();
      const file = h('input', { type: 'file', id: 'apiann-image', accept: 'image/png,image/jpeg,image/webp' });
      file.addEventListener('change', async () => {
        const f = file.files && file.files[0]; if (!f) return;
        try { image = await annThumb(f); drawPreview(); } catch (e) { toast(e.message, true); file.value = ''; }
      });
      modal(u ? 'Edit announcement' : 'New announcement', h('div', {},
        h('div', { class: 'field' }, h('label', {}, 'Provider'), sel),
        h('div', { class: 'field' }, h('label', {}, 'Title (max 80 characters)'), title),
        h('div', { class: 'field' }, h('label', {}, 'Short description (max 400 characters)'), desc),
        h('div', { class: 'field' }, h('label', {}, 'Thumbnail (optional; PNG, JPEG or WebP, shrunk to 128 px and stored inside the announcement)'), file,
          h('div', { class: 'row', style: 'margin-top:6px' }, preview, h('button', { class: 'btn small', type: 'button', id: 'apiann-image-clear', onclick: () => { image = null; file.value = ''; drawPreview(); } }, 'Remove image'))),
        h('p', { class: 'hint' }, 'Saving never publishes. A new announcement is a draft until you press Publish.')),
      [{ label: 'Cancel', run: (c) => c() }, { label: 'Save', cls: 'primary', run: async (c) => {
        if (!sel.value) { toast('Choose the provider', true); return true; }
        if (!title.value.trim()) { toast('Write the title first', true); return true; }
        await act(() => rpc('admin_upsert_api_provider_announcement', { p_id: u ? u.id : null, p_provider_key: sel.value, p_title: title.value.trim(), p_description: desc.value.trim(),
          p_image_data: image, p_expected_updated_at: u ? u.updated_at : null }), 'Announcement saved');
        c(); go('apiann'); } }]);
    }
    const list = h('div', { id: 'apiann-list' });
    function draw() {
      const q = query.trim().toLowerCase();
      const rows = (data.announcements || []).filter((a) => (filter === 'all' || a.status === (filter === 'published' ? 'published' : 'draft'))
        && (!q || `${a.title} ${a.description} ${a.provider_key} ${a.provider_title}`.toLowerCase().includes(q)));
      if (!rows.length) { list.replaceChildren(h('p', { class: 'hint', id: 'apiann-empty' }, (data.announcements || []).length ? 'No announcement matches.' : 'No announcements yet.')); return; }
      list.replaceChildren(h('div', { class: 'tablewrap' }, h('table', { id: 'apiann-table' }, h('thead', {}, h('tr', {}, ['', 'Announcement', 'Provider', 'State', 'Users read / dismissed', 'Updated', 'Actions'].map((x) => h('th', {}, x)))),
        h('tbody', {}, rows.map((a) => h('tr', { 'data-apiann': a.id, 'data-status': a.status },
          h('td', {}, a.image_data && ANN_IMG_RE.test(a.image_data) ? h('img', { class: 'ann-thumb', src: a.image_data, alt: '' }) : null),
          h('td', {}, h('b', {}, a.title), a.description ? h('div', { class: 'hint', style: 'margin:2px 0 0' }, a.description) : null),
          h('td', {}, a.provider_title, ' ', h('code', {}, a.provider_key), a.provider_archived ? h('span', { class: 'badge suspended', style: 'margin-left:6px' }, 'Provider removed') : null),
          h('td', {}, h('span', { class: 'badge' + (a.status === 'published' ? ' ok' : '') }, a.status === 'published' ? 'Published' : 'Unpublished')),
          h('td', {}, `${num(a.read_count)} / ${num(a.dismissed_count)}`), h('td', {}, fmtShort(a.updated_at)),
          h('td', { class: 'actions' },
            h('button', { class: 'btn small', 'data-act': 'edit', type: 'button', onclick: () => modalFor(a) }, 'Edit'),
            a.status === 'draft' ? h('button', { class: 'btn small primary', 'data-act': 'publish', type: 'button', disabled: a.provider_archived, title: a.provider_archived ? 'Restore the provider first' : 'Users will see it', onclick: async () => { await act(() => rpc('admin_set_api_provider_announcement_status', { p_id: a.id, p_status: 'published', p_expected_updated_at: a.updated_at }), 'Published: users can now see it'); go('apiann'); } }, 'Publish') : null,
            a.status === 'published' ? h('button', { class: 'btn small', 'data-act': 'unpublish', type: 'button', onclick: async () => { await act(() => rpc('admin_set_api_provider_announcement_status', { p_id: a.id, p_status: 'draft', p_expected_updated_at: a.updated_at }), 'Hidden from users'); go('apiann'); } }, 'Unpublish') : null,
            h('button', { class: 'btn small danger', 'data-act': 'delete', type: 'button', onclick: () => confirmBox('Delete announcement', 'Only this announcement (and users’ read marks for it) is deleted. Providers, models and keys are not touched.', 'Delete',
              async () => { await act(() => rpc('admin_delete_api_provider_announcement', { p_id: a.id }), 'Announcement deleted'); go('apiann'); }) }, 'Delete'))))))));
    }
    const search = h('input', { id: 'apiann-search', class: 'input', placeholder: 'Search title, text or provider', style: 'max-width:260px', oninput: (e) => { query = e.target.value; draw(); } });
    const chips = h('div', { class: 'row', style: 'gap:6px' });
    const drawChips = () => chips.replaceChildren(...[['all', 'All'], ['published', 'Published'], ['draft', 'Unpublished']].map(([k, l]) =>
      h('button', { class: 'chip' + (filter === k ? ' on' : ''), type: 'button', 'data-filter': k, onclick: () => { filter = k; drawChips(); draw(); } }, l)));
    drawChips(); draw();
    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('h2', {}, 'API Provider Announcements'), search, h('button', { class: 'btn small', id: 'btn-apiann-refresh', onclick: () => go('apiann') }, 'Refresh'),
        h('button', { class: 'btn primary small', id: 'btn-apiann-new', type: 'button', onclick: () => modalFor(null) }, 'New announcement')),
      h('p', { class: 'hint' }, 'Notices about an AI API provider. Users see published ones on that provider’s card in Settings → API → Options → Provider, with a NEW marker until they read or dismiss it. A provider that is removed in API Configuration hides its announcements automatically.'),
      chips, list);
  }

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

  // Phone layout: below 760px tables become cards (admin.css). Each cell needs its column title as data-label for that.
  function labelTables() {
    document.querySelectorAll('table').forEach((t) => {
      if (t.id === 'users-table') return;                    // the Users table has its own stacked layout
      const heads = [...t.querySelectorAll('th')].slice(0, 12).map((x) => x.textContent.trim());
      if (!heads.length) return;
      t.querySelectorAll('tr').forEach((tr) => [...tr.children].forEach((c, i) => { if (c.tagName === 'TD' && !c.dataset.label && heads[i]) c.dataset.label = heads[i]; }));
    });
  }
  new MutationObserver(labelTables).observe(document.body, { childList: true, subtree: true });

  // --------------------------------------------------------------- start
  sb.auth.onAuthStateChange((event) => { if (event === 'SIGNED_OUT') screenSignIn(); });
  boot();
})();