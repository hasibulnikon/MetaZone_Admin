-- MetaZone v0.9.9.2 -- 0003: limits are fully admin-controlled, per plan, each one optional (NULL = unlimited),
-- plus a timed "bonus: unlimited for Free users" switch; and a reservation is now a budget of SUCCESSES.
-- Run AFTER 0001 and 0002. Run once.
--
-- WHY THE BUDGET CHANGE (the "20/day but only 15 generated" report): a reservation used to be a budget of
-- ATTEMPTS. Asking for 35 files with 20 left granted 20 attempts; if 5 of them failed (provider errors,
-- rate limits) only 15 succeeded and the other 15 files were already denied, although 5 slots were unused.
-- Now failures never consume the budget, so the client keeps going until `granted` files have SUCCEEDED.

-- ---- new config keys (NULL = unlimited) -------------------------------------------------------
insert into public.app_config(key, value) values
  ('premium_daily_limit',           'null'::jsonb),
  ('premium_weekly_limit',          'null'::jsonb),
  ('premium_max_keys_per_provider', 'null'::jsonb),
  ('free_unlimited_until',          'null'::jsonb)          -- ISO timestamp; while in the future, Free has no daily/weekly limit
on conflict (key) do nothing;

-- ---- helpers ----------------------------------------------------------------------------------
create function public.free_bonus_active() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(public.cfg_text('free_unlimited_until')::timestamptz > now(), false) $$;

create function public.plan_limit(p_plan text, p_kind text) returns integer     -- p_kind: 'daily' | 'weekly'; NULL = unlimited
language sql stable security definer set search_path = public, pg_temp as
$$ select case when p_plan = 'free' and public.free_bonus_active() then null
               else public.cfg_int(p_plan || '_' || p_kind || '_limit') end $$;

create function public.plan_max_keys(p_plan text) returns integer               -- NULL = unlimited
language sql stable security definer set search_path = public, pg_temp as
$$ select public.cfg_int(p_plan || '_max_keys_per_provider') $$;

revoke all on function public.free_bonus_active(), public.plan_limit(text, text), public.plan_max_keys(text)
  from public, anon, authenticated;

-- ---- a reservation holds (granted - ok): failures do not consume it ---------------------------
create or replace function public._outstanding(p_user uuid) returns integer
language sql stable security definer set search_path = public, pg_temp as
$$ select coalesce(sum(greatest(granted - ok, 0)), 0)::integer from public.usage_reservations
   where user_id = p_user and not closed and expires_at > now() $$;

-- ---- me(): per-plan limits (null = unlimited), remaining, bonus ------------------------------
create or replace function public.me() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  uid uuid := public._require_user();
  p public.profiles; s public.subscriptions;
  v_plan text; t date := public.mz_today();
  d_lim int; w_lim int; d_used int; w_used int; out_n int;
