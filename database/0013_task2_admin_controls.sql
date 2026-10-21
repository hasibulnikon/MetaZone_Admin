-- 0013 (Split Project Task 2; app version stays v0.9.9.10): admin-controlled page ON/OFF hardening, explicit active add-on version,
-- change audit. Run AFTER 0001..0012. Additive and idempotent: re-running changes nothing an admin chose (switches, selections,
-- published releases); functions / triggers / policies are re-created. It never edits an earlier migration.
--
-- WHAT THIS FILE CHANGES (and what it deliberately does not)
--
-- A. PAGE CONTROL
--    * Home ('dashboard') and Settings ('appearance' + its API-manager section 'settings') are PROTECTED at the database level:
--      a trigger on page_flags refuses to delete them, to un-lock them or to switch any of their three switches off, and a trigger on
--      user_page_overrides refuses a per-user OFF for them. The RPCs already refused this (0006/0011); now a direct UPDATE / bulk
--      UPDATE / DELETE / INSERT is refused too (only a role that disables triggers, i.e. the database owner, could bypass it).
--    * PRECEDENCE CHANGE (deliberate, requested by the Task 2 specification).  _page_enabled() used to let a per-user ON beat the
--      global OFF ("beta tester" use).  Now:   protected page -> ON;   global master switch OFF -> OFF for everybody (a per-user
--      ON can NOT revive it);   else the per-user override;   else the plan (Free / Premium) switch.
--      A per-user OFF still only affects that user. "Give Tracker to one Free user" keeps working: that is a per-user ON against a
--      PLAN switch, not against the master switch. To run a beta: leave the master ON, switch the plan switches OFF, force ON per user.
--    * who / when: page_flags.updated_by, and a small audit table (control_audit) written by every admin change below.
-- B. ACTIVE ADD-ON VERSION
--    * New table addon_active_release: the admin's explicit, server-authoritative choice per add-on.
--        mode 'pinned'    -> exactly active_version is offered (even if a higher seq exists and is not yanked)
--        mode 'auto'      -> the admin explicitly chose "newest eligible release" (the pre-0013 behaviour)
--        mode 'withdrawn' -> the active release was yanked: NOTHING is offered until the admin selects again (no silent substitute)
--        no row           -> nothing selected yet: nothing is offered
--      Migration seeding keeps today's behaviour for every add-on that already has releases (pinned to its current newest eligible one).
--      admin_publish_addon pins the FIRST release of an add-on automatically; later releases are published but NOT active until the
--      admin selects them. Restoring (un-yanking) a release never activates it.
--    * addon_catalog() follows the selection and now also returns 'selection', 'revision', 'available', 'reason' and 'revoked' (the list
--      of withdrawn versions) so a client can tell "nothing to offer" from "not published" and can disable a revoked installed version.
--    * mz_addon_object_allowed() (Storage policy) follows the same rule: a pinned add-on can only download its pinned release.
-- Not changed: signatures / SHA-256 / seq immutability of published releases, Free/Premium switches, per-user overrides, reserve_generations.

-- ====================================================================== audit
create table if not exists public.control_audit (
  id          bigserial primary key,
  at          timestamptz not null default now(),
  actor       uuid,
  actor_email text,
  action      text not null,
  target      text not null,
  detail      jsonb not null default '{}'::jsonb      -- keys, versions, booleans only: never secrets
);
alter table public.control_audit enable row level security;
revoke all on public.control_audit from public, anon, authenticated;
revoke all on sequence public.control_audit_id_seq from public, anon, authenticated;

create or replace function public._audit(p_action text, p_target text, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.control_audit(actor, actor_email, action, target, detail)
  values (auth.uid(), (select p.email from public.profiles p where p.id = auth.uid()), p_action, p_target, coalesce(p_detail, '{}'::jsonb));
  delete from public.control_audit where id < (select max(id) from public.control_audit) - 5000;     -- bounded: keep the last ~5000 rows
end $$;

create or replace function public.admin_list_control_audit(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor_email', a.actor_email, 'action', a.action,
                                                      'target', a.target, 'detail', a.detail) order by a.id desc)
                     from (select * from public.control_audit order by id desc limit least(greatest(coalesce(p_limit, 50), 1), 500)) a),
                  '[]'::jsonb);
