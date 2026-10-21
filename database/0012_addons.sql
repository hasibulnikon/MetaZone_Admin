-- 0012 (v0.9.9.10): MetaZone becomes MODULAR. Optional "add-ons" (signed .mzaddon ZIP packages) are downloaded by the desktop app
-- from a PRIVATE Supabase Storage bucket ('addons'). This migration is the server half of that: who may see / download an add-on,
-- the release catalogue, and the admin functions that publish / withdraw a release. Run AFTER 0001..0011. Idempotent: re-running
-- changes nothing that an admin chose (switches, published releases); policies and functions are simply re-created.
--
-- ENTITLEMENT = THE EXISTING PAGE SWITCHES.  An add-on is unlocked for a user exactly when
--     public._page_enabled(user, feature_key)
-- is true, i.e. the very same rule as every page (0006 + 0011): locked -> on; else the user's override (Users -> Pages); else the
-- master switch AND the user's plan switch (Free / Premium).  So the admin already has every control he needs: Free/Premium switches
-- per feature, a master "off for everybody", and per-user exceptions in both directions.  Nothing new to learn in the panel.
--   add-on id               -> feature_key (a page_flags row)
--   adobe_tracker           -> 'tracker'            (existing row, kind stays 'page'; Tracker stays Free = OFF as set by 0011)
--   converter_image         -> 'converter_image'    (NEW row, kind 'addon')
--   converter_video         -> 'converter_video'    (NEW row, kind 'addon')
--   advanced_embedder_vector-> 'embed_vector'       (NEW row, kind 'addon')
--   advanced_embedder_video -> 'embed_video'        (NEW row, kind 'addon')
-- The four new rows default to: enabled, Free ON, Premium ON, not locked.
--
-- FREE USERS SEE EVERYTHING, ONLY ENTITLED USERS GET THE FILE.  addon_catalog() lists every add-on (locked ones too, entitled=false) so the
-- app can show a locked card with Download disabled.  The same rule is enforced again where it matters, on the Storage objects
-- (policy below), so a Free user cannot fetch a package by guessing its URL.
--
-- INTEGRITY IS NOT STORAGE'S JOB.  Storage is only transport.  The app verifies the *signed manifest* inside the package and the SHA-256
-- published here before it installs anything; a tampered or swapped object fails that check no matter what Storage serves.  The
-- sha256 / size recorded here are never editable: to change a package you publish a NEW version with a higher seq.
--
-- Surface added (all RPC-only, SECURITY DEFINER, pinned search_path; the tables have RLS on and no client grants, like the rest):
--   client (authenticated)  addon_catalog(p_core), addon_history(p_addon)
--   storage policy helpers  mz_addon_object_allowed(name), mz_addon_admin()      (policies are evaluated with the caller's privileges,
--                                                                                 so these two must be executable; each reveals only a boolean about the caller)
--   admin (needs admin_users) admin_publish_addon(jsonb), admin_yank_addon(text,text,boolean), admin_list_addon_releases()
--   changed                 admin_list_pages(), admin_get_user_pages()  -> every row now also carries 'kind' ('page' | 'addon')
--   unchanged on purpose    get_my_pages()  already returns EVERY page_flags row, so the app receives the four add-on keys with no change.
--
-- The Storage part is wrapped so this file still runs on a Postgres that has no `storage` schema (plain local test databases).

-- ---------------------------------------------------------------- page_flags.kind
alter table public.page_flags
  add column if not exists kind text not null default 'page' check (kind in ('page', 'addon'));

insert into public.page_flags(page_key, label, enabled, enabled_free, enabled_premium, locked, sort_order, kind) values
  ('converter_image', 'File Converter - Image tool',   true, true, true, false, 100, 'addon'),
  ('converter_video', 'File Converter - Video tool',   true, true, true, false, 110, 'addon'),
  ('embed_vector',    'Advanced Embedder - Vector',    true, true, true, false, 120, 'addon'),
  ('embed_video',     'Advanced Embedder - Video',     true, true, true, false, 130, 'addon')
