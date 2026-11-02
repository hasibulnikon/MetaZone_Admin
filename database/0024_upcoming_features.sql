-- 0024 (v1.0.1; app version unchanged): Admin-managed "Upcoming features" notice board. Run AFTER 0001..0023. Idempotent, one transaction.
--
-- WHY.  Settings -> Add-ons -> Upcoming features used to be a hard-coded list inside the app (AI BG Remover, AI Image Upscaler). It is now data the
-- Admin controls: create an announcement (title + description), optionally link it to the id of the add-on it announces, publish / unpublish / edit /
-- delete it, and - when the add-on's first STABLE release is published through the EXISTING signed publishing workflow (admin_publish_addon) - the
-- announcement is promoted automatically and leaves the board in the same transaction.
--
-- WHAT THIS FILE ADDS
--   public.upcoming_features         the announcements (RLS on, no client grants, like every table).
--       status: 'draft' (Admin only) | 'published' (shown to users) | 'released' (promoted; kept only as a record, never shown).
--       addon_id: optional link to an add-on id (same format as public.addons.addon_id; a retired id (0023) is refused).
--   client RPC   get_upcoming_features()                  -> the published, not-yet-released announcements (authenticated users).
--   admin RPCs   admin_list_upcoming_features(), admin_upsert_upcoming_feature(...), admin_set_upcoming_feature_status(...),
--                admin_delete_upcoming_feature(uuid)        (all need admin_users, every change is written to control_audit).
--   trigger      upcoming_features_promote on addon_releases (AFTER INSERT, channel 'stable'): marks the linked announcements 'released'.
--                It runs inside the publish transaction, so a failed publish never promotes anything and a successful one always does.
--
-- WHAT IT DOES NOT DO (on purpose)
--   * There is NO new upload or publish path: packages are still uploaded to the private 'addons' bucket and published by admin_publish_addon
--     (signed manifest, SHA-256, immutable releases, tombstones, entitlement via the add-on's feature switch) exactly as before. admin_publish_addon,
--     addon_catalog and every other add-on function are untouched.
--   * Deleting an announcement deletes ONLY its own row. It has no foreign key to, and never reads or writes, addons / addon_releases /
--     addon_active_release / addon_release_tombstones / Storage, so an already published add-on or release can never be removed by it.
--   * An announcement is never shown to users once its linked add-on has a stable, non-yanked release (get_upcoming_features checks that too, in
--     case an old row was left 'published').

begin;

create table if not exists public.upcoming_features (
  id              uuid primary key default gen_random_uuid(),
  title           text not null check (char_length(btrim(title)) between 1 and 80),
  description     text not null default '' check (char_length(description) <= 400),
  addon_id        text check (addon_id is null or addon_id ~ '^[a-z0-9_]{1,32}$'),
  status          text not null default 'draft' check (status in ('draft', 'published', 'released')),
  sort_order      integer not null default 100 check (sort_order between 0 and 100000),
  created_at      timestamptz not null default now(),
  created_by      uuid,
  updated_at      timestamptz not null default now(),
  updated_by      uuid,
  published_at    timestamptz,
  released_at     timestamptz,
  released_version text
);
alter table public.upcoming_features enable row level security;
revoke all on public.upcoming_features from public, anon, authenticated;
create index if not exists upcoming_features_status_idx on public.upcoming_features(status, sort_order);
create index if not exists upcoming_features_addon_idx on public.upcoming_features(addon_id) where addon_id is not null;

-- ====================================================================== promotion (same transaction as the publish)
create or replace function public._upcoming_promote_on_release() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  if new.channel = 'stable' then
    update public.upcoming_features
       set status = 'released', released_at = now(), released_version = new.version, updated_at = now()
     where addon_id = new.addon_id and status in ('draft', 'published');
    get diagnostics n = row_count;
    if n > 0 then
      perform public._audit('upcoming_release', new.addon_id, jsonb_build_object('version', new.version, 'announcements', n));
    end if;
  end if;
  return new;
end $$;
revoke all on function public._upcoming_promote_on_release() from public, anon, authenticated;

drop trigger if exists upcoming_features_promote on public.addon_releases;
create trigger upcoming_features_promote after insert on public.addon_releases
  for each row execute function public._upcoming_promote_on_release();

-- ====================================================================== client: what users see
create or replace function public.get_upcoming_features() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_user();
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', u.id, 'title', u.title, 'description', u.description, 'published_at', u.published_at)
                     order by u.sort_order, u.published_at, u.created_at)
      from public.upcoming_features u
     where u.status = 'published'
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
             'sort_order', u.sort_order, 'created_at', u.created_at, 'updated_at', u.updated_at, 'published_at', u.published_at,
             'released_at', u.released_at, 'released_version', u.released_version,
             'addon_has_release', (u.addon_id is not null and exists (select 1 from public.addon_releases r where r.addon_id = u.addon_id)))
           order by (u.status = 'released'), u.sort_order, u.created_at)
      from public.upcoming_features u), '[]'::jsonb);
