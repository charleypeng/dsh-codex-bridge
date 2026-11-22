import test from 'node:test'
import assert from 'node:assert/strict'
import { normalizeCodexCatalog, legacyModels, createModelRegistry } from '../model-registry.js'
const upstream = (id = 'gpt-6.2-astra') => ({ slug: id, display_name: id, context_window: 272000, input_modalities: ['text', 'image'], supported_in_api: true, visibility: 'list', default_reasoning_level: 'low', supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort })) })
const fixture = () => {
  const stored = new Map()
  let fail = false, signals = 0
  const deps = { load: async (id) => structuredClone(stored.get(id) ?? null), save: async (id, value) => { if (fail) throw new Error('disk full'); stored.set(id, structuredClone(value)) }, changed: () => signals++ }
  return { stored, deps, registry: createModelRegistry(deps), fail: () => { fail = true }, signals: () => signals }
}
test('normalizes exact Codex efforts/defaults and ignores instruction-bearing fields', () => {
  const input = upstream()
  input.model_messages = { instructions_template: 'UNTRUSTED-SERVER-PROMPT' }
  const data = normalizeCodexCatalog([input, upstream(), { ...upstream('hidden'), visibility: 'hide' }, { ...upstream('not-api'), supported_in_api: false }])
  assert.equal(data.length, 1)
  assert.deepEqual(data[0].reasoningEfforts.map((item) => item.id), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.deepEqual(data[0].unsupportedReasoningEfforts, [])
  assert.equal(data[0].defaultReasoningEffort, 'low')
  assert.equal(JSON.stringify(data).includes('UNTRUSTED'), false)
  assert.throws(() => normalizeCodexCatalog([]))
})
test('preserves only explicit overrides, not stale runtime defaults', () => {
  const native = [{ id: 'one', name: 'old name', contextWindow: 100, reasoningEfforts: [{ id: 'high', label: 'High' }] }]
  const seeded = legacyModels({}, native)
  assert.deepEqual(seeded[0].overrides, {})
  const customized = legacyModels({ models: [{ id: 'one', contextWindow: 400 }] }, native)
  assert.equal(customized[0].overrides.contextWindow, 400)
})
test('new models automatically appear, disabled preferences survive sync and restart', async () => {
  const f = fixture()
  await f.registry.select('a')
  await f.registry.sync('a', normalizeCodexCatalog([upstream()]))
  await f.registry.setEnabled('gpt-6.2-astra', false)
  await f.registry.sync('a', normalizeCodexCatalog([upstream(), upstream('future-new')]))
  assert.equal(f.registry.snapshot().models.find((row) => row.id === 'gpt-6.2-astra').enabled, false)
  assert.equal(f.registry.snapshot().models.find((row) => row.id === 'future-new').enabled, true)
  const reboot = createModelRegistry(f.deps)
  await reboot.select('a')
  assert.equal(reboot.snapshot().models.find((row) => row.id === 'gpt-6.2-astra').enabled, false)
})
test('manual models and explicit capacities survive automatic catalog updates; tiers follow Codex', async () => {
  const f = fixture()
  const manual = legacyModels({ models: [{ id: 'gpt-6.2-astra', contextWindow: 400000 }, { id: 'my-manual' }] })
  await f.registry.select('a', manual)
  await f.registry.sync('a', normalizeCodexCatalog([upstream()]))
  const rows = f.registry.snapshot().models
  assert.equal(rows.find((row) => row.id === 'gpt-6.2-astra').contextWindow, 400000)
  assert.equal(rows.find((row) => row.id === 'gpt-6.2-astra').reasoningEfforts.at(-1).id, 'max')
  assert.deepEqual(rows.find((row) => row.id === 'gpt-6.2-astra').unsupportedReasoningEfforts, [])
  assert.equal(rows.find((row) => row.id === 'my-manual').source, 'manual')
})
test('all off remains in registry, every row can be enabled again, invalid requests reject', async () => {
  const f = fixture()
  await f.registry.select('a')
  await f.registry.sync('a', normalizeCodexCatalog([upstream()]))
  await f.registry.setEnabled('gpt-6.2-astra', false)
  assert.equal(f.registry.snapshot().models.length, 1)
  assert.equal(f.registry.snapshot().models[0].enabled, false)
  await f.registry.setEnabled('gpt-6.2-astra', true)
  assert.equal(f.registry.snapshot().models[0].enabled, true)
  await assert.rejects(f.registry.setEnabled('unknown', true))
  await assert.rejects(f.registry.setEnabled('gpt-6.2-astra', 'true'))
})
test('durable write failure leaves active preferences unchanged; bad catalog preserves state', async () => {
  const f = fixture()
  await f.registry.select('a')
  await f.registry.sync('a', normalizeCodexCatalog([upstream()]))
  f.fail()
  await assert.rejects(f.registry.setEnabled('gpt-6.2-astra', false), /disk full/)
  assert.equal(f.registry.snapshot().models[0].enabled, true)
  f.registry.failed('catalog offline')
  assert.equal(f.registry.snapshot().models.length, 1)
  assert.equal(f.registry.snapshot().catalogError, 'catalog offline')
})
test('accounts are partitioned and old-account catalog cannot overwrite new account', async () => {
  const f = fixture()
  await f.registry.select('a')
  await f.registry.sync('a', normalizeCodexCatalog([upstream()]))
  await f.registry.select('b')
  assert.equal(f.registry.snapshot().models.length, 0)
  await assert.rejects(f.registry.sync('a', normalizeCodexCatalog([upstream('late-old')])) )
  await f.registry.sync('b', normalizeCodexCatalog([upstream('b-model')]))
  assert.deepEqual(f.registry.snapshot().models.map((row) => row.id), ['b-model'])
})
