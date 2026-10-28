-- 0014_addon_manager.sql  (Admin Panel: Add-on Manager)         Run AFTER 0013. Safe to re-run (idempotent).
--
-- What this adds (server side only; nothing here touches signing, authentication, licensing or the app):
--   A. public.addons              add-on registry: name + description (the admin's own records, no code, no package)
--   B. addon_release_tombstones   a record of every DELETED release. Two jobs:
--        1. a deleted version number / seq can never be published again (otherwise different bytes could appear under a
--           version that user PCs may already have installed);
--        2. if the deleted release was YANKED it stays in the 'revoked' list that addon_catalog() sends to the apps.
--           The app REPLACES its local revoked list with the server's list, so without this a hard delete would silently
--           un-revoke the version on every PC.
--   C. addon_catalog()            redefined from 0013: identical, except 'revoked' also includes revoked tombstones.
--   D. admin_upsert_addon / admin_list_addons              create + edit + list add-ons
--   E. admin_withdraw_addon                                deactivate an add-on (reactivate with the existing
--                                                          admin_restore_previous_addon_active / admin_set_addon_active)
--   F. admin_delete_addon_release / admin_delete_addon     delete one version / a whole add-on (database part; a whole add-on is refused while offered)
--   G. admin_replace_addon_release                         replace the package of a NON-active release (never an active one)
--
-- Deleting is a TWO-step operation by necessity: Postgres cannot delete a file from Supabase Storage.
--   Step 1 (these functions, ONE transaction): records the tombstone, removes the database rows, returns the Storage paths.
--   Step 2 (the Admin site, with the admin's own session): removes those files from the 'addons' bucket.
-- If step 2 fails, only an unreachable file is left behind (the database no longer lists it, so the Storage policy
-- mz_addon_object_allowed() refuses every user; admins can still remove it). The reverse order would leave users with a
-- listed release whose file is gone, which is why the database goes first.
--
-- Deleting a server package does NOT remove anything from users' PCs. Apps keep what they installed; only a YANKED
-- (revoked) version is told to stop. To make apps stop running a version, yank it first.

-- ====================================================================== A. registry
create table if not exists public.addons (
  addon_id    text primary key check (addon_id ~ '^[a-z0-9_]{1,32}$'),
  name        text not null check (char_length(btrim(name)) between 1 and 80),
  description text not null default '' check (char_length(description) <= 400),
  created_at  timestamptz not null default now(),
  created_by  uuid,
  updated_at  timestamptz not null default now(),
  updated_by  uuid
);
alter table public.addons enable row level security;
revoke all on public.addons from public, anon, authenticated;

-- one registry row for every add-on that already has releases (idempotent: never overwrites an admin's edit)
insert into public.addons(addon_id, name, description)
select distinct on (r.addon_id) r.addon_id, coalesce(nullif(btrim(r.title), ''), r.addon_id), coalesce(left(r.summary, 400), '')
  from public.addon_releases r
 order by r.addon_id, r.seq desc
on conflict (addon_id) do nothing;

-- ====================================================================== B. tombstones
create table if not exists public.addon_release_tombstones (
  addon_id     text    not null check (addon_id ~ '^[a-z0-9_]{1,32}$'),
  version      text    not null,
  seq          integer not null,
  sha256       text,
  feature_key  text,
  title        text,
  was_yanked   boolean not null default false,
  revoked      boolean not null default false,          -- true = keep telling apps to stop running / recovering to this version
  storage_path text,
  deleted_at   timestamptz not null default now(),
  deleted_by   uuid,
  primary key (addon_id, version),
  unique (addon_id, seq)
);
alter table public.addon_release_tombstones enable row level security;
revoke all on public.addon_release_tombstones from public, anon, authenticated;

create or replace function public._guard_deleted_release() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.addon_release_tombstones t where t.addon_id = new.addon_id and t.version = new.version) then
    raise exception 'version % of % was deleted earlier and cannot be published again: use a new version number', new.version, new.addon_id;
  end if;
  if exists (select 1 from public.addon_release_tombstones t where t.addon_id = new.addon_id and t.seq >= new.seq) then
    raise exception 'seq % of % is not above a deleted release: use a higher seq', new.seq, new.addon_id;
  end if;
  return new;
end $$;

drop trigger if exists addon_releases_guard_deleted on public.addon_releases;
create trigger addon_releases_guard_deleted before insert on public.addon_releases
  for each row execute function public._guard_deleted_release();

-- ====================================================================== C. addon_catalog (0013 + revoked tombstones)
create or replace function public.addon_catalog(p_core text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); core integer[];
begin
  if p_core is not null and btrim(p_core) <> '' then
    core := public._mz_ver(p_core);
    if core is null then raise exception 'invalid core version'; end if;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'addon_id', a.addon_id, 'selection', a.mode, 'revision', a.revision,
             'available', (a.rj is not null),
             'reason', case when a.rj is not null then null
                            when a.mode = 'withdrawn' then 'the active release was withdrawn by the administrator'
                            when a.mode = 'none'      then 'the administrator has not selected a version yet'
                            when a.mode = 'pinned'    then 'the selected release is not available for this app version'
                            else 'no release is available for this app version' end,
             'version', a.rj->'version', 'seq', a.rj->'seq', 'channel', a.rj->'channel',
             'size', a.rj->'size_bytes', 'sha256', a.rj->'sha256', 'storage_path', a.rj->'storage_path',
             'feature_key', coalesce(a.rj->>'feature_key', a.fkey), 'title', coalesce(a.rj->>'title', a.title),
             'summary', a.rj->'summary', 'notes', coalesce(a.rj->'notes', '{}'::jsonb),
             'min_core', a.rj->'min_core', 'max_core', a.rj->'max_core', 'published_at', a.rj->'published_at',
             'entitled', public._page_enabled(uid, coalesce(a.rj->>'feature_key', a.fkey)),
             'revoked', a.revoked)
           order by a.addon_id)
      from (select i.addon_id, i.fkey, i.title, i.revoked, coalesce(s.mode, 'none') as mode, coalesce(s.revision, 0) as revision, r.rj
              from (select ids.addon_id,
                           coalesce((select (array_agg(x.feature_key order by x.seq desc))[1] from public.addon_releases x where x.addon_id = ids.addon_id),
                                    (select (array_agg(t.feature_key order by t.seq desc))[1] from public.addon_release_tombstones t where t.addon_id = ids.addon_id)) as fkey,
                           coalesce((select (array_agg(x.title order by x.seq desc))[1] from public.addon_releases x where x.addon_id = ids.addon_id),
                                    (select (array_agg(t.title order by t.seq desc))[1] from public.addon_release_tombstones t where t.addon_id = ids.addon_id)) as title,
                           coalesce((select jsonb_agg(u.version order by u.seq)
                                       from (select x.version, x.seq from public.addon_releases x where x.addon_id = ids.addon_id and x.yanked
                                             union
                                             select t.version, t.seq from public.addon_release_tombstones t where t.addon_id = ids.addon_id and t.revoked) u),
                                    '[]'::jsonb) as revoked
                      from (select y.addon_id from public.addon_releases y
                            union
                            select z.addon_id from public.addon_release_tombstones z where z.revoked) ids) i
              left join public.addon_active_release s on s.addon_id = i.addon_id
              left join lateral (
                select to_jsonb(x) as rj from public.addon_releases x
                 where x.addon_id = i.addon_id and not x.yanked and x.channel = 'stable'
                   and s.addon_id is not null and s.mode <> 'withdrawn'
                   and (s.mode <> 'pinned' or x.version = s.active_version)
                   and (core is null or x.min_core is null or public._mz_ver(x.min_core) is null or public._mz_ver(x.min_core) <= core)
                   and (core is null or x.max_core is null or public._mz_ver(x.max_core) is null or public._mz_ver(x.max_core) >= core)
                 order by x.seq desc limit 1) r on true) a), '[]'::jsonb);
