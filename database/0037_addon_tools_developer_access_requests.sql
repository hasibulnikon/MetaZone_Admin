-- 0037 (v1.0.0, 9th Edition, Addon Tools V5 Part 12): DEVELOPER OPTIONS ACCESS REQUESTS (user side). Run AFTER 0036.
-- Forward-only, idempotent, ONE transaction. NOT applied to any database yet and NOT executed against any PostgreSQL (none was available).
-- The identical file lives in MetaZone_App/supabase/migrations/ and MetaZone_Admin/database/.
--
-- WHAT THIS IS.  A user who is not allowed to use Developer Options / Developer Import can ASK an administrator for access, and can see the state of
-- their own request. A request is only a note for the admin. It NEVER grants anything: this file never writes
-- addon_tools_developer_access or addon_tools_developer_settings (it only ASKS the 0036 rule), and it does not change that rule. Access stays decided ONLY by
-- _addon_tools_developer_import_reason / _allowed (global switch, personal decision, Free / Premium switch). Approving / declining a request and
-- notifying admins are NOT here (Part 13); a request just waits as 'pending'.
--
-- WHAT IT ADDS
--   table    addon_tools_developer_requests   one row per request: id, user_id, status (pending | approved | declined), optional message (<= 500 chars),
--                                             created_at, decided_at, decided_by. Closed to every client role (RLS on, no policy, no grant).
--            ONE pending request per user is guaranteed by a partial UNIQUE index (also under concurrent calls).
--   internal _addon_tools_developer_request_gate(user)   the ONE place that says whether the user may submit now (code + retry_after). No grants.
--            _addon_tools_developer_request_json(row)    the user-visible shape of a request (never the admin's id). No grants.
--   user     addon_tools_request_developer_access(p_message)   submit a request for the CALLER (identity = auth.uid(); there is no user-id argument)
--            addon_tools_my_developer_request()                the caller's latest request + whether they can submit now. Own data only.
--
-- RULES (server side, in the gate)
--   already_allowed  the 0036 rule already allows this user              -> no request (nothing to ask for)
--   pending          the user already has a pending request              -> no second one (partial unique index is the backstop)
--   cooldown         the latest request was decided (declined, or approved but the user is not allowed now) less than 24 hours ago -> wait
--                    (24 h counted from decided_at; keeps a declined user from re-sending at once, and lets them ask again the next day)
--   ok               otherwise a new pending request is created. Older decided requests stay as history; the user sees the latest one only.
-- A request is accepted even while the global Developer Options switch is OFF: the user cannot see why they are blocked, and the admin decides.
-- Expected refusals are returned as {ok:false, code:...} (not as SQL errors). Not signed in = SQL error 'not authenticated' (_require_user).
--
-- FOR PART 13: it only needs to set status ('approved' | 'declined'), decided_at (= now()) and decided_by on a pending row. The check constraint
-- requires decided_at to be NULL exactly while status = 'pending'. Part 13 must grant access through the existing 0036 admin RPCs, not here.

begin;

do $$ begin
  if to_regclass('public.profiles') is null
     or to_regclass('public.addon_tools_developer_access') is null
     or to_regclass('public.addon_tools_developer_settings') is null
     or to_regprocedure('public._addon_tools_developer_import_reason(uuid)') is null
     or to_regprocedure('public._addon_tools_developer_import_allowed(uuid)') is null
     or to_regprocedure('public._require_user()') is null then
    raise exception '0037 needs 0036 (Developer Options access controls): run the earlier migrations first';
  end if;
end $$;

-- ====================================================================== A. table (closed: RPC access only)
create table if not exists public.addon_tools_developer_requests (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  status     text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  message    text check (message is null or char_length(message) <= 500),
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  decided_by uuid,
  check ((status = 'pending') = (decided_at is null))
);
create unique index if not exists addon_tools_developer_requests_one_pending on public.addon_tools_developer_requests (user_id) where status = 'pending';
create index if not exists addon_tools_developer_requests_user_idx on public.addon_tools_developer_requests (user_id, created_at desc);
create index if not exists addon_tools_developer_requests_pending_idx on public.addon_tools_developer_requests (created_at) where status = 'pending';   -- for the Admin list (Part 13)

alter table public.addon_tools_developer_requests enable row level security;
revoke all on public.addon_tools_developer_requests from public, anon, authenticated;     -- no policy + no grant = no direct access at all

-- ====================================================================== B. internal helpers
create or replace function public._addon_tools_developer_request_json(r public.addon_tools_developer_requests) returns jsonb
language sql immutable set search_path = public, pg_temp as $$
  select case when r.id is null then null
    else jsonb_build_object('status', r.status, 'message', r.message, 'created_at', r.created_at, 'decided_at', r.decided_at) end
$$;

-- {can_request, code, retry_after}. The ONLY place that decides whether a new request may be created.
create or replace function public._addon_tools_developer_request_gate(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.addon_tools_developer_requests; v_until timestamptz;
begin
  if public._addon_tools_developer_import_allowed(p_user) then
    return jsonb_build_object('can_request', false, 'code', 'already_allowed', 'retry_after', null);
  end if;
  select * into r from public.addon_tools_developer_requests where user_id = p_user order by created_at desc, id limit 1;
  if r.id is not null and r.status = 'pending' then
    return jsonb_build_object('can_request', false, 'code', 'pending', 'retry_after', null);
  end if;
  if r.id is not null then
    v_until := coalesce(r.decided_at, r.created_at) + interval '24 hours';
    if v_until > now() then
      return jsonb_build_object('can_request', false, 'code', 'cooldown', 'retry_after', v_until);
    end if;
  end if;
  return jsonb_build_object('can_request', true, 'code', 'ok', 'retry_after', null);
end $$;

-- ====================================================================== C. user RPCs (the caller's own data only)
create or replace function public.addon_tools_request_developer_access(p_message text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); v_msg text; g jsonb; r public.addon_tools_developer_requests;
begin
  v_msg := nullif(btrim(coalesce(p_message, '')), '');
  if v_msg is not null and char_length(v_msg) > 500 then return jsonb_build_object('ok', false, 'code', 'message_too_long'); end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools_dev_request:' || uid::text));
  g := public._addon_tools_developer_request_gate(uid);
  if (g->>'can_request')::boolean is not true then
    select * into r from public.addon_tools_developer_requests where user_id = uid order by created_at desc, id limit 1;
    return jsonb_build_object('ok', false, 'created', false, 'code', g->>'code', 'retry_after', g->'retry_after', 'request', public._addon_tools_developer_request_json(r));
  end if;
  begin
    insert into public.addon_tools_developer_requests (user_id, message) values (uid, v_msg) returning * into r;     -- user_id is ALWAYS the session's user
  exception when unique_violation then
    select * into r from public.addon_tools_developer_requests where user_id = uid order by created_at desc, id limit 1;
    return jsonb_build_object('ok', false, 'created', false, 'code', 'pending', 'retry_after', null, 'request', public._addon_tools_developer_request_json(r));
  end;
  return jsonb_build_object('ok', true, 'created', true, 'code', 'created', 'retry_after', null, 'request', public._addon_tools_developer_request_json(r));
end $$;

create or replace function public.addon_tools_my_developer_request() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); g jsonb; r public.addon_tools_developer_requests;
begin
  select * into r from public.addon_tools_developer_requests where user_id = uid order by created_at desc, id limit 1;
  g := public._addon_tools_developer_request_gate(uid);
  return jsonb_build_object('request', public._addon_tools_developer_request_json(r), 'can_request', (g->>'can_request')::boolean,
                            'code', g->>'code', 'retry_after', g->'retry_after');
end $$;

-- ====================================================================== D. privileges
revoke all on function
  public._addon_tools_developer_request_json(public.addon_tools_developer_requests), public._addon_tools_developer_request_gate(uuid),
  public.addon_tools_request_developer_access(text), public.addon_tools_my_developer_request()
  from public, anon, authenticated;
grant execute on function public.addon_tools_request_developer_access(text), public.addon_tools_my_developer_request() to authenticated;   -- internal helpers: no grants

commit;