on conflict (page_key) do update set kind = 'addon';       -- keeps whatever switches the admin already set

-- ---------------------------------------------------------------- addon_releases
create table if not exists public.addon_releases (
  addon_id     text not null check (addon_id ~ '^[a-z0-9_]{1,32}$'),
  version      text not null check (version ~ '^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]{1,24})?$'),
  seq          integer not null check (seq >= 1),                         -- strictly increasing per add-on: "newer" never depends on parsing versions
  channel      text not null default 'stable' check (channel ~ '^[a-z0-9_]{1,16}$'),
  feature_key  text not null references public.page_flags(page_key),
  title        text,
  summary      text,
  size_bytes   bigint check (size_bytes > 0),
  sha256       text check (sha256 ~ '^[0-9a-f]{64}$'),
  storage_path text,
  notes        jsonb not null default '{}'::jsonb,                         -- {"pages":[...],"problems":[...],"fixes":[...]}
  min_core     text,                                                       -- oldest / newest MetaZone core this package supports (null = open)
  max_core     text,
  published_at timestamptz not null default now(),
  published_by uuid,
  yanked       boolean not null default false,
  primary key (addon_id, version),
  unique (addon_id, seq)
);
alter table public.addon_releases enable row level security;
revoke all on public.addon_releases from public, anon, authenticated;

-- ---------------------------------------------------------------- dotted-version helper (numeric compare, leading 'v' ignored)
-- 'v0.9.9.10' -> {0,9,9,10,0,0}.  A pre-release suffix ('-beta') is ignored.  Not numeric -> NULL.
create or replace function public._mz_ver(p text) returns integer[]
language plpgsql immutable set search_path = public, pg_temp as $$
declare s text := lower(btrim(coalesce(p, ''))); parts text[]; out integer[] := '{}'; i int;
begin
  s := regexp_replace(s, '^v', '');
  s := split_part(split_part(s, '-', 1), '+', 1);
  if s !~ '^[0-9]{1,9}(\.[0-9]{1,9}){0,5}$' then return null; end if;
  parts := string_to_array(s, '.');
  for i in 1..6 loop
    out := out || coalesce(parts[i], '0')::integer;
  end loop;
  return out;
end $$;

-- ---------------------------------------------------------------- client API
-- ONE row per add-on: its newest (highest seq) non-yanked STABLE release that supports p_core. p_core null = no core filtering.
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
             'addon_id', r.addon_id, 'version', r.version, 'seq', r.seq, 'channel', r.channel,
             'size', r.size_bytes, 'sha256', r.sha256, 'storage_path', r.storage_path,
             'feature_key', r.feature_key, 'title', r.title, 'summary', r.summary, 'notes', r.notes,
             'min_core', r.min_core, 'max_core', r.max_core, 'published_at', r.published_at,
             'entitled', public._page_enabled(uid, r.feature_key))
           order by r.addon_id)
      from (select distinct on (x.addon_id) x.*
              from public.addon_releases x
             where not x.yanked and x.channel = 'stable'
               and (core is null or x.min_core is null or public._mz_ver(x.min_core) is null or public._mz_ver(x.min_core) <= core)
               and (core is null or x.max_core is null or public._mz_ver(x.max_core) is null or public._mz_ver(x.max_core) >= core)
             order by x.addon_id, x.seq desc) r), '[]'::jsonb);
end $$;

