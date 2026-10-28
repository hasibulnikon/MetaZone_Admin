-- 0018 (Step 21; app version stays v1.0.0): retire the Admin entries of the removed Converter and of the retired Advanced Embedder
-- add-ons. Run AFTER 0001..0017. It never edits an earlier migration (0010 and 0012 stay exactly as they were released).
--
-- WHY.  MetaZone v1.0.0 no longer ships a Converter page, the two File Converter add-ons or the two Advanced Embedder add-ons
-- (the embedder is built into the Core 'embed' page). Their switches are still created by older migrations and therefore still show
-- up in Admin -> Pages / Add-ons:
--     converter        page row            created by 0010 (kind 'page')
--     converter_image  feature switch      created by 0012 (kind 'addon')
--     converter_video  feature switch      created by 0012 (kind 'addon')
--     embed_vector     feature switch      created by 0012 (kind 'addon')   (Advanced Embedder - Vector)
--     embed_video      feature switch      created by 0012 (kind 'addon')   (Advanced Embedder - Video)
--
-- WHAT THIS FILE DOES
--   A. public.retired_page_keys: a tiny table that lists the five keys (no client access, like every other table).
--   B. Safety stop: if any addon_releases row still uses one of the five keys, the migration STOPS with a clear message and changes
--      nothing (a published release is never deleted by accident). The live check before this step found no such row.
--   C. Removes the five rows from page_flags. user_page_overrides rows for them go with them (they only point at those rows).
--      A saved Dashboard shortcut list (app_config 'dashboard_shortcuts') loses the retired keys, if it holds any, and keeps its order.
--   D. A BEFORE INSERT trigger on page_flags that silently skips an insert of a retired key. So a fresh database that replays
--      0001..0018 ends without the five rows, and re-running 0010 or 0012 by hand later does NOT bring them back (both files stay
--      "idempotent / safe to re-run"; their insert is simply ignored for these keys).
--
-- WHAT IT DOES NOT TOUCH: the Core pages 'embed' and 'tracker' (and every other page_flags row), addon_releases, addon_release_tombstones,
-- addon_active_release, any function, the Storage bucket. The 'adobe_tracker' add-on keeps its 'tracker' switch.
-- Idempotent: running it again changes nothing.
--
-- Note on a fresh replay: 0010 and 0012 still INSERT the five rows when they run, and this file then removes them; the end state of
-- 0001..0018 is what counts, and it has none of the five rows.

begin;

-- ====================================================================== A. the list of retired keys
create table if not exists public.retired_page_keys (
  page_key   text primary key check (page_key ~ '^[a-z0-9_]{1,32}$'),
  reason     text not null,
  retired_at timestamptz not null default now()
);
alter table public.retired_page_keys enable row level security;
revoke all on public.retired_page_keys from public, anon, authenticated;

insert into public.retired_page_keys(page_key, reason) values
  ('converter',       'Converter page removed in v1.0.0 (created by 0010)'),
  ('converter_image', 'File Converter - Image add-on removed in v1.0.0 (created by 0012)'),
  ('converter_video', 'File Converter - Video add-on removed in v1.0.0 (created by 0012)'),
  ('embed_vector',    'Advanced Embedder - Vector add-on retired in v1.0.0; vector embedding is in the Core embed page (created by 0012)'),
  ('embed_video',     'Advanced Embedder - Video add-on retired in v1.0.0; video embedding is in the Core embed page (created by 0012)')
on conflict (page_key) do nothing;

-- ====================================================================== B. safety stop
do $$
declare n integer;
begin
  select count(*) into n from public.addon_releases r
   where r.feature_key in (select k.page_key from public.retired_page_keys k);
  if n > 0 then
    raise exception '0018 stopped: % add-on release row(s) still use a retired feature key (converter_image, converter_video, embed_vector or embed_video). Nothing was changed. Delete those releases in Admin first, then run this file again.', n
      using errcode = '23503';
  end if;
end $$;

-- ====================================================================== C. remove the rows
delete from public.user_page_overrides
 where page_key in (select k.page_key from public.retired_page_keys k);

delete from public.page_flags
 where page_key in (select k.page_key from public.retired_page_keys k);

-- A stored Dashboard shortcut list must not keep a retired key (the reader would otherwise fall back to its default list).
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

-- ====================================================================== D. never create them again
create or replace function public._skip_retired_page_key() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if exists (select 1 from public.retired_page_keys r where r.page_key = new.page_key) then
    return null;                                    -- skip this row quietly (older, re-run migrations stay harmless)
  end if;
  return new;
end $$;

drop trigger if exists mz_skip_retired_page_key on public.page_flags;
create trigger mz_skip_retired_page_key before insert on public.page_flags
  for each row execute function public._skip_retired_page_key();

revoke all on function public._skip_retired_page_key() from public, anon, authenticated;

commit;
