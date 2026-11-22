import { createRequire } from 'node:module'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROVIDER = 'openai-codex'
const BASE_URL = 'https://chatgpt.com/backend-api'
const positive = (value, fallback) => Number.isSafeInteger(value) && value > 0 ? value : fallback
const copy = (value) => value === undefined ? undefined : structuredClone(value)
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze)
    Object.freeze(value)
  }
  return value
}

/** Resolve only public exports, anchored in the running Host, including ASAR installs. */
async function installedRuntime(context) {
  const anchor = context?.get('profileContext')?.installAnchor ?? (process.env.DSH_INSTALL_DIR && join(process.env.DSH_INSTALL_DIR, 'package.json'))
  if (!anchor || !isAbsolute(anchor)) throw new Error('Codex adapter requires the running DSH installation anchor')
  const require = createRequire(anchor)
  const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const { PiAiAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  // pi-ai is import-only and does not export package.json. Locate its manifest
  // through Node's installation-anchored package search, then honor ./api/*.
  const manifestPath = require.resolve.paths('@earendil-works/pi-ai')
    ?.map(base => join(base, '@earendil-works/pi-ai/package.json')).find(file => existsSync(file))
  if (!manifestPath) throw new Error('The installed public pi-ai package is unavailable')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const entry = manifest.exports?.['./api/*']
  const target = typeof entry === 'string' ? entry : entry?.import
  if (manifest.name !== '@earendil-works/pi-ai' || typeof target !== 'string' || !target.startsWith('./') || !target.includes('*')) {
    throw new Error('The installed pi-ai package does not publish the required API export')
  }
  const root = dirname(manifestPath)
  const apiPath = resolve(root, target.replaceAll('*', 'openai-codex-responses'))
  if (!apiPath.startsWith(root + sep)) throw new Error('Invalid public pi-ai API export target')
  const { stream } = await import(pathToFileURL(apiPath).href)
  return { ...llm, PiAiAdapter, stream }
}

/**
 * Host-owned OAuth remains outside this adapter. No credential files, ambient
 * environment keys, or pi-ai OAuth refresh are consulted here. Tests may inject
 * the public classes and a non-network low-level stream through runtime.
 */
export async function createLiveAdapter({ context, getSnapshot, accessToken, runtime }) {
  if (typeof getSnapshot !== 'function' || typeof accessToken !== 'function') throw new TypeError('Codex adapter requires snapshot and access-token callbacks')
  const api = runtime ?? await installedRuntime(context)
  const { LlmAdapter, PiAiAdapter, LlmError, stream: codexStream } = api
  if (typeof LlmAdapter !== 'function' || typeof PiAiAdapter !== 'function' || typeof codexStream !== 'function') throw new TypeError('Invalid Codex adapter runtime')
  const fail = (message, code) => {
    if (LlmError) throw new LlmError(message, code)
    throw Object.assign(new Error(message), { code })
  }
  const capture = () => {
    const snapshot = getSnapshot()
    if (!snapshot || !Array.isArray(snapshot.models)) fail('Codex model snapshot is unavailable', 'INVALID_CONFIG')
    return freeze({ models: copy(snapshot.models), route: copy(snapshot.route ?? {}) })
  }
  const owned = provider => { if (provider !== PROVIDER) fail('Codex adapter does not own this provider', 'NO_ADAPTER') }
  const rowOf = (snapshot, provider, model) => {
    owned(provider)
    const row = snapshot.models.find(row => row.id === model)
    if (!row) fail('Codex model is not in the saved catalog', 'UNKNOWN_MODEL')
    return row
  }
  const metadata = (snapshot, provider, model) => {
    const row = rowOf(snapshot, provider, model)
    const info = { provider, id: row.id, name: row.name ?? row.id, inputModalities: [...(row.input ?? ['text'])] }
    const contextWindow = positive(row.contextWindow, positive(snapshot.route.defaultContextWindow))
    if (contextWindow !== undefined) info.context = { contextWindow }
    const configured = snapshot.route.modelOverrides?.[model]?.maxTokens
      ?? snapshot.route.models?.find(item => item.id === model)?.maxTokens ?? row.maxTokens
    if (positive(configured) !== undefined) info.defaultMaxTokens = configured
    const efforts = row.reasoningEfforts ?? []
    if (efforts.length) info.reasoning = {
      efforts: efforts.map(({ id, label }) => ({ id, name: label ?? id })),
      ...(efforts.some(({ id }) => id === row.defaultReasoningEffort) ? { defaultEffort: row.defaultReasoningEffort } : {}),
    }
    const compat = { ...snapshot.route.compat, ...row.compat }
    if (compat.supportsMidConvoSystemMessages) {
      info.systemPromptUpdate = 'in-history'
      if (compat.supportsAdditionalTools || compat.supportsToolSearch) info.toolUpdate = 'addition-only'
    }
    return freeze(info)
  }
  const innerFor = (snapshot, effort) => {
    const route = snapshot.route
    const models = snapshot.models.map(row => ({
      id: row.id, name: row.name ?? row.id, provider: PROVIDER,
      api: 'openai-codex-responses', baseUrl: route.baseURL ?? BASE_URL,
      // Only the outer adapter owns reasoning. pi-ai's canonical levels must
      // never validate, rename, or clamp the actual Codex effort (e.g. ultra).
      reasoning: false, input: [...(row.input ?? ['text'])],
      contextWindow: positive(row.contextWindow, positive(route.defaultContextWindow, 1_000_000)),
      maxTokens: positive(row.maxTokens, positive(route.defaultMaxTokens, 128_000)),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      compat: { ...route.compat, ...row.compat },
    }))
    const dispatch = (model, converted, options) => codexStream(model, converted, { ...options, reasoningEffort: effort })
    const piProvider = {
      id: PROVIDER, name: route.displayName ?? 'OpenAI Codex', baseUrl: route.baseURL ?? BASE_URL,
      auth: { apiKey: {
        name: 'Host-resolved Codex access token',
        resolve: async ({ credential }) => credential?.key === undefined ? undefined : { auth: { apiKey: credential.key }, source: 'Host' },
      } },
      getModels: () => models, stream: dispatch, streamSimple: dispatch,
    }
    const profile = {
      ...route, provider: PROVIDER, displayName: piProvider.name, piProvider,
      // A legacy canonical default must not leak into inner validation.
      reasoning: undefined,
      streamIdleTimeoutMs: positive(route.streamIdleTimeoutMs, 300_000),
      maxRequestImageBytes: positive(route.maxRequestImageBytes, 20 * 1024 * 1024),
      maxRequestImages: positive(route.maxRequestImages, 50),
      imageOffloadCountQuantum: Math.min(positive(route.imageOffloadCountQuantum, 10), positive(route.maxRequestImages, 50)),
      requestImagePixelBudget: positive(route.requestImagePixelBudget, 2048 * 2048),
      requestImageMaxBytes: positive(route.requestImageMaxBytes, 1024 * 1024),
      retryPolicy: api.resolveRetryPolicy?.(route.retryPolicy, 'Codex adapter'),
      modelErrors: new Map(), configuredMaxTokens: new Map(),
    }
    const profiles = new Map([[PROVIDER, profile]])
    return new PiAiAdapter({
      profiles: () => profiles,
      resolveApiKey: async () => {
        const token = await accessToken({ provider: PROVIDER, route })
        if (typeof token !== 'string' || !token.trim()) fail('Codex access token is unavailable; sign in again', 'MISSING_CREDENTIAL')
        return token
      },
      // Never let pi-ai fall back to ambient credentials or its own OAuth store.
      auth: {
        credentials: { read: async () => undefined, list: async () => [], modify: async () => { throw new Error('Codex OAuth is owned by the Host') }, delete: async () => {} },
        authContext: { env: async () => undefined, fileExists: async () => false },
      },
      resolveAttachments: () => context?.get('attachments'),
      resolveImageAccess: (attachments, ref) => api.resolveImageAttachmentAccess?.(
        attachments, hostPath => context?.get('fs')?.processPathFromHostPath(hostPath), ref,
      ),
    })
  }
  const run = (snapshot, options, selected) => {
    if (selected && (selected.provider !== options.provider || selected.model !== options.model)) fail('Prepared Codex call model does not match', 'INVALID_PREPARED_CALL')
    const row = rowOf(snapshot, options.provider, options.model)
    const effort = options.reasoningEffort ?? row.defaultReasoningEffort ?? undefined
    if (effort !== undefined && !(row.reasoningEfforts ?? []).some(item => item.id === effort)) {
      fail('Codex model does not support the selected reasoning effort', 'UNSUPPORTED_REASONING_EFFORT')
    }
    // Per-stream closure, not a mutable effort shared by concurrent requests.
    return innerFor(snapshot, effort).stream({ ...options, reasoningEffort: undefined })
  }
  return new class extends LlmAdapter {
    providerInfo(provider) { owned(provider); return { id: provider, name: capture().route.displayName ?? 'OpenAI Codex' } }
    providerRetryPolicy(provider) { owned(provider); return api.resolveRetryPolicy?.(capture().route.retryPolicy, 'Codex adapter') }
    async listModels(provider) {
      owned(provider)
      return capture().models.filter(row => row.enabled !== false).map(row => ({ provider, id: row.id, name: row.name ?? row.id, inputModalities: [...(row.input ?? ['text'])] }))
    }
    async resolveModel(provider, model, signal) { signal?.throwIfAborted(); return metadata(capture(), provider, model) }
    async prepareCall(provider, model, signal) {
      signal?.throwIfAborted()
      const snapshot = capture()
      return Object.freeze({ model: metadata(snapshot, provider, model), stream: options => run(snapshot, options, { provider, model }) })
    }
    stream(options) { return run(capture(), options) }
    imageRequestTarget(provider, model, image) {
      const snapshot = capture()
      rowOf(snapshot, provider, model)
      return innerFor(snapshot).imageRequestTarget(provider, model, image)
    }
  }()
}
