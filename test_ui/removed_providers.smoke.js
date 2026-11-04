// v1.0.0 (7th Edition, Part 2) browser smoke test: the REAL admin.js renders API Configuration against a STUBBED Supabase client whose in-page fake mimics the
// archive semantics of migration 0026 (archive in place, restore in place). It proves the PAGE behaves correctly: Remove asks first and archives (never a delete RPC),
// the item leaves the active table and appears in "Removed Providers & Models", Restore asks first, restoring a model leaves its provider alone, restoring a provider brings its
// models back, a removed key cannot be re-added, errors leave the page unchanged, and without 0026 the Remove buttons are off. It does NOT test SQL / RLS / a live project.
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/removed_providers.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const STUB = `
window.__calls = [];
const M = (id, label, enabled, o) => ({ id, label, enabled, sort_order: o, archived: false, withProvider: false });
const S = { providers: [
  { provider: 'Gemini', title: 'Gemini', enabled: true, hidden: false, archived: false, models: [M('gemini-2.5-flash', 'Gemini 2.5 Flash', true, 10)] },
  { provider: 'Groq', title: 'Groq', enabled: false, hidden: false, archived: false, models: [M('qwen/qwen3.6-27b', 'Qwen 3.6 27B', true, 10), M('openai/gpt-oss-120b', 'GPT OSS 120B', false, 20)] },
  { provider: 'OpenAI', title: 'OpenAI', enabled: true, hidden: false, archived: false, models: [M('gpt-4o', 'GPT-4o', true, 10), M('gpt-4o-mini', 'GPT-4o Mini', true, 20)] }] };
const base = (p) => ({ provider: p.provider, title: p.title, enabled: p.enabled, hidden: p.hidden, vision: true, key_url: '', key_hint: '', validate: '', adapter: 'builtin', sort_order: 10, failover_order: 10, package: null, packages: [],
  models: p.models.filter((m) => !m.archived).map((m) => ({ id: m.id, label: m.label, enabled: m.enabled, sort_order: m.sort_order })) });
const catalog = () => S.providers.filter((p) => !p.archived).map(base);
const removedJson = () => ({ providers: S.providers.filter((p) => p.archived).map((p) => ({ provider: p.provider, title: p.title, enabled: p.enabled, hidden: p.hidden, adapter: 'builtin', archived_at: '2026-11-02T08:00:00Z',
    models: p.models.map((m) => ({ id: m.id, label: m.label, enabled: m.enabled, archived_with_provider: m.withProvider, archived_at: '2026-11-02T08:00:00Z' })), package_count: 0, has_published_package: false })),
  models: S.providers.flatMap((p) => p.models.filter((m) => m.archived && !m.withProvider).map((m) => ({ provider: p.provider, provider_title: p.title, provider_archived: p.archived, id: m.id, label: m.label, enabled: m.enabled, sort_order: m.sort_order, archived_at: '2026-11-02T08:00:00Z' }))) });
const out = (x) => Object.assign(x, { catalog: catalog(), removed: removedJson() });
const prov = (k) => { const p = S.providers.find((x) => x.provider === k); if (!p) throw new Error('unknown_provider'); return p; };
const mod = (k, id) => { const m = prov(k).models.find((x) => x.id === id); if (!m) throw new Error('unknown_model'); return m; };
const H = {
  admin_overview: () => ({}), admin_list_addon_releases: () => [], admin_list_pages: () => [], admin_get_addon_selection: () => [], admin_list_addons: () => [], admin_list_ai_force_updates: () => [],
  admin_list_ai_catalog: () => catalog(),
  admin_list_removed_ai_catalog: () => { if (window.__STUB__.no0026) throw new Error('Could not find the function public.admin_list_removed_ai_catalog'); return removedJson(); },
  admin_archive_ai_provider: (a) => { if (window.__STUB__.denied) throw new Error('forbidden'); const p = prov(a.p_key); if (p.archived) return out({ already_archived: true });
    p.archived = true; p.models.forEach((m) => { if (!m.archived) { m.archived = true; m.withProvider = true; } }); return out({ already_archived: false }); },
  admin_restore_ai_provider: (a) => { if (window.__STUB__.denied) throw new Error('forbidden'); const p = prov(a.p_key); if (!p.archived) return out({ already_active: true });
    p.archived = false; p.models.forEach((m) => { if (m.withProvider) { m.archived = false; m.withProvider = false; } }); return out({ already_active: false }); },
  admin_archive_ai_model: (a) => { if (window.__STUB__.denied) throw new Error('forbidden'); const m = mod(a.p_provider, a.p_model); if (m.archived) return out({ already_archived: true }); m.archived = true; m.withProvider = false; return out({ already_archived: false }); },
  admin_restore_ai_model: (a) => { const p = prov(a.p_provider), m = mod(a.p_provider, a.p_model); if (!m.archived) return out({ already_active: true });
    if (p.archived) throw new Error('parent_provider_archived: restore provider ' + p.provider + ' first'); m.archived = false; return out({ already_active: false }); },
  admin_upsert_ai_provider: (a) => { const p = S.providers.find((x) => x.provider === a.p_key); if (p && p.archived) throw new Error('provider_is_archived: restore it'); throw new Error('stub: upsert not expected'); },
};
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push({ name, params }); const f = H[name]; if (!f) return { data: null, error: { message: 'stub: no handler for ' + name } };
    try { return { data: JSON.parse(JSON.stringify(f(params || {}))), error: null }; } catch (e) { return { data: null, error: { message: e.message } }; } },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'stub' } }), remove: async () => { window.__storageRemove = (window.__storageRemove || 0) + 1; return { error: null }; }, createSignedUrl: async () => ({ error: { message: 'stub' } }) }) },
}) };`;
(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(); const results = [];
  const open = async (flags) => {
    const page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, flags || {});
    await page.goto(url); await page.waitForSelector('.nav button[data-tab="ai"]'); await page.click('.nav button[data-tab="ai"]'); await page.waitForSelector('#ai-removed');
    const calls = () => page.evaluate(() => window.__calls.map((c) => c.name));
    const count = async (n) => (await calls()).filter((x) => x === n).length;
    const dlg = page.locator('.overlay[role="dialog"]');
    const confirm = async (label) => { await dlg.waitFor(); await dlg.locator('button', { hasText: label }).click(); await page.waitForTimeout(250); };
    const cancel = async () => { await dlg.waitFor(); await dlg.locator('button', { hasText: 'Cancel' }).click(); await page.waitForTimeout(100); };
    return { page, errors, calls, count, dlg, confirm, cancel };
  };
  try {
    {   // ---- main flow
      const { page, errors, calls, count, dlg, confirm, cancel } = await open();
      const active = () => page.locator('#ai-rows tr.prov').evaluateAll((t) => t.map((r) => r.dataset.provider));
      const modelsOf = (k) => page.locator(`#ai-rows tr[data-model][data-provider="${k}"]`).evaluateAll((t) => t.map((r) => r.dataset.model));
      assert.deepEqual(await active(), ['Gemini', 'Groq', 'OpenAI']); assert.match(await page.locator("#ai-removed").innerText(), /removed providers & models/i);
      assert.equal(await page.locator('#ai-rm-tab-providers').innerText(), 'Removed Providers (0)'); assert.match(await page.locator('#ai-removed-body').innerText(), /No removed providers/);
      // remove ONE model: dialog first, Cancel sends nothing
      const mrow = '#ai-rows tr[data-model="gpt-4o-mini"] button[data-act="delmodel"]';
      await page.click(mrow); assert.match(await dlg.innerText(), /Removed Providers & Models/i); assert.equal(await count('admin_archive_ai_model'), 0, 'the dialog alone sends nothing');
      await cancel(); assert.equal(await count('admin_archive_ai_model'), 0, 'Cancel sends nothing');
      await page.click(mrow); await confirm(/^Remove$/);
      assert.equal(await count('admin_archive_ai_model'), 1);
      assert.deepEqual(await modelsOf('OpenAI'), ['gpt-4o'], 'archived model left the active list'); assert.deepEqual(await active(), ['Gemini', 'Groq', 'OpenAI'], 'its provider is still active');
      assert.equal(await page.locator('#ai-rm-tab-models').innerText(), 'Removed Models (1)');
      await page.click('#ai-rm-tab-models'); assert.match(await page.locator('#ai-removed-models').innerText(), /gpt-4o-mini/); assert.match(await page.locator('#ai-removed-models').innerText(), /OpenAI/);
      // remove a PROVIDER
      await page.click('#ai-rows tr.prov[data-provider="Groq"] button[data-act="delete"]'); await cancel(); assert.equal(await count('admin_archive_ai_provider'), 0);
      await page.click('#ai-rows tr.prov[data-provider="Groq"] button[data-act="delete"]'); assert.match(await dlg.innerText(), /Nothing is deleted/); await confirm(/^Remove$/);
      assert.equal(await count('admin_archive_ai_provider'), 1); assert.deepEqual(await active(), ['Gemini', 'OpenAI']); assert.deepEqual(await modelsOf('Groq'), []);
      await page.click('#ai-rm-tab-providers'); const rp = page.locator('#ai-removed-providers tr[data-removed-provider="Groq"]');
      assert.equal(await rp.count(), 1); assert.match(await rp.innerText(), /Groq/); assert.match(await rp.innerText(), /Off/, 'original status (Groq was Off) is shown'); assert.equal((await rp.locator('td').nth(2).innerText()).trim(), '2', 'both models kept');
      // search / filter
      await page.fill('#ai-rm-search', 'zzz'); assert.match(await page.locator('#ai-removed-body').innerText(), /No removed provider matches/);
      await page.fill('#ai-rm-search', 'GRO'); assert.equal(await page.locator('#ai-removed-providers tr[data-removed-provider]').count(), 1);
      await page.fill('#ai-rm-search', '');
      // a removed key cannot be re-added silently
      await page.click('#ai-add-provider'); await page.fill('#aip-key', 'Groq'); await page.fill('#aip-title', 'Groq again'); await dlg.locator('button', { hasText: 'Save' }).click(); await page.waitForTimeout(150);
      assert.match(await page.locator('#aip-err').innerText(), /removed earlier/); assert.equal(await count('admin_upsert_ai_provider'), 0, 'refused before any call'); await cancel();
      // model restore is blocked while ITS provider is removed? (gpt-4o-mini's provider OpenAI is active -> restorable). Restore it: dialog first
      await page.click('#ai-rm-tab-models'); const btn = page.locator('#ai-removed-models tr[data-removed-model="gpt-4o-mini"] button[data-act="restore-model"]');
      await btn.click(); assert.match(await dlg.innerText(), /provider OpenAI is not changed/i); assert.equal(await count('admin_restore_ai_model'), 0); await cancel(); assert.equal(await count('admin_restore_ai_model'), 0);
      await btn.click(); await confirm(/^Restore$/); assert.equal(await count('admin_restore_ai_model'), 1);
      assert.deepEqual(await modelsOf('OpenAI'), ['gpt-4o', 'gpt-4o-mini']); assert.deepEqual(await active(), ['Gemini', 'OpenAI'], 'restoring a model did not change any provider');
      assert.match(await page.locator('#ai-removed-body').innerText(), /No removed models/);
      // restore the provider: dialog names the models that come back
      await page.click('#ai-rm-tab-providers'); await page.locator('#ai-removed-providers tr[data-removed-provider="Groq"] button[data-act="restore-provider"]').click();
      const t = await dlg.innerText(); assert.match(t, /Restore Groq\?/); assert.match(t, /qwen\/qwen3\.6-27b/); assert.match(t, /openai\/gpt-oss-120b/); await cancel(); assert.equal(await count('admin_restore_ai_provider'), 0);
      await page.locator('#ai-removed-providers tr[data-removed-provider="Groq"] button[data-act="restore-provider"]').click(); await confirm(/^Restore$/);
      assert.equal(await count('admin_restore_ai_provider'), 1); assert.deepEqual(await active(), ['Gemini', 'Groq', 'OpenAI']);
      assert.deepEqual(await modelsOf('Groq'), ['qwen/qwen3.6-27b', 'openai/gpt-oss-120b'], 'both models are back, no duplicates');
      assert.match(await page.locator('#ai-rows tr[data-model="openai/gpt-oss-120b"]').innerText(), /Off|Provider off/, 'previous Off setting kept');
      assert.equal(await page.locator('#ai-rm-tab-providers').innerText(), 'Removed Providers (0)');
      // nothing in the whole flow used a delete path or touched Storage
      const all = await calls(); assert.deepEqual(all.filter((n) => /delete/i.test(n)), [], 'no delete RPC was called'); assert.equal(await page.evaluate(() => window.__storageRemove || 0), 0, 'no Storage file was removed');
      assert.deepEqual(errors, [], 'no page errors'); results.push('main flow'); await page.close();
    }
    {   // ---- a model whose provider is removed cannot be restored on its own
      const { page, errors, count } = await open();
      await page.click('#ai-rows tr[data-model="gpt-4o"] button[data-act="delmodel"]'); await page.locator('.overlay button', { hasText: /^Remove$/ }).click(); await page.waitForTimeout(200);
      await page.click('#ai-rows tr.prov[data-provider="OpenAI"] button[data-act="delete"]'); await page.locator('.overlay button', { hasText: /^Remove$/ }).click(); await page.waitForTimeout(200);
      await page.click('#ai-rm-tab-models'); const b = page.locator('#ai-removed-models tr[data-removed-model="gpt-4o"] button[data-act="restore-model"]');
      assert.equal(await b.isDisabled(), true); assert.match(await page.locator('#ai-removed-models').innerText(), /Provider removed/);
      assert.match((await b.getAttribute('title')) || '', /Restore provider OpenAI first/); assert.equal(await count('admin_restore_ai_model'), 0);
      // restoring the provider brings back gpt-4o-mini (removed with it) but NOT gpt-4o (removed on its own)
      await page.click('#ai-rm-tab-providers'); await page.locator('#ai-removed-providers tr[data-removed-provider="OpenAI"] button[data-act="restore-provider"]').click(); await page.locator('.overlay button', { hasText: /^Restore$/ }).click(); await page.waitForTimeout(250);
      assert.deepEqual(await page.locator('#ai-rows tr[data-model][data-provider="OpenAI"]').evaluateAll((t) => t.map((r) => r.dataset.model)), ['gpt-4o-mini']);
      await page.click('#ai-rm-tab-models'); assert.equal(await page.locator('#ai-removed-models tr[data-removed-model="gpt-4o"] button[data-act="restore-model"]').isDisabled(), false);
      assert.deepEqual(errors, []); results.push('model under removed provider'); await page.close();
    }
    {   // ---- server refuses (not an admin): nothing changes, error is shown
      const { page, errors } = await open({ denied: true });
      await page.click('#ai-rows tr.prov[data-provider="Groq"] button[data-act="delete"]'); await page.locator('.overlay button', { hasText: /^Remove$/ }).click(); await page.waitForSelector('.toast.err');
      assert.match(await page.locator('.toast.err').innerText(), /forbidden/); assert.equal(await page.locator('#ai-rows tr.prov').count(), 3, 'unchanged after refusal');
      assert.equal(await page.locator('#ai-rm-tab-providers').innerText(), 'Removed Providers (0)'); assert.deepEqual(errors, []); results.push('denied'); await page.close();
    }
    {   // ---- migration 0026 not applied yet: Remove is switched off, nothing can be deleted
      const { page, errors, calls } = await open({ no0026: true });
      assert.equal(await page.locator('#ai-rm-needs-0026').count(), 1);
      for (const sel of ['#ai-rows tr.prov[data-provider="Groq"] button[data-act="delete"]', '#ai-rows tr[data-model="gpt-4o"] button[data-act="delmodel"]']) assert.equal(await page.locator(sel).isDisabled(), true);
      assert.deepEqual((await calls()).filter((n) => /archive|delete|restore/i.test(n)), []); assert.deepEqual(errors, []); results.push('without 0026'); await page.close();
    }
    console.log('PASS scenarios: ' + results.join(', '));
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