end $$;

-- ====================================================================== D. create / edit / list add-ons
create or replace function public.admin_upsert_addon(p_addon text, p_name text, p_description text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text := btrim(coalesce(p_name, '')); v_desc text := btrim(coalesce(p_description, '')); existed boolean; a public.addons;
begin
  perform public._require_admin();
  if p_addon is null or p_addon !~ '^[a-z0-9_]{1,32}$' then raise exception 'invalid add-on id (a-z, 0-9, underscore, max 32)'; end if;
  if v_name = '' or char_length(v_name) > 80 then raise exception 'name is required (max 80 characters)'; end if;
  if char_length(v_desc) > 400 then raise exception 'description too long (max 400 characters)'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || p_addon));
  existed := exists (select 1 from public.addons where addon_id = p_addon);
  insert into public.addons(addon_id, name, description, created_by, updated_by)
  values (p_addon, v_name, v_desc, auth.uid(), auth.uid())
  on conflict (addon_id) do update
    set name = excluded.name, description = excluded.description, updated_at = now(), updated_by = auth.uid()
  returning * into a;
  perform public._audit(case when existed then 'addon_edit' else 'addon_create' end, p_addon, jsonb_build_object('name', v_name));
  return to_jsonb(a);
end $$;

create or replace function public.admin_list_addons() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'addon_id', i.addon_id,
             'name', coalesce(a.name, i.last_title, i.addon_id),
             'description', coalesce(a.description, ''),
             'registered', (a.addon_id is not null),
             'feature_key', i.fkey,
             'release_count', i.n,
             'yanked_count', i.n_yanked,
             'latest_version', i.latest,
             'deleted_count', (select count(*) from public.addon_release_tombstones t where t.addon_id = i.addon_id),
             'mode', coalesce(s.mode, 'none'),
             'active_version', s.active_version,
             'previous_version', s.previous_version,
             'revision', coalesce(s.revision, 0),
             'effective_version', public._addon_effective_version(i.addon_id),
             'created_at', a.created_at, 'updated_at', a.updated_at)
           order by i.addon_id)
      from (select ids.addon_id,
                   (select count(*) from public.addon_releases x where x.addon_id = ids.addon_id) as n,
                   (select count(*) from public.addon_releases x where x.addon_id = ids.addon_id and x.yanked) as n_yanked,
                   (select (array_agg(x.version order by x.seq desc))[1] from public.addon_releases x where x.addon_id = ids.addon_id) as latest,
                   (select (array_agg(x.feature_key order by x.seq desc))[1] from public.addon_releases x where x.addon_id = ids.addon_id) as fkey,
                   (select (array_agg(x.title order by x.seq desc))[1] from public.addon_releases x where x.addon_id = ids.addon_id) as last_title
              from (select q.addon_id from public.addons q union select y.addon_id from public.addon_releases y) ids) i
      left join public.addons a on a.addon_id = i.addon_id
      left join public.addon_active_release s on s.addon_id = i.addon_id), '[]'::jsonb);
