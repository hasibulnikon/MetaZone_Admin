-- 0036 (v1.0.0, 9th Edition, Addon Tools V5 Part 11): DEVELOPER OPTIONS ACCESS CONTROLS. Run AFTER 0035 (needs 0032 + 0035).
-- Forward-only, idempotent, ONE transaction. NOT applied to any database yet and NOT executed against any PostgreSQL (none was available).
-- The identical file lives in MetaZone_App/supabase/migrations/ and MetaZone_Admin/database/.
--
-- WHAT IS REUSED (0035, unchanged in meaning): table addon_tools_developer_access (per-user row), the single rule function
-- _addon_tools_developer_import_allowed(user), admin_addon_tools_set/get/list_developer_import, and the user RPC addon_tools_my_developer_import()
-- that the Main App already calls. The app is NOT changed: it still asks the server and still only reads {enabled}.
--
-- THE GAP THIS CLOSES. 0035 has only the per-user row. Missing: (1) a GLOBAL on/off, (2) Free / Premium availability, (3) a way to remove a
-- per-user decision (0035 can only write ON or OFF), (4) a server-side reason so the Admin screen shows WHY a user is allowed or not.
--
-- WHAT IT ADDS
--   table    addon_tools_developer_settings   ONE row (id = true): enabled (global), allow_free, allow_premium, updated_at, updated_by.
--                                             Closed to every client role (RLS on, no policy, no grant). Seeded with ALL OFF (fail closed).
--   internal _addon_tools_developer_import_reason(user)   the ONE rule, as a reason code. _addon_tools_developer_import_allowed(user) (0035's
--                                             function, same signature) is now defined from it, so everything that already calls it follows.
--   admin    admin_addon_tools_get_developer_settings(), admin_addon_tools_set_developer_settings(enabled, allow_free, allow_premium)
--   changed  admin_addon_tools_set_developer_import(user, enabled)   NULL now REMOVES the personal decision (the plan switch decides again)
--            admin_addon_tools_get_developer_import(user_ids)         also returns override, reason, plan
--            admin_addon_tools_list_developer_import()                lists every user with a personal decision (ON or OFF), not only ON
--
-- THE RULE (one place).   reason:
--   'global_off'   the global switch is OFF                      -> NOT allowed, whatever the user's own row or plan says (a personal ON cannot bypass it)
--   'override_on'  global ON and the user's own row is ON        -> allowed
--   'override_off' global ON and the user's own row is OFF       -> NOT allowed (beats the plan switch, same precedence as catalog access)
--   'plan_on'      global ON, no own row, plan switch ON         -> allowed   (plan = mz_plan(user): 'premium' uses allow_premium, otherwise allow_free)
--   'plan_off'     global ON, no own row, plan switch OFF        -> NOT allowed
-- No row in addon_tools_developer_access = no personal decision. Existing rows keep their value: a 0035 row with enabled = true is a personal ON,
-- with enabled = false a personal OFF. Because the global switch is seeded OFF, nobody is allowed after this migration until an admin turns the
-- global switch ON (0035 was never applied to a database, so no live user changes). It grants no catalog access and no publishing right.

begin;

do $$ begin
  if to_regclass('public.addon_tools_developer_access') is null
     or to_regprocedure('public._addon_tools_developer_import_allowed(uuid)') is null
     or to_regprocedure('public._addon_tools_audit(text, text, text, jsonb)') is null
     or to_regprocedure('public.mz_plan(uuid)') is null then
    raise exception '0036 needs 0035 (Developer Import permission) and 0032: run the earlier migrations first';
  end if;
end $$;