begin
  insert into public.profiles(id, email)
    select uid, u.email from auth.users u where u.id = uid
  on conflict (id) do nothing;
  select * into p from public.profiles where id = uid;
  select * into s from public.subscriptions where user_id = uid;
  v_plan := public.mz_plan(uid);
  d_lim := public.plan_limit(v_plan, 'daily');
  w_lim := public.plan_limit(v_plan, 'weekly');
  d_used := public._used(uid, t, v_plan);
  w_used := public._used(uid, public.mz_week_start(), v_plan);
  out_n := public._outstanding(uid);
  return jsonb_build_object(
    'user_id', uid, 'email', p.email, 'status', p.status, 'plan', v_plan,
    'premium_started_at', s.started_at, 'premium_expires_at', s.expires_at,
    'limits', jsonb_build_object('daily', d_lim, 'weekly', w_lim,
                                 'max_keys_per_provider', public.plan_max_keys(v_plan)),
    'usage', jsonb_build_object(
        'today', (select coalesce(sum(ok),0) from public.usage_daily where user_id = uid and day = t),
        'week',  public._used(uid, public.mz_week_start()),
        'month', public._used(uid, public.mz_month_start()),
        'total', public._used(uid, date '1970-01-01')),
    'remaining', case when d_lim is null and w_lim is null then null else jsonb_build_object(
        'daily',  case when d_lim is null then null else greatest(0, d_lim - d_used - out_n) end,
        'weekly', case when w_lim is null then null else greatest(0, w_lim - w_used - out_n) end) end,
    'offers', jsonb_build_object(
        'free',    jsonb_build_object('daily', public.plan_limit('free','daily'), 'weekly', public.plan_limit('free','weekly'),
                                      'max_keys_per_provider', public.plan_max_keys('free')),
        'premium', jsonb_build_object('daily', public.plan_limit('premium','daily'), 'weekly', public.plan_limit('premium','weekly'),
                                      'max_keys_per_provider', public.plan_max_keys('premium'))),
    'bonus_until', case when v_plan = 'free' and public.free_bonus_active() then public.cfg_text('free_unlimited_until') end,
    'premium_info', public.premium_info(),
    'heartbeat_interval_seconds', public.cfg_int('heartbeat_interval_seconds'),
    'offline_grace_hours', public.cfg_int('offline_grace_hours'),
    'server_time', now());
end $$;

-- ---- reserve_generations(): any plan can have daily/weekly limits, each optional --------------
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

-- ---- settle_usage(): `granted` caps SUCCESSES; failures are recorded (bounded) but never consume it ----
create or replace function public.settle_usage(p_reservation uuid, p_seq integer, p_ok integer,
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
  room     := greatest(r.granted - r.ok, 0);
  ok_add   := least(greatest(coalesce(p_ok, 0), 0), room);
  fail_add := least(greatest(coalesce(p_failed, 0), 0), 5000);
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

-- ---- admin_set_config(): numeric | nullable-limit | text | timezone | timestamp keys -----------
create or replace function public.admin_set_config(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  limit_keys constant text[] := array['free_daily_limit','free_weekly_limit','free_max_keys_per_provider',
                                      'premium_daily_limit','premium_weekly_limit','premium_max_keys_per_provider'];
  text_keys  constant text[] := array['premium_price_text','premium_bkash_number','premium_contact_text','premium_instructions'];
begin
  perform public._require_admin();
  p_value := coalesce(p_value, 'null'::jsonb);                       -- PostgREST may deliver JSON null as SQL NULL
  if not exists (select 1 from public.app_config where key = p_key) then
    raise exception 'unknown config key'; end if;
  if p_key = 'day_timezone' then
    if jsonb_typeof(p_value) <> 'string' or not exists (select 1 from pg_timezone_names where name = p_value #>> '{}') then
      raise exception 'unknown timezone'; end if;
  elsif p_key = 'free_unlimited_until' then                          -- null (off) or an ISO timestamp
    if jsonb_typeof(p_value) = 'string' then
      begin perform (p_value #>> '{}')::timestamptz;
      exception when others then raise exception 'not a valid timestamp'; end;
    elsif jsonb_typeof(p_value) <> 'null' then raise exception 'not a valid timestamp'; end if;
  elsif p_key = any (text_keys) then
    if jsonb_typeof(p_value) <> 'string' or length(p_value #>> '{}') > 600 then
      raise exception 'value must be text of at most 600 characters'; end if;
    p_value := to_jsonb(btrim(p_value #>> '{}'));
  elsif p_key = any (limit_keys) then                                -- whole number >= 0, or null = unlimited
    if jsonb_typeof(p_value) <> 'null' and
       (jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0 or (p_value #>> '{}')::numeric <> trunc((p_value #>> '{}')::numeric)) then
      raise exception 'limit must be a whole number >= 0, or null for unlimited'; end if;
  else
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0 then
      raise exception 'value must be a non-negative number'; end if;
  end if;
  update public.app_config set value = p_value, updated_at = now() where key = p_key;
end $$;
