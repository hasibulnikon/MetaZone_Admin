-- 0028 (app version stays v1.0.0): bulk model import for OpenAI-compatible providers (7th Edition Part 4).
-- FORWARD-ONLY, idempotent, one transaction. Run AFTER 0001..0027. NOT APPLIED to any database yet and NOT executed against any PostgreSQL (prepared for
-- review; apply it yourself in the Supabase SQL Editor, first on a TEST project). It does not change any earlier migration file; it only ADDS one function.
--
-- WHY
--   The Admin "Import models" screen fetches model ids from a provider's /models endpoint and adds several at once. The existing admin_upsert_ai_model
--   OVERWRITES label / enabled / order of a model that already exists, so calling it in a loop could silently change models the Admin configured earlier.
--   An import must be INSERT-ONLY, atomic and race-safe, so this adds one function that never updates an existing row.
--
-- WHAT IT ADDS
--   admin_import_ai_models(p_provider text, p_models jsonb) -> jsonb   (Admin only, audited)
--     p_models = [{"id": "...", "label": "...", "enabled": true, "sort_order": 10, "text_only": true}, ...]  (at most 500)
--     * only for an existing, NOT archived provider whose adapter is 'openai_compat' (a Built-in / Downloaded Package provider is refused);
--     * a model that already exists is SKIPPED, never updated (skipped_existing); a model removed earlier (archived, migration 0026) is SKIPPED and must be
--       restored from Removed Providers & Models (skipped_archived); an id repeated inside the request is inserted once; an invalid entry is reported, not inserted;
--     * text_only is set only on rows this call inserts (a missing value means TRUE: a model is never assumed to read images);
--     * a model inserted as OFF is mirrored into ai_access exactly like admin_upsert_ai_model does (older apps keep obeying it);
--     * returns {added, skipped_existing, skipped_archived, invalid, catalog} - catalog is the same JSON as admin_list_ai_catalog().
--   No API key and no provider setting is read or written here.
begin;

do $$ begin
  if to_regclass('public.ai_providers') is null or to_regclass('public.ai_provider_models') is null then
    raise exception '0028 stopped: migration 0021 (ai_provider_catalog) has not been applied. Nothing was changed.' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_provider_models' and column_name = 'archived_at') then
    raise exception '0028 stopped: migration 0026 (removed_providers_models_archive) has not been applied. Nothing was changed.' using errcode = '55000';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_provider_models' and column_name = 'text_only') then
    raise exception '0028 stopped: migration 0027 (openai_compatible_providers) has not been applied. Nothing was changed. Run 0027 first.' using errcode = '55000';
  end if;
  if to_regprocedure('public._require_admin()') is null or to_regprocedure('public._audit(text,text,jsonb)') is null
     or to_regprocedure('public._ai_mirror_access(text,text,boolean)') is null or to_regprocedure('public._ai_catalog_json(boolean)') is null then
    raise exception '0028 stopped: _require_admin / _audit / _ai_mirror_access / _ai_catalog_json are missing. Nothing was changed.' using errcode = '55000';
  end if;
end $$;

create or replace function public.admin_import_ai_models(p_provider text, p_models jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  v_adapter text; v_archived timestamptz; v_found boolean;
  e jsonb; mid text; lbl text; v_enabled boolean; v_sort integer; v_text_only boolean; v_tmp text; n integer := 0; ins integer;
  seen text[] := array[]::text[];
  added jsonb := '[]'::jsonb; skipped_existing jsonb := '[]'::jsonb; skipped_archived jsonb := '[]'::jsonb; invalid jsonb := '[]'::jsonb;
begin
  perform public._require_admin();
  select adapter, archived_at, true into v_adapter, v_archived, v_found from public.ai_providers where provider_key = p_provider;
  if not coalesce(v_found, false) then raise exception 'unknown_provider'; end if;
  if v_archived is not null then raise exception 'provider_is_archived: restore the provider first'; end if;
  if v_adapter <> 'openai_compat' then raise exception 'import_requires_openai_compat: % uses the "%" adapter; models are imported only into OpenAI-compatible providers', p_provider, v_adapter; end if;
  if p_models is null or jsonb_typeof(p_models) <> 'array' then raise exception 'invalid_models: expected a list of models'; end if;
  if jsonb_array_length(p_models) = 0 then raise exception 'invalid_models: the list is empty'; end if;
  if jsonb_array_length(p_models) > 500 then raise exception 'too_many_models: at most 500 per import'; end if;

  for e in select x from jsonb_array_elements(p_models) x loop
    n := n + 1;
    if jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'id') <> 'string' then
      invalid := invalid || jsonb_build_array(jsonb_build_object('position', n, 'reason', 'not a model object with an id'));
      continue;
    end if;
    mid := btrim(e ->> 'id');
    if char_length(mid) not between 1 and 120 or mid ~ '[[:space:][:cntrl:]]' then
      invalid := invalid || jsonb_build_array(jsonb_build_object('id', left(mid, 60), 'reason', 'a model id has 1-120 characters and no spaces'));
      continue;
    end if;
    if mid = any (seen) then continue; end if;
    seen := seen || mid;
    lbl := left(btrim(coalesce(nullif(btrim(e ->> 'label'), ''), mid)), 80);
    if char_length(lbl) < 1 or lbl ~ '[[:cntrl:]]' then lbl := left(mid, 80); end if;
    v_enabled := case when jsonb_typeof(e -> 'enabled') = 'boolean' then (e ->> 'enabled')::boolean else true end;
    v_text_only := case when jsonb_typeof(e -> 'text_only') = 'boolean' then (e ->> 'text_only')::boolean else true end;
    v_tmp := e ->> 'sort_order';
    v_sort := case when v_tmp ~ '^[0-9]{1,6}$' then v_tmp::integer else 100 end;

    if exists (select 1 from public.ai_provider_models where provider_key = p_provider and model_id = mid and archived_at is not null) then
      skipped_archived := skipped_archived || to_jsonb(mid);
      continue;
    end if;
    insert into public.ai_provider_models(provider_key, model_id, label, enabled, sort_order, text_only)
      values (p_provider, mid, lbl, v_enabled, v_sort, v_text_only)
      on conflict (provider_key, model_id) do nothing;
    get diagnostics ins = row_count;
    if ins = 1 then
      added := added || to_jsonb(mid);
      if not v_enabled then perform public._ai_mirror_access(p_provider, mid, false); end if;
    else
      skipped_existing := skipped_existing || to_jsonb(mid);
    end if;
  end loop;

  perform public._audit('ai_models_import', p_provider, jsonb_build_object('added', jsonb_array_length(added), 'skipped_existing', jsonb_array_length(skipped_existing),
                                                                           'skipped_archived', jsonb_array_length(skipped_archived), 'invalid', jsonb_array_length(invalid)));
  return jsonb_build_object('added', added, 'skipped_existing', skipped_existing, 'skipped_archived', skipped_archived, 'invalid', invalid,
                            'catalog', public._ai_catalog_json(true));
end $$;

revoke all on function public.admin_import_ai_models(text, jsonb) from public, anon, authenticated;
grant execute on function public.admin_import_ai_models(text, jsonb) to authenticated;

commit;