-- ====================================================================== A. settings (one row)
create table if not exists public.addon_tools_developer_settings (
  id            boolean primary key default true check (id),            -- exactly one row can exist
  enabled       boolean not null default false,                         -- GLOBAL switch: OFF = nobody
  allow_free    boolean not null default false,                         -- Free accounts (no personal decision)
  allow_premium boolean not null default false,                         -- Premium accounts (no personal decision)
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);
insert into public.addon_tools_developer_settings (id) values (true) on conflict (id) do nothing;
alter table public.addon_tools_developer_settings enable row level security;
revoke all on public.addon_tools_developer_settings from public, anon, authenticated;

-- ====================================================================== B. the one rule
create or replace function public._addon_tools_developer_import_reason(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select case
    when p_user is null or s.id is null or s.enabled is not true then 'global_off'
    when d.user_id is not null and d.enabled then 'override_on'
    when d.user_id is not null then 'override_off'
    when public.mz_plan(p_user) = 'premium' then case when s.allow_premium then 'plan_on' else 'plan_off' end
    else case when s.allow_free then 'plan_on' else 'plan_off' end
  end
  from (select 1) x
  left join public.addon_tools_developer_settings s on s.id
  left join public.addon_tools_developer_access d on d.user_id = p_user
$$;

create or replace function public._addon_tools_developer_import_allowed(p_user uuid) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select public._addon_tools_developer_import_reason(p_user) in ('override_on', 'plan_on')
$$;

-- ====================================================================== C. admin: global + plan switches
create or replace function public.admin_addon_tools_get_developer_settings() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare s public.addon_tools_developer_settings; v_email text;
begin
  perform public._require_admin();
  select * into s from public.addon_tools_developer_settings where id;
  if not found then return jsonb_build_object('enabled', false, 'allow_free', false, 'allow_premium', false, 'updated_at', null, 'updated_by_email', null,
                                              'overrides_on', 0, 'overrides_off', 0); end if;
  select p.email into v_email from public.profiles p where p.id = s.updated_by;
  return jsonb_build_object('enabled', s.enabled, 'allow_free', s.allow_free, 'allow_premium', s.allow_premium, 'updated_at', s.updated_at,
    'updated_by_email', v_email,
    'overrides_on',  (select count(*) from public.addon_tools_developer_access where enabled),
    'overrides_off', (select count(*) from public.addon_tools_developer_access where not enabled));
end $$;

-- NULL = leave unchanged; at least one value is required. Only an actual change is written and audited.
create or replace function public.admin_addon_tools_set_developer_settings(p_enabled boolean default null, p_allow_free boolean default null, p_allow_premium boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare o public.addon_tools_developer_settings; n public.addon_tools_developer_settings;
begin
  perform public._require_admin();
  if p_enabled is null and p_allow_free is null and p_allow_premium is null then raise exception 'nothing to change'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools_dev_settings'));
  insert into public.addon_tools_developer_settings (id) values (true) on conflict (id) do nothing;
  select * into o from public.addon_tools_developer_settings where id for update;
  update public.addon_tools_developer_settings
     set enabled = coalesce(p_enabled, enabled), allow_free = coalesce(p_allow_free, allow_free), allow_premium = coalesce(p_allow_premium, allow_premium),
         updated_at = now(), updated_by = auth.uid()
   where id returning * into n;
  if (n.enabled, n.allow_free, n.allow_premium) is distinct from (o.enabled, o.allow_free, o.allow_premium) then
    perform public._addon_tools_audit('developer_settings_set', null, null, jsonb_build_object(
      'enabled', n.enabled, 'allow_free', n.allow_free, 'allow_premium', n.allow_premium,
      'was_enabled', o.enabled, 'was_allow_free', o.allow_free, 'was_allow_premium', o.allow_premium));
  end if;
  return jsonb_build_object('enabled', n.enabled, 'allow_free', n.allow_free, 'allow_premium', n.allow_premium, 'updated_at', n.updated_at,
                            'changed', (n.enabled, n.allow_free, n.allow_premium) is distinct from (o.enabled, o.allow_free, o.allow_premium));
end $$;

-- ====================================================================== D. admin: per-user decision (same name / args as 0035)
-- true = personal ON, false = personal OFF, NULL = remove the personal decision. Returns the stored decision AND what the rule now says.
create or replace function public.admin_addon_tools_set_developer_import(p_user uuid, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_had boolean; v_was boolean; v_at timestamptz;
begin
  perform public._require_admin();
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools_dev_import:' || p_user::text));
  select true, d.enabled into v_had, v_was from public.addon_tools_developer_access d where d.user_id = p_user;
  if p_enabled is null then
    delete from public.addon_tools_developer_access where user_id = p_user;
  else
    insert into public.addon_tools_developer_access(user_id, enabled, updated_by) values (p_user, p_enabled, auth.uid())
    on conflict (user_id) do update set enabled = excluded.enabled, updated_at = now(), updated_by = auth.uid();
  end if;
  if v_was is distinct from p_enabled then
    perform public._addon_tools_audit('developer_import_set', null, null, jsonb_build_object('user_id', p_user, 'enabled', p_enabled, 'was_enabled', v_was));
  end if;
  select d.updated_at into v_at from public.addon_tools_developer_access d where d.user_id = p_user;
  return jsonb_build_object('user_id', p_user, 'enabled', p_enabled, 'override', p_enabled, 'was_override', v_was,
                            'changed', v_was is distinct from p_enabled, 'updated_at', v_at,
                            'allowed_now', public._addon_tools_developer_import_allowed(p_user), 'reason', public._addon_tools_developer_import_reason(p_user));
end $$;

-- State of the given users: 'enabled' = what the rule says NOW (effective), 'override' = the personal decision (null = none), 'reason', 'plan'.
create or replace function public.admin_addon_tools_get_developer_import(p_user_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if p_user_ids is null or coalesce(array_length(p_user_ids, 1), 0) > 50 then raise exception 'ask for at most 50 users at a time'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.id, 'enabled', public._addon_tools_developer_import_allowed(p.id),
             'override', d.enabled, 'reason', public._addon_tools_developer_import_reason(p.id), 'plan', public.mz_plan(p.id), 'updated_at', d.updated_at) order by p.id)
      from public.profiles p left join public.addon_tools_developer_access d on d.user_id = p.id
     where p.id = any(p_user_ids)), '[]'::jsonb);