end $$;

create or replace function public.admin_upsert_upcoming_feature(
  p_id uuid, p_title text, p_description text default '', p_addon_id text default null, p_sort_order integer default 100,
  p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_title text := btrim(coalesce(p_title, '')); v_desc text := btrim(coalesce(p_description, '')); v_addon text := nullif(btrim(coalesce(p_addon_id, '')), '');
        cur public.upcoming_features; u public.upcoming_features;
begin
  perform public._require_admin();
  if v_title = '' or char_length(v_title) > 80 then raise exception 'title is required (max 80 characters)'; end if;
  if char_length(v_desc) > 400 then raise exception 'description too long (max 400 characters)'; end if;
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
    insert into public.upcoming_features(title, description, addon_id, sort_order, created_by, updated_by)
    values (v_title, v_desc, v_addon, p_sort_order, auth.uid(), auth.uid()) returning * into u;
    perform public._audit('upcoming_create', u.id::text, jsonb_build_object('title', v_title, 'addon_id', v_addon));
  else
    select * into cur from public.upcoming_features where id = p_id for update;
    if not found then raise exception 'unknown announcement'; end if;
    if p_expected_updated_at is not null and p_expected_updated_at is distinct from cur.updated_at then
      raise exception 'stale: this announcement was changed by someone else. Reload the page and try again.';
    end if;
    update public.upcoming_features
       set title = v_title, description = v_desc, addon_id = v_addon, sort_order = p_sort_order, updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into u;
    perform public._audit('upcoming_edit', u.id::text, jsonb_build_object('title', v_title, 'addon_id', v_addon));
  end if;
  return to_jsonb(u);
end $$;

-- 'draft' <-> 'published' only. 'released' is set by the promotion trigger alone; a released announcement can be edited or deleted, not re-published.
create or replace function public.admin_set_upcoming_feature_status(p_id uuid, p_status text, p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.upcoming_features; u public.upcoming_features;
begin
  perform public._require_admin();
  if p_status is null or p_status not in ('draft', 'published') then raise exception 'status must be draft or published'; end if;
  select * into cur from public.upcoming_features where id = p_id for update;
  if not found then raise exception 'unknown announcement'; end if;
  if cur.status = 'released' then raise exception 'this announcement was already promoted to a released add-on; delete it or create a new one'; end if;
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

create or replace function public.admin_delete_upcoming_feature(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.upcoming_features;
begin
  perform public._require_admin();
  delete from public.upcoming_features where id = p_id returning * into cur;     -- ONLY this table: add-ons and releases are never touched
  if not found then raise exception 'unknown announcement'; end if;
  perform public._audit('upcoming_delete', cur.id::text, jsonb_build_object('title', cur.title, 'status', cur.status, 'addon_id', cur.addon_id));
  return jsonb_build_object('id', cur.id, 'deleted', true);
end $$;

revoke all on function public.get_upcoming_features() from public, anon, authenticated;
revoke all on function public.admin_list_upcoming_features() from public, anon, authenticated;
revoke all on function public.admin_upsert_upcoming_feature(uuid, text, text, text, integer, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_set_upcoming_feature_status(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_delete_upcoming_feature(uuid) from public, anon, authenticated;
grant execute on function
  public.get_upcoming_features(),
  public.admin_list_upcoming_features(),
  public.admin_upsert_upcoming_feature(uuid, text, text, text, integer, timestamptz),
  public.admin_set_upcoming_feature_status(uuid, text, timestamptz),
  public.admin_delete_upcoming_feature(uuid)
  to authenticated;

commit;
