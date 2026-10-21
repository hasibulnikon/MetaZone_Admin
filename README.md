# MetaZone Admin  (v1.0.0)

Your control panel: users, Premium activation, **limits & offers per plan**, unlimited-Free bonus, payment info,
notices, app version. A static site (no server of its own): it talks to your Supabase project, and **every
action is a database function that only works for accounts listed in `admin_users`** -- hiding a button is
cosmetic, the server refuses everyone else (tested). No secret key is used or needed.

## One-time setup
1. Supabase SQL Editor: run the SQL files `0001…` through `0008…`, then `0010…`, `0011…`, `0012…` and `0013…` **in that order, once each** (0006 = page on/off switches; 0007 = Adobe Tracker joins the page switch; if you already ran 0001–0006, run only 0007 — it is optional, the app works without it) (folder `database/` in this download; it is `supabase/migrations/` in the main MetaZone project).
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
* **Pages** -- switch each app page (Meta, Image to Prompt, Embed, Prompt-to-Prompt, Batch, Tracker, API Manager) on or off for everyone. For one customer: **Users → Pages** forces a page on or off for that account only (beats the global switch), e.g. a cheaper plan without Batch, or Tracker on for you only while it is off for everyone. Home and Settings are always on.
* **Pages** (v0.9.9.10) is grouped: **Pages** and **Add-on features** (File Converter Image/Video, Advanced Embedder Vector/Video; Tracker's row also controls the Adobe Tracker add-on). Same Free / Premium / Everyone switches and per-user exceptions (Users → Pages). Free users still see locked add-ons in the app, with Download disabled.
* **Add-ons** (v0.9.9.10, needs migration 0012) -- releases table (Yank / Restore) and **Publish a new release**: pick the signed `.mzaddon` package and its `release.json` sidecar (`{addon_id, version, seq, channel, size, sha256, feature_key, title, summary, min_core, max_core, notes:{pages,problems,fixes}}`). The panel validates the sidecar, computes the package SHA-256/size in your browser and refuses a mismatch, shows the notes, uploads to the private Storage bucket `addons` with your own admin session (no service key), then calls `admin_publish_addon`. If anything fails after the upload it says so and offers Retry / Remove uploaded file. Published releases are immutable: publish a new version (higher seq) instead. Pure logic is in `addon_logic.js`; test: `node test/addon_logic.test.js`.
* **Premium payment info** -- bKash number, price, contact, instructions shown in the app.
* **Notices** -- shown in the app as a right-to-left ticker under the header (each notice once per day per user, priority first).
* **App version** -- set the latest release + download link; apps on an older version show an update banner.

Apps see changed limits on their next refresh (heartbeat, a few minutes) and always at the start of a batch.

## Updates (v0.9.9.5)
Admin → App version → **Download URL** should be a **direct https link to the installer `.exe`** (for example a GitHub
release asset). The app then downloads it inside its own window (progress + speed) and installs it with the same Inno
installer as before. If the link is a web page instead, the app notices and opens it in the browser, as in earlier versions.

## Look & feel (v0.9.9.6)
Dark, compact, one shared design system: every colour/spacing/radius is a variable at the top of `admin.css` (`:root`), and every page uses the same components (buttons, inputs, badges, tables, panels, nav, modal). Branding lives in `assets/` (`assets/README.md` lists the files to replace). This release changed presentation only: no SQL migration, no change to what any admin action does.

## Task 2 additions (needs migration 0013)

* **Pages** - Home and Settings are protected ("Always on (protected)"); the server refuses to switch them off. The "Everyone" master switch now beats a per-user ON (OFF = off for all). A "Last changed" column and a **Recent changes** list (who/what/when) were added.
* **Add-ons** - each add-on has an **active version**: the only one offered to users. Publish with "Make active after publishing" (ticked by default; the first release of an add-on is always activated automatically), **Make active** on any eligible release (older ones too = rollback), **Automatic (newest)**, and **Restore previous selection**. Yanking the active release withdraws the selection: users are offered nothing until you choose again. Restoring a yanked release never activates it.
* Pure logic: `addon_logic.js`; test: `node --test test/addon_logic.test.js`.
