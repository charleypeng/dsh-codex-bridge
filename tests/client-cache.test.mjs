// Pure cache/controller unit tests from the actual client implementation.
// No React/DOM emulation or screenshot: first-frame coverage verifies the exact
// synchronous initializer + its source wiring, not an actual browser paint.
// Run: node --test tools/client-cache.test.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import vm from 'node:vm'

const source = await readFile(new URL('../client.js', import.meta.url), 'utf8')
const start = source.indexOf('    const CACHE_KEY = ')
const end = source.indexOf('    const displayCache = createDisplayCache()')
assert.ok(start > 0 && end > start, 'pure helper boundaries exist')
const window = {}
let localStorageReads = 0
Object.defineProperty(window, 'localStorage', { get() { localStorageReads++; throw new Error('blocked localStorage') } })
Object.defineProperty(window, 'sessionStorage', { get() { throw new Error('blocked sessionStorage') } })
const { CACHE_KEY, CACHE_TTL, displaySnapshot, createDisplayCache, initialDisplayState, createDisplayLoader } = vm.runInNewContext(
  source.slice(start, end) + '\n;({ CACHE_KEY, CACHE_TTL, displaySnapshot, createDisplayCache, initialDisplayState, createDisplayLoader })',
  { window },
)
const NOW = 1_795_350_000_000
function fixture(used = 29) {
  return {
    auth: { found: true, accountId: 'account-private-id-1234', authMode: 'chatgpt', path: '/private/auth.json', tokens: { access: 'SECRET_ACCESS' }, raw: 'SECRET_RAW' },
    credential: { accessToken: 'SECRET_ACCESS', refreshToken: 'SECRET_REFRESH' },
    route: { configurable: true, configured: true, providers: ['openai-codex'], raw: 'SECRET_ROUTE' },
    usage: { planLabel: 'Pro Lite', email: 'private@example.invalid', accountId: 'account-private-id-1234', fetchedAt: NOW,
      windows: [{ kind: 'primary', usedPercent: used, windowSeconds: 604800, resetAt: NOW / 1000 + 3600, resetAfterSeconds: 3600, raw: 'SECRET_WINDOW' }],
      credits: { unlimited: false, balance: '12.5', token: 'SECRET_CREDIT' }, resetCredits: 2 },
    usageError: null,
    models: [{ id: 'gpt-test', name: 'Test model', reasoning: true, contextWindow: 272000, available: true, accessToken: 'SECRET_MODEL' }],
    codexModels: [{ raw: 'SECRET_CODEX_MODELS' }],
    extra: 'SECRET_EXTRA',
  }
}
function storage() {
  const items = new Map()
  return { items, getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) }
}
function seeded() {
  const disk = storage()
  const cache = createDisplayCache(() => disk, () => NOW)
  cache.write(fixture())
  return { disk, cache }
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function plain(value) { return JSON.parse(JSON.stringify(value)) }

test('cached first-frame initializer is ready synchronously before any network call', () => {
  const { cache } = seeded()
  let calls = 0
  const loader = createDisplayLoader(cache, () => { calls++; throw new Error('not yet') })
  const state = loader.snapshot()
  assert.equal(calls, 0)
  assert.equal(state.phase, 'ready')
  assert.equal(state.data.usage.windows[0].usedPercent, 29)
  assert.equal(state.data.models[0].name, 'Test model')
  assert.equal(state.stale, true)
  assert.match(source, /useState\(\(\) => loader\.snapshot\(\)\)/)
})

test('no-cache initial state selects the section skeleton, not a full-page spinner', () => {
  const state = initialDisplayState(createDisplayCache(() => storage(), () => NOW))
  assert.equal(state.data, null)
  assert.equal(state.phase, 'loading')
  assert.match(source, /if \(data === null\)/)
  assert.match(source, /\['credentialSection', 'routeSection', 'usageSection', 'modelsSection'\]/)
  assert.match(source, /className: 'cbx-skeleton'/)
})

test('failed background refresh retains every prior display field and marks it stale', async () => {
  const { cache } = seeded()
  const loader = createDisplayLoader(cache, () => { throw new Error('offline') })
  const before = plain(loader.snapshot().data)
  await loader.refresh()
  const after = loader.snapshot()
  assert.deepEqual(plain(after.data), before)
  assert.equal(after.phase, 'ready')
  assert.equal(after.stale, true)
  assert.equal(after.refreshing, false)
  assert.match(after.error, /offline/)
})

test('Host partial usage failure retains usage/models and does not refresh cache age', async () => {
  const { disk, cache } = seeded()
  const original = disk.getItem(CACHE_KEY)
  const failed = { ...fixture(), usage: null, models: [], usageError: 'quota offline' }
  const loader = createDisplayLoader(cache, () => failed)
  await loader.refresh()
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 29)
  assert.equal(loader.snapshot().data.models.length, 1)
  assert.equal(loader.snapshot().stale, true)
  assert.equal(disk.getItem(CACHE_KEY), original)
})