end $$;

-- ====================================================================== E. deactivate (withdraw) an add-on
-- Same state the existing 'yank the active release' produces (mode 'withdrawn': apps are offered nothing), but without yanking anything.
-- "Activate again" = the existing Restore previous selection / Make active / Automatic.
create or replace function public.admin_withdraw_addon(p_addon text, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare s public.addon_active_release; eff text; n public.addon_active_release;
begin
  perform public._require_admin();
  if p_addon is null or p_addon !~ '^[a-z0-9_]{1,32}$' then raise exception 'unknown add-on'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || p_addon));
  select * into s from public.addon_active_release where addon_id = p_addon for update;
  if not found then raise exception '% has no selection to withdraw (publish a release first)', p_addon; end if;
  if p_expected_revision is not null and p_expected_revision is distinct from s.revision then
    raise exception 'stale: the selection for % was changed by someone else (now revision %). Reload the page and try again.', p_addon, s.revision;
  end if;
  if s.mode = 'withdrawn' then raise exception '% is already deactivated', p_addon; end if;
  eff := public._addon_effective_version(p_addon);
  update public.addon_active_release
     set mode = 'withdrawn', active_version = null,
         previous_version = coalesce(eff, s.active_version, s.previous_version),
         revision = revision + 1, updated_by = auth.uid(), updated_at = now()
   where addon_id = p_addon returning * into n;
  perform public._audit('addon_withdraw', p_addon, jsonb_build_object('from_mode', s.mode, 'from_version', coalesce(eff, s.active_version), 'revision', n.revision));
  return to_jsonb(n);
end $$;

