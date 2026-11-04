-- 0025 (app version stays v1.0.0): "Restore Default Providers" for Admin Panel -> API Configuration.
-- FORWARD-ONLY, idempotent, one transaction. Run AFTER 0001..0024. NOT APPLIED to any database yet (prepared for review; apply it yourself in
-- the Supabase SQL Editor). It does NOT re-run 0021 and it does not change any earlier migration.
--
-- WHY
--   admin_delete_ai_provider() (0021) permanently deletes a provider and cascades its models, its ai_access switches and its package rows.
--   Some ORIGINAL DEFAULT providers were deleted that way (everything except Gemini and Mistral). The defaults are fully described by the bundled
--   seed catalogue (MetaZone_js/backend/providers/seed.py = the rows seeded by 0021), so they can be put back; custom providers / models that are
--   NOT in that catalogue cannot be reconstructed here and are never invented.
--
-- WHAT IT ADDS
--   admin_restore_default_ai_catalog()   Admin only (public._require_admin()), no parameters. Returns
--       { restored_providers, restored_models, providers[], models[{provider, model}], catalog }   (catalog = what admin_list_ai_catalog() returns,
--       so the Admin page can redraw from it).
-- RULES THE FUNCTION FOLLOWS
--   * INSERT ... ON CONFLICT DO NOTHING only. An existing provider row or model row is NEVER updated, re-enabled, relabelled, re-ordered or deleted.
--     Custom providers / models (e.g. the manually added Groq model 'openai/gpt-oss-120b') are not touched. Package rows (ai_provider_packages) and
--     their signature columns are not touched and not read.
--   * Only a MISSING default provider, or a MISSING default model (under a provider that now exists), is inserted. Calling it again inserts nothing.
--   * A restored row is enabled unless an older ai_access OFF switch for exactly that provider / model still exists (same rule 0021 used when it
--     seeded); the new row is then mirrored into ai_access with the existing helper, so ai_providers / ai_provider_models and ai_access stay consistent.
--   * No user data: the function never reads or writes anything that holds a user's API key (those live only in the app on the user's computer).
--   * Concurrent clicks are serialised with a transaction-level advisory lock; the counts returned are exactly the rows this call inserted.
--   * One audit row (public._audit) is written only when something was actually restored (counts and keys only).
begin;

do $$ begin
  if to_regclass('public.ai_providers') is null or to_regclass('public.ai_provider_models') is null or to_regclass('public.ai_access') is null then
    raise exception '0025 stopped: migration 0021 (ai_provider_catalog) has not been applied. Nothing was changed. Run 0001..0024 first.' using errcode = '55000';
  end if;
  if to_regprocedure('public._require_admin()') is null or to_regprocedure('public._audit(text,text,jsonb)') is null then
    raise exception '0025 stopped: _require_admin / _audit are missing (migrations 0008 / 0013). Nothing was changed.' using errcode = '55000';
  end if;
  if to_regprocedure('public._ai_mirror_access(text,text,boolean)') is null or to_regprocedure('public._ai_catalog_json(boolean)') is null then
    raise exception '0025 stopped: the 0021 catalogue helpers are missing. Nothing was changed. Run 0021 first.' using errcode = '55000';
  end if;
end $$;

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
     where exists (select 1 from public.ai_providers p where p.provider_key = d.provider_key)
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

-- ------------------------------------------------------------------ privileges: same pattern as every other admin_* function (the _require_admin() call is the gate)
revoke all on function public.admin_restore_default_ai_catalog() from public, anon, authenticated;
grant execute on function public.admin_restore_default_ai_catalog() to authenticated;

commit;
