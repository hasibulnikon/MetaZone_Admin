-- 0029 (v1.0.0, 7th Edition Part 8A; app version unchanged): Admin-managed API Provider Announcements. Run AFTER 0001..0026 (0027/0028 are NOT required).
-- Idempotent, one transaction. NOT applied to any database yet.
--
-- WHY.  The Admin can post a short announcement about an AI API provider (e.g. "new model available", "key page moved"). Users see the PUBLISHED ones
-- in Settings -> API -> Options -> Provider, on the card of the provider they belong to, with a NEW marker until the user reads or dismisses them.
--
-- WHAT THIS FILE ADDS
--   public.api_provider_announcements        the announcements (RLS on, no client grants, like every table).
--       provider_key -> public.ai_providers(provider_key): the STABLE provider key, never the display name. No provider name is written in code,
--                       so a provider added later can be announced with no change here or in the apps.
--       status: 'draft' (Admin only) | 'published' (shown). A new announcement is ALWAYS 'draft'; only admin_set_api_provider_announcement_status publishes.
--       image_data: optional small thumbnail stored INLINE as a data: URI (png / jpeg / webp only, <= 60000 chars). There is NO remote image URL:
--                   the app never fetches an address an admin typed, so a thumbnail cannot track users or load third-party content.
--   public.api_provider_announcement_reads   per-user state: (user_id, announcement_id) -> 'read' | 'dismissed'. RLS on, no client grants.
--   client RPCs  get_api_provider_announcements()                      -> published announcements of non-archived providers + the CALLER's own state.
--                set_api_provider_announcement_state(uuid, text)       -> the caller marks one published announcement 'read' or 'dismissed'.
--   admin RPCs   admin_list_api_provider_announcements(), admin_upsert_api_provider_announcement(...),
--                admin_set_api_provider_announcement_status(...), admin_delete_api_provider_announcement(uuid)
--                (all call _require_admin() first; every change is written to control_audit).
--
-- WHAT IT DOES NOT DO (on purpose)
--   * It does not touch ai_providers, ai_provider_models, packages, the catalogue functions, ai_access, keys or any add-on object. Deleting an
--     announcement deletes only its own row (and the per-user state rows that point at it).
--   * No API key or secret is stored here.
--   * Add-on announcements / Upcoming features / promotion are Part 8B (0024 is untouched).

begin;

do $$ begin
  if to_regclass('public.ai_providers') is null or to_regprocedure('public._require_admin()') is null
     or to_regprocedure('public._require_user()') is null or to_regprocedure('public._audit(text, text, jsonb)') is null then
    raise exception '0029 needs 0001 / 0013 / 0021 first (ai_providers, _require_admin, _require_user, _audit are missing)';
  end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'ai_providers' and column_name = 'archived_at') then
    raise exception '0029 needs 0026 first (ai_providers.archived_at is missing)';
  end if;
end $$;

create table if not exists public.api_provider_announcements (
  id           uuid primary key default gen_random_uuid(),
  provider_key text not null references public.ai_providers(provider_key) on delete cascade,
  title        text not null check (char_length(btrim(title)) between 1 and 80),
  description  text not null default '' check (char_length(description) <= 400),
  image_data   text check (image_data is null or (char_length(image_data) <= 60000 and image_data ~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$')),
  status       text not null default 'draft' check (status in ('draft', 'published')),
  created_at   timestamptz not null default now(),
  created_by   uuid,
  updated_at   timestamptz not null default now(),
  updated_by   uuid,
  published_at timestamptz
);
alter table public.api_provider_announcements enable row level security;
revoke all on public.api_provider_announcements from public, anon, authenticated;
create index if not exists api_provider_announcements_provider_idx on public.api_provider_announcements(provider_key, status);
create index if not exists api_provider_announcements_status_idx on public.api_provider_announcements(status, published_at desc);

create table if not exists public.api_provider_announcement_reads (
  user_id         uuid not null references public.profiles(id) on delete cascade,
  announcement_id uuid not null references public.api_provider_announcements(id) on delete cascade,
  state           text not null check (state in ('read', 'dismissed')),
  updated_at      timestamptz not null default now(),
  primary key (user_id, announcement_id)
);
alter table public.api_provider_announcement_reads enable row level security;
revoke all on public.api_provider_announcement_reads from public, anon, authenticated;
create index if not exists api_provider_announcement_reads_ann_idx on public.api_provider_announcement_reads(announcement_id);

-- ====================================================================== client: what users see
-- Only PUBLISHED announcements whose provider still exists and is not archived. The state is the CALLER's own (auth.uid()); null = never opened (NEW).
create or replace function public.get_api_provider_announcements() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare v_uid uuid;
begin
  v_uid := public._require_user();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', a.id, 'provider_key', a.provider_key, 'title', a.title, 'description', a.description, 'image_data', a.image_data,
             'published_at', a.published_at, 'state', r.state)
           order by a.published_at desc nulls last, a.created_at desc)
      from public.api_provider_announcements a
      join public.ai_providers p on p.provider_key = a.provider_key and p.archived_at is null
      left join public.api_provider_announcement_reads r on r.announcement_id = a.id and r.user_id = v_uid
     where a.status = 'published'), '[]'::jsonb);
