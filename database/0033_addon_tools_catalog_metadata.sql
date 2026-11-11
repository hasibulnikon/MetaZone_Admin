-- 0033 (v1.0.0, 9th Edition, Addon Tools Part 8): CATALOG METADATA + PLAN AVAILABILITY. Run AFTER 0032 (needs the 0032 Addon Tools tables/RPCs).
-- Forward-only, idempotent, ONE transaction. NOT applied to any database yet and NOT executed against any PostgreSQL (none was available).
-- The identical file lives in MetaZone_App/supabase/migrations/ and MetaZone_Admin/database/.
--
-- WHAT IT ADDS
--   1. addon_tools_releases.category / .tags / .icon: the Part 7 display metadata of a release (optional keys of tool.json). They are stored ON THE
--      RELEASE ROW, not on the mutable catalog row, because the source of truth is the SIGNED manifest of that release: a new current release, an
--      update or a rollback automatically brings the right metadata with it, and nobody can edit it afterwards (the releases guard now locks these
--      columns too). They are filled by a BEFORE INSERT trigger that reads them out of release_json.manifest, so they can never disagree with what
--      the app verifies, and admin_addon_tools_register_release (0032) did not have to change. Older releases get the safe defaults
--      (category NULL, tags [], icon NULL) from the column defaults; no existing row is rewritten.
--   2. addon_tools_catalog(p_app_version) (user RPC) now also returns, per tool: category, tags, icon (from the CURRENT release; '' / [] / '' when
--      the tool has none) and access_free / access_premium (the existing Free / Premium switches of the tool). Same signature, same return type,
--      same entitlement filter, same ordering; only new keys are added, so the current app (which reads named keys) keeps working.
--   Author is unchanged: it stays the admin-entered catalog column (admin_addon_tools_upsert_tool) and is returned exactly as before.
--
-- UNCHANGED ON PURPOSE: RLS, table grants, the access rule (_addon_tools_entitled), every admin RPC (incl. register_release / list), get_release,
-- the signing format, package validation, Storage policies. Function privileges are re-stated for the objects touched here.
-- Rules mirror manifest.py (Part 7): category 2-30 chars [a-z][a-z0-9]*(-[a-z0-9]+)*; tags 0-8 unique, each 1-24 chars [a-z0-9]+(-[a-z0-9]+)*;
-- icon a safe relative .svg/.png path (max 200) that must be listed in the signed files.

begin;

do $$ begin
  if to_regclass('public.addon_tools_releases') is null or to_regclass('public.addon_tools_catalog') is null
     or to_regprocedure('public.addon_tools_catalog(text)') is null or to_regprocedure('public._addon_tools_releases_guard()') is null then
    raise exception '0033 needs 0032 (Addon Tools): run the earlier migrations first';
  end if;
end $$;

