-- MetaZone v0.9.9.2 -- accounts / subscriptions / usage / notices / admin.
-- Target: Supabase (Postgres 15+), Free plan.
--
-- DESIGN RULES
--  * Clients (anon / authenticated) get NO table privileges. RLS is enabled
--    on every table with no policies (deny-by-default, defense in depth).
--    All access is through SECURITY DEFINER functions below, each of which
--    derives the caller from auth.uid() -- never from a parameter.
--  * Plan is DERIVED (subscriptions.expires_at > now()), never stored, so
--    expiry needs no cron job and cannot be forgotten.
--  * Usage is counted in one row per (user, day, plan). Week/month/total are
--    sums of those rows (<= ~366 rows/user/year) -- no weekly/monthly tables.
--  * Raw usage_events are short-retention (prune_usage_events()).
--  * No service-role key is ever needed by the desktop app or the admin site.

create extension if not exists pgcrypto;

-- ------------------------------------------------------------------ config
create table public.app_config (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);
insert into public.app_config(key, value) values
  ('free_daily_limit',            '20'),
  ('free_weekly_limit',           '100'),
  ('free_max_keys_per_provider',  '1'),
  ('heartbeat_interval_seconds',  '300'),
  ('online_threshold_seconds',    '600'),
  ('reservation_ttl_minutes',     '30'),
  ('premium_default_days',        '30'),
  ('premium_max_reservation',     '5000'),
  ('day_timezone',                '"Asia/Dhaka"'),
  ('event_retention_days',        '45'),
  ('offline_grace_hours',         '24');

-- ------------------------------------------------------------------ tables
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  created_at   timestamptz not null default now(),
  status       text not null default 'active' check (status in ('active','suspended')),
  last_seen_at timestamptz,
  app_version  text
);

create table public.subscriptions (
  user_id    uuid primary key references public.profiles(id) on delete cascade,
  started_at timestamptz not null,
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);

create table public.subscription_events (
  id         bigserial primary key,
  user_id    uuid not null references public.profiles(id) on delete cascade,
  at         timestamptz not null default now(),
  action     text not null check (action in ('activate','extend','set_expiry','deactivate')),
  old_expiry timestamptz,
  new_expiry timestamptz,
  admin_id   uuid,
  note       text
);
create index on public.subscription_events(user_id, at desc);
create index on public.subscription_events(at desc);

create table public.usage_daily (
  user_id uuid not null references public.profiles(id) on delete cascade,
  day     date not null,
  plan    text not null check (plan in ('free','premium')),
  ok      integer not null default 0 check (ok >= 0),
  failed  integer not null default 0 check (failed >= 0),
  primary key (user_id, day, plan)
);
create index on public.usage_daily(day);

-- One reservation = one batch the client was authorised to run. Counts
-- against the quota (granted - ok - failed) until settled or expired.
create table public.usage_reservations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  day         date not null,
  plan        text not null check (plan in ('free','premium')),
  kind        text not null default 'meta',
  app_version text,
  granted     integer not null check (granted > 0),
  ok          integer not null default 0,
  failed      integer not null default 0,
  last_seq    integer not null default 0,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  closed      boolean not null default false
);
create index on public.usage_reservations(user_id) where not closed;
create index on public.usage_reservations(created_at);

create table public.usage_events (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  at          timestamptz not null default now(),
  plan        text not null,
  kind        text,
  ok          boolean not null,
  provider    text,
  model       text,
  app_version text,
  request_id  text
);
create index on public.usage_events(at);
create index on public.usage_events(user_id, at desc);

