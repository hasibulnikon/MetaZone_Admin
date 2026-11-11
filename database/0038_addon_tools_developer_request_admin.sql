-- 0038 (v1.0.0, 9th Edition, Addon Tools V5 Part 13): DEVELOPER OPTIONS ACCESS REQUESTS, ADMIN SIDE. Run AFTER 0037 (needs 0035 + 0036 + 0037).
-- Forward-only, idempotent, ONE transaction. NOT applied to any database yet; it has only been run on a throw-away local PostgreSQL 16 with stub
-- helpers (see HANDOFF_ADDON_TOOLS_PART13.md), never on Supabase.
-- The identical file lives in MetaZone_App/supabase/migrations/ and MetaZone_Admin/database/.
--
-- NO NEW TABLE. It reuses addon_tools_developer_requests (0037) and its constraints (status pending|approved|declined; decided_at is NULL exactly while
-- pending; partial unique index = one pending request per user). 0035 / 0036 / 0037 are not changed: the 0036 rule (global > personal > plan) is untouched
-- and the user-side RPCs (addon_tools_request_developer_access / addon_tools_my_developer_request) keep their exact behaviour and shape.
--
-- WHAT IT ADDS (all admin-only: each one calls _require_admin() first, so a normal user gets 'forbidden'; none is granted to anon)
--   admin_addon_tools_list_developer_requests(p_status, p_limit)   the requests with identity (email, nickname), plan, message, dates, who decided,
--                                                                 and what the 0036 rule says for the user NOW (allowed_now + reason). Pending first.
--   admin_addon_tools_developer_request_summary()                  {pending_count, newest[]}: what the Admin screen shows as the "new request" notice.
--   admin_addon_tools_decide_developer_request(p_request_id, p_decision)   'approved' | 'declined', ONE transaction:
--        1. per-user advisory lock (the SAME key the user-side submit takes) + FOR UPDATE on the request row  -> two Admins / an Admin and a submit can't interleave
--        2. only a request that is STILL 'pending' can be decided; otherwise {ok:false, code:'already_decided'} and NOTHING is written
--        3. approve: refuses (code 'personal_off', nothing written) when the user has a personal OFF (an Admin's explicit block is not silently overwritten:
--           reset or allow the user first); otherwise grants through the EXISTING 0036 RPC admin_addon_tools_set_developer_import(user, true) = a personal ON
--           (same Admin authorisation, same audit row 'developer_import_set'). That is the ONLY way access is granted here. If any part fails the whole
--           call rolls back, so a request is never 'approved' without the grant, and never granted without a decided request.
--        4. decline: writes the decision only. It never touches addon_tools_developer_access or addon_tools_developer_settings.
--        5. sets status, decided_at = now(), decided_by = auth.uid() (the session, never a parameter) and writes ONE audit row 'developer_request_decided'.
--      The answer carries allowed_now / reason as the 0036 rule says AFTER the decision: an approval while the global switch is OFF is recorded and the
--      personal ON is stored, but allowed_now stays false (reason 'global_off'). Approval never bypasses the global, personal-OFF or plan rules.
--
-- NOTIFICATION. No Admin notification system exists in this code base (searched SQL, Admin JS, Main App). The smallest fitting solution is NOT a new
-- table: a pending request IS the notification. The summary RPC reads the pending rows, so there is exactly one notice per request (no duplicates
-- possible, nothing can drift), it names the user, and it goes away by itself when the request is decided. No e-mail / push is sent.
-- decided_by is returned to Admins only (as decided_by_email); the user RPCs still never expose it.

begin;

do $$ begin
  if to_regclass('public.addon_tools_developer_requests') is null
     or to_regprocedure('public.admin_addon_tools_set_developer_import(uuid, boolean)') is null
     or to_regprocedure('public._addon_tools_developer_import_reason(uuid)') is null
     or to_regprocedure('public._addon_tools_audit(text, text, text, jsonb)') is null
     or to_regprocedure('public._require_admin()') is null then
    raise exception '0038 needs 0037 (Developer Options access requests) and 0036: run the earlier migrations first';
  end if;
end $$;

-- ====================================================================== A. internal: admin view of one request (never granted)
create or replace function public._addon_tools_developer_request_admin_json(r public.addon_tools_developer_requests) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select case when r.id is null then null else jsonb_build_object(
    'id', r.id, 'user_id', r.user_id, 'email', p.email, 'nickname', p.nickname, 'plan', public.mz_plan(r.user_id),
    'status', r.status, 'message', r.message, 'created_at', r.created_at, 'decided_at', r.decided_at,
    'decided_by_email', (select d.email from public.profiles d where d.id = r.decided_by),
    'allowed_now', public._addon_tools_developer_import_allowed(r.user_id),
    'reason', public._addon_tools_developer_import_reason(r.user_id)) end
  from (select 1) x left join public.profiles p on p.id = r.user_id
$$;