end $$;

-- ====================================================================== A. protected pages
alter table public.page_flags add column if not exists updated_by uuid;

-- Home = 'dashboard'; Settings = 'appearance' and its API-manager section 'settings'. Anything flagged locked is protected too.
create or replace function public._page_protected(p_key text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(p_key in ('dashboard', 'appearance', 'settings'), false)
      or coalesce((select f.locked from public.page_flags f where f.page_key = p_key), false)
$$;

create or replace function public._guard_protected_page() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    if old.page_key in ('dashboard', 'appearance', 'settings') or old.locked then
      raise exception 'This page cannot be removed (Home and Settings are protected).' using errcode = '23514';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' and (old.page_key in ('dashboard', 'appearance', 'settings') or old.locked) then
    if new.page_key <> old.page_key then
      raise exception 'A protected page cannot be renamed.' using errcode = '23514';
    end if;
    if not (new.locked and new.enabled and new.enabled_free and new.enabled_premium) then
      raise exception 'This page cannot be switched off (Home and Settings are protected).' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'INSERT' and new.page_key in ('dashboard', 'appearance', 'settings')
     and not (new.locked and new.enabled and new.enabled_free and new.enabled_premium) then
    raise exception 'This page cannot be switched off (Home and Settings are protected).' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists mz_guard_protected_page on public.page_flags;
create trigger mz_guard_protected_page before insert or update or delete on public.page_flags
  for each row execute function public._guard_protected_page();

create or replace function public._guard_protected_override() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if not new.enabled and public._page_protected(new.page_key) then
    raise exception 'This page cannot be switched off (Home and Settings are protected).' using errcode = '23514';
  end if;
  return new;
end $$;

drop trigger if exists mz_guard_protected_override on public.user_page_overrides;
create trigger mz_guard_protected_override before insert or update on public.user_page_overrides
  for each row execute function public._guard_protected_override();

-- Clean up any OFF override that was written for a protected page by hand before this migration (they were already ignored).
delete from public.user_page_overrides o where not o.enabled and public._page_protected(o.page_key);

-- ---- the one place the rule lives (see header: GLOBAL OFF now beats a per-user ON)
create or replace function public._page_enabled(p_user uuid, p_page text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case
              when public._page_protected(f.page_key) then true                       -- Home / Settings: always on
              when not f.enabled then false                                           -- master switch OFF: off for everybody
              else coalesce(
                     (select o.enabled from public.user_page_overrides o where o.user_id = p_user and o.page_key = f.page_key),
                     case when public.mz_plan(p_user) = 'premium' then f.enabled_premium else f.enabled_free end)
            end
       from public.page_flags f where f.page_key = p_page),
    true)
$$;

