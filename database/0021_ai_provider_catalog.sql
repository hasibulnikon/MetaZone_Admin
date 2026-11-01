-- 0021 (app version stays v1.0.0): Admin-managed API provider / model catalogue + provider adapter packages.
-- FORWARD-ONLY, idempotent, one transaction. Run AFTER 0001..0020. NOT APPLIED to any database yet (prepared for review; see
-- MetaZone_App/docs/API_MANAGER.md). Does not touch 0008 (ai_access), 0019 (retired Tracker objects), signing keys or secrets.
--
-- WHAT IT ADDS
--   tables  ai_providers, ai_provider_models, ai_provider_packages          (catalogue + package registry; NO user secrets anywhere)
--   admin   admin_list_ai_catalog, admin_upsert_ai_provider, admin_delete_ai_provider, admin_upsert_ai_model, admin_delete_ai_model,
--           admin_set_ai_provider_enabled, admin_set_ai_model_enabled, admin_register_ai_package, admin_record_ai_package_test,
--           admin_publish_ai_package, admin_retire_ai_package, admin_delete_ai_package
--   users   get_ai_catalog(), get_ai_package_download(provider)
--   storage private bucket 'ai-providers' (admins write; a signed-in user may read ONLY the published package of an enabled provider)
-- RULES THE SERVER ENFORCES
--   * publishing is explicit and only from status 'tested' whose test report names the package's own SHA-256; it never touches a user's
--     installed copy (the app updates only when the person presses Update) and never touches users' API keys (they live only in the app);
--   * enabling/disabling a provider or model also mirrors into public.ai_access (0008), so older apps keep honouring the switch;
--   * a provider with a published package cannot be deleted (retire the package first).
begin;

do $$ begin
  if to_regprocedure('public._require_admin()') is null or to_regclass('public.ai_access') is null then
    raise exception '0021 needs 0008 (ai_access, _require_admin) - apply 0001..0020 first';
  end if;
end $$;