test('usage from the previous account is never borrowed for a new account', async () => {
  const { cache } = seeded()
  const changed = fixture()
  changed.auth.accountId = 'another-private-account-9999'
  changed.usage = null
  changed.usageError = 'quota offline'
  const loader = createDisplayLoader(cache, () => changed)
  await loader.refresh()
  assert.equal(loader.snapshot().data.usage, null)
})

test('successful background refresh keeps old UI while pending then publishes and persists new data', async () => {
  const { disk, cache } = seeded()
  const pending = deferred()
  const loader = createDisplayLoader(cache, (endpoint) => { assert.equal(endpoint, 'refresh'); return pending.promise })
  const task = loader.refresh()
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 29)
  assert.equal(loader.snapshot().refreshing, true)
  pending.resolve(fixture(41))
  await task
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 41)
  assert.equal(loader.snapshot().stale, false)
  assert.equal(loader.snapshot().error, null)
  assert.equal(JSON.parse(disk.getItem(CACHE_KEY)).data.usage.windows[0].usedPercent, 41)
})

test('close/reopen and independent cache instance both synchronously recover cached data', async () => {
  const { disk, cache } = seeded()
  const loader = createDisplayLoader(cache, () => fixture(54))
  const unsubscribe = loader.subscribe(() => {})
  await loader.refresh()
  unsubscribe()
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 54)
  const reloaded = createDisplayCache(() => disk, () => NOW)
  assert.equal(initialDisplayState(reloaded).data.usage.windows[0].usedPercent, 54)
})

test('storage getter/read/write failures are safe and memory still supports reopen', () => {
  for (const getStorage of [
    () => { throw new Error('security') },
    () => ({ getItem() { throw new Error('read denied') }, setItem() { throw new Error('quota') } }),
    () => ({ getItem() { return null }, setItem() { throw new Error('quota') } }),
    () => undefined,
  ]) {
    const cache = createDisplayCache(getStorage, () => NOW)
    assert.equal(cache.read(), null)
    assert.doesNotThrow(() => cache.write(fixture()))
    assert.equal(initialDisplayState(cache).data.usage.windows[0].usedPercent, 29)
  }
  const defaultCache = createDisplayCache(undefined, () => NOW)
  assert.equal(defaultCache.read(), null)
  assert.doesNotThrow(() => defaultCache.write(fixture()))
  assert.equal(defaultCache.read().data.models.length, 1)
  assert.equal(localStorageReads, 0, 'localStorage is never touched')
})

test('malformed, unknown-version, future and expired session data are ignored', () => {
  for (const record of [
    '{broken', 'null', JSON.stringify({ version: 2, savedAt: NOW, data: fixture() }),
    JSON.stringify({ version: 1, savedAt: NOW + 1, data: fixture() }),
    JSON.stringify({ version: 1, savedAt: NOW - CACHE_TTL, data: fixture() }),
    JSON.stringify({ version: 1, savedAt: NOW, data: { models: [] } }),
  ]) {
    const cache = createDisplayCache(() => ({ getItem: () => record }), () => NOW)
    assert.equal(cache.read(), null)
  }
})

test('TTL bounds memory too, without extending older Host snapshot lifetime', () => {
  const disk = storage()
  let now = NOW
  const cache = createDisplayCache(() => disk, () => now)
  const value = fixture()
  value.usage.fetchedAt = NOW - CACHE_TTL + 1000
  cache.write(value)
  assert.ok(cache.read())
  now += 1000
  assert.equal(cache.read(), null)
  assert.equal(createDisplayLoader(cache, () => fixture()).snapshot().data, null)
})

