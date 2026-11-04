-- 0030 (v1.0.0; app version unchanged; Part 8B): Upcoming Features management - thumbnail, archive, explicit ordering. Run AFTER 0024. Idempotent, one transaction.
--
-- WHY.  0024 already provides the announcement table, the user read RPC and the Admin create / edit / publish / unpublish / delete RPCs. What it lacks
--       for Part 8B: an optional thumbnail, an ARCHIVE state (kept as a record, never shown) and a way to set the display order without typing numbers.
--
-- WHAT THIS FILE CHANGES (additive; 0024 is not edited)
--   public.upcoming_features        + image_data (optional small data: png/jpeg/webp, same rule as 0029), + archived_at / archived_by.
--                                   + CHECK: an archived row can never be 'published'.
--   get_upcoming_features()         now also returns image_data and NEVER returns an archived row.
--   admin_list_upcoming_features()  now also returns image_data, archived_at; archived rows sort last.
--   admin_upsert_upcoming_feature   new optional 7th argument p_image_data (null = no image). The old 6-argument overload is dropped so there is
--                                   exactly one function; callers that omit p_image_data keep working (and store no image).
--   admin_set_upcoming_feature_status  same signature; additionally refuses to publish an archived announcement.
--   NEW admin_set_upcoming_feature_archived(p_id, p_archived, p_expected_updated_at)   archive (forces 'draft') / restore (stays 'draft').
--   NEW admin_reorder_upcoming_features(p_ids uuid[])                                  renumbers sort_order 10, 20, 30 ... in the given order.
--
-- WHAT IT DOES NOT TOUCH (Part 8C owns it): the promotion trigger upcoming_features_promote / _upcoming_promote_on_release(), admin_publish_addon,
--   addon_releases and every other add-on object. No dependency on 0027, 0028 or 0029.

begin;

do $$
begin
  if to_regclass('public.upcoming_features') is null then
    raise exception 'upcoming_features is missing: apply 0024_upcoming_features.sql first';
  end if;
  if to_regprocedure('public._require_admin()') is null or to_regprocedure('public._require_user()') is null then
    raise exception 'helper functions _require_admin/_require_user are missing: apply the earlier migrations first';
  end if;
end $$;

alter table public.upcoming_features add column if not exists image_data  text;
alter table public.upcoming_features add column if not exists archived_at timestamptz;
alter table public.upcoming_features add column if not exists archived_by uuid;

do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.upcoming_features'::regclass and conname = 'upcoming_features_image_chk') then
    alter table public.upcoming_features add constraint upcoming_features_image_chk
      check (image_data is null or (char_length(image_data) <= 60000 and image_data ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$'));
  end if;
  if not exists (select 1 from pg_constraint where conrelid = 'public.upcoming_features'::regclass and conname = 'upcoming_features_archived_not_published_chk') then
    alter table public.upcoming_features add constraint upcoming_features_archived_not_published_chk
      check (archived_at is null or status <> 'published');
  end if;
end $$;
create index if not exists upcoming_features_archived_idx on public.upcoming_features(archived_at) where archived_at is not null;

-- ====================================================================== client: what users see (published, NOT archived, not already released)
create or replace function public.get_upcoming_features() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_user();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'description', u.description, 'image_data', u.image_data, 'published_at', u.published_at)
                     order by u.sort_order, u.published_at, u.created_at)
      from public.upcoming_features u
     where u.status = 'published'
       and u.archived_at is null
       and not (u.addon_id is not null and exists (select 1 from public.addon_releases r
                                                    where r.addon_id = u.addon_id and r.channel = 'stable' and not r.yanked))), '[]'::jsonb);
end $$;

-- ====================================================================== admin
create or replace function public.admin_list_upcoming_features() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', u.id, 'title', u.title, 'description', u.description, 'addon_id', u.addon_id, 'status', u.status,
             'image_data', u.image_data, 'archived_at', u.archived_at,
             'sort_order', u.sort_order, 'created_at', u.created_at, 'updated_at', u.updated_at, 'published_at', u.published_at,
             'released_at', u.released_at, 'released_version', u.released_version,
             'addon_has_release', (u.addon_id is not null and exists (select 1 from public.addon_releases r where r.addon_id = u.addon_id)))
           order by (u.archived_at is not null), (u.status = 'released'), u.sort_order, u.created_at)
      from public.upcoming_features u), '[]'::jsonb);
end $$;

