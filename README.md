# MetaZone Admin  (v0.9.9.2)

Your control panel: users, Premium activation, **limits & offers per plan**, unlimited-Free bonus, payment info,
notices, app version. A static site (no server of its own): it talks to your Supabase project, and **every
action is a database function that only works for accounts listed in `admin_users`** -- hiding a button is
cosmetic, the server refuses everyone else (tested). No secret key is used or needed.

## One-time setup
1. Supabase SQL Editor: run the SQL files `0001…` through `0004…` **in that order, once each** (folder `database/` in this download; it is `supabase/migrations/` in the main MetaZone project).
2. Supabase → Authentication → URL Configuration → Redirect URLs: add
   `http://localhost:5173/`   (and, if you host the site, its exact URL, e.g. `https://hasibulnikon.github.io/metazone-releases/admin/`).
3. Make yourself an admin (SQL Editor; sign in to the admin site once first so your account exists):
   ```sql
   insert into public.admin_users(user_id) select id from auth.users where email = 'YOUR_GMAIL@gmail.com';
   ```

## Run it
* On your PC: double-click `run_admin.bat`, then use the page that opens (`http://localhost:5173/`).
* Or host the `MetaZone_admin` folder on GitHub Pages (public repo) -- the page is public but shows nothing without an admin login.

`config.js` holds only the public Supabase URL + publishable key. `vendor/supabase.js` is supabase-js (MIT), bundled so
the site works without any CDN.

## What each page does
* **Overview** -- users (total / active now / today / free / premium / expired / suspended), generations, subscriptions, app versions.
* **Users** -- search, Activate / Extend / set expiry / Deactivate Premium, Suspend / Restore, per-user usage + history.
* **Limits & Offers** -- for Free and Premium separately: daily limit, weekly limit, API keys per provider; each one a number or *Unlimited*.
  **Bonus**: unlimited Free generations for 1/3/7/30 days or until a date -- it ends by itself. Advanced: batch size, slot hold time, online threshold.
* **Premium payment info** -- bKash number, price, contact, instructions shown in the app.
* **Notices** -- shown in the app as a right-to-left ticker under the header (each notice once per day per user, priority first).
* **App version** -- set the latest release + download link; apps on an older version show an update banner.

Apps see changed limits on their next refresh (heartbeat, a few minutes) and always at the start of a batch.
