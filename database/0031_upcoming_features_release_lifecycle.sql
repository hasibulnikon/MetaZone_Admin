-- 0031 (v1.0.0; app version unchanged; Part 8C): Upcoming Features <-> Add-on release lifecycle. Run AFTER 0024 and 0030. Idempotent, one transaction.
--
-- WHY.  0024's promotion trigger function promotes every announcement of the add-on whose status is 'draft' or 'published'. Since 0030 an ARCHIVED
--       announcement is stored as status 'draft' + archived_at, so a newly published stable release would have promoted (modified) archived rows too.
--       An archived announcement must stay archived and must never be touched by a release.
--
-- WHAT THIS FILE CHANGES (nothing else)
--   _upcoming_promote_on_release()    (CREATE OR REPLACE; the trigger upcoming_features_promote on addon_releases is NOT dropped or recreated)
--       promotes only when the NEW release is channel 'stable' AND not yanked, and only rows with status in ('draft','published') AND archived_at IS NULL.
--       Archived rows are counted and mentioned in the existing audit entry ('skipped_archived') but are never modified.
--       Repeated events are harmless: a 'released' row no longer matches, so released_at / released_version are never overwritten.
--   admin_set_upcoming_feature_status (same signature) additionally refuses to PUBLISH an announcement whose add-on already has a stable, non-yanked
--       release (it would be hidden from users anyway; restoring an archived row of an already-released add-on can therefore not show it).
--
-- WHAT IT DOES NOT TOUCH: admin_publish_addon, addon_releases, addon_catalog, signing / upload / verification, get_upcoming_features (already hides
--   archived rows and rows whose add-on has a stable non-yanked release), the 0030 archive / restore / reorder functions, any table or grant.

begin;

do $$
begin
  if to_regclass('public.upcoming_features') is null or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'upcoming_features' and column_name = 'archived_at') then
    raise exception 'apply 0024_upcoming_features.sql and 0030_upcoming_features_management.sql first';
  end if;
end $$;

create or replace function public._upcoming_promote_on_release() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer; skipped integer;
begin
  if new.channel = 'stable' and not new.yanked then
    update public.upcoming_features
       set status = 'released', released_at = now(), released_version = new.version, updated_at = now()
     where addon_id = new.addon_id and status in ('draft', 'published') and archived_at is null;
    get diagnostics n = row_count;
    select count(*) into skipped from public.upcoming_features where addon_id = new.addon_id and archived_at is not null and status <> 'released';
    if n > 0 or skipped > 0 then
      perform public._audit('upcoming_release', new.addon_id, jsonb_build_object('version', new.version, 'announcements', n, 'skipped_archived', skipped));
    end if;
  end if;
  return new;
end $$;
revoke all on function public._upcoming_promote_on_release() from public, anon, authenticated;

create or replace function public.admin_set_upcoming_feature_status(p_id uuid, p_status text, p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.upcoming_features; u public.upcoming_features;
begin
  perform public._require_admin();
  if p_status is null or p_status not in ('draft', 'published') then raise exception 'status must be draft or published'; end if;
  select * into cur from public.upcoming_features where id = p_id for update;
  if not found then raise exception 'unknown announcement'; end if;
  if cur.status = 'released' then raise exception 'this announcement was already promoted to a released add-on; delete it or create a new one'; end if;
  if p_status = 'published' and cur.archived_at is not null then raise exception 'this announcement is archived: restore it before publishing'; end if;
  if p_status = 'published' and cur.addon_id is not null and exists (select 1 from public.addon_releases r where r.addon_id = cur.addon_id and r.channel = 'stable' and not r.yanked) then
    raise exception 'add-on % already has a stable release: it is available in Add-ons, there is nothing to announce', cur.addon_id;
  end if;
  if p_expected_updated_at is not null and p_expected_updated_at is distinct from cur.updated_at then
    raise exception 'stale: this announcement was changed by someone else. Reload the page and try again.';
  end if;
  update public.upcoming_features
     set status = p_status, updated_at = now(), updated_by = auth.uid(),
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end
   where id = p_id returning * into u;
  perform public._audit('upcoming_' || p_status, u.id::text, jsonb_build_object('title', u.title));
  return to_jsonb(u);
end $$;

revoke all on function public.admin_set_upcoming_feature_status(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.admin_set_upcoming_feature_status(uuid, text, timestamptz) to authenticated;

commit;
