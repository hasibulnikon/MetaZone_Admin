-- 0022 (app version stays v1.0.0): signed provider packages (version / signature columns), ONE package size limit, and the Admin "Force Update"
-- job system for provider packages and model definitions. FORWARD-ONLY, idempotent, one transaction. Run AFTER 0001..0021.
-- NOT APPLIED to any database (prepared for review). Does not touch 0008 (ai_access), 0019 / 0020 (Tracker), signing keys, secrets or any user's API key.
--
-- WHAT IT ADDS
--   columns  ai_provider_packages: package_id, version, min_app, unpacked_bytes, signature (the publisher's Ed25519 envelope; PUBLIC data - the private key is
--            never in the database), + constraints; size limit stays 5 MiB (= providers/limits.py = Admin provider_logic.js = bucket file_size_limit)
--   tables   ai_force_update_jobs     one row per Admin push (provider package or one model definition), idempotent while active
--            ai_force_update_targets  one row per (job, user, device): pending -> downloading -> installing -> completed | failed | retrying | cancelled
--            ai_revoked_signing_keys  key ids the apps must stop trusting (catalogue-delivered revocation; can only REMOVE trust)
--   admin    admin_preview_ai_force_update, admin_push_ai_force_update, admin_cancel_ai_force_update, admin_rollback_ai_force_update,
--            admin_list_ai_force_updates, admin_list_ai_force_update_targets, admin_purge_ai_force_updates, admin_revoke_ai_signing_key,
--            admin_attach_ai_package_signature; admin_register_ai_package / admin_publish_ai_package are replaced (signature + version rules)
--   users    get_ai_pending_updates(device), get_ai_force_update_package(job), ack_ai_force_update(job, device, status, ...)  - all bound to auth.uid()
--   storage  mz_ai_pkg_allowed also lets a signed-in user read the package a still-active force-update job points at (policy objects unchanged)
-- RULES THE SERVER ENFORCES
--   * only an Admin pushes / cancels / rolls back; tables are closed to every client role (RLS on, all privileges revoked) - the functions are the only door;
--   * a user can only fetch / acknowledge jobs for HIS OWN auth.uid(); nobody can read another user's target rows, keys or private data; no API key or secret is
--     ever part of a job or an acknowledgement (error text is length-limited and cleaned by the app);
--   * pushing needs the confirmation value shown by the preview (the target's SHA-256 / model digest), so a push is always an explicit decision;
--   * the same push twice while active returns the SAME job (no duplicate job); a newer push for the same target supersedes the older active job;
--   * publishing needs a signature envelope that names this package's SHA-256 / size / provider / version; the APP verifies the signature (the database cannot);
--   * cancel never rolls back what is already installed - that is the separate admin_rollback_ai_force_update.
begin;

-- ====================================================================== A. safety stops (nothing is changed if one fires)
do $$
begin
  if to_regclass('public.ai_provider_packages') is null or to_regclass('public.ai_providers') is null or to_regclass('public.ai_provider_models') is null then
    raise exception '0022 stopped: migration 0021 (ai_provider_catalog) has not been applied. Nothing was changed. Run 0001..0021 first.' using errcode = '55000';
  end if;
  if to_regclass('public.ai_access') is null or to_regprocedure('public._require_admin()') is null or to_regprocedure('public._audit(text,text,jsonb)') is null then
    raise exception '0022 stopped: migrations 0001..0013 are incomplete (ai_access / _require_admin / _audit missing). Nothing was changed.' using errcode = '55000';
  end if;
  if to_regclass('public.retired_page_keys') is null then
    raise exception '0022 stopped: migrations 0018 / 0019 have not been applied. Nothing was changed. Run 0001..0021 in order.' using errcode = '55000';
  end if;
  if exists (select 1 from public.retired_page_keys where page_key = 'tracker') then
    raise exception '0022 stopped: migration 0020 (restore_tracker_page) has not been applied - public.retired_page_keys still lists ''tracker''. Nothing was changed. Run 0020, then 0022.' using errcode = '55000';
  end if;
  if to_regprocedure('public.mz_addon_admin()') is null then
    raise exception '0022 stopped: public.mz_addon_admin() is missing (migration 0012). Nothing was changed.' using errcode = '55000';
  end if;
end $$;

-- ====================================================================== B. package metadata + one size limit
alter table public.ai_provider_packages
  add column if not exists package_id     text,
  add column if not exists version        text,
  add column if not exists min_app        text,
  add column if not exists unpacked_bytes integer,
  add column if not exists signature      jsonb;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ai_pkg_version_semver' and conrelid = 'public.ai_provider_packages'::regclass) then
    alter table public.ai_provider_packages add constraint ai_pkg_version_semver
      check (version is null or version ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_pkg_min_app_semver' and conrelid = 'public.ai_provider_packages'::regclass) then
    alter table public.ai_provider_packages add constraint ai_pkg_min_app_semver
      check (min_app is null or min_app ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_pkg_unpacked_limit' and conrelid = 'public.ai_provider_packages'::regclass) then
    -- 20 MiB uncompressed (= providers/limits.py MAX_UNPACKED_BYTES). The compressed limit stays 5 MiB (0021: size_bytes <= 5242880).
    alter table public.ai_provider_packages add constraint ai_pkg_unpacked_limit check (unpacked_bytes is null or (unpacked_bytes > 0 and unpacked_bytes <= 20971520));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'ai_pkg_package_id_shape' and conrelid = 'public.ai_provider_packages'::regclass) then
    alter table public.ai_provider_packages add constraint ai_pkg_package_id_shape check (package_id is null or package_id ~ '^mz\.provider\.[a-z][a-z0-9_.-]{0,39}$');
  end if;
end $$;

do $$ begin
  if to_regclass('storage.buckets') is not null
     and exists (select 1 from information_schema.columns where table_schema = 'storage' and table_name = 'buckets' and column_name = 'file_size_limit') then
    -- the same 5 MiB as the table constraint: Storage itself refuses a bigger file, so an oversized package cannot even be uploaded
    execute 'update storage.buckets set file_size_limit = 5242880 where id = $1' using 'ai-providers';
  end if;
end $$;

create or replace function public._mz_semver_cmp(a text, b text) returns integer
language sql immutable as $$
  select case when pa > pb then 1 when pa < pb then -1 else 0 end
    from (select string_to_array(coalesce(nullif(a, ''), '0.0.0'), '.')::int[] as pa, string_to_array(coalesce(nullif(b, ''), '0.0.0'), '.')::int[] as pb) v
$$;

-- ====================================================================== C. tables
create table if not exists public.ai_revoked_signing_keys (
  key_id     text primary key check (key_id ~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$'),
  reason     text not null default '' check (char_length(reason) <= 200),
  revoked_at timestamptz not null default now(),
  revoked_by uuid
);

create table if not exists public.ai_force_update_jobs (
  id              uuid primary key default gen_random_uuid(),
  kind            text not null default 'update' check (kind in ('update', 'rollback')),
  scope           text not null check (scope in ('provider', 'model')),
  provider_key    text not null references public.ai_providers(provider_key) on delete cascade,
  model_id        text check (model_id is null or char_length(model_id) between 1 and 120),
  package_id      uuid references public.ai_provider_packages(id),
  target_sha256   text check (target_sha256 is null or target_sha256 ~ '^[0-9a-f]{64}$'),
  target_version  text,
  target_size     integer check (target_size is null or (target_size > 0 and target_size <= 5242880)),
  model_snapshot  jsonb,
  rollback_of     uuid references public.ai_force_update_jobs(id) on delete set null,
  summary         text not null default '' check (char_length(summary) <= 500),
  idempotency_key text not null check (char_length(idempotency_key) between 10 and 200),
  status          text not null default 'active' check (status in ('active', 'cancelled', 'superseded')),
  created_by      uuid,
  created_at      timestamptz not null default now(),
  cancelled_at    timestamptz,
  cancelled_by    uuid,
  check ((scope = 'provider' and package_id is not null and target_sha256 is not null and model_id is null)
      or (scope = 'model' and model_id is not null and model_snapshot is not null and package_id is null))
);
create unique index if not exists ai_force_job_one_active_per_key on public.ai_force_update_jobs(idempotency_key) where status = 'active';
create index if not exists ai_force_job_provider on public.ai_force_update_jobs(provider_key, status);
create index if not exists ai_force_job_created on public.ai_force_update_jobs(created_at desc);

create table if not exists public.ai_force_update_targets (
  job_id            uuid not null references public.ai_force_update_jobs(id) on delete cascade,
  user_id           uuid not null references auth.users(id) on delete cascade,
  device_id         text not null check (device_id ~ '^[0-9a-f-]{16,64}$'),
  status            text not null default 'pending' check (status in ('pending', 'downloading', 'installing', 'completed', 'failed', 'retrying', 'cancelled')),
  attempts          integer not null default 0 check (attempts between 0 and 1000),
  last_error        text check (last_error is null or char_length(last_error) <= 300),
  installed_version text check (installed_version is null or char_length(installed_version) <= 40),
  first_seen_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  completed_at      timestamptz,
  primary key (job_id, user_id, device_id)
);
create index if not exists ai_force_target_status on public.ai_force_update_targets(job_id, status);
create index if not exists ai_force_target_user on public.ai_force_update_targets(user_id, device_id, status);

alter table public.ai_revoked_signing_keys enable row level security;
alter table public.ai_force_update_jobs enable row level security;
alter table public.ai_force_update_targets enable row level security;
revoke all on table public.ai_revoked_signing_keys, public.ai_force_update_jobs, public.ai_force_update_targets from public, anon, authenticated;

-- ====================================================================== D. catalogue JSON carries version / signature
create or replace function public._ai_catalog_json(p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider', p.provider_key, 'title', p.title, 'enabled', p.enabled, 'hidden', p.hidden, 'vision', p.vision,
    'key_url', p.key_url, 'key_hint', p.key_hint, 'validate', p.validate_kind, 'adapter', p.adapter,
    'sort_order', p.sort_order, 'failover_order', p.failover_order,
    'models', coalesce((select jsonb_agg(jsonb_build_object('id', m.model_id, 'label', m.label, 'enabled', m.enabled, 'sort_order', m.sort_order)
                                         order by m.sort_order, m.model_id) from public.ai_provider_models m where m.provider_key = p.provider_key), '[]'::jsonb),
    'package', (select jsonb_build_object('id', k.id, 'title', k.title, 'sha256', k.sha256, 'size', k.size_bytes, 'published_at', k.published_at,
                                          'version', k.version, 'package_id', k.package_id, 'min_app', k.min_app)
                  from public.ai_provider_packages k where k.provider_key = p.provider_key and k.status = 'published'),
    'packages', case when p_admin then coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'sha256', k.sha256, 'size', k.size_bytes,
                         'status', k.status, 'validation', k.validation, 'test_report', k.test_report, 'storage_path', k.storage_path,
                         'created_at', k.created_at, 'published_at', k.published_at, 'version', k.version, 'package_id', k.package_id,
                         'min_app', k.min_app, 'unpacked_bytes', k.unpacked_bytes, 'signed', k.signature is not null,
                         'signer', k.signature ->> 'key_id') order by k.created_at desc)
                         from public.ai_provider_packages k where k.provider_key = p.provider_key), '[]'::jsonb) else null end
  ) order by p.sort_order, p.provider_key), '[]'::jsonb) from public.ai_providers p