test('closed loader does not resurrect an expired cached display', () => {
  const disk = storage()
  let now = NOW
  const cache = createDisplayCache(() => disk, () => now)
  cache.write(fixture())
  const loader = createDisplayLoader(cache, () => fixture())
  assert.equal(loader.snapshot().phase, 'ready')
  now += CACHE_TTL
  assert.equal(loader.snapshot().data, null)
})

test('only strictly whitelisted display fields persist, with even short account IDs masked', () => {
  const { disk, cache } = seeded()
  const encoded = disk.getItem(CACHE_KEY)
  for (const forbidden of ['SECRET_', 'private@example.invalid', 'account-private-id-1234', '/private/auth.json', 'credential', 'codexModels', 'accessToken', 'tokens', 'providers']) {
    assert.equal(encoded.includes(forbidden), false, forbidden)
  }
  assert.equal(cache.read().data.auth.accountMasked, 'accoun…1234')
  const short = fixture(); short.auth.accountId = 'abc'
  assert.equal(displaySnapshot(short).auth.accountMasked, '••••')
  assert.deepEqual(plain(displaySnapshot(displaySnapshot(fixture()))), plain(displaySnapshot(fixture())), 'sanitization is idempotent')
})

test('opening/manual/timer concurrent refreshes share one request and one promise', async () => {
  const { cache } = seeded()
  const pending = deferred()
  let calls = 0
  const loader = createDisplayLoader(cache, () => { calls++; return pending.promise })
  const first = loader.refresh()
  assert.equal(loader.refresh(), first)
  assert.equal(loader.refresh(), first)
  await Promise.resolve()
  assert.equal(calls, 1)
  pending.resolve(fixture(62))
  await first
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 62)
})

test('older response cannot overwrite a newer response or its persisted cache', async () => {
  const { disk, cache } = seeded()
  const older = deferred(), newer = deferred()
  let calls = 0
  const loader = createDisplayLoader(cache, () => ++calls === 1 ? older.promise : newer.promise)
  const oldTask = loader.refresh()
  await Promise.resolve()
  loader.invalidate()
  const newTask = loader.refresh()
  newer.resolve(fixture(75))
  await newTask
  older.resolve(fixture(3))
  await oldTask
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 75)
  assert.equal(JSON.parse(disk.getItem(CACHE_KEY)).data.usage.windows[0].usedPercent, 75)
})

test('older rejection cannot replace a newer successful state', async () => {
  const { cache } = seeded()
  const older = deferred(), newer = deferred()
  let calls = 0
  const loader = createDisplayLoader(cache, () => ++calls === 1 ? older.promise : newer.promise)
  const oldTask = loader.refresh()
  await Promise.resolve()
  loader.invalidate()
  const newTask = loader.refresh()
  newer.resolve(fixture(81))
  await newTask
  older.reject(new Error('old failure'))
  await oldTask
  assert.equal(loader.snapshot().error, null)
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 81)
})

test('unsubscribing prevents subsequent notification while background result can update cache', async () => {
  const { cache } = seeded()
  const pending = deferred()
  const loader = createDisplayLoader(cache, () => pending.promise)
  let notifications = 0
  const unsubscribe = loader.subscribe(() => { notifications++ })
  const task = loader.refresh()
  unsubscribe()
  const atUnmount = notifications
  pending.resolve(fixture(88))
  await task
  assert.equal(notifications, atUnmount)
  assert.equal(cache.read().data.usage.windows[0].usedPercent, 88)
})

test('mount/cleanup wiring uses visible-only 60s refresh and guards async action state', () => {
  assert.match(source, /document\.visibilityState !== 'visible'/)
  assert.match(source, /\}, 60000\)/)
  assert.match(source, /mounted\.current = false\s+unsubscribe\(\)\s+clearInterval\(timer\)/)
  assert.match(source, /if \(mounted\.current\) setBusy\(null\)/)
  assert.match(source, /const ROUTE = '\/codex-api'/)
  assert.doesNotMatch(source, /call\(['"]status['"]/)
  assert.doesNotMatch(source, /clearCache|localStorage|removeItem/)
})

test('malformed network response also preserves the previous display', async () => {
  const { cache } = seeded()
  const loader = createDisplayLoader(cache, () => ({ ok: true }))
  await loader.refresh()
  assert.equal(loader.snapshot().data.usage.windows[0].usedPercent, 29)
  assert.equal(loader.snapshot().stale, true)
  assert.match(loader.snapshot().error, /Invalid Codex response/)
})
