/** Pure Codex catalog normalization and serialized, durable model preferences. */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/
const positive = (value) => Number.isSafeInteger(value) && value > 0 ? value : null
const text = (value, max = 180) => typeof value === 'string' ? value.slice(0, max) : null
const clone = (value) => JSON.parse(JSON.stringify(value))

export function normalizeCodexCatalog(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 500) throw new Error('Codex 返回空目录或异常目录，保留已有模型')
  const seen = new Set()
  const models = []
  for (const row of raw) {
    const id = row?.slug ?? row?.id
    if (typeof id !== 'string' || !ID.test(id)) continue
    if (row.visibility === 'hide' || row.visibility === 'hidden' || row.supported_in_api === false) continue
    if (seen.has(id)) continue
    seen.add(id)
    const efforts = []
    const unsupportedReasoningEfforts = []
    for (const entry of Array.isArray(row.supported_reasoning_levels) ? row.supported_reasoning_levels : []) {
      const effort = typeof entry === 'string' ? entry : entry?.effort
      if (typeof effort !== 'string' || !ID.test(effort) || efforts.some((item) => item.id === effort)) continue
      // User excludes Codex's ultra sub-agent orchestration mode. It is not a
      // selectable inference effort and must never be silently aliased to max.
      if (effort === 'ultra') continue
      efforts.push({ id: effort, label: effort.charAt(0).toUpperCase() + effort.slice(1) })
    }
    const preferred = typeof row.default_reasoning_level === 'string' ? row.default_reasoning_level : null
    const input = Array.isArray(row.input_modalities)
      ? row.input_modalities.filter((item) => item === 'text' || item === 'image') : ['text']
    models.push({
      id, name: text(row.display_name ?? row.name) ?? id,
      contextWindow: positive(row.context_window),
      input: input.length ? [...new Set(input)] : ['text'],
      reasoningEfforts: efforts, unsupportedReasoningEfforts,
      defaultReasoningEffort: efforts.some((item) => item.id === preferred) ? preferred : null,
      source: 'codex', catalogAvailable: true,
    })
  }
  if (models.length === 0) throw new Error('Codex 目录里没有可使用的模型，保留已有模型')
  return models
}

/** Preserve explicit settings, without persisting transport credentials in a catalog cache. */
export function legacyModels(route, runtime = []) {
  const explicit = Array.isArray(route.models) && route.models.length > 0
  const configured = explicit ? route.models : runtime
  return configured.filter((row) => typeof row?.id === 'string' && ID.test(row.id)).map((entry) => {
    const native = runtime.find((row) => row.id === entry.id) ?? {}
    const override = route.modelOverrides?.[entry.id] ?? {}
    const model = { ...native, ...entry, ...override }
    const customized = { ...(explicit ? entry : {}), ...override }
    const effortInput = Array.isArray(native.reasoningEfforts) ? native.reasoningEfforts : []
    const effortMap = model.reasoningEfforts && !Array.isArray(model.reasoningEfforts) ? model.reasoningEfforts : null
    const efforts = effortMap ? Object.entries(effortMap).filter(([, wire]) => wire !== null).map(([id]) => ({ id, label: id })) : effortInput
    return {
      id: model.id, name: model.name ?? model.id,
      contextWindow: positive(model.contextWindow), input: model.input ?? ['text', 'image'],
      reasoningEfforts: efforts, defaultReasoningEffort: native.defaultReasoningEffort ?? null,
      source: 'manual', catalogAvailable: false,
      // Known profile fields only; no server prompts, bearer tokens, or headers.
      overrides: Object.fromEntries(['contextWindow', 'maxTokens', 'name', 'input', 'compat'].filter((key) => customized[key] !== undefined).map((key) => [key, customized[key]])),
    }
  })
}

export function createModelRegistry({ load, save, changed = () => {}, now = Date.now }) {
  let account = null
  let state = { catalog: [], manual: [], preferences: {}, fetchedAt: null }
  let error = null
  let revision = 0
  let chain = Promise.resolve()
  let closed = false
  const serial = (task) => {
    const result = chain.then(() => { if (closed) throw new Error('Codex 模型目录已关闭'); return task() })
    chain = result.catch(() => {})
    return result
  }
  const all = () => {
    const known = new Set(state.catalog.map((row) => row.id))
    const rows = state.catalog.map((row) => {
      const original = state.manual.find((item) => item.id === row.id)
      return { ...row, ...(original?.overrides ?? {}), reasoningEfforts: row.reasoningEfforts, defaultReasoningEffort: row.defaultReasoningEffort, source: 'codex' }
    }).concat(state.manual.filter((row) => !known.has(row.id)))
    return rows.map((row) => ({
      ...row, enabled: state.preferences[row.id] !== false,
      reasoning: row.reasoningEfforts.length > 0, unsupportedReasoningEfforts: row.unsupportedReasoningEfforts ?? [], available: null,
    }))
  }
  return {
    async select(next, seed = []) {
      return serial(async () => {
        if (next === account) return
        const restored = next ? await load(next) : null
        account = next
        state = restored ?? { catalog: [], manual: clone(seed), preferences: {}, fetchedAt: null }
        error = null
        revision++
        changed()
      })
    },
    snapshot() { return { account, models: all(), catalogError: error, catalogUpdatedAt: state.fetchedAt, revision } },
    async sync(expectedAccount, catalog) {
      return serial(async () => {
        if (!expectedAccount || expectedAccount !== account) throw new Error('Codex 账号已切换，忽略旧模型目录')
        // Build from current preferences at commit time, never from fetch-start state.
        const next = { ...state, catalog: clone(catalog), fetchedAt: now() }
        await save(account, next)
        state = next
        error = null
        revision++
        changed()
        return this.snapshot()
      })
    },
    failed(message) { error = String(message).slice(0, 500) },
    async setEnabled(id, enabled) {
      return serial(async () => {
        if (!account) throw new Error('没有已登录的 Codex 账号')
        if (typeof id !== 'string' || !ID.test(id) || typeof enabled !== 'boolean') throw new Error('模型开关参数无效')
        if (!all().some((row) => row.id === id)) throw new Error('模型不在已缓存的 Codex 目录中，请先刷新目录')
        const next = { ...state, preferences: { ...state.preferences, [id]: enabled } }
        await save(account, next)
        state = next
        revision++
        changed()
        return this.snapshot()
      })
    },
    close() { closed = true; return chain },
  }
}
