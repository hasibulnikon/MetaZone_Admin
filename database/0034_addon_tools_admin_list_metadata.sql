-- 0034 (v1.0.0, 9th Edition, Addon Tools Part 9): ADMIN LIST SHOWS RELEASE METADATA. Run AFTER 0033. Forward-only, idempotent, ONE transaction.
-- NOT applied to any database yet and NOT executed against any PostgreSQL. The identical file lives in MetaZone_App/supabase/migrations/ and MetaZone_Admin/database/.
--
-- Replaces ONE function, admin_addon_tools_list() (same signature, same admin guard, same return shape): each entry of a tool's "releases" array
-- now also carries category, tags and icon, read from the addon_tools_releases columns that 0033 fills from the SIGNED manifest ('' / [] / ''
-- for releases without them). Everything else in the answer is exactly as in 0032. No table, column, policy, grant or other function changes;
-- the Admin screen only ever DISPLAYS these values (they cannot be edited anywhere).

begin;

do $$ begin
  if to_regprocedure('public.admin_addon_tools_list()') is null or not exists (
       select 1 from information_schema.columns where table_schema = 'public' and table_name = 'addon_tools_releases' and column_name = 'category') then
    raise exception '0034 needs 0033 (Addon Tools catalog metadata): run the earlier migrations first';
  end if;
end $$;

create or replace function public.admin_addon_tools_list() returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  perform public._require_admin();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'tool_id', c.tool_id, 'name', c.name, 'description', c.description, 'author', c.author,
      'published', c.published, 'enabled', c.enabled, 'access_free', c.access_free, 'access_premium', c.access_premium,
      'current_release_id', c.current_release_id, 'previous_release_id', c.previous_release_id,
      'current_version', (select x.version from public.addon_tools_releases x where x.release_id = c.current_release_id),
      'previous_version', (select x.version from public.addon_tools_releases x where x.release_id = c.previous_release_id),
      'rollback', case when c.rollback_from_release_id is null then null else jsonb_build_object(
          'from_version', (select x.version from public.addon_tools_releases x where x.release_id = c.rollback_from_release_id),
          'reason', c.rollback_reason, 'at', c.rollback_at, 'by', c.rollback_by) end,
      'force_update_below', c.force_update_below, 'force_update_reason', c.force_update_reason, 'force_update_at', c.force_update_at,
      'revision', c.revision, 'created_at', c.created_at, 'updated_at', c.updated_at,
      'releases', coalesce((select jsonb_agg(jsonb_build_object(
            'release_id', r.release_id, 'version', r.version, 'seq', r.seq, 'zip_sha256', r.zip_sha256, 'zip_size', r.zip_size,
            'storage_path', r.storage_path, 'key_id', r.key_id, 'min_app_version', r.min_app_version, 'permissions', r.permissions,
            'file_count', r.file_count, 'notes', r.notes,
            'category', coalesce(r.category, ''), 'tags', r.tags, 'icon', coalesce(r.icon, ''), 'revoked', r.revoked, 'revoked_reason', r.revoked_reason, 'revoked_at', r.revoked_at,
            'created_at', r.created_at, 'is_current', (r.release_id = c.current_release_id)) order by r.seq desc)
          from public.addon_tools_releases r where r.tool_id = c.tool_id), '[]'::jsonb),
      'user_access', coalesce((select jsonb_agg(jsonb_build_object(
            'user_id', u.user_id, 'email', p.email, 'allowed', u.allowed, 'updated_at', u.updated_at) order by p.email)
          from public.addon_tools_user_access u join public.profiles p on p.id = u.user_id where u.tool_id = c.tool_id), '[]'::jsonb))
      order by c.tool_id)
      from public.addon_tools_catalog c), '[]'::jsonb);
end $$;

revoke all on function public.admin_addon_tools_list() from public, anon, authenticated;
grant execute on function public.admin_addon_tools_list() to authenticated;            -- as in 0032: refuses non-admins inside (_require_admin)

commit;
