-- 0026 (app version stays v1.0.0): "Removed Providers & Models" - archive (soft delete) with permanent restore, for Admin Panel -> API Configuration.
-- FORWARD-ONLY, idempotent, one transaction. Run AFTER 0001..0025. NOT APPLIED to any database yet (prepared for review; apply it yourself in the
-- Supabase SQL Editor, first on a TEST project). It does not change any earlier migration file; functions it replaces are re-created with CREATE OR REPLACE.
--
-- WHY
--   admin_delete_ai_provider() / admin_delete_ai_model() (0021) permanently DELETE the row and CASCADE to models and ai_access switches.
--   From 0026 on nothing in the Admin workflow deletes a provider or a model: "Remove" ARCHIVES the row IN PLACE and "Restore" un-archives it.
--
-- DESIGN (in place, no copy table)
--   ai_providers        + archived_at timestamptz, archived_by uuid
--   ai_provider_models  + archived_at timestamptz, archived_by uuid, archived_with_provider boolean (true = archived because its provider was removed)
--   Because the row stays where it is, its primary key, foreign keys (models, packages, force-update jobs), enabled flag, hidden flag, ordering, adapter,
--   labels and package references are all kept as they were - nothing is copied, so nothing can drift. "Original status" = the unchanged `enabled` column.
--   A key collision on restore is structurally impossible (the archived row still owns its key). The real collision is creating a NEW provider / model
--   with an archived key: admin_upsert_ai_provider / admin_upsert_ai_model now REFUSE it with 'provider_is_archived' / 'model_is_archived' (never an
--   overwrite), so the Admin must choose: restore the old one.
--
-- WHAT IT ADDS / REPLACES
--   new     admin_archive_ai_provider(p_key)            archive a provider AND its not-yet-archived models (marked archived_with_provider)
--           admin_restore_ai_provider(p_key)            un-archive the provider and the models archived WITH it; models removed on their own stay removed
--           admin_archive_ai_model(p_provider, p_model) archive one model; the provider is untouched
--           admin_restore_ai_model(p_provider, p_model) un-archive one model; the provider's status is untouched; refused while the provider is removed
--           admin_list_removed_ai_catalog()             Admin-only list for the Removed Providers & Models page
--           _ai_removed_json()                          helper (closed to every client role)
--   replaced (same signatures, same grants)
--           admin_delete_ai_provider(text), admin_delete_ai_model(text, text)   now ONLY archive (kept so an older Admin page can never hard-delete)
--           _ai_catalog_json(boolean)       hides archived providers / models  -> admin_list_ai_catalog() and get_ai_catalog() (the app) stop offering them
--           get_ai_package_download(text)   an archived provider has no download (its packages are KEPT, nothing is retired or deleted)
--           mz_ai_pkg_allowed(text)         Storage read for a published package also requires the provider not to be archived
--           admin_push_ai_force_update(...) refuses an archived provider / model
--           admin_upsert_ai_provider / admin_upsert_ai_model / admin_set_ai_provider_enabled / admin_set_ai_model_enabled   refuse an archived row
--           admin_restore_default_ai_catalog() (0025)   never un-archives anything and never adds a default model under an archived provider
-- RULES
--   * Every new / replaced admin function starts with public._require_admin(); non-admins get 'forbidden'. No table is opened to clients (RLS unchanged).
--   * Repeat-safe: archiving an archived row, or restoring an active row, changes nothing and answers {already_archived|already_active: true}.
--   * Archiving is refused while a force update (0022) is active for that provider / model (cancel it first) - nothing is cancelled silently.
--   * ai_access (0008) is kept in step: an archived provider / model is mirrored as OFF for older apps; restoring mirrors the stored `enabled` value back.
--   * Restoring changes no setting: enabled, hidden, ordering, labels, packages and updated_at are exactly what they were. No user data / API key is involved.
--   * One audit row (public._audit) per archive / restore that really changed something.
begin;

