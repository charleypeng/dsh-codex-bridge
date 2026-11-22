import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createLiveAdapter } from '../live-adapter.js'

const provider = 'openai-codex'
const collect = async iterable => { const rows = []; for await (const row of iterable) rows.push(row); return rows }
const model = (id = 'codex-test') => ({
  id, name: id, enabled: true, contextWindow: 200000, input: ['text', 'image'],
  reasoningEfforts: ['low', 'high', 'ultra'].map(id => ({ id, label: id.toUpperCase() })), defaultReasoningEffort: 'high',
})
const request = (effort, id = 'codex-test') => ({ provider, model: id, messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }], ...(effort === undefined ? {} : { reasoningEffort: effort }) })

function fixture(snapshot = { models: [model()], route: {} }) {
  const calls = [], innerOptions = [], configurations = []
  class LlmAdapter {}
  class PiAiAdapter {
    constructor(config) { this.config = config; configurations.push(config) }
    imageRequestTarget(_p, _m, image) { return { width: image.width, height: image.height, maxBytes: this.config.profiles().get(provider).requestImageMaxBytes } }
    async *stream(options) {
      innerOptions.push(options)
      const profile = this.config.profiles().get(provider)
      const apiKey = await this.config.resolveApiKey(provider, profile)
      assert.equal(profile.reasoning, undefined)
      assert.equal(typeof profile.piProvider.auth.apiKey.resolve, 'function')
      const auth = await profile.piProvider.auth.apiKey.resolve({ credential: { key: apiKey } })
      assert.equal(auth.auth.apiKey, 'unit-test-only')
      const selected = profile.piProvider.getModels().find(item => item.id === options.model)
      assert.equal(selected.reasoning, false)
      yield* profile.piProvider.streamSimple(selected, { converted: options.messages }, { apiKey, headers: profile.headers })
    }
  }
  const runtime = { LlmAdapter, PiAiAdapter, stream: async function* (model, context, options) { calls.push({ model, context, options }); yield { type: 'finish', reason: { kind: 'stop' } } } }
  return {
    calls, innerOptions, configurations, runtime, snapshot,
    create: () => createLiveAdapter({ context: { get: () => undefined }, getSnapshot: () => snapshot, accessToken: async () => 'unit-test-only', runtime }),
  }
}

test('advertises exact Codex efforts, labels and default without canonical max alias', async () => {
  const f = fixture(), adapter = await f.create()
  assert.ok(adapter instanceof f.runtime.LlmAdapter)
  const info = await adapter.resolveModel(provider, 'codex-test')
  assert.deepEqual(info.reasoning, { efforts: ['low', 'high', 'ultra'].map(id => ({ id, name: id.toUpperCase() })), defaultEffort: 'high' })
  assert.equal(info.context.contextWindow, 200000)
  assert.deepEqual(info.inputModalities, ['text', 'image'])
  assert.ok(Object.isFrozen(info.reasoning.efforts))
})

test('wire ultra stays ultra; omitted effort uses catalog default; inner gets none', async () => {
  const f = fixture(), adapter = await f.create()
  await collect(adapter.stream(request('ultra')))
  await collect(adapter.stream(request()))
  assert.deepEqual(f.calls.map(call => call.options.reasoningEffort), ['ultra', 'high'])
  assert.ok(f.innerOptions.every(options => options.reasoningEffort === undefined))
  assert.throws(() => adapter.stream(request('max')), { code: 'UNSUPPORTED_REASONING_EFFORT' })
  assert.equal(f.calls.length, 2)
})

test('every advertised effort passes through verbatim, including future opaque levels', async () => {
  const row = model(); row.reasoningEfforts.push({ id: 'future-level', label: 'Future' })
  const f = fixture({ models: [row], route: { reasoning: 'max' } }), adapter = await f.create()
  for (const effort of row.reasoningEfforts) await collect(adapter.stream(request(effort.id)))
  assert.deepEqual(f.calls.map(call => call.options.reasoningEffort), ['low', 'high', 'ultra', 'future-level'])
})

test('no configured default omits wire reasoning; unsupported catalog default fails loudly', async () => {
  const f = fixture(); f.snapshot.models[0].defaultReasoningEffort = null
  const adapter = await f.create()
  await collect(adapter.stream(request()))
  assert.equal(f.calls[0].options.reasoningEffort, undefined)
  assert.equal((await adapter.resolveModel(provider, 'codex-test')).reasoning.defaultEffort, undefined)
  f.snapshot.models[0].defaultReasoningEffort = 'max'
  assert.throws(() => adapter.stream(request()), { code: 'UNSUPPORTED_REASONING_EFFORT' })
})