$$;

create or replace function public.get_ai_catalog() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  return jsonb_build_object('providers', public._ai_catalog_json(false),
                            'revoked_signing_keys', coalesce((select jsonb_agg(key_id order by key_id) from public.ai_revoked_signing_keys), '[]'::jsonb));
end $$;

-- ====================================================================== E. package register / sign / publish (signature + version rules)
create or replace function public._ai_signature_problem(p_sig jsonb, p_provider text, p_sha text, p_size integer, p_version text) returns text
language plpgsql immutable as $$
declare m jsonb := p_sig -> 'manifest';
begin
  if p_sig is null or jsonb_typeof(p_sig) <> 'object' then return 'signature_missing'; end if;
  if (p_sig ->> 'alg') is distinct from 'ed25519' or coalesce(p_sig ->> 'key_id', '') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$' or coalesce(p_sig ->> 'sig', '') = '' then
    return 'signature_malformed'; end if;
  if m is null or jsonb_typeof(m) <> 'object' or (m ->> 'type') is distinct from 'mz-provider-package' then return 'signature_manifest_malformed'; end if;
  if (m ->> 'provider') is distinct from p_provider then return 'signature_is_for_another_provider'; end if;
  if (m ->> 'sha256') is distinct from p_sha or (m ->> 'size') is distinct from p_size::text then return 'signature_is_for_another_file'; end if;
  if p_version is null or (m ->> 'version') is distinct from p_version then return 'signature_version_mismatch'; end if;
  return null;