drop function if exists public.admin_upsert_upcoming_feature(uuid, text, text, text, integer, timestamptz);
create or replace function public.admin_upsert_upcoming_feature(
  p_id uuid, p_title text, p_description text default '', p_addon_id text default null, p_sort_order integer default 100,
  p_expected_updated_at timestamptz default null, p_image_data text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_title text := btrim(coalesce(p_title, '')); v_desc text := btrim(coalesce(p_description, '')); v_addon text := nullif(btrim(coalesce(p_addon_id, '')), '');
        v_img text := nullif(p_image_data, '');
        cur public.upcoming_features; u public.upcoming_features;
begin
  perform public._require_admin();
  if v_title = '' or char_length(v_title) > 80 then raise exception 'title is required (max 80 characters)'; end if;
  if char_length(v_desc) > 400 then raise exception 'description too long (max 400 characters)'; end if;
  if v_img is not null and (char_length(v_img) > 60000 or v_img !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$') then
    raise exception 'invalid thumbnail (PNG, JPEG or WebP data image up to 60000 characters)';
  end if;
  if v_addon is not null then
    if v_addon !~ '^[a-z0-9_]{1,32}$' then raise exception 'invalid add-on id (a-z, 0-9, underscore, max 32)'; end if;
    if to_regclass('public.retired_addon_ids') is not null and exists (select 1 from public.retired_addon_ids where addon_id = v_addon) then
      raise exception 'add-on id % is retired and cannot be announced', v_addon;
    end if;
    if exists (select 1 from public.addon_releases r where r.addon_id = v_addon and r.channel = 'stable' and not r.yanked) then
      raise exception 'add-on % already has a stable release: it is available in Add-ons, there is nothing to announce', v_addon;
    end if;
  end if;
  if p_sort_order is null or p_sort_order < 0 or p_sort_order > 100000 then raise exception 'invalid sort order'; end if;
  if p_id is null then
    insert into public.upcoming_features(title, description, addon_id, sort_order, image_data, created_by, updated_by)     -- status defaults to 'draft': never auto-published
    values (v_title, v_desc, v_addon, p_sort_order, v_img, auth.uid(), auth.uid()) returning * into u;
    perform public._audit('upcoming_create', u.id::text, jsonb_build_object('title', v_title, 'addon_id', v_addon));
  else
    select * into cur from public.upcoming_features where id = p_id for update;
    if not found then raise exception 'unknown announcement'; end if;
    if p_expected_updated_at is not null and p_expected_updated_at is distinct from cur.updated_at then
      raise exception 'stale: this announcement was changed by someone else. Reload the page and try again.';
    end if;
    update public.upcoming_features        -- status / archived_at are NOT changed by an edit
       set title = v_title, description = v_desc, addon_id = v_addon, sort_order = p_sort_order, image_data = v_img, updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into u;
    perform public._audit('upcoming_edit', u.id::text, jsonb_build_object('title', v_title, 'addon_id', v_addon));
  end if;
  return to_jsonb(u);
end $$;

-- 'draft' <-> 'published' only; an archived announcement must be restored first.
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

-- Archive = hidden from users and parked in the Admin "Archived" list; it also unpublishes. Restore returns it as a DRAFT (never straight to published).
create or replace function public.admin_set_upcoming_feature_archived(p_id uuid, p_archived boolean, p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.upcoming_features; u public.upcoming_features;
begin
  perform public._require_admin();
  if p_archived is null then raise exception 'p_archived must be true or false'; end if;
  select * into cur from public.upcoming_features where id = p_id for update;
  if not found then raise exception 'unknown announcement'; end if;
  if cur.status = 'released' then raise exception 'this announcement was already promoted to a released add-on; delete it instead'; end if;
  if p_expected_updated_at is not null and p_expected_updated_at is distinct from cur.updated_at then
    raise exception 'stale: this announcement was changed by someone else. Reload the page and try again.';
  end if;
  if p_archived then
    update public.upcoming_features set status = 'draft', archived_at = coalesce(archived_at, now()), archived_by = auth.uid(), updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into u;
  else
    update public.upcoming_features set archived_at = null, archived_by = null, updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into u;
  end if;
  perform public._audit(case when p_archived then 'upcoming_archive' else 'upcoming_restore' end, u.id::text, jsonb_build_object('title', u.title));
  return to_jsonb(u);
end $$;

-- Display order: the Admin sends the ids in the wanted order; sort_order becomes 10, 20, 30 ... (users see ascending sort_order).
create or replace function public.admin_reorder_upcoming_features(p_ids uuid[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  perform public._require_admin();
  if p_ids is null or coalesce(array_length(p_ids, 1), 0) = 0 or array_length(p_ids, 1) > 500 then raise exception 'give 1 to 500 announcement ids'; end if;
  if (select count(distinct x) from unnest(p_ids) x) <> array_length(p_ids, 1) then raise exception 'duplicate ids'; end if;
  if (select count(*) from public.upcoming_features where id = any(p_ids)) <> array_length(p_ids, 1) then raise exception 'unknown announcement in the list'; end if;
  perform 1 from public.upcoming_features where id = any(p_ids) order by id for update;
  update public.upcoming_features f
     set sort_order = least(100000, t.ord * 10), updated_at = now(), updated_by = auth.uid()
    from unnest(p_ids) with ordinality as t(id, ord)
   where f.id = t.id and f.sort_order is distinct from least(100000, t.ord * 10);
  get diagnostics n = row_count;
  perform public._audit('upcoming_reorder', 'upcoming_features', jsonb_build_object('count', array_length(p_ids, 1), 'changed', n));
  return jsonb_build_object('ok', true, 'count', array_length(p_ids, 1), 'changed', n);
end $$;

revoke all on function public.get_upcoming_features() from public, anon, authenticated;
revoke all on function public.admin_list_upcoming_features() from public, anon, authenticated;
revoke all on function public.admin_upsert_upcoming_feature(uuid, text, text, text, integer, timestamptz, text) from public, anon, authenticated;
revoke all on function public.admin_set_upcoming_feature_status(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_set_upcoming_feature_archived(uuid, boolean, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_reorder_upcoming_features(uuid[]) from public, anon, authenticated;
grant execute on function
  public.get_upcoming_features(),
  public.admin_list_upcoming_features(),
  public.admin_upsert_upcoming_feature(uuid, text, text, text, integer, timestamptz, text),
  public.admin_set_upcoming_feature_status(uuid, text, timestamptz),
  public.admin_set_upcoming_feature_archived(uuid, boolean, timestamptz),
  public.admin_reorder_upcoming_features(uuid[])
  to authenticated;

commit;
