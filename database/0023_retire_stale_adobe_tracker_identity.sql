-- 0023 (v1.0.1; app version unchanged): retire the stale 'adobe_tracker' identity. Run AFTER 0001..0022. Forward-only, idempotent, one transaction.
--
-- WHY.  Two ids exist for the same product:
--     tracker          the REAL built-in Tracker page (page_flags row, restored by 0020).  KEPT, never touched here.
--     adobe_tracker    the stale / duplicate identity of the old Tracker ADD-ON (add-on registry row, its releases, and - on databases where
--                      an admin created it by hand while the add-on was being rebuilt - a page_flags row). It shows up next to the real
--                      Tracker in Admin and must go.
--
-- WHY NOT 0019.  0019 removes the page_flags row 'tracker', its overrides and the Tracker search objects. Re-running it would REMOVE the working
--   Tracker page (0020 exists precisely to undo it). This file never deletes, edits or re-registers 'tracker', never touches
--   user_page_overrides rows of 'tracker', reserve_generations, the Tracker plan defaults or the Dashboard shortcut list entry 'tracker'.
--
-- WHAT THIS FILE DOES
--   A. Safety stops (nothing is changed when one fires): the real 'tracker' page row is missing (0020 not applied) or 'tracker' is on the
--      retired list; some OTHER add-on's release still uses the feature key 'adobe_tracker' (deleting that page row would break it).
--   B. public.retired_addon_ids: a tiny list of add-on ids that may never be registered or published again (no client access, like every table).
--   C. Removes the identity: every release of add-on 'adobe_tracker' gets a tombstone first (the version/seq can never be published again, and a
--      YANKED release stays on the revoked list apps receive - exactly what admin_delete_addon does), then its selection row, releases and registry
--      row are deleted. The page_flags row 'adobe_tracker' (if it exists) is deleted together with its user_page_overrides. A saved Dashboard
--      shortcut list loses the entry 'adobe_tracker' (order kept), if it holds one.
--   D. 'adobe_tracker' is added to public.retired_page_keys, so the existing 0018 trigger mz_skip_retired_page_key silently skips any later insert of a
--      page_flags row with that key (re-running an old migration or an Admin 'add page' cannot bring it back), and two BEFORE INSERT triggers refuse the
--      id on public.addons and public.addon_releases with a clear message.
--   E. One control_audit line, only when something was really removed.
--
-- WHAT IT DOES NOT DO: Postgres cannot delete files from Supabase Storage. The Storage paths of the deleted releases are returned in the audit line
--   (detail.storage_paths) and printed as a NOTICE; remove those files in Admin / the Storage dashboard if you want the bytes gone (they are already
--   unreachable: the Storage policy only serves objects of listed releases). Apps keep whatever they installed; only yanked versions stay revoked.
--   To undo the retirement deliberately: delete the row from public.retired_addon_ids and public.retired_page_keys (both only list 'adobe_tracker' here).
-- Idempotent: running it again changes nothing.

begin;

-- ====================================================================== A. safety stops
do $$
begin
  if to_regclass('public.retired_page_keys') is null or to_regclass('public.addons') is null or to_regclass('public.addon_releases') is null then
    raise exception '0023 stopped: migrations 0014 / 0018 have not been applied (add-on registry or public.retired_page_keys is missing). Nothing was changed. Run 0001..0022 first.'
      using errcode = '55000';
  end if;
  if not exists (select 1 from public.page_flags where page_key = 'tracker' and kind = 'page') then
    raise exception '0023 stopped: the built-in Tracker page switch ''tracker'' is missing (migration 0020 has not been applied). Nothing was changed. Run 0020 first - this file must never be the reason Tracker disappears.'
      using errcode = '55000';
  end if;
  if exists (select 1 from public.retired_page_keys where page_key = 'tracker') then
    raise exception '0023 stopped: ''tracker'' is on public.retired_page_keys (0019 without 0020). Nothing was changed. Run 0020 first.'
      using errcode = '55000';
  end if;
  if exists (select 1 from public.addon_releases r where r.feature_key = 'adobe_tracker' and r.addon_id <> 'adobe_tracker') then
    raise exception '0023 stopped: a release of another add-on still uses the feature key adobe_tracker. Nothing was changed. Delete or re-key that release in Admin first.'
      using errcode = '23503';
  end if;