create table public.notices (
  id               bigserial primary key,
  body             text not null check (length(body) between 1 and 300),
  active           boolean not null default true,
  archived         boolean not null default false,
  starts_at        timestamptz,
  ends_at          timestamptz,
  show_immediately boolean not null default false,
  priority         integer not null default 0,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create table public.notice_seen (
  user_id   uuid not null references public.profiles(id) on delete cascade,
  notice_id bigint not null references public.notices(id) on delete cascade,
  day       date not null,
  dismissed boolean not null default false,
  primary key (user_id, notice_id, day)
);

create table public.admin_users (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  note       text,
  created_at timestamptz not null default now()
);

create table public.app_versions (
  version      text primary key,
  released_at  timestamptz not null default now(),
  notes        text,
  download_url text,
  is_latest    boolean not null default false
);
create unique index app_versions_one_latest on public.app_versions(is_latest) where is_latest;

-- Deny-by-default: RLS on, no policies, no table grants.
do $$ declare t text; begin
  for t in select tablename from pg_tables where schemaname = 'public' loop
    execute format('alter table public.%I enable row level security', t);
  end loop;
end $$;
revoke all on all tables    in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;

-- ---------------------------------------------------------------- helpers
create function public.cfg_int(p_key text) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select (value #>> '{}')::integer from public.app_config where key = p_key $$;

create function public.cfg_text(p_key text) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select value #>> '{}' from public.app_config where key = p_key $$;

-- "today" / week / month are calendar boundaries in the configured timezone.
create function public.mz_today() returns date
language sql stable security definer set search_path = public, pg_temp as
$$ select (now() at time zone public.cfg_text('day_timezone'))::date $$;

create function public.mz_week_start() returns date          -- Monday
language sql stable security definer set search_path = public, pg_temp as
$$ select date_trunc('week', public.mz_today()::timestamp)::date $$;

create function public.mz_month_start() returns date
language sql stable security definer set search_path = public, pg_temp as
$$ select date_trunc('month', public.mz_today()::timestamp)::date $$;

create function public.mz_plan(p_user uuid) returns text
language sql stable security definer set search_path = public, pg_temp as
$$ select case when exists (select 1 from public.subscriptions s
                            where s.user_id = p_user and s.expires_at > now())
               then 'premium' else 'free' end $$;

create function public.is_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select exists (select 1 from public.admin_users a where a.user_id = auth.uid()) $$;

create function public._require_admin() returns void
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null or not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

create function public._require_user() returns uuid
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  return auth.uid();
end $$;

-- Sum of ok generations for one user over [from, to], optionally one plan.
create function public._used(p_user uuid, p_from date, p_plan text default null) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(sum(ok), 0)::integer from public.usage_daily
   where user_id = p_user and day >= p_from and (p_plan is null or plan = p_plan) $$;

create function public._outstanding(p_user uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(sum(granted - ok - failed), 0)::integer from public.usage_reservations
   where user_id = p_user and not closed and expires_at > now() $$;

-- Profile row is created when the auth user is created.
create function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles(id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ------------------------------------------------------------ client API
create function public.me() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._require_user();
  p public.profiles; s public.subscriptions;
  v_plan text; t date := public.mz_today();
  d_used int; w_used int; out_n int;
  free_d int := public.cfg_int('free_daily_limit');
  free_w int := public.cfg_int('free_weekly_limit');
begin
  insert into public.profiles(id, email)
    select uid, u.email from auth.users u where u.id = uid
  on conflict (id) do nothing;
  select * into p from public.profiles where id = uid;
  select * into s from public.subscriptions where user_id = uid;
  v_plan := public.mz_plan(uid);
  select coalesce(sum(ok),0) into d_used from public.usage_daily
    where user_id = uid and day = t and plan = 'free';
  select coalesce(sum(ok),0) into w_used from public.usage_daily
    where user_id = uid and day >= public.mz_week_start() and plan = 'free';
  out_n := public._outstanding(uid);
  return jsonb_build_object(
    'user_id', uid, 'email', p.email, 'status', p.status, 'plan', v_plan,
    'premium_started_at', s.started_at, 'premium_expires_at', s.expires_at,
    'limits', jsonb_build_object(
        'daily',  case when v_plan = 'free' then free_d end,
        'weekly', case when v_plan = 'free' then free_w end,
        'max_keys_per_provider',
           case when v_plan = 'free' then public.cfg_int('free_max_keys_per_provider') end),
    'usage', jsonb_build_object(
        'today', (select coalesce(sum(ok),0) from public.usage_daily where user_id = uid and day = t),
        'week',  public._used(uid, public.mz_week_start()),
        'month', public._used(uid, public.mz_month_start()),
        'total', public._used(uid, date '1970-01-01')),
    'remaining', case when v_plan = 'free' then jsonb_build_object(
        'daily',  greatest(0, free_d - d_used - out_n),
        'weekly', greatest(0, free_w - w_used - out_n)) end,
    'heartbeat_interval_seconds', public.cfg_int('heartbeat_interval_seconds'),
    'offline_grace_hours', public.cfg_int('offline_grace_hours'),
    'server_time', now());
end $$;

create function public.heartbeat(p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user();
begin
  perform public.me();  -- makes sure the profile exists
  update public.profiles set last_seen_at = now(),
         app_version = coalesce(left(p_app_version, 32), app_version)
   where id = uid;
  return public.me();
end $$;

-- Ask permission to run up to p_count generations. Free plans may get a
-- PARTIAL grant (min of what was asked, daily remaining, weekly remaining).
create function public.reserve_generations(p_count integer, p_kind text default 'meta',
                                           p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._require_user();
  p public.profiles; v_plan text; n int; granted int;
  d_rem int; w_rem int; out_n int; rid uuid; reason text; msg text;
begin
  perform public.me();
  select * into p from public.profiles where id = uid for update;   -- serialises per user
  if p.status = 'suspended' then
    return jsonb_build_object('ok', false, 'reason', 'suspended', 'message', 'Account suspended.');
  end if;
  n := least(greatest(coalesce(p_count, 0), 0), 100000);
  if n = 0 then
    return jsonb_build_object('ok', false, 'reason', 'nothing', 'message', 'Nothing to generate.');
  end if;
  v_plan := public.mz_plan(uid);
  if v_plan = 'premium' then
    granted := least(n, public.cfg_int('premium_max_reservation'));
  else
    out_n := public._outstanding(uid);
    d_rem := public.cfg_int('free_daily_limit')  - public._used(uid, public.mz_today(), 'free') - out_n;
    w_rem := public.cfg_int('free_weekly_limit') - public._used(uid, public.mz_week_start(), 'free') - out_n;
    granted := greatest(0, least(n, d_rem, w_rem));
    if granted < n then
      if w_rem <= 0 then reason := 'weekly_limit'; msg := 'Weekly generation limit reached.';
      elsif d_rem <= 0 then reason := 'daily_limit'; msg := 'Daily generation limit reached.';
      elsif w_rem < d_rem then reason := 'weekly_limit'; msg := 'Weekly generation limit reached.';
      else reason := 'daily_limit'; msg := 'Daily generation limit reached.'; end if;
    end if;
    if granted = 0 then
      return jsonb_build_object('ok', false, 'reason', reason, 'message', msg, 'plan', v_plan);
    end if;
  end if;
  insert into public.usage_reservations(user_id, day, plan, kind, app_version, granted, expires_at)
  values (uid, public.mz_today(), v_plan, left(coalesce(p_kind,'meta'), 24), left(p_app_version, 32), granted,
          now() + make_interval(mins => public.cfg_int('reservation_ttl_minutes')))
  returning id into rid;
  return jsonb_build_object('ok', true, 'reservation_id', rid, 'granted', granted,
           'requested', n, 'plan', v_plan, 'reason', reason, 'message', msg);
end $$;

-- Report results. p_seq must strictly increase per reservation (replays are
-- ignored, so a retried network call cannot double-count). Failures are
-- recorded but free up their slot (they do not consume quota).
create function public.settle_usage(p_reservation uuid, p_seq integer, p_ok integer,
                                    p_failed integer, p_events jsonb default '[]'::jsonb,
                                    p_final boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._require_user();
  r public.usage_reservations; room int; ok_add int; fail_add int; ev jsonb; i int := 0;
begin
  select * into r from public.usage_reservations
   where id = p_reservation and user_id = uid for update;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_reservation');
  end if;
  if p_seq <= r.last_seq then
    return jsonb_build_object('ok', true, 'duplicate', true);
  end if;
  if r.closed then
    return jsonb_build_object('ok', false, 'reason', 'closed');
  end if;
  room     := r.granted - r.ok - r.failed;
  ok_add   := least(greatest(coalesce(p_ok, 0), 0), room);
  fail_add := least(greatest(coalesce(p_failed, 0), 0), room - ok_add);
  if ok_add + fail_add > 0 then
    insert into public.usage_daily(user_id, day, plan, ok, failed)
    values (uid, r.day, r.plan, ok_add, fail_add)
    on conflict (user_id, day, plan)
    do update set ok = public.usage_daily.ok + excluded.ok,
                  failed = public.usage_daily.failed + excluded.failed;
  end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) = 'array' then
    for ev in select * from jsonb_array_elements(p_events) loop
      exit when i >= least(200, ok_add + fail_add);
      insert into public.usage_events(user_id, plan, kind, ok, provider, model, app_version, request_id)
      values (uid, r.plan, left(coalesce(ev->>'kind', r.kind), 24),
              coalesce((ev->>'ok')::boolean, true),
              left(ev->>'provider', 40), left(ev->>'model', 80), r.app_version, left(ev->>'request_id', 64));
      i := i + 1;
    end loop;
  end if;
  update public.usage_reservations
     set ok = ok + ok_add, failed = failed + fail_add, last_seq = p_seq,
         closed = coalesce(p_final, false),
         expires_at = now() + make_interval(mins => public.cfg_int('reservation_ttl_minutes'))
   where id = r.id;
  return jsonb_build_object('ok', true, 'counted_ok', ok_add, 'counted_failed', fail_add);
end $$;

create function public.next_notice() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); n public.notices; t date := public.mz_today();
begin
  perform public.me();
  select * into n from public.notices x
   where x.active and not x.archived
     and (x.show_immediately or x.starts_at is null or x.starts_at <= now())
     and (x.ends_at is null or x.ends_at > now())
     and not exists (select 1 from public.notice_seen s
                      where s.user_id = uid and s.notice_id = x.id and s.day = t)
   order by x.priority desc, x.created_at desc limit 1;
  if not found then return null; end if;
  insert into public.notice_seen(user_id, notice_id, day) values (uid, n.id, t) on conflict do nothing;
  return jsonb_build_object('id', n.id, 'body', n.body);
end $$;

create function public.dismiss_notice(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user();
begin
  update public.notice_seen set dismissed = true
   where user_id = uid and notice_id = p_id and day = public.mz_today();
end $$;

create function public.get_latest_version() returns jsonb    -- also callable pre-login
language sql stable security definer set search_path = public, pg_temp as
$$ select to_jsonb(v) - 'is_latest' from public.app_versions v where v.is_latest $$;

-- -------------------------------------------------------------- admin API
create function public.admin_overview() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  t date := public.mz_today(); thr int := public.cfg_int('online_threshold_seconds'); res jsonb;
begin
  perform public._require_admin();
  select jsonb_build_object(
    'users', jsonb_build_object(
      'total', (select count(*) from public.profiles),
      'active_now', (select count(*) from public.profiles where last_seen_at > now() - make_interval(secs => thr)),
      'active_today', (select count(*) from public.profiles
                        where (last_seen_at at time zone public.cfg_text('day_timezone'))::date = t),
      'premium', (select count(*) from public.subscriptions where expires_at > now()),
      'free', (select count(*) from public.profiles) - (select count(*) from public.subscriptions where expires_at > now()),
      'expired_premium', (select count(*) from public.subscriptions where expires_at <= now()),
      'suspended', (select count(*) from public.profiles where status = 'suspended')),
    'generations', jsonb_build_object(
      'total',  (select coalesce(sum(ok),0) from public.usage_daily),
      'today',  (select coalesce(sum(ok),0) from public.usage_daily where day = t),
      'week',   (select coalesce(sum(ok),0) from public.usage_daily where day >= public.mz_week_start()),
      'month',  (select coalesce(sum(ok),0) from public.usage_daily where day >= public.mz_month_start()),
      'free',   (select coalesce(sum(ok),0) from public.usage_daily where plan = 'free'),
      'premium',(select coalesce(sum(ok),0) from public.usage_daily where plan = 'premium'),
      'failed', (select coalesce(sum(failed),0) from public.usage_daily)),
    'subscriptions', jsonb_build_object(
      'active_premium', (select count(*) from public.subscriptions where expires_at > now()),
      'expiring_soon',  (select count(*) from public.subscriptions
                          where expires_at > now() and expires_at <= now() + interval '7 days'),
      'expired',        (select count(*) from public.subscriptions where expires_at <= now()),
      'recently_activated', (select count(*) from public.subscription_events
                              where action = 'activate' and at > now() - interval '7 days')),
    'app', jsonb_build_object(
      'latest_version', (select version from public.app_versions where is_latest),
      'users_by_version', coalesce((select jsonb_object_agg(coalesce(v,'unknown'), c)
                            from (select app_version v, count(*) c from public.profiles group by 1) x), '{}'::jsonb))
  ) into res;
  return res;
end $$;

create function public.admin_list_users(p_search text default null, p_limit integer default 50,
                                        p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare res jsonb; t date := public.mz_today(); ws date := public.mz_week_start(); ms date := public.mz_month_start();
begin
  perform public._require_admin();
  select coalesce(jsonb_agg(row_to_json(q)::jsonb order by q.created_at desc), '[]'::jsonb) into res from (
    select p.id, p.email, p.status, p.created_at, p.last_seen_at, p.app_version,
           case when s.expires_at > now() then 'premium' else 'free' end as plan,
           s.started_at as premium_started_at, s.expires_at as premium_expires_at,
           coalesce(sum(u.ok) filter (where u.day = t), 0)  as today,
           coalesce(sum(u.ok) filter (where u.day >= ws), 0) as week,
           coalesce(sum(u.ok) filter (where u.day >= ms), 0) as month,
           coalesce(sum(u.ok), 0) as total
      from public.profiles p
      left join public.subscriptions s on s.user_id = p.id
      left join public.usage_daily u on u.user_id = p.id
     where p_search is null or p.email ilike '%' || p_search || '%' or p.id::text = p_search
     group by p.id, s.user_id
     order by p.created_at desc
     limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) q;
  return res;
end $$;

create function public.admin_user_detail(p_user uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'profile', (select to_jsonb(p) from public.profiles p where p.id = p_user),
    'plan', public.mz_plan(p_user),
    'subscription', (select to_jsonb(s) from public.subscriptions s where s.user_id = p_user),
    'subscription_history', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc)
        from (select * from public.subscription_events where user_id = p_user order by at desc limit 50) e), '[]'),
    'usage_by_day', coalesce((select jsonb_agg(to_jsonb(u) order by u.day desc)
        from (select day, plan, ok, failed from public.usage_daily where user_id = p_user
              order by day desc limit 90) u), '[]'),
    'recent_events', coalesce((select jsonb_agg(to_jsonb(e) order by e.at desc)
        from (select at, plan, kind, ok, provider, model, app_version from public.usage_events
              where user_id = p_user order by at desc limit 100) e), '[]'));
end $$;

-- Activate or extend. New expiry = max(current expiry, now) + days, so an
-- extension can never shorten remaining time.
create function public.admin_set_premium(p_user uuid, p_days integer default null,
                                         p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  s public.subscriptions; d int := coalesce(p_days, public.cfg_int('premium_default_days'));
  base timestamptz; new_exp timestamptz; was_active boolean;
begin
  perform public._require_admin();
  if d < 1 or d > 3660 then raise exception 'days must be 1..3660'; end if;
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'unknown user'; end if;
  select * into s from public.subscriptions where user_id = p_user for update;
  was_active := found and s.expires_at > now();
  base := case when was_active then s.expires_at else now() end;
  new_exp := base + make_interval(days => d);
  insert into public.subscriptions(user_id, started_at, expires_at)
    values (p_user, now(), new_exp)
  on conflict (user_id) do update
    set expires_at = new_exp, updated_at = now(),
        started_at = case when was_active then public.subscriptions.started_at else now() end;
  insert into public.subscription_events(user_id, action, old_expiry, new_expiry, admin_id, note)
    values (p_user, case when was_active then 'extend' else 'activate' end,
            s.expires_at, new_exp, auth.uid(), p_note);
  return jsonb_build_object('ok', true, 'plan', 'premium', 'expires_at', new_exp);
end $$;

create function public.admin_set_expiry(p_user uuid, p_expiry timestamptz, p_note text default null)
returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.subscriptions;
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then
    raise exception 'unknown user'; end if;
  select * into s from public.subscriptions where user_id = p_user for update;
  insert into public.subscriptions(user_id, started_at, expires_at) values (p_user, now(), p_expiry)
  on conflict (user_id) do update set expires_at = p_expiry, updated_at = now();
  insert into public.subscription_events(user_id, action, old_expiry, new_expiry, admin_id, note)
    values (p_user, 'set_expiry', s.expires_at, p_expiry, auth.uid(), p_note);
  return jsonb_build_object('ok', true, 'expires_at', p_expiry, 'plan', public.mz_plan(p_user));
end $$;

create function public.admin_deactivate_premium(p_user uuid, p_note text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.subscriptions;
begin
  perform public._require_admin();
  select * into s from public.subscriptions where user_id = p_user for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_subscription'); end if;
  update public.subscriptions set expires_at = least(expires_at, now()), updated_at = now() where user_id = p_user;
  insert into public.subscription_events(user_id, action, old_expiry, new_expiry, admin_id, note)
    values (p_user, 'deactivate', s.expires_at, least(s.expires_at, now()), auth.uid(), p_note);
  return jsonb_build_object('ok', true, 'plan', public.mz_plan(p_user));
end $$;

create function public.admin_set_status(p_user uuid, p_status text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if p_status not in ('active','suspended') then raise exception 'bad status'; end if;
  update public.profiles set status = p_status where id = p_user;
  if not found then raise exception 'unknown user'; end if;
  return jsonb_build_object('ok', true, 'status', p_status);
end $$;

create function public.admin_list_notices() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(to_jsonb(n) order by n.created_at desc) from public.notices n), '[]');
end $$;

create function public.admin_upsert_notice(p_id bigint, p_body text, p_active boolean default true,
    p_starts_at timestamptz default null, p_ends_at timestamptz default null,
    p_show_immediately boolean default false, p_priority integer default 0) returns bigint
language plpgsql security definer set search_path = public, pg_temp as $$
declare nid bigint;
begin
  perform public._require_admin();
  if p_id is null then
    insert into public.notices(body, active, starts_at, ends_at, show_immediately, priority)
    values (p_body, coalesce(p_active,true), p_starts_at, p_ends_at, coalesce(p_show_immediately,false), coalesce(p_priority,0))
    returning id into nid;
  else
    update public.notices set body = p_body, active = coalesce(p_active,true), starts_at = p_starts_at,
           ends_at = p_ends_at, show_immediately = coalesce(p_show_immediately,false),
           priority = coalesce(p_priority,0), updated_at = now()
     where id = p_id returning id into nid;
    if nid is null then raise exception 'unknown notice'; end if;
  end if;
  return nid;
end $$;

create function public.admin_archive_notice(p_id bigint, p_archived boolean default true) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.notices set archived = p_archived, updated_at = now() where id = p_id;
end $$;

create function public.admin_delete_notice(p_id bigint) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  delete from public.notices where id = p_id;
end $$;

create function public.admin_get_config() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return (select jsonb_object_agg(key, value) from public.app_config);
end $$;

create function public.admin_set_config(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if not exists (select 1 from public.app_config where key = p_key) then
    raise exception 'unknown config key'; end if;
  if p_key <> 'day_timezone' and (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0) then
    raise exception 'value must be a non-negative number'; end if;
  if p_key = 'day_timezone' and not exists (select 1 from pg_timezone_names where name = p_value #>> '{}') then
    raise exception 'unknown timezone'; end if;
  update public.app_config set value = p_value, updated_at = now() where key = p_key;
end $$;

create function public.admin_set_latest_version(p_version text, p_notes text default null,
                                                p_url text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.app_versions set is_latest = false where is_latest;
  insert into public.app_versions(version, notes, download_url, is_latest)
    values (p_version, p_notes, p_url, true)
  on conflict (version) do update set notes = excluded.notes, download_url = excluded.download_url, is_latest = true;
end $$;

-- Housekeeping. NOT granted to clients; run from pg_cron or the SQL editor:
--   select cron.schedule('mz-prune', '17 3 * * *', 'select public.prune_usage_events()');
create function public.prune_usage_events() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare a int; b int; c int;
begin
  delete from public.usage_events where at < now() - make_interval(days => public.cfg_int('event_retention_days'));
  get diagnostics a = row_count;
  delete from public.usage_reservations where created_at < now() - interval '7 days';
  get diagnostics b = row_count;
  delete from public.notice_seen where day < public.mz_today() - 30;
  get diagnostics c = row_count;
  return jsonb_build_object('events', a, 'reservations', b, 'notice_seen', c);
end $$;

-- ------------------------------------------------------------ privileges
-- Functions are executable by PUBLIC by default: strip that, then grant back
-- exactly the client-facing surface.
do $$ declare f record; begin
  for f in select p.oid::regprocedure as sig from pg_proc p
           join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public'
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f.sig);
  end loop;
end $$;
grant execute on function
  public.me(), public.heartbeat(text), public.reserve_generations(integer, text, text),
  public.settle_usage(uuid, integer, integer, integer, jsonb, boolean),
  public.next_notice(), public.dismiss_notice(bigint),
  public.admin_overview(), public.admin_list_users(text, integer, integer),
  public.admin_user_detail(uuid), public.admin_set_premium(uuid, integer, text),
  public.admin_set_expiry(uuid, timestamptz, text), public.admin_deactivate_premium(uuid, text),
  public.admin_set_status(uuid, text), public.admin_list_notices(),
  public.admin_upsert_notice(bigint, text, boolean, timestamptz, timestamptz, boolean, integer),
  public.admin_archive_notice(bigint, boolean), public.admin_delete_notice(bigint),
  public.admin_get_config(), public.admin_set_config(text, jsonb),
  public.admin_set_latest_version(text, text, text)
  to authenticated;
grant execute on function public.get_latest_version() to anon, authenticated;
-- (admin_* are callable by any signed-in user but raise 'forbidden' unless
--  is_admin(); the check lives inside each function.)
