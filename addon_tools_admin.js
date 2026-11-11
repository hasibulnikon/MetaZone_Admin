/* MetaZone Admin -- Addon Tools Manager (Part 5). Separate from the old "Add-ons" tab (addon_logic.js / admin_*_addon RPCs): this file only talks to
   the Part 2A RPCs (admin_addon_tools_*) and to the Part 2D `addon-tools-publish` Edge Function with the admin's OWN session token.
   There is no signing, no package parsing and no hashing-for-trust here; no service-role key exists in this site. All dynamic text is rendered
   with textContent (through h()). admin.js hands in its helpers (ctx) so the look and behaviour match the rest of the panel. */
(() => {
  'use strict';
  const L = window.MZ_ADDON_TOOLS;

  function mount(main, ctx) {
    const { h, rpc, toast, modal, fmt, fmtShort } = ctx;
    let tools = []; let loadError = null;
    let sel = null;                          // selected tool id
    let view = 'tools';                      // 'tools' | 'audit'
    let dtab = 'overview';                   // 'overview' | 'releases' | 'access' | 'audit'
    let busy = false;
    let keyInfoState = null;                 // last "signing key" check
    const root = h('div', { id: 'at-root', class: 'at-root' });
    main.replaceChildren(root);

    // ---------------------------------------------------------------- small pieces
    const badge = (text, cls) => h('span', { class: 'badge ' + (cls || '') }, text);
    const btn = (label, onclick, cls, extra) => h('button', { type: 'button', class: 'btn at-act ' + (cls || ''), onclick, ...(extra || {}) }, label);
    const note = (text, cls) => h('p', { class: 'at-note ' + (cls || '') }, text);
    const spin = (text) => h('div', { class: 'skel' }, h('span', { class: 'spin' }), text);
    const kv = (k, v) => h('div', { class: 'at-kv' }, h('span', {}, k), h('b', {}, v == null || v === '' ? '—' : v));
    // Part 9: display-only helpers. Metadata comes from the server (signed manifest -> 0033 columns -> admin_addon_tools_list); nothing here sends it anywhere.
    const tagBadges = (tags) => (tags && tags.length ? h('span', { class: 'at-tags' }, tags.map((x) => badge(x))) : null);
    const planBadges = (t) => h('span', { class: 'at-plans' }, L.planStates(t).map((p) => badge(p.text, p.cls)));
    const metaKvs = (m) => [kv('Category', m.category), kv('Tags', tagBadges(m.tags)), kv('Icon file', m.icon)];
    const FROM_SIGNED = 'Read from the signed package of this release; it cannot be edited here. To change it, upload a new release.';
    const tool = () => tools.find((t) => t.tool_id === sel) || null;
    const setBusy = (b) => { busy = b; root.classList.toggle('at-busy', b); };

    async function edgeDeps() {
      const { data } = await ctx.sb.auth.getSession();
      const token = data && data.session && data.session.access_token;
      if (!token) throw new Error('Your session expired. Reload the page and sign in again.');
      return { fetch: window.fetch.bind(window), url: L.edgeUrl(ctx.cfg.supabaseUrl), token, anonKey: ctx.cfg.publishableKey };
    }

    // ---------------------------------------------------------------- data
    async function reload() {
      try { tools = L.parseTools(await rpc('admin_addon_tools_list')); loadError = null; }
      catch (e) { loadError = L.describeRpcError(e.message); }
      if (sel && !tool()) sel = null;
      draw();
    }
    // One write at a time. Always re-reads the list afterwards (the server is the source of truth) and says what happened.
    async function mutate(fn, okMsg) {
      if (busy) return { ok: false, kind: 'busy', text: 'Another change is still running.' };
      setBusy(true);
      try { const res = await fn(); setBusy(false); await reload(); if (okMsg) toast(okMsg); return { ok: true, res }; }
      catch (e) {
        setBusy(false); const d = L.describeRpcError(e.message);
        toast(d.text, true); if (d.kind === 'stale') await reload();
        return { ok: false, kind: d.kind, text: d.text };
      }
    }

    // ---------------------------------------------------------------- shell
    function draw() {
      const kids = [];
      kids.push(h('div', { class: 'toolbar' }, h('h2', {}, 'Addon Tools'),
        h('span', { class: 'seg', role: 'group', 'aria-label': 'View' }, [['tools', 'Tools'], ['developer', 'Developer Options'], ['audit', 'Audit log']].map(([v, l]) => h('button', { type: 'button', class: v === view ? 'on' : '', 'data-view': v, onclick: () => { view = v; if (v === 'tools') sel = null; if (v === 'developer') devLoad(); draw(); } }, l, v === 'developer' && dev.summary && dev.summary.count ? h('span', { class: 'badge premium at-count', title: 'Pending access requests' }, String(dev.summary.count)) : null))),
        btn('Signing key', checkKey, 'small', { id: 'at-key' }), btn('Refresh', async () => { await reload(); toast('Reloaded.'); }, 'small', { id: 'at-refresh' }),
        btn('New tool', () => toolDialog(null), '', { id: 'at-new' }), btn('Upload release', () => publishDialog(sel), 'primary', { id: 'at-upload' })));
      kids.push(note('New Addon Tools system (ZIP + signed release, runs in its own window). Separate from the Add-ons tab, which manages the old .mzaddon add-ons.', 'hint'));
      if (keyInfoState) kids.push(keyPanel());
      const ntc = view !== 'developer' ? L.developerRequestNotice(dev.summary) : null;           // Part 13: new-request notice (names the user, opens the request)
      if (ntc) kids.push(h('div', { class: 'panel at-banner', id: 'at-req-notice', role: 'status' }, h('div', { class: 'p-head' }, h('b', {}, ntc.text), btn('Review request', () => devOpenRequest(ntc.firstId), 'small primary', { 'data-act': 'req-open' }))));
      if (view === 'developer') kids.push(developerPanel());
      else if (loadError) kids.push(h('div', { class: 'panel' }, h('h3', {}, loadError.kind === 'missing' ? 'Not installed on this server' : 'Could not load'),
        h('p', { class: 'warn' }, loadError.text), loadError.kind === 'missing' ? note('Apply migration 0032_addon_tools.sql to this Supabase project (test project first), then reload.') : null,
        btn('Try again', reload)));
      else if (view === 'audit') kids.push(auditPanel(null));
      else if (sel && tool()) kids.push(detail(tool()));
      else kids.push(toolList());
      root.replaceChildren(...kids);
    }

    // ---------------------------------------------------------------- signing key (public facts only)
    async function checkKey() {
      keyInfoState = { loading: true }; draw();
      try { keyInfoState = L.describeKeyInfo(await L.edgeJson(await edgeDeps(), { action: 'key_info' })); }
      catch (e) { keyInfoState = { ok: false, title: e.message, problems: [], warnings: [] }; }
      draw();
    }
    function keyPanel() {
      const k = keyInfoState;
      const close = btn('Hide', () => { keyInfoState = null; draw(); }, 'small ghost');
      if (k.loading) return h('div', { class: 'panel', id: 'at-key-panel' }, spin('Checking the signing key…'));
      if (!k.ok) return h('div', { class: 'panel', id: 'at-key-panel' }, h('div', { class: 'p-head' }, h('h3', {}, 'Signing key'), close), h('p', { class: 'warn' }, k.title), k.detail ? note(k.detail) : null);
      return h('div', { class: 'panel', id: 'at-key-panel' }, h('div', { class: 'p-head' }, h('h3', {}, 'Signing key'), close),
        h('div', { class: 'at-kvs' }, kv('Key id', k.key_id), kv('Algorithm', k.alg), kv('Fingerprint', k.fingerprint)),
        note('Public facts only. Compare the key id / public key with addon_tools_rt/keys.py: if they differ, installs on user PCs will fail verification.'));
    }

    // ---------------------------------------------------------------- tool list
    function accessExtra(t) {
      const ua = t.user_access || []; const allow = ua.filter((u) => u.allowed === true).length; const deny = ua.filter((u) => u.allowed === false).length; const x = [];
      if (allow) x.push(allow + ' user' + (allow === 1 ? '' : 's') + ' allowed'); if (deny) x.push(deny + ' denied');
      return x.join(', ');
    }
    function toolList() {
      if (!tools.length) return h('div', { class: 'panel' }, h('h3', {}, 'No tools yet'), note('Create a tool, upload its first release, make that release current, then publish it and choose who may use it.'), btn('New tool', () => toolDialog(null), 'primary'));
      const rows = tools.map((t) => {
        const st = L.toolStatus(t); const pub = L.publicationState(t); const cur = L.currentRelease(t);
        return h('tr', { class: 'at-row', 'data-tool': t.tool_id },
          h('td', {}, h('b', {}, t.name), h('div', { class: 'hint' }, t.tool_id)),
          h('td', { 'data-col': 'author' }, t.author ? t.author : h('span', { class: 'hint' }, '—')),
          h('td', { 'data-col': 'publication' }, badge(pub.label, pub.cls), !pub.published && pub.blockers.length ? h('div', { class: 'hint' }, 'Not eligible yet') : null),
          h('td', {}, badge(st.label, st.cls), t.rollback ? badge('Rolled back', 'premium') : null, t.force_update_below ? badge('Force ≥ ' + t.force_update_below, 'premium') : null),
          h('td', {}, cur ? h('code', {}, cur.version) : '—', h('div', { class: 'hint' }, (t.releases.length) + ' release' + (t.releases.length === 1 ? '' : 's')), cur && L.releaseMeta(cur).category ? h('div', { class: 'hint' }, L.releaseMeta(cur).category) : null),
          h('td', { 'data-col': 'access' }, planBadges(t), accessExtra(t) ? h('div', { class: 'hint' }, accessExtra(t)) : null),
          h('td', {}, fmtShort(t.updated_at)),
          h('td', { class: 'actions' }, btn('Manage', () => { sel = t.tool_id; dtab = 'overview'; draw(); }, 'small', { 'data-act': 'manage' })));
      });
      return h('div', { class: 'tablewrap' }, h('table', { id: 'at-table' }, h('thead', {}, h('tr', {}, ['Tool', 'Author', 'Publication', 'Status', 'Current', 'Access', 'Updated', ''].map((c) => h('th', {}, c)))), h('tbody', {}, rows)));
    }

    // ---------------------------------------------------------------- tool detail
    function detail(t) {
      const st = L.toolStatus(t);
      const tabs = h('span', { class: 'seg', role: 'group', 'aria-label': 'Tool sections' }, [['overview', 'Overview'], ['releases', 'Releases (' + t.releases.length + ')'], ['access', 'Access'], ['audit', 'Audit']].map(([v, l]) =>
        h('button', { type: 'button', class: v === dtab ? 'on' : '', 'data-dtab': v, onclick: () => { dtab = v; draw(); } }, l)));
      const body = dtab === 'releases' ? releasesPanel(t) : dtab === 'access' ? accessPanel(t) : dtab === 'audit' ? auditPanel(t.tool_id) : overviewPanel(t);
      return h('div', { id: 'at-detail', 'data-tool': t.tool_id },
        h('div', { class: 'toolbar' }, btn('← All tools', () => { sel = null; draw(); }, 'small', { id: 'at-back' }), h('h2', {}, t.name), badge(L.publicationState(t).label, L.publicationState(t).cls), badge(st.label, st.cls), h('code', {}, t.tool_id), tabs),
        body);
    }

    function overviewPanel(t) {
      const cur = L.currentRelease(t); const blockers = L.publishBlockers(t); const out = [];
      if (t.rollback) out.push(h('div', { class: 'panel at-banner' }, h('h3', {}, 'Rolled back'), h('p', {}, `Users are offered ${t.current_version || '?'} instead of ${t.rollback.from_version || '?'} since ${fmt(t.rollback.at)}.`), t.rollback.reason ? h('p', {}, 'Reason: ' + t.rollback.reason) : null));
      out.push(h('div', { class: 'panel' }, h('div', { class: 'p-head' }, h('h3', {}, 'Details'), btn('Edit', () => toolDialog(t), 'small', { id: 'at-edit' })),
        h('div', { class: 'at-kvs' }, kv('Name', t.name), kv('Author', t.author), kv('Availability', planBadges(t)), kv('Current release', cur ? cur.version : 'none'), kv('Previous release', t.previous_version), kv('Revision', t.revision), kv('Last change', fmt(t.updated_at))),
        t.description ? h('p', { style: 'margin-top:10px' }, t.description) : note('No description.'),
        note('Name, description and author are entered here (Edit). Availability is set on the Access tab.', 'hint')));
      out.push(h('div', { class: 'panel', id: 'at-meta-panel' }, h('h3', {}, 'Current release metadata'),
        cur ? h('div', { class: 'at-kvs' }, [kv('Version', cur.version), ...metaKvs(L.releaseMeta(cur))]) : note('No current release yet.'),
        cur ? note(L.releaseMeta(cur).any ? FROM_SIGNED : 'This release declares no category, tags or icon. ' + FROM_SIGNED, 'hint') : null));
      out.push(h('div', { class: 'panel' }, h('h3', {}, 'Visibility'),
        h('div', { class: 'at-switch' }, h('div', {}, h('b', {}, t.published ? 'Published' : 'Not published'), h('div', { class: 'hint' }, t.published ? 'Listed in the app for people who pass the access rule.' : 'Hidden from every user. The current release is kept.')),
          t.published ? btn('Unpublish', () => stateDialog(t, 'published', false), 'danger', { id: 'at-unpublish' }) : btn('Publish', () => stateDialog(t, 'published', true), 'primary', { id: 'at-publish', disabled: blockers.length ? true : null, title: blockers.join(' ') })),
        !t.published && blockers.length ? note(blockers.join(' '), 'warn') : null,
        h('div', { class: 'at-switch' }, h('div', {}, h('b', {}, t.enabled ? 'Enabled' : 'Disabled'), h('div', { class: 'hint' }, t.enabled ? 'Master switch is on.' : 'Master switch is off: off for everybody, even users with a personal allow.')),
          t.enabled ? btn('Disable', () => stateDialog(t, 'enabled', false), 'danger', { id: 'at-disable' }) : btn('Enable', () => stateDialog(t, 'enabled', true), '', { id: 'at-enable' }))));
      out.push(forceUpdatePanel(t));
      return h('div', { class: 'at-stack' }, out);
    }

    function stateDialog(t, field, value) {
      const texts = {
        'published:true': ['Publish ' + t.name + '?', `People who pass the access rule (${L.planText(t)}) will be offered version ${t.current_version || '?'}.`, 'Publish', 'primary', 'Published.'],
        'published:false': ['Unpublish ' + t.name + '?', 'It disappears from the catalog and installed copies stop being allowed to open. Releases are kept; you can publish again later.', 'Unpublish', 'danger', 'Unpublished.'],
        'enabled:true': ['Enable ' + t.name + '?', 'The master switch goes back on. Access then follows the plan switches and personal overrides.', 'Enable', 'primary', 'Enabled.'],
        'enabled:false': ['Disable ' + t.name + '?', 'Switched off for everybody (even personal allows). The published state and releases are kept.', 'Disable', 'danger', 'Disabled.'],
      }[field + ':' + value];
      modal(texts[0], h('p', {}, texts[1]), [{ label: 'Cancel', run: (c) => c() }, { label: texts[2], cls: texts[3], run: async (c) => {
        const r = await mutate(() => rpc('admin_addon_tools_set_state', L.stateCall(t, { [field]: value })), texts[4]);
        if (r.ok || r.kind === 'stale') c(); else return true;
      } }]);
    }

    function forceUpdatePanel(t) {
      const cur = L.currentRelease(t);
      const v = h('input', { type: 'text', id: 'at-force-version', placeholder: cur ? 'e.g. ' + cur.version : '1.2.3', value: t.force_update_below || '', maxlength: '30', style: 'width:140px' });
      const why = h('textarea', { id: 'at-force-reason', maxlength: String(L.LIMITS.reason), placeholder: 'Shown to people whose installed copy is older than this version', style: 'min-height:60px' }, t.force_update_reason || '');
      const msg = h('p', { class: 'warn', hidden: true });
      const apply = (clear) => {
        const c = L.forceUpdateCall(t, clear ? '' : v.value, clear ? '' : why.value);
        if (!c.ok) { msg.textContent = c.errors.join(' '); msg.hidden = false; return; }
        msg.hidden = true;
        modal(clear ? 'Clear the force update?' : 'Require version ' + trimV(v.value) + ' or newer?',
          h('p', {}, clear ? 'Installed copies are no longer forced to update.' : `Installed copies older than ${trimV(v.value)} must update to ${cur ? cur.version : 'the current release'} before they can be opened.`),
          [{ label: 'Cancel', run: (cl) => cl() }, { label: clear ? 'Clear' : 'Require update', cls: clear ? '' : 'danger', run: async (cl) => {
            const r = await mutate(() => rpc('admin_addon_tools_set_force_update', c.args), clear ? 'Force update cleared.' : 'Force update saved.');
            if (r.ok || r.kind === 'stale') cl(); else return true; } }]);
      };
      const trimV = (s) => String(s).trim();
      return h('div', { class: 'panel', id: 'at-force' }, h('h3', {}, 'Force update'),
        t.force_update_below ? h('p', {}, 'Active: installed copies below ', h('b', {}, t.force_update_below), ' must update.' + (t.force_update_at ? ' Set ' + fmt(t.force_update_at) + '.' : '')) : note('Not set: users may keep any installed version that is not revoked.'),
        h('div', { class: 'field' }, h('label', {}, 'Minimum version'), v), h('div', { class: 'field' }, h('label', {}, 'Reason'), why), msg,
        h('div', { class: 'row' }, btn('Save', () => apply(false), 'primary', { id: 'at-force-save' }), t.force_update_below ? btn('Clear', () => apply(true), '', { id: 'at-force-clear' }) : null),
        note('The minimum cannot be higher than the current release. Making an older release current is refused while it is below this minimum.', 'hint'));
    }

    // ---------------------------------------------------------------- releases
    function releaseMetaCell(r) {
      const m = L.releaseMeta(r); if (!m.any) return h('span', { class: 'hint' }, 'none declared');
      return h('div', {}, m.category ? h('div', {}, badge(m.category, 'premium')) : null, tagBadges(m.tags), m.icon ? h('div', { class: 'hint at-clip', title: m.icon }, 'icon: ' + m.icon) : null);
    }
    function releasesPanel(t) {
      const cur = L.currentRelease(t);
      const rows = t.releases.map((r) => {
        const sk = L.selectKind(t, r);
        const act = [];
        if (sk.kind === 'update') act.push(btn('Make current', () => selectDialog(t, r, 'update'), 'small primary', { 'data-act': 'current' }));
        else if (sk.kind === 'rollback') act.push(btn('Roll back to this', () => selectDialog(t, r, 'rollback'), 'small gold', { 'data-act': 'rollback' }));
        else act.push(btn('Make current', () => {}, 'small', { disabled: true, title: sk.why }));
        if (r.revoked) act.push(btn('Restore', () => revokeDialog(t, r, false), 'small', { 'data-act': 'unrevoke' }));
        else act.push(btn('Revoke', () => revokeDialog(t, r, true), 'small danger', { 'data-act': 'revoke', disabled: r.release_id === t.current_release_id ? true : null, title: r.release_id === t.current_release_id ? 'Make another release current before revoking this one.' : null }));
        return h('tr', { 'data-version': r.version, class: r.is_current ? 'at-current' : '' },
          h('td', {}, h('b', {}, r.version), h('div', { class: 'hint' }, '#' + r.seq)),
          h('td', {}, h('div', { class: 'badges' }, L.releaseLabels(t, r).map((x) => badge(x.text, x.cls))), r.revoked && r.revoked_reason ? h('div', { class: 'hint' }, r.revoked_reason) : null),
          h('td', {}, L.fmtBytes(r.zip_size), h('div', { class: 'hint' }, r.file_count + ' files')),
          h('td', {}, h('code', { title: r.zip_sha256 }, L.shortHash(r.zip_sha256)), h('div', { class: 'hint' }, 'key ' + r.key_id)),
          h('td', {}, r.min_app_version || '—', h('div', { class: 'hint' }, (r.permissions || []).join(', ') || 'no permissions')),
          h('td', { 'data-col': 'meta' }, releaseMetaCell(r)),
          h('td', {}, fmtShort(r.created_at), r.notes ? h('div', { class: 'hint at-clip', title: r.notes }, r.notes) : null),
          h('td', { class: 'actions at-wrap' }, act));
      });
      const summary = h('div', { class: 'at-kvs' }, kv('Current', cur ? cur.version : 'none'), kv('Previous', t.previous_version), kv('Rollback', t.rollback ? `from ${t.rollback.from_version}` : 'no'), kv('Force minimum', t.force_update_below));
      return h('div', { class: 'at-stack' },
        h('div', { class: 'panel' }, h('div', { class: 'p-head' }, h('h3', {}, 'Release history'), btn('Upload release', () => publishDialog(t.tool_id), 'primary small', { id: 'at-upload2' })), summary,
          note('Category, tags and icon shown per release come from its signed package. An uploaded release is stored but NOT offered until you make it current. Older versions can be selected again as a rollback (a reason is required). Revoking stops apps from running or installing that release.', 'hint')),
        t.releases.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'at-releases' }, h('thead', {}, h('tr', {}, ['Version', 'State', 'Package', 'SHA-256', 'Needs / permissions', 'Metadata (signed)', 'Uploaded', ''].map((c) => h('th', {}, c)))), h('tbody', {}, rows)))
          : h('div', { class: 'panel' }, note('No release yet. Upload the first package.'), btn('Upload release', () => publishDialog(t.tool_id), 'primary')));
    }

    function reasonDialog(o) {
      const ta = h('textarea', { id: 'at-reason', maxlength: String(L.LIMITS.reason), placeholder: o.placeholder || '', style: 'min-height:70px' });
      const msg = h('p', { class: 'warn', hidden: true });
      const body = h('div', {}, o.intro, h('div', { class: 'field' }, h('label', {}, o.label), ta), msg);
      modal(o.title, body, [{ label: 'Cancel', run: (c) => c() }, { label: o.confirmLabel, cls: o.cls || 'primary', run: async (c) => {
        const chk = o.check(ta.value);
        if (!chk.ok) { msg.textContent = chk.errors.join(' '); msg.hidden = false; return true; }
        const r = await mutate(() => rpc(o.rpc, chk.args), o.ok);
        if (r.ok || r.kind === 'stale') c(); else { msg.textContent = r.text; msg.hidden = false; return true; }
      } }]);
    }
    function selectDialog(t, r, kind) {
      const cur = L.currentRelease(t);
      if (kind === 'update') {
        modal('Make ' + r.version + ' current?', h('p', {}, cur ? `Users are offered ${r.version} instead of ${cur.version}. Installed copies update when the app next checks.` : `${r.version} becomes the release users are offered once the tool is published.`),
          [{ label: 'Cancel', run: (c) => c() }, { label: 'Make current', cls: 'primary', run: async (c) => {
            const chk = L.setCurrentCall(t, r, ''); if (!chk.ok) { toast(chk.errors.join(' '), true); return true; }
            const x = await mutate(() => rpc('admin_addon_tools_set_current_release', chk.args), r.version + ' is now current.');
            if (x.ok || x.kind === 'stale') c(); else return true; } }]);
        return;
      }
      reasonDialog({ title: 'Roll back to ' + r.version + '?', intro: h('p', {}, `Users are offered the OLDER ${r.version} instead of ${cur ? cur.version : 'the current release'}. Apps that already run the newer version are allowed to downgrade.`),
        label: 'Reason (required, recorded in the audit log)', placeholder: 'What was wrong with the newer release?', confirmLabel: 'Roll back', cls: 'danger',
        check: (reason) => { const c = L.setCurrentCall(t, r, reason); return { ok: c.ok, errors: c.errors, args: c.args }; }, rpc: 'admin_addon_tools_set_current_release', ok: 'Rolled back to ' + r.version + '.' });
    }
    function revokeDialog(t, r, revoke) {
      if (!revoke) {
        modal('Restore ' + r.version + '?', h('p', {}, 'The release is no longer revoked. It is NOT made current automatically.'), [{ label: 'Cancel', run: (c) => c() }, { label: 'Restore', run: async (c) => {
          const chk = L.revokeCall(t, r, false, ''); if (!chk.ok) { toast(chk.errors.join(' '), true); return true; }
          const x = await mutate(() => rpc('admin_addon_tools_set_release_revoked', chk.args), r.version + ' restored.'); if (x.ok || x.kind === 'stale') c(); else return true; } }]);
        return;
      }
      reasonDialog({ title: 'Revoke ' + r.version + '?', intro: h('p', {}, 'Every app is told to stop running and installing this release. It cannot be made current while revoked. Revocation is recorded in the audit log.'),
        label: 'Reason (required)', placeholder: 'Why is this release withdrawn?', confirmLabel: 'Revoke', cls: 'danger',
        check: (reason) => { const c = L.revokeCall(t, r, true, reason); return { ok: c.ok, errors: c.errors, args: c.args }; }, rpc: 'admin_addon_tools_set_release_revoked', ok: r.version + ' revoked.' });
    }

    // ---------------------------------------------------------------- access
    function accessPanel(t) {
      const free = h('input', { type: 'checkbox', id: 'at-free' }); free.checked = !!t.access_free;
      const prem = h('input', { type: 'checkbox', id: 'at-premium' }); prem.checked = !!t.access_premium;
      const save = btn('Save plan access', () => {
        const patch = {}; if (free.checked !== !!t.access_free) patch.free = free.checked; if (prem.checked !== !!t.access_premium) patch.premium = prem.checked;
        if (!Object.keys(patch).length) { toast('Nothing changed.'); return; }
        modal('Change plan access?', h('p', {}, `${L.planText({ access_free: free.checked, access_premium: prem.checked })}. Takes effect for every user on the next catalog refresh.`),
          [{ label: 'Cancel', run: (c) => c() }, { label: 'Save', cls: 'primary', run: async (c) => {
            const r = await mutate(() => rpc('admin_addon_tools_set_plan_access', L.planCall(t, patch)), 'Plan access saved.'); if (r.ok || r.kind === 'stale') c(); else return true; } }]);
      }, 'primary', { id: 'at-plan-save' });
      const plan = h('div', { class: 'panel' }, h('h3', {}, 'Plans'), h('p', { class: 'at-note' }, 'Availability now: ', planBadges(t)),
        h('div', { class: 'row' }, h('label', { class: 'name' }, free, ' Free: available'), h('label', { class: 'name' }, prem, ' Premium: available'), save),
        note('A user can use the tool only if it is published AND enabled AND has a current release AND (their personal override, else their plan switch) is on. The master switches beat a personal allow.', 'hint'));
      const rows = t.user_access.map((u) => h('tr', { 'data-user': u.user_id },
        h('td', {}, u.email || u.user_id), h('td', {}, badge(u.allowed ? 'Allowed' : 'Denied', u.allowed ? 'ok' : 'suspended')), h('td', {}, fmtShort(u.updated_at)),
        h('td', { class: 'actions' }, btn(u.allowed ? 'Deny instead' : 'Allow instead', () => userAccess(t, u.user_id, u.email, !u.allowed), 'small'), btn('Remove override', () => userAccess(t, u.user_id, u.email, null), 'small', { 'data-act': 'clear-user' }))));
      const users = h('div', { class: 'panel', id: 'at-users' }, h('div', { class: 'p-head' }, h('h3', {}, 'Per-user overrides'), btn('Add user…', () => userPicker(t), 'small primary', { id: 'at-add-user' })),
        rows.length ? h('div', { class: 'tablewrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['User', 'Override', 'Changed', ''].map((c) => h('th', {}, c)))), h('tbody', {}, rows))) : note('No personal overrides: the plan switches decide for everyone.'));
      return h('div', { class: 'at-stack' }, plan, users);
    }
    function userAccess(t, userId, email, allowed, closeFn) {
      const c = L.userAccessCall(t, userId, allowed); if (!c.ok) { toast(c.errors.join(' '), true); return; }
      const what = allowed === null ? `Remove the personal override for ${email || userId}? The plan switch decides again.` : `${allowed ? 'Allow' : 'Deny'} ${email || userId}? This beats their plan switch.`;
      modal(allowed === null ? 'Remove override?' : (allowed ? 'Allow user?' : 'Deny user?'), h('p', {}, what), [{ label: 'Cancel', run: (x) => x() }, { label: 'Confirm', cls: allowed === false ? 'danger' : 'primary', run: async (x) => {
        const r = await mutate(() => rpc('admin_addon_tools_set_user_access', c.args), 'User access saved.'); if (r.ok || r.kind === 'stale') { x(); if (closeFn) closeFn(); } else return true; } }]);
    }
    function userPicker(t) {
      const q = h('input', { type: 'search', id: 'at-user-q', placeholder: 'Search by email…', style: 'width:100%' }); const list = h('div', { class: 'at-results' }); const status = h('p', { class: 'hint' }, 'Type at least 3 characters.');
      let timer = null; let seq = 0; let closeIt = () => {};
      const search = async () => {
        const s = q.value.trim(); const my = ++seq; if (s.length < 3) { list.replaceChildren(); status.textContent = 'Type at least 3 characters.'; return; }
        status.replaceChildren(h('span', { class: 'spin' }), ' Searching…');
        try {
          const found = await rpc('admin_list_users', { p_search: s, p_limit: 8, p_offset: 0 }); if (my !== seq) return;
          status.textContent = found.length ? 'Choose a user:' : 'No user found.';
          list.replaceChildren(...found.map((u) => h('div', { class: 'at-pick' }, h('div', {}, h('b', {}, u.email), h('div', { class: 'hint' }, (u.nickname ? u.nickname + ' · ' : '') + u.plan)),
            h('div', { class: 'row', style: 'margin:0' }, btn('Allow', () => userAccess(t, u.id, u.email, true, closeIt), 'small primary'), btn('Deny', () => userAccess(t, u.id, u.email, false, closeIt), 'small danger')))));
        } catch (e) { if (my === seq) { status.textContent = ''; status.append(h('span', { class: 'warn' }, e.message)); } }
      };
      q.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(search, 300); });
      closeIt = modal('Add a personal override for ' + t.name, h('div', {}, h('div', { class: 'field' }, q), status, list), [{ label: 'Close', run: (c) => c() }]);
    }

    // ---------------------------------------------------------------- Developer Import permission (Part 11)
    // A per-USER switch for a future Developer ZIP Import in the Main App (so it lives next to the tool list, not inside one tool's Access tab).
    // It does not touch catalog access and gives no right to publish. The screen only calls the 0035 RPCs with the admin's own session; every
    // state shown is what the server answered (re-read after each change), never a guess.
    const dev = { q: '', found: [], states: {}, list: null, settings: null, error: null, searching: '', seq: 0,
      req: { filter: 'pending', list: null, error: null, seq: 0, focus: null }, summary: null };          // Part 13: access requests + the pending notice
    const DEV_MISSING = 'The Developer Import database functions are not installed on this server. Apply migrations 0035_addon_tools_developer_import_permission.sql and 0036_addon_tools_developer_options_access.sql (test project first), then reload.';
    const REQ_MISSING = 'The access-request functions are not installed on this server. Apply migrations 0037_addon_tools_developer_access_requests.sql and 0038_addon_tools_developer_request_admin.sql (test project first), then reload.';
    const reqError = (e) => (L.isMissingRpcError(e.message) ? { kind: 'missing', text: REQ_MISSING } : L.describeRpcError(e.message));
    const devError = (e) => (L.isMissingRpcError(e.message) ? { kind: 'missing', text: DEV_MISSING } : L.describeRpcError(e.message));
    // One search box for the life of the screen: draw() rebuilds the page, so the box is re-attached and keeps its focus / caret (devDraw).
    const devQ = h('input', { type: 'search', id: 'at-dev-q', placeholder: 'Search by email…', style: 'width:100%' }); let devTimer = null;
    devQ.addEventListener('input', () => { dev.q = devQ.value; clearTimeout(devTimer); devTimer = setTimeout(devSearch, 300); });
    function devDraw() {
      if (view !== 'developer') return;
      const f = document.activeElement === devQ; const pos = devQ.selectionStart;
      draw(); if (f) { devQ.focus(); try { devQ.setSelectionRange(pos, pos); } catch (e) { /* not supported for this input type */ } }
    }
    const devOn = (id) => !!(dev.states[String(id).toLowerCase()] || {}).enabled;
    async function devLoad() {
      try { dev.settings = L.parseDeveloperSettings(await rpc('admin_addon_tools_get_developer_settings')); dev.list = L.parseDeveloperList(await rpc('admin_addon_tools_list_developer_import')); dev.error = null; }
      catch (e) { dev.list = null; dev.settings = null; dev.error = devError(e); }
      devDraw();
      await devLoadRequests(); devDraw();                              // separate: a server without 0038 still shows the rest of the screen
    }
    // Part 13: the request list (server-authoritative, re-read after every decision) and the pending notice.
    async function devLoadRequests() {
      const my = ++dev.req.seq;
      try { const list = L.parseDeveloperRequests(await rpc('admin_addon_tools_list_developer_requests', L.developerRequestListCall(dev.req.filter))); if (my !== dev.req.seq) return; dev.req.list = list; dev.req.error = null; }
      catch (e) { if (my !== dev.req.seq) return; dev.req.list = null; dev.req.error = reqError(e); }
      await devLoadSummary();
    }
    async function devLoadSummary() {
      try { dev.summary = L.parseDeveloperRequestSummary(await rpc('admin_addon_tools_developer_request_summary')); } catch (e) { dev.summary = null; }
      if (ctx.setNavBadge) ctx.setNavBadge(dev.summary ? dev.summary.count : 0);
    }
    function devOpenRequest(id) { view = 'developer'; dev.req.filter = 'pending'; dev.req.focus = id || null; devLoad(); draw(); }
    async function devStates() {                                       // re-read the state of the users currently shown
      const ids = dev.found.map((u) => u.id).filter(Boolean);
      dev.states = ids.length ? L.parseDeveloperStates(await rpc('admin_addon_tools_get_developer_import', { p_user_ids: ids })) : {};
    }
    async function devSearch() {
      const s = dev.q.trim(); const my = ++dev.seq;
      if (s.length < 3) { dev.found = []; dev.states = {}; dev.searching = ''; devDraw(); return; }
      dev.searching = 'Searching…'; devDraw();
      try {
        const found = await rpc('admin_list_users', { p_search: s, p_limit: 8, p_offset: 0 }); if (my !== dev.seq) return;
        dev.found = Array.isArray(found) ? found.filter((u) => u && typeof u.id === 'string') : [];
        await devStates(); if (my !== dev.seq) return;
        dev.searching = dev.found.length ? '' : 'No user found.'; dev.error = null;
      } catch (e) { if (my !== dev.seq) return; dev.found = []; dev.states = {}; dev.searching = ''; dev.error = devError(e); }
      devDraw();
    }
    // enabled: true = personal ON, false = personal OFF, null = remove the personal decision (the plan switch decides again).
    function devSet(u, enabled) {
      const c = L.developerImportCall(u.id, enabled); if (!c.ok) { toast(c.errors.join(' '), true); return; }
      const who = u.email || u.id; const g = dev.settings && dev.settings.enabled;
      const T = { true: ['Allow Developer Options for this user?', `${who} gets a personal ON.` + (g ? '' : ' Developer Options is switched off globally, so it stays blocked until the global switch is ON.'), 'Allow', 'primary'],
        false: ['Block Developer Options for this user?', `${who} gets a personal OFF: blocked even if their plan is allowed.`, 'Block', 'danger'],
        null: ['Reset to plan setting?', `${who} loses the personal decision; the Free / Premium switch below decides again.`, 'Reset', ''] }[String(enabled)];
      modal(T[0], h('div', {}, h('p', {}, T[1]), note('Only this permission. It gives no catalog tool access and no right to publish to the public catalog. The server enforces it.', 'hint')),
        [{ label: 'Cancel', run: (x) => x() }, { label: T[2], cls: T[3], run: async (x) => {
          if (busy) { toast('Another change is still running.', true); return true; }
          setBusy(true);
          try {
            const res = await rpc('admin_addon_tools_set_developer_import', c.args);
            const got = res && (res.override === true ? true : res.override === false ? false : null);
            if (!(res && got === enabled && String(res.user_id || '').toLowerCase() === String(u.id).toLowerCase())) throw new Error('The server did not confirm the change. Check the state shown and try again.');
            setBusy(false); toast('Developer Options saved.'); x();
          } catch (e) { setBusy(false); toast(devError(e).text, true); return true; }
          try { await devStates(); } catch (e) { /* the list below still re-reads */ }
          await devLoad();
        } }]);
    }
    function devSetSettings(patch, title, text, label, cls) {
      const c = L.developerSettingsCall(patch); if (!c.ok) { toast(c.errors.join(' '), true); return; }
      modal(title, h('div', {}, h('p', {}, text), note('The server decides. A global OFF blocks everybody, including users with a personal ON.', 'hint')),
        [{ label: 'Cancel', run: (x) => x() }, { label, cls, run: async (x) => {
          if (busy) { toast('Another change is still running.', true); return true; }
          setBusy(true);
          try {
            const res = L.parseDeveloperSettings(await rpc('admin_addon_tools_set_developer_settings', c.args));
            const want = (k) => (patch[k] === undefined || (res && res[k] === patch[k]));
            if (!res || !want('enabled') || !want('allow_free') || !want('allow_premium')) throw new Error('The server did not confirm the change. Check the state shown and try again.');
            setBusy(false); toast('Developer Options settings saved.'); x();
          } catch (e) { setBusy(false); toast(devError(e).text, true); return true; }
          try { await devStates(); } catch (e) { /* re-read below */ }
          await devLoad();
        } }]);
    }
    // ---- Part 13: approve / decline. The confirmation names the user and says exactly what happens; the server then re-checks everything.
    function devDecide(r, decision) {
      const c = L.developerRequestDecisionCall(r.id, decision); if (!c.ok) { toast(c.errors.join(' '), true); return; }
      const who = r.email || r.user_id; const g = dev.settings && dev.settings.enabled;
      const approve = decision === 'approved';
      const body = approve
        ? h('div', {}, h('p', {}, `${who} gets a personal ON (the same as "Allow" in Find a user).`),
            g === false || r.reason === 'global_off' ? note('Developer Options is switched off globally, so it stays blocked for them until the global switch is ON.', 'warn') : null,
            r.reason === 'override_off' ? note('This user has a personal OFF. The server refuses the approval and changes nothing; reset or allow them first, or decline the request.', 'warn') : null,
            note('Only this permission. It gives no catalog tool access and no right to publish. The server checks it again.', 'hint'))
        : h('div', {}, h('p', {}, `${who} is told the request was declined. No access is granted; they can ask again after 24 hours.`), note('The server checks that the request is still pending.', 'hint'));
      modal(approve ? 'Approve this request?' : 'Decline this request?', body, [{ label: 'Cancel', run: (x) => x() }, { label: approve ? 'Approve' : 'Decline', cls: approve ? 'primary' : 'danger', run: async (x) => {
        if (busy) { toast('Another change is still running.', true); return true; }
        setBusy(true); let out;
        try { out = L.interpretDecision(await rpc('admin_addon_tools_decide_developer_request', c.args), decision, r.id); }
        catch (e) { setBusy(false); toast(reqError(e).text, true); return true; }
        setBusy(false); toast(out.text, !out.ok && out.kind === 'err'); x();
        if (out.refresh) { try { await devStates(); } catch (e) { /* re-read below */ } await devLoad(); }
      } }]);
    }
    function requestsPanel() {
      const R = dev.req; const sum = dev.summary;
      const tabs = h('span', { class: 'seg', role: 'group', 'aria-label': 'Request status' }, [['pending', 'Pending'], ['approved', 'Approved'], ['declined', 'Declined'], ['all', 'All']].map(([v, l]) =>
        h('button', { type: 'button', class: v === R.filter ? 'on' : '', 'data-req-filter': v, onclick: () => { R.filter = v; R.list = null; devDraw(); devLoadRequests().then(devDraw); } }, l, v === 'pending' && sum && sum.count ? h('span', { class: 'badge premium at-count' }, String(sum.count)) : null)));
      let box;
      if (R.error) box = h('div', {}, h('p', { class: 'warn' }, R.error.text), btn('Try again', () => { devLoadRequests().then(devDraw); }, 'small'));
      else if (R.list === null) box = spin('Loading…');
      else if (!R.list.length) box = note(R.filter === 'pending' ? 'No pending requests.' : 'No requests to show.');
      else box = h('div', { class: 'tablewrap' }, h('table', { id: 'at-req-table' }, h('thead', {}, h('tr', {}, ['User', 'Requested', 'Message', 'Status', 'Developer Options now', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, R.list.map((r) => { const st = L.requestStatus(r.status);
          return h('tr', { 'data-request': r.id, 'data-status': r.status, 'data-focus': R.focus === r.id ? '1' : null },
            h('td', {}, h('b', {}, r.email || r.user_id), h('div', { class: 'hint' }, (r.nickname ? r.nickname + ' · ' : '') + (r.plan || ''))),
            h('td', {}, fmtShort(r.created_at)),
            h('td', { class: 'at-wrap' }, r.message ? h('span', { class: 'at-msg' }, r.message) : h('span', { class: 'hint' }, 'No message')),
            h('td', {}, badge(st.text, st.cls), r.status !== 'pending' ? h('div', { class: 'hint' }, fmtShort(r.decided_at) + (r.decided_by_email ? ' by ' + r.decided_by_email : '')) : null),
            h('td', {}, devReasonBadge(r.reason)),
            h('td', { class: 'actions' }, r.status === 'pending' ? [btn('Approve', () => devDecide(r, 'approved'), 'small primary', { 'data-act': 'req-approve' }), btn('Decline', () => devDecide(r, 'declined'), 'small danger', { 'data-act': 'req-decline' })] : null)); }))));
      if (R.focus && R.list) { const id = R.focus; setTimeout(() => { const el = root.querySelector('[data-request="' + id + '"]'); if (el) { try { el.scrollIntoView({ block: 'center' }); } catch (e) { /* ignore */ } } }, 0); if (R.list.some((x) => x.id === id) || R.error) R.focus = null; }
      return h('div', { class: 'panel', id: 'at-dev-requests' }, h('div', { class: 'p-head' }, h('h3', {}, 'Access requests'), tabs),
        h('p', { class: 'hint' }, 'Users who cannot use Developer Options can ask for access. Approving saves a personal ON; it never overrides the global switch. Declining grants nothing.'), box);
    }
    function devBadge(on) { const b = L.developerImportBadge(on); return badge(b.text, b.cls); }
    function devReasonBadge(code) { const r = L.developerReason(code); return badge(r.text, r.cls); }
    function devPersonal(o) { return o === true ? badge('Personal ON', 'ok') : o === false ? badge('Personal OFF', 'suspended') : h('span', { class: 'hint' }, 'No personal setting'); }
    function settingsPanel() {
      const st = dev.settings;
      if (!st) return h('div', { class: 'panel', id: 'at-dev-settings' }, h('h3', {}, 'Developer Options availability'), dev.error ? note('The current setting could not be read.') : spin('Loading…'));
      const on = st.enabled;
      const planRow = (key, label, val) => h('div', { class: 'at-switch', 'data-plan': key }, h('div', {}, h('b', {}, label + ': ' + (val ? 'allowed' : 'not allowed')),
        h('div', { class: 'hint' }, `${label} accounts with no personal setting ${val ? 'may' : 'may not'} use Developer Options${on ? '.' : ' (once the global switch is ON).'}`)),
        val ? btn('Turn off', () => devSetSettings({ [key]: false }, 'Turn off Developer Options for ' + label + '?', label + ' accounts without a personal ON lose access.', 'Turn off', 'danger'), 'small danger', { 'data-act': 'dev-plan-off-' + key })
            : btn('Turn on', () => devSetSettings({ [key]: true }, 'Allow Developer Options for ' + label + '?', label + ' accounts without a personal OFF will be allowed' + (on ? '.' : ', once the global switch is ON.'), 'Turn on', 'primary'), 'small primary', { 'data-act': 'dev-plan-on-' + key }));
      return h('div', { class: 'panel', id: 'at-dev-settings' }, h('div', { class: 'p-head' }, h('h3', {}, 'Developer Options availability'), badge(L.developerSettingsSummary(st), on ? 'ok' : 'suspended')),
        h('div', { class: 'at-switch', 'data-plan': 'global' }, h('div', {}, h('b', {}, on ? 'Global switch: ON' : 'Global switch: OFF'),
          h('div', { class: 'hint' }, on ? 'Users can have Developer Options according to the plan switches and personal settings below.' : 'Nobody has Developer Options, whatever their plan or personal setting says.')),
          on ? btn('Turn OFF for everybody', () => devSetSettings({ enabled: false }, 'Turn Developer Options OFF for everybody?', 'Every user loses Developer Options, including users with a personal ON. Personal and plan settings are kept.', 'Turn OFF', 'danger'), 'small danger', { 'data-act': 'dev-global-off' })
             : btn('Turn ON', () => devSetSettings({ enabled: true }, 'Turn Developer Options ON?', 'Users are then allowed according to the plan switches and personal settings. Nothing is allowed by default: both plan switches are off until you turn them on.', 'Turn ON', 'primary'), 'small primary', { 'data-act': 'dev-global-on' })),
        planRow('allow_free', 'Free', st.allow_free), planRow('allow_premium', 'Premium', st.allow_premium),
        note(`Personal settings: ${st.overrides_on} ON, ${st.overrides_off} OFF.` + (st.updated_at ? ` Last change ${fmtShort(st.updated_at)}${st.updated_by_email ? ' by ' + st.updated_by_email : ''}.` : ''), 'hint'));
    }
    function developerPanel() {
      const q = devQ; if (q.value !== dev.q) q.value = dev.q;
      const pick = dev.found.map((u) => { const stt = dev.states[String(u.id).toLowerCase()] || {}; const ov = stt.override === undefined ? null : stt.override; return h('div', { class: 'at-pick', 'data-user': u.id },
        h('div', {}, h('b', {}, u.email), h('div', { class: 'hint' }, (u.nickname ? u.nickname + ' · ' : '') + (u.plan || '')), h('div', { style: 'margin-top:4px' }, devReasonBadge(stt.reason), ' ', devPersonal(ov))),
        h('div', { class: 'row', style: 'margin:0;align-items:center' }, devBadge(!!stt.enabled),
          ov === true ? null : btn('Allow', () => devSet(u, true), 'small primary', { 'data-act': 'dev-on' }), ov === false ? null : btn('Block', () => devSet(u, false), 'small danger', { 'data-act': 'dev-off' }),
          ov === null ? null : btn('Reset', () => devSet(u, null), 'small', { 'data-act': 'dev-reset' }))); });
      const searchStatus = dev.searching || (dev.q.trim().length < 3 ? 'Type at least 3 characters of the email.' : (dev.found.length ? 'Choose what to do:' : ''));
      const intro = h('div', { class: 'panel' }, h('h3', {}, 'Developer Options access'),
        h('p', {}, 'Decides who may use Developer Options (Developer ZIP Import) in the app. Order of rules: the global switch first (OFF blocks everybody), then a personal ON / OFF, then the Free / Premium switch. Everything is OFF until you turn it ON.'),
        note('Separate from tool access: it does not allow or deny any catalog tool, and it does not allow anyone to publish tools to the public catalog (only administrators can do that, in this screen).', 'hint'));
      const find = h('div', { class: 'panel', id: 'at-dev-search' }, h('h3', {}, 'Find a user'), h('div', { class: 'field' }, q),
        h('p', { class: 'hint' }, dev.searching === 'Searching…' ? [h('span', { class: 'spin' }), ' Searching…'] : searchStatus), h('div', { class: 'at-results' }, pick));
      const err = dev.error ? h('div', { class: 'panel' }, h('p', { class: 'warn' }, dev.error.text), btn('Try again', () => { devLoad(); if (dev.q.trim().length >= 3) devSearch(); }, 'small')) : null;
      let listBox;
      if (dev.list === null && !dev.error) listBox = spin('Loading…');
      else if (dev.list === null) listBox = note('The list could not be loaded.');
      else if (!dev.list.length) listBox = note('Nobody has a personal setting.');
      else listBox = h('div', { class: 'tablewrap' }, h('table', { id: 'at-dev-table' }, h('thead', {}, h('tr', {}, ['User', 'Personal', 'Now', 'Changed', ''].map((c) => h('th', {}, c)))),
        h('tbody', {}, dev.list.map((u) => h('tr', { 'data-user': u.user_id }, h('td', {}, u.email || u.user_id), h('td', {}, devPersonal(u.override)), h('td', {}, devReasonBadge(u.reason)), h('td', {}, fmtShort(u.updated_at)),
          h('td', { class: 'actions' }, btn('Reset', () => devSet({ id: u.user_id, email: u.email }, null), 'small', { 'data-act': 'dev-reset' })))))));
      const current = h('div', { class: 'panel', id: 'at-dev-list' }, h('div', { class: 'p-head' }, h('h3', {}, 'Users with a personal setting'), btn('Refresh', () => { devLoad(); }, 'small')), listBox);
      return h('div', { class: 'at-stack', id: 'at-dev' }, intro, requestsPanel(), err, settingsPanel(), find, current);
    }

    // ---------------------------------------------------------------- audit
    function auditPanel(toolId) {
      const box = h('div', { class: 'panel', id: 'at-audit' }, h('div', { class: 'p-head' }, h('h3', {}, toolId ? 'Audit log: ' + toolId : 'Audit log (all tools)'), h('span', {}, 'append-only')));
      const q = h('input', { type: 'search', id: 'at-audit-q', placeholder: 'Filter (email, action, version…)', style: 'width:240px' });
      const sel2 = h('select', { id: 'at-audit-action' }, h('option', { value: '' }, 'All actions'));
      const body = h('div', {});
      const bar = h('div', { class: 'toolbar', style: 'margin-bottom:8px' }, q, sel2, btn('Reload', () => load(), 'small'));
      box.append(bar, body);
      let rows = null;
      const paint = () => {
        if (!rows) return; const f = L.filterAudit(rows, { q: q.value, action: sel2.value });
        body.replaceChildren(f.length ? h('div', { class: 'tablewrap' }, h('table', { id: 'at-audit-table' }, h('thead', {}, h('tr', {}, ['When', 'Who', 'Tool', 'Version', 'What'].map((c) => h('th', {}, c)))),
          h('tbody', {}, f.map((a) => { const l = L.auditLine(a); return h('tr', {}, h('td', {}, fmt(a.at)), h('td', {}, a.actor_email || '—'), h('td', {}, a.tool_id || '—'), h('td', {}, a.version || '—'), h('td', {}, l.text, l.extra ? h('div', { class: 'hint' }, l.extra) : null)); }))))
          : note(rows.length ? 'No entry matches the filter.' : 'No entries yet.'),
          rows.length >= 200 ? note('Showing the newest 200 entries.', 'hint') : null);
      };
      async function load() {
        body.replaceChildren(spin('Loading the audit log…'));
        try {
          const got = await rpc('admin_addon_tools_list_audit', { p_tool_id: toolId, p_limit: 200 });          // always fresh: the log changes with every action
          rows = Array.isArray(got) ? got : [];
          const acts = [...new Set(rows.map((a) => a.action))].sort(); const keep = sel2.value;
          sel2.replaceChildren(h('option', { value: '' }, 'All actions'), ...acts.map((a) => h('option', { value: a }, L.auditLine({ action: a }).text))); sel2.value = acts.includes(keep) ? keep : '';
          paint();
        } catch (e) { body.replaceChildren(h('p', { class: 'warn' }, L.describeRpcError(e.message).text), btn('Try again', () => load(), 'small')); }
      }
      q.addEventListener('input', paint); sel2.addEventListener('change', paint);
      load();
      return box;
    }

    // ---------------------------------------------------------------- create / edit tool
    function toolDialog(t) {
      const editing = !!t;
      const f = { id: h('input', { type: 'text', id: 'at-f-id', value: editing ? t.tool_id : '', disabled: editing ? true : null, maxlength: '40', placeholder: 'colour-palette' }),
        name: h('input', { type: 'text', id: 'at-f-name', value: editing ? t.name : '', maxlength: String(L.LIMITS.name) }),
        author: h('input', { type: 'text', id: 'at-f-author', value: editing ? t.author : '', maxlength: String(L.LIMITS.author) }),
        desc: h('textarea', { id: 'at-f-desc', maxlength: String(L.LIMITS.description), style: 'min-height:70px' }, editing ? t.description : '') };
      const msg = h('p', { class: 'warn', hidden: true });
      const body = h('div', {}, h('div', { class: 'field' }, h('label', {}, 'Tool id (cannot be changed later; must equal "id" in tool.json)'), f.id), h('div', { class: 'field' }, h('label', {}, 'Name'), f.name),
        h('div', { class: 'field' }, h('label', {}, 'Author (optional)'), f.author), h('div', { class: 'field' }, h('label', {}, 'Description (max 280)'), f.desc), msg,
        note(editing ? 'Saves name, description and author only. Releases, access and visibility are not touched.' : 'The tool is created hidden with no access. Upload a release next.', 'hint'));
      modal(editing ? 'Edit ' + t.name : 'New tool', body, [{ label: 'Cancel', run: (c) => c() }, { label: editing ? 'Save' : 'Create tool', cls: 'primary', run: async (c) => {
        const chk = L.validateToolDraft({ tool_id: f.id.value, name: f.name.value, description: f.desc.value, author: f.author.value }, { editing, existingIds: tools.map((x) => x.tool_id) });
        if (!chk.ok) { msg.textContent = chk.errors.join(' '); msg.hidden = false; return true; }
        if (editing) chk.value.tool_id = t.tool_id;
        const r = await mutate(() => rpc('admin_addon_tools_upsert_tool', L.upsertCall(chk.value)), editing ? 'Tool saved.' : 'Tool created. Next: upload its first release.');
        if (r.ok) { if (!editing) { sel = chk.value.tool_id; dtab = 'releases'; draw(); } c(); } else { msg.textContent = r.text; msg.hidden = false; return true; }
      } }]);
    }

    // ---------------------------------------------------------------- upload + publish (Edge Function)
    function publishDialog(preselect) {
      if (!tools.length) { toast('Create a tool first.', true); return; }
      let working = false; let closeIt = () => {};
      const pick = h('select', { id: 'at-pub-tool' }, h('option', { value: '' }, 'Choose a tool…'), tools.map((t) => h('option', { value: t.tool_id }, t.name + ' (' + t.tool_id + ')')));
      if (preselect && tools.some((t) => t.tool_id === preselect)) pick.value = preselect;
      const file = h('input', { type: 'file', id: 'at-pub-file', accept: '.zip,application/zip' });
      const notes = h('textarea', { id: 'at-pub-notes', maxlength: String(L.LIMITS.notes), placeholder: 'Release notes (optional, max 2000 characters)', style: 'min-height:70px' });
      const fileInfo = h('p', { class: 'hint', id: 'at-pub-fileinfo' });
      const msg = h('p', { class: 'warn', hidden: true }); const out = h('div', { id: 'at-pub-result' });
      const go = btn('Upload release', run, 'primary', { id: 'at-pub-go' });
      const form = h('div', { id: 'at-pub-form' }, h('div', { class: 'field' }, h('label', {}, 'Tool'), pick), h('div', { class: 'field' }, h('label', {}, 'Package (.zip, max 50 MB)'), file, fileInfo),
        h('div', { class: 'field' }, h('label', {}, 'Release notes'), notes), msg, h('div', { class: 'row' }, go),
        note('The server validates the package, signs the release, stores it and registers it. The release is stored but NOT offered to users until you make it current, and nobody sees the tool until you publish it (Overview, Visibility).', 'hint'));
      const body = h('div', {}, form, out);

      file.addEventListener('change', async () => {
        const f = file.files && file.files[0]; fileInfo.textContent = '';
        if (!f) return;
        fileInfo.textContent = f.name + ' · ' + L.fmtBytes(f.size) + ' · computing SHA-256…';
        try { const hex = await L.sha256Hex(await f.arrayBuffer()); if (file.files[0] === f) fileInfo.textContent = f.name + ' · ' + L.fmtBytes(f.size) + ' · SHA-256 ' + hex.slice(0, 16) + '… (reference only: the server computes the signed hash)'; }
        catch (_e) { if (file.files[0] === f) fileInfo.textContent = f.name + ' · ' + L.fmtBytes(f.size); }
      });

      async function run() {
        const chk = L.validatePublishInput({ tool_id: pick.value, file: file.files && file.files[0], notes: notes.value });
        if (!chk.ok) { msg.textContent = chk.errors.join(' '); msg.hidden = false; return; }
        msg.hidden = true; working = true; setBusy(true);
        form.hidden = true; out.replaceChildren(spin('Uploading and validating on the server… large packages can take a minute. Do not close this window.'));
        let resp;
        try { resp = await L.publishEdge(await edgeDeps(), chk.value, file.files[0]); }
        catch (e) { resp = { ok: false, status: 0, body: { ok: false, error: { code: 'unauthenticated', message: e.message } } }; }
        working = false; setBusy(false);
        if (resp.ok) { showSuccess(L.describePublishSuccess(resp), chk.value.tool_id); await reload(); } else { showFailure(L.describeEdgeFailure(resp), chk.value); if (resp.status === 0 || resp.body && resp.body.registration_state === 'uncertain') await reload(); }
      }
      function again() { out.replaceChildren(); form.hidden = false; }

      function showSuccess(s, toolId) {
        const lines = [h('p', { class: 'at-okline' }, '✓ Release ', h('b', {}, s.version), ' of ', h('b', {}, s.tool_id), ' was validated, signed and registered.'),
          h('div', { class: 'at-kvs' }, kv('Version', s.version), kv('Sequence', '#' + s.seq), kv('Files', s.files), kv('Size', L.fmtBytes(s.zip_size)), kv('SHA-256', L.shortHash(s.zip_sha256)), kv('Signed with key', s.key_id)),
          s.metadataKnown ? h('div', { id: 'at-pub-meta' }, h('h4', {}, 'Package metadata'), h('div', { class: 'at-kvs' }, [kv('Author', s.author), ...metaKvs(s.metadata)]),
            note('Read back from the signed release record; nothing here was typed in. The tool\'s catalog author is edited separately on the tool.', 'hint'))
            : note('The publishing service did not report package metadata (an older version of it). Open the Releases tab to see it once the database is updated.', 'hint'),
          s.reconciled ? note(s.note || 'The release is registered (confirmed from the release list).', 'hint') : null,
          s.offered ? note('It is already the current release.') : note('Stored, but NOT offered to users yet. Make it current to offer it' + ' (the tool also has to be published).', 'warn')];
        if (s.warnings.length) lines.push(h('div', { class: 'at-warnbox' }, h('b', {}, `Package warnings (${s.warningCount || s.warnings.length}, advisory only):`), h('ul', {}, s.warnings.map((w) => h('li', {}, w)))));
        else lines.push(note('No package warnings.', 'hint'));
        const makeNow = btn('Make this release current', async () => {
          makeNow.disabled = true;
          const t = tools.find((x) => x.tool_id === toolId); const r = t && t.releases.find((x) => x.version === s.version);
          if (!t || !r) { toast('Reload the list and use the Releases tab.', true); makeNow.disabled = false; return; }
          const k = L.selectKind(t, r);
          if (k.kind !== 'update') { toast(k.kind === 'none' ? k.why : 'This would be a rollback: use the Releases tab.', true); makeNow.disabled = false; return; }
          const c = L.setCurrentCall(t, r, ''); const x = await mutate(() => rpc('admin_addon_tools_set_current_release', c.args), s.version + ' is now current.');
          if (x.ok) { closeIt(); sel = toolId; dtab = 'overview'; draw(); } else makeNow.disabled = false;
        }, 'primary', { id: 'at-pub-makecurrent' });
        out.replaceChildren(...lines, h('div', { class: 'row' }, s.offered ? null : makeNow, btn('Upload another', again), btn('Close', () => closeIt())));
      }
      function showFailure(d, v) {
        const parts = [h('p', { class: 'warn', id: 'at-pub-fail' }, '✗ ' + d.title), d.detail ? note(d.detail) : null];
        if (d.problems.length) parts.push(h('div', { class: 'at-warnbox err' }, h('b', {}, `Validation problems (${d.problemCount}${d.problemCount > d.problems.length ? ', first ' + d.problems.length + ' shown' : ''}):`),
          h('ul', {}, d.problems.map((p) => h('li', {}, (p.path ? p.path + ': ' : '') + p.message)))));
        if (d.warnings.length) parts.push(h('div', { class: 'at-warnbox' }, h('b', {}, 'Warnings:'), h('ul', {}, d.warnings.map((w) => h('li', {}, w)))));
        if (d.uncertain) parts.push(note('Not known whether the release was registered. The list has been reloaded: check the Releases tab before uploading again. Nothing was deleted.', 'warn'));
        const row = [btn('Back', again, 'primary')];
        if (d.orphan && d.canRecover) {
          parts.push(note('The package file was uploaded but is not registered. You can remove that leftover file (only possible when no release uses it).', 'warn'));
          row.push(btn('Remove uploaded file', () => recover(d, v), 'danger', { id: 'at-pub-recover' }));
        }
        row.push(btn('Close', () => closeIt()));
        out.replaceChildren(...parts, h('div', { class: 'row' }, row));
      }
      function recover(d, v) {
        const ver = (d.orphan.path.split('/')[1]) || '';
        modal('Remove the uploaded file?', h('p', {}, `Deletes ${d.orphan.path} from storage. The server refuses if any release uses it. No release or database record is changed.`), [{ label: 'Cancel', run: (c) => c() }, { label: 'Remove file', cls: 'danger', run: async (c) => {
          try {
            const r = await L.edgeJson(await edgeDeps(), L.recoverRequest(v.tool_id, ver));
            if (r.ok) { toast(r.body.result === 'already_missing' ? 'The file was already gone.' : 'Uploaded file removed.'); c(); again(); }
            else { toast(L.describeEdgeFailure(r).title, true); return true; }
          } catch (e) { toast(e.message, true); return true; }
        } }]);
      }
      closeIt = modal('Upload a release', body, [{ label: 'Close', run: (c) => { if (!working) c(); else return true; } }], () => !working);
    }

    // ---------------------------------------------------------------- start
    root.replaceChildren(spin('Loading Addon Tools…'));
    devLoadSummary().then(() => { if (view !== 'developer') draw(); });          // Part 13: the new-request notice (silent when 0038 is missing)
    return reload();
  }

  window.MZ_ADDON_TOOLS_UI = { mount };
})();