end $$;

-- ====================================================================== B. list of add-on ids that may never come back
create table if not exists public.retired_addon_ids (
  addon_id   text primary key check (addon_id ~ '^[a-z0-9_]{1,32}$'),
  reason     text not null,
  retired_at timestamptz not null default now()
);
alter table public.retired_addon_ids enable row level security;
revoke all on public.retired_addon_ids from public, anon, authenticated;

insert into public.retired_addon_ids(addon_id, reason)
values ('adobe_tracker', 'Stale duplicate of the built-in Tracker page (page key ''tracker''); retired in v1.0.1 (0023)')
on conflict (addon_id) do nothing;

-- ====================================================================== C. remove the identity
do $$
declare
  n_rel integer := 0; n_reg integer := 0; n_sel integer := 0; n_page integer := 0; n_ovr integer := 0; n_sc integer := 0; paths jsonb := '[]'::jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('mz_addon:adobe_tracker'));                -- same lock the Admin publish / yank / delete functions take

  select coalesce(jsonb_agg(x.storage_path order by x.seq) filter (where x.storage_path is not null), '[]'::jsonb), count(*)
    into paths, n_rel from public.addon_releases x where x.addon_id = 'adobe_tracker';

  insert into public.addon_release_tombstones(addon_id, version, seq, sha256, feature_key, title, was_yanked, revoked, storage_path)
  select x.addon_id, x.version, x.seq, x.sha256, x.feature_key, x.title, x.yanked, x.yanked, x.storage_path
    from public.addon_releases x where x.addon_id = 'adobe_tracker'
  on conflict do nothing;

  delete from public.addon_active_release where addon_id = 'adobe_tracker';
  get diagnostics n_sel = row_count;
  delete from public.addon_releases where addon_id = 'adobe_tracker';
  delete from public.addons where addon_id = 'adobe_tracker';
  get diagnostics n_reg = row_count;

  delete from public.user_page_overrides where page_key = 'adobe_tracker';
  get diagnostics n_ovr = row_count;
  delete from public.page_flags where page_key = 'adobe_tracker';                  -- NEVER 'tracker'
  get diagnostics n_page = row_count;

  update public.app_config
     set value = coalesce(
           (select jsonb_agg(to_jsonb(t.e) order by t.ord)
              from jsonb_array_elements_text(public.app_config.value) with ordinality as t(e, ord)
             where t.e <> 'adobe_tracker'), '[]'::jsonb)
   where key = 'dashboard_shortcuts'
     and case when jsonb_typeof(value) = 'array'
              then exists (select 1 from jsonb_array_elements_text(public.app_config.value) as x(e) where x.e = 'adobe_tracker')
              else false end;
  get diagnostics n_sc = row_count;

  if n_rel + n_reg + n_sel + n_page + n_ovr + n_sc > 0 then
    perform public._audit('addon_identity_retire', 'adobe_tracker',
      jsonb_build_object('migration', '0023', 'releases', n_rel, 'registry_rows', n_reg, 'selection_rows', n_sel,
                         'page_rows', n_page, 'overrides', n_ovr, 'shortcut_lists', n_sc, 'storage_paths', paths));
    raise notice '0023: retired adobe_tracker (% release(s), % registry row, % page row). Storage files to remove by hand: %', n_rel, n_reg, n_page, paths;
  end if;
end $$;

-- ====================================================================== D. never create it again
insert into public.retired_page_keys(page_key, reason)
values ('adobe_tracker', 'Stale duplicate of the built-in Tracker page (key ''tracker''); retired in v1.0.1 (0023)')
on conflict (page_key) do nothing;

create or replace function public._refuse_retired_addon_id() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.retired_addon_ids r where r.addon_id = new.addon_id) then
    raise exception 'add-on id % is retired and cannot be registered or published again', new.addon_id using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public._refuse_retired_addon_id() from public, anon, authenticated;

drop trigger if exists mz_refuse_retired_addon_id on public.addons;
create trigger mz_refuse_retired_addon_id before insert on public.addons
  for each row execute function public._refuse_retired_addon_id();
drop trigger if exists mz_refuse_retired_addon_id on public.addon_releases;
create trigger mz_refuse_retired_addon_id before insert on public.addon_releases
  for each row execute function public._refuse_retired_addon_id();

commit;
