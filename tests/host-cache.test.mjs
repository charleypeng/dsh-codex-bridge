import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStatusCache } from '../status-cache.js'
import { mountBridge } from '../index.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const turn = () => new Promise(setImmediate)
const base = (account = 'account-a') => ({ auth: { accountId: account }, credential: { accountId: account }, route: { configured: true }, usage: null, usageError: null, models: [] })
const full = (percent, account) => ({ ...base(account), usage: { windows: [{ usedPercent: percent }] }, models: [{ id: 'gpt-6.2-astra' }] })

test('cache returns local first, single-flights requests, then serves cached results immediately', async () => {
  let clock = 1000, count = 0
  const network = deferred()
  const cache = createStatusCache({ now: () => clock, local: async () => base(), refresh: () => { count++; return network.promise } })
  const first = await cache.read()
  assert.equal(first.usage, null)
  const fresh = cache.read({ fresh: true })
  const second = await cache.read()
  assert.equal(second.usage, null)
  await turn()
  assert.equal(count, 1)
  network.resolve(full(29))
  const actual = await fresh
  assert.equal(actual.usage.windows[0].usedPercent, 29)
  assert.equal(actual.cacheUpdatedAt, 1000)
  clock += 2000
  assert.equal((await cache.read()).usage.windows[0].usedPercent, 29)
  assert.equal(count, 1)
  cache.dispose()
})

test('automatic and explicit refresh failure retain quota and original timestamp', async () => {
  let fail = false, clock = 1000, calls = 0
  const cache = createStatusCache({ now: () => clock, local: async () => base(), refresh: async () => {
    calls++
    if (fail) throw new Error('network offline')
    return full(29)
  } })
  await cache.read({ fresh: true })
  fail = true
  clock += 31000
  assert.equal((await cache.read()).usage.windows[0].usedPercent, 29)
  await turn()
  const stale = await cache.read()
  assert.equal(stale.usage.windows[0].usedPercent, 29)
  assert.equal(stale.usageError, 'network offline')
  assert.equal(stale.cacheUpdatedAt, 1000)
  assert.equal(calls, 2, 'backoff avoids repeatedly hammering a failing endpoint')
  const explicit = await cache.read({ fresh: true })
  assert.equal(explicit.usage.windows[0].usedPercent, 29)
  assert.equal(explicit.cacheUpdatedAt, 1000)
  cache.dispose()
})

test('account switch discards the old quota and ignores old in-flight response', async () => {
  let account = 'account-a'
  const old = deferred(), next = deferred()
  const cache = createStatusCache({ local: async () => base(account), refresh: (snapshot) => snapshot.credential.accountId === 'account-a' ? old.promise : next.promise })
  const pendingOld = cache.read({ fresh: true })
  await turn()
  account = 'account-b'
  const empty = await cache.read()
  assert.equal(empty.usage, null)
  next.resolve(full(4, 'account-b'))
  const current = await cache.read({ fresh: true })
  assert.equal(current.usage.windows[0].usedPercent, 4)
  old.resolve(full(99, 'account-a'))
  await pendingOld
  assert.equal((await cache.read()).usage.windows[0].usedPercent, 4)
  cache.dispose()
})

test('returned quota failures retain good data, invalidation and disposal ignore late results', async () => {
  let output = full(29)
  const cache = createStatusCache({ local: async () => base(), refresh: async () => output })
  await cache.read({ fresh: true })
  output = { ...base(), usageError: 'quota endpoint timeout' }
  const failed = await cache.read({ fresh: true })
  assert.equal(failed.usage.windows[0].usedPercent, 29)
  assert.equal(failed.usageError, 'quota endpoint timeout')
  const waiting = deferred()
  output = waiting.promise
  const pending = cache.read({ fresh: true })
  await turn()
  cache.invalidate()
  cache.dispose()
  waiting.resolve(full(90))
  await pending
  assert.equal((await cache.read()).usage, null)
})

