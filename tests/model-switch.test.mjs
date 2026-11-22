// Actual client pure cache/controller helpers only: no React or DOM mocks.
// Run: node --test tools/model-switch.test.mjs tools/client-cache.test.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('    const CACHE_KEY = ')
const end = source.indexOf('    const displayCache = createDisplayCache()')
assert.ok(start > 0 && end > start, 'actual pure helper boundaries exist')
const { CACHE_KEY, displaySnapshot, createDisplayCache, createDisplayLoader } = vm.runInNewContext(
  source.slice(start, end) + '\n;({ CACHE_KEY, displaySnapshot, createDisplayCache, createDisplayLoader })',
)
const NOW = 1_795_350_000_000
const plain = (value) => JSON.parse(JSON.stringify(value))
function fixture(firstEnabled = true, secondEnabled = false) {
  return {
    auth: { found: true, accountId: 'private-account-1234', authMode: 'chatgpt', tokens: 'SECRET_AUTH' },
    route: { configured: true, configurable: true },
    usage: { fetchedAt: NOW, planLabel: 'Pro', windows: [], credits: { unlimited: false, balance: '2' } },
    models: [
      { id: 'first', name: 'First model', enabled: firstEnabled, available: false, contextWindow: 272000,
        reasoning: true, reasoningEfforts: [{ id: 'low', label: 'Low', tokens: 'SECRET_EFFORT' }, { id: 'high' }],
        defaultReasoningEffort: 'high', unsupportedReasoningEfforts: ['max'], source: 'codex', catalogAvailable: true,
        raw: 'SECRET_MODEL' },
      { id: 'second', name: 'Manual model', enabled: secondEnabled, available: null, contextWindow: null,
        reasoning: true, reasoningEfforts: ['medium', 'high'], defaultReasoningEffort: null,
        unsupportedReasoningEfforts: [], source: 'manual', catalogAvailable: false },
    ],
    catalogError: null, catalogUpdatedAt: NOW - 1000,
    raw: { tokens: 'SECRET_RAW' },
  }
}
function seeded(value = fixture()) {
  const disk = new Map()
  const cache = createDisplayCache(() => ({ getItem: (key) => disk.get(key) ?? null, setItem: (key, data) => disk.set(key, data) }), () => NOW)
  cache.write(value)
  return { disk, cache }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

// These are behavior tests of the production helpers, not a synthetic renderer.
test('cache whitelist preserves enabled, effort, source, and catalog display fields only', () => {
  const value = fixture()
  value.catalogError = 'Catalog temporarily unavailable'
  const { cache, disk } = seeded(value)
  const data = plain(cache.read().data)
  assert.equal(data.models[0].enabled, true)
  assert.equal(data.models[1].enabled, false)
  assert.deepEqual(data.models[0].reasoningEfforts, [{ id: 'low', label: 'Low' }, { id: 'high', label: 'high' }])
  assert.deepEqual(data.models[1].reasoningEfforts, [{ id: 'medium', label: 'medium' }, { id: 'high', label: 'high' }])
  assert.equal(data.models[0].defaultReasoningEffort, 'high')
  assert.deepEqual(data.models[0].unsupportedReasoningEfforts, ['max'])
  assert.equal(data.models[1].source, 'manual')
  assert.equal(data.models[1].catalogAvailable, false)
  assert.equal(data.catalogError, 'Catalog temporarily unavailable')
  assert.equal(data.catalogUpdatedAt, NOW - 1000)
  assert.equal(disk.get(CACHE_KEY).includes('SECRET_'), false)
  assert.equal(disk.get(CACHE_KEY).includes('tokens'), false)
  assert.equal(disk.get(CACHE_KEY).includes('private-account-1234'), false)
  assert.deepEqual(plain(displaySnapshot(data)), data, 'sanitizing twice stays safe and stable')
})

test('old v1 cache retains first-frame models and defaults old runtime rows to enabled', () => {
  const old = fixture()
  for (const row of old.models) {
    delete row.enabled; delete row.reasoningEfforts; delete row.source; delete row.catalogAvailable
  }
  delete old.catalogError; delete old.catalogUpdatedAt
  const { cache } = seeded(old)
  let requests = 0
  const loader = createDisplayLoader(cache, () => { requests++ })
  assert.equal(loader.snapshot().phase, 'ready')
  assert.equal(loader.snapshot().data.models[0].enabled, true)
  assert.equal(loader.snapshot().data.catalogError, null)
  assert.equal(requests, 0)
})

test('malformed effort/catalog metadata is safely bounded and unknown source becomes legacy', () => {
  const value = fixture()
  Object.assign(value.models[0], { reasoningEfforts: [null, 9, {}, { id: '' }, { id: 'high', label: 3 }, 'low'],
    unsupportedReasoningEfforts: ['max', null, 3], source: 'unknown', defaultReasoningEffort: {}, catalogAvailable: 'yes' })
  value.catalogUpdatedAt = Infinity
  value.catalogError = 'x'.repeat(1000)
  const data = plain(displaySnapshot(value))
  assert.deepEqual(data.models[0].reasoningEfforts, [{ id: 'high', label: 'high' }, { id: 'low', label: 'low' }])
  assert.deepEqual(data.models[0].unsupportedReasoningEfforts, ['max'])
  assert.equal(data.models[0].defaultReasoningEffort, null)
  assert.equal(data.models[0].source, 'legacy')
  assert.equal(data.models[0].catalogAvailable, false)
  assert.equal(data.catalogUpdatedAt, null)
  assert.equal(data.catalogError.length, 500)
})

test('toggle sends the exact payload, keeps previous checked value while saving, and caches full status without another fetch', async () => {
  const { cache, disk } = seeded()
  const pending = deferred(), calls = []
  const loader = createDisplayLoader(cache, (endpoint, payload) => { calls.push([endpoint, plain(payload)]); return pending.promise })
  const task = loader.setModelEnabled('first', false)
  assert.deepEqual(plain(loader.snapshot().pendingModels), ['first'])
  assert.equal(loader.snapshot().data.models[0].enabled, true, 'no optimistic checked-state drift')
  await Promise.resolve()
  assert.deepEqual(calls, [['setModelEnabled', { model: 'first', enabled: false }]])
  const next = fixture(false)
  next.usage.planLabel = 'Updated plan'
  pending.resolve(next)
  assert.equal(await task, true)
  assert.equal(loader.snapshot().data.models[0].enabled, false)
  assert.equal(loader.snapshot().data.usage.planLabel, 'Updated plan', 'complete returned status is authoritative')
  assert.equal(JSON.parse(disk.get(CACHE_KEY)).data.models[0].enabled, false)
  assert.equal(calls.length, 1, 'success does not request status/refresh')
  assert.deepEqual(plain(loader.snapshot().pendingModels), [])
  assert.equal(loader.snapshot().modelFeedback[0].error, null)
})

test('disabled rows can be re-enabled even when quota says unavailable or unknown', async () => {
  const { cache } = seeded(fixture(false))
  const loader = createDisplayLoader(cache, () => fixture(true))
  assert.equal(await loader.setModelEnabled('first', true), true)
  assert.equal(loader.snapshot().data.models[0].enabled, true)
  assert.equal(loader.snapshot().data.models[0].available, false, 'enabled is not quota')
  assert.equal(loader.snapshot().data.models[1].available, null)
})

test('all models may be off and remain present with manual metadata intact', async () => {
  const { cache } = seeded()
  const loader = createDisplayLoader(cache, () => fixture(false, false))
  assert.equal(await loader.setModelEnabled('first', false), true)
  const models = loader.snapshot().data.models
  assert.equal(models.length, 2)
  assert.ok(models.every((row) => row.enabled === false))
  assert.equal(models[1].source, 'manual')
  assert.deepEqual(plain(models[1].reasoningEfforts), [{ id: 'medium', label: 'medium' }, { id: 'high', label: 'high' }])
})

test('failed toggle preserves data and cache, clears only its pending row, and offers retry without a refresh', async () => {
  const { cache, disk } = seeded()
  const previous = disk.get(CACHE_KEY)
  let calls = 0
  const loader = createDisplayLoader(cache, () => { if (++calls === 1) throw new Error('save denied'); return fixture(false) })
  assert.equal(await loader.setModelEnabled('first', false), false)
  assert.equal(loader.snapshot().data.models[0].enabled, true)
  assert.equal(disk.get(CACHE_KEY), previous)
  assert.deepEqual(plain(loader.snapshot().pendingModels), [])
  assert.match(loader.snapshot().modelFeedback[0].error, /save denied/)
  const retry = loader.setModelEnabled('first', false)
  assert.equal(loader.snapshot().modelFeedback.length, 0, 'retry clears the previous error immediately')
  assert.equal(await retry, true)
  assert.equal(calls, 2)
})

test('malformed/non-authoritative toggle result fails safely without changing checked state', async () => {
  for (const response of [{}, fixture(), { ...fixture(false), models: [] }, { ...fixture(false), auth: null }]) {
    const { cache, disk } = seeded()
    const previous = disk.get(CACHE_KEY)
    const loader = createDisplayLoader(cache, () => response)
    assert.equal(await loader.setModelEnabled('first', false), false)
    assert.equal(loader.snapshot().data.models[0].enabled, true)
    assert.equal(disk.get(CACHE_KEY), previous)
    assert.match(loader.snapshot().modelFeedback[0].error, /Invalid Codex model response/)
  }
})

test('refresh already in flight cannot overwrite successful toggle or persisted cache', async () => {
  const { cache, disk } = seeded()
  const older = deferred()
  const loader = createDisplayLoader(cache, (endpoint) => endpoint === 'refresh' ? older.promise : fixture(false))
  const refresh = loader.refresh()
  await Promise.resolve()
  assert.equal(await loader.setModelEnabled('first', false), true)
  older.resolve(fixture(true))
  await refresh
  assert.equal(loader.snapshot().data.models[0].enabled, false)
  assert.equal(JSON.parse(disk.get(CACHE_KEY)).data.models[0].enabled, false)
})

test('old refresh rejection cannot introduce an error after successful toggle', async () => {
  const { cache } = seeded()
  const older = deferred()
  const loader = createDisplayLoader(cache, (endpoint) => endpoint === 'refresh' ? older.promise : fixture(false))
  const refresh = loader.refresh()
  await Promise.resolve()
  await loader.setModelEnabled('first', false)
  older.reject(new Error('old refresh failed'))
  await refresh
  assert.equal(loader.snapshot().error, null)
  assert.equal(loader.snapshot().data.models[0].enabled, false)
})

test('timer/manual/reopen refresh during mutation shares pending work and sends no extra request', async () => {
  const { cache } = seeded()
  const pending = deferred()
  let calls = 0
  const loader = createDisplayLoader(cache, () => { calls++; return pending.promise })
  const task = loader.setModelEnabled('first', false)
  const refresh = loader.refresh()
  assert.equal(loader.refresh(), refresh)
  await Promise.resolve()
  assert.equal(calls, 1)
  pending.resolve(fixture(false))
  await Promise.all([task, refresh])
  assert.equal(calls, 1)
  assert.equal(loader.snapshot().refreshing, false)
})

test('different rows queue writes in order while only submitted rows are pending', async () => {
  const { cache } = seeded()
  const first = deferred(), second = deferred(), calls = []
  const loader = createDisplayLoader(cache, (endpoint, payload) => {
    calls.push([endpoint, plain(payload)])
    return calls.length === 1 ? first.promise : second.promise
  })
  const one = loader.setModelEnabled('first', false)
  assert.deepEqual(plain(loader.snapshot().pendingModels), ['first'])
  assert.equal(loader.snapshot().pendingModels.includes('second'), false)
  const two = loader.setModelEnabled('second', true)
  await Promise.resolve()
  assert.equal(calls.length, 1, 'full snapshots cannot race each other')
  assert.deepEqual(plain(loader.snapshot().pendingModels), ['first', 'second'])
  first.resolve(fixture(false))
  await one
  await Promise.resolve()
  assert.equal(calls.length, 2)
  assert.deepEqual(plain(loader.snapshot().pendingModels), ['second'])
  second.resolve(fixture(false, true))
  await two
  assert.deepEqual(plain(loader.snapshot().data.models.map((row) => row.enabled)), [false, true])
  assert.deepEqual(calls[1], ['setModelEnabled', { model: 'second', enabled: true }])
})

test('one failed row does not cancel another queued row', async () => {
  const { cache } = seeded()
  let calls = 0
  const loader = createDisplayLoader(cache, () => { if (++calls === 1) throw new Error('first denied'); return fixture(true, true) })
  const one = loader.setModelEnabled('first', false), two = loader.setModelEnabled('second', true)
  assert.equal(await one, false)
  assert.equal(await two, true)
  assert.match(loader.snapshot().modelFeedback.find((row) => row.id === 'first').error, /first denied/)
  assert.equal(loader.snapshot().data.models[1].enabled, true)
})

test('duplicate, unknown model, and nonboolean requests are ignored before network', async () => {
  const { cache } = seeded()
  const pending = deferred()
  let calls = 0
  const loader = createDisplayLoader(cache, () => { calls++; return pending.promise })
  assert.equal(await loader.setModelEnabled('missing', true), false)
  assert.equal(await loader.setModelEnabled('first', 'false'), false)
  const one = loader.setModelEnabled('first', false)
  assert.equal(await loader.setModelEnabled('first', false), false)
  pending.resolve(fixture(false))
  await one
  assert.equal(calls, 1)
})

test('unmounted page still commits the mutation cache for synchronous reopen', async () => {
  const { cache } = seeded()
  const pending = deferred()
  const loader = createDisplayLoader(cache, () => pending.promise)
  let notifications = 0
  const unsubscribe = loader.subscribe(() => { notifications++ })
  const task = loader.setModelEnabled('first', false)
  unsubscribe()
  const before = notifications
  pending.resolve(fixture(false))
  await task
  assert.equal(notifications, before)
  assert.equal(loader.snapshot().data.models[0].enabled, false)
  assert.equal(cache.read().data.models[0].enabled, false)
})

test('static UI contract uses native accessible switches, row-local pending, locale text, theme tokens and focus styling', () => {
  assert.match(source, /type: 'button', className: 'cbx-switch', role: 'switch'/)
  assert.match(source, /'aria-checked': model.enabled/)
  assert.match(source, /'aria-label': `\$\{t\('modelEnableLabel'\)\}/)
  assert.match(source, /disabled: saving \|\| props.disabled/)
  assert.match(source, /saving: state.pendingModels.includes\(model.id\)/)
  assert.match(source, /onClick: \(\) => props.onToggle\(model.id, !model.enabled\)/)
  assert.match(source, /\.cbx-switch:focus-visible/)
  assert.match(source, /role: feedback\?\.error \? 'alert' : 'status'/)
  assert.doesNotMatch(source, /onKeyDown|@deepseek-ai\/dsh-client-ui-primitives|document\.body|#[0-9a-fA-F]{3,8}\b|rgba?\(/)
  assert.match(source, /modelHint: 'Switches control model picker availability/)
  assert.match(source, /modelHint: '开关仅控制模型选择器中的可选性/)
  assert.match(source, /quotaUnavailable: 'Quota: unavailable'/)
  assert.match(source, /quotaUnavailable: '账号额度：不可用'/)
  assert.doesNotMatch(source, /models\.filter\(.*enabled/)
  // The switch matches the Settings page control: 36x20 pill, 16px thumb, inverted on state.
  assert.match(source, /\.cbx-switchtrack\{position:relative;display:block;width:36px;height:20px;border-radius:999px;/)
  assert.match(source, /\.cbx-switchthumb\{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;/)
  assert.match(source, /\.cbx-switchtrack\[data-on=true\]\{background:var\(--dsw-alias-label-primary\)\}/)
  assert.match(source, /\.cbx-switchtrack\[data-on=true\] \.cbx-switchthumb\{transform:translateX\(16px\)\}/)
  assert.match(source, /'data-on': model\.enabled \? 'true' : undefined/)
  assert.doesNotMatch(source, /\.cbx-switch\{[^}]*border:1px solid/)
  // Each row is structured: icon + name + source/default tags, an iconed meta line, effort chips.
  assert.match(source, /'\.cbx-modeltitle\{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0\}'/)
  assert.match(source, /'\.cbx-tag\{display:inline-flex;align-items:center;gap:4px;height:19px;/)
  assert.match(source, /'\.cbx-chip-on\{border-color:var\(--dsw-alias-label-primary\);/)
  assert.match(source, /'\.cbx-metarow\{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;/)
  assert.match(source, /function Glyph\(props\) \{/)
  assert.match(source, /h\(Glyph, \{ kind: 'model', size: 13 \}\)/)
  assert.match(source, /h\(Glyph, \{ kind: 'context' \}\)/)
  assert.match(source, /className: effort\.id === model\.defaultReasoningEffort \? 'cbx-chip cbx-chip-on' : 'cbx-chip'/)
  // Icons inherit label color instead of carrying their own palette.
  assert.match(source, /stroke: 'currentColor'/)
  assert.doesNotMatch(source, /<svg/)
  // No redundant status word beside the control: the pill itself shows the state.
  assert.doesNotMatch(source, /cbx-modeltoggle' \},\s*h\('span'/)
})