-- ---- admin API: same signatures as before, plus protection by name, who/when and audit
create or replace function public.admin_set_page_enabled(p_key text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  select * into f from public.page_flags where page_key = p_key;
  if not found then raise exception 'unknown page'; end if;
  if public._page_protected(p_key) and not coalesce(p_enabled, true) then
    raise exception 'This page cannot be switched off.';
  end if;
  update public.page_flags set enabled = coalesce(p_enabled, true), updated_at = now(), updated_by = auth.uid() where page_key = p_key;
  perform public._audit('page_master', p_key, jsonb_build_object('enabled', coalesce(p_enabled, true)));
  return (select to_jsonb(x) from public.page_flags x where x.page_key = p_key);
end $$;

create or replace function public.admin_set_page_plan_access(p_key text, p_free boolean default null, p_premium boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  select * into f from public.page_flags where page_key = p_key;
  if not found then raise exception 'unknown page'; end if;
  if public._page_protected(p_key) and (p_free is false or p_premium is false) then
    raise exception 'This page cannot be switched off.';
  end if;
  update public.page_flags
     set enabled_free = coalesce(p_free, enabled_free), enabled_premium = coalesce(p_premium, enabled_premium),
         updated_at = now(), updated_by = auth.uid()
   where page_key = p_key;
  perform public._audit('page_plan', p_key, jsonb_build_object('free', p_free, 'premium', p_premium));
  return (select to_jsonb(x) from public.page_flags x where x.page_key = p_key);
end $$;

create or replace function public.admin_set_user_page(p_user uuid, p_key text, p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  select * into f from public.page_flags where page_key = p_key;
  if not found then raise exception 'unknown page'; end if;
  if public._page_protected(p_key) then raise exception 'This page cannot be switched off.'; end if;
  if p_enabled is null then
    delete from public.user_page_overrides where user_id = p_user and page_key = p_key;
  else
    insert into public.user_page_overrides(user_id, page_key, enabled) values (p_user, p_key, p_enabled)
    on conflict (user_id, page_key) do update set enabled = excluded.enabled, updated_at = now();
  end if;
  perform public._audit('page_user', p_key, jsonb_build_object('user', p_user, 'enabled', p_enabled));
  return public.admin_get_user_pages(p_user);
end $$;

create or replace function public.admin_reset_user_pages(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  delete from public.user_page_overrides where user_id = p_user;
  perform public._audit('page_user_reset', 'all', jsonb_build_object('user', p_user));
  return public.admin_get_user_pages(p_user);
end $$;

create or replace function public.admin_list_pages() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'kind', f.kind, 'enabled', f.enabled, 'locked', f.locked,
            'protected', public._page_protected(f.page_key),
            'enabled_free', f.enabled_free, 'enabled_premium', f.enabled_premium,
            'updated_at', f.updated_at, 'updated_by_email', (select p.email from public.profiles p where p.id = f.updated_by),
            'overrides_on',  (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and o.enabled),
            'overrides_off', (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and not o.enabled))
          order by f.sort_order, f.page_key) from public.page_flags f where f.page_key <> 'settings'), '[]'::jsonb);
end $$;

create or replace function public.admin_get_user_pages(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_plan text;
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  v_plan := public.mz_plan(p_user);
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'kind', f.kind, 'locked', f.locked, 'protected', public._page_protected(f.page_key),
            'global_enabled', f.enabled, 'plan', v_plan,
            'plan_enabled', f.enabled and case when v_plan = 'premium' then f.enabled_premium else f.enabled_free end,
            'override', (select o.enabled from public.user_page_overrides o where o.user_id = p_user and o.page_key = f.page_key),
            'effective', public._page_enabled(p_user, f.page_key))
          order by f.sort_order, f.page_key) from public.page_flags f where f.page_key <> 'settings'), '[]'::jsonb);
end $$;

-- ====================================================================== B. explicit active version
create table if not exists public.addon_active_release (
  addon_id         text primary key check (addon_id ~ '^[a-z0-9_]{1,32}$'),
  mode             text not null default 'pinned' check (mode in ('pinned', 'auto', 'withdrawn')),
  active_version   text,
  previous_version text,                                   -- the selection that was replaced / withdrawn: "restore previous"
  revision         bigint not null default 1,              -- optimistic concurrency: bumped on every change
  updated_by       uuid,
  updated_at       timestamptz not null default now(),
  constraint addon_active_pinned_has_version check ((mode = 'pinned') = (active_version is not null)),
  foreign key (addon_id, active_version)   references public.addon_releases(addon_id, version),
  foreign key (addon_id, previous_version) references public.addon_releases(addon_id, version)
);
alter table public.addon_active_release enable row level security;
revoke all on public.addon_active_release from public, anon, authenticated;

