-- Version lifecycle: extends the existing app_versions/"latest version" system
-- with an explicit active/inactive state, so the admin can retire a shipped
-- version and have the SERVER refuse to authorize it. get_latest_version(),
-- admin_set_latest_version() and their tests keep working unchanged.

alter table public.app_versions
  add column is_active    boolean not null default true,
  add column update_title text,
  add column features     text,
  add column bugfixes     text;

-- A version marked Latest must also be Active. This is the hard backstop;
-- admin_upsert_version()/admin_set_version_active() also check it up front
-- with a friendlier error before ever reaching this constraint.
alter table public.app_versions
  add constraint app_versions_latest_implies_active check (not is_latest or is_active);

-- ---------------------------------------------------------------------------
-- Single source of truth for "is this version allowed to run" + "what should
-- the client know about updates". Reused by get_version_status() (anonymous,
-- pre-login), heartbeat() (authenticated, periodic) and reserve_generations()
-- (authenticated - the actual enforcement point) so the rule lives in exactly
-- one place. NOT granted to clients directly (see privileges block).
--
-- An unregistered/unknown version (null, blank, or no matching row) comes
-- back inactive - this is deliberate: only versions the admin has explicitly
-- registered are allowed to operate. That means every version actually in
-- the wild (including whatever is live today) must have a row here - see the
-- backfill at the bottom of this migration and the release-process note in
-- the accompanying plan doc.
create function public._version_info(p_version text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'requested_version', p_version,
    'is_known',   v.version is not null,
    'is_active',  coalesce(v.is_active, false),
    'status',     case when v.is_active then 'active' else 'inactive' end,
    'is_latest',  coalesce(v.is_latest, false),
    'latest_version', lv.version,
    'update_title',   lv.update_title,
    'features',       lv.features,
    'bugfixes',       lv.bugfixes,
    'notes',          lv.notes,
    'download_url',   lv.download_url,
    'released_at',    lv.released_at)
  from (select 1) x
  left join public.app_versions v  on v.version = nullif(btrim(coalesce(p_version, '')), '')
  left join public.app_versions lv on lv.is_latest
$$;

-- Anonymous + authenticated: "is MY version still allowed, and what's new".
-- Superset of get_latest_version() - kept alongside it, not instead of it.
create function public.get_version_status(p_version text) returns jsonb   -- also callable pre-login
language sql stable security definer set search_path = public, pg_temp as
$$ select public._version_info(p_version) $$;

-- heartbeat() already runs authenticated every few minutes and already
-- receives p_app_version - piggyback the same status on its existing reply
-- instead of adding a second periodic call.
create or replace function public.heartbeat(p_app_version text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user();
begin
  perform public.me();  -- makes sure the profile exists
  update public.profiles set last_seen_at = now(),
         app_version = coalesce(left(p_app_version, 32), app_version)
   where id = uid;
  return public.me() || jsonb_build_object('version_status', public._version_info(p_app_version));
end $$;

-- The real gate. Generation already requires this authenticated, network
-- -required call, and it already fails closed with no network - so this is
-- the one place a version block can't be bypassed by a stale/patched client.
-- Body is 0004's (the current final version, including its abuse-limit
-- caps) with exactly one addition: the version-active check, right after
-- the existing suspended check.
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

-- ---------------------------------------------------------------- admin API
create function public.admin_list_versions() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(to_jsonb(v) order by v.released_at desc) from public.app_versions v), '[]');
end $$;

-- One write path for both new releases and edits of an existing one, keyed
-- on version (the table's primary key) - mirrors admin_set_latest_version's
-- existing upsert style. Enforces "Latest implies Active" itself (friendlier
-- error than the raw constraint) before ever reaching it.
create function public.admin_upsert_version(p_version text, p_active boolean default true,
    p_latest boolean default false, p_download_url text default null, p_update_title text default null,
    p_features text default null, p_bugfixes text default null, p_notes text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if p_version is null or btrim(p_version) = '' then raise exception 'version is required'; end if;
  if coalesce(p_latest, false) and not coalesce(p_active, true) then
    raise exception 'A version marked Latest must also be Active.';
  end if;
  if coalesce(p_latest, false) then
    update public.app_versions set is_latest = false where is_latest and version <> p_version;
  end if;
  insert into public.app_versions(version, is_active, is_latest, download_url, update_title, features, bugfixes, notes)
    values (p_version, coalesce(p_active, true), coalesce(p_latest, false),
            p_download_url, p_update_title, p_features, p_bugfixes, p_notes)
  on conflict (version) do update set
    is_active = excluded.is_active, is_latest = excluded.is_latest, download_url = excluded.download_url,
    update_title = excluded.update_title, features = excluded.features, bugfixes = excluded.bugfixes,
    notes = excluded.notes;
  return (select to_jsonb(v) from public.app_versions v where v.version = p_version);
end $$;

-- Quick Active/Inactive toggle for the common case (no need to open the full
-- edit form just to kill a version). Refuses to deactivate the current
-- Latest - promote a different version to Latest first.
create function public.admin_set_version_active(p_version text, p_active boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v public.app_versions;
begin
  perform public._require_admin();
  select * into v from public.app_versions where version = p_version;
  if not found then raise exception 'unknown version'; end if;
  if v.is_latest and not coalesce(p_active, true) then
    raise exception 'This is the Latest version - mark a different version Latest before deactivating it.';
  end if;
  update public.app_versions set is_active = coalesce(p_active, true) where version = p_version;
  return (select to_jsonb(v2) from public.app_versions v2 where v2.version = p_version);
end $$;

-- Backward-compat shim: existing callers (and the old single-form Admin UI)
-- keep working unchanged, now routed through the one write path above so
-- "Latest implies Active" is enforced here too instead of being duplicated.
create or replace function public.admin_set_latest_version(p_version text, p_notes text default null,
                                                p_url text default null) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public.admin_upsert_version(p_version, true, true, p_url, null, null, null, p_notes);
end $$;

-- ------------------------------------------------------------ privileges
-- Same pattern as 0001: strip the PUBLIC-by-default EXECUTE grant Postgres
-- puts on every new function, then grant back exactly the intended surface.
revoke all on function public._version_info(text) from public, anon, authenticated;
revoke all on function public.get_version_status(text) from public, anon, authenticated;
revoke all on function public.admin_list_versions() from public, anon, authenticated;
revoke all on function public.admin_upsert_version(text, boolean, boolean, text, text, text, text, text)
  from public, anon, authenticated;
revoke all on function public.admin_set_version_active(text, boolean) from public, anon, authenticated;

grant execute on function public.get_version_status(text) to anon, authenticated;
grant execute on function
  public.admin_list_versions(),
  public.admin_upsert_version(text, boolean, boolean, text, text, text, text, text),
  public.admin_set_version_active(text, boolean)
  to authenticated;
-- _version_info stays ungranted, same as the other underscore-prefixed helpers.

-- ------------------------------------------------------------ deploy note
-- Whatever version is actually live right now must be registered + active
-- before this migration goes out, or its users get treated as "unknown" (=
-- inactive) the moment reserve_generations enforcement takes effect. If the
-- currently-live version is already the `is_latest` row (the common case),
-- this backfill covers it for free via the column DEFAULT above; the
-- statement below is a no-op unless there's no is_latest row yet to catch.
update public.app_versions set is_active = true where is_latest and not is_active;
