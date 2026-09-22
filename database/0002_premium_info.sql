-- MetaZone v0.9.9.2 -- 0002: Premium payment info (bKash number, price, instructions) managed from the Admin app.
-- Run AFTER 0001. Safe to run once; CREATE OR REPLACE keeps the existing privileges on me() / admin_set_config().
--
-- The values live in app_config (text keys below), are editable only through admin_set_config() (admin only),
-- and are delivered to signed-in users inside me() -> "premium_info". Nothing is hardcoded in the desktop client.

insert into public.app_config(key, value) values
  ('premium_price_text',   '""'::jsonb),
  ('premium_bkash_number', '""'::jsonb),
  ('premium_contact_text', '""'::jsonb),
  ('premium_instructions', to_jsonb('Pay the subscription fee via bKash, then send your Google account email and payment proof to the administrator. Premium is activated on your account after verification.'::text))
on conflict (key) do nothing;

create function public.premium_info() returns jsonb
language sql stable security definer set search_path = public, pg_temp as
$$ select jsonb_build_object(
     'price_text',   coalesce(public.cfg_text('premium_price_text'), ''),
     'bkash_number', coalesce(public.cfg_text('premium_bkash_number'), ''),
     'contact_text', coalesce(public.cfg_text('premium_contact_text'), ''),
     'instructions', coalesce(public.cfg_text('premium_instructions'), '')) $$;
-- new functions are executable by PUBLIC by default; only me() (SECURITY DEFINER) needs to call this one
revoke all on function public.premium_info() from public, anon, authenticated;

-- me(): identical to 0001 plus "premium_info"
create or replace function public.me() returns jsonb
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
    'premium_info', public.premium_info(),
    'heartbeat_interval_seconds', public.cfg_int('heartbeat_interval_seconds'),
    'offline_grace_hours', public.cfg_int('offline_grace_hours'),
    'server_time', now());
end $$;

-- admin_set_config(): numeric keys stay numeric; the timezone and the premium_* keys are text
create or replace function public.admin_set_config(p_key text, p_value jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  text_keys constant text[] := array['premium_price_text','premium_bkash_number','premium_contact_text','premium_instructions'];
begin
  perform public._require_admin();
  if not exists (select 1 from public.app_config where key = p_key) then
    raise exception 'unknown config key'; end if;
  if p_key = 'day_timezone' then
    if jsonb_typeof(p_value) <> 'string' or not exists (select 1 from pg_timezone_names where name = p_value #>> '{}') then
      raise exception 'unknown timezone'; end if;
  elsif p_key = any (text_keys) then
    if jsonb_typeof(p_value) <> 'string' or length(p_value #>> '{}') > 600 then
      raise exception 'value must be text of at most 600 characters'; end if;
    p_value := to_jsonb(btrim(p_value #>> '{}'));
  else
    if jsonb_typeof(p_value) <> 'number' or (p_value #>> '{}')::numeric < 0 then
      raise exception 'value must be a non-negative number'; end if;
  end if;
  update public.app_config set value = p_value, updated_at = now() where key = p_key;
end $$;
