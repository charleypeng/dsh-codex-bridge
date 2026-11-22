/** Durable, schema-validated catalog data; OAuth tokens stay in credentials. */
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { join } from 'node:path'

export async function openModelStore(context) {
  const anchor = context.get('profileContext')?.installAnchor ?? (process.env.DSH_INSTALL_DIR && join(process.env.DSH_INSTALL_DIR, 'package.json'))
  if (!anchor) throw new Error('无法定位当前 DSH 安装，模型偏好未保存')
  const require = createRequire(anchor)
  const { z } = require('zod')
  const effort = z.object({ id: z.string().min(1).max(160), label: z.string().max(180) })
  const model = z.object({
    id: z.string().min(1).max(160), name: z.string().max(180),
    contextWindow: z.number().int().positive().nullable(),
    input: z.array(z.enum(['text', 'image'])), reasoningEfforts: z.array(effort),
    unsupportedReasoningEfforts: z.array(z.string()).optional(),
    defaultReasoningEffort: z.string().nullable(), source: z.enum(['codex', 'manual', 'legacy']),
    catalogAvailable: z.boolean(), overrides: z.record(z.string(), z.unknown()).optional(),
  })
  const record = z.object({
    catalog: z.array(model), manual: z.array(model), preferences: z.record(z.string(), z.boolean()),
    fetchedAt: z.number().nullable(),
  })
  const baseline = z.object({ route: z.record(z.string(), z.unknown()), manual: z.array(model) })
  const domain = await context.get('storageDomain').open({
    name: 'codex_bridge_models', version: 1, tables: {
      accounts: { valueSchema: record }, profiles: { valueSchema: baseline },
    },
  })
  const key = (account) => createHash('sha256').update(account).digest('hex')
  return {
    load: async (account) => domain.table('accounts').get(key(account)) ?? null,
    save: async (account, value) => { await domain.table('accounts').put(key(account), record.parse(value)) },
    baseline: () => domain.table('profiles').get('original') ?? null,
    saveBaseline: async (value) => { await domain.table('profiles').put('original', baseline.parse(value)) },
    close: () => domain.close(),
  }
}