-- ------------------------------------------------------------------ tables
create table if not exists public.ai_providers (
  provider_key   text primary key check (provider_key ~ '^[A-Za-z][A-Za-z0-9_.-]{0,39}$'),
  title          text not null check (char_length(btrim(title)) between 1 and 80),
  enabled        boolean not null default true,
  hidden         boolean not null default false,          -- kept in the catalogue, not offered in the key tabs / failover (Claude, Grok today)
  vision         boolean not null default true,
  key_url        text not null default '' check (char_length(key_url) <= 300),
  key_hint       text not null default '' check (char_length(key_hint) <= 200),
  validate_kind  text not null default '' check (char_length(validate_kind) <= 40),
  adapter        text not null default 'builtin' check (adapter in ('builtin', 'package')),
  sort_order     integer not null default 100,            -- order in Settings
  failover_order integer not null default 100,            -- order keys are tried during generation
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
create table if not exists public.ai_provider_models (
  provider_key text not null references public.ai_providers(provider_key) on delete cascade,
  model_id     text not null check (char_length(btrim(model_id)) between 1 and 120),
  label        text not null check (char_length(btrim(label)) between 1 and 80),
  enabled      boolean not null default true,
  sort_order   integer not null default 100,
  updated_at   timestamptz not null default now(),
  primary key (provider_key, model_id)
);
create table if not exists public.ai_provider_packages (
  id           uuid primary key default gen_random_uuid(),
  provider_key text not null references public.ai_providers(provider_key),
  title        text not null check (char_length(btrim(title)) between 1 and 80),     -- Admin display title; there is NO version field
  storage_path text not null unique check (storage_path ~ '^[A-Za-z0-9_.-]+/[0-9a-f]{64}\.mzprovider$'),
  sha256       text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes   integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  status       text not null default 'validated' check (status in ('validated', 'tested', 'published', 'superseded', 'retired')),
  validation   jsonb not null default '{}'::jsonb,
  test_report  jsonb,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  published_at timestamptz,
  unique (provider_key, sha256)
);
create unique index if not exists ai_provider_one_published on public.ai_provider_packages(provider_key) where status = 'published';
alter table public.ai_providers enable row level security;
alter table public.ai_provider_models enable row level security;
alter table public.ai_provider_packages enable row level security;
revoke all on table public.ai_providers, public.ai_provider_models, public.ai_provider_packages from public, anon, authenticated;

-- ------------------------------------------------------------------ seed: EVERY provider / model the app supported before this migration
-- (generated from backend/core/constants.py; an existing row is never overwritten). Existing ai_access OFF switches carry over.
insert into public.ai_providers (provider_key, title, hidden, vision, key_url, key_hint, validate_kind, sort_order, failover_order) values
  ('OpenRouter', 'OpenRouter', false, true, 'https://openrouter.ai/keys', 'Get free key → openrouter.ai', 'openrouter', 80, 10),
  ('Gemini', 'Gemini', false, true, 'https://aistudio.google.com/app/apikey', 'Get free key → aistudio.google.com', 'gemini', 10, 20),
  ('Mistral', 'Mistral', false, true, 'https://console.mistral.ai/api-keys/', 'Get key → console.mistral.ai', 'mistral', 20, 30),
  ('Groq', 'Groq', false, true, 'https://console.groq.com/keys', 'Get free key → console.groq.com', 'groq', 30, 40),
  ('Cerebras', 'Cerebras', false, false, 'https://cloud.cerebras.ai/', 'Get free key → cloud.cerebras.ai', 'cerebras', 40, 50),
  ('OpenAI', 'OpenAI', false, true, 'https://platform.openai.com/api-keys', 'Get key → platform.openai.com', 'openai', 50, 60),
  ('Claude', 'Claude', true, true, 'https://console.anthropic.com/settings/keys', 'Get key → console.anthropic.com', 'claude', 60, 70),
  ('Grok', 'Grok', true, true, 'https://console.x.ai', 'Get key → console.x.ai (this is xAI''s Grok — different from Groq above)', 'grok', 70, 80)
on conflict (provider_key) do nothing;

insert into public.ai_provider_models (provider_key, model_id, label, sort_order) values
  ('OpenRouter', 'thinkingmachines/inkling-small:free', 'Inkling Small (Vision)', 10),
  ('OpenRouter', 'inclusionai/ling-3.0-flash-vl:free', 'Ling 3.0 Flash VL', 20),
  ('OpenRouter', 'thinkingmachines/inkling:free', 'Inkling (Vision)', 30),
  ('OpenRouter', 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', 'Nemotron 3 Nano Omni', 40),
  ('Gemini', 'gemini-3.6-flash', 'Gemini 3.6 Flash', 10),
  ('Gemini', 'gemini-3.5-flash', 'Gemini 3.5 Flash', 20),
  ('Gemini', 'gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', 30),
  ('Gemini', 'gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', 40),
  ('Gemini', 'gemini-3-flash-preview', 'Gemini 3 Flash (Preview)', 50),
  ('Gemini', 'gemini-2.5-flash', 'Gemini 2.5 Flash', 60),
  ('Gemini', 'gemini-1.5-flash', 'Gemini 1.5 Flash', 70),
  ('Gemini', 'gemini-1.5-pro', 'Gemini 1.5 Pro', 80),
  ('Mistral', 'pixtral-12b-2409', 'Pixtral 12B', 10),
  ('Mistral', 'pixtral-large-2411', 'Pixtral Large', 20),
  ('Groq', 'qwen/qwen3.6-27b', 'Qwen 3.6 27B (Vision)', 10),
  ('Cerebras', 'llama-3.3-70b', 'Llama 3.3 70B', 10),
  ('Cerebras', 'llama3.1-8b', 'Llama 3.1 8B', 20),
  ('OpenAI', 'gpt-4o', 'GPT-4o', 10),
  ('OpenAI', 'gpt-4o-mini', 'GPT-4o Mini', 20),
  ('OpenAI', 'gpt-4.1-nano', 'GPT-4.1 Nano', 30),
  ('Claude', 'claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 10),
  ('Claude', 'claude-sonnet-5', 'Claude Sonnet 5', 20),
  ('Grok', 'grok-4', 'Grok 4', 10),
  ('Grok', 'grok-4-fast', 'Grok 4 Fast', 20)
on conflict (provider_key, model_id) do nothing;

update public.ai_providers p set enabled = false
  where exists (select 1 from public.ai_access a where a.provider = p.provider_key and a.model = '' and not a.enabled);
update public.ai_provider_models m set enabled = false
  where exists (select 1 from public.ai_access a where a.provider = m.provider_key and a.model = m.model_id and not a.enabled);

-- ------------------------------------------------------------------ helpers
create or replace function public._ai_mirror_access(p_provider text, p_model text, p_enabled boolean) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_enabled then delete from public.ai_access where provider = p_provider and model = p_model;
  else insert into public.ai_access(provider, model, enabled) values (p_provider, p_model, false)
         on conflict (provider, model) do update set enabled = false, updated_at = now();
  end if;
end $$;

create or replace function public._ai_catalog_json(p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider', p.provider_key, 'title', p.title, 'enabled', p.enabled, 'hidden', p.hidden, 'vision', p.vision,
    'key_url', p.key_url, 'key_hint', p.key_hint, 'validate', p.validate_kind, 'adapter', p.adapter,
    'sort_order', p.sort_order, 'failover_order', p.failover_order,
    'models', coalesce((select jsonb_agg(jsonb_build_object('id', m.model_id, 'label', m.label, 'enabled', m.enabled, 'sort_order', m.sort_order)
                                         order by m.sort_order, m.model_id) from public.ai_provider_models m where m.provider_key = p.provider_key), '[]'::jsonb),
    'package', (select jsonb_build_object('id', k.id, 'title', k.title, 'sha256', k.sha256, 'size', k.size_bytes, 'published_at', k.published_at)
                  from public.ai_provider_packages k where k.provider_key = p.provider_key and k.status = 'published'),
    'packages', case when p_admin then coalesce((select jsonb_agg(jsonb_build_object('id', k.id, 'title', k.title, 'sha256', k.sha256, 'size', k.size_bytes,
                         'status', k.status, 'validation', k.validation, 'test_report', k.test_report, 'storage_path', k.storage_path,
                         'created_at', k.created_at, 'published_at', k.published_at) order by k.created_at desc)
                         from public.ai_provider_packages k where k.provider_key = p.provider_key), '[]'::jsonb) else null end
  ) order by p.sort_order, p.provider_key), '[]'::jsonb) from public.ai_providers p
$$;

-- ------------------------------------------------------------------ admin functions
create or replace function public.admin_list_ai_catalog() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin perform public._require_admin(); return public._ai_catalog_json(true); end $$;

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

create or replace function public.admin_set_ai_provider_enabled(p_key text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.ai_providers set enabled = coalesce(p_enabled, true), updated_at = now() where provider_key = p_key;
  if not found then raise exception 'unknown_provider'; end if;
  perform public._ai_mirror_access(p_key, '', coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_upsert_ai_model(p_provider text, p_model text, p_label text, p_enabled boolean default true, p_sort integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare m text := btrim(coalesce(p_model, '')); l text := btrim(coalesce(p_label, ''));
begin
  perform public._require_admin();
  if not exists (select 1 from public.ai_providers where provider_key = p_provider) then raise exception 'unknown_provider'; end if;
  if char_length(m) not between 1 and 120 or char_length(l) not between 1 and 80 then raise exception 'invalid_model'; end if;
  insert into public.ai_provider_models(provider_key, model_id, label, enabled, sort_order) values (p_provider, m, l, coalesce(p_enabled, true), coalesce(p_sort, 100))
    on conflict (provider_key, model_id) do update set label = excluded.label, enabled = excluded.enabled, sort_order = excluded.sort_order, updated_at = now();
  perform public._ai_mirror_access(p_provider, m, coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_set_ai_model_enabled(p_provider text, p_model text, p_enabled boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.ai_provider_models set enabled = coalesce(p_enabled, true), updated_at = now() where provider_key = p_provider and model_id = p_model;
  if not found then raise exception 'unknown_model'; end if;
  perform public._ai_mirror_access(p_provider, p_model, coalesce(p_enabled, true));
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_delete_ai_model(p_provider text, p_model text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  delete from public.ai_provider_models where provider_key = p_provider and model_id = p_model;
  if not found then raise exception 'unknown_model'; end if;
  delete from public.ai_access where provider = p_provider and model = p_model;
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_delete_ai_provider(p_key text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare paths jsonb;
begin
  perform public._require_admin();
  if not exists (select 1 from public.ai_providers where provider_key = p_key) then raise exception 'unknown_provider'; end if;
  if exists (select 1 from public.ai_provider_packages where provider_key = p_key and status = 'published') then
    raise exception 'provider_has_published_package: retire the package first';
  end if;
  select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into paths from public.ai_provider_packages where provider_key = p_key;
  delete from public.ai_provider_packages where provider_key = p_key;
  delete from public.ai_providers where provider_key = p_key;               -- models cascade
  delete from public.ai_access where provider = p_key;
  return jsonb_build_object('deleted', true, 'provider', p_key, 'storage_paths', paths, 'catalog', public._ai_catalog_json(true));
end $$;

create or replace function public.admin_register_ai_package(p_provider text, p_title text, p_storage_path text, p_sha256 text, p_size integer, p_validation jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_id uuid; v_obj jsonb;
begin
  perform public._require_admin();
  if not exists (select 1 from public.ai_providers where provider_key = p_provider) then raise exception 'unknown_provider'; end if;
  if coalesce(p_validation ->> 'ok', 'false') <> 'true' then raise exception 'validation_failed: only a package that passed validation can be registered'; end if;
  if (p_validation ->> 'provider') is distinct from p_provider then raise exception 'package_identity_mismatch'; end if;
  if (p_validation ->> 'sha256') is distinct from p_sha256 then raise exception 'validation_report_is_for_another_file'; end if;
  if p_storage_path is distinct from (p_provider || '/' || p_sha256 || '.mzprovider') then raise exception 'storage_path_must_be_provider_slash_sha256'; end if;
  if to_regclass('storage.objects') is not null then
    execute 'select to_jsonb(o) from storage.objects o where o.bucket_id = $1 and o.name = $2 limit 1' into v_obj using 'ai-providers', p_storage_path;
    if v_obj is null then raise exception 'package_file_not_in_storage'; end if;
    if coalesce((v_obj -> 'metadata' ->> 'size')::bigint, p_size) <> p_size then raise exception 'storage_size_mismatch'; end if;
  end if;
  insert into public.ai_provider_packages(provider_key, title, storage_path, sha256, size_bytes, status, validation, created_by)
    values (p_provider, btrim(p_title), p_storage_path, p_sha256, p_size, 'validated', p_validation, auth.uid())
    on conflict (provider_key, sha256) do update set title = excluded.title, validation = excluded.validation
    returning id into v_id;
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_record_ai_package_test(p_id uuid, p_report jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype;
begin
  perform public._require_admin();
  select * into r from public.ai_provider_packages where id = p_id for update;
  if not found then raise exception 'unknown_package'; end if;
  if r.status not in ('validated', 'tested') then raise exception 'package_not_testable_in_status_%', r.status; end if;
  if coalesce(p_report ->> 'ok', 'false') <> 'true' then raise exception 'test_failed'; end if;
  if (p_report ->> 'sha256') is distinct from r.sha256 then raise exception 'test_report_is_for_another_file'; end if;
  update public.ai_provider_packages set status = 'tested', test_report = p_report where id = p_id;
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_publish_ai_package(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype;
begin
  perform public._require_admin();
  select * into r from public.ai_provider_packages where id = p_id for update;
  if not found then raise exception 'unknown_package'; end if;
  if r.status = 'published' then return public._ai_catalog_json(true); end if;
  if r.status <> 'tested' then raise exception 'package_must_be_tested_before_publishing (status %)', r.status; end if;
  if (r.test_report ->> 'sha256') is distinct from r.sha256 then raise exception 'test_report_is_for_another_file'; end if;
  update public.ai_provider_packages set status = 'superseded' where provider_key = r.provider_key and status = 'published';
  update public.ai_provider_packages set status = 'published', published_at = now() where id = p_id;
  update public.ai_providers set adapter = 'package', updated_at = now() where provider_key = r.provider_key and adapter = 'package';
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_retire_ai_package(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  update public.ai_provider_packages set status = 'retired' where id = p_id and status in ('published', 'superseded', 'tested', 'validated');
  if not found then raise exception 'unknown_package_or_already_retired'; end if;
  return public._ai_catalog_json(true);
end $$;

create or replace function public.admin_delete_ai_package(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare r public.ai_provider_packages%rowtype;
begin
  perform public._require_admin();
  select * into r from public.ai_provider_packages where id = p_id for update;
  if not found then raise exception 'unknown_package'; end if;
  if r.status = 'published' then raise exception 'published_package_cannot_be_deleted: retire it first'; end if;
  delete from public.ai_provider_packages where id = p_id;
  return jsonb_build_object('deleted', true, 'storage_path', r.storage_path, 'catalog', public._ai_catalog_json(true));
end $$;

-- ------------------------------------------------------------------ what the APP asks (any signed-in user; no admin data, no secrets)
create or replace function public.get_ai_catalog() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if auth.uid() is null then raise exception 'unauthenticated' using errcode = '42501'; end if;
  return jsonb_build_object('providers', public._ai_catalog_json(false));
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
  return jsonb_build_object('package_id', r.id, 'title', r.title, 'storage_path', r.storage_path, 'sha256', r.sha256, 'size', r.size_bytes);
end $$;

-- ------------------------------------------------------------------ Storage: private bucket 'ai-providers'
create or replace function public.mz_ai_pkg_allowed(p_name text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select auth.uid() is not null and p_name is not null and (
    exists (select 1 from public.admin_users a where a.user_id = auth.uid())
    or exists (select 1 from public.ai_provider_packages k join public.ai_providers p on p.provider_key = k.provider_key
               where k.storage_path = p_name and k.status = 'published' and p.enabled))
$$;
do $$ begin
  if to_regclass('storage.objects') is not null then
    insert into storage.buckets (id, name, public) values ('ai-providers', 'ai-providers', false) on conflict (id) do update set public = false;
    drop policy if exists mz_aipk_select on storage.objects; drop policy if exists mz_aipk_insert on storage.objects;
    drop policy if exists mz_aipk_update on storage.objects; drop policy if exists mz_aipk_delete on storage.objects;
    create policy mz_aipk_select on storage.objects for select to authenticated using (bucket_id = 'ai-providers' and public.mz_ai_pkg_allowed(name));
    create policy mz_aipk_insert on storage.objects for insert to authenticated with check (bucket_id = 'ai-providers' and public.mz_addon_admin());
    create policy mz_aipk_update on storage.objects for update to authenticated using (bucket_id = 'ai-providers' and public.mz_addon_admin()) with check (bucket_id = 'ai-providers' and public.mz_addon_admin());
    create policy mz_aipk_delete on storage.objects for delete to authenticated using (bucket_id = 'ai-providers' and public.mz_addon_admin());
  end if;
end $$;

-- ------------------------------------------------------------------ privileges
revoke all on function public._ai_mirror_access(text, text, boolean), public._ai_catalog_json(boolean) from public, anon, authenticated;
revoke all on function public.admin_list_ai_catalog(), public.admin_upsert_ai_provider(text, text, boolean, boolean, boolean, text, text, text, text, integer, integer),
  public.admin_set_ai_provider_enabled(text, boolean), public.admin_upsert_ai_model(text, text, text, boolean, integer), public.admin_set_ai_model_enabled(text, text, boolean),
  public.admin_delete_ai_model(text, text), public.admin_delete_ai_provider(text), public.admin_register_ai_package(text, text, text, text, integer, jsonb),
  public.admin_record_ai_package_test(uuid, jsonb), public.admin_publish_ai_package(uuid), public.admin_retire_ai_package(uuid), public.admin_delete_ai_package(uuid),
  public.get_ai_catalog(), public.get_ai_package_download(text), public.mz_ai_pkg_allowed(text) from public, anon, authenticated;
grant execute on function public.admin_list_ai_catalog(), public.admin_upsert_ai_provider(text, text, boolean, boolean, boolean, text, text, text, text, integer, integer),
  public.admin_set_ai_provider_enabled(text, boolean), public.admin_upsert_ai_model(text, text, text, boolean, integer), public.admin_set_ai_model_enabled(text, text, boolean),
  public.admin_delete_ai_model(text, text), public.admin_delete_ai_provider(text), public.admin_register_ai_package(text, text, text, text, integer, jsonb),
  public.admin_record_ai_package_test(uuid, jsonb), public.admin_publish_ai_package(uuid), public.admin_retire_ai_package(uuid), public.admin_delete_ai_package(uuid),
  public.get_ai_catalog(), public.get_ai_package_download(text), public.mz_ai_pkg_allowed(text) to authenticated;

commit;