end $$;

drop function if exists public.admin_register_ai_package(text, text, text, text, integer, jsonb);
create or replace function public.admin_register_ai_package(p_provider text, p_title text, p_storage_path text, p_sha256 text, p_size integer, p_validation jsonb,
                                                           p_signature jsonb default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_obj jsonb; v_ver text := nullif(p_validation ->> 'version', ''); v_unp bigint := nullif(p_validation ->> 'unpacked_size', '')::bigint; v_prob text;
begin
  perform public._require_admin();
  if not exists (select 1 from public.ai_providers where provider_key = p_provider) then raise exception 'unknown_provider'; end if;
  if coalesce(p_validation ->> 'ok', 'false') <> 'true' then raise exception 'validation_failed: only a package that passed validation can be registered'; end if;
  if (p_validation ->> 'provider') is distinct from p_provider then raise exception 'package_identity_mismatch'; end if;
  if (p_validation ->> 'sha256') is distinct from p_sha256 then raise exception 'validation_report_is_for_another_file'; end if;
  if p_storage_path is distinct from (p_provider || '/' || p_sha256 || '.mzprovider') then raise exception 'storage_path_must_be_provider_slash_sha256'; end if;
  if p_size is null or p_size <= 0 or p_size > 5242880 then raise exception 'package_too_large: the limit is 5 MB (5242880 bytes)'; end if;
  if v_unp is not null and (v_unp <= 0 or v_unp > 20971520) then raise exception 'package_unpacked_too_large: the limit is 20 MB (20971520 bytes) uncompressed'; end if;
  if p_signature is not null then
    v_prob := public._ai_signature_problem(p_signature, p_provider, p_sha256, p_size, v_ver);
    if v_prob is not null then raise exception '%', v_prob; end if;
    if exists (select 1 from public.ai_revoked_signing_keys where key_id = p_signature ->> 'key_id') then raise exception 'signing_key_revoked'; end if;
  end if;
  if to_regclass('storage.objects') is not null then
    execute 'select to_jsonb(o) from storage.objects o where o.bucket_id = $1 and o.name = $2 limit 1' into v_obj using 'ai-providers', p_storage_path;
    if v_obj is null then raise exception 'package_file_not_in_storage'; end if;
    if coalesce((v_obj -> 'metadata' ->> 'size')::bigint, p_size) <> p_size then raise exception 'storage_size_mismatch'; end if;
  end if;
  insert into public.ai_provider_packages(provider_key, title, storage_path, sha256, size_bytes, status, validation, created_by,
                                          package_id, version, min_app, unpacked_bytes, signature)
    values (p_provider, btrim(p_title), p_storage_path, p_sha256, p_size, 'validated', p_validation, auth.uid(),
            nullif(p_validation ->> 'package_id', ''), v_ver, nullif(p_validation ->> 'min_app', ''), v_unp::integer, p_signature)
    on conflict (provider_key, sha256) do update set title = excluded.title, validation = excluded.validation, package_id = excluded.package_id,
      version = excluded.version, min_app = excluded.min_app, unpacked_bytes = excluded.unpacked_bytes, signature = coalesce(excluded.signature, public.ai_provider_packages.signature)
    returning id into v_id;
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_attach_ai_package_signature(p_id uuid, p_signature jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype; v_prob text;
begin
  perform public._require_admin();
  select * into r from public.ai_provider_packages where id = p_id for update;
  if not found then raise exception 'unknown_package'; end if;
  if r.status in ('retired') then raise exception 'package_retired'; end if;
  v_prob := public._ai_signature_problem(p_signature, r.provider_key, r.sha256, r.size_bytes, r.version);
  if v_prob is not null then raise exception '%', v_prob; end if;
  if exists (select 1 from public.ai_revoked_signing_keys where key_id = p_signature ->> 'key_id') then raise exception 'signing_key_revoked'; end if;
  update public.ai_provider_packages set signature = p_signature where id = p_id;
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_publish_ai_package(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype; cur public.ai_provider_packages%rowtype; v_prob text;
begin
  perform public._require_admin();
  select * into r from public.ai_provider_packages where id = p_id for update;
  if not found then raise exception 'unknown_package'; end if;
  if r.status = 'published' then return public._ai_catalog_json(true); end if;
  if r.status <> 'tested' then raise exception 'package_must_be_tested_before_publishing (status %)', r.status; end if;
  if (r.test_report ->> 'sha256') is distinct from r.sha256 then raise exception 'test_report_is_for_another_file'; end if;
  v_prob := public._ai_signature_problem(r.signature, r.provider_key, r.sha256, r.size_bytes, r.version);
  if v_prob is not null then raise exception 'package_not_signed: % (sign it with scripts/provider_pkg.py check --sign)', v_prob; end if;
  if exists (select 1 from public.ai_revoked_signing_keys where key_id = r.signature ->> 'key_id') then raise exception 'signing_key_revoked'; end if;
  select * into cur from public.ai_provider_packages where provider_key = r.provider_key and status = 'published';
  if found and public._mz_semver_cmp(r.version, cur.version) < 0 then
    raise exception 'version_not_newer: published is %, this is % (apps never install an older package; use a force-update rollback to go back)', cur.version, r.version;
  end if;
  update public.ai_provider_packages set status = 'superseded' where provider_key = r.provider_key and status = 'published';
  update public.ai_provider_packages set status = 'published', published_at = now() where id = p_id;
  update public.ai_providers set adapter = 'package', updated_at = now() where provider_key = r.provider_key and adapter = 'package';
  return public._ai_catalog_json(true);
end $$;

create or replace function public.get_ai_package_download(p_provider text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype; pr public.ai_providers%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into pr from public.ai_providers where provider_key = p_provider;
  if not found then raise exception 'unknown_provider'; end if;
  if not pr.enabled then raise exception 'provider_disabled'; end if;
  select * into r from public.ai_provider_packages where provider_key = p_provider and status = 'published';
  if not found then raise exception 'no_published_package'; end if;
  return jsonb_build_object('package_id', r.id, 'title', r.title, 'storage_path', r.storage_path, 'sha256', r.sha256, 'size', r.size_bytes,
                            'version', r.version, 'signature', r.signature);
end $$;

create or replace function public.admin_revoke_ai_signing_key(p_key text, p_reason text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if coalesce(p_key, '') !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$' then raise exception 'invalid_key_id'; end if;
  insert into public.ai_revoked_signing_keys(key_id, reason, revoked_by) values (p_key, left(coalesce(p_reason, ''), 200), auth.uid()) on conflict (key_id) do nothing;
  update public.ai_provider_packages set status = 'retired' where status in ('published', 'tested', 'validated') and signature ->> 'key_id' = p_key;
  perform public._audit('ai_signing_key_revoked', p_key, jsonb_build_object('reason', left(coalesce(p_reason, ''), 200)));
  return public._ai_catalog_json(true);
end $$;

-- ====================================================================== F. Force Update: admin side
create or replace function public._ai_model_snapshot(p_provider text, p_model text) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object('id', m.model_id, 'label', m.label, 'enabled', m.enabled, 'sort_order', m.sort_order,
                            'revision', (extract(epoch from m.updated_at) * 1000)::bigint)
    from public.ai_provider_models m where m.provider_key = p_provider and m.model_id = p_model
$$;

create or replace function public._ai_force_key(p_scope text, p_provider text, p_model text, p_target text) returns text
language sql immutable as $$ select 'fu:' || p_scope || ':' || p_provider || ':' || coalesce(p_model, '') || ':' || p_target $$;

create or replace function public.admin_preview_ai_force_update(p_scope text, p_provider text, p_model text default null, p_package_id uuid default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare pr public.ai_providers%rowtype; k public.ai_provider_packages%rowtype; snap jsonb; dig text; j public.ai_force_update_jobs%rowtype; warn jsonb := '[]'::jsonb;
        users_total bigint; res jsonb;
begin
  perform public._require_admin();
  select * into pr from public.ai_providers where provider_key = p_provider;
  if not found then raise exception 'unknown_provider'; end if;
  select count(*) into users_total from public.profiles where status = 'active';
  if not pr.enabled then warn := warn || to_jsonb('The provider is switched off: the update installs, but the provider stays off.'::text); end if;
  if p_scope = 'provider' then
    if p_package_id is null then select * into k from public.ai_provider_packages where provider_key = p_provider and status = 'published';
    else select * into k from public.ai_provider_packages where id = p_package_id and provider_key = p_provider; end if;
    if not found then raise exception 'no_published_package'; end if;
    if k.status <> 'published' then raise exception 'package_not_published: only the published package can be force-updated'; end if;
    if k.signature is null or public._ai_signature_problem(k.signature, k.provider_key, k.sha256, k.size_bytes, k.version) is not null then raise exception 'package_not_signed'; end if;
    select * into j from public.ai_force_update_jobs where idempotency_key = public._ai_force_key('provider', p_provider, null, k.sha256) and status = 'active';
    res := jsonb_build_object('scope', 'provider', 'provider', p_provider, 'title', pr.title, 'package_id', k.id, 'package_title', k.title, 'version', k.version,
             'sha256', k.sha256, 'size', k.size_bytes, 'confirm', k.sha256, 'signer', k.signature ->> 'key_id',
             'summary', format('Update %s to "%s" version %s (%s KB, signed by %s). Installs automatically on every online device; API keys are not touched.',
                               pr.title, k.title, coalesce(k.version, '?'), round(k.size_bytes / 1024.0, 1), k.signature ->> 'key_id'));
  elsif p_scope = 'model' then
    snap := public._ai_model_snapshot(p_provider, p_model);
    if snap is null then raise exception 'unknown_model'; end if;
    dig := encode(sha256(convert_to(snap::text, 'utf8')), 'hex');
    select * into j from public.ai_force_update_jobs where idempotency_key = public._ai_force_key('model', p_provider, p_model, dig) and status = 'active';
    res := jsonb_build_object('scope', 'model', 'provider', p_provider, 'title', pr.title, 'model_id', p_model, 'model', snap, 'version', (snap ->> 'revision'),
             'size', 0, 'confirm', dig,
             'summary', format('Update the definition of model %s of %s (label "%s", %s). Only this model changes; no package is reinstalled.',
                               p_model, pr.title, snap ->> 'label', case when (snap ->> 'enabled')::boolean then 'on' else 'off' end));
  else
    raise exception 'invalid_scope';
  end if;
  return res || jsonb_build_object('affected_users', users_total, 'warnings', warn, 'duplicate_job', case when j.id is null then null else j.id end);
end $$;

create or replace function public.admin_push_ai_force_update(p_scope text, p_provider text, p_model text default null, p_package_id uuid default null,
                                                            p_confirm text default null, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare pv jsonb; key text; j public.ai_force_update_jobs%rowtype; k public.ai_provider_packages%rowtype; snap jsonb; dup boolean := false;
begin
  perform public._require_admin();
  perform 1 from public.ai_providers where provider_key = p_provider for update;                      -- serialises pushes for one provider
  pv := public.admin_preview_ai_force_update(p_scope, p_provider, p_model, p_package_id);
  if p_confirm is distinct from (pv ->> 'confirm') then raise exception 'confirmation_required: confirm the target shown in the preview'; end if;
  if p_scope = 'provider' then
    select * into k from public.ai_provider_packages where id = (pv ->> 'package_id')::uuid;
    key := public._ai_force_key('provider', p_provider, null, k.sha256);
  else
    snap := pv -> 'model';
    key := public._ai_force_key('model', p_provider, p_model, p_confirm);
  end if;
  select * into j from public.ai_force_update_jobs where idempotency_key = key and status = 'active';
  if found then dup := true;
  else
    update public.ai_force_update_jobs set status = 'superseded' where provider_key = p_provider and scope = p_scope and coalesce(model_id, '') = coalesce(p_model, '') and status = 'active';
    insert into public.ai_force_update_jobs(kind, scope, provider_key, model_id, package_id, target_sha256, target_version, target_size, model_snapshot, summary, idempotency_key, created_by)
      values ('update', p_scope, p_provider, case when p_scope = 'model' then p_model end, case when p_scope = 'provider' then k.id end, case when p_scope = 'provider' then k.sha256 end,
              pv ->> 'version', case when p_scope = 'provider' then k.size_bytes end, case when p_scope = 'model' then snap end,
              left(btrim(coalesce(nullif(p_note, ''), pv ->> 'summary')), 500), key, auth.uid())
      returning * into j;
    perform public._audit('ai_force_update_push', p_provider, jsonb_build_object('job', j.id, 'scope', p_scope, 'model', p_model, 'version', j.target_version));
  end if;
  perform public.admin_purge_ai_force_updates(180);                                                    -- bounded history
  return jsonb_build_object('job_id', j.id, 'duplicate', dup, 'status', j.status, 'jobs', public.admin_list_ai_force_updates(30));
end $$;

create or replace function public.admin_cancel_ai_force_update(p_job uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.ai_force_update_jobs%rowtype;
begin
  perform public._require_admin();
  select * into j from public.ai_force_update_jobs where id = p_job for update;
  if not found then raise exception 'unknown_job'; end if;
  if j.status <> 'active' then raise exception 'job_not_active (status %)', j.status; end if;
  update public.ai_force_update_jobs set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid() where id = p_job;
  update public.ai_force_update_targets set status = 'cancelled', updated_at = now() where job_id = p_job and status not in ('completed', 'cancelled');   -- installed ones stay installed
  perform public._audit('ai_force_update_cancel', j.provider_key, jsonb_build_object('job', p_job));
  return public.admin_list_ai_force_updates(30);
end $$;

create or replace function public.admin_rollback_ai_force_update(p_job uuid, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare j public.ai_force_update_jobs%rowtype; r public.ai_force_update_jobs%rowtype; done bigint;
begin
  perform public._require_admin();
  select * into j from public.ai_force_update_jobs where id = p_job;
  if not found then raise exception 'unknown_job'; end if;
  if j.kind <> 'update' or j.scope <> 'provider' then raise exception 'only_a_provider_package_update_can_be_rolled_back'; end if;
  select count(*) into done from public.ai_force_update_targets where job_id = p_job and status = 'completed';
  if done = 0 then raise exception 'nothing_to_roll_back: no device has completed this update (cancel it instead)'; end if;
  if j.status = 'active' then
    update public.ai_force_update_jobs set status = 'cancelled', cancelled_at = now(), cancelled_by = auth.uid() where id = p_job;       -- stop installing it anywhere else
    update public.ai_force_update_targets set status = 'cancelled', updated_at = now() where job_id = p_job and status not in ('completed', 'cancelled');
  end if;
  select * into r from public.ai_force_update_jobs where idempotency_key = 'fu:rollback:' || p_job::text and status = 'active';
  if not found then
    insert into public.ai_force_update_jobs(kind, scope, provider_key, package_id, target_sha256, target_version, target_size, rollback_of, summary, idempotency_key, created_by)
      values ('rollback', 'provider', j.provider_key, j.package_id, j.target_sha256, j.target_version, j.target_size, p_job,
              left(btrim(coalesce(nullif(p_note, ''), format('Go back from version %s to the previous copy on devices that installed it.', coalesce(j.target_version, '?')))), 500),
              'fu:rollback:' || p_job::text, auth.uid()) returning * into r;
    perform public._audit('ai_force_update_rollback', j.provider_key, jsonb_build_object('job', p_job, 'rollback_job', r.id));
  end if;
  return jsonb_build_object('job_id', r.id, 'jobs', public.admin_list_ai_force_updates(30));
end $$;

create or replace function public.admin_list_ai_force_updates(p_limit integer default 30) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare users_total bigint;
begin
  perform public._require_admin();
  select count(*) into users_total from public.profiles where status = 'active';
  return coalesce((select jsonb_agg(row order by (row ->> 'created_at') desc) from (
    select jsonb_build_object('id', j.id, 'kind', j.kind, 'scope', j.scope, 'provider', j.provider_key, 'model_id', j.model_id, 'version', j.target_version,
             'sha256', j.target_sha256, 'size', j.target_size, 'summary', j.summary, 'status', j.status, 'rollback_of', j.rollback_of, 'created_at', j.created_at,
             'cancelled_at', j.cancelled_at,
             'counts', jsonb_build_object(
                'queued', greatest(users_total - (select count(distinct t.user_id) from public.ai_force_update_targets t where t.job_id = j.id), 0),
                'pending', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'pending'),
                'downloading', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'downloading'),
                'installing', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'installing'),
                'completed', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'completed'),
                'failed', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'failed'),
                'retrying', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'retrying'),
                'cancelled', (select count(*) from public.ai_force_update_targets t where t.job_id = j.id and t.status = 'cancelled')),
             'last_error', (select t.last_error from public.ai_force_update_targets t where t.job_id = j.id and t.last_error is not null order by t.updated_at desc limit 1)) as row
      from public.ai_force_update_jobs j order by j.created_at desc limit greatest(least(coalesce(p_limit, 30), 200), 1)) x), '[]'::jsonb);
end $$;

create or replace function public.admin_list_ai_force_update_targets(p_job uuid, p_status text default null, p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('user', p.email, 'device', left(t.device_id, 8), 'status', t.status, 'attempts', t.attempts, 'version', t.installed_version,
                   'error', t.last_error, 'first_seen_at', t.first_seen_at, 'updated_at', t.updated_at, 'completed_at', t.completed_at) order by t.updated_at desc)
                   from (select * from public.ai_force_update_targets where job_id = p_job and (p_status is null or status = p_status)
                          order by updated_at desc limit greatest(least(coalesce(p_limit, 100), 500), 1)) t
                   left join public.profiles p on p.id = t.user_id), '[]'::jsonb);
end $$;

create or replace function public.admin_purge_ai_force_updates(p_older_than_days integer default 90) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare n integer;
begin
  perform public._require_admin();
  delete from public.ai_force_update_jobs where status <> 'active' and created_at < now() - make_interval(days => greatest(coalesce(p_older_than_days, 90), 1));
  get diagnostics n = row_count;
  return n;
end $$;

-- ====================================================================== G. Force Update: what the APP asks (always about auth.uid() itself)
create or replace function public.get_ai_pending_updates(p_device text) returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); out jsonb;
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if coalesce(p_device, '') !~ '^[0-9a-f-]{16,64}$' then raise exception 'invalid_device'; end if;
  insert into public.ai_force_update_targets(job_id, user_id, device_id, status)
    select j.id, uid, p_device, 'pending' from public.ai_force_update_jobs j
     where j.status = 'active'
       and not exists (select 1 from public.ai_force_update_targets t where t.job_id = j.id and t.user_id = uid and t.device_id = p_device)
       and (select count(*) from public.ai_force_update_targets t2 where t2.job_id = j.id and t2.user_id = uid) < 20       -- at most 20 devices per user per job
    on conflict do nothing;
  select coalesce(jsonb_agg(jsonb_build_object('job_id', j.id, 'kind', j.kind, 'scope', j.scope, 'provider', j.provider_key, 'model_id', j.model_id,
           'summary', j.summary, 'created_at', j.created_at,
           'target', case when j.scope = 'provider' then jsonb_build_object('sha256', j.target_sha256, 'version', j.target_version, 'size', j.target_size,
                                                                         'package_id', (select k.package_id from public.ai_provider_packages k where k.id = j.package_id)) end,
           'model', j.model_snapshot) order by j.created_at), '[]'::jsonb)
    into out
    from public.ai_force_update_jobs j join public.ai_force_update_targets t on t.job_id = j.id and t.user_id = uid and t.device_id = p_device
   where j.status = 'active' and t.status not in ('completed', 'cancelled');
  return jsonb_build_object('jobs', out);
