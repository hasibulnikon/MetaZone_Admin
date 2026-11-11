-- 0032 (v1.0.0, 9th Edition, Addon Tools Part 2A): DATABASE FOUNDATION for Addon Tools. Run AFTER 0001..0031 (needs 0001 + 0013 only).
-- Forward-only, idempotent, ONE transaction. NOT applied to any database yet and NOT executed against any PostgreSQL (none was available).
--
-- WHAT THIS IS.  Addon Tools are the new ZIP + tool.json tools (see MetaZone_js/docs/ADDON_TOOLS.md). They are a SEPARATE system from the old
-- .mzaddon Add-on System. Everything here lives in its own namespace: tables public.addon_tools_*, functions *addon_tools*, Storage bucket
-- 'addon-tools', Storage policies mz_addon_tools_*. Nothing existing is altered: no old add-on table / RPC / bucket / policy / signing key,
-- no page_flags row, no control_audit row. Only READ-ONLY use of three shared helpers: _require_admin(), _require_user(), mz_plan().
--
-- WHAT IT ADDS
--   tables   addon_tools_catalog      one row per tool: metadata + state (published, enabled) + Free/Premium switches + current / previous /
--                                     rollback release + force-update floor + revision counter (optimistic concurrency).
--            addon_tools_releases     immutable release history: signed record bytes + signature + ZIP hash/size + Storage path. A row can
--                                     only be REVOKED afterwards; identity columns can never change and a row can never be deleted.
--            addon_tools_user_access  per-user allow / deny override (beats the plan switch, never beats the tool's master switches).
--            addon_tools_audit        append-only administrative audit log (no UPDATE / DELETE possible).
--   bucket   'addon-tools' (private, 50 MB limit, zip only where this Supabase version supports those bucket columns).
--   RPCs     admin (all call _require_admin first):  admin_addon_tools_upsert_tool, _register_release, _set_current_release, _set_state,
--                  _set_plan_access, _set_user_access, _set_force_update, _set_release_revoked, _list, _list_audit
--            user (signed-in only):  addon_tools_catalog(p_app_version), addon_tools_get_release(p_tool_id)
--
-- ACCESS RULE (one place: _addon_tools_entitled).  A user may see / download a tool iff  tool.published AND tool.enabled AND has a current release
-- AND ( the user's own override, if any, else the plan switch: access_premium for Premium accounts, access_free for Free accounts ).
-- A master switch OFF beats a per-user ON (same precedence as 0013). A NEW tool is created with published=false and BOTH plan switches OFF
-- (fail closed): nothing reaches any user until an admin publishes it and grants a plan or a user.
--
-- WHAT THIS DOES NOT DO (on purpose; separate upcoming parts)
--   * It cannot sign and cannot verify a signature: Postgres here has no Ed25519. It STORES the exact signed bytes + signature that the Part 2B
--     Edge Function produces, after checking they are well-formed and agree with the columns. The APP verifies the signature (Part 1 runtime).
--     A row in addon_tools_releases is therefore NOT proof of authenticity; it is transport and bookkeeping.
--   * No Edge Function, no ZIP upload / validation, no key generation, no Admin UI, no app catalog / download / install / update / rollback code.
--   * No tool removal. Releases are permanent; a tool is taken away with set_state(published=false) and a bad release with set_release_revoked.
--     (A removal RPC, if wanted, is a later migration because it must also keep version numbers unusable.)
--   * Updates / rollback are only RECORDED here (current release, rollback_*, force_update_*) and reported by addon_tools_catalog; executing them is the app's job.
--
-- Storage object name = '<tool_id>/<version>/<tool_id>-<version>.zip'. A user may read an object iff it is exactly the package of the CURRENT, not
-- revoked release of a tool they are entitled to (admins: any object). Writes: admins only. No anon access at all.

begin;

do $$ begin
  if to_regclass('public.profiles') is null or to_regclass('public.admin_users') is null
     or to_regprocedure('public._require_admin()') is null or to_regprocedure('public._require_user()') is null
     or to_regprocedure('public.mz_plan(uuid)') is null then
    raise exception '0032 needs 0001 (accounts, plans, admin guards): run the earlier migrations first';
  end if;
end $$;

-- ====================================================================== A. helpers (internal, no client access)
-- 'MAJOR.MINOR.PATCH[-pre]' -> {MAJOR,MINOR,PATCH}; anything else -> NULL. Same grammar and same pre-release-ignored ordering as the app (manifest.py).
create or replace function public._addon_tools_ver(p text) returns integer[]
language sql immutable set search_path = public, pg_temp as $$
  select case when p ~ '^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-[0-9A-Za-z.-]{1,20})?$'
              then string_to_array(split_part(p, '-', 1), '.')::integer[] end
$$;

-- Permissions a release may declare. Defence in depth: mirrors manifest.py PERMISSIONS with status 'supported' (only 'storage' today).
-- Adding a permission later = a new migration that replaces this function, together with the app build that can grant it.
create or replace function public._addon_tools_permissions_ok(p jsonb) returns boolean
language sql immutable set search_path = public, pg_temp as $$
  select p is not null and jsonb_typeof(p) = 'array' and jsonb_array_length(p) <= 16
     and not exists (select 1 from jsonb_array_elements(p) e where jsonb_typeof(e) <> 'string' or (e #>> '{}') not in ('storage'))
$$;

-- ====================================================================== B. tables
create table if not exists public.addon_tools_catalog (
  tool_id                  text primary key check (tool_id ~ '^[a-z][a-z0-9-]{2,39}$'),
  name                     text not null check (char_length(btrim(name)) between 1 and 60),
  description              text not null default '' check (char_length(description) <= 280),
  author                   text not null default '' check (char_length(author) <= 80),
  published                boolean not null default false,          -- visible in the app catalog at all
  enabled                  boolean not null default true,           -- master switch: off = off for everybody (published state is kept)
  access_free              boolean not null default false,          -- Free plan may use it
  access_premium           boolean not null default false,          -- Premium plan may use it
  current_release_id       uuid,                                    -- the release users are offered
  previous_release_id      uuid,                                    -- what 'current' was before the last change (for "restore previous")
  rollback_from_release_id uuid,                                    -- set only while current is OLDER than the release it replaced
  rollback_reason          text check (rollback_reason is null or char_length(rollback_reason) <= 400),
  rollback_at              timestamptz,
  rollback_by              uuid,
  force_update_below       text check (force_update_below is null or public._addon_tools_ver(force_update_below) is not null),
  force_update_reason      text check (force_update_reason is null or char_length(force_update_reason) <= 400),
  force_update_at          timestamptz,
  force_update_by          uuid,
  revision                 bigint not null default 1,
  created_at               timestamptz not null default now(),
  created_by               uuid,
  updated_at               timestamptz not null default now(),
  updated_by               uuid,
  constraint addon_tools_published_needs_release check (not published or current_release_id is not null),
  constraint addon_tools_rollback_complete check ((rollback_from_release_id is null) = (rollback_at is null))
);

create table if not exists public.addon_tools_releases (
  release_id       uuid primary key,                                -- the release_id INSIDE the signed record
  tool_id          text not null references public.addon_tools_catalog(tool_id),
  version          text not null check (public._addon_tools_ver(version) is not null),
  seq              integer not null check (seq >= 1),               -- 1,2,3.. per tool, in publication order (version order equals seq order)
  zip_sha256       text not null check (zip_sha256 ~ '^[0-9a-f]{64}$'),
  zip_size         bigint not null check (zip_size between 1 and 52428800),
  storage_path     text not null,
  key_id           text not null check (key_id ~ '^[A-Za-z0-9._-]{1,64}$'),
  release_json     text not null check (char_length(release_json) between 2 and 1000000),   -- the EXACT signed bytes (UTF-8 text), never re-serialised
  release_sig      text not null check (char_length(release_sig) between 2 and 4096),       -- release.sig JSON text {key_id, alg, sig}
  min_app_version  text check (min_app_version is null or public._addon_tools_ver(min_app_version) is not null),
  permissions      jsonb not null default '[]'::jsonb check (public._addon_tools_permissions_ok(permissions)),
  file_count       integer not null check (file_count between 1 and 2000),
  notes            text not null default '' check (char_length(notes) <= 2000),
  revoked          boolean not null default false,                  -- true = apps must stop running / installing this release
  revoked_reason   text check (revoked_reason is null or char_length(revoked_reason) <= 400),
  revoked_at       timestamptz,
  revoked_by       uuid,
  created_at       timestamptz not null default now(),
  created_by       uuid,
  unique (tool_id, version),
  unique (tool_id, seq),
  unique (tool_id, release_id),                                     -- target of the composite foreign keys below
  constraint addon_tools_release_path check (storage_path = tool_id || '/' || version || '/' || tool_id || '-' || version || '.zip'),
  constraint addon_tools_release_revoked_at check (not revoked or revoked_at is not null)
);

-- current / previous / rollback release must belong to the SAME tool (composite FK; NULL = not set)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'addon_tools_catalog_current_fk') then
    alter table public.addon_tools_catalog add constraint addon_tools_catalog_current_fk
      foreign key (tool_id, current_release_id) references public.addon_tools_releases (tool_id, release_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'addon_tools_catalog_previous_fk') then
    alter table public.addon_tools_catalog add constraint addon_tools_catalog_previous_fk
      foreign key (tool_id, previous_release_id) references public.addon_tools_releases (tool_id, release_id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'addon_tools_catalog_rollback_fk') then
    alter table public.addon_tools_catalog add constraint addon_tools_catalog_rollback_fk
      foreign key (tool_id, rollback_from_release_id) references public.addon_tools_releases (tool_id, release_id);
  end if;
end $$;

create table if not exists public.addon_tools_user_access (
  tool_id    text not null references public.addon_tools_catalog(tool_id),
  user_id    uuid not null references public.profiles(id) on delete cascade,
  allowed    boolean not null,                                      -- true = grant, false = deny (both beat the plan switch)
  updated_at timestamptz not null default now(),
  updated_by uuid,
  primary key (tool_id, user_id)
);
create index if not exists addon_tools_user_access_user_idx on public.addon_tools_user_access (user_id);

create table if not exists public.addon_tools_audit (
  id            bigserial primary key,
  at            timestamptz not null default now(),
  actor         uuid,
  actor_email   text,
  action        text not null,
  tool_id       text,
  release_version text,
  detail        jsonb not null default '{}'::jsonb                  -- ids, versions, booleans, reasons: never secrets, never package bytes
);
create index if not exists addon_tools_audit_tool_idx on public.addon_tools_audit (tool_id, id desc);

-- ---- immutability. Releases: identity never changes, never deleted (only the revoked_* columns move). Audit: append-only.
create or replace function public._addon_tools_releases_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'Addon Tools releases are permanent and cannot be deleted';
  end if;
  if (new.release_id, new.tool_id, new.version, new.seq, new.zip_sha256, new.zip_size, new.storage_path, new.key_id, new.release_json,
      new.release_sig, new.min_app_version, new.permissions, new.file_count, new.notes, new.created_at, new.created_by)
     is distinct from
     (old.release_id, old.tool_id, old.version, old.seq, old.zip_sha256, old.zip_size, old.storage_path, old.key_id, old.release_json,
      old.release_sig, old.min_app_version, old.permissions, old.file_count, old.notes, old.created_at, old.created_by) then
    raise exception 'a published Addon Tools release cannot be changed: publish a new version instead';
  end if;
  return new;
end $$;
drop trigger if exists addon_tools_releases_guard on public.addon_tools_releases;
create trigger addon_tools_releases_guard before update or delete on public.addon_tools_releases
  for each row execute function public._addon_tools_releases_guard();

create or replace function public._addon_tools_audit_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'the Addon Tools audit log is append-only';
end $$;
drop trigger if exists addon_tools_audit_guard on public.addon_tools_audit;
create trigger addon_tools_audit_guard before update or delete on public.addon_tools_audit
  for each row execute function public._addon_tools_audit_guard();

-- ---- RLS: ON everywhere, NO policies and NO grants for anon / authenticated = no direct access at all (default deny).
-- Every read / write goes through the security-definer RPCs below, which check who the caller is. (Not FORCEd: the definer functions run as the owner.)
alter table public.addon_tools_catalog     enable row level security;
alter table public.addon_tools_releases    enable row level security;
alter table public.addon_tools_user_access enable row level security;
alter table public.addon_tools_audit       enable row level security;
revoke all on public.addon_tools_catalog, public.addon_tools_releases, public.addon_tools_user_access, public.addon_tools_audit from public, anon, authenticated;
revoke all on sequence public.addon_tools_audit_id_seq from public, anon, authenticated;

-- ====================================================================== C. internal functions that need the tables
create or replace function public._addon_tools_audit(p_action text, p_tool text, p_version text default null, p_detail jsonb default '{}'::jsonb) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.addon_tools_audit(actor, actor_email, action, tool_id, release_version, detail)
  values (auth.uid(), (select p.email from public.profiles p where p.id = auth.uid()), p_action, p_tool, p_version, coalesce(p_detail, '{}'::jsonb));
end $$;

-- The ONE place the access rule lives.
create or replace function public._addon_tools_entitled(p_user uuid, p_tool text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce((
    select c.published and c.enabled and c.current_release_id is not null
           and coalesce((select o.allowed from public.addon_tools_user_access o where o.user_id = p_user and o.tool_id = c.tool_id),
                        case when public.mz_plan(p_user) = 'premium' then c.access_premium else c.access_free end)
      from public.addon_tools_catalog c where c.tool_id = p_tool), false)
$$;

-- ====================================================================== D. admin RPCs
-- Shared conventions: every function calls _require_admin() first; takes the per-tool advisory lock; the optional p_expected_revision makes a stale
-- admin screen fail instead of overwriting someone else's change; every change bumps catalog.revision and writes one audit row.

create or replace function public.admin_addon_tools_upsert_tool(p_tool_id text, p_name text, p_description text default '', p_author text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_name text := btrim(coalesce(p_name, '')); v_desc text := btrim(coalesce(p_description, '')); v_auth text := btrim(coalesce(p_author, ''));
        existed boolean; c public.addon_tools_catalog;
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'invalid tool id (3-40 chars: a-z, 0-9, hyphen, starting with a letter)'; end if;
  if v_name = '' or char_length(v_name) > 60 then raise exception 'name is required (max 60 characters)'; end if;
  if char_length(v_desc) > 280 then raise exception 'description too long (max 280 characters)'; end if;
  if char_length(v_auth) > 80 then raise exception 'author too long (max 80 characters)'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  existed := exists (select 1 from public.addon_tools_catalog where tool_id = p_tool_id);
  insert into public.addon_tools_catalog(tool_id, name, description, author, created_by, updated_by)
  values (p_tool_id, v_name, v_desc, v_auth, auth.uid(), auth.uid())
  on conflict (tool_id) do update
    set name = excluded.name, description = excluded.description, author = excluded.author,
        revision = public.addon_tools_catalog.revision + 1, updated_at = now(), updated_by = auth.uid()
  returning * into c;
  perform public._addon_tools_audit(case when existed then 'tool_edit' else 'tool_create' end, p_tool_id, null, jsonb_build_object('name', v_name));
  return to_jsonb(c);
end $$;

-- Stores one signed release. Called with an ADMIN session by the Part 2B Edge Function after it has validated the ZIP, hashed it, uploaded it to the
-- 'addon-tools' bucket and signed the record. The release is stored but NOT offered: admin_addon_tools_set_current_release makes it current.
-- p = { tool_id, release_json (text, the exact signed bytes), release_sig (text, release.sig JSON), notes? }.
-- Everything else (version, hash, size, key id, permissions, min app version, file count, release id) is READ FROM the signed record, so the columns
-- can never disagree with what the app will verify.
create or replace function public.admin_addon_tools_register_release(p jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_tool text; v_rj text; v_sig text; v_notes text; v_doc jsonb; v_sd jsonb; v_id uuid; v_ver text; v_sha text; v_size bigint; v_key text;
  v_mav text; v_perms jsonb; v_nfiles integer; v_path text; v_seq integer; v_obj jsonb; r public.addon_tools_releases;
begin
  perform public._require_admin();
  if p is null or jsonb_typeof(p) <> 'object' then raise exception 'request must be a JSON object'; end if;
  v_tool := p->>'tool_id'; v_rj := p->>'release_json'; v_sig := p->>'release_sig'; v_notes := btrim(coalesce(p->>'notes', ''));
  if v_tool is null or v_tool !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'invalid tool id'; end if;
  if v_rj is null or v_sig is null then raise exception 'release_json and release_sig are required'; end if;
  if char_length(v_notes) > 2000 then raise exception 'notes too long (max 2000 characters)'; end if;

  begin v_doc := v_rj::jsonb; exception when others then raise exception 'release_json is not valid JSON'; end;
  begin v_sd  := v_sig::jsonb; exception when others then raise exception 'release_sig is not valid JSON'; end;
  if jsonb_typeof(v_doc) <> 'object' or jsonb_typeof(v_sd) <> 'object' then raise exception 'release_json and release_sig must be JSON objects'; end if;
  if v_doc->'schema' is distinct from '1'::jsonb or v_doc->>'kind' is distinct from 'mz-addon-tool-release' then
    raise exception 'release_json is not an Addon Tools release record (schema 1)';
  end if;
  if v_doc->>'tool_id' is distinct from v_tool or v_doc #>> '{manifest,id}' is distinct from v_tool then
    raise exception 'the signed record is for a different tool than tool_id';
  end if;
  v_ver := v_doc->>'version';
  if v_ver is null or public._addon_tools_ver(v_ver) is null or v_doc #>> '{manifest,version}' is distinct from v_ver then
    raise exception 'the signed record has an invalid version, or manifest.version differs from it';
  end if;
  v_sha := v_doc->>'zip_sha256';
  if v_sha is null or v_sha !~ '^[0-9a-f]{64}$' then raise exception 'the signed record has no valid zip_sha256'; end if;
  begin v_size := (v_doc->>'zip_size')::bigint; exception when others then raise exception 'the signed record has no valid zip_size'; end;
  if v_size is null or v_size < 1 or v_size > 52428800 then raise exception 'zip_size must be between 1 byte and 50 MB'; end if;
  begin v_id := (v_doc->>'release_id')::uuid; exception when others then raise exception 'the signed record has no valid release_id (uuid)'; end;
  if v_id is null then raise exception 'the signed record has no valid release_id (uuid)'; end if;
  v_key := v_doc->>'key_id';
  if v_key is null or v_key !~ '^[A-Za-z0-9._-]{1,64}$' then raise exception 'the signed record has no valid key_id'; end if;
  if v_sd->>'key_id' is distinct from v_key or v_sd->>'alg' is distinct from 'ed25519'
     or coalesce(v_sd->>'sig', '') !~ '^[A-Za-z0-9+/]{86}==$' then
    raise exception 'release_sig must be {key_id (same as the record), alg "ed25519", sig (base64 of 64 bytes)}';
  end if;
  if jsonb_typeof(v_doc->'files') is distinct from 'array' or jsonb_array_length(v_doc->'files') not between 1 and 2000 then
    raise exception 'the signed record must list between 1 and 2000 files';
  end if;
  v_nfiles := jsonb_array_length(v_doc->'files');
  v_perms := coalesce(v_doc #> '{manifest,permissions}', '[]'::jsonb);
  if not public._addon_tools_permissions_ok(v_perms) then raise exception 'the manifest asks for a permission this system cannot grant'; end if;
  v_mav := v_doc #>> '{manifest,min_app_version}';
  if v_mav is not null and public._addon_tools_ver(v_mav) is null then raise exception 'manifest.min_app_version is invalid'; end if;
  v_path := v_tool || '/' || v_ver || '/' || v_tool || '-' || v_ver || '.zip';

  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || v_tool));
  if not exists (select 1 from public.addon_tools_catalog where tool_id = v_tool) then
    raise exception 'unknown tool %: create it first (admin_addon_tools_upsert_tool)', v_tool;
  end if;
  if exists (select 1 from public.addon_tools_releases x where x.tool_id = v_tool and public._addon_tools_ver(x.version) >= public._addon_tools_ver(v_ver)) then
    raise exception 'version % of % is not higher than an existing release: use a new, higher version number', v_ver, v_tool;
  end if;
  select coalesce(max(seq), 0) + 1 into v_seq from public.addon_tools_releases where tool_id = v_tool;

  -- The package must really be in Storage (skipped where there is no storage schema). Size is compared when Storage reports it.
  if to_regclass('storage.objects') is not null then
    execute 'select to_jsonb(o) from storage.objects o where o.bucket_id = $1 and o.name = $2 limit 1' into v_obj using 'addon-tools', v_path;
    if v_obj is null then raise exception 'package not found in Storage at %: upload it first', v_path; end if;
    if coalesce(v_obj #>> '{metadata,size}', '') ~ '^[0-9]+$' and (v_obj #>> '{metadata,size}')::bigint <> v_size then
      raise exception 'size in Storage (%) differs from the signed zip_size (%)', v_obj #>> '{metadata,size}', v_size;
    end if;
  end if;

  insert into public.addon_tools_releases(release_id, tool_id, version, seq, zip_sha256, zip_size, storage_path, key_id, release_json, release_sig,
                                          min_app_version, permissions, file_count, notes, created_by)
  values (v_id, v_tool, v_ver, v_seq, v_sha, v_size, v_path, v_key, v_rj, v_sig, v_mav, v_perms, v_nfiles, v_notes, auth.uid())
  returning * into r;
  update public.addon_tools_catalog set revision = revision + 1, updated_at = now(), updated_by = auth.uid() where tool_id = v_tool;
  perform public._addon_tools_audit('release_register', v_tool, v_ver, jsonb_build_object('release_id', v_id, 'seq', v_seq, 'zip_sha256', v_sha, 'key_id', v_key));
  return jsonb_build_object('release_id', r.release_id, 'tool_id', r.tool_id, 'version', r.version, 'seq', r.seq, 'storage_path', r.storage_path,
                            'zip_sha256', r.zip_sha256, 'zip_size', r.zip_size, 'key_id', r.key_id, 'offered', false);
end $$;

-- Makes one release the one users are offered. Newer than the current one = a normal update (clears any rollback marker).
-- OLDER than the current one = a ROLLBACK: a reason is required, and rollback_* records what it replaced so the app may accept the downgrade.
create or replace function public.admin_addon_tools_set_current_release(p_tool_id text, p_version text, p_reason text default null, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.addon_tools_catalog; r public.addon_tools_releases; cur public.addon_tools_releases; v_reason text := btrim(coalesce(p_reason, '')); v_rollback boolean := false;
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' or p_version is null then raise exception 'unknown release'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  select * into c from public.addon_tools_catalog where tool_id = p_tool_id for update;
  if not found then raise exception 'unknown tool'; end if;
  if p_expected_revision is not null and p_expected_revision is distinct from c.revision then
    raise exception 'stale: % was changed by someone else (now revision %). Reload the page and try again.', p_tool_id, c.revision;
  end if;
  select * into r from public.addon_tools_releases where tool_id = p_tool_id and version = p_version;
  if not found then raise exception 'unknown release'; end if;
  if r.revoked then raise exception 'version % is revoked and cannot be made current (un-revoke it first, or choose another version)', p_version; end if;
  if c.current_release_id = r.release_id then raise exception 'version % is already the current release', p_version; end if;
  if char_length(v_reason) > 400 then raise exception 'reason too long (max 400 characters)'; end if;
  if c.force_update_below is not null and public._addon_tools_ver(r.version) < public._addon_tools_ver(c.force_update_below) then
    raise exception 'version % is below the force-update floor (%): clear or lower the force update first', p_version, c.force_update_below;
  end if;
  if c.current_release_id is not null then
    select * into cur from public.addon_tools_releases where release_id = c.current_release_id;
    v_rollback := r.seq < cur.seq;
  end if;
  if v_rollback and v_reason = '' then raise exception 'a rollback needs a reason'; end if;

  update public.addon_tools_catalog
     set previous_release_id = c.current_release_id, current_release_id = r.release_id,
         rollback_from_release_id = case when v_rollback then c.current_release_id end,
         rollback_reason = case when v_rollback then v_reason end,
         rollback_at = case when v_rollback then now() end,
         rollback_by = case when v_rollback then auth.uid() end,
         revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where tool_id = p_tool_id returning * into c;
  perform public._addon_tools_audit(case when v_rollback then 'release_rollback' else 'release_set_current' end, p_tool_id, r.version,
                                    jsonb_build_object('release_id', r.release_id, 'from_version', cur.version, 'reason', nullif(v_reason, ''), 'revision', c.revision));
  return to_jsonb(c);
end $$;

-- Publish / unpublish and enable / disable. NULL = leave unchanged. Publishing needs a current, not revoked release.
create or replace function public.admin_addon_tools_set_state(p_tool_id text, p_published boolean default null, p_enabled boolean default null, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.addon_tools_catalog; n public.addon_tools_catalog; v_cur public.addon_tools_releases;
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'unknown tool'; end if;
  if p_published is null and p_enabled is null then raise exception 'nothing to change'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  select * into c from public.addon_tools_catalog where tool_id = p_tool_id for update;
  if not found then raise exception 'unknown tool'; end if;
  if p_expected_revision is not null and p_expected_revision is distinct from c.revision then
    raise exception 'stale: % was changed by someone else (now revision %). Reload the page and try again.', p_tool_id, c.revision;
  end if;
  if p_published is true then
    if c.current_release_id is null then raise exception '% has no current release: register a release and make it current first', p_tool_id; end if;
    select * into v_cur from public.addon_tools_releases where release_id = c.current_release_id;
    if v_cur.revoked then raise exception 'the current release (%) is revoked: choose another current release first', v_cur.version; end if;
  end if;
  update public.addon_tools_catalog
     set published = coalesce(p_published, published), enabled = coalesce(p_enabled, enabled),
         revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where tool_id = p_tool_id returning * into n;
  if n.published is distinct from c.published then
    perform public._addon_tools_audit(case when n.published then 'tool_publish' else 'tool_unpublish' end, p_tool_id, null, jsonb_build_object('revision', n.revision));
  end if;
  if n.enabled is distinct from c.enabled then
    perform public._addon_tools_audit(case when n.enabled then 'tool_enable' else 'tool_disable' end, p_tool_id, null, jsonb_build_object('revision', n.revision));
  end if;
  return to_jsonb(n);
end $$;

-- Free / Premium switches. NULL = leave unchanged.
create or replace function public.admin_addon_tools_set_plan_access(p_tool_id text, p_free boolean default null, p_premium boolean default null, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.addon_tools_catalog; n public.addon_tools_catalog;
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'unknown tool'; end if;
  if p_free is null and p_premium is null then raise exception 'nothing to change'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  select * into c from public.addon_tools_catalog where tool_id = p_tool_id for update;
  if not found then raise exception 'unknown tool'; end if;
  if p_expected_revision is not null and p_expected_revision is distinct from c.revision then
    raise exception 'stale: % was changed by someone else (now revision %). Reload the page and try again.', p_tool_id, c.revision;
  end if;
  update public.addon_tools_catalog
     set access_free = coalesce(p_free, access_free), access_premium = coalesce(p_premium, access_premium),
         revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where tool_id = p_tool_id returning * into n;
  perform public._addon_tools_audit('access_plan', p_tool_id, null,
    jsonb_build_object('free', n.access_free, 'premium', n.access_premium, 'was_free', c.access_free, 'was_premium', c.access_premium));
  return to_jsonb(n);
end $$;

-- Per-user override: true = grant, false = deny, NULL = remove the override (the plan switch decides again).
create or replace function public.admin_addon_tools_set_user_access(p_tool_id text, p_user uuid, p_allowed boolean default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'unknown tool'; end if;
  if p_user is null or not exists (select 1 from public.profiles where id = p_user) then raise exception 'unknown user'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  if not exists (select 1 from public.addon_tools_catalog where tool_id = p_tool_id) then raise exception 'unknown tool'; end if;
  if p_allowed is null then
    delete from public.addon_tools_user_access where tool_id = p_tool_id and user_id = p_user;
  else
    insert into public.addon_tools_user_access(tool_id, user_id, allowed, updated_by) values (p_tool_id, p_user, p_allowed, auth.uid())
    on conflict (tool_id, user_id) do update set allowed = excluded.allowed, updated_at = now(), updated_by = auth.uid();
  end if;
  update public.addon_tools_catalog set revision = revision + 1, updated_at = now(), updated_by = auth.uid() where tool_id = p_tool_id;
  perform public._addon_tools_audit(case when p_allowed is null then 'access_user_clear' else 'access_user_set' end, p_tool_id, null,
                                    jsonb_build_object('user_id', p_user, 'allowed', p_allowed));
  return jsonb_build_object('tool_id', p_tool_id, 'user_id', p_user, 'allowed', p_allowed,
                            'entitled_now', public._addon_tools_entitled(p_user, p_tool_id));
end $$;

-- Force update: apps that have this tool installed below p_min_version must update to the current release before running it.
-- NULL p_min_version clears it. The floor must not exceed the current release (an unreachable floor would lock everybody out).
create or replace function public.admin_addon_tools_set_force_update(p_tool_id text, p_min_version text default null, p_reason text default null, p_expected_revision bigint default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c public.addon_tools_catalog; n public.addon_tools_catalog; cur public.addon_tools_releases; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'unknown tool'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  select * into c from public.addon_tools_catalog where tool_id = p_tool_id for update;
  if not found then raise exception 'unknown tool'; end if;
  if p_expected_revision is not null and p_expected_revision is distinct from c.revision then
    raise exception 'stale: % was changed by someone else (now revision %). Reload the page and try again.', p_tool_id, c.revision;
  end if;
  if p_min_version is not null then
    if public._addon_tools_ver(p_min_version) is null then raise exception 'version must look like 1.2.3'; end if;
    if char_length(v_reason) > 400 then raise exception 'reason too long (max 400 characters)'; end if;
    select * into cur from public.addon_tools_releases where release_id = c.current_release_id;
    if not found then raise exception '% has no current release to update to', p_tool_id; end if;
    if public._addon_tools_ver(p_min_version) > public._addon_tools_ver(cur.version) then
      raise exception 'the force-update version (%) is above the current release (%)', p_min_version, cur.version;
    end if;
  end if;
  update public.addon_tools_catalog
     set force_update_below = p_min_version, force_update_reason = case when p_min_version is null then null else nullif(v_reason, '') end,
         force_update_at = case when p_min_version is null then null else now() end, force_update_by = case when p_min_version is null then null else auth.uid() end,
         revision = revision + 1, updated_at = now(), updated_by = auth.uid()
   where tool_id = p_tool_id returning * into n;
  perform public._addon_tools_audit(case when p_min_version is null then 'force_update_clear' else 'force_update_set' end, p_tool_id, p_min_version,
                                    jsonb_build_object('below', p_min_version, 'reason', nullif(v_reason, ''), 'was', c.force_update_below));
  return to_jsonb(n);
end $$;

-- Revoke / un-revoke a release: tells every app to stop running or installing it. The CURRENT release cannot be revoked: make another one current first.
create or replace function public.admin_addon_tools_set_release_revoked(p_tool_id text, p_version text, p_revoked boolean, p_reason text default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.addon_tools_releases; c public.addon_tools_catalog; v_reason text := btrim(coalesce(p_reason, ''));
begin
  perform public._require_admin();
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' or p_version is null or p_revoked is null then raise exception 'unknown release'; end if;
  if char_length(v_reason) > 400 then raise exception 'reason too long (max 400 characters)'; end if;
  perform pg_advisory_xact_lock(hashtext('mz_addon_tools:' || p_tool_id));
  select * into c from public.addon_tools_catalog where tool_id = p_tool_id for update;
  if not found then raise exception 'unknown tool'; end if;
  select * into r from public.addon_tools_releases where tool_id = p_tool_id and version = p_version for update;
  if not found then raise exception 'unknown release'; end if;
  if p_revoked and r.release_id = c.current_release_id then
    raise exception 'version % is the current release: make another version current (or unpublish the tool) before revoking it', p_version;
  end if;
  if p_revoked and v_reason = '' then raise exception 'revoking needs a reason'; end if;
  if r.revoked = p_revoked then raise exception 'version % is already %', p_version, case when p_revoked then 'revoked' else 'not revoked' end; end if;
  update public.addon_tools_releases
     set revoked = p_revoked, revoked_reason = case when p_revoked then v_reason end,
         revoked_at = case when p_revoked then now() end, revoked_by = case when p_revoked then auth.uid() end
   where release_id = r.release_id returning * into r;
  update public.addon_tools_catalog set revision = revision + 1, updated_at = now(), updated_by = auth.uid() where tool_id = p_tool_id;
  perform public._addon_tools_audit(case when p_revoked then 'release_revoke' else 'release_unrevoke' end, p_tool_id, p_version,
                                    jsonb_build_object('release_id', r.release_id, 'reason', nullif(v_reason, '')));
  return jsonb_build_object('tool_id', p_tool_id, 'version', p_version, 'revoked', r.revoked, 'revoked_at', r.revoked_at);
end $$;

-- Everything the future Admin screen needs in one call: tools, their releases (WITHOUT the signed bytes), per-user overrides.
create or replace function public.admin_addon_tools_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'tool_id', c.tool_id, 'name', c.name, 'description', c.description, 'author', c.author,
      'published', c.published, 'enabled', c.enabled, 'access_free', c.access_free, 'access_premium', c.access_premium,
      'current_release_id', c.current_release_id, 'previous_release_id', c.previous_release_id,
      'current_version', (select x.version from public.addon_tools_releases x where x.release_id = c.current_release_id),
      'previous_version', (select x.version from public.addon_tools_releases x where x.release_id = c.previous_release_id),
      'rollback', case when c.rollback_from_release_id is null then null else jsonb_build_object(
          'from_version', (select x.version from public.addon_tools_releases x where x.release_id = c.rollback_from_release_id),
          'reason', c.rollback_reason, 'at', c.rollback_at, 'by', c.rollback_by) end,
      'force_update_below', c.force_update_below, 'force_update_reason', c.force_update_reason, 'force_update_at', c.force_update_at,
      'revision', c.revision, 'created_at', c.created_at, 'updated_at', c.updated_at,
      'releases', coalesce((select jsonb_agg(jsonb_build_object(
            'release_id', r.release_id, 'version', r.version, 'seq', r.seq, 'zip_sha256', r.zip_sha256, 'zip_size', r.zip_size,
            'storage_path', r.storage_path, 'key_id', r.key_id, 'min_app_version', r.min_app_version, 'permissions', r.permissions,
            'file_count', r.file_count, 'notes', r.notes, 'revoked', r.revoked, 'revoked_reason', r.revoked_reason, 'revoked_at', r.revoked_at,
            'created_at', r.created_at, 'is_current', (r.release_id = c.current_release_id)) order by r.seq desc)
          from public.addon_tools_releases r where r.tool_id = c.tool_id), '[]'::jsonb),
      'user_access', coalesce((select jsonb_agg(jsonb_build_object(
            'user_id', u.user_id, 'email', p.email, 'allowed', u.allowed, 'updated_at', u.updated_at) order by p.email)
          from public.addon_tools_user_access u join public.profiles p on p.id = u.user_id where u.tool_id = c.tool_id), '[]'::jsonb))
      order by c.tool_id)
      from public.addon_tools_catalog c), '[]'::jsonb);
end $$;

create or replace function public.admin_addon_tools_list_audit(p_tool_id text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('id', a.id, 'at', a.at, 'actor_email', a.actor_email, 'action', a.action,
                                                       'tool_id', a.tool_id, 'version', a.release_version, 'detail', a.detail) order by a.id desc)
                     from (select * from public.addon_tools_audit x where p_tool_id is null or x.tool_id = p_tool_id
                            order by x.id desc limit least(greatest(coalesce(p_limit, 50), 1), 500)) a), '[]'::jsonb);
end $$;

-- ====================================================================== E. user RPCs (signed-in only; the app never reads a table)
-- Catalog: the tools THIS user is entitled to, each with its current release summary (hashes, no signed bytes), the update / rollback markers,
-- plus a global list of revoked releases so apps stop running them even after a user's access ended.
-- p_app_version: the running app version; a release whose min_app_version is higher is reported available=false (reason given), never hidden.
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

-- The signed record of the CURRENT release of one tool the caller is entitled to: exactly what the app verifies (bytes + signature) before it installs.
create or replace function public.addon_tools_get_release(p_tool_id text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare uid uuid := public._require_user(); r public.addon_tools_releases;
begin
  if p_tool_id is null or p_tool_id !~ '^[a-z][a-z0-9-]{2,39}$' then raise exception 'unknown tool'; end if;
  if not public._addon_tools_entitled(uid, p_tool_id) then raise exception 'unknown tool'; end if;           -- same answer for "no such tool" and "not yours"
  select r0.* into r from public.addon_tools_releases r0 join public.addon_tools_catalog c on c.current_release_id = r0.release_id and c.tool_id = r0.tool_id
   where c.tool_id = p_tool_id and not r0.revoked;
  if not found then raise exception 'unknown tool'; end if;
  return jsonb_build_object('tool_id', r.tool_id, 'version', r.version, 'release_id', r.release_id, 'storage_path', r.storage_path,
                            'zip_sha256', r.zip_sha256, 'zip_size', r.zip_size, 'key_id', r.key_id,
                            'release_json', r.release_json, 'release_sig', r.release_sig);
end $$;

-- ====================================================================== F. Storage: private bucket 'addon-tools' + policies (own names, old 'addons' bucket untouched)
create or replace function public.mz_addon_tools_admin() returns boolean
language sql stable security definer set search_path = public, pg_temp as
$$ select auth.uid() is not null and exists (select 1 from public.admin_users a where a.user_id = auth.uid()) $$;

create or replace function public.mz_addon_tools_object_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_name is not null and (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    or exists (select 1 from public.addon_tools_catalog c
                 join public.addon_tools_releases r on r.release_id = c.current_release_id and r.tool_id = c.tool_id
                where c.tool_id = split_part(p_name, '/', 1) and r.storage_path = p_name and not r.revoked
                  and public._addon_tools_entitled(auth.uid(), c.tool_id)))
$$;

do $$ begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public) values ('addon-tools', 'addon-tools', false)
    on conflict (id) do update set public = false;
    -- size / type limits only where this Supabase version has the columns
    if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
      execute 'update storage.buckets set file_size_limit = 52428800 where id = ''addon-tools''';
    end if;
    if exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'allowed_mime_types') then
      execute 'update storage.buckets set allowed_mime_types = array[''application/zip'', ''application/x-zip-compressed'', ''application/octet-stream''] where id = ''addon-tools''';
    end if;
  end if;
  if to_regclass('storage.objects') is not null then
    drop policy if exists mz_addon_tools_select on storage.objects;
    drop policy if exists mz_addon_tools_insert on storage.objects;
    drop policy if exists mz_addon_tools_update on storage.objects;
    drop policy if exists mz_addon_tools_delete on storage.objects;
    create policy mz_addon_tools_select on storage.objects for select to authenticated
      using (bucket_id = 'addon-tools' and public.mz_addon_tools_object_allowed(name));
    create policy mz_addon_tools_insert on storage.objects for insert to authenticated
      with check (bucket_id = 'addon-tools' and public.mz_addon_tools_admin());
    create policy mz_addon_tools_update on storage.objects for update to authenticated
      using (bucket_id = 'addon-tools' and public.mz_addon_tools_admin()) with check (bucket_id = 'addon-tools' and public.mz_addon_tools_admin());
    create policy mz_addon_tools_delete on storage.objects for delete to authenticated
      using (bucket_id = 'addon-tools' and public.mz_addon_tools_admin());
  end if;
end $$;

-- ====================================================================== G. privileges
-- New functions start with PUBLIC execute: strip it everywhere, then grant back only the intended surface.
revoke all on function
  public._addon_tools_ver(text), public._addon_tools_permissions_ok(jsonb),
  public._addon_tools_releases_guard(), public._addon_tools_audit_guard(),
  public._addon_tools_audit(text, text, text, jsonb), public._addon_tools_entitled(uuid, text),
  public.admin_addon_tools_upsert_tool(text, text, text, text), public.admin_addon_tools_register_release(jsonb),
  public.admin_addon_tools_set_current_release(text, text, text, bigint), public.admin_addon_tools_set_state(text, boolean, boolean, bigint),
  public.admin_addon_tools_set_plan_access(text, boolean, boolean, bigint), public.admin_addon_tools_set_user_access(text, uuid, boolean),
  public.admin_addon_tools_set_force_update(text, text, text, bigint), public.admin_addon_tools_set_release_revoked(text, text, boolean, text),
  public.admin_addon_tools_list(), public.admin_addon_tools_list_audit(text, integer),
  public.addon_tools_catalog(text), public.addon_tools_get_release(text),
  public.mz_addon_tools_admin(), public.mz_addon_tools_object_allowed(text)
  from public, anon, authenticated;

grant execute on function
  public.admin_addon_tools_upsert_tool(text, text, text, text),
  public.admin_addon_tools_register_release(jsonb),
  public.admin_addon_tools_set_current_release(text, text, text, bigint),
  public.admin_addon_tools_set_state(text, boolean, boolean, bigint),
  public.admin_addon_tools_set_plan_access(text, boolean, boolean, bigint),
  public.admin_addon_tools_set_user_access(text, uuid, boolean),
  public.admin_addon_tools_set_force_update(text, text, text, bigint),
  public.admin_addon_tools_set_release_revoked(text, text, boolean, text),
  public.admin_addon_tools_list(),
  public.admin_addon_tools_list_audit(text, integer),
  public.addon_tools_catalog(text),
  public.addon_tools_get_release(text)
  to authenticated;                                     -- admin_* refuse non-admins inside (_require_admin); addon_tools_* need a signed-in user
-- Storage policy helpers are evaluated with the caller's privileges (Storage runs policies as 'authenticated'), so they need EXECUTE; they only
-- answer yes/no for the caller's own auth.uid() and are not callable by anon.
grant execute on function public.mz_addon_tools_admin(), public.mz_addon_tools_object_allowed(text) to authenticated;

commit;
