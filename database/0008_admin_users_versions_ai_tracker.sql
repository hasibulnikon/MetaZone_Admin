-- MetaZone v0.9.9.5.2 / migration 0008
--   1. profiles.nickname              -- admin-only display name, NOT an identity (auth.users / profiles.email untouched)
--   2. admin_set_nickname()           -- set / edit / clear
--   3. admin_delete_user()            -- server-side, admin-only, typed-email confirmation, cascades the user's own rows only
--   4. admin_delete_version()         -- refuses Latest; refuses a version still in use unless forced; never touches installer files
--   5. ai_access + admin_*_ai_access() + get_ai_access()  -- admin ON/OFF for Meta Generator providers / models (Apify is NOT here)
--   6. tracker_search_events + record_tracker_search()    -- Adobe Tracker SEARCH counts, separate from generations / prompts / Apify usage
--   7. admin_list_users() / admin_overview() extended (nickname, tracker searches)
-- Every admin_* function starts with _require_admin(): the server is the authority, hiding a button is cosmetic.

-- ------------------------------------------------------------------ 1. nickname
alter table public.profiles add column if not exists nickname text;
alter table public.profiles drop constraint if exists profiles_nickname_len;
alter table public.profiles add constraint profiles_nickname_len check (nickname is null or char_length(nickname) <= 60);

create function public.admin_set_nickname(p_user uuid, p_nickname text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n text := nullif(btrim(coalesce(p_nickname, '')), '');
begin
  perform public._require_admin();
  if n is not null and char_length(n) > 60 then raise exception 'nickname_too_long'; end if;
  update public.profiles set nickname = n where id = p_user;
  if not found then raise exception 'user_not_found'; end if;
  return jsonb_build_object('id', p_user, 'nickname', n);
end $$;

-- ------------------------------------------------------------------ 6. tracker searches (before list_users, which reads it)
create table public.tracker_search_events (
  id          bigserial primary key,
  user_id     uuid not null references public.profiles(id) on delete cascade,
  searched_at timestamptz not null default now(),
  mode        text
);
create index tracker_search_events_user_time on public.tracker_search_events(user_id, searched_at desc);
create index tracker_search_events_time on public.tracker_search_events(searched_at desc);
alter table public.tracker_search_events enable row level security;       -- no policies: only the functions below touch it

-- One row per search the person STARTS in Adobe Tracker (not a generation, not an Image-to-Prompt job, not an Apify call).
create function public.record_tracker_search(p_mode text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); m text := nullif(left(btrim(coalesce(p_mode, '')), 20), '');
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if not exists (select 1 from public.profiles where id = uid) then return jsonb_build_object('ok', false); end if;
  -- abuse backstop: at most 600 recorded searches per hour per account
  if (select count(*) from public.tracker_search_events where user_id = uid and searched_at > now() - interval '1 hour') >= 600 then
    return jsonb_build_object('ok', true, 'recorded', false);
  end if;
  insert into public.tracker_search_events(user_id, mode) values (uid, m);
  return jsonb_build_object('ok', true, 'recorded', true);
end $$;

-- ------------------------------------------------------------------ 7. admin_list_users / admin_overview (replace)
create or replace function public.admin_list_users(p_search text default null, p_limit integer default 50,
                                        p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare res jsonb; t date := public.mz_today(); ws date := public.mz_week_start(); ms date := public.mz_month_start();
begin
  perform public._require_admin();
  select coalesce(jsonb_agg(row_to_json(q)::jsonb order by q.created_at desc), '[]'::jsonb) into res from (
    select p.id, p.nickname, p.email, p.status, p.created_at, p.last_seen_at, p.app_version,
           case when s.expires_at > now() then 'premium' else 'free' end as plan,
           s.started_at as premium_started_at, s.expires_at as premium_expires_at,
           coalesce(sum(u.ok) filter (where u.day = t), 0)  as today,
           coalesce(sum(u.ok) filter (where u.day >= ws), 0) as week,
           coalesce(sum(u.ok) filter (where u.day >= ms), 0) as month,
           coalesce(sum(u.ok), 0) as total,
           (select count(*) from public.tracker_search_events e where e.user_id = p.id) as tracker_searches,
           (select count(*) from public.tracker_search_events e where e.user_id = p.id
              and (e.searched_at at time zone public.cfg_text('day_timezone'))::date = t) as tracker_searches_today,
           exists (select 1 from public.admin_users a where a.user_id = p.id) as is_admin
      from public.profiles p
      left join public.subscriptions s on s.user_id = p.id
      left join public.usage_daily u on u.user_id = p.id
     where p_search is null or p.email ilike '%' || p_search || '%' or p.nickname ilike '%' || p_search || '%' or p.id::text = p_search
     group by p.id, s.user_id
     order by p.created_at desc
     limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) q;
  return res;
end $$;

create function public.admin_tracker_search_stats() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare t date := public.mz_today();
begin
  perform public._require_admin();
  return jsonb_build_object(
    'total', (select count(*) from public.tracker_search_events),
    'today', (select count(*) from public.tracker_search_events where (searched_at at time zone public.cfg_text('day_timezone'))::date = t),
    'week',  (select count(*) from public.tracker_search_events where (searched_at at time zone public.cfg_text('day_timezone'))::date >= public.mz_week_start()),
    'month', (select count(*) from public.tracker_search_events where (searched_at at time zone public.cfg_text('day_timezone'))::date >= public.mz_month_start()),
    'users_today', (select count(distinct user_id) from public.tracker_search_events where (searched_at at time zone public.cfg_text('day_timezone'))::date = t));
end $$;

-- ------------------------------------------------------------------ 3. delete user
-- Deletes the auth identity; every per-user table (profiles, subscriptions, subscription_events, usage_*, notice_seen,
-- page overrides, tracker_search_events) is `on delete cascade` from auth.users/profiles, so nothing is orphaned. Global data
-- (app_config, notices, app_versions, page defaults, ai_access) has no per-user rows and is untouched.
create function public.admin_delete_user(p_user uuid, p_confirm_email text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.profiles;
begin
  perform public._require_admin();
  select * into p from public.profiles where id = p_user;
  if not found then raise exception 'user_not_found'; end if;
  if p_user = auth.uid() then raise exception 'cannot_delete_yourself'; end if;
  if exists (select 1 from public.admin_users where user_id = p_user) then raise exception 'cannot_delete_an_admin'; end if;
  if lower(btrim(coalesce(p_confirm_email, ''))) <> lower(coalesce(p.email, '')) then raise exception 'confirmation_mismatch'; end if;
  delete from auth.users where id = p_user;
  return jsonb_build_object('deleted', true, 'id', p_user, 'email', p.email);
end $$;

-- ------------------------------------------------------------------ 4. delete version
-- Only the version-control ROW. The installer file (Google Drive / GitHub / ...) is never touched: this database holds a URL, not the file.
-- Refused when it is the Latest (the updater would have nothing to offer and nobody could be told to update).
-- A version some users still run becomes "unregistered" = inactive = forced update (0005's rule), so that needs p_force.
create function public.admin_delete_version(p_version text, p_force boolean default false) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.app_versions; in_use integer; latest text;
begin
  perform public._require_admin();
  select * into v from public.app_versions where version = p_version;
  if not found then raise exception 'version_not_found'; end if;
  if v.is_latest then raise exception 'cannot_delete_latest_version'; end if;
  select version into latest from public.app_versions where is_latest;
  if latest is null then raise exception 'no_latest_version_set'; end if;
  select count(*) into in_use from public.profiles where app_version = p_version;
  if in_use > 0 and not coalesce(p_force, false) then
    raise exception 'version_in_use:%', in_use;
  end if;
  delete from public.app_versions where version = p_version;
  return jsonb_build_object('deleted', true, 'version', p_version, 'users_still_on_it', in_use, 'latest', latest);
end $$;

-- ------------------------------------------------------------------ 5. Meta Generator provider / model access (Apify is NOT part of this)
-- One row per explicit admin decision; no row = allowed. model = '' is the provider-level switch.
create table public.ai_access (
  provider   text not null check (btrim(provider) <> ''),
  model      text not null default '',
  enabled    boolean not null,
  updated_at timestamptz not null default now(),
  primary key (provider, model)
);
alter table public.ai_access enable row level security;

create function public.admin_list_ai_access() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'model', model, 'enabled', enabled) order by provider, model) from public.ai_access), '[]'::jsonb);
end $$;

