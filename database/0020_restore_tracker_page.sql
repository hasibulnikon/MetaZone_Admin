-- 0020 (app version stays v1.0.0): restore the built-in "Tracker" page switch. Run AFTER 0001..0019. Forward-only, idempotent, one transaction.
--
-- WHY.  Adobe Tracker is a BUILT-IN page of the Main App again (restored from v0.9.9.8; it is NOT an add-on). Migration 0019 had retired its
-- server-side objects when the Tracker add-on package was removed:
--     * page_flags row 'tracker' (and its user_page_overrides) were deleted;
--     * 'tracker' was added to public.retired_page_keys, and the 0018 BEFORE INSERT trigger mz_skip_retired_page_key therefore silently
--       skips any insert of that key.
-- So without this file the Admin panel (Pages) cannot list Tracker, nobody can switch it on or off, and the app's page map has no 'tracker'
-- entry (the app then fails open: the page would be ON for everybody and could not be controlled).
--
-- WHAT THIS FILE DOES
--   A. Safety stops (nothing is changed if one fires): 0018 / 0019 not applied (public.retired_page_keys missing), or page_flags is missing a
--      column this file writes (kind 0012, enabled_free / enabled_premium 0011, nav_visible 0016).
--   B. Takes 'tracker' off public.retired_page_keys. This is the ONLY change to that table: the five keys of 0018 (converter,
--      converter_image, converter_video, embed_vector, embed_video) stay retired, and the guard trigger stays in place for them.
--   C. Registers the page switch exactly like every other built-in page row (same table, same columns, same triggers):
--          page_key 'tracker', label 'Tracker', kind 'page', enabled = true (master switch ON), enabled_free = false, enabled_premium = true,
--          locked = false, sort_order = 70, nav_visible = true.
--      These are the values Tracker had before it was retired (0006 created it ON; 0011 turned it OFF for the Free plan and left it ON for
--      Premium). Nothing else is invented. An existing row (for example one the owner added by hand) is NEVER touched (ON CONFLICT DO NOTHING).
--   D. Writes one control_audit line, only when the row was really inserted.
--
-- WHAT THIS FILE DOES NOT DO
--   * It does not recreate record_tracker_search(text), admin_tracker_search_stats(), the table tracker_search_events or the tracker_* columns of
--     admin_list_users(). The Admin-side Tracker search count stays retired; the app counts searches locally. Historical rows of
--     tracker_search_events were deleted by 0019 and cannot be recovered from the supplied files.
--   * It does not recreate the old per-user overrides for 'tracker' (deleted by 0019; unrecoverable). Per-user exceptions can be set again in
--     Admin -> Users -> Pages.
--   * It does not touch addons / addon_releases / addon_active_release / addon_release_tombstones, reserve_generations (its page-check list still
--     contains the token 'tracker', so the Admin switch also stops Tracker's Image-to-Prompt generations again), the Dashboard shortcut list
--     (app_config 'dashboard_shortcuts'), any function, any trigger, any grant, or any other page_flags row. Home / Settings protection
--     (0013 triggers) is unchanged.
--
-- BEHAVIOUR AFTER THIS FILE
--   Admin -> Pages lists Tracker (kind 'page'): Everyone ON, Free OFF, Premium ON. The Admin can switch it with the existing controls (Everyone /
--   Free / Premium) and per user (Users -> Pages). Rules are the existing ones (0013): master switch OFF = off for everybody; otherwise a per-user
--   override beats the plan switch. The app hides the page and refuses its backend calls while it is off for that account.
--   To make Tracker available to ALL plans or to nobody, use the Admin controls afterwards; this file only restores the previous default.
--
-- DO NOT RE-RUN 0019 AFTER THIS FILE. 0019 deletes the 'tracker' page row and puts the key back on retired_page_keys. (0019 is idempotent for
-- a database that never ran 0020; it is not written to coexist with it.) 0001..0020 in order produce the intended end state; re-running 0006 / 0011 is
-- harmless (their Tracker statements are idempotent and 0006 is not re-runnable anyway).
-- Idempotent: running this file again changes nothing.

begin;

-- ====================================================================== A. safety stops
do $$
declare missing text;
begin
  if to_regclass('public.retired_page_keys') is null then
    raise exception '0020 stopped: migrations 0018 / 0019 have not been applied (public.retired_page_keys is missing). Nothing was changed. Run 0001..0019 first.'
      using errcode = '55000';
  end if;
  select string_agg(c.col, ', ') into missing
    from (values ('kind'), ('enabled_free'), ('enabled_premium'), ('nav_visible'), ('locked'), ('sort_order'), ('label')) as c(col)
   where not exists (select 1 from information_schema.columns k
                      where k.table_schema = 'public' and k.table_name = 'page_flags' and k.column_name = c.col);
  if missing is not null then
    raise exception '0020 stopped: public.page_flags is missing column(s): %. Nothing was changed. Run 0011, 0012 and 0016 first.', missing
      using errcode = '55000';
  end if;
end $$;

-- ====================================================================== B. 'tracker' is a built-in page again
delete from public.retired_page_keys where page_key = 'tracker';

-- ====================================================================== C. + D. register the page switch (and audit it once)
with ins as (
  insert into public.page_flags(page_key, label, enabled, enabled_free, enabled_premium, locked, sort_order, kind, nav_visible)
  values ('tracker', 'Tracker', true, false, true, false, 70, 'page', true)
  on conflict (page_key) do nothing
  returning page_key
)
select public._audit('page_restore', ins.page_key,
                     jsonb_build_object('migration', '0020', 'enabled', true, 'enabled_free', false, 'enabled_premium', true))
  from ins;

commit;
