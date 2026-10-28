-- 0017_yank_revision_check.sql  (Step 8: optimistic-lock check for Yank / Restore)   Run AFTER 0016. Safe to re-run (idempotent).
--
-- STATUS: PREPARED ONLY. It has NOT been applied to any database (no PostgreSQL in the authoring environment, and Step 8 forbids running
-- SQL) and NOT to production. It needs explicit approval, then a run on a throw-away database with supabase/tests first.
--
-- What changes: admin_yank_addon(p_addon, p_version, p_yank) gets a 4th OPTIONAL argument p_expected_revision bigint, with exactly the
-- semantics of admin_withdraw_addon / admin_delete_addon_release (0014): the add-on's selection revision the admin last SAW. When it is given
-- and the add-on's selection (addon_active_release.revision; 0 when the add-on has no selection row yet) has moved, the call raises
-- 'stale: ... Reload the page and try again.' and changes NOTHING (no yank flag, no selection change, no audit entry).
-- NULL = no check (every existing caller keeps working: same results as 0013).
-- Behaviour otherwise unchanged: the per-add-on advisory lock, 'unknown release', yanking the offered version withdraws the selection
-- (revision + 1), restore never activates, audit entry, same return value.
--
-- Why DROP + CREATE: a 3-argument and a 4-argument-with-default function side by side make a call with three arguments ambiguous in
-- PostgreSQL. The old 3-argument function is dropped in the same transaction and the new one gets the same privileges 0012 gave it
-- (admins only, through _require_admin(); EXECUTE for the 'authenticated' role like every other admin_* function; never anon / public).
--
-- DEPLOY ORDER: apply this migration BEFORE (or together with) the Admin build that sends p_expected_revision for Yank / Restore.
-- The previous Admin build keeps working against the new function (it sends three arguments).
-- RE-RUN ORDER: do not re-run 0012 / 0013 after this file (they would create the 3-argument function again next to the new one and a
-- 3-argument call becomes ambiguous); if that ever happens, run this file again (it drops the old form first).
-- Not changed: signing, hashes, entitlement, licensing, page switches, migrations 0001-0016.

begin;

drop function if exists public.admin_yank_addon(text, text, boolean);

create or replace function public.admin_yank_addon(p_addon text, p_version text, p_yank boolean, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.addon_releases; was_active boolean := false; s public.addon_active_release; eff text;
begin
  perform public._require_admin();
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || coalesce(p_addon, '')));
  select * into s from public.addon_active_release where addon_id = p_addon for update;
  if p_expected_revision is not null and p_expected_revision is distinct from (case when found then s.revision else 0 end) then
    raise exception 'stale: the selection for % was changed by someone else (now revision %). Reload the page and try again.',
      p_addon, (case when found then s.revision else 0 end);
  end if;
  eff := public._addon_effective_version(p_addon);                         -- what clients are being offered right now
  update public.addon_releases set yanked = coalesce(p_yank, true)
   where addon_id = p_addon and version = p_version returning * into r;
  if not found then raise exception 'unknown release'; end if;
  if coalesce(p_yank, true) and eff is not distinct from p_version then
    select * into s from public.addon_active_release where addon_id = p_addon for update;
    if found then
      update public.addon_active_release
         set mode = 'withdrawn', active_version = null, previous_version = p_version, revision = revision + 1,
             updated_by = auth.uid(), updated_at = now()
       where addon_id = p_addon;
      was_active := true;
    end if;
  end if;
  perform public._audit(case when coalesce(p_yank, true) then 'addon_yank' else 'addon_restore' end, p_addon,
                        jsonb_build_object('version', p_version, 'was_active', was_active));
  return to_jsonb(r) || jsonb_build_object('was_active', was_active, 'selection_withdrawn', was_active);
end $$;

revoke all on function public.admin_yank_addon(text, text, boolean, bigint) from public, anon, authenticated;
grant execute on function public.admin_yank_addon(text, text, boolean, bigint) to authenticated;

commit;