create function public.admin_set_ai_access(p_provider text, p_model text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr text := btrim(coalesce(p_provider, '')); m text := btrim(coalesce(p_model, ''));
begin
  perform public._require_admin();
  if pr = '' or char_length(pr) > 60 or char_length(m) > 120 then raise exception 'invalid_provider_or_model'; end if;
  if lower(pr) like '%apify%' then raise exception 'apify_is_not_a_meta_generator_provider'; end if;
  if coalesce(p_enabled, true) then
    delete from public.ai_access where provider = pr and model = m;                      -- back to the default (allowed)
  else
    insert into public.ai_access(provider, model, enabled) values (pr, m, false)
      on conflict (provider, model) do update set enabled = false, updated_at = now();
  end if;
  return public.admin_list_ai_access();
end $$;

-- What the APP asks (any signed-in user): only the switched-OFF items, so the payload is tiny and carries no admin data.
create function public.get_ai_access() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  return jsonb_build_object(
    'providers', coalesce((select jsonb_agg(provider order by provider) from public.ai_access where model = '' and not enabled), '[]'::jsonb),
    'models', coalesce((select jsonb_agg(jsonb_build_object('provider', provider, 'model', model) order by provider, model) from public.ai_access where model <> '' and not enabled), '[]'::jsonb));
end $$;

-- ------------------------------------------------------------------ privileges (same pattern as 0005 / 0006)
revoke all on function public.admin_set_nickname(uuid, text) from public, anon, authenticated;
revoke all on function public.record_tracker_search(text) from public, anon, authenticated;
revoke all on function public.admin_tracker_search_stats() from public, anon, authenticated;
revoke all on function public.admin_delete_user(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_delete_version(text, boolean) from public, anon, authenticated;
revoke all on function public.admin_list_ai_access() from public, anon, authenticated;
revoke all on function public.admin_set_ai_access(text, text, boolean) from public, anon, authenticated;
revoke all on function public.get_ai_access() from public, anon, authenticated;
revoke all on table public.tracker_search_events, public.ai_access from public, anon, authenticated;
revoke all on sequence public.tracker_search_events_id_seq from public, anon, authenticated;     -- Supabase grants new sequences to clients by default

grant execute on function
  public.admin_set_nickname(uuid, text),
  public.record_tracker_search(text),
  public.admin_tracker_search_stats(),
  public.admin_delete_user(uuid, text),
  public.admin_delete_version(text, boolean),
  public.admin_list_ai_access(),
  public.admin_set_ai_access(text, text, boolean),
  public.get_ai_access()
  to authenticated;
-- admin_list_users keeps its existing grant (create or replace preserves ACLs).
