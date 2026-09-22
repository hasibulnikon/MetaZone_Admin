-- MetaZone v0.9.9.2 -- 0004: abuse limits that protect the free-tier database (500 MB) from a modified client.
-- Run AFTER 0003, once. Behaviour for normal use is unchanged.
--   * at most 20 open (unclosed, unexpired) reservations per user
--   * at most 500 failures reported per settle call (a normal call reports ~10)
--   * at most 3000 detailed usage_events rows per user per rolling day (the authoritative counters are unaffected)

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
  fail_add := least(greatest(coalesce(p_failed, 0), 0), 500);
  if ok_add + fail_add > 0 then
    insert into public.usage_daily(user_id, day, plan, ok, failed)
    values (uid, r.day, r.plan, ok_add, fail_add)
    on conflict (user_id, day, plan)
    do update set ok = public.usage_daily.ok + excluded.ok,
                  failed = public.usage_daily.failed + excluded.failed;
  end if;
  if jsonb_typeof(coalesce(p_events, '[]'::jsonb)) = 'array'
     and (select count(*) from public.usage_events where user_id = uid and at > now() - interval '1 day') < 3000 then
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
