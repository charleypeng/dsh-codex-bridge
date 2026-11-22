/**
 * Codex bridge — Host half.
 *
 * Reads the Codex CLI credential file (`~/.codex/auth.json`), imports it into
 * the harness credential record that `@deepseek-ai/dsh-llm-pi-ai` reads for its
 * `openai-codex` route, and serves the account's quota, plan, and model
 * availability to the Web page over a Connection RPC channel.
 */

import { readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createStatusCache } from './status-cache.js'
import { createModelRegistry, legacyModels, normalizeCodexCatalog } from './model-registry.js'
import { openModelStore } from './model-store.js'
import { createLiveAdapter } from './live-adapter.js'

const PROVIDER = 'openai-codex'
const RECORD_KEY = 'llm-pi-ai/openai-codex'
const ROUTE_PATH = '/codex-api'
const PI_AI_ENTRY_ID = 'llm-pi-ai'

const USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
const MODELS_URL = 'https://chatgpt.com/backend-api/codex/models'
const TOKEN_URL = 'https://auth.openai.com/oauth/token'
const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const JWT_CLAIM_PATH = 'https://api.openai.com/auth'
const CLIENT_VERSION = '0.171.0'
const USAGE_TTL_MS = 30_000

export const name = 'codex-bridge'

export const inject = ['tools', 'connection', 'webServer', 'credentials', 'llm', 'configEditor', 'storageDomain', 'profileContext']

const PLANS = {
  free: 'Free', plus: 'Plus', pro: 'Pro', prolite: 'Pro Lite', team: 'Team',
  business: 'Business', enterprise: 'Enterprise', edu: 'Edu',
}

function codexHome() {
  const override = process.env.CODEX_HOME
  return override !== undefined && override.length > 0 ? override : join(homedir(), '.codex')
}

function authPath() {
  return join(codexHome(), 'auth.json')
}

async function readJsonBody(request) {
  return await new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', (chunk) => {
      size += chunk.length
      if (size > 65536) {
        reject(new Error('请求体超过 64KB'))
        request.destroy()
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(text))
      } catch (error) {
        reject(new Error(`请求体不是合法 JSON：${messageOf(error)}`))
      }
    })
    request.on('error', reject)
  })
}

function messageOf(error) {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : String(error)
}

function base64UrlJson(segment) {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/')
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8'))
}

/** Decode a JWT payload without verifying it; only display facts are read from it. */
function decodeJwt(token) {
  if (typeof token !== 'string') return null
  const parts = token.split('.')
  if (parts.length !== 3) return null
  try {
    return base64UrlJson(parts[1])
  } catch {
    return null
  }
}

function accountIdOf(accessToken) {
  const payload = decodeJwt(accessToken)
  const claim = payload?.[JWT_CLAIM_PATH]
  const accountId = claim?.chatgpt_account_id
  return typeof accountId === 'string' && accountId.length > 0 ? accountId : null
}

function expiresAtOf(accessToken) {
  const exp = decodeJwt(accessToken)?.exp
  return typeof exp === 'number' ? exp * 1000 : null
}

/** Read and normalize the Codex CLI credential file. */
async function readCodexAuth() {
  const path = authPath()
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    return { path, found: false, reason: messageOf(error), raw: null, tokens: null }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { path, found: true, reason: `auth.json 不是合法 JSON：${messageOf(error)}`, raw: null, tokens: null }
  }
  const tokens = raw?.tokens
  const access = typeof tokens?.access_token === 'string' ? tokens.access_token : null
  if (access === null) {
    return { path, found: true, reason: 'auth.json 中没有 OAuth 凭证（可能使用 API Key 登录）', raw, tokens: null }
  }
  return {
    path,
    found: true,
    reason: null,
    raw,
    tokens: {
      access,
      refresh: typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : null,
      idToken: typeof tokens?.id_token === 'string' ? tokens.id_token : null,
      accountId: typeof tokens?.account_id === 'string' ? tokens.account_id : accountIdOf(access),
      expiresAt: expiresAtOf(access),
      lastRefresh: typeof raw?.last_refresh === 'string' ? raw.last_refresh : null,
      authMode: typeof raw?.auth_mode === 'string' ? raw.auth_mode : null,
    },
  }
}

