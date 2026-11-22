window.__ModuleLoader__.load({
  id: '@charleypeng/dsh-codex-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useMemo, useCallback, useRef } = React

    const NS = 'codex.bridge'
    const ROUTE = '/codex-api'
    const CACHE_KEY = 'codex.bridge.display.v1'
    const CACHE_TTL = 24 * 60 * 60 * 1000

    // Only display fields cross the cache boundary, never a Host response or raw auth.
    function displaySnapshot(value) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return null
      if (!value.auth || typeof value.auth !== 'object' || Array.isArray(value.auth)
        || !value.route || typeof value.route !== 'object' || Array.isArray(value.route) || !Array.isArray(value.models)) return null
      const text = (input, max = 160) => typeof input === 'string' ? input.slice(0, max) : null
      const number = (input) => typeof input === 'number' && Number.isFinite(input) ? input : null
      const masked = (input) => {
        if (typeof input !== 'string' || input.length === 0) return null
        if (/^.{6}….{4}$/u.test(input)) return input
        return input.length > 10 ? input.slice(0, 6) + '…' + input.slice(-4) : '••••'
      }
      const usage = value.usage && typeof value.usage === 'object' ? value.usage : null
      return {
        auth: {
          found: value.auth.found === true,
          accountMasked: masked(value.auth.accountMasked ?? value.auth.accountId),
          authMode: ['chatgpt', 'oauth', 'api_key'].includes(value.auth.authMode) ? value.auth.authMode : null,
        },
        route: { configured: value.route.configured === true, configurable: value.route.configurable === true },
        usage: usage === null ? null : {
          planLabel: text(usage.planLabel, 80),
          fetchedAt: number(usage.fetchedAt),
          limitReached: usage.limitReached === true,
          windows: (Array.isArray(usage.windows) ? usage.windows : []).slice(0, 8)
            .filter((item) => item && ['primary', 'secondary'].includes(item.kind))
            .map((item) => ({
              kind: item.kind, usedPercent: number(item.usedPercent), windowSeconds: number(item.windowSeconds),
              resetAt: number(item.resetAt), resetAfterSeconds: number(item.resetAfterSeconds),
            })),
          credits: {
            unlimited: usage.credits?.unlimited === true,
            balance: typeof usage.credits?.balance === 'string' && /^-?\d+(?:\.\d+)?$/.test(usage.credits.balance)
              ? usage.credits.balance.slice(0, 40) : null,
          },
          resetCredits: number(usage.resetCredits),
        },
        models: value.models.slice(0, 200).filter((item) => item && typeof item.id === 'string').map((item) => ({
          id: text(item.id), name: text(item.name) ?? text(item.id),
          // v1 caches listed only enabled runtime models. Keep those readable.
          enabled: item.enabled !== false,
          contextWindow: number(item.contextWindow), reasoning: item.reasoning === true,
          input: (Array.isArray(item.input) ? item.input : []).filter((value) => value === 'text' || value === 'image').slice(0, 2),
          available: typeof item.available === 'boolean' ? item.available : null,
          reasoningEfforts: (Array.isArray(item.reasoningEfforts) ? item.reasoningEfforts : []).slice(0, 32)
            .map((effort) => typeof effort === 'string' ? { id: effort, label: effort } : effort)
            .filter((effort) => effort && typeof effort.id === 'string' && effort.id.length > 0)
            .map((effort) => ({ id: text(effort.id), label: text(effort.label) ?? text(effort.id) })),
          defaultReasoningEffort: text(item.defaultReasoningEffort),
          unsupportedReasoningEfforts: (Array.isArray(item.unsupportedReasoningEfforts) ? item.unsupportedReasoningEfforts : [])
            .filter((effort) => typeof effort === 'string').slice(0, 32).map((effort) => text(effort)),
          source: ['codex', 'manual', 'legacy'].includes(item.source) ? item.source : 'legacy',
          catalogAvailable: item.catalogAvailable === true,
        })),
        catalogError: text(value.catalogError, 500),
        catalogUpdatedAt: number(value.catalogUpdatedAt),
      }
    }

    function createDisplayCache(storage = () => window.sessionStorage, now = () => Date.now()) {
      let memory = null
      function valid(record) {
        if (record?.version !== 1 || !Number.isFinite(record.savedAt)) return null
        if (record.savedAt > now() || now() - record.savedAt >= CACHE_TTL) return null
        const data = displaySnapshot(record.data)
        return data === null ? null : { version: 1, savedAt: record.savedAt, data }
      }
      return {
        read() {
          memory = valid(memory)
          if (memory !== null) return memory
          try { memory = valid(JSON.parse(storage()?.getItem(CACHE_KEY) ?? 'null')) } catch { /* blocked or malformed storage */ }
          return memory
        },
        write(value) {
          const data = displaySnapshot(value)
          if (data === null) return null
          // An old Host usage snapshot must not acquire another 24 hours on each open.
          const fetchedAt = data.usage?.fetchedAt
          const savedAt = Number.isFinite(fetchedAt) ? Math.min(now(), fetchedAt) : now()
          memory = valid({ version: 1, savedAt, data })
          if (memory !== null) {
            try { storage()?.setItem(CACHE_KEY, JSON.stringify(memory)) } catch { /* memory cache still works */ }
          }
          return memory
        },
      }
    }

    function initialDisplayState(cache) {
      const cached = cache.read()
      return { phase: cached ? 'ready' : 'loading', data: cached?.data ?? null, stale: Boolean(cached), error: null, refreshing: false,
        pendingModels: [], modelFeedback: [] }
    }

    // Shared per activation: dedupe mounts/manual/timer refreshes, and invalidate
    // pending reads around credential/route mutations so old responses cannot win.
    function createDisplayLoader(cache, request) {
      let state = initialDisplayState(cache)
      let revision = 0
      let inFlight = null
      // Full status responses must be committed in write order, even when users
      // toggle different rows quickly. Only the submitted row is disabled.
      let mutations = Promise.resolve()
      const listeners = new Set()
      const publish = (next) => { state = next; for (const listener of listeners) listener(state) }
      return {
        snapshot() {
          // Do not let a closed page keep an expired cache alive indefinitely.
          if (!listeners.size && !state.pendingModels.length && state.data !== null && cache.read() === null) state = initialDisplayState(cache)
          return state
        },
        subscribe(listener) {
          listeners.add(listener)
          listener(state)
          return () => { listeners.delete(listener) }
        },
        invalidate() { revision += 1; inFlight = null },
        setModelEnabled(model, enabled) {
          if (typeof enabled !== 'boolean' || !state.data?.models.some((item) => item.id === model)
            || state.pendingModels.includes(model)) return Promise.resolve(false)
          revision += 1
          inFlight = null
          publish({ ...state, refreshing: false, pendingModels: [...state.pendingModels, model],
            modelFeedback: state.modelFeedback.filter((item) => item.id !== model) })
          const task = mutations.then(async () => {
            try {
              const value = await request('setModelEnabled', { model, enabled })
              const data = displaySnapshot(value)
              if (data === null || !value.models.some((item) => item?.id === model && item.enabled === enabled)) {
                throw new Error('Invalid Codex model response')
              }
              // Invalidate again: a read that began during another mutation must
              // never replace this authoritative complete status snapshot.
              revision += 1
              inFlight = null
              cache.write(data)
              publish({ ...state, phase: 'ready', data, stale: Boolean(value.usageError) || value.cached === true,
                error: value.usageError ? String(value.usageError) : null, refreshing: false,
                modelFeedback: [...state.modelFeedback.filter((item) => item.id !== model), { id: model, enabled, error: null }] })
              return true
            } catch (error) {
              revision += 1
              inFlight = null
              // Pessimistic commit: leave the prior checked value and cache
              // untouched on failure, with an inline, retryable error.
              publish({ ...state, refreshing: false,
                modelFeedback: [...state.modelFeedback.filter((item) => item.id !== model), {
                  id: model, error: error instanceof Error ? error.message : String(error),
                }] })
              return false
            } finally {
              publish({ ...state, pendingModels: state.pendingModels.filter((id) => id !== model) })
            }
          })
          mutations = task.then(() => {})
          return task
        },
        refresh() {
          // A mutation returns the complete status itself. Do not race it or
          // follow it with a redundant refresh (including timers/reopened pages).
          if (state.pendingModels.length) return mutations
          if (inFlight !== null) return inFlight
          const currentRevision = ++revision
          publish({ ...state, refreshing: true, stale: state.data !== null })
          const task = Promise.resolve().then(() => request('refresh')).then((value) => {
            if (currentRevision !== revision) return
            let data = displaySnapshot(value)
            if (data === null) throw new Error('Invalid Codex response')
            const failed = Boolean(value.usageError)
            // Never borrow usage from another account. Preserve the last good
            // display if a partial failed response omits its usage/model fields.
            const previous = state.data
            if (failed && previous?.auth.accountMasked === data.auth.accountMasked) {
              data = { ...data, usage: data.usage ?? previous.usage,
                models: data.models.length ? data.models : previous.models }
            }
            if (!failed) cache.write(data)
            publish({ ...state, phase: 'ready', data, stale: failed || value.cached === true, error: failed ? String(value.usageError) : null, refreshing: false })
          }).catch((error) => {
            if (currentRevision !== revision) return
            publish({ ...state, phase: state.data === null ? 'error' : 'ready', stale: state.data !== null,
              error: error instanceof Error ? error.message : String(error), refreshing: false })
          }).finally(() => {
            if (currentRevision === revision) inFlight = null
          })
          inFlight = task
          return task
        },
      }
    }

    const displayCache = createDisplayCache()

    const EN = {
      nav: 'Codex',
      title: 'Codex models and quota',
      description: 'Sign in through your local Codex credentials, use Codex models in DSH, and watch the allowance they consume.',
      credentialSection: 'Credential',
      credentialFile: 'Credential file',
      credentialStatus: 'Status',
      credentialAccount: 'Account',
      credentialMode: 'Sign-in mode',
      connected: 'Connected',
      missing: 'Not available',
      noCredential: 'No OAuth credential in the file',
      routeSection: 'Model route',
      routeReady: 'Enabled',
      routeMissing: 'Not enabled',
      routeHint: 'Codex models appear in the model picker once the route is enabled.',
      usageSection: 'Allowance',
      usageUnavailable: 'Allowance data is unavailable.',
      used: 'used',
      remaining: 'remaining',
      primaryWindow: 'Primary window',
      secondaryWindow: 'Secondary window',
      windowLength: 'Window',
      windowHours: 'hours',
      resetsAt: 'Resets',
      resetsIn: 'Reset in',
      credits: 'Credits',
      creditsBalance: 'Balance',
      creditsUnlimited: 'Unlimited',
      resetCredits: 'Reset coupons',
      limitReached: 'The allowance is used up.',
      modelsSection: 'Models',
      modelsEmpty: 'No models in the directory yet. Import the credential and refresh the catalog.',
      modelPicker: 'Model picker',
      modelHint: 'Switches control model picker availability, not account allowance. You can turn all models off; history and manual settings are kept.',
      modelEnabled: 'Enabled',
      modelDisabled: 'Disabled',
      modelSaving: 'Saving…',
      modelEnableLabel: 'Enable in model picker',
      modelSavedEnabled: 'Enabled in the model picker.',
      modelSavedDisabled: 'Disabled in the model picker; history and settings kept.',
      modelSaveFailed: 'Could not save. The previous setting is unchanged. Try the switch again.',
      quotaAvailable: 'Quota: available',
      quotaUnavailable: 'Quota: unavailable',
      quotaUnknown: 'Quota: unknown',
      catalogError: 'Catalog refresh failed; showing known models.',
      catalogMissing: 'Not in the current catalog',
      sourceCodex: 'Codex catalog',
      sourceManual: 'Manual',
      sourceLegacy: 'Legacy',
      effortDefault: 'default',
      effortsUnsupported: 'Unsupported efforts',
      available: 'Available',
      unavailable: 'Not available',
      unknown: 'Unknown',
      context: 'Context',
      reasoning: 'Reasoning',
      yes: 'Yes',
      actionSetup: 'Import credential and enable',
      actionImport: 'Read credential again',
      actionEnable: 'Enable route',
      actionRefresh: 'Refresh',
      working: 'Working…',
      updated: 'Updated',
      errorTitle: 'Something went wrong',
      retry: 'Try again',
      setupDone: 'Imported the credential and enabled the Codex route.',
      importDone: 'Read the credential file again.',
      enableDone: 'Enabled the Codex route.',
      unchanged: 'Nothing changed.',
      reloadHint: 'Reload the session to see the new models in the picker.',
      noConnection: 'The Host connection is unavailable, so the page cannot read Codex data.',
      plan: 'Plan',
      textInput: 'Text',
      imageInput: 'Image',
      defaultTag: 'Default',
      unitDay: 'd',
      unitHour: 'h',
      unitMinute: 'm',
      cachedData: 'Cached data',
      refreshing: 'Updating in the background…',
      staleData: 'Showing previous data; refresh failed.',
      loadingData: 'Loading Codex data…',
      localCredential: 'Local Codex credential file',
    }

    const ZH = {
      nav: 'Codex',
      title: 'Codex 模型与额度',
      description: '使用本机 Codex 的登录凭证，在 DSH 里选择 Codex 模型，并查看额度消耗。',
      credentialSection: '凭证',
      credentialFile: '凭证文件',
      credentialStatus: '状态',
      credentialAccount: '账号',
      credentialMode: '登录方式',
      connected: '已连接',
      missing: '不可用',
      noCredential: '文件里没有 OAuth 凭证',
      routeSection: '模型路由',
      routeReady: '已启用',
      routeMissing: '未启用',
      routeHint: '启用路由后，Codex 模型会出现在模型选择器里。',
      usageSection: '额度',
      usageUnavailable: '额度数据不可用。',
      used: '已用',
      remaining: '剩余',
      primaryWindow: '主额度窗口',
      secondaryWindow: '次额度窗口',
      windowLength: '窗口长度',
      windowHours: '小时',
      resetsAt: '重置时间',
      resetsIn: '距重置',
      credits: '额外额度',
      creditsBalance: '余额',
      creditsUnlimited: '无限',
      resetCredits: '重置券',
      limitReached: '当前额度已用尽。',
      modelsSection: '模型',
      modelsEmpty: '目录中还没有模型，请先导入凭证并刷新模型目录。',
      modelPicker: '模型选择器',
      modelHint: '开关仅控制模型选择器中的可选性，不代表账号额度。可全部关闭；历史和手动配置都会保留。',
      modelEnabled: '已启用',
      modelDisabled: '已停用',
      modelSaving: '正在保存…',
      modelEnableLabel: '在模型选择器中启用',
      modelSavedEnabled: '已在模型选择器中启用。',
      modelSavedDisabled: '已在模型选择器中停用，历史与配置已保留。',
      modelSaveFailed: '保存失败，已保留原设置。可再次操作开关重试。',
      quotaAvailable: '账号额度：可用',
      quotaUnavailable: '账号额度：不可用',
      quotaUnknown: '账号额度：未知',
      catalogError: '模型目录刷新失败，继续显示已知模型。',
      catalogMissing: '不在当前目录中',
      sourceCodex: 'Codex 目录',
      sourceManual: '手动配置',
      sourceLegacy: '旧配置',
      effortDefault: '默认',
      effortsUnsupported: '不支持的推理档位',
      available: '可用',
      unavailable: '账号不可用',
      unknown: '未知',
      context: '上下文',
      reasoning: '推理',
      yes: '支持',
      actionSetup: '导入凭证并启用',
      actionImport: '重新读取凭证',
      actionEnable: '启用模型路由',
      actionRefresh: '刷新',
      working: '处理中…',
      updated: '更新于',
      errorTitle: '出错了',
      retry: '重试',
      setupDone: '已导入凭证并启用 Codex 路由。',
      importDone: '已重新读取凭证文件。',
      enableDone: '已启用 Codex 路由。',
      unchanged: '没有变化。',
      reloadHint: '重载会话后即可在模型选择器里看到新模型。',
      noConnection: 'Host 连接不可用，页面读不到 Codex 数据。',
      plan: '计划',
      textInput: '文本',
      imageInput: '图片',
      defaultTag: '默认',
      unitDay: '天',
      unitHour: '小时',
      unitMinute: '分',
      cachedData: '缓存数据',
      refreshing: '正在后台更新…',
      staleData: '刷新失败，继续显示上次数据。',
      loadingData: '正在加载 Codex 数据…',
      localCredential: '本机 Codex 凭证文件',
    }

    const CSS = [
      '.cbx-page{display:flex;flex-direction:column;gap:16px;padding:2px 0 24px;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.6}',
      '.cbx-head{display:flex;flex-direction:column;gap:4px}',
      '.cbx-title{font-size:15px;font-weight:600;margin:0}',
      '.cbx-desc{margin:0;color:var(--dsw-alias-label-secondary);font-size:12.5px}',
      '.cbx-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);padding:14px 16px;display:flex;flex-direction:column;gap:10px}',
      '.cbx-cardhead{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.cbx-cardtitle{font-size:13px;font-weight:600;margin:0}',
      '.cbx-row{display:flex;align-items:baseline;justify-content:space-between;gap:16px}',
      '.cbx-key{color:var(--dsw-alias-label-secondary);flex:0 0 auto}',
      '.cbx-val{text-align:right;word-break:break-word;font-variant-numeric:tabular-nums}',
      '.cbx-mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.cbx-pill{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:1px 9px;font-size:12px;border:1px solid var(--dsw-alias-border-l1)}',
      '.cbx-ok{color:var(--dsw-alias-state-success-primary)}',
      '.cbx-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.cbx-bad{color:var(--dsw-alias-state-error-primary)}',
      '.cbx-idle{color:var(--dsw-alias-label-secondary)}',
      '.cbx-actions{display:flex;flex-wrap:wrap;gap:8px}',
      '.cbx-btn{appearance:none;cursor:pointer;border-radius:8px;padding:5px 12px;font-size:12.5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}',
      '.cbx-btn:hover:not(:disabled){border-color:var(--dsw-alias-border-l2)}',
      '.cbx-btn:disabled{opacity:.55;cursor:default}',
      '.cbx-primary{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.cbx-meter{display:flex;flex-direction:column;gap:6px}',
      '.cbx-meterhead{display:flex;align-items:baseline;justify-content:space-between;gap:12px}',
      '.cbx-pct{font-size:24px;font-weight:600;font-variant-numeric:tabular-nums;line-height:1.2}',
      '.cbx-track{height:8px;border-radius:999px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;border:1px solid var(--dsw-alias-border-l1)}',
      '.cbx-fill{height:100%;border-radius:999px;background:var(--dsw-alias-brand-primary)}',
      '.cbx-fillwarn{height:100%;border-radius:999px;background:var(--dsw-alias-state-warn-primary)}',
      '.cbx-fillbad{height:100%;border-radius:999px;background:var(--dsw-alias-state-error-primary)}',
      '.cbx-model{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:10px 18px;padding:14px 2px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.cbx-model:first-of-type{border-top:none}',
      '.cbx-modelmain{display:flex;flex-direction:column;gap:7px;min-width:0}',
      '.cbx-modeltitle{display:flex;align-items:center;flex-wrap:wrap;gap:8px;min-width:0}',
      '.cbx-modelicon{display:inline-flex;align-items:center;justify-content:center;flex:none;width:22px;height:22px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary)}',
      '.cbx-modelname{font-size:13.5px;font-weight:600;line-height:1.3;color:var(--dsw-alias-label-primary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}',
      '.cbx-tag{display:inline-flex;align-items:center;gap:4px;height:19px;padding:0 7px;border-radius:999px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1;white-space:nowrap}',
      '.cbx-tag-accent{border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}',
      '.cbx-tag-ok{color:var(--dsw-alias-state-success-primary)}',
      '.cbx-tag-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.cbx-metarow{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;color:var(--dsw-alias-label-tertiary)}',
      '.cbx-metaitem{display:inline-flex;align-items:center;gap:4px;min-width:0}',
      '.cbx-metaid{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:34ch}',
      '.cbx-efforts{display:flex;align-items:center;flex-wrap:wrap;gap:4px}',
      '.cbx-chip{display:inline-flex;align-items:center;height:19px;padding:0 8px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:1}',
      '.cbx-chip-on{border-color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.cbx-aside{display:flex;flex-direction:column;align-items:flex-end;gap:8px;flex:none}',
      '@media (max-width:520px){.cbx-model{grid-template-columns:minmax(0,1fr)}.cbx-aside{flex-direction:row;align-items:center;justify-content:space-between;width:100%}}',
      // Switch matches the Settings page control: 36x20 pill, 16px white thumb,
      // inverting to the primary label color when on.
      '.cbx-switch{appearance:none;display:inline-flex;align-items:center;justify-content:center;flex:none;width:36px;height:20px;padding:0;border:0;border-radius:999px;background:transparent;cursor:pointer}',
      '.cbx-switchtrack{position:relative;display:block;width:36px;height:20px;border-radius:999px;background:var(--dsw-alias-border-l2);transition:background-color 160ms var(--ds-ease-in-out)}',
      '.cbx-switchthumb{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform 160ms var(--ds-ease-in-out)}',
      '.cbx-switchtrack[data-on=true]{background:var(--dsw-alias-label-primary)}',
      '.cbx-switchtrack[data-on=true] .cbx-switchthumb{transform:translateX(16px)}',
      '.cbx-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}',
      '.cbx-switch:focus-visible{outline:2px solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}',
      '.cbx-note{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.cbx-banner{border-radius:8px;padding:8px 12px;font-size:12.5px;border:1px solid var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.cbx-okbanner{border-radius:8px;padding:8px 12px;font-size:12.5px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}',
      '.cbx-skeleton{height:12px;max-width:100%;border-radius:4px;background:var(--dsw-alias-bg-layer-2)}',
    ].join('')

    function pad(value) {
      return value < 10 ? `0${value}` : String(value)
    }

    function formatDuration(seconds, t) {
      if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '—'
      const total = Math.round(seconds)
      const days = Math.floor(total / 86400)
      const hours = Math.floor((total % 86400) / 3600)
      const minutes = Math.floor((total % 3600) / 60)
      if (days > 0) return `${days}${t('unitDay')} ${hours}${t('unitHour')}`
      if (hours > 0) return `${hours}${t('unitHour')} ${minutes}${t('unitMinute')}`
      return `${minutes}${t('unitMinute')}`
    }

    function remainingSeconds(usageWindow) {
      if (typeof usageWindow.resetAt === 'number' && Number.isFinite(usageWindow.resetAt)) {
        const seconds = usageWindow.resetAt - Date.now() / 1000
        return seconds > 0 ? seconds : 0
      }
      return typeof usageWindow.resetAfterSeconds === 'number' ? usageWindow.resetAfterSeconds : null
    }

    function formatClock(epochSeconds) {
      if (typeof epochSeconds !== 'number' || !Number.isFinite(epochSeconds)) return '—'
      const date = new Date(epochSeconds * 1000)
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function Row(props) {
      return h('div', { className: 'cbx-row' },
        h('span', { className: 'cbx-key' }, props.label),
        h('span', { className: props.mono === true ? 'cbx-val cbx-mono' : 'cbx-val' }, props.children ?? props.value ?? '—'))
    }

    function Meter(props) {
      const percent = typeof props.percent === 'number' ? Math.max(0, Math.min(100, props.percent)) : null
      const tone = percent === null ? 'cbx-fill' : percent >= 95 ? 'cbx-fillbad' : percent >= 80 ? 'cbx-fillwarn' : 'cbx-fill'
      const remaining = remainingSeconds(props.window)
      const reset = remaining === null ? formatClock(props.window.resetAt) : formatDuration(remaining, props.t)
      return h('div', { className: 'cbx-meter' },
        h('div', { className: 'cbx-meterhead' },
          h('span', { className: 'cbx-key' }, props.title),
          h('span', { className: 'cbx-pct', style: { fontSize: 15 } }, percent === null ? '—' : `${percent}% ${props.t('used')}`)),
        h('div', { className: 'cbx-track' }, h('div', { className: tone, style: { width: `${percent === null ? 0 : percent}%` } })),
        h('div', { className: 'cbx-row' },
          h('span', { className: 'cbx-key' }, `${props.t('remaining')} ${percent === null ? '—' : `${100 - percent}%`}`),
          h('span', { className: 'cbx-val' }, `${props.t('resetsIn')} ${reset}`)))
    }

    /** Original 16px stroke glyphs; color always inherits the surrounding label token. */
    function Glyph(props) {
      const shapes = {
        model: [h('rect', { key: 'r', x: 2.75, y: 2.75, width: 10.5, height: 10.5, rx: 3 }),
          h('circle', { key: 'c', cx: 8, cy: 8, r: 2 })],
        context: [h('path', { key: 'l', d: 'M5.5 3H4a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 4 13h1.5M10.5 3H12a1.5 1.5 0 0 1 1.5 1.5v7A1.5 1.5 0 0 1 12 13h-1.5' }),
          h('path', { key: 'm', d: 'M6.5 8h3' })],
        input: [h('rect', { key: 'r', x: 2.5, y: 3.5, width: 11, height: 9, rx: 2 }),
          h('path', { key: 'p', d: 'M4 10.6l2.8-2.8 2.2 2.2 1.4-1.4 1.6 1.6' })],
        reason: [h('path', { key: 'p', d: 'M8 2.4l1.45 3.15L12.6 7l-3.15 1.45L8 11.6 6.55 8.45 3.4 7l3.15-1.45z' })],
        check: [h('path', { key: 'p', d: 'M3.5 8.6l3 3 6-6.6' })],
        alert: [h('path', { key: 'p', d: 'M8 3.2l5 9.3H3z' }), h('path', { key: 'l', d: 'M8 7v2.2' })],
        gauge: [h('circle', { key: 'c', cx: 8, cy: 8, r: 5.6 }), h('path', { key: 'p', d: 'M8 8l2.2-1.6' })],
      }
      return h('svg', {
        'data-glyph': props.kind, viewBox: '0 0 16 16', width: props.size ?? 12, height: props.size ?? 12,
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true, focusable: 'false', style: { flex: 'none', display: 'block' },
      }, ...(shapes[props.kind] ?? []))
    }

    function ModelRow(props) {
      const { model, t, saving, feedback } = props
      const feedbackId = `cbx-model-feedback-${encodeURIComponent(model.id)}`
      const sourceKey = { codex: 'sourceCodex', manual: 'sourceManual', legacy: 'sourceLegacy' }[model.source] ?? 'sourceLegacy'
      const defaultEffort = model.reasoningEfforts.find((effort) => effort.id === model.defaultReasoningEffort)
      const inputs = (model.input ?? []).map((value) => t(value === 'image' ? 'imageInput' : 'textInput'))
      const meta = [h('span', { key: 'id', className: 'cbx-metaitem' },
        h('span', { className: 'cbx-metaid' }, model.id))]
      if (typeof model.contextWindow === 'number') {
        meta.push(h('span', { key: 'ctx', className: 'cbx-metaitem' },
          h(Glyph, { kind: 'context' }), `${Math.round(model.contextWindow / 1000)}k`))
      }
      if (inputs.length > 0) {
        meta.push(h('span', { key: 'in', className: 'cbx-metaitem' },
          h(Glyph, { kind: 'input' }), inputs.join(' / ')))
      }
      if (model.reasoning) {
        meta.push(h('span', { key: 'rs', className: 'cbx-metaitem' },
          h(Glyph, { kind: 'reason' }), t('reasoning')))
      }
      const quota = model.available === true
        ? h('span', { className: 'cbx-tag cbx-tag-ok' }, h(Glyph, { kind: 'check', size: 11 }), t('quotaAvailable'))
        : model.available === false
          ? h('span', { className: 'cbx-tag cbx-tag-warn' }, h(Glyph, { kind: 'alert', size: 11 }), t('quotaUnavailable'))
          : null
      return h('div', { className: 'cbx-model' },
        h('div', { className: 'cbx-modelmain' },
          h('div', { className: 'cbx-modeltitle' },
            h('span', { className: 'cbx-modelicon' }, h(Glyph, { kind: 'model', size: 13 })),
            h('span', { className: 'cbx-modelname' }, model.name),
            h('span', { className: 'cbx-tag' }, t(sourceKey)),
            defaultEffort === undefined ? null : h('span', { className: 'cbx-tag cbx-tag-accent' },
              h(Glyph, { kind: 'reason', size: 11 }), `${t('defaultTag')} ${defaultEffort.label}`),
            model.catalogAvailable ? null : h('span', { className: 'cbx-tag cbx-tag-warn' }, t('catalogMissing'))),
          h('div', { className: 'cbx-metarow' }, ...meta),
          model.reasoningEfforts.length === 0 ? null : h('div', { className: 'cbx-efforts' },
            ...model.reasoningEfforts.map((effort) => h('span', {
              key: effort.id,
              className: effort.id === model.defaultReasoningEffort ? 'cbx-chip cbx-chip-on' : 'cbx-chip',
            }, effort.label))),
          model.unsupportedReasoningEfforts.length === 0 ? null : h('span', { className: 'cbx-note cbx-warn' },
            `${t('effortsUnsupported')}: ${model.unsupportedReasoningEfforts.join(', ')}`),
          h('span', { id: feedbackId, className: `cbx-note${feedback?.error ? ' cbx-bad' : ''}`,
            role: feedback?.error ? 'alert' : 'status', 'aria-atomic': true },
          saving ? t('modelSaving') : feedback?.error
            ? `${t('modelSaveFailed')} ${feedback.error}`
            : feedback ? t(feedback.enabled ? 'modelSavedEnabled' : 'modelSavedDisabled') : '')),
        h('div', { className: 'cbx-aside' },
          h('button', {
            type: 'button', className: 'cbx-switch', role: 'switch',
            'aria-checked': model.enabled, 'aria-label': `${t('modelEnableLabel')}: ${model.name} (${model.id})`,
            'aria-describedby': `cbx-model-hint ${feedbackId}`, 'aria-busy': saving,
            disabled: saving || props.disabled,
            onClick: () => props.onToggle(model.id, !model.enabled),
          }, h('span', {
            className: 'cbx-switchtrack', 'aria-hidden': true,
            'data-on': model.enabled ? 'true' : undefined,
          }, h('span', { className: 'cbx-switchthumb' }))),
          quota))
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, {
          en: EN, zh: ZH, ja: EN, es: EN, fr: EN, de: EN, ru: EN, pt: EN,
        }), 'codex-bridge: dictionaries')

        async function call(endpoint, payload) {
          const response = await fetch(`${ROUTE}/${endpoint}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'same-origin',
            body: JSON.stringify({ payload: payload ?? {} }),
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const result = await response.json()
          if (result?.ok !== true) throw new Error(result?.error?.message ?? 'Codex request failed')
          return result.value
        }

        const loader = createDisplayLoader(displayCache, call)

        function CodexSection() {
          // Lazy synchronous initialization is the first render, before effects/fetch.
          const [state, setState] = useState(() => loader.snapshot())
          const [busy, setBusy] = useState(null)
          const [notice, setNotice] = useState(null)
          const [tick, setTick] = useState(0)
          const mounted = useRef(false)

          useEffect(() => {
            mounted.current = true
            const unsubscribe = loader.subscribe(setState)
            // Opening always revalidates, including when the page starts hidden.
            loader.refresh()
            const timer = setInterval(() => {
              if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return
              setTick((value) => value + 1)
              loader.refresh()
            }, 60000)
            return () => {
              mounted.current = false
              unsubscribe()
              clearInterval(timer)
            }
          }, [])

          const run = useCallback(async (action, endpoint) => {
            setBusy(action)
            setNotice(null)
            try {
              if (action === 'refresh') {
                await loader.refresh()
                return
              }
              loader.invalidate()
              const value = await call(endpoint)
              // A timer may have started another read while this mutation ran.
              loader.invalidate()
              if (!mounted.current) { loader.refresh(); return }
              if (action === 'setup') {
                setNotice(value?.setup?.ok === true ? t('setupDone') : (value?.setup?.reason ?? t('unchanged')))
              } else if (action === 'importCredential') {
                setNotice(value?.imported?.ok === true ? t('importDone') : (value?.imported?.reason ?? t('unchanged')))
              } else if (action === 'enableRoute') {
                setNotice(value?.route?.ok === true ? t('enableDone') : (value?.route?.reason ?? t('unchanged')))
              }
              await loader.refresh()
            } catch (error) {
              loader.invalidate()
              loader.refresh()
              if (mounted.current) setNotice(error instanceof Error ? error.message : String(error))
            } finally {
              if (mounted.current) setBusy(null)
            }
          }, [])

          const data = state.data
          const usage = data?.usage ?? null
          const auth = data?.auth ?? null
          const route = data?.route ?? null
          const models = data?.models ?? []

          const lastUpdated = useMemo(() => {
            if (usage === null || typeof usage.fetchedAt !== 'number') return '—'
            return formatClock(usage.fetchedAt / 1000)
          }, [usage, tick])

          const header = h('div', { className: 'cbx-head' },
            h('h2', { className: 'cbx-title' }, t('title')),
            h('p', { className: 'cbx-desc' }, t('description')))

          if (data === null) {
            return h('div', { className: 'cbx-page', 'aria-busy': state.refreshing },
              h('style', null, CSS), header,
              h('span', { className: 'cbx-note', role: 'status' }, t('loadingData')),
              state.error === null ? null : h('div', { className: 'cbx-banner', role: 'alert' }, `${t('errorTitle')}：${state.error}`),
              ...['credentialSection', 'routeSection', 'usageSection', 'modelsSection'].map((section) =>
                h('div', { className: 'cbx-card', key: section },
                  h('h3', { className: 'cbx-cardtitle' }, t(section)),
                  h('div', { className: 'cbx-skeleton', style: { width: '70%' }, 'aria-hidden': true }),
                  h('div', { className: 'cbx-skeleton', style: { width: '45%' }, 'aria-hidden': true }))),
              h('div', { className: 'cbx-actions' }, h('button', {
                type: 'button', className: 'cbx-btn', disabled: state.refreshing,
                onClick: () => { loader.refresh() },
              }, t('retry'))))
          }

          const credentialRows = h('div', { className: 'cbx-card' },
            h('div', { className: 'cbx-cardhead' },
              h('h3', { className: 'cbx-cardtitle' }, t('credentialSection')),
              h('span', {
                className: `cbx-pill ${auth?.found === true ? 'cbx-ok' : 'cbx-warn'}`,
              }, auth?.found === true ? t('connected') : t('missing'))),
            h(Row, { label: t('credentialFile'), value: t('localCredential') }),
            h(Row, { label: t('credentialAccount'), value: auth?.accountMasked ?? '—', mono: true }),
            h(Row, { label: t('credentialMode'), value: auth?.authMode ?? '—' }),
            auth?.found === true ? null : h('span', { className: 'cbx-note cbx-warn' }, auth?.reason ?? t('noCredential')),
            h(Row, { label: t('plan'), value: usage?.planLabel ?? '—' }),
            h('div', { className: 'cbx-actions' },
              h('button', {
                type: 'button',
                className: 'cbx-btn cbx-primary',
                disabled: busy !== null || state.pendingModels.length > 0,
                onClick: () => { run('setup', 'setup') },
              }, busy === 'setup' ? t('working') : t('actionSetup')),
              h('button', {
                type: 'button',
                className: 'cbx-btn',
                disabled: busy !== null || state.pendingModels.length > 0,
                onClick: () => { run('importCredential', 'importCredential') },
              }, busy === 'importCredential' ? t('working') : t('actionImport')),
              route?.configured === true
                ? null
                : h('button', {
                  type: 'button',
                  className: 'cbx-btn',
                  disabled: busy !== null || state.pendingModels.length > 0,
                  onClick: () => { run('enableRoute', 'enableRoute') },
                }, busy === 'enableRoute' ? t('working') : t('actionEnable'))))

          const routeCard = h('div', { className: 'cbx-card' },
            h('div', { className: 'cbx-cardhead' },
              h('h3', { className: 'cbx-cardtitle' }, t('routeSection')),
              h('span', { className: `cbx-pill ${route?.configured === true ? 'cbx-ok' : 'cbx-warn'}` },
                route?.configured === true ? t('routeReady') : t('routeMissing'))),
            h('span', { className: 'cbx-note' }, t('routeHint')))

          const windows = usage?.windows ?? []
          const usageCard = h('div', { className: 'cbx-card' },
            h('div', { className: 'cbx-cardhead' },
              h('h3', { className: 'cbx-cardtitle' }, t('usageSection')),
              h('span', { className: 'cbx-note' }, usage === null ? '—' : `${t('updated')} ${lastUpdated}`)),
            usage === null
              ? h('span', { className: 'cbx-note cbx-warn' }, data?.usageError ?? t('usageUnavailable'))
              : h('div', { style: { display: 'flex', flexDirection: 'column', gap: 14 } },
                usage.limitReached ? h('span', { className: 'cbx-note cbx-bad' }, t('limitReached')) : null,
                ...windows.map((window) => h(Meter, {
                  key: window.kind,
                  window,
                  t,
                  title: window.kind === 'primary' ? t('primaryWindow') : t('secondaryWindow'),
                  percent: window.usedPercent,
                })),
                h(Row, {
                  label: t('credits'),
                  value: usage.credits.unlimited
                    ? t('creditsUnlimited')
                    : `${t('creditsBalance')} ${usage.credits.balance ?? '0'}`,
                }),
                usage.resetCredits === null ? null : h(Row, { label: t('resetCredits'), value: String(usage.resetCredits) })))

          const modelsCard = h('div', { className: 'cbx-card' },
            h('div', { className: 'cbx-cardhead' },
              h('h3', { className: 'cbx-cardtitle' }, t('modelsSection')),
              h('span', { className: 'cbx-note' }, String(models.length))),
            h('span', { id: 'cbx-model-hint', className: 'cbx-note' }, t('modelHint')),
            data.catalogUpdatedAt === null ? null : h('span', { className: 'cbx-note' },
              `${t('updated')} ${formatClock(data.catalogUpdatedAt / 1000)}`),
            data.catalogError === null ? null : h('span', { className: 'cbx-note cbx-warn', role: 'status' },
              `${t('catalogError')} ${data.catalogError}`),
            models.length === 0
              ? h('span', { className: 'cbx-note' }, t('modelsEmpty'))
              : h('div', { style: { display: 'flex', flexDirection: 'column' } },
                ...models.map((model) => h(ModelRow, { key: model.id, model, t,
                  saving: state.pendingModels.includes(model.id),
                  feedback: state.modelFeedback.find((item) => item.id === model.id),
                  disabled: busy !== null && busy !== 'refresh', onToggle: loader.setModelEnabled }))))

          return h('div', { className: 'cbx-page' },
            h('style', null, CSS),
            header,
            state.stale || state.refreshing ? h('div', { className: 'cbx-note', role: 'status' },
              state.error !== null ? t('staleData') : `${t('cachedData')}${state.refreshing ? ` · ${t('refreshing')}` : ''}`) : null,
            state.error === null ? null : h('div', { className: 'cbx-banner', role: 'alert' }, `${t('errorTitle')}：${state.error}`),
            notice === null ? null : h('div', { className: 'cbx-okbanner' }, notice),
            credentialRows,
            routeCard,
            usageCard,
            modelsCard,
            h('div', { className: 'cbx-actions' },
              h('button', {
                type: 'button',
                className: 'cbx-btn',
                disabled: busy !== null,
                onClick: () => { run('refresh', 'refresh') },
              }, busy === 'refresh' ? t('working') : t('actionRefresh')),
              h('span', { className: 'cbx-note' }, t('reloadHint'))))
        }

        ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'codex',
          order: 90,
          label: () => t('nav'),
          locale: NS,
        }, CodexSection)), 'codex-bridge: settings page')
      },
    }
  },
})