-- ====================================================================== F. delete one release / a whole add-on
create or replace function public.admin_delete_addon_release(p_addon text, p_version text, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.addon_releases; s public.addon_active_release; eff text;
begin
  perform public._require_admin();
  if p_addon is null or p_addon !~ '^[a-z0-9_]{1,32}$' or p_version is null then raise exception 'unknown release'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || p_addon));                 -- same lock as publish / yank / select
  select * into r from public.addon_releases where addon_id = p_addon and version = p_version for update;
  if not found then raise exception 'unknown release'; end if;
  select * into s from public.addon_active_release where addon_id = p_addon for update;
  if p_expected_revision is not null and p_expected_revision is distinct from coalesce(s.revision, 0) then
    raise exception 'stale: the selection for % was changed by someone else (now revision %). Reload the page and try again.', p_addon, coalesce(s.revision, 0);
  end if;
  eff := public._addon_effective_version(p_addon);
  if s.addon_id is not null and s.mode = 'pinned' and s.active_version = p_version then
    raise exception 'cannot delete %: it is the ACTIVE version. Make another version active, or deactivate the add-on, first.', p_version;
  end if;
  if eff is not distinct from p_version then
    raise exception 'cannot delete %: users are being offered it right now (automatic mode). Choose another version or deactivate the add-on first.', p_version;
  end if;
  if s.addon_id is not null and s.previous_version is not distinct from p_version then
    update public.addon_active_release                                            -- "restore previous" must not point at a deleted release
       set previous_version = null, revision = revision + 1, updated_by = auth.uid(), updated_at = now()
     where addon_id = p_addon;
  end if;
  insert into public.addon_release_tombstones(addon_id, version, seq, sha256, feature_key, title, was_yanked, revoked, storage_path, deleted_by)
  values (r.addon_id, r.version, r.seq, r.sha256, r.feature_key, r.title, r.yanked, r.yanked, r.storage_path, auth.uid());
  delete from public.addon_releases where addon_id = p_addon and version = p_version;
  perform public._audit('addon_release_delete', p_addon, jsonb_build_object('version', p_version, 'seq', r.seq, 'was_yanked', r.yanked));
  return jsonb_build_object('addon_id', p_addon, 'version', p_version, 'storage_path', r.storage_path,
                            'was_yanked', r.yanked, 'revocation_kept', r.yanked);
end $$;

-- Step 2.7 guard: a whole add-on is refused while users can currently be offered it.
-- "Offered" = the SAME rule addon_catalog() uses to hand a release to an app, minus the per-app core-version filter (the server cannot know
-- which core every PC runs, so ANY app that could receive a release counts): the add-on has a selection row whose mode is not 'withdrawn'
-- AND at least one release that is not yanked and is on the 'stable' channel (mode 'pinned': only the chosen version counts).
-- This is deliberately a SUPERSET of _addon_effective_version() (which also applies _addon_block_reason, e.g. app-version support): anything
-- the Admin panel shows as offered is refused here, and so is a release the catalogue could still hand to some app.
-- Not offered (deletion allowed): registry-only add-on, no selection row, 'withdrawn', or only yanked / non-stable releases.
-- The check runs after the per-add-on advisory lock and a row lock on the selection (the same lock publish / yank / select / withdraw take),
-- inside the same transaction as the deletion, so a concurrent change cannot slip in between check and delete. A refusal raises before anything
-- is written: no tombstone, no row removed, no audit entry. Escape hatch: admin_withdraw_addon (deactivate), then delete.
create or replace function public.admin_delete_addon(p_addon text, p_confirm text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare paths jsonb; n_rel integer; n_rev integer; s public.addon_active_release; v_offered text;
begin
  perform public._require_admin();
  if p_addon is null or p_addon !~ '^[a-z0-9_]{1,32}$' then raise exception 'unknown add-on'; end if;
  if p_confirm is distinct from p_addon then raise exception 'confirmation text does not match the add-on id'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || p_addon));
  if not exists (select 1 from public.addons where addon_id = p_addon) and not exists (select 1 from public.addon_releases where addon_id = p_addon) then
    raise exception 'unknown add-on';
  end if;
  select * into s from public.addon_active_release where addon_id = p_addon for update;
  if found and s.mode <> 'withdrawn' then
    select x.version into v_offered from public.addon_releases x
     where x.addon_id = p_addon and not x.yanked and x.channel = 'stable'
       and (s.mode <> 'pinned' or x.version = s.active_version)
     order by x.seq desc limit 1;
    if v_offered is not null then
      raise exception 'cannot delete add-on %: users are being offered it right now (version %, selection mode %). Deactivate the add-on first (Versions > Deactivate), then delete it.', p_addon, v_offered, s.mode;
    end if;
  end if;
  select coalesce(jsonb_agg(x.storage_path order by x.seq) filter (where x.storage_path is not null), '[]'::jsonb), count(*), count(*) filter (where x.yanked)
    into paths, n_rel, n_rev
    from public.addon_releases x where x.addon_id = p_addon;
  insert into public.addon_release_tombstones(addon_id, version, seq, sha256, feature_key, title, was_yanked, revoked, storage_path, deleted_by)
  select x.addon_id, x.version, x.seq, x.sha256, x.feature_key, x.title, x.yanked, x.yanked, x.storage_path, auth.uid()
    from public.addon_releases x where x.addon_id = p_addon;
  delete from public.addon_active_release where addon_id = p_addon;                -- its foreign keys point at the releases: first
  delete from public.addon_releases where addon_id = p_addon;
  delete from public.addons where addon_id = p_addon;
  perform public._audit('addon_delete', p_addon, jsonb_build_object('releases', n_rel, 'yanked_kept_revoked', n_rev));
  return jsonb_build_object('addon_id', p_addon, 'storage_paths', paths, 'releases_deleted', n_rel, 'revocations_kept', n_rev);
