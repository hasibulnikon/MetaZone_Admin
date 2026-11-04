// v1.0.0 (7th Edition) browser smoke test: the REAL admin.js renders API Configuration against a stubbed Supabase client and the
// "Restore Default Providers" button is exercised: confirm dialog, cancel = no call, confirm = ONE admin_restore_default_ai_catalog call with no parameters,
// success summary with the counts, automatic refresh of the table from the returned catalogue, idempotent second click, error path. NOT SQL / RLS / a live project.
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/restore_default_providers.smoke.js
'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { chromium } = require('playwright');
const ROOT = path.resolve(__dirname, '..');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const STUB = `
window.__calls = [];
window.supabase = { createClient: () => ({
  auth: { onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }), getSession: async () => ({ data: { session: { user: { email: 'admin@test' } } } }), signOut: async () => ({}) },
  rpc: async (name, params) => { window.__calls.push({ name, params }); const h = window.__STUB__.rpc[name];
    if (!h) return { data: null, error: { message: 'stub: no handler for ' + name } };
    const n = window.__calls.filter((c) => c.name === name).length; const out = h.seq ? h.seq[Math.min(n, h.seq.length) - 1] : h;      // seq = the answer of the 1st, 2nd ... call (data must be JSON: it crosses addInitScript)
    if (out.error) return { data: null, error: { message: out.error } };
    return { data: out.data, error: null }; },
  storage: { from: () => ({ upload: async () => ({ error: { message: 'stub' } }), remove: async () => ({ error: { message: 'stub' } }), createSignedUrl: async () => ({ error: { message: 'stub' } }) }) },
}) };`;
const P = (key, extra) => Object.assign({ provider: key, title: key, enabled: true, hidden: false, vision: true, key_url: '', key_hint: '', validate: key.toLowerCase(), adapter: 'builtin',
  sort_order: 10, failover_order: 10, models: [{ id: key.toLowerCase() + '-m1', label: key + ' M1', enabled: true, sort_order: 10 }], package: null, packages: [] }, extra || {});
const DAMAGED = [P('Gemini'), P('Mistral'), P('Groq', { models: [{ id: 'openai/gpt-oss-120b', label: 'GPT OSS 120B', enabled: true, sort_order: 20 }] })];     // Groq kept the manually added model
const RESTORED = DAMAGED.concat(['OpenRouter', 'Cerebras', 'OpenAI', 'Claude', 'Grok'].map((k) => P(k, { hidden: k === 'Claude' || k === 'Grok' })));
const base = (restore) => ({ rpc: { admin_overview: { data: {} }, admin_list_addon_releases: { data: [] }, admin_list_pages: { data: [] }, admin_get_addon_selection: { data: [] }, admin_list_addons: { data: [] },
  admin_list_ai_catalog: { data: DAMAGED }, admin_list_ai_force_updates: { data: [] }, admin_restore_default_ai_catalog: restore } });
const SCENARIOS = {
  restore: base({ seq: [
    { data: { restored_providers: 5, restored_models: 5, providers: ['Cerebras', 'Claude', 'Grok', 'OpenAI', 'OpenRouter'], models: [{ provider: 'Claude', model: 'claude-sonnet-5' }], catalog: RESTORED } },
    { data: { restored_providers: 0, restored_models: 0, providers: [], models: [], catalog: RESTORED } }] }),
  denied: base({ error: 'forbidden' }),
};
(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(); const results = [];
  try {
    for (const [name, data] of Object.entries(SCENARIOS)) {
      const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
      const errors = []; page.on('pageerror', (e) => errors.push(e.message));
      await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
      await page.addInitScript((d) => { window.__STUB__ = d; }, data);
      await page.goto(url); await page.waitForSelector('.nav button[data-tab="ai"]'); await page.click('.nav button[data-tab="ai"]');
      await page.waitForSelector('#ai-restore-defaults');
      const names = () => page.evaluate(() => window.__calls.map((c) => c.name));
      const restoreCalls = async () => (await names()).filter((n) => n === 'admin_restore_default_ai_catalog').length;
      assert.equal((await page.locator('#ai-restore-defaults').innerText()).trim(), 'Restore Default Providers');
      assert.equal(await page.locator('#ai-rows tr.prov').count(), 3, name + ': damaged catalogue shown');
      assert.equal(await restoreCalls(), 0, name + ': rendering restores nothing');
      // click -> confirmation first; Cancel -> nothing is sent
      await page.click('#ai-restore-defaults');
      const dlg = page.locator('.overlay[role="dialog"]'); await dlg.waitFor();
      const text = await dlg.innerText();
      assert.match(text, /Restore default providers\?/); assert.match(text, /missing/i); assert.match(text, /already exist/i); assert.match(text, /nothing is overwritten/i);
      assert.equal(await restoreCalls(), 0, name + ': the dialog alone sends nothing');
      await dlg.locator('button', { hasText: 'Cancel' }).click(); await page.waitForTimeout(100);
      assert.equal(await page.locator('.overlay').count(), 0); assert.equal(await restoreCalls(), 0, name + ': Cancel sends nothing');
      // confirm
      await page.click('#ai-restore-defaults'); await dlg.waitFor();
      await dlg.locator('button', { hasText: /^Restore$/ }).click(); await page.waitForTimeout(250);
      const sent = (await page.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_restore_default_ai_catalog');
      assert.equal(sent.length, 1, name + ': exactly one RPC call'); assert.deepEqual(sent[0].params, {}, 'no parameters are sent');
      if (name === 'restore') {
        const summary = await page.locator('#ai-restore-summary').innerText();
        assert.match(summary, /Restored 5 providers and 5 models\./); assert.match(summary, /OpenRouter/); assert.match(summary, /Existing providers and models were not changed/);
        assert.equal(await page.locator('#ai-rows tr.prov').count(), 8, 'the table refreshed itself from the returned catalogue');
        assert.equal(await page.locator('#ai-rows tr.prov[data-provider="Groq"]').count(), 1);
        assert.match(await page.locator('#ai-rows').innerText(), /openai\/gpt-oss-120b/, 'the manually added Groq model is still listed');
        await page.locator('.overlay button', { hasText: 'OK' }).click();
        // second click: idempotent summary
        await page.click('#ai-restore-defaults'); await dlg.waitFor(); await dlg.locator('button', { hasText: /^Restore$/ }).click(); await page.waitForTimeout(250);
        assert.match(await page.locator('#ai-restore-summary').innerText(), /Nothing to restore/);
        assert.equal(await page.locator('#ai-rows tr.prov').count(), 8, 'no duplicate rows');
        const writes = (await names()).filter((n) => /^admin_(upsert|delete|set)_/.test(n)); assert.deepEqual(writes, [], 'only the restore RPC writes anything');
      }
      if (name === 'denied') {
        await page.waitForSelector('.toast.err'); assert.match(await page.locator('.toast.err').innerText(), /forbidden/);
        assert.equal(await page.locator('#ai-restore-summary').count(), 0, 'no success summary after an error');
        assert.equal(await page.locator('#ai-rows tr.prov').count(), 3, 'the table is unchanged after an error');
      }
      assert.deepEqual(errors, [], name + ': no page errors');
      results.push(name); await page.close();
    }
    console.log('PASS scenarios: ' + results.join(', '));
  } finally { await browser.close(); server.close(); }
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