-- "What changed": the last 10 non-yanked stable releases of one add-on, newest first.
create or replace function public.addon_history(p_addon text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_user();
  return coalesce((
    select jsonb_agg(jsonb_build_object('version', h.version, 'seq', h.seq, 'published_at', h.published_at, 'notes', h.notes)
                     order by h.seq desc)
      from (select * from public.addon_releases
             where addon_id = p_addon and not yanked and channel = 'stable'
             order by seq desc limit 10) h), '[]'::jsonb);
end $$;

-- ---------------------------------------------------------------- admin API
create or replace function public.admin_list_addon_releases() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'addon_id', r.addon_id, 'version', r.version, 'seq', r.seq, 'channel', r.channel, 'feature_key', r.feature_key,
             'title', r.title, 'summary', r.summary, 'size', r.size_bytes, 'sha256', r.sha256, 'storage_path', r.storage_path,
             'notes', r.notes, 'min_core', r.min_core, 'max_core', r.max_core,
             'published_at', r.published_at, 'published_by', r.published_by, 'yanked', r.yanked)
           order by r.published_at desc, r.seq desc, r.addon_id)
      from public.addon_releases r), '[]'::jsonb);
end $$;

-- p = the sidecar release.json produced by the build tool:
--   {addon_id, version, seq, channel?, size, sha256, feature_key, title, summary, min_core?, max_core?, notes:{pages,problems,fixes}}
-- The package must ALREADY be uploaded to Storage at storage_path (the panel does that first); when Storage is present this is verified.
-- A published release is immutable: sha256 / size can never be edited -- publish a new version instead.
create or replace function public.admin_publish_addon(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_id text; v_ver text; v_seq int; v_chan text; v_size bigint; v_sha text; v_key text; v_title text; v_sum text;
  v_min text; v_max text; v_notes jsonb; v_path text; v_max_seq int; k text; el jsonb; v_obj jsonb; r public.addon_releases;
begin
  perform public._require_admin();
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'release must be a JSON object'; end if;

  v_id := p->>'addon_id';
  if v_id is null or v_id !~ '^[a-z0-9_]{1,32}$' then raise exception 'invalid addon_id (a-z, 0-9, underscore, max 32)'; end if;
  v_ver := p->>'version';
  if v_ver is null or v_ver !~ '^[0-9]+(\.[0-9]+){1,3}([-+][0-9A-Za-z.-]{1,24})?$' then raise exception 'invalid version'; end if;
  if coalesce(jsonb_typeof(p->'seq'), '') <> 'number' or (p->>'seq') !~ '^[0-9]{1,9}$' or (p->>'seq')::bigint < 1 or (p->>'seq')::bigint > 2000000000 then
    raise exception 'invalid seq (whole number >= 1)';
  end if;
  v_seq := (p->>'seq')::int;
  v_chan := coalesce(nullif(p->>'channel', ''), 'stable');
  if v_chan !~ '^[a-z0-9_]{1,16}$' then raise exception 'invalid channel'; end if;
  if coalesce(jsonb_typeof(p->'size'), '') <> 'number' or (p->>'size') !~ '^[0-9]{1,15}$' or (p->>'size')::bigint < 1 then raise exception 'invalid size (bytes > 0)'; end if;
  v_size := (p->>'size')::bigint;
  v_sha := lower(coalesce(p->>'sha256', ''));
  if v_sha !~ '^[0-9a-f]{64}$' then raise exception 'invalid sha256 (64 hex characters)'; end if;
  v_key := p->>'feature_key';
  if v_key is null or not exists (select 1 from public.page_flags where page_key = v_key) then raise exception 'unknown feature_key'; end if;
  v_title := btrim(coalesce(p->>'title', ''));
  if v_title = '' or length(v_title) > 80 then raise exception 'title is required (max 80 characters)'; end if;
  v_sum := btrim(coalesce(p->>'summary', ''));
  if length(v_sum) > 400 then raise exception 'summary too long (max 400 characters)'; end if;
  v_min := nullif(btrim(coalesce(p->>'min_core', '')), '');
  v_max := nullif(btrim(coalesce(p->>'max_core', '')), '');
  if v_min is not null and public._mz_ver(v_min) is null then raise exception 'invalid min_core'; end if;
  if v_max is not null and public._mz_ver(v_max) is null then raise exception 'invalid max_core'; end if;
  if v_min is not null and v_max is not null and public._mz_ver(v_min) > public._mz_ver(v_max) then raise exception 'min_core is newer than max_core'; end if;

  v_notes := case when jsonb_typeof(p->'notes') is null or jsonb_typeof(p->'notes') = 'null' then '{}'::jsonb else p->'notes' end;
  if jsonb_typeof(v_notes) <> 'object' then raise exception 'notes must be an object'; end if;
  for k in select jsonb_object_keys(v_notes) loop
    if k not in ('pages', 'problems', 'fixes') then raise exception 'unknown notes section: %', k; end if;
    if jsonb_typeof(v_notes->k) <> 'array' or jsonb_array_length(v_notes->k) > 50 then raise exception 'notes.% must be a list (max 50 lines)', k; end if;
    for el in select * from jsonb_array_elements(v_notes->k) loop
      if jsonb_typeof(el) <> 'string' or length(el #>> '{}') > 400 then raise exception 'notes.% lines must be text (max 400 characters)', k; end if;
    end loop;
  end loop;

  v_path := v_id || '/' || v_ver || '/' || v_id || '-' || v_ver || '.mzaddon';
  if p ? 'storage_path' and p->>'storage_path' is distinct from v_path then
    raise exception 'storage_path must be %', v_path;
  end if;

  perform pg_advisory_xact_lock(hashtext('mz_addon:' || v_id));            -- two admins publishing the same add-on at once
  if exists (select 1 from public.addon_releases where addon_id = v_id and version = v_ver) then
    raise exception 'version % of % is already published (published releases are immutable; publish a new version)', v_ver, v_id;
  end if;
  select max(seq) into v_max_seq from public.addon_releases where addon_id = v_id;
  if v_max_seq is not null and v_seq <= v_max_seq then
    raise exception 'seq must be greater than the highest published seq (%) for %', v_max_seq, v_id;
  end if;

  -- The package must really be in Storage (skipped where there is no storage schema). Size is compared when Storage reports it.
  if to_regclass('storage.objects') is not null then
    execute 'select to_jsonb(o) from storage.objects o where o.bucket_id = $1 and o.name = $2 limit 1' into v_obj using 'addons', v_path;
    if v_obj is null then raise exception 'package not found in Storage at %: upload it first', v_path; end if;
    if coalesce(v_obj #>> '{metadata,size}', '') ~ '^[0-9]+$' and (v_obj #>> '{metadata,size}')::bigint <> v_size then
      raise exception 'size in Storage (%) differs from the release size (%)', v_obj #>> '{metadata,size}', v_size;
    end if;
  end if;

  insert into public.addon_releases(addon_id, version, seq, channel, feature_key, title, summary, size_bytes, sha256, storage_path,
                                    notes, min_core, max_core, published_by)
  values (v_id, v_ver, v_seq, v_chan, v_key, v_title, v_sum, v_size, v_sha, v_path, v_notes, v_min, v_max, auth.uid())
  returning * into r;
  return to_jsonb(r);
end $$;

-- Withdraw (or restore) a release. A yanked release disappears from addon_catalog / addon_history and its Storage object stops being
-- downloadable; the catalogue falls back to the previous release automatically.
create or replace function public.admin_yank_addon(p_addon text, p_version text, p_yank boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.addon_releases;
begin
  perform public._require_admin();
  update public.addon_releases set yanked = coalesce(p_yank, true)
   where addon_id = p_addon and version = p_version returning * into r;
  if not found then raise exception 'unknown release'; end if;
  return to_jsonb(r);
end $$;

-- ---------------------------------------------------------------- page lists now carry 'kind' (all 0011 keys kept)
create or replace function public.admin_list_pages() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'kind', f.kind, 'enabled', f.enabled, 'locked', f.locked,
            'enabled_free', f.enabled_free, 'enabled_premium', f.enabled_premium,
            'overrides_on',  (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and o.enabled),
            'overrides_off', (select count(*) from public.user_page_overrides o where o.page_key = f.page_key and not o.enabled))
          order by f.sort_order, f.page_key) from public.page_flags f where f.page_key <> 'settings'), '[]'::jsonb);
