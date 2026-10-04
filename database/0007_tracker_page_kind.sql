-- MetaZone v0.9.9.5 / migration 0007 -- Adobe Tracker joins the page-access check.
-- Run once in the Supabase SQL editor AFTER 0001-0006. Safe to re-run (create or replace).
-- Optional for the app: a server without 0007 simply does not page-check kind 'tracker' (the app keeps working,
-- the Tracker page switch then only hides the page, it does not stop Image-to-Prompt generations).
-- create or replace keeps the existing grants on reserve_generations, so no privilege statements are needed.

-- ---------------------------------------------------------------- the server-side gate
-- Body = 0006's reserve_generations, unchanged except ONE token: 'tracker' joins the kinds that are page-checked, so
-- the Admin 'Tracker' page switch also stops Adobe Tracker's Image-to-Prompt from spending generations.
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
  -- v0.9.9.4 (0006) / v0.9.9.5 (0007 adds 'tracker'): page switched off for this user -> no generation slot for that page's feature.
  if p_kind in ('meta', 'prompt', 'p2p', 'tracker') and not public._page_enabled(uid, p_kind) then
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
