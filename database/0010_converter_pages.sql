-- 0010 (v0.9.9.9): Admin -> Pages switch for the new Converter page.
-- Safe and additive: one new page_flags row, nothing else changes. Idempotent (re-running is harmless).
-- The page is ON for everyone by default; switch it off globally or per user from Admin -> Pages as usual.
-- It spends no AI quota, so reserve_generations() is untouched.
insert into public.page_flags(page_key, label, enabled, locked, sort_order) values
  ('converter', 'Converter', true, false, 72)
on conflict (page_key) do nothing;
