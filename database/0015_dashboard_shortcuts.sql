-- 0015_dashboard_shortcuts.sql  (Step 4.2: configurable Dashboard shortcuts, SERVER SIDE ONLY)   Run AFTER 0014. Safe to re-run (idempotent).
--
-- What this adds. Nothing here touches the Admin Panel UI, the Dashboard UI, the app, signing, authentication or licensing:
--   A. one app_config row  'dashboard_shortcuts'   the global, ordered list of page keys shown as Dashboard shortcuts (a JSON array of text)
--   B. _dashboard_shortcuts_problem(text[])        the ONE validation rule (used by the writer and, fail-safe, by the reader)
--   C. get_my_dashboard_shortcuts()                any signed-in user (the desktop app, the Admin panel): the published list
--   D. admin_set_dashboard_shortcuts(p_keys text[])  admins only: validate, store, audit
--
-- Storage: the existing app_config (key text pk, value jsonb). No new table.
--
-- Rules enforced by the server (admin_set_dashboard_shortcuts), checked in this order, each refusal raises and writes NOTHING:
--   1. the list is required (not NULL, no NULL entry)
--   2. at most 9 entries (the 3 x 3 grid)
--   3. no duplicates (exact text comparison: keys are NOT trimmed, lower-cased or otherwise normalised)
--   4. every key is a supported page: a page_flags row with kind = 'page', and not the API-Manager alias 'settings'
--      (so add-on feature switches such as converter_image / embed_vector are refused)
--   5. Home ('dashboard') and Settings ('appearance') MUST both be present. They cannot be removed. (They are also already protected
--      from being switched off by 0013: page_flags triggers + _page_enabled().)
-- Order is kept as given. Whether a listed page is switched on for a given user is NOT decided here: the app hides a disabled page's button
-- exactly as it does today (PageAccess); Home and Settings are always on.
--
-- Default and fail-safe. The seeded list is Home + the five buttons the Dashboard has hard-coded today, in their current order:
--   dashboard, meta, embed, p2p, automation, appearance.
-- get_my_dashboard_shortcuts() returns that default whenever the stored value is missing or is not valid under rules 2-5 (for example a
-- row deleted by hand, a wrong type written through the generic admin_set_config(), or a page removed from page_flags later). It never
-- raises because of a bad stored value. A client that gets NO answer (offline, a server without 0015) keeps its built-in buttons: that is
-- the client's job and is not changed in this step.
--
-- Not changed: admin_set_config() / admin_get_config() (admin_get_config will list the new key like every other app_config row;
-- admin_set_config can only store a NUMBER under it, which the reader above treats as invalid and ignores), get_my_pages(), page_flags,
-- _page_enabled(), _audit(), migrations 0001-0014.

-- ====================================================================== A. the stored list
insert into public.app_config(key, value) values
  ('dashboard_shortcuts', '["dashboard","meta","embed","p2p","automation","appearance"]'::jsonb)
on conflict (key) do nothing;                                   -- never overwrites a list an admin already chose

-- ====================================================================== B. validation (one place)
-- Returns NULL when the list is acceptable, otherwise the refusal text.
create or replace function public._dashboard_shortcuts_problem(p_keys text[]) returns text
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare k text;
begin
  if p_keys is null then return 'the shortcut list is required'; end if;
  if cardinality(p_keys) > 9 then return 'at most 9 shortcuts are allowed'; end if;
  if exists (select 1 from unnest(p_keys) e where e is null) then return 'a shortcut key cannot be empty'; end if;
  select e into k from unnest(p_keys) e group by e having count(*) > 1 limit 1;
  if found then return format('duplicate shortcut: %s', k); end if;
  select e into k from unnest(p_keys) e
   where not exists (select 1 from public.page_flags f where f.page_key = e and f.kind = 'page' and f.page_key <> 'settings') limit 1;
  if found then return format('unknown or unsupported page: %s', k); end if;
  if not ('dashboard' = any (p_keys)) then return 'Home (dashboard) must always be one of the shortcuts'; end if;
  if not ('appearance' = any (p_keys)) then return 'Settings (appearance) must always be one of the shortcuts'; end if;
  return null;
end $$;

-- ====================================================================== C. read (apps and the Admin panel)
create or replace function public.get_my_dashboard_shortcuts() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v jsonb; keys text[];
begin
  perform public._require_user();
  select c.value into v from public.app_config c where c.key = 'dashboard_shortcuts';
  if v is not null and jsonb_typeof(v) = 'array'
     and not exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
    select coalesce(array_agg(t.e #>> '{}' order by t.n), '{}'::text[]) into keys from jsonb_array_elements(v) with ordinality t(e, n);
    if public._dashboard_shortcuts_problem(keys) is null then
      return jsonb_build_object('shortcuts', to_jsonb(keys));
    end if;
  end if;
  return jsonb_build_object('shortcuts', '["dashboard","meta","embed","p2p","automation","appearance"]'::jsonb);   -- same as the seed in section A
end $$;

-- ====================================================================== D. write (admins only)
create or replace function public.admin_set_dashboard_shortcuts(p_keys text[]) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare problem text; prev_value jsonb;
begin
  perform public._require_admin();
  problem := public._dashboard_shortcuts_problem(p_keys);
  if problem is not null then raise exception '%', problem using errcode = '22023'; end if;
  select c.value into prev_value from public.app_config c where c.key = 'dashboard_shortcuts';
  insert into public.app_config(key, value) values ('dashboard_shortcuts', to_jsonb(p_keys))
  on conflict (key) do update set value = excluded.value, updated_at = now();
  perform public._audit('dashboard_shortcuts_set', 'dashboard_shortcuts',
                        jsonb_build_object('shortcuts', to_jsonb(p_keys), 'previous', prev_value));     -- page keys only, never secrets
  return jsonb_build_object('shortcuts', to_jsonb(p_keys));
end $$;

-- ====================================================================== privileges (same posture as 0006 / 0014)
revoke all on function public._dashboard_shortcuts_problem(text[])   from public, anon, authenticated;     -- internal: no grant
revoke all on function public.get_my_dashboard_shortcuts()           from public, anon, authenticated;
revoke all on function public.admin_set_dashboard_shortcuts(text[])  from public, anon, authenticated;
grant execute on function public.get_my_dashboard_shortcuts()          to authenticated;
grant execute on function public.admin_set_dashboard_shortcuts(text[]) to authenticated;
