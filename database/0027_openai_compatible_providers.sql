-- 0027 (app version stays v1.0.0): OpenAI-compatible providers (7th Edition Part 3) - catalogue support for the app's generic OpenAI-compatible runtime.
-- FORWARD-ONLY, idempotent, one transaction. Run AFTER 0001..0026. NOT APPLIED to any database yet and NOT executed against any PostgreSQL (prepared for
-- review; apply it yourself in the Supabase SQL Editor, first on a TEST project). It does not change any earlier migration file; the one function it
-- replaces (_ai_catalog_json) is re-created with CREATE OR REPLACE, so its grants stay as they are.
--
-- WHY
--   A service that speaks the OpenAI chat-completions format (Groq, OpenRouter, Cerebras, ...) needs no downloadable adapter package any more: the app
--   carries ONE generic runtime (backend/providers/openai_compat.py) and the catalogue only says WHERE the service is and HOW to authenticate.
--
-- WHAT IT ADDS / CHANGES
--   ai_providers.adapter        now also accepts 'openai_compat'  (existing rows keep 'builtin' / 'package'; nothing is converted)
--   ai_provider_openai_config   NEW: one row per OpenAI-compatible provider: base_url, chat_path, models_path ('' = the service cannot list models),
--                               auth_scheme ('bearer' | 'header'), auth_header, auth_prefix, extra_headers, timeout_seconds, max_tokens_field.
--                               Closed to every client role (RLS on, all privileges revoked); the admin function below is the only writer.
--   ai_provider_models.text_only NEW boolean (default false): the Admin marks a model as unable to read images. Vision itself reuses the EXISTING
--                               ai_providers.vision flag; text_only can only narrow it for one model, never widen it.
--   admin_upsert_ai_openai_provider(...)   create / update an OpenAI-compatible provider + its settings (Admin only, audited)
--   admin_set_ai_model_text_only(...)      mark / unmark one model as text only (Admin only)
--   _ai_catalog_json(boolean)              (replaced) also returns `compat` (the settings above) per provider and `text_only` per model
-- RULES THE SERVER ENFORCES (the app re-checks all of them and never trusts the server's answer)
--   * https only; no credentials / query / fragment in the URL; the host must be a real domain name (no IP literal, no localhost / .local / .internal ...);
--   * paths use only letters, digits and . _ ~ - /, no '//' and no dot segments; a pasted endpoint name (/chat/completions, /models) is removed from
--     base_url and a path that repeats the base URL's own path is shortened, so no path is ever duplicated;
--   * extra_headers: at most 10, plain text, never a hop-by-hop header, never the auth header and never a name that looks like a credential;
--   * NO API KEY IS STORED ANYWHERE IN THE DATABASE. Users' keys stay in the app (prefs.json); this catalogue is readable by every signed-in user, so
--     it only ever holds non-secret settings. Row-level security and the Admin checks of 0021 - 0026 are untouched;
--   * an existing provider of another adapter is never converted (adapter_conflict); an archived provider is never overwritten (restore it first).
begin;

do $$ begin
  if to_regclass('public.ai_providers') is null or to_regclass('public.ai_provider_models') is null then
    raise exception '0027 stopped: migration 0021 (ai_provider_catalog) has not been applied. Nothing was changed.' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_providers' and column_name = 'archived_at')
     or not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_provider_models' and column_name = 'archived_at') then
    raise exception '0027 stopped: migration 0026 (removed_providers_models_archive) has not been applied. Nothing was changed. Run 0026 first.' using errcode = '55000';
  end if;
  if to_regprocedure('public._require_admin()') is null or to_regprocedure('public._audit(text,text,jsonb)') is null
     or to_regprocedure('public._ai_mirror_access(text,text,boolean)') is null or to_regprocedure('public._ai_catalog_json(boolean)') is null then
    raise exception '0027 stopped: _require_admin / _audit / _ai_mirror_access / _ai_catalog_json are missing. Nothing was changed.' using errcode = '55000';
  end if;
end $$;

-- ------------------------------------------------------------------ adapter kinds (additive: the two existing values stay valid)
do $$ declare c record; begin
  for c in select conname from pg_constraint
            where conrelid = 'public.ai_providers'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%adapter%' loop
    execute format('alter table public.ai_providers drop constraint %I', c.conname);
  end loop;
  alter table public.ai_providers add constraint ai_providers_adapter_check check (adapter in ('builtin', 'package', 'openai_compat'));
end $$;

-- ------------------------------------------------------------------ per-model "text only" mark (vision itself stays ai_providers.vision)
alter table public.ai_provider_models add column if not exists text_only boolean not null default false;

-- ------------------------------------------------------------------ settings of an OpenAI-compatible provider (NO secrets)
create table if not exists public.ai_provider_openai_config (
  provider_key     text primary key references public.ai_providers(provider_key) on delete cascade,
  base_url         text not null check (char_length(base_url) between 12 and 300
                                        and base_url ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$'
                                        and base_url !~ '/\.\.?(/|$)'),
  chat_path        text not null default '/chat/completions' check (chat_path ~ '^/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*$' and chat_path !~ '/\.\.?(/|$)'),
  models_path      text not null default '/models' check (models_path = '' or (models_path ~ '^/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*$' and models_path !~ '/\.\.?(/|$)')),
  auth_scheme      text not null default 'bearer' check (auth_scheme in ('bearer', 'header')),
  auth_header      text not null default 'Authorization' check (auth_header ~ '^[A-Za-z0-9_-]{1,64}$'),
  auth_prefix      text not null default 'Bearer ' check (auth_prefix ~ '^[ -~]{0,32}$'),
  extra_headers    jsonb not null default '{}'::jsonb check (jsonb_typeof(extra_headers) = 'object' and char_length(extra_headers::text) <= 3000),
  timeout_seconds  integer not null default 30 check (timeout_seconds between 5 and 120),
  max_tokens_field text not null default 'max_tokens' check (max_tokens_field in ('max_tokens', 'max_completion_tokens')),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  check (auth_scheme <> 'bearer' or (auth_header = 'Authorization' and auth_prefix = 'Bearer '))
);
alter table public.ai_provider_openai_config enable row level security;
revoke all on table public.ai_provider_openai_config from public, anon, authenticated;

-- ------------------------------------------------------------------ helpers (closed to every client role)
create or replace function public._ai_openai_forbidden_headers() returns text[]
language sql immutable set search_path = public, pg_temp as $$
  select array['host', 'content-length', 'content-type', 'accept', 'accept-encoding', 'user-agent', 'cookie', 'set-cookie', 'transfer-encoding',
               'connection', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'upgrade', 'expect', 'keep-alive', 'x-forwarded-for',
               'x-forwarded-host', 'x-real-ip', 'forwarded']
$$;

create or replace function public._ai_openai_clean_headers(p_headers jsonb, p_auth_header text) returns jsonb
language plpgsql immutable set search_path = public, pg_temp as $$
declare r record; res jsonb := '{}'::jsonb; n integer := 0; low text; val text;
begin
  if p_headers is null or p_headers = '{}'::jsonb then return '{}'::jsonb; end if;
  if jsonb_typeof(p_headers) <> 'object' then raise exception 'invalid_extra_headers: must be an object of header names and values'; end if;
  for r in select e.key as hname, e.value as hval from jsonb_each(p_headers) e loop
    n := n + 1;
    low := lower(r.hname);
    if n > 10 then raise exception 'invalid_extra_headers: at most 10 headers'; end if;
    if r.hname !~ '^[A-Za-z0-9_-]{1,64}$' then raise exception 'invalid_extra_headers: "%" is not a valid header name', left(r.hname, 40); end if;
    if low = any (public._ai_openai_forbidden_headers()) or low = lower(coalesce(p_auth_header, '')) then
      raise exception 'invalid_extra_headers: % cannot be set here', r.hname;
    end if;
    if low ~ '(key|secret|token|auth|password|passwd|cookie|session|credential|bearer)' then
      raise exception 'invalid_extra_headers: % looks like a credential - the catalogue is visible to every signed-in user, so no secret may be stored in it', r.hname;
    end if;
    if exists (select 1 from jsonb_object_keys(p_headers) k where lower(k) = low and k <> r.hname) then
      raise exception 'invalid_extra_headers: % appears twice', r.hname;
    end if;
    if jsonb_typeof(r.hval) <> 'string' then raise exception 'invalid_extra_headers: the value of % must be text', r.hname; end if;
    val := btrim(r.hval #>> '{}');
    if char_length(val) not between 1 and 200 or val !~ '^[ -~]+$' then
      raise exception 'invalid_extra_headers: the value of % must be 1-200 plain characters', r.hname;
    end if;
    res := res || jsonb_build_object(r.hname, val);
  end loop;
  return res;
end $$;

-- ------------------------------------------------------------------ catalogue JSON: + compat settings per provider, + text_only per model
create or replace function public._ai_catalog_json(p_admin boolean) returns jsonb
language sql stable security definer set search_path = public, pg_temp as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'provider', p.provider_key, 'title', p.title, 'enabled', p.enabled, 'hidden', p.hidden, 'vision', p.vision,
    'key_url', p.key_url, 'key_hint', p.key_hint, 'validate', p.validate_kind, 'adapter', p.adapter,
    'sort_order', p.sort_order, 'failover_order', p.failover_order,
    'compat', (select jsonb_build_object('base_url', o.base_url, 'chat_path', o.chat_path, 'models_path', o.models_path, 'auth_scheme', o.auth_scheme,
                                         'auth_header', o.auth_header, 'auth_prefix', o.auth_prefix, 'extra_headers', o.extra_headers,
                                         'timeout_seconds', o.timeout_seconds, 'max_tokens_field', o.max_tokens_field)
                 from public.ai_provider_openai_config o where o.provider_key = p.provider_key and p.adapter = 'openai_compat'),
    'models', coalesce((select jsonb_agg(jsonb_build_object('id', m.model_id, 'label', m.label, 'enabled', m.enabled, 'sort_order', m.sort_order,
                                                            'text_only', m.text_only)
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

-- ------------------------------------------------------------------ admin: create / update an OpenAI-compatible provider
create or replace function public.admin_upsert_ai_openai_provider(
  p_key text, p_title text, p_config jsonb, p_enabled boolean default true, p_hidden boolean default false, p_vision boolean default true,
  p_key_url text default '', p_key_hint text default '', p_sort integer default 100, p_failover integer default 100) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  k text := btrim(coalesce(p_key, '')); t text := btrim(coalesce(p_title, ''));
  c jsonb := coalesce(p_config, '{}'::jsonb);
  allowed text[] := array['base_url', 'chat_path', 'models_path', 'auth_scheme', 'auth_header', 'auth_prefix', 'extra_headers', 'timeout_seconds', 'max_tokens_field'];
  unk text; cur text; cur_archived timestamptz; found_row boolean;
  v_base text; v_host text; v_port text; v_bpath text; v_chat text; v_models text; v_scheme text; v_header text; v_prefix text; v_headers jsonb;
  v_timeout integer; v_field text; v_tmp text;
begin
  perform public._require_admin();
  if k !~ '^[A-Za-z][A-Za-z0-9_.-]{0,39}$' then raise exception 'invalid_provider_key'; end if;
  if char_length(t) not between 1 and 80 then raise exception 'invalid_title'; end if;
  if lower(k) like '%apify%' then raise exception 'apify_is_not_a_meta_generator_provider'; end if;
  if jsonb_typeof(c) <> 'object' then raise exception 'invalid_config: the settings must be an object'; end if;
  select kk into unk from jsonb_object_keys(c) kk where kk <> all (allowed) limit 1;
  if unk is not null then raise exception 'unknown_setting: %', left(unk, 40); end if;

  -- an existing provider of another adapter is never converted; an archived one is never overwritten
  select adapter, archived_at, true into cur, cur_archived, found_row from public.ai_providers where provider_key = k;
  if found_row then
    if cur_archived is not null then
      raise exception 'provider_is_archived: % was removed earlier - restore it from Removed Providers & Models instead of adding it again', k;
    end if;
    if cur <> 'openai_compat' then
      raise exception 'adapter_conflict: % already exists with the "%" adapter and is not converted. Use another provider key', k, cur;
    end if;
  end if;

  -- base_url: https only, a real domain name, no credentials / query / fragment, no endpoint name at the end, no trailing slash
  v_base := btrim(coalesce(c ->> 'base_url', ''));
  if v_base = '' then raise exception 'base_url_required'; end if;
  if v_base !~* '^https://' then raise exception 'base_url_must_be_https'; end if;
  if char_length(v_base) > 300 or v_base ~ '[[:space:][:cntrl:]?#@]' then raise exception 'invalid_base_url: no spaces, credentials, ? or # parts, at most 300 characters'; end if;
  v_base := regexp_replace(v_base, '/+$', '');
  while v_base ~ '^https://[^/]+(/.*)?/(chat/completions|completions|models)$' loop
    v_base := regexp_replace(v_base, '/(chat/completions|completions|models)$', '');
  end loop;
  v_host := lower(substring(v_base from '^https://([^/:]+)'));
  v_base := 'https://' || v_host || coalesce(substring(v_base from '^https://[^/:]+(.*)$'), '');
  if v_base !~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*$' or v_base ~ '/\.\.?(/|$)' then
    raise exception 'invalid_base_url';
  end if;
  if v_host !~ '\.' or v_host ~ '^[0-9.]+$' or v_host = 'localhost' or v_host ~ '\.(localhost|local|internal|lan|localdomain|intranet|corp|private)$'
     or v_host ~ '\.home\.arpa$' or v_host ~ '\.\.' or v_host ~ '(^|\.)-' or v_host ~ '-(\.|$)' or char_length(v_host) > 253 then
    raise exception 'invalid_base_url_host: use the provider''s public domain name (no IP address, localhost or local / internal names)';
  end if;
  v_port := substring(v_base from '^https://[^/:]+:([0-9]+)');
  if v_port is not null then
    if char_length(v_port) > 5 then raise exception 'invalid_base_url_port'; end if;
    if v_port::integer not between 1 and 65535 then raise exception 'invalid_base_url_port'; end if;
  end if;
  v_bpath := coalesce(substring(v_base from '^https://[^/]+(/.*)$'), '');

  -- endpoint paths: leading '/', no '//', no trailing '/', and never repeating the base URL's own path
  v_chat := coalesce(nullif(btrim(c ->> 'chat_path'), ''), '/chat/completions');
  if v_chat ~ '://' then raise exception 'invalid_chat_path: give a path such as /chat/completions, not a full URL'; end if;
  if v_chat !~ '^/' then v_chat := '/' || v_chat; end if;
  v_chat := regexp_replace(regexp_replace(v_chat, '/{2,}', '/', 'g'), '(.)/$', '\1');
  if v_bpath <> '' and (v_chat = v_bpath or left(v_chat, char_length(v_bpath) + 1) = v_bpath || '/') then v_chat := substr(v_chat, char_length(v_bpath) + 1); end if;
  if v_chat !~ '^/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*$' or v_chat ~ '/\.\.?(/|$)' then raise exception 'invalid_chat_path'; end if;

  if not (c ? 'models_path') or jsonb_typeof(c -> 'models_path') = 'null' then
    v_models := '/models';
  else
    v_models := btrim(coalesce(c ->> 'models_path', ''));
    if v_models ~ '://' then raise exception 'invalid_models_path: give a path such as /models, not a full URL'; end if;
    if v_models <> '' then
      if v_models !~ '^/' then v_models := '/' || v_models; end if;
      v_models := regexp_replace(regexp_replace(v_models, '/{2,}', '/', 'g'), '(.)/$', '\1');
      if v_bpath <> '' and (v_models = v_bpath or left(v_models, char_length(v_bpath) + 1) = v_bpath || '/') then v_models := substr(v_models, char_length(v_bpath) + 1); end if;
      if v_models !~ '^/[A-Za-z0-9._~-]+(/[A-Za-z0-9._~-]+)*$' or v_models ~ '/\.\.?(/|$)' then raise exception 'invalid_models_path'; end if;
    end if;
  end if;

  -- authentication: Bearer, or one named header (e.g. x-api-key) with an optional prefix
  v_scheme := coalesce(nullif(btrim(c ->> 'auth_scheme'), ''), 'bearer');
  if v_scheme not in ('bearer', 'header') then raise exception 'invalid_auth_scheme'; end if;
  if v_scheme = 'bearer' then
    v_header := 'Authorization'; v_prefix := 'Bearer ';
  else
    v_header := btrim(coalesce(c ->> 'auth_header', ''));
    v_prefix := coalesce(c ->> 'auth_prefix', '');
    if v_header !~ '^[A-Za-z0-9_-]{1,64}$' or lower(v_header) = any (public._ai_openai_forbidden_headers()) then raise exception 'invalid_auth_header'; end if;
    if v_prefix !~ '^[ -~]{0,32}$' then raise exception 'invalid_auth_prefix: at most 32 printable characters'; end if;
  end if;
  v_headers := public._ai_openai_clean_headers(coalesce(c -> 'extra_headers', '{}'::jsonb), v_header);

  v_tmp := coalesce(nullif(btrim(c ->> 'timeout_seconds'), ''), '30');
  if v_tmp !~ '^[0-9]{1,3}$' then raise exception 'invalid_timeout: 5 to 120 seconds'; end if;
  v_timeout := v_tmp::integer;
  if v_timeout not between 5 and 120 then raise exception 'invalid_timeout: 5 to 120 seconds'; end if;
  v_field := coalesce(nullif(btrim(c ->> 'max_tokens_field'), ''), 'max_tokens');
  if v_field not in ('max_tokens', 'max_completion_tokens') then raise exception 'invalid_max_tokens_field'; end if;

  insert into public.ai_providers(provider_key, title, enabled, hidden, vision, key_url, key_hint, validate_kind, adapter, sort_order, failover_order)
    values (k, t, coalesce(p_enabled, true), coalesce(p_hidden, false), coalesce(p_vision, true), left(coalesce(p_key_url, ''), 300),
            left(coalesce(p_key_hint, ''), 200), 'openai_compat', 'openai_compat', coalesce(p_sort, 100), coalesce(p_failover, 100))
    on conflict (provider_key) do update set title = excluded.title, enabled = excluded.enabled, hidden = excluded.hidden, vision = excluded.vision,
      key_url = excluded.key_url, key_hint = excluded.key_hint, validate_kind = 'openai_compat', adapter = 'openai_compat',
      sort_order = excluded.sort_order, failover_order = excluded.failover_order, updated_at = now();
  insert into public.ai_provider_openai_config(provider_key, base_url, chat_path, models_path, auth_scheme, auth_header, auth_prefix, extra_headers, timeout_seconds, max_tokens_field)
    values (k, v_base, v_chat, v_models, v_scheme, v_header, v_prefix, v_headers, v_timeout, v_field)
    on conflict (provider_key) do update set base_url = excluded.base_url, chat_path = excluded.chat_path, models_path = excluded.models_path,
      auth_scheme = excluded.auth_scheme, auth_header = excluded.auth_header, auth_prefix = excluded.auth_prefix, extra_headers = excluded.extra_headers,
      timeout_seconds = excluded.timeout_seconds, max_tokens_field = excluded.max_tokens_field, updated_at = now();
  perform public._ai_mirror_access(k, '', coalesce(p_enabled, true));
  perform public._audit('ai_openai_provider_upsert', k, jsonb_build_object('base_url', v_base, 'auth_scheme', v_scheme, 'models_endpoint', v_models <> ''));
  return public._ai_catalog_json(true);
end $$;

-- ------------------------------------------------------------------ admin: mark one model as unable to read images
create or replace function public.admin_set_ai_model_text_only(p_provider text, p_model text, p_text_only boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  if exists (select 1 from public.ai_providers where provider_key = p_provider and archived_at is not null) then raise exception 'provider_is_archived: restore it first'; end if;
  if exists (select 1 from public.ai_provider_models where provider_key = p_provider and model_id = p_model and archived_at is not null) then raise exception 'model_is_archived: restore it first'; end if;
  update public.ai_provider_models set text_only = coalesce(p_text_only, false), updated_at = now() where provider_key = p_provider and model_id = p_model;
  if not found then raise exception 'unknown_model'; end if;
  return public._ai_catalog_json(true);
end $$;

-- ------------------------------------------------------------------ privileges (same pattern as 0021 / 0026)
revoke all on function public._ai_openai_forbidden_headers(), public._ai_openai_clean_headers(jsonb, text) from public, anon, authenticated;
revoke all on function public.admin_upsert_ai_openai_provider(text, text, jsonb, boolean, boolean, boolean, text, text, integer, integer),
  public.admin_set_ai_model_text_only(text, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_upsert_ai_openai_provider(text, text, jsonb, boolean, boolean, boolean, text, text, integer, integer),
  public.admin_set_ai_model_text_only(text, text, boolean) to authenticated;

commit;