end $$;

create or replace function public.admin_get_user_pages(p_user uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_plan text;
begin
  perform public._require_admin();
  if not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  v_plan := public.mz_plan(p_user);
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'kind', f.kind, 'locked', f.locked, 'global_enabled', f.enabled,
            'plan', v_plan,
            'plan_enabled', f.enabled and case when v_plan = 'premium' then f.enabled_premium else f.enabled_free end,
            'override', (select o.enabled from public.user_page_overrides o where o.user_id = p_user and o.page_key = f.page_key),
            'effective', public._page_enabled(p_user, f.page_key))
          order by f.sort_order, f.page_key) from public.page_flags f where f.page_key <> 'settings'), '[]'::jsonb);
end $$;
-- (admin_set_user_page / admin_set_page_enabled / admin_set_page_plan_access already accept any page_flags key, add-on keys included.)

-- ---------------------------------------------------------------- Storage: private bucket 'addons' + policies
-- Object name = '<addon_id>/<version>/<addon_id>-<version>.mzaddon'.  A caller may read an object iff it is exactly the storage_path of a
-- release that exists, is not yanked and whose feature is enabled for that caller -- or the caller is an admin.  Writes: admins only.
-- No anon access at all.  (Transport only: the app still verifies the signed manifest + SHA-256 before installing.)
create or replace function public.mz_addon_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select auth.uid() is not null and exists (select 1 from public.admin_users a where a.user_id = auth.uid()) $$;