end $$;

create or replace function public.get_ai_force_update_package(p_job uuid) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare j public.ai_force_update_jobs%rowtype; k public.ai_provider_packages%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into j from public.ai_force_update_jobs where id = p_job and status = 'active' and scope = 'provider' and kind = 'update';
  if not found then raise exception 'job_not_active'; end if;
  select * into k from public.ai_provider_packages where id = j.package_id;
  if not found or k.status = 'retired' then raise exception 'package_not_available'; end if;
  return jsonb_build_object('package_id', k.id, 'storage_path', k.storage_path, 'sha256', k.sha256, 'size', k.size_bytes, 'version', k.version, 'signature', k.signature);
end $$;

create or replace function public.ack_ai_force_update(p_job uuid, p_device text, p_status text, p_version text default null, p_error text default null, p_attempt integer default 0)
returns jsonb
language plpgsql volatile security definer set search_path = public, pg_temp as $$
declare uid uuid := auth.uid(); j public.ai_force_update_jobs%rowtype; t public.ai_force_update_targets%rowtype;
begin
  if uid is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  if coalesce(p_device, '') !~ '^[0-9a-f-]{16,64}$' then raise exception 'invalid_device'; end if;
  if p_status not in ('pending', 'downloading', 'installing', 'completed', 'failed', 'retrying') then raise exception 'invalid_status'; end if;
  select * into j from public.ai_force_update_jobs where id = p_job;
  if not found then raise exception 'unknown_job'; end if;
  select * into t from public.ai_force_update_targets where job_id = p_job and user_id = uid and device_id = p_device for update;
  if not found then
    if (select count(*) from public.ai_force_update_targets x where x.job_id = p_job and x.user_id = uid) >= 20 then raise exception 'too_many_devices'; end if;
    insert into public.ai_force_update_targets(job_id, user_id, device_id, status) values (p_job, uid, p_device, 'pending') returning * into t;
  end if;
  if t.status in ('completed', 'cancelled') then
    return jsonb_build_object('ok', true, 'status', t.status, 'job_status', j.status);                  -- terminal: a late / repeated message changes nothing (idempotent)
  end if;
  if j.status <> 'active' then
    update public.ai_force_update_targets set status = 'cancelled', updated_at = now() where job_id = p_job and user_id = uid and device_id = p_device;
    return jsonb_build_object('ok', true, 'status', 'cancelled', 'job_status', j.status);
  end if;
  update public.ai_force_update_targets
     set status = p_status, attempts = greatest(attempts, least(greatest(coalesce(p_attempt, 0), 0), 1000)),
         last_error = case when p_status in ('failed', 'retrying') then left(coalesce(p_error, ''), 300) when p_status = 'completed' then null else last_error end,
         installed_version = case when p_status = 'completed' then left(p_version, 40) else installed_version end,
         updated_at = now(), completed_at = case when p_status = 'completed' then now() else completed_at end
   where job_id = p_job and user_id = uid and device_id = p_device;
  return jsonb_build_object('ok', true, 'status', p_status, 'job_status', j.status);