function grantPayload(tokens) {
  return {
    type: 'oauth',
    access: tokens.access,
    refresh: tokens.refresh,
    expires: tokens.expiresAt ?? 0,
    accountId: tokens.accountId,
  }
}

function sameGrant(left, right) {
  if (left === undefined || right === undefined) return false
  return left.type === right.type
    && left.access === right.access
    && left.refresh === right.refresh
    && left.expires === right.expires
    && left.accountId === right.accountId
}

async function readRecord(context) {
  const credentials = context.get('credentials')
  if (credentials === undefined) return { credentials: undefined, record: undefined }
  const record = await credentials.readRecord(RECORD_KEY)
  return { credentials, record }
}

async function writeRecord(context, payload) {
  const credentials = context.get('credentials')
  if (credentials === undefined) throw new Error('这个配置没有挂载凭证服务，无法写入 Codex 凭证')
  await credentials.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload }))
  return payload
}

/** The live Codex credential: the stored grant when present, otherwise an import from the file. */
async function currentCredential(context) {
  const { record } = await readRecord(context)
  const stored = record?.kind === 'grant' ? record.payload : undefined
  if (stored?.type === 'oauth' && typeof stored.access === 'string') {
    return { payload: stored, source: 'record', imported: false }
  }
  const auth = await readCodexAuth()
  if (auth.tokens === null) return { payload: null, source: 'none', auth, imported: false }
  const payload = grantPayload(auth.tokens)
  await writeRecord(context, payload)
  return { payload, source: 'file', auth, imported: true }
}

/** Import the file credential into the record, refusing to overwrite a newer stored grant. */
async function importCredential(context, options = {}) {
  const auth = await readCodexAuth()
  if (auth.tokens === null) {
    return { ok: false, changed: false, path: auth.path, reason: auth.reason ?? '没有可用的凭证', tokens: null }
  }
  const payload = grantPayload(auth.tokens)
  const { record } = await readRecord(context)
  const stored = record?.kind === 'grant' ? record.payload : undefined
  const storedExpiry = typeof stored?.expires === 'number' ? stored.expires : 0
  const fileExpiry = payload.expires ?? 0
  if (options.force !== true && sameGrant(stored, payload)) {
    return { ok: true, changed: false, path: auth.path, reason: null, auth: describeAuth(auth) }
  }
  if (options.force !== true && stored !== undefined && storedExpiry > fileExpiry + 60_000) {
    return {
      ok: true,
      changed: false,
      path: auth.path,
      reason: '已存凭证比 auth.json 更新，保留已存凭证',
      auth: describeAuth(auth),
    }
  }
  await writeRecord(context, payload)
  return { ok: true, changed: true, path: auth.path, reason: null, auth: describeAuth(auth) }
}

function requestHeaders(credential) {
  return {
    Authorization: `Bearer ${credential.access}`,
    'chatgpt-account-id': credential.accountId ?? '',
    originator: 'codex_cli_rs',
    'User-Agent': `codex_cli_rs/${CLIENT_VERSION}`,
    accept: 'application/json',
  }
}

const refreshFlights = new WeakMap()
async function refreshGrant(context, payload) {
  const active = refreshFlights.get(context)
  if (active) return active
  const work = refreshGrantOnce(context, payload).finally(() => {
    if (refreshFlights.get(context) === work) refreshFlights.delete(context)
  })
  refreshFlights.set(context, work)
  return work
}

async function refreshGrantOnce(context, payload) {
  if (typeof payload.refresh !== 'string' || payload.refresh.length === 0) {
    throw new Error('凭证已过期，且没有 refresh token，无法自动续期')
  }
  const response = await fetch(TOKEN_URL, {
    signal: AbortSignal.timeout(20_000),
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: payload.refresh,
      client_id: CLIENT_ID,
    }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`刷新 Codex 凭证失败（HTTP ${response.status}）${text.slice(0, 200)}`)
  }
  const json = await response.json()
  if (typeof json?.access_token !== 'string') throw new Error('刷新 Codex 凭证的响应缺少 access_token')
  const next = {
    type: 'oauth',
    access: json.access_token,
    refresh: typeof json.refresh_token === 'string' ? json.refresh_token : payload.refresh,
    expires: expiresAtOf(json.access_token) ?? 0,
    accountId: accountIdOf(json.access_token) ?? payload.accountId,
  }
  await writeRecord(context, next)
  await mirrorToFile(next)
  return next
}

