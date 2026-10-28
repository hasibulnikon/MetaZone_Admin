-- 0019 (Step 22D; app version stays v1.0.0): retire the Adobe Tracker database objects. Run AFTER 0001..0018.
-- It never edits an earlier migration (0006-0008, 0011-0013 stay exactly as released).
--
-- WHY.  The Adobe Tracker add-on package was removed from the Main App in Step 22C, its Admin panels were removed in Step 22A, and the
-- Main App no longer calls anything Tracker-specific (Step 22B/22C). What is left on the server is only the database side:
--     table    public.tracker_search_events            created by 0008 (one row per Tracker search)
--     function public.record_tracker_search(text)      created by 0008 (the only writer of that table)
--     function public.admin_tracker_search_stats()     created by 0008 (the only Admin reader of that table)
--     function public.admin_list_users(...)            0008 version also reads the table (columns tracker_searches / tracker_searches_today)
--     page_flags row 'tracker' (+ user_page_overrides) created by 0006; it was the add-on's feature switch (0012 maps adobe_tracker -> 'tracker')
--
-- WHAT THIS FILE DOES (one transaction, all or nothing)
--   A. Safety stops (nothing is changed if one fires):
--        * 0018 has not been applied (public.retired_page_keys is missing);
--        * any addon_releases row still belongs to the 'adobe_tracker' add-on or still uses the feature key 'tracker'
--          (a published release is never deleted by accident; an installed Tracker 1.0.x needs record_tracker_search).
--   B. Replaces admin_list_users(text, integer, integer): identical to the 0008 version, minus the two tracker_* columns
--      (same signature and return type, so grants are kept; the Admin from Step 22A on ignores those fields anyway).
--   C. Drops admin_tracker_search_stats(), record_tracker_search(text) and the table tracker_search_events (its indexes and its id sequence go with it).
--      >>> THE TRACKER SEARCH HISTORY IS DELETED. Take a database backup first if it matters. <<<
--   D. Removes the page switch 'tracker': its user_page_overrides rows, then its page_flags row; prunes 'tracker' from a saved Dashboard
--      shortcut list (same rule as 0018); adds 'tracker' to public.retired_page_keys so the 0018 BEFORE INSERT guard keeps it from coming back.
--
-- WHAT IT DOES NOT TOUCH: reserve_generations (its page-check list still contains the token 'tracker'; with no 'tracker' row the page check
-- passes, and nothing calls that kind any more), addons / addon_releases / addon_release_tombstones / addon_active_release (a leftover
-- 'adobe_tracker' registry row, tombstone or 'withdrawn' marker stays; remove the registry row in Admin -> Add-ons if you want it gone),
-- admin_overview, admin_delete_user, every other page_flags row, the Storage bucket, any other table or function.
--
-- ORDER OF OPERATIONS FOR THE OWNER (outside this file): host the Admin from Step 22A or later BEFORE running this file. An older Admin
-- calls admin_tracker_search_stats() on its Overview page and would show an error there once the function is gone.
-- Idempotent: running it again changes nothing.

begin;

-- ====================================================================== A. safety stops
do $$
declare n integer;
begin
  if to_regclass('public.retired_page_keys') is null then
    raise exception '0019 stopped: migration 0018 has not been applied (public.retired_page_keys is missing). Nothing was changed. Run 0018 first.'
      using errcode = '55000';
  end if;
  select count(*) into n from public.addon_releases r
   where r.addon_id = 'adobe_tracker' or r.feature_key = 'tracker';
  if n > 0 then
    raise exception '0019 stopped: % add-on release row(s) still belong to adobe_tracker or use the feature key tracker. Nothing was changed. Delete those releases in Admin first, then run this file again.', n
      using errcode = '23503';
  end if;
end $$;

-- ====================================================================== B. admin_list_users without the tracker columns
create or replace function public.admin_list_users(p_search text default null, p_limit integer default 50,
                                        p_offset integer default 0) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare res jsonb; t date := public.mz_today(); ws date := public.mz_week_start(); ms date := public.mz_month_start();
begin
  perform public._require_admin();
  select coalesce(jsonb_agg(row_to_json(q)::jsonb order by q.created_at desc), '[]'::jsonb) into res from (
    select p.id, p.nickname, p.email, p.status, p.created_at, p.last_seen_at, p.app_version,
           case when s.expires_at > now() then 'premium' else 'free' end as plan,
           s.started_at as premium_started_at, s.expires_at as premium_expires_at,
           coalesce(sum(u.ok) filter (where u.day = t), 0)  as today,
           coalesce(sum(u.ok) filter (where u.day >= ws), 0) as week,
           coalesce(sum(u.ok) filter (where u.day >= ms), 0) as month,
           coalesce(sum(u.ok), 0) as total,
           exists (select 1 from public.admin_users a where a.user_id = p.id) as is_admin
      from public.profiles p
      left join public.subscriptions s on s.user_id = p.id
      left join public.usage_daily u on u.user_id = p.id
     where p_search is null or p.email ilike '%' || p_search || '%' or p.nickname ilike '%' || p_search || '%' or p.id::text = p_search
     group by p.id, s.user_id
     order by p.created_at desc
     limit least(greatest(p_limit, 1), 200) offset greatest(p_offset, 0)) q;
  return res;
end $$;

-- ====================================================================== C. drop the Tracker search objects
drop function if exists public.admin_tracker_search_stats();
drop function if exists public.record_tracker_search(text);
drop table if exists public.tracker_search_events;

-- ====================================================================== D. remove the 'tracker' page switch
insert into public.retired_page_keys(page_key, reason) values
  ('tracker', 'Adobe Tracker add-on removed in v1.0.0; its page switch was created by 0006 and mapped to the add-on by 0012')
on conflict (page_key) do nothing;

delete from public.user_page_overrides where page_key = 'tracker';
delete from public.page_flags where page_key = 'tracker';

-- A stored Dashboard shortcut list must not keep a retired key (same rule and statement shape as 0018).
update public.app_config
   set value = coalesce(
         (select jsonb_agg(to_jsonb(t.e) order by t.ord)
            from jsonb_array_elements_text(public.app_config.value) with ordinality as t(e, ord)
           where t.e not in (select k.page_key from public.retired_page_keys k)),
         '[]'::jsonb)
 where key = 'dashboard_shortcuts'
   and case when jsonb_typeof(value) = 'array'            -- CASE, not AND: Postgres does not promise to test the type first
            then exists (select 1 from jsonb_array_elements_text(public.app_config.value) as x(e)
                          where x.e in (select k.page_key from public.retired_page_keys k))
            else false end;

commit;