end $$;

create or replace function public.set_api_provider_announcement_state(p_id uuid, p_state text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_uid uuid;
begin
  v_uid := public._require_user();
  if p_state is null or p_state not in ('read', 'dismissed') then raise exception 'state must be read or dismissed'; end if;
  if not exists (select 1 from public.api_provider_announcements a join public.ai_providers p on p.provider_key = a.provider_key and p.archived_at is null
                  where a.id = p_id and a.status = 'published') then
    raise exception 'unknown announcement';
  end if;
  -- A dismissed announcement stays dismissed: opening / marking it 'read' later never brings it back.
  insert into public.api_provider_announcement_reads(user_id, announcement_id, state) values (v_uid, p_id, p_state)
  on conflict (user_id, announcement_id) do update
     set state = case when public.api_provider_announcement_reads.state = 'dismissed' then 'dismissed' else excluded.state end, updated_at = now();
  return jsonb_build_object('id', p_id, 'state', (select r.state from public.api_provider_announcement_reads r where r.user_id = v_uid and r.announcement_id = p_id));
end $$;

-- ====================================================================== admin
create or replace function public.admin_list_api_provider_announcements() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return jsonb_build_object(
    'announcements', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'provider_key', a.provider_key, 'provider_title', p.title, 'provider_archived', (p.archived_at is not null),
               'title', a.title, 'description', a.description, 'image_data', a.image_data, 'status', a.status,
               'created_at', a.created_at, 'updated_at', a.updated_at, 'published_at', a.published_at,
               'read_count', (select count(*) from public.api_provider_announcement_reads r where r.announcement_id = a.id and r.state = 'read'),
               'dismissed_count', (select count(*) from public.api_provider_announcement_reads r where r.announcement_id = a.id and r.state = 'dismissed'))
             order by a.created_at desc)
        from public.api_provider_announcements a join public.ai_providers p on p.provider_key = a.provider_key), '[]'::jsonb),
    'providers', coalesce((
      select jsonb_agg(jsonb_build_object('provider', p.provider_key, 'title', p.title) order by p.sort_order, p.provider_key)
        from public.ai_providers p where p.archived_at is null), '[]'::jsonb));
end $$;