test('disabled and all-off models leave selectors but retain exact resolution and history dispatch', async () => {
  const a = model(), b = model('disabled'); b.enabled = false
  const f = fixture({ models: [a, b], route: {} }), adapter = await f.create()
  assert.deepEqual((await adapter.listModels(provider)).map(row => row.id), [a.id])
  assert.equal((await adapter.resolveModel(provider, b.id)).id, b.id)
  await collect((await adapter.prepareCall(provider, b.id)).stream(request('ultra', b.id)))
  a.enabled = false
  assert.deepEqual(await adapter.listModels(provider), [])
  assert.equal((await adapter.resolveModel(provider, a.id)).id, a.id)
  await collect(adapter.stream(request()))
  assert.equal(f.calls.length, 2)
  await assert.rejects(adapter.resolveModel(provider, 'unknown'), { code: 'UNKNOWN_MODEL' })
  await assert.rejects(adapter.listModels('other'), { code: 'NO_ADAPTER' })
})

test('prepared snapshot freezes route, metadata, default and allowed efforts before later mutations', async () => {
  const f = fixture({ models: [model()], route: { baseURL: 'https://old.invalid', headers: { 'x-generation': 'old' }, reasoning: 'max' } })
  const adapter = await f.create()
  const pending = adapter.prepareCall(provider, 'codex-test')
  f.snapshot.route.baseURL = 'https://new.invalid'; f.snapshot.route.headers['x-generation'] = 'new'
  f.snapshot.models[0].defaultReasoningEffort = 'low'; f.snapshot.models[0].reasoningEfforts.pop()
  f.snapshot.models[0].contextWindow = 1000
  const prepared = await pending
  await collect(prepared.stream(request('ultra')))
  await collect(prepared.stream(request()))
  assert.equal(prepared.model.context.contextWindow, 200000)
  assert.equal(prepared.model.reasoning.defaultEffort, 'high')
  assert.equal(f.calls[0].model.baseUrl, 'https://old.invalid')
  assert.equal(f.calls[0].options.headers['x-generation'], 'old')
  assert.deepEqual(f.calls.map(call => call.options.reasoningEffort), ['ultra', 'high'])
  assert.equal((await adapter.resolveModel(provider, 'codex-test')).context.contextWindow, 1000)
  assert.throws(() => prepared.stream({ ...request(), provider: 'other' }), { code: 'INVALID_PREPARED_CALL' })
  assert.throws(() => prepared.stream(request('low', 'another')), { code: 'INVALID_PREPARED_CALL' })
})

test('concurrent requests do not share a mutable reasoning effort', async () => {
  const f = fixture(), adapter = await f.create()
  await Promise.all([collect(adapter.stream(request('low'))), collect(adapter.stream(request('ultra')))])
  assert.deepEqual(f.calls.map(call => call.options.reasoningEffort).sort(), ['low', 'ultra'])
})

test('stream captures its generation before its lazy iterable is consumed', async () => {
  const f = fixture(), adapter = await f.create()
  const pending = adapter.stream(request())
  f.snapshot.models[0].defaultReasoningEffort = 'ultra'
  await collect(pending)
  await collect(adapter.stream(request()))
  assert.deepEqual(f.calls.map(call => call.options.reasoningEffort), ['high', 'ultra'])
})

test('aborted metadata calls reject before reading dynamic state', async () => {
  const f = fixture(), adapter = await f.create(), controller = new AbortController()
  controller.abort(new Error('cancelled'))
  await assert.rejects(adapter.resolveModel(provider, 'codex-test', controller.signal), /cancelled/)
  await assert.rejects(adapter.prepareCall(provider, 'codex-test', controller.signal), /cancelled/)
})

test('missing access token fails safely without printing it or invoking transport', async () => {
  const f = fixture()
  const adapter = await createLiveAdapter({ getSnapshot: () => f.snapshot, accessToken: async () => '', runtime: f.runtime })
  await assert.rejects(collect(adapter.stream(request())), { code: 'MISSING_CREDENTIAL' })
  assert.equal(f.calls.length, 0)
})

