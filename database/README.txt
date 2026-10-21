Run these SQL files in the Supabase SQL Editor in order: 0001 ... 0008, then 0010 (v0.9.9.9: Converter + EPS 10 page switches) -- once each (0008 = v0.9.9.5.2: nickname, delete user/version, AI access, Tracker search counts).
They are identical to supabase/migrations/ in the main MetaZone project.
Then 0011 (per-plan page access) and 0012 (v0.9.9.10: add-ons -- page_flags.kind, addon_releases, addon_catalog, Storage bucket 'addons' + policies, admin publish/yank). 0012 skips the Storage part automatically if the storage schema is missing.
Then 0013 (Task 2: protected pages, global-OFF-beats-per-user precedence, admin-selected active add-on version, control audit log). Run it AFTER 0012; it is safe to re-run.