-- ====================================================================== A. validation helpers (internal, no client access)
create or replace function public._addon_tools_tags_ok(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p is not null and jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 8
     and not exists (select 1 from jsonb_array_elements(p) e
                      where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') not between 1 and 24
                         or (e #>> '{}') !~ '^[a-z0-9]+(-[a-z0-9]+)*$')
     and (select count(distinct e #>> '{}') from jsonb_array_elements(p) e) = jsonb_array_length(p)
$$;

create or replace function public._addon_tools_icon_path_ok(p text) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p is not null and char_length(p) between 5 and 200 and p ~* '\.(svg|png)$'
     and p !~ '^/' and p !~ '//' and p !~ '/$' and p !~ '\\' and p !~ ':' and p !~ '(^|/)\.{1,2}(/|$)'
     and p !~ '[[:cntrl:]]'
$$;

-- ====================================================================== B. columns (defaults = safe values for every existing release)
alter table public.addon_tools_releases
  add column if not exists category text
    check (category is null or (char_length(category) between 2 and 30 and category ~ '^[a-z][a-z0-9]*(-[a-z0-9]+)*$')),
  add column if not exists tags jsonb not null default '[]'::jsonb
    check (public._addon_tools_tags_ok(tags)),
  add column if not exists icon text
    check (icon is null or public._addon_tools_icon_path_ok(icon));

-- ====================================================================== C. releases guard: the new columns are as immutable as the rest
-- (Replaced BEFORE any later update; nothing needed backfilling: every pre-0033 release has no category / tags / icon in its signed manifest.)
create or replace function public._addon_tools_releases_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Addon Tools releases are permanent and cannot be deleted';
  end if;
  if (new.release_id, new.tool_id, new.version, new.seq, new.zip_sha256, new.zip_size, new.storage_path, new.key_id, new.release_json,
      new.release_sig, new.min_app_version, new.permissions, new.file_count, new.notes, new.created_at, new.created_by,
      new.category, new.tags, new.icon)
     is distinct from
     (old.release_id, old.tool_id, old.version, old.seq, old.zip_sha256, old.zip_size, old.storage_path, old.key_id, old.release_json,
      old.release_sig, old.min_app_version, old.permissions, old.file_count, old.notes, old.created_at, old.created_by,
      old.category, old.tags, old.icon) then
    raise exception 'a published Addon Tools release cannot be changed: publish a new version instead';
  end if;
  return new;
end $$;

-- ====================================================================== D. fill the columns from the SIGNED manifest on insert
-- register_release (0032) has already checked that release_json is a well-formed record; this only copies the optional Part 7 keys, and fails
-- the insert (so nothing is stored) if the signed manifest carries a value the Part 7 rules do not allow.
create or replace function public._addon_tools_releases_meta() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare m jsonb;
begin
  begin m := (new.release_json::jsonb) -> 'manifest'; exception when others then m := null; end;
  new.category := null; new.tags := '[]'::jsonb; new.icon := null;                    -- never trust values supplied by the insert statement
  if m is null or jsonb_typeof(m) <> 'object' then return new; end if;
  if (m -> 'category') is not null then
    if jsonb_typeof(m->'category') <> 'string' then raise exception 'manifest.category must be text'; end if;
    new.category := m->>'category';
  end if;
  if (m -> 'tags') is not null then
    if not public._addon_tools_tags_ok(m->'tags') then raise exception 'manifest.tags must be a list of up to 8 unique valid tags'; end if;
    new.tags := m->'tags';
  end if;
  if (m -> 'icon') is not null then
    if jsonb_typeof(m->'icon') <> 'string' or not public._addon_tools_icon_path_ok(m->>'icon') then
      raise exception 'manifest.icon must be a safe relative .svg or .png path';
    end if;
    if jsonb_typeof((new.release_json::jsonb) -> 'files') = 'array'
       and not exists (select 1 from jsonb_array_elements((new.release_json::jsonb) -> 'files') f where f->>'path' = m->>'icon') then
      raise exception 'manifest.icon is not in the signed file list';
    end if;
    new.icon := m->>'icon';
  end if;
  return new;
end $$;
drop trigger if exists addon_tools_releases_meta on public.addon_tools_releases;
create trigger addon_tools_releases_meta before insert on public.addon_tools_releases
  for each row execute function public._addon_tools_releases_meta();

-- ====================================================================== E. user catalog RPC (same signature; new keys only)
-- New keys per tool: category, tags, icon (current release; '' / [] / '' when absent), access_free, access_premium (the tool's plan switches).
create or replace function public.addon_tools_catalog(p_app_version text default null) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); app integer[];
begin
  if p_app_version is not null and btrim(p_app_version) <> '' then
    app := public._addon_tools_ver(btrim(p_app_version));
    if app is null then raise exception 'invalid app version'; end if;
  end if;
  return jsonb_build_object(
    'tools', coalesce((
      select jsonb_agg(jsonb_build_object(
        'tool_id', c.tool_id, 'name', c.name, 'description', c.description, 'author', c.author, 'revision', c.revision,
        'category', coalesce(r.category, ''), 'tags', r.tags, 'icon', coalesce(r.icon, ''),
        'access_free', c.access_free, 'access_premium', c.access_premium,
        'available', (app is null or r.min_app_version is null or public._addon_tools_ver(r.min_app_version) <= app),
        'reason', case when app is not null and r.min_app_version is not null and public._addon_tools_ver(r.min_app_version) > app
                       then 'this tool needs MetaZone ' || r.min_app_version || ' or newer' end,
        'release_id', r.release_id, 'version', r.version, 'seq', r.seq, 'zip_sha256', r.zip_sha256, 'zip_size', r.zip_size,
        'storage_path', r.storage_path, 'key_id', r.key_id, 'min_app_version', r.min_app_version, 'permissions', r.permissions,
        'file_count', r.file_count, 'notes', r.notes, 'published_at', r.created_at,
        'force_update_below', c.force_update_below, 'force_update_reason', c.force_update_reason,
        'rollback', case when c.rollback_from_release_id is null then null else jsonb_build_object(
            'from_version', (select x.version from public.addon_tools_releases x where x.release_id = c.rollback_from_release_id),
            'reason', c.rollback_reason, 'at', c.rollback_at) end)
        order by c.name, c.tool_id)
        from public.addon_tools_catalog c
        join public.addon_tools_releases r on r.release_id = c.current_release_id and r.tool_id = c.tool_id and not r.revoked
       where public._addon_tools_entitled(uid, c.tool_id)), '[]'::jsonb),
    'revoked', coalesce((select jsonb_agg(jsonb_build_object('tool_id', x.tool_id, 'version', x.version, 'release_id', x.release_id, 'zip_sha256', x.zip_sha256)
                                          order by x.tool_id, x.seq)
                           from public.addon_tools_releases x where x.revoked), '[]'::jsonb));
end $$;

-- ====================================================================== F. privileges (same pattern as 0032 section G)
revoke all on function
  public._addon_tools_tags_ok(jsonb), public._addon_tools_icon_path_ok(text),
  public._addon_tools_releases_guard(), public._addon_tools_releases_meta(),
  public.addon_tools_catalog(text)
  from public, anon, authenticated;
grant execute on function public.addon_tools_catalog(text) to authenticated;          -- as in 0032: needs a signed-in user (_require_user inside)

commit;
