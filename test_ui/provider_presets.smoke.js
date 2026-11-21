// Part 80 browser smoke test: the REAL admin.js in Chromium against a stubbed Supabase client. Navigation groups, provider presets (Groq / OpenRouter / Cloudflare Workers AI / NVIDIA NIM / Custom),
// the Cloudflare placeholder guard and the publish gate (unchecked = saved disabled unless accepted); no key is ever sent. NOT SQL / RLS / a live project.
//   NODE_PATH=$(npm root -g) PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test_ui/provider_presets.smoke.js
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
  sort_order: 10, failover_order: 10, models: [], package: null, packages: [] }, extra || {});
const CAT = [P('Groq'), P('OpenRouter')];
const SCEN = { rpc: { admin_overview: { data: {} }, admin_list_addon_releases: { data: [] }, admin_list_pages: { data: [] }, admin_get_addon_selection: { data: [] }, admin_list_addons: { data: [] },
  admin_list_ai_catalog: { data: CAT }, admin_list_ai_force_updates: { data: [] }, admin_list_removed_ai_catalog: { data: { providers: [], models: [] } },
  admin_upsert_ai_openai_provider: { data: { catalog: CAT } } } };
(async () => {
  const server = http.createServer((req, res) => {
    const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0]).replace(/^\/+$/, '/index.html'));
    if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream' }); fs.createReadStream(p).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch(); let n = 0; const ok = (m) => { n++; console.log('ok   ' + m); };
  try {
    const page = await browser.newPage({ viewport: { width: 1300, height: 900 } });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/vendor/supabase.js', (r) => r.fulfill({ contentType: 'text/javascript', body: STUB }));
    await page.addInitScript((d) => { window.__STUB__ = d; }, SCEN);
    await page.goto(url); await page.waitForSelector('.nav button[data-tab="ai"]');
    const groups = await page.locator('.nav .nav-group').allInnerTexts();
    assert.deepEqual(groups.map((g) => g.trim().toLowerCase()), ['dashboard', 'pages & permissions', 'users & controls', 'api provider manager', 'licensing', 'publishing', 'other tools']); ok('navigation is grouped into the seven areas');
    const tabs = await page.locator('.nav button').evaluateAll((b) => b.map((x) => x.dataset.tab));
    assert.deepEqual(tabs.sort(), ['addons', 'addontools', 'ai', 'apiann', 'limits', 'notices', 'overview', 'pages', 'payment', 'users', 'version']); ok('every existing screen is still reachable (same tab ids)');
    await page.click('.nav button[data-tab="ai"]'); await page.waitForSelector('#ai-add-provider'); await page.click('#ai-add-provider');
    const dlg = page.locator('.overlay[role="dialog"]'); await dlg.waitFor();
    assert.deepEqual(await page.locator('#aip-preset option').allInnerTexts(), ['Custom (any OpenAI-compatible provider)', 'Groq', 'OpenRouter', 'Cloudflare Workers AI', 'NVIDIA NIM']); ok('preset list: Custom, Groq, OpenRouter, Cloudflare Workers AI, NVIDIA NIM');
    // Cloudflare: placeholder must be replaced
    await page.selectOption('#aip-preset', 'cloudflare');
    assert.match(await page.inputValue('#aip-base'), /accounts\/<ACCOUNT_ID>\/ai\/v1$/); assert.equal(await page.inputValue('#aip-models'), ''); assert.equal(await page.inputValue('#aip-key'), 'cloudflare_workers_ai');
    await dlg.locator('button', { hasText: /^Save$/ }).click(); await page.waitForTimeout(150);
    assert.match(await page.locator('#aip-err').innerText(), /Replace the <PLACEHOLDER>/); ok('Cloudflare placeholder blocks saving');
    assert.equal((await page.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_upsert_ai_openai_provider').length, 0);
    // NVIDIA: fills, saves disabled when unchecked, and never sends a key
    await page.selectOption('#aip-preset', 'nvidia');
    assert.equal(await page.inputValue('#aip-base'), 'https://integrate.api.nvidia.com/v1'); assert.equal(await page.inputValue('#aip-key'), 'nvidia_nim'); assert.equal(await page.inputValue('#aip-models'), '/models'); ok('NVIDIA NIM preset fills the settings');
    await dlg.locator('button', { hasText: /^Save$/ }).click(); await page.waitForSelector('#aip-gate');
    assert.match(await page.locator('#aip-gate').innerText(), /saved DISABLED/);
    await page.locator('.overlay[role="dialog"]').last().locator('button', { hasText: 'Add provider' }).click(); await page.waitForTimeout(250);
    let sent = (await page.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_upsert_ai_openai_provider');
    assert.equal(sent.length, 1); assert.equal(sent[0].params.p_enabled, false, 'unchecked -> saved disabled'); assert.equal(sent[0].params.p_config.base_url, 'https://integrate.api.nvidia.com/v1'); ok('an unchecked provider is saved disabled');
    assert.ok(!/nvapi-[A-Za-z0-9]{6}|Bearer [A-Za-z0-9]/.test(JSON.stringify(sent[0].params)), 'no key in the request'); ok('no API key is sent to the database');
    // Groq with explicit acceptance -> enabled
    await page.click('#ai-add-provider'); await page.waitForSelector('#aip-preset'); await page.selectOption('#aip-preset', 'groq');
    assert.equal(await page.inputValue('#aip-base'), 'https://api.groq.com/openai/v1');
    await page.locator('.overlay[role="dialog"]').last().locator('button', { hasText: /^Save$/ }).click(); await page.waitForSelector('#aip-publish-unchecked');
    await page.check('#aip-publish-unchecked'); await page.locator('.overlay[role="dialog"]').last().locator('button', { hasText: 'Add provider' }).click(); await page.waitForTimeout(250);
    sent = (await page.evaluate(() => window.__calls)).filter((c) => c.name === 'admin_upsert_ai_openai_provider');
    assert.equal(sent.length, 2); assert.equal(sent[1].params.p_enabled, true); assert.equal(sent[1].params.p_key, 'groq_compat'); ok('explicitly accepted publish -> enabled');
    assert.deepEqual(errors, [], 'no page errors'); ok('no page errors');
  } finally { await browser.close(); server.close(); }
  console.log('\n' + n + ' checks passed');
})().catch((e) => { console.error('FAIL', e.stack || e); process.exit(1); });