-- NULL = this release may be made active. Otherwise the plain-language reason it may not (shown in the Admin panel).
-- Compatibility: the release must support at least one ACTIVE app version (when any app version is registered).
create or replace function public._addon_block_reason(p_addon text, p_version text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.addon_releases;
begin
  select * into r from public.addon_releases where addon_id = p_addon and version = p_version;
  if not found then return 'this release does not exist'; end if;
  if r.yanked then return 'this release is yanked: restore it first (restoring does not activate it)'; end if;
  if r.channel <> 'stable' then return 'only releases on the stable channel can be active'; end if;
  if r.sha256 is null or r.size_bytes is null or r.storage_path is null then return 'the release record is incomplete (no hash, size or package)'; end if;
  if not exists (select 1 from public.page_flags where page_key = r.feature_key) then return 'its feature switch no longer exists'; end if;
  -- only app versions whose number can be parsed take part (a placeholder row such as 'v' can neither support nor refute anything)
  if exists (select 1 from public.app_versions where is_active and public._mz_ver(version) is not null)
     and not exists (select 1 from public.app_versions v
                      where v.is_active and public._mz_ver(v.version) is not null
                        and (r.min_core is null or public._mz_ver(r.min_core) is null or public._mz_ver(r.min_core) <= public._mz_ver(v.version))
                        and (r.max_core is null or public._mz_ver(r.max_core) is null or public._mz_ver(r.max_core) >= public._mz_ver(v.version))) then
    return 'it does not support any app version that is currently active';
  end if;
  return null;
end $$;

-- The version a client of an ordinary current core would be offered (ignores a single client's own core range).
create or replace function public._addon_effective_version(p_addon text) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.addon_active_release; v text;
begin
  select * into s from public.addon_active_release where addon_id = p_addon;
  if not found or s.mode = 'withdrawn' then return null; end if;
  if s.mode = 'pinned' then
    return case when public._addon_block_reason(p_addon, s.active_version) is null then s.active_version end;
  end if;
  select x.version into v from public.addon_releases x
   where x.addon_id = p_addon and public._addon_block_reason(x.addon_id, x.version) is null
   order by x.seq desc limit 1;
  return v;
end $$;

create or replace function public._set_addon_selection(p_addon text, p_mode text, p_version text, p_expected bigint, p_action text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.addon_active_release; reason text; prev text; n public.addon_active_release;
begin
  if p_addon is null or p_addon !~ '^[a-z0-9_]{1,32}$' or not exists (select 1 from public.addon_releases where addon_id = p_addon) then
    raise exception 'unknown add-on';
  end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || p_addon));              -- same lock as publish / yank
  select * into s from public.addon_active_release where addon_id = p_addon for update;
  if p_expected is not null and p_expected is distinct from coalesce(s.revision, 0) then
    raise exception 'stale: the selection for % was changed by someone else (now revision %). Reload the page and try again.',
      p_addon, coalesce(s.revision, 0);
  end if;
  if p_mode = 'pinned' then
    reason := public._addon_block_reason(p_addon, p_version);
    if reason is not null then raise exception 'cannot activate % %: %', p_addon, coalesce(p_version, '(none)'), reason; end if;
  elsif p_mode = 'auto' then
    if not exists (select 1 from public.addon_releases x where x.addon_id = p_addon and public._addon_block_reason(x.addon_id, x.version) is null) then
      raise exception 'cannot switch % to automatic: no eligible release exists', p_addon;
    end if;
  else
    raise exception 'invalid selection mode';
  end if;
  prev := case when s.active_version is not null and s.active_version is distinct from p_version then s.active_version else s.previous_version end;
  if s.addon_id is null then
    insert into public.addon_active_release(addon_id, mode, active_version, previous_version, revision, updated_by)
    values (p_addon, p_mode, p_version, null, 1, auth.uid()) returning * into n;
  else
    update public.addon_active_release
       set mode = p_mode, active_version = p_version, previous_version = prev, revision = revision + 1, updated_by = auth.uid(), updated_at = now()
     where addon_id = p_addon returning * into n;
  end if;
  perform public._audit(p_action, p_addon, jsonb_build_object('mode', p_mode, 'version', p_version, 'from_mode', s.mode,
                                                              'from_version', s.active_version, 'revision', n.revision));
  return to_jsonb(n);
end $$;

create or replace function public.admin_set_addon_active(p_addon text, p_version text, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return public._set_addon_selection(p_addon, 'pinned', p_version, p_expected_revision, 'addon_active_set');
end $$;

create or replace function public.admin_clear_addon_active(p_addon text, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return public._set_addon_selection(p_addon, 'auto', null, p_expected_revision, 'addon_active_auto');
end $$;

create or replace function public.admin_restore_previous_addon_active(p_addon text, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare prev text;
begin
  perform public._require_admin();
  select previous_version into prev from public.addon_active_release where addon_id = p_addon;
  if prev is null then raise exception 'there is no previous selection to restore for %', coalesce(p_addon, '(none)'); end if;
  return public._set_addon_selection(p_addon, 'pinned', prev, p_expected_revision, 'addon_active_restore_previous');
end $$;

create or replace function public.admin_get_addon_selection() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'addon_id', i.addon_id, 'title', i.title, 'feature_key', i.fkey,
             'mode', coalesce(s.mode, 'none'), 'active_version', s.active_version, 'previous_version', s.previous_version,
             'revision', coalesce(s.revision, 0), 'updated_at', s.updated_at,
             'updated_by_email', (select p.email from public.profiles p where p.id = s.updated_by),
             'effective_version', public._addon_effective_version(i.addon_id),
             'previous_block_reason', case when s.previous_version is not null then public._addon_block_reason(i.addon_id, s.previous_version) end)
           order by i.addon_id)
      from (select addon_id, (array_agg(feature_key order by seq desc))[1] as fkey, (array_agg(title order by seq desc))[1] as title
              from public.addon_releases group by addon_id) i
      left join public.addon_active_release s on s.addon_id = i.addon_id), '[]'::jsonb);