end $$;

-- Everybody with a PERSONAL decision (ON or OFF), with what the rule says for them now.
create or replace function public.admin_addon_tools_list_developer_import() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', p.id, 'email', p.email, 'enabled', d.enabled, 'override', d.enabled,
             'effective', public._addon_tools_developer_import_allowed(p.id), 'reason', public._addon_tools_developer_import_reason(p.id),
             'plan', public.mz_plan(p.id), 'updated_at', d.updated_at) order by d.updated_at desc, p.id)
      from public.addon_tools_developer_access d join public.profiles p on p.id = d.user_id), '[]'::jsonb);
end $$;

-- ====================================================================== E. privileges
revoke all on function
  public._addon_tools_developer_import_reason(uuid), public._addon_tools_developer_import_allowed(uuid),
  public.admin_addon_tools_get_developer_settings(), public.admin_addon_tools_set_developer_settings(boolean, boolean, boolean),
  public.admin_addon_tools_set_developer_import(uuid, boolean), public.admin_addon_tools_get_developer_import(uuid[]),
  public.admin_addon_tools_list_developer_import(), public.addon_tools_my_developer_import()
  from public, anon, authenticated;
grant execute on function
  public.admin_addon_tools_get_developer_settings(), public.admin_addon_tools_set_developer_settings(boolean, boolean, boolean),
  public.admin_addon_tools_set_developer_import(uuid, boolean), public.admin_addon_tools_get_developer_import(uuid[]),
  public.admin_addon_tools_list_developer_import(), public.addon_tools_my_developer_import()
  to authenticated;                                    -- admin_* refuse non-admins inside (_require_admin); my_* returns only the caller's own state

commit;
