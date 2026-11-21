// Part 80: provider presets + publish gate (pure logic, no network). Run: node --test test/compat_presets.test.js
'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const CL = require('../compat_logic.js');

test('the five start points exist: Custom, Groq, OpenRouter, Cloudflare Workers AI, NVIDIA NIM', () => {
  assert.deepEqual(CL.PRESETS.map((p) => p.id), ['custom', 'groq', 'openrouter', 'cloudflare', 'nvidia']);
  assert.equal(CL.presetById('custom').fill, null); assert.equal(CL.presetById('nope').id, 'custom');
});
test('presets carry settings only: https base URL, paths, key link; never a key or a baked-in model list', () => {
  for (const p of CL.PRESETS.filter((x) => x.fill)) {
    assert.match(p.fill.base_url, /^https:\/\//); assert.ok(p.fill.chat_path.startsWith('/')); assert.ok(/^[a-z][a-z0-9_]*$/.test(p.fill.provider), p.id);
    assert.ok(!/(sk-or-v1-[A-Za-z0-9]{10,}|gsk_[A-Za-z0-9]{10,}|nvapi-[A-Za-z0-9]{10,}|Bearer [A-Za-z0-9])/.test(JSON.stringify(p.fill)), 'no key material');
    assert.ok(!('models' in p.fill));
  }
  assert.equal(CL.presetById('groq').fill.base_url, 'https://api.groq.com/openai/v1');
  assert.equal(CL.presetById('openrouter').fill.base_url, 'https://openrouter.ai/api/v1');
  assert.equal(CL.presetById('nvidia').fill.base_url, 'https://integrate.api.nvidia.com/v1');
  assert.equal(CL.presetById('cloudflare').fill.models_path, '', 'Cloudflare has no OpenAI model list');
});
test('preset provider keys do not clash with the built-in Groq / OpenRouter keys', () => {
  const keys = CL.PRESETS.filter((x) => x.fill).map((p) => p.fill.provider);
  assert.ok(!keys.includes('groq') && !keys.includes('openrouter')); assert.equal(new Set(keys).size, keys.length);
});
test('the Cloudflare <ACCOUNT_ID> placeholder must be replaced before the form is accepted', () => {
  const v = Object.assign({}, CL.DEFAULTS, { base_url: CL.presetById('cloudflare').fill.base_url });
  assert.ok(CL.missingFields(v).some((m) => /Replace the <PLACEHOLDER>/.test(m)));
  v.base_url = v.base_url.replace('<ACCOUNT_ID>', 'abc123'); assert.deepEqual(CL.missingFields(v), []);
  assert.ok(CL.hasPlaceholder('https://x/<ACCOUNT_ID>/y') && !CL.hasPlaceholder('https://x/v1'));
});
test('existing required-field rules are unchanged', () => {
  assert.deepEqual(CL.missingFields({ base_url: '' }), ['Enter the base URL.']);
  assert.ok(CL.missingFields({ base_url: 'http://x' })[0].includes('https://'));
  assert.ok(CL.missingFields({ base_url: 'https://x', auth_scheme: 'header', auth_header: '' }).length === 1);
});
test('publish gate: enabled only when a check passed for EXACTLY this configuration, or the admin accepts', () => {
  const a = { base_url: 'https://a/v1', chat_path: '/c', extra_headers: { B: '1', A: '2' } }, aSame = { extra_headers: { A: '2', B: '1' }, chat_path: '/c', base_url: 'https://a/v1' }, b = Object.assign({}, a, { base_url: 'https://b/v1' });
  assert.equal(CL.configSignature(a), CL.configSignature(aSame), 'key order does not matter');
  const sig = CL.configSignature(a);
  assert.equal(CL.publishEnabled(true, sig, aSame, false), true);
  assert.equal(CL.publishEnabled(true, sig, b, false), false, 'a changed configuration needs a new check');
  assert.equal(CL.publishEnabled(true, '', a, false), false, 'never checked');
  assert.equal(CL.publishEnabled(true, '', a, true), true, 'explicitly accepted');
  assert.equal(CL.publishEnabled(false, sig, a, true), false, 'a disabled provider stays disabled');
});