do $$ begin
  if to_regclass('public.ai_providers') is null or to_regclass('public.ai_provider_models') is null or to_regclass('public.ai_provider_packages') is null or to_regclass('public.ai_access') is null then
    raise exception '0026 stopped: migration 0021 (ai_provider_catalog) has not been applied. Nothing was changed.' using errcode = '55000';
  end if;
  if to_regclass('public.ai_force_update_jobs') is null or to_regprocedure('public.admin_push_ai_force_update(text,text,text,uuid,text,text)') is null then
    raise exception '0026 stopped: migration 0022 (ai_provider_force_update) has not been applied. Nothing was changed.' using errcode = '55000';
  end if;
  if to_regprocedure('public.admin_restore_default_ai_catalog()') is null then
    raise exception '0026 stopped: migration 0025 (restore_default_ai_providers) has not been applied. Nothing was changed. Run 0025 first.' using errcode = '55000';
  end if;
  if to_regprocedure('public._require_admin()') is null or to_regprocedure('public._audit(text,text,jsonb)') is null or to_regprocedure('public._ai_mirror_access(text,text,boolean)') is null then
    raise exception '0026 stopped: _require_admin / _audit / _ai_mirror_access are missing. Nothing was changed.' using errcode = '55000';
  end if;
end $$;

-- ------------------------------------------------------------------ archive columns (additive; existing rows stay active)
alter table public.ai_providers       add column if not exists archived_at timestamptz;
alter table public.ai_providers       add column if not exists archived_by uuid;
alter table public.ai_provider_models add column if not exists archived_at timestamptz;
alter table public.ai_provider_models add column if not exists archived_by uuid;
alter table public.ai_provider_models add column if not exists archived_with_provider boolean not null default false;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'ai_model_archive_flag_needs_archive' and conrelid = 'public.ai_provider_models'::regclass) then
    alter table public.ai_provider_models add constraint ai_model_archive_flag_needs_archive check (archived_at is not null or not archived_with_provider);
  end if;
end $$;
create index if not exists ai_providers_archived_idx on public.ai_providers(archived_at) where archived_at is not null;
create index if not exists ai_provider_models_archived_idx on public.ai_provider_models(provider_key, archived_at) where archived_at is not null;

-- ------------------------------------------------------------------ hide archived rows from everything that serves the catalogue
create or replace function public._ai_catalog_json(p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider', p.provider_key, 'title', p.title, 'enabled', p.enabled, 'hidden', p.hidden, 'vision', p.vision,
    'key_url', p.key_url, 'key_hint', p.key_hint, 'validate', p.validate_kind, 'adapter', p.adapter,
    'sort_order', p.sort_order, 'failover_order', p.failover_order,
    'models', coalesce((select jsonb_agg(jsonb_build_object('id', m.model_id, 'label', m.label, 'enabled', m.enabled, 'sort_order', m.sort_order)
                                         order by m.sort_order, m.model_id) from public.ai_provider_models m where m.provider_key = p.provider_key and m.archived_at is null), '[]'::jsonb),
    'package', (select jsonb_build_object('id', k.id, 'title', k.title, 'sha256', k.sha256, 'size', k.size_bytes, 'published_at', k.published_at,
                                          'version', k.version, 'package_id', k.package_id, 'min_app', k.min_app)
                  from public.ai_provider_packages k where k.provider_key = p.provider_key and k.status = 'published'),
    'packages', case when p_admin then coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'sha256', k.sha256, 'size', k.size_bytes,
                         'status', k.status, 'validation', k.validation, 'test_report', k.test_report, 'storage_path', k.storage_path,
                         'created_at', k.created_at, 'published_at', k.published_at, 'version', k.version, 'package_id', k.package_id,
                         'min_app', k.min_app, 'unpacked_bytes', k.unpacked_bytes, 'signed', k.signature is not null,
                         'signer', k.signature ->> 'key_id') order by k.created_at desc)
                         from public.ai_provider_packages k where k.provider_key = p.provider_key), '[]'::jsonb) else null end
  ) order by p.sort_order, p.provider_key), '[]'::jsonb) from public.ai_providers p where p.archived_at is null
$$;

create or replace function public.get_ai_package_download(p_provider text) returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype; pr public.ai_providers%rowtype;
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  select * into pr from public.ai_providers where provider_key = p_provider;
  if not found then raise exception 'unknown_provider'; end if;
  if pr.archived_at is not null then raise exception 'unknown_provider'; end if;                      -- a removed provider is not offered, its package is kept
  if not pr.enabled then raise exception 'provider_disabled'; end if;
  select * into r from public.ai_provider_packages where provider_key = p_provider and status = 'published';
  if not found then raise exception 'no_published_package'; end if;
  return jsonb_build_object('package_id', r.id, 'title', r.title, 'storage_path', r.storage_path, 'sha256', r.sha256, 'size', r.size_bytes,
                            'version', r.version, 'signature', r.signature);