/**
 * Write a refreshed grant back into the Codex CLI file so both clients keep one
 * refresh-token family. Best effort: the record stays authoritative.
 */
async function mirrorToFile(payload) {
  try {
    const auth = await readCodexAuth()
    if (auth.found !== true || auth.raw === null) return
    const next = {
      ...auth.raw,
      tokens: {
        ...auth.raw.tokens,
        access_token: payload.access,
        refresh_token: payload.refresh ?? auth.raw.tokens?.refresh_token,
        account_id: payload.accountId ?? auth.raw.tokens?.account_id,
      },
      last_refresh: new Date().toISOString(),
    }
    const path = authPath()
    const temporary = `${path}.codex-bridge-${process.pid}.tmp`
    await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
    await rename(temporary, path)
  } catch {
    // A read-only or relocated Codex home must not fail the quota request.
  }
}

/** Call an authenticated ChatGPT backend endpoint, refreshing once on 401. */
async function codexGet(context, url, options = {}) {
  const { payload } = await currentCredential(context)
  if (payload === null) throw new Error('没有找到 Codex 凭证，请先在 ~/.codex/auth.json 登录 Codex')
  let credential = payload
  const signal = options.signal ?? AbortSignal.timeout(20_000)
  let response = await fetch(url, { headers: requestHeaders(credential), signal })
  if (response.status === 401) {
    credential = await refreshGrant(context, credential)
    response = await fetch(url, { headers: requestHeaders(credential), signal })
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new Error(`Codex 接口返回 HTTP ${response.status}${text.length > 0 ? `：${text.slice(0, 300)}` : ''}`)
  }
  return { data: await response.json(), credential }
}

function normalizeWindows(rateLimit) {
  const windows = []
  for (const kind of ['primary_window', 'secondary_window']) {
    const window = rateLimit?.[kind]
    if (window === undefined || window === null) continue
    windows.push({
      kind: kind === 'primary_window' ? 'primary' : 'secondary',
      usedPercent: typeof window.used_percent === 'number' ? window.used_percent : null,
      windowSeconds: typeof window.limit_window_seconds === 'number' ? window.limit_window_seconds : null,
      resetAt: typeof window.reset_at === 'number' ? window.reset_at : null,
      resetAfterSeconds: typeof window.reset_after_seconds === 'number' ? window.reset_after_seconds : null,
    })
  }
  return windows
}

function normalizeUsage(raw) {
  const limit = raw?.rate_limit ?? {}
  const credits = raw?.credits ?? {}
  const models = {}
  for (const [id, entry] of Object.entries(raw?.model_usage ?? {})) {
    models[id] = {
      available: entry?.available === true,
      availableAt: typeof entry?.available_at === 'string' ? entry.available_at : null,
    }
  }
  return {
    planType: typeof raw?.plan_type === 'string' ? raw.plan_type : null,
    planLabel: PLANS[raw?.plan_type] ?? (typeof raw?.plan_type === 'string' ? raw.plan_type : null),
    email: typeof raw?.email === 'string' ? raw.email : null,
    accountId: typeof raw?.account_id === 'string' ? raw.account_id : null,
    allowed: limit.allowed !== false,
    limitReached: limit.limit_reached === true,
    reachedType: typeof raw?.rate_limit_reached_type === 'string' ? raw.rate_limit_reached_type : null,
    windows: normalizeWindows(limit),
    credits: {
      hasCredits: credits.has_credits === true,
      unlimited: credits.unlimited === true,
      balance: typeof credits.balance === 'string' ? credits.balance : null,
      overageLimitReached: credits.overage_limit_reached === true,
      approxLocalMessages: Array.isArray(credits.approx_local_messages) ? credits.approx_local_messages : null,
      approxCloudMessages: Array.isArray(credits.approx_cloud_messages) ? credits.approx_cloud_messages : null,
    },
    spendControlReached: raw?.spend_control?.reached === true,
    resetCredits: typeof raw?.rate_limit_reset_credits?.available_count === 'number'
      ? raw.rate_limit_reset_credits.available_count
      : null,
    models,
  }
}

