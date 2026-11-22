import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mountBridge } from '../index.js'

const token = `test.${Buffer.from(JSON.stringify({ exp: 2000000000, 'https://api.openai.com/auth': { chatgpt_account_id: 'guard-account' } })).toString('base64url')}.signature`

async function harness({ staleCurrent }) {
  const directory = await mkdtemp(join(tmpdir(), 'codex-bridge-guard-'))
  await writeFile(join(directory, 'auth.json'), JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'guard-refresh', account_id: 'guard-account' } }))
  const original = { providers: {
    'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    openai: { apiKeyEnv: 'OPENAI_API_KEY' },
    'openai-codex': {},
  } }
  const entry = { options: { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai', config: structuredClone(original) } }
  let route, writes = 0, live = null
  const ctx = {
    get(name) {
      if (name === 'webServer') return { register: (value) => { route = value; return () => {} } }
      if (name === 'connection') return { requestRejection: () => undefined }
      if (name === 'credentials') return {
        readRecord: async () => ({ kind: 'grant', payload: { type: 'oauth', access: token, refresh: 'guard-refresh', expires: 2_000_000_000_000, accountId: 'guard-account' } }),
        modifyRecord: async () => undefined,
      }
      if (name === 'configEditor') return {
        entries: () => [entry],
        edit: async (_, change) => {
          const next = change(authStore, {})
          writes++
          entry.options.config = next
        },
      }
      if (name === 'llm') return {
        registerAdapter: (_, value) => { live = value; return () => {} },
        listProviders: () => live ? [{ id: 'openai-codex' }] : [],
        listModels: async () => [],
        resolveModelInfo: async () => ({}),
      }
      if (name === 'tools') return { register: () => () => {} }
    },
    effect(fn) { return fn() },
    emit() {},
  }
  // The editor hands its callback a detached config; `staleCurrent` simulates a
  // loader view that lost providers, which must abort instead of persisting.
  const authStore = staleCurrent ?? entry.options.config
  const store = {
    baseline: () => null, saveBaseline: async () => {},
    load: async () => null, save: async () => {}, close: async () => {},
  }
  await mountBridge(ctx, { openStore: async () => store, makeAdapter: async () => ({ listModels: async () => [] }) })
  async function request(endpoint) {
    const req = Readable.from([Buffer.from('{}')])
    req.headers = {}
    req.method = 'POST'
    req.url = '/codex-api/' + endpoint
    let status
    let body
    const done = new Promise((resolve) => { body = resolve })
    await route.handler(req, { writeHead: (code) => { status = code }, end: (value) => { body(value); } })
    return { status, body: await done }
  }
  return { entry, original, request, writes: () => writes, live: () => live, cleanup: () => rm(directory, { recursive: true, force: true }), directory }
}

test('a stale editor view cannot drop unrelated providers, and the route stays registered', async () => {
  const h = await harness({ staleCurrent: { providers: {} } })
  try {
    const result = JSON.parse((await h.request('setup')).body)
    assert.equal(result.ok, true, 'the RPC envelope succeeds')
    assert.equal(result.value.setup.ok, false, 'the guarded migration must abort visibly')
    assert.match(result.value.route.reason, /其它模型供应商/)
    assert.deepEqual(h.entry.options.config, h.original, 'profile config is untouched')
    assert.equal(h.writes(), 0)
    // The live adapter is only registered after a successful migration, so the
    // legacy pi-ai row still serves the route for this account.
    assert.equal(h.live(), null)
  } finally { await h.cleanup() }
})

test('a matching view migrates only the Codex provider', async () => {
  const h = await harness({})
  try {
    const result = JSON.parse((await h.request('setup')).body)
    assert.equal(result.ok, true)
    assert.deepEqual(Object.keys(h.entry.options.config.providers).sort(), ['openai', 'opencode-go'])
    assert.deepEqual(h.entry.options.config.providers.openai, { apiKeyEnv: 'OPENAI_API_KEY' })
    assert.ok(h.live())
  } finally { await h.cleanup() }
})