end $$;

create or replace function public.mz_ai_pkg_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_name is not null and (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    or exists (select 1 from public.ai_provider_packages k join public.ai_providers p on p.provider_key = k.provider_key
               where k.storage_path = p_name and k.status = 'published' and p.enabled and p.archived_at is null)
    or exists (select 1 from public.ai_force_update_jobs j join public.ai_provider_packages k on k.id = j.package_id
               where k.storage_path = p_name and j.status = 'active' and j.scope = 'provider' and j.kind = 'update' and k.status <> 'retired'))
$$;

-- ------------------------------------------------------------------ refuse to touch an archived row (no silent overwrite)
create or replace function public.admin_upsert_ai_provider(
  p_key text, p_title text, p_enabled boolean default true, p_hidden boolean default false, p_vision boolean default true,
  p_key_url text default '', p_key_hint text default '', p_validate_kind text default '', p_adapter text default 'package',
  p_sort integer default 100, p_failover integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare k text := btrim(coalesce(p_key, '')); t text := btrim(coalesce(p_title, ''));
begin
  perform public._require_admin();
  if k !~ '^[A-Za-z][A-Za-z0-9_.-]{0,39}$' then raise exception 'invalid_provider_key'; end if;
  if char_length(t) not between 1 and 80 then raise exception 'invalid_title'; end if;
  if lower(k) like '%apify%' then raise exception 'apify_is_not_a_meta_generator_provider'; end if;
  if coalesce(p_adapter, 'package') not in ('builtin', 'package') then raise exception 'invalid_adapter'; end if;
  if exists (select 1 from public.ai_providers where provider_key = k and archived_at is not null) then
    raise exception 'provider_is_archived: % was removed earlier - restore it from Removed Providers & Models instead of adding it again', k;
  end if;
  insert into public.ai_providers(provider_key, title, enabled, hidden, vision, key_url, key_hint, validate_kind, adapter, sort_order, failover_order)
    values (k, t, coalesce(p_enabled, true), coalesce(p_hidden, false), coalesce(p_vision, true), left(coalesce(p_key_url, ''), 300),
            left(coalesce(p_key_hint, ''), 200), left(coalesce(p_validate_kind, ''), 40), coalesce(p_adapter, 'package'),
            coalesce(p_sort, 100), coalesce(p_failover, 100))
    on conflict (provider_key) do update set title = excluded.title, enabled = excluded.enabled, hidden = excluded.hidden, vision = excluded.vision,
      key_url = excluded.key_url, key_hint = excluded.key_hint, validate_kind = excluded.validate_kind, adapter = excluded.adapter,
      sort_order = excluded.sort_order, failover_order = excluded.failover_order, updated_at = now();
  perform public._ai_mirror_access(k, '', coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_upsert_ai_model(p_provider text, p_model text, p_label text, p_enabled boolean default true, p_sort integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m text := btrim(coalesce(p_model, '')); l text := btrim(coalesce(p_label, ''));
begin
  perform public._require_admin();
  if not exists (select 1 from public.ai_providers where provider_key = p_provider) then raise exception 'unknown_provider'; end if;
  if exists (select 1 from public.ai_providers where provider_key = p_provider and archived_at is not null) then raise exception 'provider_is_archived: restore the provider first'; end if;
  if char_length(m) not between 1 and 120 or char_length(l) not between 1 and 80 then raise exception 'invalid_model'; end if;
  if exists (select 1 from public.ai_provider_models where provider_key = p_provider and model_id = m and archived_at is not null) then
    raise exception 'model_is_archived: % was removed earlier - restore it from Removed Providers & Models instead of adding it again', m;
  end if;
  insert into public.ai_provider_models(provider_key, model_id, label, enabled, sort_order) values (p_provider, m, l, coalesce(p_enabled, true), coalesce(p_sort, 100))
    on conflict (provider_key, model_id) do update set label = excluded.label, enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = now();
  perform public._ai_mirror_access(p_provider, m, coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_set_ai_provider_enabled(p_key text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if exists (select 1 from public.ai_providers where provider_key = p_key and archived_at is not null) then raise exception 'provider_is_archived: restore it first'; end if;
  update public.ai_providers set enabled = coalesce(p_enabled, true), updated_at = now() where provider_key = p_key;
  if not found then raise exception 'unknown_provider'; end if;
  perform public._ai_mirror_access(p_key, '', coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_set_ai_model_enabled(p_provider text, p_model text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if exists (select 1 from public.ai_provider_models where provider_key = p_provider and model_id = p_model and archived_at is not null) then raise exception 'model_is_archived: restore it first'; end if;
  update public.ai_provider_models set enabled = coalesce(p_enabled, true), updated_at = now() where provider_key = p_provider and model_id = p_model;
  if not found then raise exception 'unknown_model'; end if;
  perform public._ai_mirror_access(p_provider, p_model, coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_push_ai_force_update(p_scope text, p_provider text, p_model text default null, p_package_id uuid default null,
                                                            p_confirm text default null, p_note text default '') returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare pv jsonb; key text; j public.ai_force_update_jobs%rowtype; k public.ai_provider_packages%rowtype; snap jsonb; dup boolean := false;
begin
  perform public._require_admin();
  if exists (select 1 from public.ai_providers where provider_key = p_provider and archived_at is not null) then raise exception 'provider_is_archived: restore it from Removed Providers & Models first'; end if;
  if p_scope = 'model' and exists (select 1 from public.ai_provider_models where provider_key = p_provider and model_id = p_model and archived_at is not null) then raise exception 'model_is_archived: restore it from Removed Providers & Models first'; end if;
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

-- ------------------------------------------------------------------ 0025 default restore: never un-archives, never adds under a removed provider
create or replace function public.admin_restore_default_ai_catalog() returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_new_providers jsonb := '[]'::jsonb;
  v_new_models    jsonb := '[]'::jsonb;
  v_np integer := 0;
  v_nm integer := 0;
  r record;
begin
  perform public._require_admin();
  perform pg_advisory_xact_lock(hashtext('metazone.restore_default_ai_catalog'));

  -- ---- providers: the 8 rows 0021 seeded (= providers/seed.py: SEED_PROVIDERS / SEED_ORDERED / SEED_HIDDEN). Missing ones only.
  with default_providers(provider_key, title, hidden, vision, key_url, key_hint, validate_kind, sort_order, failover_order) as (values
    ('OpenRouter', 'OpenRouter', false, true,  'https://openrouter.ai/keys',                    'Get free key → openrouter.ai',                                              'openrouter', 80, 10),
    ('Gemini',     'Gemini',     false, true,  'https://aistudio.google.com/app/apikey',          'Get free key → aistudio.google.com',                                        'gemini',     10, 20),
    ('Mistral',    'Mistral',    false, true,  'https://console.mistral.ai/api-keys/',            'Get key → console.mistral.ai',                                              'mistral',    20, 30),
    ('Groq',       'Groq',       false, true,  'https://console.groq.com/keys',                   'Get free key → console.groq.com',                                           'groq',       30, 40),
    ('Cerebras',   'Cerebras',   false, false, 'https://cloud.cerebras.ai/',                      'Get free key → cloud.cerebras.ai',                                          'cerebras',   40, 50),
    ('OpenAI',     'OpenAI',     false, true,  'https://platform.openai.com/api-keys',            'Get key → platform.openai.com',                                             'openai',     50, 60),
    ('Claude',     'Claude',     true,  true,  'https://console.anthropic.com/settings/keys',     'Get key → console.anthropic.com',                                           'claude',     60, 70),
    ('Grok',       'Grok',       true,  true,  'https://console.x.ai',                            'Get key → console.x.ai (this is xAI''s Grok — different from Groq above)', 'grok',       70, 80)),
  ins as (
    insert into public.ai_providers (provider_key, title, enabled, hidden, vision, key_url, key_hint, validate_kind, sort_order, failover_order)
    select d.provider_key, d.title,
           not exists (select 1 from public.ai_access a where a.provider = d.provider_key and a.model = '' and not a.enabled),
           d.hidden, d.vision, d.key_url, d.key_hint, d.validate_kind, d.sort_order, d.failover_order
      from default_providers d
    on conflict (provider_key) do nothing
    returning provider_key, enabled)
  select coalesce(jsonb_agg(jsonb_build_object('provider', i.provider_key, 'enabled', i.enabled) order by i.provider_key), '[]'::jsonb), count(*)
    into v_new_providers, v_np
    from ins i;

  for r in select e ->> 'provider' as provider_key, (e ->> 'enabled')::boolean as enabled from jsonb_array_elements(v_new_providers) e loop
    perform public._ai_mirror_access(r.provider_key, '', r.enabled);
  end loop;

  -- ---- models: the 24 rows 0021 seeded. Missing ones only, and only under a provider that exists (restored just now, or already there).
  with default_models(provider_key, model_id, label, sort_order) as (values
    ('OpenRouter', 'thinkingmachines/inkling-small:free',                  'Inkling Small (Vision)',   10),
    ('OpenRouter', 'inclusionai/ling-3.0-flash-vl:free',                   'Ling 3.0 Flash VL',        20),
    ('OpenRouter', 'thinkingmachines/inkling:free',                        'Inkling (Vision)',         30),
    ('OpenRouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free',   'Nemotron 3 Nano Omni',     40),
    ('Gemini',     'gemini-3.6-flash',                                     'Gemini 3.6 Flash',         10),
    ('Gemini',     'gemini-3.5-flash',                                     'Gemini 3.5 Flash',         20),
    ('Gemini',     'gemini-3.5-flash-lite',                                'Gemini 3.5 Flash-Lite',    30),
    ('Gemini',     'gemini-3.1-flash-lite',                                'Gemini 3.1 Flash-Lite',    40),
    ('Gemini',     'gemini-3-flash-preview',                               'Gemini 3 Flash (Preview)', 50),
    ('Gemini',     'gemini-2.5-flash',                                     'Gemini 2.5 Flash',         60),
    ('Gemini',     'gemini-1.5-flash',                                     'Gemini 1.5 Flash',         70),
    ('Gemini',     'gemini-1.5-pro',                                       'Gemini 1.5 Pro',           80),
    ('Mistral',    'pixtral-12b-2409',                                     'Pixtral 12B',              10),
    ('Mistral',    'pixtral-large-2411',                                   'Pixtral Large',            20),
    ('Groq',       'qwen/qwen3.6-27b',                                     'Qwen 3.6 27B (Vision)',    10),
    ('Cerebras',   'llama-3.3-70b',                                        'Llama 3.3 70B',            10),
    ('Cerebras',   'llama3.1-8b',                                          'Llama 3.1 8B',             20),
    ('OpenAI',     'gpt-4o',                                               'GPT-4o',                   10),
    ('OpenAI',     'gpt-4o-mini',                                          'GPT-4o Mini',              20),
    ('OpenAI',     'gpt-4.1-nano',                                         'GPT-4.1 Nano',             30),
    ('Claude',     'claude-haiku-4-5-20251001',                            'Claude Haiku 4.5',         10),
    ('Claude',     'claude-sonnet-5',                                      'Claude Sonnet 5',          20),
    ('Grok',       'grok-4',                                               'Grok 4',                   10),
    ('Grok',       'grok-4-fast',                                          'Grok 4 Fast',              20)),
  ins as (
    insert into public.ai_provider_models (provider_key, model_id, label, enabled, sort_order)
    select d.provider_key, d.model_id, d.label,
           not exists (select 1 from public.ai_access a where a.provider = d.provider_key and a.model = d.model_id and not a.enabled),
           d.sort_order
      from default_models d
     where exists (select 1 from public.ai_providers p where p.provider_key = d.provider_key and p.archived_at is null)      -- 0026: never add under a removed provider
    on conflict (provider_key, model_id) do nothing
    returning provider_key, model_id, enabled)
  select coalesce(jsonb_agg(jsonb_build_object('provider', i.provider_key, 'model', i.model_id, 'enabled', i.enabled) order by i.provider_key, i.model_id), '[]'::jsonb), count(*)
    into v_new_models, v_nm
    from ins i;

  for r in select e ->> 'provider' as provider_key, e ->> 'model' as model_id, (e ->> 'enabled')::boolean as enabled from jsonb_array_elements(v_new_models) e loop
    perform public._ai_mirror_access(r.provider_key, r.model_id, r.enabled);
  end loop;

  if v_np + v_nm > 0 then
    perform public._audit('restore_default_ai_catalog', 'ai_catalog', jsonb_build_object(
      'providers_restored', v_np, 'models_restored', v_nm,
      'providers', (select coalesce(jsonb_agg(e ->> 'provider' order by e ->> 'provider'), '[]'::jsonb) from jsonb_array_elements(v_new_providers) e)));
  end if;

  return jsonb_build_object(
    'restored_providers', v_np,
    'restored_models', v_nm,
    'providers', (select coalesce(jsonb_agg(e ->> 'provider' order by e ->> 'provider'), '[]'::jsonb) from jsonb_array_elements(v_new_providers) e),
    'models', (select coalesce(jsonb_agg(jsonb_build_object('provider', e ->> 'provider', 'model', e ->> 'model') order by e ->> 'provider', e ->> 'model'), '[]'::jsonb)
                 from jsonb_array_elements(v_new_models) e),
    'catalog', public._ai_catalog_json(true));
end $$;

-- ------------------------------------------------------------------ the Removed list (Admin only)
create or replace function public._ai_removed_json() returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'providers', coalesce((select jsonb_agg(jsonb_build_object(
        'provider', p.provider_key, 'title', p.title, 'enabled', p.enabled, 'hidden', p.hidden, 'adapter', p.adapter, 'archived_at', p.archived_at,
        'models', coalesce((select jsonb_agg(jsonb_build_object('id', m.model_id, 'label', m.label, 'enabled', m.enabled,
                                                               'archived_with_provider', m.archived_with_provider, 'archived_at', m.archived_at)
                                             order by m.sort_order, m.model_id) from public.ai_provider_models m where m.provider_key = p.provider_key), '[]'::jsonb),
        'package_count', (select count(*) from public.ai_provider_packages k where k.provider_key = p.provider_key),
        'has_published_package', exists (select 1 from public.ai_provider_packages k where k.provider_key = p.provider_key and k.status = 'published')
      ) order by p.archived_at desc, p.provider_key) from public.ai_providers p where p.archived_at is not null), '[]'::jsonb),
    'models', coalesce((select jsonb_agg(jsonb_build_object(
        'provider', m.provider_key, 'provider_title', p.title, 'provider_archived', p.archived_at is not null, 'id', m.model_id, 'label', m.label,
        'enabled', m.enabled, 'sort_order', m.sort_order, 'archived_at', m.archived_at) order by m.archived_at desc, m.provider_key, m.model_id)
      from public.ai_provider_models m join public.ai_providers p on p.provider_key = m.provider_key
     where m.archived_at is not null and not m.archived_with_provider), '[]'::jsonb))
$$;

create or replace function public.admin_list_removed_ai_catalog() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin perform public._require_admin(); return public._ai_removed_json(); end $$;

-- ------------------------------------------------------------------ archive / restore: providers
create or replace function public.admin_archive_ai_provider(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.ai_providers%rowtype; n integer := 0; m record;
begin
  perform public._require_admin();
  select * into p from public.ai_providers where provider_key = p_key for update;
  if not found then raise exception 'unknown_provider'; end if;
  if p.archived_at is not null then
    return jsonb_build_object('archived', true, 'already_archived', true, 'provider', p_key, 'models_archived', 0, 'storage_paths', '[]'::jsonb,
                              'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
  end if;
  if exists (select 1 from public.ai_force_update_jobs where provider_key = p_key and status = 'active') then
    raise exception 'provider_has_active_force_update: cancel its force update first';
  end if;
  update public.ai_providers set archived_at = now(), archived_by = auth.uid() where provider_key = p_key;
  with a as (update public.ai_provider_models set archived_at = now(), archived_by = auth.uid(), archived_with_provider = true
              where provider_key = p_key and archived_at is null returning 1)
    select count(*) into n from a;
  perform public._ai_mirror_access(p_key, '', false);                                           -- older apps read ai_access: archived = off
  for m in select model_id from public.ai_provider_models where provider_key = p_key and archived_at is not null loop
    perform public._ai_mirror_access(p_key, m.model_id, false);
  end loop;
  perform public._audit('archive_ai_provider', p_key, jsonb_build_object('models_archived', n));
  return jsonb_build_object('archived', true, 'already_archived', false, 'provider', p_key, 'models_archived', n, 'storage_paths', '[]'::jsonb,
                            'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
end $$;

create or replace function public.admin_restore_ai_provider(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare p public.ai_providers%rowtype; n integer := 0; m record;
begin
  perform public._require_admin();
  select * into p from public.ai_providers where provider_key = p_key for update;
  if not found then raise exception 'unknown_provider'; end if;
  if p.archived_at is null then
    return jsonb_build_object('restored', true, 'already_active', true, 'provider', p_key, 'models_restored', 0,
                              'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
  end if;
  update public.ai_providers set archived_at = null, archived_by = null where provider_key = p_key;     -- enabled / hidden / order / updated_at are NOT touched
  with a as (update public.ai_provider_models set archived_at = null, archived_by = null, archived_with_provider = false
              where provider_key = p_key and archived_with_provider returning 1)
    select count(*) into n from a;
  perform public._ai_mirror_access(p_key, '', p.enabled);                                       -- back to the stored switch
  for m in select model_id, enabled from public.ai_provider_models where provider_key = p_key and archived_at is null loop
    perform public._ai_mirror_access(p_key, m.model_id, m.enabled);
  end loop;
  perform public._audit('restore_ai_provider', p_key, jsonb_build_object('models_restored', n));
  return jsonb_build_object('restored', true, 'already_active', false, 'provider', p_key, 'models_restored', n,
                            'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
end $$;

-- ------------------------------------------------------------------ archive / restore: models
create or replace function public.admin_archive_ai_model(p_provider text, p_model text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.ai_provider_models%rowtype;
begin
  perform public._require_admin();
  select * into m from public.ai_provider_models where provider_key = p_provider and model_id = p_model for update;
  if not found then raise exception 'unknown_model'; end if;
  if m.archived_at is not null then
    return jsonb_build_object('archived', true, 'already_archived', true, 'provider', p_provider, 'model', p_model,
                              'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
  end if;
  if exists (select 1 from public.ai_force_update_jobs where provider_key = p_provider and scope = 'model' and model_id = p_model and status = 'active') then
    raise exception 'model_has_active_force_update: cancel its force update first';
  end if;
  update public.ai_provider_models set archived_at = now(), archived_by = auth.uid(), archived_with_provider = false where provider_key = p_provider and model_id = p_model;
  perform public._ai_mirror_access(p_provider, p_model, false);
  perform public._audit('archive_ai_model', p_provider, jsonb_build_object('model', p_model));
  return jsonb_build_object('archived', true, 'already_archived', false, 'provider', p_provider, 'model', p_model,
                            'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
end $$;

create or replace function public.admin_restore_ai_model(p_provider text, p_model text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m public.ai_provider_models%rowtype; pa timestamptz;
begin
  perform public._require_admin();
  select * into m from public.ai_provider_models where provider_key = p_provider and model_id = p_model for update;
  if not found then raise exception 'unknown_model'; end if;
  if m.archived_at is null then
    return jsonb_build_object('restored', true, 'already_active', true, 'provider', p_provider, 'model', p_model,
                              'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
  end if;
  select archived_at into pa from public.ai_providers where provider_key = p_provider;
  if pa is not null then raise exception 'parent_provider_archived: restore provider % first (a model is restored without changing its provider)', p_provider; end if;
  update public.ai_provider_models set archived_at = null, archived_by = null, archived_with_provider = false where provider_key = p_provider and model_id = p_model;   -- provider row untouched
  perform public._ai_mirror_access(p_provider, p_model, m.enabled);
  perform public._audit('restore_ai_model', p_provider, jsonb_build_object('model', p_model));
  return jsonb_build_object('restored', true, 'already_active', false, 'provider', p_provider, 'model', p_model,
                            'catalog', public._ai_catalog_json(true), 'removed', public._ai_removed_json());
end $$;

-- ------------------------------------------------------------------ the two 0021 delete functions: same names and signatures, but they only ARCHIVE now
-- (an older Admin page that still calls them can no longer delete anything; 'storage_paths' stays an empty list so it removes no file)
create or replace function public.admin_delete_ai_provider(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return public.admin_archive_ai_provider(p_key) || jsonb_build_object('deleted', false);
end $$;

create or replace function public.admin_delete_ai_model(p_provider text, p_model text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return public.admin_archive_ai_model(p_provider, p_model) || jsonb_build_object('deleted', false);
end $$;

-- ------------------------------------------------------------------ privileges: same pattern as every other admin_* function (the _require_admin() call is the gate)
revoke all on function public._ai_removed_json() from public, anon, authenticated;
revoke all on function public.admin_list_removed_ai_catalog(), public.admin_archive_ai_provider(text), public.admin_restore_ai_provider(text),
  public.admin_archive_ai_model(text, text), public.admin_restore_ai_model(text, text) from public, anon, authenticated;
grant execute on function public.admin_list_removed_ai_catalog(), public.admin_archive_ai_provider(text), public.admin_restore_ai_provider(text),
  public.admin_archive_ai_model(text, text), public.admin_restore_ai_model(text, text) to authenticated;

commit;