async function fetchUsage(context, options) {
  const { data } = await codexGet(context, USAGE_URL, options)
  const usage = normalizeUsage(data)
  usage.fetchedAt = Date.now()
  return usage
}

/** Enumerate the models the account's Codex backend advertises, tolerating an empty or older answer. */
async function fetchCodexModels(context, options) {
  let version = CLIENT_VERSION
  try {
    // Codex updates this cache's client_version itself. Never import its prompts.
    const metadata = JSON.parse(await readFile(join(codexHome(), 'models_cache.json'), 'utf8'))
    if (/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(metadata.client_version)) version = metadata.client_version
  } catch { /* The installed CLI cache is optional. */ }
  const { data } = await codexGet(context, `${MODELS_URL}?client_version=${encodeURIComponent(version)}`, options)
  return normalizeCodexCatalog(data?.models)
}

function routeEntry(context) {
  const editor = context.get('configEditor')
  if (editor === undefined || typeof editor.entries !== 'function') return undefined
  for (const entry of editor.entries()) {
    if (entry?.options?.id === PI_AI_ENTRY_ID) return { editor, entry }
  }
  return undefined
}

function routeState(context) {
  const found = routeEntry(context)
  if (found === undefined) return { configurable: false, configured: false, providers: [] }
  const providers = found.entry.options?.config?.providers
  const names = providers !== undefined && providers !== null && typeof providers === 'object'
    ? Object.keys(providers)
    : []
  const live = context.get('llm')?.listProviders?.().some((row) => row.id === PROVIDER) === true
  return { configurable: true, configured: live || names.includes(PROVIDER), providers: [...new Set([...names, ...(live ? [PROVIDER] : [])])] }
}

async function listRuntimeModels(context, usage) {
  const llm = context.get('llm')
  if (llm === undefined || typeof llm.listModels !== 'function') return []
  let models
  try {
    models = await llm.listModels(PROVIDER)
  } catch {
    return []
  }
  const rows = []
  for (const model of models) {
    let info = {}
    try {
      info = await llm.resolveModelInfo(PROVIDER, model.id)
    } catch {
      info = {}
    }
    const account = usage?.models?.[model.id]
    rows.push({
      id: model.id,
      name: typeof model.name === 'string' ? model.name : model.id,
      contextWindow: typeof info?.context?.contextWindow === 'number' ? info.context.contextWindow : null,
      maxTokens: typeof info?.defaultMaxTokens === 'number' ? info.defaultMaxTokens : null,
      reasoning: info?.reasoning !== undefined && info?.reasoning !== null,
      reasoningEfforts: (info?.reasoning?.efforts ?? []).map((item) => ({ id: item.id, label: typeof item.name === 'string' ? item.name : item.id })),
      defaultReasoningEffort: info?.reasoning?.defaultEffort ?? null,
      input: info?.inputModalities ?? ['text', 'image'],
      image: Array.isArray(info?.inputModalities) ? info.inputModalities.includes('image') : null,
      available: account === undefined ? null : account.available,
    })
  }
  return rows
}

function describeAuth(auth) {
  if (auth === undefined || auth === null) return { found: false, path: authPath(), reason: null }
  return {
    found: auth.found === true && auth.tokens !== null,
    path: auth.path,
    reason: auth.reason ?? null,
    authMode: auth.tokens?.authMode ?? null,
    accountId: auth.tokens?.accountId ?? null,
    expiresAt: auth.tokens?.expiresAt ?? null,
    lastRefresh: auth.tokens?.lastRefresh ?? null,
    hasRefresh: typeof auth.tokens?.refresh === 'string',
  }
}

export async function apply(context) {
  return mountBridge(context)
}

