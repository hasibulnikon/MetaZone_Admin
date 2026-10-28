-- 0016_page_registry_and_nav.sql  (Step 4.B: Admin-registered pages + left-navigation placement)   Run AFTER 0015. Safe to re-run (idempotent).
--
-- STATUS: PREPARED FOR ISOLATED TESTING ONLY. It has NOT been applied to any database (no PostgreSQL was available when it was written) and
-- has NOT been applied to production. Run it first on a throw-away database / Supabase test project with supabase/tests, then decide.
--
-- Principle: ACCESS and PLACEMENT are separate.
--   access    = page_flags.enabled / enabled_free / enabled_premium / user_page_overrides  (unchanged: 0006, 0011, 0013)
--   placement = WHERE an enabled page shows up. This file adds only the left-navigation switch (nav_visible). The Dashboard shortcut list
--               (0015) is the other placement and is unchanged.
-- Hiding a page from a place never grants or removes access. Disabling a page is still done only with admin_set_page_enabled().
--
-- What this adds:
--   A. page_flags.nav_visible boolean not null default true   (existing rows stay visible: no behaviour change on upgrade)
--   B. a guard trigger: Home / Settings (and any locked page) are always nav_visible = true
--   C. admin_register_page(p_key, p_label)      admins only: create a page switch for an add-on page WITHOUT a developer migration
--   D. admin_set_page_nav_visible(p_key, p_visible)   admins only: show / hide a page in the left navigation
--   E. admin_list_page_placement()              admins only: page_key, label, kind, enabled, nav_visible, protected, core
--   F. get_my_nav_hidden()                      any signed-in user: {"hidden": [page_key, ...]}  (the app hides these nav entries)
--
-- Registering a page (C):
--   * key must match ^[a-z0-9_]{1,32}$ (same as page_flags' own check), must NOT be a built-in Core page key
--     (dashboard, meta, prompt, embed, p2p, p2p_niche, automation, appearance, settings) and must not exist yet;
--   * the row is created kind = 'page' (like Tracker), switched OFF globally (enabled = false) so nothing reaches users until the admin
--     turns it on in Admin -> Pages; both plan switches start ON so the single global switch is what decides;
--   * a registered 'page' row is automatically valid for admin_publish_addon(feature_key) (0013) and for the Dashboard shortcut list (0015,
--     which accepts kind = 'page'); no other function is changed.
--   * there is deliberately NO delete function: removing a page switch stays a manual, reviewed SQL action.
--
-- Not changed: get_my_pages(), admin_list_pages(), admin_set_page_enabled(), _page_enabled(), reserve_generations(), the 0015 functions,
-- the add-on tables, signing / hashes / entitlement logic, migrations 0001-0015.

-- ====================================================================== A. column
alter table public.page_flags add column if not exists nav_visible boolean not null default true;

-- ====================================================================== B. guard: protected pages are always in the navigation
create or replace function public._guard_nav_visible() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if new.page_key in ('dashboard', 'appearance', 'settings') or new.locked then
    new.nav_visible := true;
  end if;
  return new;
end $$;

drop trigger if exists mz_guard_nav_visible on public.page_flags;
create trigger mz_guard_nav_visible before insert or update on public.page_flags
  for each row execute function public._guard_nav_visible();

update public.page_flags set nav_visible = true where page_key in ('dashboard', 'appearance', 'settings') or locked;

-- ====================================================================== C. register a page
create or replace function public.admin_register_page(p_key text, p_label text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare lbl text;
begin
  perform public._require_admin();
  if p_key is null or p_key !~ '^[a-z0-9_]{1,32}$' then
    raise exception 'invalid page key (a-z, 0-9, underscore, max 32)' using errcode = '22023';
  end if;
  if p_key in ('dashboard', 'meta', 'prompt', 'embed', 'p2p', 'p2p_niche', 'automation', 'appearance', 'settings') then
    raise exception 'this key belongs to a built-in page and cannot be registered' using errcode = '22023';
  end if;
  lbl := btrim(coalesce(p_label, ''));
  if lbl = '' or length(lbl) > 40 or lbl ~ '[[:cntrl:]]' then
    raise exception 'label is required (1-40 characters, no control characters)' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtext('mz_page_register:' || p_key));
  if exists (select 1 from public.page_flags where page_key = p_key) then
    raise exception 'page % is already registered', p_key using errcode = '23505';
  end if;
  insert into public.page_flags(page_key, label, enabled, enabled_free, enabled_premium, locked, sort_order, kind, nav_visible, updated_by)
  values (p_key, lbl, false, true, true, false, 100, 'page', true, auth.uid());
  perform public._audit('page_register', p_key, jsonb_build_object('label', lbl));
  return (select to_jsonb(x) from public.page_flags x where x.page_key = p_key);
end $$;

-- ====================================================================== D. left-navigation switch
create or replace function public.admin_set_page_nav_visible(p_key text, p_visible boolean) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare f public.page_flags;
begin
  perform public._require_admin();
  if p_visible is null then raise exception 'visible must be true or false' using errcode = '22023'; end if;
  select * into f from public.page_flags where page_key = p_key;
  if not found or f.page_key = 'settings' or f.kind <> 'page' then raise exception 'unknown page'; end if;
  if public._page_protected(p_key) and not p_visible then
    raise exception 'This page cannot be hidden from the navigation (Home and Settings are protected).' using errcode = '23514';
  end if;
  update public.page_flags set nav_visible = p_visible, updated_at = now(), updated_by = auth.uid() where page_key = p_key;
  perform public._audit('page_nav_visible', p_key, jsonb_build_object('nav_visible', p_visible));
  return jsonb_build_object('page_key', p_key, 'nav_visible', p_visible);
end $$;

-- ====================================================================== E. admin list (placement view)
create or replace function public.admin_list_page_placement() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object(
            'page_key', f.page_key, 'label', f.label, 'kind', f.kind, 'enabled', f.enabled, 'nav_visible', f.nav_visible,
            'protected', public._page_protected(f.page_key),
            'core', f.page_key in ('dashboard', 'meta', 'prompt', 'embed', 'p2p', 'p2p_niche', 'automation', 'appearance', 'settings'))
          order by f.sort_order, f.page_key) from public.page_flags f where f.kind = 'page' and f.page_key <> 'settings'), '[]'::jsonb);
end $$;

-- ====================================================================== F. the app's reader
create or replace function public.get_my_nav_hidden() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_user();
  return jsonb_build_object('hidden', coalesce((select jsonb_agg(f.page_key order by f.page_key) from public.page_flags f
                                               where not f.nav_visible and not public._page_protected(f.page_key)), '[]'::jsonb));
end $$;

-- ====================================================================== privileges (same posture as 0006 / 0014 / 0015)
revoke all on function public._guard_nav_visible()                       from public, anon, authenticated;
revoke all on function public.admin_register_page(text, text)            from public, anon, authenticated;
revoke all on function public.admin_set_page_nav_visible(text, boolean)  from public, anon, authenticated;
revoke all on function public.admin_list_page_placement()                from public, anon, authenticated;
revoke all on function public.get_my_nav_hidden()                        from public, anon, authenticated;
grant execute on function public.admin_register_page(text, text)           to authenticated;
grant execute on function public.admin_set_page_nav_visible(text, boolean) to authenticated;
grant execute on function public.admin_list_page_placement()               to authenticated;
grant execute on function public.get_my_nav_hidden()                       to authenticated;