end $$;

-- ====================================================================== G. replace the package of a NON-active release
-- The Admin site uploads the new file to the release's own Storage path first (admin session), then calls this to record its size + hash.
-- An ACTIVE / currently offered release is never replaced in place: publish a new version instead.
create or replace function public.admin_replace_addon_release(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id text; v_ver text; v_size bigint; v_sha text; v_old text; r public.addon_releases; s public.addon_active_release; v_obj jsonb; n public.addon_releases;
begin
  perform public._require_admin();
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'request must be a JSON object'; end if;
  v_id := p->>'addon_id'; v_ver := p->>'version';
  if v_id is null or v_id !~ '^[a-z0-9_]{1,32}$' or v_ver is null then raise exception 'unknown release'; end if;
  if coalesce(jsonb_typeof(p->'size'), '') <> 'number' or (p->>'size') !~ '^[0-9]{1,15}$' or (p->>'size')::bigint < 1 then raise exception 'invalid size (bytes > 0)'; end if;
  v_size := (p->>'size')::bigint;
  v_sha := lower(coalesce(p->>'sha256', ''));
  if v_sha !~ '^[0-9a-f]{64}$' then raise exception 'invalid sha256 (64 hex characters)'; end if;
  v_old := lower(nullif(p->>'expected_sha256', ''));
  perform pg_advisory_xact_lock(hashtext('mz_addon:' || v_id));
  select * into r from public.addon_releases where addon_id = v_id and version = v_ver for update;
  if not found then raise exception 'unknown release'; end if;
  select * into s from public.addon_active_release where addon_id = v_id for update;
  if s.addon_id is not null and s.mode = 'pinned' and s.active_version = v_ver then
    raise exception 'cannot replace the package of % %: it is the ACTIVE version. Publish a new version instead.', v_id, v_ver;
  end if;
  if public._addon_effective_version(v_id) is not distinct from v_ver then
    raise exception 'cannot replace the package of % %: users are being offered it right now. Publish a new version instead.', v_id, v_ver;
  end if;
  if v_old is not null and v_old is distinct from r.sha256 then
    raise exception 'stale: this release was changed by someone else. Reload the page and try again.';
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select to_jsonb(o) from storage.objects o where o.bucket_id = $1 and o.name = $2 limit 1' into v_obj using 'addons', r.storage_path;
    if v_obj is null then raise exception 'package not found in Storage at %: upload it first', r.storage_path; end if;
    if coalesce(v_obj #>> '{metadata,size}', '') ~ '^[0-9]+$' and (v_obj #>> '{metadata,size}')::bigint <> v_size then
      raise exception 'size in Storage (%) differs from the given size (%)', v_obj #>> '{metadata,size}', v_size;
    end if;
  end if;
  update public.addon_releases set size_bytes = v_size, sha256 = v_sha where addon_id = v_id and version = v_ver returning * into n;
  perform public._audit('addon_release_replace', v_id, jsonb_build_object('version', v_ver, 'old_sha256', left(r.sha256, 12), 'new_sha256', left(v_sha, 12), 'yanked', r.yanked));
  return to_jsonb(n);
end $$;

-- ====================================================================== privileges
-- new functions start with PUBLIC execute -- strip it, grant back only the admin surface (each admin_* checks _require_admin() itself).
revoke all on function public._guard_deleted_release() from public, anon, authenticated;
revoke all on function public.admin_upsert_addon(text, text, text) from public, anon, authenticated;
revoke all on function public.admin_list_addons() from public, anon, authenticated;
revoke all on function public.admin_withdraw_addon(text, bigint) from public, anon, authenticated;
revoke all on function public.admin_delete_addon_release(text, text, bigint) from public, anon, authenticated;
revoke all on function public.admin_delete_addon(text, text) from public, anon, authenticated;
revoke all on function public.admin_replace_addon_release(jsonb) from public, anon, authenticated;

grant execute on function
  public.admin_upsert_addon(text, text, text),
  public.admin_list_addons(),
  public.admin_withdraw_addon(text, bigint),
  public.admin_delete_addon_release(text, text, bigint),
  public.admin_delete_addon(text, text),
  public.admin_replace_addon_release(jsonb)
  to authenticated;
-- addon_catalog() was redefined with create or replace: it keeps the grants it already had (authenticated).