-- Create (p_id null) or edit. NEVER publishes: a new announcement is a draft, and an edit keeps the status it had.
create or replace function public.admin_upsert_api_provider_announcement(
  p_id uuid, p_provider_key text, p_title text, p_description text default '', p_image_data text default null,
  p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_key text := btrim(coalesce(p_provider_key, '')); v_title text := btrim(coalesce(p_title, '')); v_desc text := btrim(coalesce(p_description, ''));
        v_img text := nullif(btrim(coalesce(p_image_data, '')), ''); cur public.api_provider_announcements; a public.api_provider_announcements; pr public.ai_providers;
begin
  perform public._require_admin();
  if v_title = '' or char_length(v_title) > 80 then raise exception 'title is required (max 80 characters)'; end if;
  if char_length(v_desc) > 400 then raise exception 'description too long (max 400 characters)'; end if;
  if v_img is not null and (char_length(v_img) > 60000 or v_img !~ '^data:image/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$') then
    raise exception 'image must be a small png, jpeg or webp thumbnail (max about 45 KB)';
  end if;
  select * into pr from public.ai_providers where provider_key = v_key;
  if not found then raise exception 'unknown provider'; end if;
  if p_id is null then
    if pr.archived_at is not null then raise exception 'provider % is removed; restore it before announcing', v_key; end if;
    insert into public.api_provider_announcements(provider_key, title, description, image_data, created_by, updated_by)
    values (v_key, v_title, v_desc, v_img, auth.uid(), auth.uid()) returning * into a;
    perform public._audit('api_announcement_create', a.id::text, jsonb_build_object('provider', v_key, 'title', v_title));
  else
    select * into cur from public.api_provider_announcements where id = p_id for update;
    if not found then raise exception 'unknown announcement'; end if;
    if p_expected_updated_at is not null and p_expected_updated_at is distinct from cur.updated_at then
      raise exception 'stale: this announcement was changed by someone else. Reload the page and try again.';
    end if;
    if pr.archived_at is not null and cur.provider_key is distinct from v_key then raise exception 'provider % is removed; restore it before announcing', v_key; end if;
    update public.api_provider_announcements
       set provider_key = v_key, title = v_title, description = v_desc, image_data = v_img, updated_at = now(), updated_by = auth.uid()
     where id = p_id returning * into a;
    perform public._audit('api_announcement_edit', a.id::text, jsonb_build_object('provider', v_key, 'title', v_title));
  end if;
  return to_jsonb(a);
end $$;

create or replace function public.admin_set_api_provider_announcement_status(p_id uuid, p_status text, p_expected_updated_at timestamptz default null) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.api_provider_announcements; a public.api_provider_announcements;
begin
  perform public._require_admin();
  if p_status is null or p_status not in ('draft', 'published') then raise exception 'status must be draft or published'; end if;
  select * into cur from public.api_provider_announcements where id = p_id for update;
  if not found then raise exception 'unknown announcement'; end if;
  if p_expected_updated_at is not null and p_expected_updated_at is distinct from cur.updated_at then
    raise exception 'stale: this announcement was changed by someone else. Reload the page and try again.';
  end if;
  if p_status = 'published' and exists (select 1 from public.ai_providers p where p.provider_key = cur.provider_key and p.archived_at is not null) then
    raise exception 'provider % is removed; restore it before publishing', cur.provider_key;
  end if;
  update public.api_provider_announcements
     set status = p_status, updated_at = now(), updated_by = auth.uid(),
         published_at = case when p_status = 'published' then coalesce(published_at, now()) else published_at end
   where id = p_id returning * into a;
  perform public._audit('api_announcement_' || p_status, a.id::text, jsonb_build_object('provider', a.provider_key, 'title', a.title));
  return to_jsonb(a);
end $$;

create or replace function public.admin_delete_api_provider_announcement(p_id uuid) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare cur public.api_provider_announcements;
begin
  perform public._require_admin();
  delete from public.api_provider_announcements where id = p_id returning * into cur;     -- ONLY this table (+ its per-user state rows via cascade)
  if not found then raise exception 'unknown announcement'; end if;
  perform public._audit('api_announcement_delete', cur.id::text, jsonb_build_object('provider', cur.provider_key, 'title', cur.title, 'status', cur.status));
  return jsonb_build_object('id', cur.id, 'deleted', true);
end $$;

revoke all on function public.get_api_provider_announcements() from public, anon, authenticated;
revoke all on function public.set_api_provider_announcement_state(uuid, text) from public, anon, authenticated;
revoke all on function public.admin_list_api_provider_announcements() from public, anon, authenticated;
revoke all on function public.admin_upsert_api_provider_announcement(uuid, text, text, text, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_set_api_provider_announcement_status(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function public.admin_delete_api_provider_announcement(uuid) from public, anon, authenticated;
grant execute on function
  public.get_api_provider_announcements(),
  public.set_api_provider_announcement_state(uuid, text),
  public.admin_list_api_provider_announcements(),
  public.admin_upsert_api_provider_announcement(uuid, text, text, text, text, timestamptz),
  public.admin_set_api_provider_announcement_status(uuid, text, timestamptz),
  public.admin_delete_api_provider_announcement(uuid)
  to authenticated;

commit;