end $$;

-- Releases list: same keys as 0012 plus is_active / selectable / block_reason.
create or replace function public.admin_list_addon_releases() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'addon_id', r.addon_id, 'version', r.version, 'seq', r.seq, 'channel', r.channel, 'feature_key', r.feature_key,
             'title', r.title, 'summary', r.summary, 'size', r.size_bytes, 'sha256', r.sha256, 'storage_path', r.storage_path,
             'notes', r.notes, 'min_core', r.min_core, 'max_core', r.max_core,
             'published_at', r.published_at, 'published_by', r.published_by, 'yanked', r.yanked,
             'is_active', coalesce(r.version = public._addon_effective_version(r.addon_id), false),
             'block_reason', public._addon_block_reason(r.addon_id, r.version),
             'selectable', (public._addon_block_reason(r.addon_id, r.version) is null))
           order by r.published_at desc, r.seq desc, r.addon_id)
      from public.addon_releases r), '[]'::jsonb);
end $$;

-- ---- yank / restore: yanking the ACTIVE release withdraws the selection (no silent substitute); restoring never activates anything.
create or replace function public.admin_yank_addon(p_addon text, p_version text, p_yank boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.addon_releases; was_active boolean := false; s public.addon_active_release; eff text;
begin
  perform public._require_admin();
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || coalesce(p_addon, '')));
  eff := public._addon_effective_version(p_addon);                         -- what clients are being offered right now
  update public.addon_releases set yanked = coalesce(p_yank, true)
   where addon_id = p_addon and version = p_version returning * into r;
  if not found then raise exception 'unknown release'; end if;
  if coalesce(p_yank, true) and eff is not distinct from p_version then
    select * into s from public.addon_active_release where addon_id = p_addon for update;
    if found then
      update public.addon_active_release
         set mode = 'withdrawn', active_version = null, previous_version = p_version, revision = revision + 1,
             updated_by = auth.uid(), updated_at = now()
       where addon_id = p_addon;
      was_active := true;
    end if;
  end if;
  perform public._audit(case when coalesce(p_yank, true) then 'addon_yank' else 'addon_restore' end, p_addon,
                        jsonb_build_object('version', p_version, 'was_active', was_active));
  return to_jsonb(r) || jsonb_build_object('was_active', was_active, 'selection_withdrawn', was_active);
end $$;

