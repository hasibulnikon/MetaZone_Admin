-- 0011 (v0.9.9.9): per-PLAN page access. Admin -> Pages gets a Free switch and a Premium switch for every page.
--
-- How a page's access is decided for one user (unchanged parts marked *):
--   1. locked page (Home, Settings)                         -> always on                                  *
--   2. per-user override (Users -> Pages)                   -> that value, always wins                    *
--   3. otherwise: the master switch `enabled` (off = off for everybody)  AND  the user's plan switch
--      (enabled_premium for Premium accounts, enabled_free for Free accounts; plan = mz_plan(), expiry-aware)
--
-- Safe and additive: two new columns, defaults TRUE, so every page behaves exactly as before EXCEPT the one change you asked for:
--   * Tracker is switched OFF for the Free plan.  >>> Existing FREE users lose the Tracker page the next time the app refreshes
--     page access (heartbeat / restart). Premium users and anyone with a per-user "force on" are unaffected. Tracker data stays on
--     their computer. To give Tracker to a particular free user: Users -> Pages -> Tracker -> Force on. To give it to all Free users:
--     Pages -> Tracker -> Free ON. To keep today's behaviour, delete the single UPDATE below before running this file.
-- The new Converter page is ON for both plans.
-- Also in this file:
--   * 'settings' (the AI-provider API Manager) is NOT a page any more -- it is a section of the Settings page. Switching it off in
--     Admin -> Pages would take the API Manager away from every user, so it is now locked (always on) and hidden from the Admin lists.
--   * a leftover 'eps10' row (from an earlier draft of 0010) is removed; the EPS 10 page was dropped before release.
-- Idempotent: re-running changes nothing except the Tracker line below (see its note).

alter table public.page_flags
  add column if not exists enabled_free    boolean not null default true,
  add column if not exists enabled_premium boolean not null default true;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'page_flags_locked_all_plans') then
    alter table public.page_flags add constraint page_flags_locked_all_plans
      check (not locked or (enabled_free and enabled_premium));
  end if;
end $$;

update public.page_flags set enabled_free = false where page_key = 'tracker' and enabled_free;   -- <- the Tracker decision
update public.page_flags set enabled = true, enabled_free = true, enabled_premium = true, locked = true where page_key = 'settings';
delete from public.page_flags where page_key = 'eps10';

-- ---------------------------------------------------------------- the one place the rule lives
create or replace function public._page_enabled(p_user uuid, p_page text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when f.locked then true
                 else coalesce(
                        (select o.enabled from public.user_page_overrides o where o.user_id = p_user and o.page_key = f.page_key),
                        f.enabled and case when public.mz_plan(p_user) = 'premium' then f.enabled_premium else f.enabled_free end)
            end
       from public.page_flags f where f.page_key = p_page),
    true)
$$;

-- ---------------------------------------------------------------- admin API (old keys kept, new keys added)
create or replace function public.admin_list_pages() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'enabled', f.enabled, 'locked', f.locked,
            'enabled_free', f.enabled_free, 'enabled_premium', f.enabled_premium,
            'overrides_on',  (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and o.enabled),
            'overrides_off', (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and not o.enabled))
          order by f.sort_order, f.page_key) from public.page_flags f where f.page_key <> 'settings'), '[]'::jsonb);
end $$;

-- p_free / p_premium: true = on, false = off, null = leave unchanged.
create or replace function public.admin_set_page_plan_access(p_key text, p_free boolean default null, p_premium boolean default null)
returns jsonb language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  select * into f from public.page_flags where page_key = p_key;
  if not found then raise exception 'unknown page'; end if;
  if f.locked and (p_free is false or p_premium is false) then
    raise exception 'This page cannot be switched off.';
  end if;
  update public.page_flags
     set enabled_free = coalesce(p_free, enabled_free), enabled_premium = coalesce(p_premium, enabled_premium), updated_at = now()
   where page_key = p_key;
  return (select to_jsonb(x) from public.page_flags x where x.page_key = p_key);
end $$;

create or replace function public.admin_get_user_pages(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_plan text;
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  v_plan := public.mz_plan(p_user);
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'locked', f.locked, 'global_enabled', f.enabled,
            'plan', v_plan,
            'plan_enabled', f.enabled and case when v_plan = 'premium' then f.enabled_premium else f.enabled_free end,
            'override', (select o.enabled from public.user_page_overrides o where o.user_id = p_user and o.page_key = f.page_key),
            'effective', public._page_enabled(p_user, f.page_key))
          order by f.sort_order, f.page_key) from public.page_flags f where f.page_key <> 'settings'), '[]'::jsonb);
end $$;

revoke all on function public.admin_set_page_plan_access(text, boolean, boolean) from public, anon, authenticated;
grant execute on function public.admin_set_page_plan_access(text, boolean, boolean) to authenticated;