// Optional installed-runtime contract test: real public PiAiAdapter conversion,
// but a fake lowest-level stream, so neither credentials nor network are used.
test('real public adapter converts history/tools/images and propagates options with wire ultra', { skip: !process.env.DSH_INSTALL_DIR }, async () => {
  const require = createRequire(join(process.env.DSH_INSTALL_DIR, 'package.json'))
  const llm = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm')).href)
  const { PiAiAdapter } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-pi-ai')).href)
  const captures = [], imageReads = []
  const ref = { attachmentId: 'test-image', mediaType: 'image/png', bytes: 3, width: 1, height: 1, name: 'pixel.png' }
  const attachments = {
    imageHostPath: () => '/virtual/pixel.png',
    readImageRequest: async (image, target) => {
      imageReads.push({ image, target })
      return { variantId: 'variant-test', attachment: ref, data: new Uint8Array([1, 2, 3]), mediaType: 'image/png', bytes: 3, width: 1, height: 1, depth: 'uchar', space: 'srgb', hasAlpha: false }
    },
  }
  const snapshot = { models: [model()], route: { headers: { 'x-test': 'contract' }, temperature: 0.1, transport: 'sse', cacheRetention: 'short' } }
  const adapter = await createLiveAdapter({
    context: { get: name => name === 'attachments' ? attachments : name === 'fs' ? { processPathFromHostPath: path => path } : undefined },
    getSnapshot: () => snapshot, accessToken: async () => 'fake-not-a-credential',
    runtime: { ...llm, PiAiAdapter, stream: async function* (model, context, options) {
      captures.push({ model, context, options })
      const message = { role: 'assistant', api: model.api, provider, model: model.id, content: [{ type: 'text', text: 'ok' }], stopReason: 'stop', timestamp: 0, usage: { input: 4, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 5, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } }
      yield { type: 'text_start', contentIndex: 0, partial: message }
      yield { type: 'text_delta', contentIndex: 0, delta: 'ok', partial: message }
      yield { type: 'text_end', contentIndex: 0, content: 'ok', partial: message }
      yield { type: 'done', reason: 'stop', message }
    } },
  })
  const options = {
    ...request('ultra'), system: 'Be concise.', sessionId: 'test-session', temperature: 0.2, maxTokens: 123,
    tools: [{ name: 'lookup', description: 'Find a value', parameters: { type: 'object', properties: { key: { type: 'string' } } } }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'Look up a pixel' }, { type: 'image', attachment: ref }] },
      { id: 'assistant-1', role: 'assistant', source: { kind: 'model', provider, model: 'codex-test' }, content: [{ type: 'text', text: 'Checking' }, { type: 'tool-call', id: 'call-1', name: 'lookup', arguments: '{"key":"pixel"}' }] },
      { id: 'tool-1', role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [{ type: 'text', text: 'found' }], isError: false },
    ],
  }
  const chunks = await collect(adapter.stream(options))
  assert.equal(captures.length, 1)
  const wire = captures[0]
  assert.equal(wire.options.reasoningEffort, 'ultra')
  assert.equal(wire.model.reasoning, false)
  assert.equal(wire.options.apiKey, 'fake-not-a-credential')
  assert.equal(wire.options.temperature, 0.2)
  assert.equal(wire.options.maxTokens, 123)
  assert.equal(wire.options.sessionId, 'test-session')
  assert.equal(wire.options.transport, 'sse')
  assert.equal(wire.options.headers['x-test'], 'contract')
  assert.ok(Object.keys(wire.options.headers).some(key => key.toLowerCase() !== 'x-test'))
  const system = wire.context.messages.find(message => message.role === 'system')
  assert.equal(system.content, 'Be concise.')
  assert.equal(system.toolsAdded[0].name, 'lookup')
  assert.deepEqual(system.toolsAdded[0].parameters, options.tools[0].parameters)
  const user = wire.context.messages.find(message => message.role === 'user')
  assert.ok(user.content.some(block => block.type === 'text' && block.text.includes('Look up a pixel')))
  assert.ok(user.content.some(block => block.type === 'image' && block.data === 'AQID' && block.mimeType === 'image/png'))
  const assistant = wire.context.messages.find(message => message.role === 'assistant')
  assert.ok(assistant.content.some(block => block.type === 'toolCall' && block.name === 'lookup' && block.arguments.key === 'pixel'))
  assert.ok(wire.context.messages.some(message => message.role === 'toolResult' && message.toolCallId === 'call-1'))
  assert.equal(imageReads.length, 1)
  assert.ok(chunks.some(chunk => chunk.type === 'text-delta' && chunk.text === 'ok'))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'stop' })
})