-- ---- catalogue: ONE row per add-on that has any release; follows the admin's selection.
-- selection: pinned | auto | withdrawn | none.  available=false -> version/size/sha256/storage_path are null and 'reason' says why.
-- 'revoked' = every yanked version of this add-on: a client must not keep running / recover to one of them.
create or replace function public.addon_catalog(p_core text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); core integer[];
begin
  if p_core is not null and btrim(p_core) <> '' then
    core := public._mz_ver(p_core);
    if core is null then raise exception 'invalid core version'; end if;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'addon_id', a.addon_id, 'selection', a.mode, 'revision', a.revision,
             'available', (a.rj is not null),
             'reason', case when a.rj is not null then null
                            when a.mode = 'withdrawn' then 'the active release was withdrawn by the administrator'
                            when a.mode = 'none'      then 'the administrator has not selected a version yet'
                            when a.mode = 'pinned'    then 'the selected release is not available for this app version'
                            else 'no release is available for this app version' end,
             'version', a.rj->'version', 'seq', a.rj->'seq', 'channel', a.rj->'channel',
             'size', a.rj->'size_bytes', 'sha256', a.rj->'sha256', 'storage_path', a.rj->'storage_path',
             'feature_key', coalesce(a.rj->>'feature_key', a.fkey), 'title', coalesce(a.rj->>'title', a.title),
             'summary', a.rj->'summary', 'notes', coalesce(a.rj->'notes', '{}'::jsonb),
             'min_core', a.rj->'min_core', 'max_core', a.rj->'max_core', 'published_at', a.rj->'published_at',
             'entitled', public._page_enabled(uid, coalesce(a.rj->>'feature_key', a.fkey)),
             'revoked', a.revoked)
           order by a.addon_id)
      from (select i.addon_id, i.fkey, i.title, i.revoked, coalesce(s.mode, 'none') as mode, coalesce(s.revision, 0) as revision, r.rj
              from (select x.addon_id,
                           (array_agg(x.feature_key order by x.seq desc))[1] as fkey,
                           (array_agg(x.title order by x.seq desc))[1] as title,
                           coalesce(jsonb_agg(x.version order by x.seq) filter (where x.yanked), '[]'::jsonb) as revoked
                      from public.addon_releases x group by x.addon_id) i
              left join public.addon_active_release s on s.addon_id = i.addon_id
              left join lateral (
                select to_jsonb(x) as rj from public.addon_releases x
                 where x.addon_id = i.addon_id and not x.yanked and x.channel = 'stable'
                   and s.addon_id is not null and s.mode <> 'withdrawn'
                   and (s.mode <> 'pinned' or x.version = s.active_version)
                   and (core is null or x.min_core is null or public._mz_ver(x.min_core) is null or public._mz_ver(x.min_core) <= core)
                   and (core is null or x.max_core is null or public._mz_ver(x.max_core) is null or public._mz_ver(x.max_core) >= core)
                 order by x.seq desc limit 1) r on true) a), '[]'::jsonb);
end $$;

-- ---- Storage policy: users may only download what the selection offers (admins: everything).
create or replace function public.mz_addon_object_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_name is not null and (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    or exists (select 1 from public.addon_releases r
                where r.addon_id = split_part(p_name, '/', 1) and r.version = split_part(p_name, '/', 2)
                  and r.storage_path = p_name and not r.yanked
                  and public._page_enabled(auth.uid(), r.feature_key)
                  and exists (select 1 from public.addon_active_release s
                               where s.addon_id = r.addon_id
                                 and ((s.mode = 'pinned' and s.active_version = r.version) or s.mode = 'auto'))))
$$;

