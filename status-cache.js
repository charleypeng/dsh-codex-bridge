/** Single-flight stale-while-revalidate cache. Never removes good data on failure. */
export function createStatusCache({ local, refresh, ttlMs = 30_000, retryMs = 15_000, now = Date.now }) {
  let scope
  let value = null
  let at = 0
  let retryAt = 0
  let error = null
  let flight = null
  let generation = 0
  let disposed = false

  function selectScope(next) {
    if (next === scope) return
    scope = next
    generation++
    value = null
    at = 0
    retryAt = 0
    error = null
    flight = null
  }

  function decorate(data, cached) {
    return { ...data, cached, cacheUpdatedAt: at || null, usageError: error ?? data.usageError ?? null }
  }

  function update(base) {
    if (disposed) return Promise.resolve(decorate(value ?? base, true))
    if (flight !== null) return flight
    const started = generation
    const previous = value
    const work = Promise.resolve().then(() => refresh(base, previous)).then((next) => {
      if (disposed || started !== generation) return decorate(base, true)
      if (next.usageError) {
        // Preserve last good quota, but allow local route/model changes through.
        value = { ...next, usage: previous?.usage ?? next.usage }
        error = next.usageError
        retryAt = now() + retryMs
      } else {
        value = next
        at = now()
        error = null
        retryAt = 0
      }
      return decorate(value, Boolean(error))
    }).catch((cause) => {
      if (!disposed && started === generation) {
        error = cause instanceof Error ? cause.message : 'Codex refresh failed'
        retryAt = now() + retryMs
      }
      return decorate(value ?? base, true)
    }).finally(() => {
      if (flight === work) flight = null
    })
    flight = work
    return work
  }

  return {
    async read({ fresh = false } = {}) {
      const base = await local()
      selectScope(base.credential?.accountId ?? base.auth?.accountId ?? null)
      if (fresh) return update(base)
      const stale = value === null || now() - at >= ttlMs
      const cached = value === null ? base : {
        ...value, auth: base.auth, credential: base.credential, route: base.route,
        ...(Array.isArray(base.models) ? { models: base.models.map((row) => ({
          ...row, available: value.usage?.models?.[row.id]?.available ?? row.available ?? null,
        })) } : {}),
        ...(base.catalogError !== undefined ? { catalogError: base.catalogError, catalogUpdatedAt: base.catalogUpdatedAt, codexModels: base.codexModels } : {}),
      }
      const snapshot = decorate(cached, true)
      if (stale && now() >= retryAt) void update(base)
      return snapshot
    },
    invalidate() {
      generation++
      value = null
      at = 0
      retryAt = 0
      error = null
      flight = null
    },
    dispose() {
      disposed = true
      generation++
    },
  }
}
