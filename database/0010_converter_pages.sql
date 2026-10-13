-- 0010 (v0.9.9.9): Admin -> Pages switches for the two new pages, Converter and EPS 10.
-- Safe and additive: two new page_flags rows, nothing else changes. Idempotent (re-running is harmless).
-- Both pages are ON for everyone by default; switch them off globally or per user from Admin -> Pages as usual.
-- Neither page spends AI quota, so reserve_generations() is untouched.
insert into public.page_flags(page_key, label, enabled, locked, sort_order) values
  ('converter', 'Converter', true, false, 72),
  ('eps10',     'EPS 10',    true, false, 74)
on conflict (page_key) do nothing;