-- ---- publish: identical to 0012 except that the FIRST release of an add-on is pinned automatically (later ones are NOT activated).
create or replace function public.admin_publish_addon(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id text; v_ver text; v_seq int; v_chan text; v_size bigint; v_sha text; v_key text; v_title text; v_sum text;
  v_min text; v_max text; v_notes jsonb; v_path text; v_max_seq int; k text; el jsonb; v_obj jsonb; r public.addon_releases;
begin
  perform public._require_admin();
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'release must be a JSON object'; end if;

  v_id := p->>'addon_id';
  if v_id is null or v_id !~ '^[a-z0-9_]{1,32}$' then raise exception 'invalid addon_id (a-z, 0-9, underscore, max 32)'; end if;
  v_ver := p->>'version';
  if v_ver is null or v_ver !~ '^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]{1,24})?$' then raise exception 'invalid version'; end if;
  if coalesce(jsonb_typeof(p->'seq'), '') <> 'number' or (p->>'seq') !~ '^[0-9]{1,9}$' or (p->>'seq')::bigint < 1 or (p->>'seq')::bigint > 2000000000 then
    raise exception 'invalid seq (whole number >= 1)';
  end if;
  v_seq := (p->>'seq')::int;
  v_chan := coalesce(nullif(p->>'channel', ''), 'stable');
  if v_chan !~ '^[a-z0-9_]{1,16}$' then raise exception 'invalid channel'; end if;
  if coalesce(jsonb_typeof(p->'size'), '') <> 'number' or (p->>'size') !~ '^[0-9]{1,15}$' or (p->>'size')::bigint < 1 then raise exception 'invalid size (bytes > 0)'; end if;
  v_size := (p->>'size')::bigint;
  v_sha := lower(coalesce(p->>'sha256', ''));
  if v_sha !~ '^[0-9a-f]{64}$' then raise exception 'invalid sha256 (64 hex characters)'; end if;
  v_key := p->>'feature_key';
  if v_key is null or not exists (select 1 from public.page_flags where page_key = v_key) then raise exception 'unknown feature_key'; end if;
  v_title := btrim(coalesce(p->>'title', ''));
  if v_title = '' or length(v_title) > 80 then raise exception 'title is required (max 80 characters)'; end if;
  v_sum := btrim(coalesce(p->>'summary', ''));
  if length(v_sum) > 400 then raise exception 'summary too long (max 400 characters)'; end if;
  v_min := nullif(btrim(coalesce(p->>'min_core', '')), '');
  v_max := nullif(btrim(coalesce(p->>'max_core', '')), '');
  if v_min is not null and public._mz_ver(v_min) is null then raise exception 'invalid min_core'; end if;
  if v_max is not null and public._mz_ver(v_max) is null then raise exception 'invalid max_core'; end if;
  if v_min is not null and v_max is not null and public._mz_ver(v_min) > public._mz_ver(v_max) then raise exception 'min_core is newer than max_core'; end if;

  v_notes := case when jsonb_typeof(p->'notes') is null or jsonb_typeof(p->'notes') = 'null' then '{}'::jsonb else p->'notes' end;
  if jsonb_typeof(v_notes) <> 'object' then raise exception 'notes must be an object'; end if;
  for k in select jsonb_object_keys(v_notes) loop
    if k not in ('pages', 'problems', 'fixes') then raise exception 'unknown notes section: %', k; end if;
    if jsonb_typeof(v_notes->k) <> 'array' or jsonb_array_length(v_notes->k) > 50 then raise exception 'notes.% must be a list (max 50 lines)', k; end if;
    for el in select * from jsonb_array_elements(v_notes->k) loop
      if jsonb_typeof(el) <> 'string' or length(el #>> '{}') > 400 then raise exception 'notes.% lines must be text (max 400 characters)', k; end if;
    end loop;
  end loop;

  v_path := v_id || '/' || v_ver || '/' || v_id || '-' || v_ver || '.mzaddon';
  if p ? 'storage_path' and p->>'storage_path' is distinct from v_path then
    raise exception 'storage_path must be %', v_path;
  end if;

  perform pg_advisory_xact_lock(hashtext('mz_addon:' || v_id));            -- two admins publishing the same add-on at once
  if exists (select 1 from public.addon_releases where addon_id = v_id and version = v_ver) then
    raise exception 'version % of % is already published (published releases are immutable; publish a new version)', v_ver, v_id;
  end if;
  select max(seq) into v_max_seq from public.addon_releases where addon_id = v_id;
  if v_max_seq is not null and v_seq <= v_max_seq then
    raise exception 'seq must be greater than the highest published seq (%) for %', v_max_seq, v_id;
  end if;

  if to_regclass('storage.objects') is not null then
    execute 'select to_jsonb(o) from storage.objects o where o.bucket_id = $1 and o.name = $2 limit 1' into v_obj using 'addons', v_path;
    if v_obj is null then raise exception 'package not found in Storage at %: upload it first', v_path; end if;
    if coalesce(v_obj #>> '{metadata,size}', '') ~ '^[0-9]+$' and (v_obj #>> '{metadata,size}')::bigint <> v_size then
      raise exception 'size in Storage (%) differs from the release size (%)', v_obj #>> '{metadata,size}', v_size;
    end if;
  end if;

  insert into public.addon_releases(addon_id, version, seq, channel, feature_key, title, summary, size_bytes, sha256, storage_path,
                                    notes, min_core, max_core, published_by)
  values (v_id, v_ver, v_seq, v_chan, v_key, v_title, v_sum, v_size, v_sha, v_path, v_notes, v_min, v_max, auth.uid())
  returning * into r;

  -- the very first release of an add-on has nothing to compete with: it is the selection. Later releases never change the selection.
  if v_max_seq is null and v_chan = 'stable' and not exists (select 1 from public.addon_active_release where addon_id = v_id) then
    insert into public.addon_active_release(addon_id, mode, active_version, updated_by) values (v_id, 'pinned', v_ver, auth.uid());
  end if;
  perform public._audit('addon_publish', v_id, jsonb_build_object('version', v_ver, 'seq', v_seq, 'channel', v_chan));
  return to_jsonb(r);
end $$;

-- ---- seed: keep today's behaviour for add-ons that already have releases (idempotent: only add-ons without a row)
insert into public.addon_active_release(addon_id, mode, active_version)
select i.addon_id,
       case when n.version is null then 'withdrawn' else 'pinned' end,
       n.version
  from (select distinct addon_id from public.addon_releases) i
  left join lateral (select x.version from public.addon_releases x
                      where x.addon_id = i.addon_id and not x.yanked and x.channel = 'stable'
                      order by x.seq desc limit 1) n on true
 where not exists (select 1 from public.addon_active_release s where s.addon_id = i.addon_id);

-- ====================================================================== privileges
revoke all on function public._audit(text, text, jsonb) from public, anon, authenticated;
revoke all on function public.admin_list_control_audit(integer) from public, anon, authenticated;
revoke all on function public._page_protected(text) from public, anon, authenticated;
revoke all on function public._guard_protected_page() from public, anon, authenticated;
revoke all on function public._guard_protected_override() from public, anon, authenticated;
revoke all on function public._addon_block_reason(text, text) from public, anon, authenticated;
revoke all on function public._addon_effective_version(text) from public, anon, authenticated;
revoke all on function public._set_addon_selection(text, text, text, bigint, text) from public, anon, authenticated;
revoke all on function public.admin_set_addon_active(text, text, bigint) from public, anon, authenticated;
revoke all on function public.admin_clear_addon_active(text, bigint) from public, anon, authenticated;
revoke all on function public.admin_restore_previous_addon_active(text, bigint) from public, anon, authenticated;
revoke all on function public.admin_get_addon_selection() from public, anon, authenticated;

grant execute on function
  public.admin_list_control_audit(integer),
  public.admin_set_addon_active(text, text, bigint),
  public.admin_clear_addon_active(text, bigint),
  public.admin_restore_previous_addon_active(text, bigint),
  public.admin_get_addon_selection()
  to authenticated;
-- The underscore helpers stay ungranted. Redefined functions (_page_enabled, admin_set_*, admin_list_*, admin_get_user_pages, admin_yank_addon,
-- admin_publish_addon, addon_catalog, mz_addon_object_allowed) keep the grants they already had (create or replace preserves ACLs).
