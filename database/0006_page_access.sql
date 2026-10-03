-- MetaZone v0.9.9.4 -- 0006: per-page on/off switches, controlled from the Admin panel.
-- Run AFTER 0001..0005. Run once. Purely additive: two new tables, six new functions, and ONE
-- redefined function (reserve_generations) that is byte-for-byte 0005's body plus a single new check.
--
-- Model (two layers, user layer wins):
--   page_flags           one row per app page: the GLOBAL default (enabled / disabled for everyone).
--   user_page_overrides  optional per-user exception: force a page ON or OFF for one account.
--   effective(user, page) = locked page -> always on
--                           else the user's override if there is one
--                           else the page's global flag.
-- So you can ship a page switched OFF globally and switch it ON for yourself / beta testers only, or
-- sell a cheaper plan by switching a page OFF for one customer.
--
-- Fail-open on purpose: the desktop app treats "no answer yet" (offline, old server) as the
-- shipped default (everything on), so a network blip never locks anybody out of a page they have.
-- The server-side teeth are in reserve_generations(): the three AI-consuming pages (meta / prompt /
-- p2p) cannot obtain a generation slot while switched off for that user, exactly like the
-- version gate. Embed / Batch / Tracker have no server-metered action, so for them the switch is
-- enforced by the app UI only -- it hides the page; it is not a hard security boundary.

create table public.page_flags (
  page_key   text primary key check (page_key ~ '^[a-z0-9_]{1,32}$'),
  label      text not null,
  enabled    boolean not null default true,
  locked     boolean not null default false,        -- Home / Settings: can never be switched off
  sort_order integer not null default 100,
  updated_at timestamptz not null default now(),
  constraint page_flags_locked_implies_enabled check (not locked or enabled)
);

create table public.user_page_overrides (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  page_key   text not null references public.page_flags(page_key) on delete cascade,
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, page_key)
);

-- keys = the data-page values in frontend/pages/manifest.json (kept identical on purpose)
insert into public.page_flags(page_key, label, enabled, locked, sort_order) values
  ('dashboard',  'Home / Dashboard',      true, true,  10),
  ('meta',       'Meta Generation',       true, false, 20),
  ('embed',      'Embed',                 true, false, 30),
  ('prompt',     'Image to Prompt',       true, false, 40),
  ('p2p',        'Prompt-to-Prompt',      true, false, 50),
  ('automation', 'Batch',                 true, false, 60),
  ('tracker',    'Tracker',               true, false, 70),
  ('settings',   'API Manager',           true, false, 80),
  ('appearance', 'Settings / Appearance', true, true,  90);

-- Same deny-by-default posture as 0001: RLS on, no policies, no client table grants.
alter table public.page_flags          enable row level security;
alter table public.user_page_overrides enable row level security;
revoke all on public.page_flags, public.user_page_overrides from public, anon, authenticated;

-- ---------------------------------------------------------------- helper
-- Unknown page -> true (fail-open for a page this server has never heard of).
create function public._page_enabled(p_user uuid, p_page text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(
    (select case when f.locked then true
                 else coalesce((select o.enabled from public.user_page_overrides o
                                 where o.user_id = p_user and o.page_key = f.page_key), f.enabled) end
       from public.page_flags f where f.page_key = p_page),
    true)
$$;

-- ---------------------------------------------------------------- client API
-- The app calls this next to me()/heartbeat() (it deliberately does NOT change me()'s shape).
create function public.get_my_pages() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user();
begin
  return jsonb_build_object('pages',
    coalesce((select jsonb_object_agg(f.page_key, public._page_enabled(uid, f.page_key)) from public.page_flags f),
             '{}'::jsonb));
end $$;

-- ---------------------------------------------------------------- admin API
create function public.admin_list_pages() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'enabled', f.enabled, 'locked', f.locked,
            'overrides_on',  (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and o.enabled),
            'overrides_off', (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and not o.enabled))
          order by f.sort_order, f.page_key) from public.page_flags f), '[]'::jsonb);
end $$;

create function public.admin_set_page_enabled(p_key text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  select * into f from public.page_flags where page_key = p_key;
  if not found then raise exception 'unknown page'; end if;
  if f.locked and not coalesce(p_enabled, true) then
    raise exception 'This page cannot be switched off.';
  end if;
  update public.page_flags set enabled = coalesce(p_enabled, true), updated_at = now() where page_key = p_key;
  return (select to_jsonb(x) from public.page_flags x where x.page_key = p_key);
end $$;

-- One row per page for one user: the global flag, the user's override (null = none) and the result.
create function public.admin_get_user_pages(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'locked', f.locked, 'global_enabled', f.enabled,
            'override', (select o.enabled from public.user_page_overrides o where o.user_id = p_user and o.page_key = f.page_key),
            'effective', public._page_enabled(p_user, f.page_key))
          order by f.sort_order, f.page_key) from public.page_flags f), '[]'::jsonb);
end $$;