/** Shared operation layer; dependencies can be replaced by deterministic unit fixtures. */
export async function mountBridge(context, { openStore = openModelStore, makeAdapter = createLiveAdapter } = {}) {
  const store = await openStore(context)
  let active = true
  let registry = null
  context.effect(() => async () => {
    active = false
    await registry?.close()
    await store.close()
  }, 'codex-bridge: durable model registry')
  let baseline = store.baseline()
  const existing = routeEntry(context)
  const previousRoute = existing?.entry.options?.config?.providers?.[PROVIDER]
  if (previousRoute !== undefined) {
    const runtime = await listRuntimeModels(context, null)
    baseline = { route: previousRoute, manual: legacyModels(previousRoute, runtime) }
    await store.saveBaseline(baseline)
  }
  baseline ??= { route: {}, manual: [] }
  registry = createModelRegistry({
    load: store.load, save: store.save,
    changed: () => { if (active) context.emit?.('llm/models-updated', PROVIDER) },
  })
  async function accountScope() {
    const { record } = await readRecord(context)
    const auth = await readCodexAuth()
    return record?.payload?.accountId ?? auth.tokens?.accountId ?? null
  }
  await registry.select(await accountScope(), baseline.manual)
  const adapter = await makeAdapter({
    context,
    getSnapshot: () => ({ ...registry.snapshot(), route: baseline.route }),
    accessToken: async () => {
      const { payload } = await currentCredential(context)
      if (payload === null) throw new Error('没有可用的 Codex 登录凭证')
      if (payload.expires && payload.expires < Date.now() + 60_000) return (await refreshGrant(context, payload)).access
      return payload.access
    },
  })
  let ownsRoute = false
  async function enableRoute() {
    if (ownsRoute) return { ok: true, configured: true, changed: false, reason: null }
    const found = routeEntry(context)
    const before = found?.entry.options?.config?.providers
    const old = before?.[PROVIDER]
    if (old !== undefined) {
      const survivors = Object.keys(before).filter((name) => name !== PROVIDER).sort()
      const expected = JSON.stringify(survivors.map((name) => [name, before[name]]))
      await found.editor.edit(found.entry, (current) => {
        const providers = { ...(current.providers ?? {}) }
        delete providers[PROVIDER]
        // Refuse a write that would drop an unrelated provider: the editor
        // validates this candidate, so a thrown error aborts before persisting.
        const kept = JSON.stringify(Object.entries(providers).sort(([left], [right]) => left.localeCompare(right)))
        if (kept !== expected) {
          throw new Error('Codex 路由迁移会改动其它模型供应商，已取消写入；请检查 llm-pi-ai 配置')
        }
        return { ...current, providers }
      })
    }
    try {
      context.effect(() => context.get('llm').registerAdapter([PROVIDER], adapter), 'codex-bridge: live model adapter')
      ownsRoute = true
      context.emit?.('llm/models-updated', PROVIDER)
    } catch (error) {
      if (old !== undefined) await found.editor.edit(found.entry, (current) => ({
        ...current, providers: { ...(current.providers ?? {}), [PROVIDER]: old },
      }))
      throw error
    }
    return { ok: true, configured: true, changed: true, reason: null }
  }
  // Startup must not write configuration inside Loader's HMR transaction.
  // A legacy route is migrated by the same setup operation used by UI and tools.
  // Following starts register directly because the saved pi-ai route is absent.
  if (previousRoute === undefined) await enableRoute()

  async function localSnapshot() {
    const auth = await readCodexAuth()
    const { record } = await readRecord(context)
    const stored = record?.kind === 'grant' && record.payload?.type === 'oauth' ? record.payload : null
    await registry.select(stored?.accountId ?? auth.tokens?.accountId ?? null, baseline.manual)
    const catalogState = registry.snapshot()
    const result = {
      auth: describeAuth(auth),
      credential: {
        stored: stored !== null,
        expiresAt: stored?.expires ?? null,
        accountId: stored?.accountId ?? null,
        fileExpiry: auth.tokens?.expiresAt ?? null,
      },
      route: routeState(context),
      usage: null,
      usageError: null,
      models: catalogState.models,
      catalogError: catalogState.catalogError,
      catalogUpdatedAt: catalogState.catalogUpdatedAt,
      codexModels: catalogState.models.filter((row) => row.source === 'codex').map(({ id, name }) => ({ id, name })),
    }
    return result
  }

  const cache = createStatusCache({
    ttlMs: USAGE_TTL_MS,
    local: localSnapshot,
    async refresh(base, previous) {
      const result = { ...base }
      const [usage, catalog] = await Promise.allSettled([
        fetchUsage(context), fetchCodexModels(context),
      ])
      if (usage.status === 'fulfilled') {
        result.usage = usage.value
      } else {
        result.usage = previous?.usage ?? null
        result.usageError = messageOf(usage.reason)
      }
      // Do not apply a response fetched for the previous account after a switch.
      const current = await localSnapshot()
      const expected = base.credential.accountId ?? base.auth.accountId
      if ((current.credential.accountId ?? current.auth.accountId) !== expected) {
        throw new Error('Codex 账号已切换，请刷新账号数据')
      }
      if (catalog.status === 'fulfilled') {
        await registry.sync(expected, catalog.value)
      } else {
        registry.failed(messageOf(catalog.reason))
      }
      const updated = registry.snapshot()
      result.models = updated.models.map((row) => ({ ...row, available: result.usage?.models?.[row.id]?.available ?? null }))
      result.codexModels = updated.models.filter((row) => row.source === 'codex').map(({ id, name }) => ({ id, name }))
      return {
        ...result, auth: current.auth, credential: current.credential, route: current.route,
        catalogError: updated.catalogError, catalogUpdatedAt: updated.catalogUpdatedAt,
      }
    },
  })
  context.effect(() => () => cache.dispose(), 'codex-bridge: status cache')

  const handlers = {
    async status() {
      // Return local/cached state now; revalidation runs in the background.
      return cache.read()
    },
    async refresh() {
      // Manual and quiet refreshes both preserve the last successful snapshot.
      return cache.read({ fresh: true })
    },
    async setModelEnabled(payload = {}) {
      await localSnapshot()
      await registry.setEnabled(payload.model, payload.enabled)
      return cache.read()
    },
    async setup() {
      const imported = await importCredential(context)
      if (imported.ok !== true) {
        return { imported, route: routeState(context), setup: { ok: false, reason: imported.reason } }
      }
      let route
      try {
        route = await enableRoute()
      } catch (error) {
        route = { ok: false, configured: false, reason: messageOf(error) }
      }
      cache.invalidate()
      return { imported, route, setup: { ok: route.ok === true, reason: route.reason ?? null } }
    },
    async importCredential() {
      const imported = await importCredential(context)
      cache.invalidate()
      return { imported, route: routeState(context) }
    },
    async enableRoute() {
      const route = await enableRoute()
      cache.invalidate()
      return { route, providers: routeState(context) }
    },
  }

  const connection = context.get('connection')
  const webServer = context.get('webServer')
  if (webServer !== undefined && typeof webServer.register === 'function') {
    context.effect(() => webServer.register({
      kind: 'prefix',
      path: ROUTE_PATH,
      handler: async (request, response) => {
        const rejection = typeof connection?.requestRejection === 'function'
          ? connection.requestRejection({ headers: request.headers })
          : 401
        if (rejection !== undefined) {
          response.writeHead(rejection)
          response.end(rejection === 401 ? 'unauthorized' : 'forbidden')
          return
        }
        if (request.method !== 'POST') {
          response.writeHead(405)
          response.end('method not allowed')
          return
        }
        let result
        try {
          const pathname = new URL(request.url ?? '/', 'http://localhost').pathname
          const endpoint = pathname.slice(ROUTE_PATH.length).replace(/^\/+/, '')
          const handler = Object.hasOwn(handlers, endpoint) ? handlers[endpoint] : undefined
          if (handler === undefined) {
            result = { ok: false, error: { code: 'UNKNOWN_ENDPOINT', message: `未知的 Codex 接口：${endpoint}`, details: {} } }
          } else {
            const body = await readJsonBody(request)
            result = { ok: true, value: await handler(body?.payload ?? {}) }
          }
        } catch (error) {
          result = { ok: false, error: { code: 'CODEX_BRIDGE_FAILED', message: messageOf(error), details: {} } }
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
        response.end(JSON.stringify(result))
      },
    }), 'codex-bridge: quota route')
  }

  const tools = context.get('tools')
  if (tools !== undefined && typeof tools.register === 'function') {
    context.effect(() => tools.register({
      name: 'codex_quota',
      description: 'Report the ChatGPT/Codex account quota behind the Codex credential file: plan, '
        + 'rolling usage windows, credits, reset credits, and which models the account can use right now. '
        + 'Use it when the user asks how much Codex allowance is left, what plan they are on, or which Codex models are available.',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['usage', 'models', 'setup', 'setModelEnabled'],
            description: 'usage (default) reports quota and plan; models lists the Codex models this account can select; '
              + 'setup imports the credential; setModelEnabled persistently enables or hides one model in the picker.',
          },
          model: { type: 'string', description: 'Model id from action=models; required with setModelEnabled.' },
          enabled: { type: 'boolean', description: 'Whether this model appears in the picker; required with setModelEnabled.' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['summary'],
          properties: { summary: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: value.summary }],
      },
      async execute(args) {
        if (args?.action === 'setModelEnabled') {
          const value = await handlers.setModelEnabled(args)
          const model = value.models.find((row) => row.id === args.model)
          return { summary: `${model?.name ?? args.model}：${model?.enabled ? '已启用' : '已关闭'}（模型选择器）` }
        }
        if (args?.action === 'setup') {
          const value = await handlers.setup()
          const lines = []
          if (value.imported?.ok === true) {
            lines.push(value.imported.changed ? '已导入 Codex 凭证。' : 'Codex 凭证已是最新，无需改写。')
          } else {
            lines.push(`导入凭证失败：${value.imported?.reason ?? '未知原因'}`)
          }
          if (value.route?.ok === true) {
            lines.push(value.route.changed ? '已启用 openai-codex 模型路由（会重启 pi-ai 插件）。' : '模型路由原本就已启用。')
          } else {
            lines.push(`启用模型路由失败：${value.route?.reason ?? '未知原因'}`)
          }
          return { summary: lines.join('\n') }
        }
        const status = await cache.read({ fresh: true })
        const lines = []
        if (status.usage === null) {
          lines.push(`Codex 额度不可用：${status.usageError ?? '没有找到 Codex 凭证'}`)
        } else {
          const usage = status.usage
          lines.push(`计划：${usage.planLabel ?? usage.planType ?? '未知'}`)
          for (const window of usage.windows) {
            const span = window.windowSeconds === null ? '' : ` / ${Math.round(window.windowSeconds / 3600)} 小时窗口`
            lines.push(`${window.kind === 'primary' ? '主额度' : '次额度'}：已用 ${window.usedPercent ?? '?'}%${span}`)
            if (window.resetAt !== null) lines.push(`  重置时间：${new Date(window.resetAt * 1000).toISOString()}`)
          }
          lines.push(usage.credits.unlimited ? 'Credits：无限' : `Credits 余额：${usage.credits.balance ?? '0'}`)
          if (usage.resetCredits !== null) lines.push(`可用重置券：${usage.resetCredits} 次`)
          if (usage.limitReached) lines.push('当前额度已用尽。')
        }
        if (args?.action === 'models') {
          if (status.models.length === 0) lines.push('当前没有可用的 Codex 模型路由。')
          for (const model of status.models) {
            const availability = model.available === null ? '' : model.available ? '（可用）' : '（账号不可用）'
            lines.push(`- ${model.name} (${model.id}) ${model.enabled ? '[已启用]' : '[已关闭]'}${availability}；档位：${model.reasoningEfforts.map((item) => item.id).join(', ') || '默认'}；默认：${model.defaultReasoningEffort ?? '服务端默认'}`)
          }
        }
        return { summary: lines.join('\n') }
      },
    }), 'codex-bridge: codex_quota tool')
  }
  context.effect(() => {
    // One initial discovery, then quiet periodic revalidation without agent turns.
    void cache.read({ fresh: true }).catch(() => {})
    const timer = setInterval(() => { void cache.read().catch(() => {}) }, 5 * 60_000)
    timer.unref?.()
    return () => clearInterval(timer)
  }, 'codex-bridge: automatic catalog refresh')
}