end $$;

-- ====================================================================== H. Storage: a force-update target may be read while its job is active
create or replace function public.mz_ai_pkg_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_name is not null and (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    or exists (select 1 from public.ai_provider_packages k join public.ai_providers p on p.provider_key = k.provider_key
               where k.storage_path = p_name and k.status = 'published' and p.enabled)
    or exists (select 1 from public.ai_force_update_jobs j join public.ai_provider_packages k on k.id = j.package_id
               where k.storage_path = p_name and j.status = 'active' and j.scope = 'provider' and j.kind = 'update' and k.status <> 'retired'))
$$;

-- ====================================================================== I. privileges: closed by default, then exactly the functions below
revoke all on function public._mz_semver_cmp(text, text), public._ai_signature_problem(jsonb, text, text, integer, text), public._ai_model_snapshot(text, text),
  public._ai_force_key(text, text, text, text) from public, anon, authenticated;
revoke all on function public.admin_register_ai_package(text, text, text, text, integer, jsonb, jsonb), public.admin_attach_ai_package_signature(uuid, jsonb),
  public.admin_publish_ai_package(uuid), public.admin_revoke_ai_signing_key(text, text), public.admin_preview_ai_force_update(text, text, text, uuid),
  public.admin_push_ai_force_update(text, text, text, uuid, text, text), public.admin_cancel_ai_force_update(uuid), public.admin_rollback_ai_force_update(uuid, text),
  public.admin_list_ai_force_updates(integer), public.admin_list_ai_force_update_targets(uuid, text, integer), public.admin_purge_ai_force_updates(integer),
  public.get_ai_pending_updates(text), public.get_ai_force_update_package(uuid), public.ack_ai_force_update(uuid, text, text, text, text, integer),
  public.get_ai_catalog(), public.get_ai_package_download(text), public.mz_ai_pkg_allowed(text), public._ai_catalog_json(boolean) from public, anon, authenticated;
grant execute on function public.admin_register_ai_package(text, text, text, text, integer, jsonb, jsonb), public.admin_attach_ai_package_signature(uuid, jsonb),
  public.admin_publish_ai_package(uuid), public.admin_revoke_ai_signing_key(text, text), public.admin_preview_ai_force_update(text, text, text, uuid),
  public.admin_push_ai_force_update(text, text, text, uuid, text, text), public.admin_cancel_ai_force_update(uuid), public.admin_rollback_ai_force_update(uuid, text),
  public.admin_list_ai_force_updates(integer), public.admin_list_ai_force_update_targets(uuid, text, integer), public.admin_purge_ai_force_updates(integer),
  public.get_ai_pending_updates(text), public.get_ai_force_update_package(uuid), public.ack_ai_force_update(uuid, text, text, text, text, integer),
  public.get_ai_catalog(), public.get_ai_package_download(text), public.mz_ai_pkg_allowed(text) to authenticated;

commit;