test('Host route caches all data, authenticates, preserves models, and never returns tokens', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-test-'))
  const savedHome = process.env.CODEX_HOME
  const savedFetch = globalThis.fetch
  process.env.CODEX_HOME = directory
  const token = `test.${Buffer.from(JSON.stringify({ exp: 2000000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url')}.signature`
  const records = new Map()
  let route, tool, fetches = 0, offline = false
  const entry = { options: { id: 'llm-pi-ai', config: { providers: {
    other: { apiKeyEnv: 'UNRELATED_KEY' },
    'openai-codex': { displayName: 'Personal Codex', modelOverrides: { 'gpt-6.1-sol': { contextWindow: 500000 } } },
  } } } }
  const effects = []
  const usageGate = deferred()
  const savedAccounts = new Map()
  let savedBaseline, liveAdapter
  const openStore = async () => ({
    baseline: () => savedBaseline,
    saveBaseline: async (value) => { savedBaseline = structuredClone(value) },
    load: async (id) => savedAccounts.get(id) ?? null,
    save: async (id, value) => { savedAccounts.set(id, structuredClone(value)) },
    close: async () => {},
  })
  const makeAdapter = async ({ getSnapshot }) => ({ listModels: async () => getSnapshot().models.filter((row) => row.enabled) })
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (value) => { route = value; return () => {} } }
      if (name === 'connection') return { requestRejection: ({ headers }) => headers.test === 'owner' ? undefined : 401 }
      if (name === 'credentials') return {
        readRecord: async (key) => records.get(key),
        modifyRecord: async (key, mutate) => { const value = await mutate(records.get(key)); records.set(key, value); return value },
      }
      if (name === 'configEditor') return {
        entries: () => [entry],
        edit: async (_, change) => { entry.options.config = change(entry.options.config, {}) },
      }
      if (name === 'llm') return {
        registerAdapter: (_, value) => { liveAdapter = value; return () => { liveAdapter = null } },
        listProviders: () => liveAdapter || entry.options.config.providers['openai-codex'] ? [{ id: 'openai-codex' }] : [],
        listModels: async () => liveAdapter ? liveAdapter.listModels() : (entry.options.config.providers['openai-codex']?.models ?? [{ id: 'gpt-6.1-sol' }]).map((m) => ({ ...m, name: m.name ?? m.id })),
        resolveModelInfo: async () => ({ context: { contextWindow: 272000 }, reasoning: { efforts: [{ id: 'low' }] }, inputModalities: ['text', 'image'] }),
      }
      if (name === 'tools') return { register: (value) => { tool = value; return () => {} } }
    },
    effect(fn) { const off = fn(); effects.push(off); return off },
  }
  async function request(endpoint, headers = { test: 'owner' }, method = 'POST', body = '{}') {
    const req = Readable.from([Buffer.from(body)])
    req.headers = headers
    req.method = method
    req.url = '/codex-api/' + endpoint
    let status
    const result = deferred()
    const res = { writeHead: (code) => { status = code }, end: (value) => result.resolve({ status, body: value }) }
    await route.handler(req, res)
    return result.promise
  }
  try {
    await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'fake-refresh-secret', account_id: 'test-account' } }))
    globalThis.fetch = async (url) => {
      fetches++
      if (offline) throw new Error('offline')
      if (String(url).includes('/wham/usage')) {
        await usageGate.promise
        return { ok: true, status: 200, json: async () => ({ plan_type: 'prolite', account_id: 'test-account', rate_limit: { primary_window: { used_percent: 29 } }, credits: { balance: '0' } }) }
      }
      assert.match(String(url), /client_version=0\.171\.0/)
      return { ok: true, status: 200, json: async () => ({ models: [{ slug: 'gpt-6.2-astra', display_name: 'GPT-6.2 Astra' }] }) }
    }
    await mountBridge(ctx, { openStore, makeAdapter })
    assert.equal((await request('status', {})).status, 401)
    assert.equal((await request('status', { test: 'owner' }, 'GET')).status, 405)
    const initial = JSON.parse((await request('status')).body)
    assert.equal(initial.ok, true)
    assert.equal(initial.value.usage, null, 'first status is local, not blocked by the usage request')
    const refreshing = request('refresh')
    usageGate.resolve()
    const updated = JSON.parse((await refreshing).body).value
    assert.equal(updated.usage.planLabel, 'Pro Lite')
    assert.equal(updated.codexModels[0].id, 'gpt-6.2-astra')
    const count = fetches
    const cached = JSON.parse((await request('status')).body).value
    assert.equal(cached.usage.windows[0].usedPercent, 29)
    assert.equal(fetches, count, 'both quota and model discovery use the full snapshot cache')
    offline = true
    const stale = JSON.parse((await request('refresh')).body).value
    assert.equal(stale.usage.windows[0].usedPercent, 29)
    assert.equal(stale.usageError, 'offline')
    const setupText = (await request('setup')).body
    assert.ok(!setupText.includes(token))
    assert.ok(!setupText.includes('fake-refresh-secret'))
    assert.ok(!setupText.includes('access_token'))
    const config = entry.options.config.providers
    assert.deepEqual(config.other, { apiKeyEnv: 'UNRELATED_KEY' })
    assert.equal(config['openai-codex'], undefined, 'legacy duplicate route is migrated')
    assert.equal(savedBaseline.route.displayName, 'Personal Codex')
    assert.equal(savedBaseline.manual[0].overrides.contextWindow, 500000)
    assert.ok(liveAdapter)
    const toggled = JSON.parse((await request('setModelEnabled', { test: 'owner' }, 'POST', JSON.stringify({ payload: { model: 'gpt-6.2-astra', enabled: false } }))).body)
    assert.equal(toggled.ok, true)
    assert.equal(toggled.value.models.find((row) => row.id === 'gpt-6.2-astra').enabled, false)
    assert.equal((await liveAdapter.listModels()).some((row) => row.id === 'gpt-6.2-astra'), false)
    assert.equal(savedAccounts.get('test-account').preferences['gpt-6.2-astra'], false)
    const configuredBefore = JSON.stringify(config)
    await tool.execute({ action: 'setup' })
    assert.equal(JSON.stringify(config), configuredBefore, 'setup is idempotent')
    let rotations = 0
    const renewed = token.replace('test.', 'renewed.')
    globalThis.fetch = async (url, options) => {
      if (String(url).includes('/oauth/token')) {
        rotations++
        await turn()
        return { ok: true, status: 200, json: async () => ({ access_token: renewed, refresh_token: 'renewed-fake-secret' }) }
      }
      if (options.headers.Authorization === `Bearer ${token}`) return { ok: false, status: 401 }
      assert.equal(options.headers.Authorization, `Bearer ${renewed}`)
      return { ok: true, status: 200, json: async () => String(url).includes('/wham/usage')
        ? { plan_type: 'prolite', account_id: 'test-account', rate_limit: { primary_window: { used_percent: 30 } }, credits: { balance: '0' } }
        : { models: [{ slug: 'gpt-6.2-astra' }] } }
    }
    const renewedStatus = JSON.parse((await request('refresh')).body).value
    assert.equal(renewedStatus.usage.windows[0].usedPercent, 30)
    assert.equal(rotations, 1, 'parallel model/quota refresh shares one refresh-token rotation')
    assert.equal(JSON.parse((await request('unknown')).body).ok, false)
  } finally {
    for (const off of effects.reverse()) if (typeof off === 'function') await off()
    globalThis.fetch = savedFetch
    if (savedHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = savedHome
    // mkdtemp returned this test-owned absolute directory; only it is removed.
    assert.equal(directory.startsWith(join(tmpdir(), 'codex-bridge-test-')), true)
    await rm(directory, { recursive: true, force: true })
  }
})
