// v1.0.0 (7th Edition, Part 2) - pure helpers of the Removed Providers & Models section (provider_logic.js). No DOM, no network.
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const PL = require(path.join(process.env.MZ_ADMIN_ROOT || path.join(__dirname, '..'), 'provider_logic.js'));
const removed = {
  providers: [{ provider: 'Groq', title: 'Groq', enabled: true, models: [{ id: 'qwen/qwen3.6-27b', label: 'Qwen', archived_with_provider: true }, { id: 'old-one', label: 'Old', archived_with_provider: false }] },
              { provider: 'Grok', title: 'Grok', enabled: false, models: [] }],
  models: [{ provider: 'OpenAI', provider_title: 'OpenAI', provider_archived: false, id: 'gpt-4o-mini', label: 'GPT-4o Mini', enabled: true },
           { provider: 'Groq', provider_title: 'Groq', provider_archived: true, id: 'old-one', label: 'Old', enabled: false }],
};
test('search matches title, key, label and model id case-insensitively; empty query matches all', () => {
  assert.equal(PL.filterRemoved(removed.providers, '').length, 2);
  assert.deepEqual(PL.filterRemoved(removed.providers, 'GROK').map((p) => p.provider), ['Grok']);
  assert.deepEqual(PL.filterRemoved(removed.models, 'mini').map((m) => m.id), ['gpt-4o-mini']);
  assert.deepEqual(PL.filterRemoved(removed.models, 'groq').map((m) => m.id), ['old-one']);
  assert.deepEqual(PL.filterRemoved(removed.models, 'zzz'), []);
  assert.deepEqual(PL.filterRemoved(null, 'x'), []);
});
test('a removed key is recognised so the Admin is told to restore instead of re-adding', () => {
  assert.ok(PL.isRemovedProviderKey(removed, ' Groq ') && !PL.isRemovedProviderKey(removed, 'Gemini') && !PL.isRemovedProviderKey(null, 'Groq'));
  assert.ok(PL.isRemovedModelId(removed, 'OpenAI', 'gpt-4o-mini') && !PL.isRemovedModelId(removed, 'Groq', 'gpt-4o-mini'));
});
test('provider restore plan: models removed with it come back, models removed on their own stay removed', () => {
  assert.deepEqual(PL.restoreProviderPlan(removed.providers[0]), { back: ['qwen/qwen3.6-27b'], stay: ['old-one'] });
  assert.deepEqual(PL.restoreProviderPlan(removed.providers[1]), { back: [], stay: [] });
});
test('a model under a removed provider cannot be restored first; others can; status label is the original setting', () => {
  assert.match(PL.restoreModelBlocked(removed.models[1]), /Restore provider Groq first/);
  assert.equal(PL.restoreModelBlocked(removed.models[0]), null);
  assert.equal(PL.originalStatus({ enabled: true }), 'On'); assert.equal(PL.originalStatus({ enabled: false }), 'Off');
});