create or replace function public.mz_addon_object_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_name is not null and (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    or exists (select 1 from public.addon_releases r
                where r.addon_id = split_part(p_name, '/', 1) and r.version = split_part(p_name, '/', 2)
                  and r.storage_path = p_name and not r.yanked
                  and public._page_enabled(auth.uid(), r.feature_key)))
$$;

do $$ begin
  if to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public) values ('addons', 'addons', false)
    on conflict (id) do update set public = false;

    drop policy if exists mz_addons_select on storage.objects;
    drop policy if exists mz_addons_insert on storage.objects;
    drop policy if exists mz_addons_update on storage.objects;
    drop policy if exists mz_addons_delete on storage.objects;
    create policy mz_addons_select on storage.objects for select to authenticated
      using (bucket_id = 'addons' and public.mz_addon_object_allowed(name));
    create policy mz_addons_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'addons' and public.mz_addon_admin());
    create policy mz_addons_update on storage.objects for update to authenticated
      using (bucket_id = 'addons' and public.mz_addon_admin()) with check (bucket_id = 'addons' and public.mz_addon_admin());
    create policy mz_addons_delete on storage.objects for delete to authenticated
      using (bucket_id = 'addons' and public.mz_addon_admin());
  end if;
end $$;

-- ------------------------------------------------------------ privileges
-- new functions start with PUBLIC execute -- strip it, grant back only the intended surface.
revoke all on function public._mz_ver(text) from public, anon, authenticated;
revoke all on function public.addon_catalog(text) from public, anon, authenticated;
revoke all on function public.addon_history(text) from public, anon, authenticated;
revoke all on function public.mz_addon_admin() from public, anon, authenticated;
revoke all on function public.mz_addon_object_allowed(text) from public, anon, authenticated;
revoke all on function public.admin_list_addon_releases() from public, anon, authenticated;
revoke all on function public.admin_publish_addon(jsonb) from public, anon, authenticated;
revoke all on function public.admin_yank_addon(text, text, boolean) from public, anon, authenticated;

grant execute on function
  public.addon_catalog(text),
  public.addon_history(text),
  public.mz_addon_admin(),
  public.mz_addon_object_allowed(text),
  public.admin_list_addon_releases(),
  public.admin_publish_addon(jsonb),
  public.admin_yank_addon(text, text, boolean)
  to authenticated;
-- _mz_ver stays ungranted (underscore helper). admin_list_pages / admin_get_user_pages keep their grants (create or replace preserves ACLs).