-- p_enabled: true = force on, false = force off, null = remove the override (follow the global flag).
create function public.admin_set_user_page(p_user uuid, p_key text, p_enabled boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  select * into f from public.page_flags where page_key = p_key;
  if not found then raise exception 'unknown page'; end if;
  if f.locked then raise exception 'This page cannot be switched off.'; end if;
  if p_enabled is null then
    delete from public.user_page_overrides where user_id = p_user and page_key = p_key;
  else
    insert into public.user_page_overrides(user_id, page_key, enabled) values (p_user, p_key, p_enabled)
    on conflict (user_id, page_key) do update set enabled = excluded.enabled, updated_at = now();
  end if;
  return public.admin_get_user_pages(p_user);
end $$;

create function public.admin_reset_user_pages(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  delete from public.user_page_overrides where user_id = p_user;
  return public.admin_get_user_pages(p_user);
end $$;

-- ---------------------------------------------------------------- the server-side gate
-- Body = 0005's reserve_generations (which already carries 0003/0004's logic) with exactly ONE
-- addition: the page check right after the version check.
create or replace function public.reserve_generations(p_count integer, p_kind text default 'meta',
                                                       p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._require_user();
  p public.profiles; v_plan text; n int; granted int;
  max_res int := public.cfg_int('premium_max_reservation');
  d_lim int; w_lim int; d_rem int; w_rem int; out_n int; rid uuid; reason text; msg text;
  big constant int := 2147483000;
begin
  perform public.me();
  select * into p from public.profiles where id = uid for update;          -- serialises per user
  if p.status = 'suspended' then
    return jsonb_build_object('ok', false, 'reason', 'suspended', 'message', 'Account suspended.');
  end if;
  if not coalesce((public._version_info(p_app_version)->>'is_active')::boolean, false) then
    return jsonb_build_object('ok', false, 'reason', 'inactive_version',
      'message', 'This version of MetaZone is no longer supported. Please update to continue.');
  end if;
  -- v0.9.9.4 (0006): page switched off for this user -> no generation slot for that page's feature.
  if p_kind in ('meta', 'prompt', 'p2p') and not public._page_enabled(uid, p_kind) then
    return jsonb_build_object('ok', false, 'reason', 'page_disabled',
      'message', 'This feature is not included in your account. Contact the administrator to enable it.');
  end if;
  if (select count(*) from public.usage_reservations
       where user_id = uid and not closed and expires_at > now()) >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'too_many_open',
      'message', 'Too many generation batches are already open. Wait for them to finish and try again.');
  end if;
  n := least(greatest(coalesce(p_count, 0), 0), 100000);
  if n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing', 'message', 'Nothing to generate.');
  end if;
  v_plan := public.mz_plan(uid);
  d_lim := public.plan_limit(v_plan, 'daily');
  w_lim := public.plan_limit(v_plan, 'weekly');
  out_n := public._outstanding(uid);
  d_rem := case when d_lim is null then big else d_lim - public._used(uid, public.mz_today(), v_plan) - out_n end;
  w_rem := case when w_lim is null then big else w_lim - public._used(uid, public.mz_week_start(), v_plan) - out_n end;
  granted := greatest(0, least(n, d_rem, w_rem, max_res));
  if granted < n then
    if    w_rem <= 0                          then reason := 'weekly_limit'; msg := 'Weekly generation limit reached.';
    elsif d_rem <= 0                          then reason := 'daily_limit';  msg := 'Daily generation limit reached.';
    elsif max_res < least(d_rem, w_rem)       then reason := 'batch_limit';  msg := 'Batch size limit reached.';
    elsif w_rem < d_rem                       then reason := 'weekly_limit'; msg := 'Weekly generation limit reached.';
    else                                           reason := 'daily_limit';  msg := 'Daily generation limit reached.';
    end if;
  end if;
  if granted = 0 then
    return jsonb_build_object('ok', false, 'reason', reason, 'message', msg, 'plan', v_plan);
  end if;
  insert into public.usage_reservations(user_id, day, plan, kind, app_version, granted, expires_at)
  values (uid, public.mz_today(), v_plan, left(coalesce(p_kind,'meta'), 24), left(p_app_version, 32), granted,
          now() + make_interval(mins => public.cfg_int('reservation_ttl_minutes')))
  returning id into rid;
  return jsonb_build_object('ok', true, 'reservation_id', rid, 'granted', granted,
           'requested', n, 'plan', v_plan, 'reason', reason, 'message', msg);
end $$;

-- ------------------------------------------------------------ privileges
-- Same pattern as 0001/0005: new functions start with PUBLIC execute -- strip it, grant back the
-- intended surface. reserve_generations keeps its grant (create or replace preserves ACLs).
revoke all on function public._page_enabled(uuid, text) from public, anon, authenticated;
revoke all on function public.get_my_pages() from public, anon, authenticated;
revoke all on function public.admin_list_pages() from public, anon, authenticated;
revoke all on function public.admin_set_page_enabled(text, boolean) from public, anon, authenticated;
revoke all on function public.admin_get_user_pages(uuid) from public, anon, authenticated;
revoke all on function public.admin_set_user_page(uuid, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_reset_user_pages(uuid) from public, anon, authenticated;

grant execute on function
  public.get_my_pages(),
  public.admin_list_pages(),
  public.admin_set_page_enabled(text, boolean),
  public.admin_get_user_pages(uuid),
  public.admin_set_user_page(uuid, text, boolean),
  public.admin_reset_user_pages(uuid)
  to authenticated;
-- _page_enabled stays ungranted (underscore helper), like _version_info.