-- ====================================================================== B. admin: list
-- p_status NULL = all, or 'pending' | 'approved' | 'declined'. Pending first (oldest first, so nothing waits forever), then decided (newest first).
create or replace function public.admin_addon_tools_list_developer_requests(p_status text default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if p_status is not null and p_status not in ('pending', 'approved', 'declined') then raise exception 'invalid status filter'; end if;
  if p_limit is null or p_limit < 1 or p_limit > 200 then raise exception 'limit must be 1-200'; end if;
  return coalesce((
    select jsonb_agg(public._addon_tools_developer_request_admin_json(q.rq) order by (q.rq).status = 'pending' desc,
                     case when (q.rq).status = 'pending' then (q.rq).created_at end asc, (q.rq).decided_at desc nulls last, (q.rq).id)
      from (select r as rq from public.addon_tools_developer_requests r where p_status is null or r.status = p_status
             order by (r.status = 'pending') desc, case when r.status = 'pending' then r.created_at end asc, r.decided_at desc nulls last, r.id
             limit p_limit) q), '[]'::jsonb);
end $$;

-- ====================================================================== C. admin: the notification (derived from the pending rows)
create or replace function public.admin_addon_tools_developer_request_summary() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'pending_count', (select count(*) from public.addon_tools_developer_requests where status = 'pending'),
    'newest', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'user_id', n.user_id, 'email', p.email, 'created_at', n.created_at) order by n.created_at desc, n.id)
                          from (select r.* from public.addon_tools_developer_requests r where r.status = 'pending' order by r.created_at desc, r.id limit 5) n
                          left join public.profiles p on p.id = n.user_id), '[]'::jsonb));
end $$;

-- ====================================================================== D. admin: decide (one transaction)
create or replace function public.admin_addon_tools_decide_developer_request(p_request_id uuid, p_decision text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_user uuid; r public.addon_tools_developer_requests; g jsonb; v_before text; v_grant boolean := false;
begin
  perform public._require_admin();
  if p_request_id is null then raise exception 'choose a request'; end if;
  if p_decision is null or p_decision not in ('approved', 'declined') then raise exception 'decision must be approved or declined'; end if;
  select user_id into v_user from public.addon_tools_developer_requests where id = p_request_id;
  if v_user is null then return jsonb_build_object('ok', false, 'code', 'not_found', 'request', null); end if;
  -- same advisory key as addon_tools_request_developer_access, THEN the row lock: a concurrent decision waits here and then sees the new status
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools_dev_request:' || v_user::text));
  select * into r from public.addon_tools_developer_requests where id = p_request_id for update;
  if not found then return jsonb_build_object('ok', false, 'code', 'not_found', 'request', null); end if;
  if r.status <> 'pending' then
    return jsonb_build_object('ok', false, 'code', 'already_decided', 'request', public._addon_tools_developer_request_admin_json(r),
                              'allowed_now', public._addon_tools_developer_import_allowed(r.user_id), 'reason', public._addon_tools_developer_import_reason(r.user_id));
  end if;
  v_before := public._addon_tools_developer_import_reason(r.user_id);
  if p_decision = 'approved' then
    if v_before = 'override_off' then      -- an explicit personal block is never silently replaced; nothing has been written yet
      return jsonb_build_object('ok', false, 'code', 'personal_off', 'request', public._addon_tools_developer_request_admin_json(r),
                                'allowed_now', false, 'reason', v_before);
    end if;
    g := public.admin_addon_tools_set_developer_import(r.user_id, true);                 -- the existing 0036 mechanism (admin check, lock, audit)
    if g is null or g->>'override' is distinct from 'true' then raise exception 'the access grant was not confirmed; nothing was changed'; end if;
    v_grant := true;
  end if;
  update public.addon_tools_developer_requests set status = p_decision, decided_at = now(), decided_by = auth.uid()
   where id = r.id and status = 'pending' returning * into r;
  if not found then raise exception 'the request changed while deciding; nothing was changed'; end if;
  perform public._addon_tools_audit('developer_request_decided', null, null, jsonb_build_object(
    'request_id', r.id, 'user_id', r.user_id, 'decision', p_decision, 'granted', v_grant,
    'allowed_now', public._addon_tools_developer_import_allowed(r.user_id), 'reason', public._addon_tools_developer_import_reason(r.user_id), 'was_reason', v_before));
  return jsonb_build_object('ok', true, 'code', p_decision, 'granted', v_grant, 'request', public._addon_tools_developer_request_admin_json(r),
                            'allowed_now', public._addon_tools_developer_import_allowed(r.user_id), 'reason', public._addon_tools_developer_import_reason(r.user_id));
end $$;

-- ====================================================================== E. privileges
revoke all on function
  public._addon_tools_developer_request_admin_json(public.addon_tools_developer_requests),
  public.admin_addon_tools_list_developer_requests(text, integer), public.admin_addon_tools_developer_request_summary(),
  public.admin_addon_tools_decide_developer_request(uuid, text)
  from public, anon, authenticated;
grant execute on function
  public.admin_addon_tools_list_developer_requests(text, integer), public.admin_addon_tools_developer_request_summary(),
  public.admin_addon_tools_decide_developer_request(uuid, text)
  to authenticated;                                    -- every admin_* refuses non-admins inside (_require_admin); the internal helper has no grant

commit;
