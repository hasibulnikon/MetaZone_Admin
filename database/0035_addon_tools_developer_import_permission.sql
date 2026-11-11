-- 0035 (v1.0.0, 9th Edition, Addon Tools Part 11): DEVELOPER IMPORT PERMISSION (Admin-controlled, per user). Run AFTER 0032 (0033 / 0034 are not required).
-- Forward-only, idempotent, ONE transaction. NOT applied to any database yet and NOT executed against any PostgreSQL (none was available).
-- The identical file lives in MetaZone_App/supabase/migrations/ and MetaZone_Admin/database/.
--
-- WHAT THIS IS.  The permission foundation for a FUTURE "Developer ZIP Import" feature in the Main App: an administrator can switch ONE flag, per
-- user, ON or OFF. It is its own record and has nothing to do with the catalog: it does not grant, hide or change access to any catalog tool (the
-- 0032 access rule, addon_tools_user_access, plan switches and _addon_tools_entitled are untouched), it does not touch the old Add-on System
-- (page_flags, addon_* tables, control_audit), and it gives NO right to publish anything: publishing to the public catalog stays Admin-only
-- (admin_addon_tools_register_release / the Edge function). There is no import workflow, no Settings screen and no app code behind it yet.
--
-- WHAT IT ADDS
--   table    addon_tools_developer_access   one row per user who was EVER switched: (user_id, enabled, updated_at, updated_by). NO row = OFF, so the
--                                           default is OFF for everybody (including every existing and future account) by construction, with
--                                           no backfill. Closed to every client role (RLS on, no policy, no grant): only the RPCs below touch it.
--   internal _addon_tools_developer_import_allowed(user)   the ONE place that answers "may this user use Developer Import" (false when no row).
--                                           No grants: later parts call it from their own security-definer functions.
--   admin    admin_addon_tools_set_developer_import(p_user, p_enabled)   only an admin; one user at a time; audited (action developer_import_set)
--            admin_addon_tools_get_developer_import(p_user_ids)          only an admin; state for up to 50 given users (OFF when no row)
--            admin_addon_tools_list_developer_import()                   only an admin; every user whose permission is currently ON
--   user     addon_tools_my_developer_import()   any signed-in user; returns ONLY the caller's own state {enabled}; nobody else's
--
-- AUDIT.  Changes are written to the existing append-only addon_tools_audit (tool_id NULL, detail = user id + enabled + previous value; never
-- secrets). Only an actual change is logged.

begin;

do $$ begin
  if to_regclass('public.addon_tools_audit') is null or to_regclass('public.profiles') is null
     or to_regprocedure('public._addon_tools_audit(text, text, text, jsonb)') is null
     or to_regprocedure('public._require_admin()') is null or to_regprocedure('public._require_user()') is null then
    raise exception '0035 needs 0032 (Addon Tools database foundation): run the earlier migrations first';
  end if;
end $$;

-- ====================================================================== A. table
create table if not exists public.addon_tools_developer_access (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  enabled    boolean not null default false,                         -- a row never means "on" by itself: read this column
  updated_at timestamptz not null default now(),
  updated_by uuid
);
create index if not exists addon_tools_developer_access_enabled_idx on public.addon_tools_developer_access (updated_at desc) where enabled;

alter table public.addon_tools_developer_access enable row level security;
revoke all on public.addon_tools_developer_access from public, anon, authenticated;     -- no policy + no grant = no direct access at all

-- ====================================================================== B. the one rule (internal)
create or replace function public._addon_tools_developer_import_allowed(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((select d.enabled from public.addon_tools_developer_access d where d.user_id = p_user), false)
$$;

-- ====================================================================== C. admin RPCs (every one calls _require_admin first)
create or replace function public.admin_addon_tools_set_developer_import(p_user uuid, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_was boolean; v_at timestamptz;
begin
  perform public._require_admin();
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  if p_enabled is null then raise exception 'choose ON or OFF'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools_dev_import:' || p_user::text));
  v_was := public._addon_tools_developer_import_allowed(p_user);
  if v_was is distinct from p_enabled or not exists (select 1 from public.addon_tools_developer_access where user_id = p_user) then
    insert into public.addon_tools_developer_access(user_id, enabled, updated_by) values (p_user, p_enabled, auth.uid())
    on conflict (user_id) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
  end if;
  if v_was is distinct from p_enabled then
    perform public._addon_tools_audit('developer_import_set', null, null, jsonb_build_object('user_id', p_user, 'enabled', p_enabled, 'was_enabled', v_was));
  end if;
  select d.updated_at into v_at from public.addon_tools_developer_access d where d.user_id = p_user;
  return jsonb_build_object('user_id', p_user, 'enabled', p_enabled, 'was_enabled', v_was, 'changed', v_was is distinct from p_enabled, 'updated_at', v_at);
end $$;

-- State of the given users (the Admin screen passes the users it just found). Users without a row are reported OFF.
create or replace function public.admin_addon_tools_get_developer_import(p_user_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if p_user_ids is null or coalesce(array_length(p_user_ids, 1), 0) > 50 then raise exception 'ask for at most 50 users at a time'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.id, 'enabled', coalesce(d.enabled, false), 'updated_at', d.updated_at) order by p.id)
      from public.profiles p left join public.addon_tools_developer_access d on d.user_id = p.id
     where p.id = any(p_user_ids)), '[]'::jsonb);
end $$;

-- Everybody who currently has it ON (small by nature: it is granted one person at a time).
create or replace function public.admin_addon_tools_list_developer_import() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.id, 'email', p.email, 'enabled', true, 'updated_at', d.updated_at) order by d.updated_at desc, p.id)
      from public.addon_tools_developer_access d join public.profiles p on p.id = d.user_id
     where d.enabled), '[]'::jsonb);
end $$;

-- ====================================================================== D. user RPC (own state only)
create or replace function public.addon_tools_my_developer_import() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user();
begin
  return jsonb_build_object('enabled', public._addon_tools_developer_import_allowed(uid));
end $$;

-- ====================================================================== E. privileges
-- New functions start with PUBLIC execute: strip it, then grant back only the intended surface (admin_* refuse non-admins inside).
revoke all on function
  public._addon_tools_developer_import_allowed(uuid),
  public.admin_addon_tools_set_developer_import(uuid, boolean),
  public.admin_addon_tools_get_developer_import(uuid[]),
  public.admin_addon_tools_list_developer_import(),
  public.addon_tools_my_developer_import()
  from public, anon, authenticated;
grant execute on function
  public.admin_addon_tools_set_developer_import(uuid, boolean),
  public.admin_addon_tools_get_developer_import(uuid[]),
  public.admin_addon_tools_list_developer_import(),
  public.addon_tools_my_developer_import()
  to authenticated;

commit;
