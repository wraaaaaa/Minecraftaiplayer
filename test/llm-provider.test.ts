import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { BotConfig } from '../src/config/types.js'
import { Logger } from '../src/core/logger.js'
import { createLlmProvider } from '../src/llm/provider-factory.js'

async function mockApi(responseBody: unknown): Promise<{ baseUrl: string; request: Promise<{ url: string; body: Record<string, unknown> }>; close: () => Promise<void> }> {
  let resolveRequest!: (value: { url: string; body: Record<string, unknown> }) => void
  const request = new Promise<{ url: string; body: Record<string, unknown> }>((resolve) => { resolveRequest = resolve })
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    resolveRequest({ url: incoming.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify(responseBody))
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock API failed to listen')
  return { baseUrl: `http://127.0.0.1:${address.port}`, request, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

async function mockSequentialApi(responseBodies: unknown[]): Promise<{ baseUrl: string; requests: Promise<Array<{ url: string; body: Record<string, unknown> }>>; close: () => Promise<void> }> {
  let resolveRequests!: (value: Array<{ url: string; body: Record<string, unknown> }>) => void
  const received: Array<{ url: string; body: Record<string, unknown> }> = []
  const requests = new Promise<Array<{ url: string; body: Record<string, unknown> }>>(resolve => { resolveRequests = resolve })
  const server = createServer(async (incoming, outgoing) => {
    const chunks: Buffer[] = []
    for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
    received.push({ url: incoming.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
    const responseBody = responseBodies[received.length - 1]
    outgoing.writeHead(200, { 'content-type': 'application/json' })
    outgoing.end(JSON.stringify(responseBody))
    if (received.length === responseBodies.length) resolveRequests(received)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('mock API failed to listen')
  return { baseUrl: `http://127.0.0.1:${address.port}`, requests, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) }
}

function config(provider: BotConfig['model']['provider'], baseUrl: string): BotConfig['model'] {
  return { provider, model: 'test-model', apiKeyEnv: 'TEST_KEY', baseUrl, reasoningEffort: 'xhigh', timeoutMs: 5000, maxOutputTokens: 4096 }
}

test('DeepSeek 请求显式启用思考并把 xhigh 映射为 max', async () => {
  const api = await mockApi({ choices: [{ message: { content: '{"ok":true}' } }] })
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-llm-${process.pid}.log`), level: 'error', console: false })
  try {
    const result = await createLlmProvider(config('deepseek', api.baseUrl), 'test-key', logger).complete({ system: 's', user: 'u' })
    const received = await api.request
    assert.equal(received.url, '/chat/completions')
    assert.deepEqual(received.body.thinking, { type: 'enabled' })
    assert.equal(received.body.reasoning_effort, 'max')
    assert.equal(received.body.max_tokens, 4096)
    assert.equal(result.effectiveEffort, 'max')
  } finally { await logger.flush(); await api.close() }
})

test('DeepSeek JSON 空 content 时仅重试一次并降级为非思考模式', async () => {
  const api = await mockSequentialApi([
    { choices: [{ finish_reason: 'length', message: { content: null, reasoning_content: 'private reasoning must not be used' } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '{"intent":"chat","reply":"你好","action":{"type":"none"}}' } }] }
  ])
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-llm-retry-${process.pid}.log`), level: 'error', console: false })
  try {
    const result = await createLlmProvider(config('deepseek', api.baseUrl), 'test-key', logger).complete({ system: '必须输出 JSON', user: '{"message":"你好"}' })
    const received = await api.requests
    assert.equal(received.length, 2)
    assert.deepEqual(received[0]?.body.thinking, { type: 'enabled' })
    assert.equal(received[0]?.body.reasoning_effort, 'max')
    assert.deepEqual(received[1]?.body.thinking, { type: 'disabled' })
    assert.equal('reasoning_effort' in (received[1]?.body ?? {}), false)
    assert.match(JSON.stringify(received[1]?.body.messages), /非空 JSON 对象/u)
    assert.equal(result.effectiveEffort, 'none')
    assert.doesNotMatch(result.text, /private reasoning/u)
    assert.match(result.text, /"intent":"chat"/u)
  } finally { await logger.flush(); await api.close() }
})

test('OpenAI 适配器使用 Responses API 和请求的推理强度', async () => {
  const api = await mockApi({ output_text: '{"ok":true}' })
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-openai-${process.pid}.log`), level: 'error', console: false })
  try {
    const result = await createLlmProvider(config('openai', api.baseUrl), 'test-key', logger).complete({ system: 's', user: 'u' })
    const received = await api.request
    assert.equal(received.url, '/responses')
    assert.deepEqual(received.body.reasoning, { effort: 'xhigh' })
    assert.equal(received.body.max_output_tokens, 4096)
    assert.equal(result.effectiveEffort, 'xhigh')
  } finally { await logger.flush(); await api.close() }
})

test('缺少密钥时允许 Bot 启动，但首次模型请求明确失败', async () => {
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-missing-key-${process.pid}.log`), level: 'error', console: false })
  try {
    const provider = createLlmProvider(config('deepseek', 'http://127.0.0.1'), '', logger)
    await assert.rejects(provider.complete({ system: 's', user: 'u' }), /TEST_KEY/u)
  } finally { await logger.flush() }
})

test('DeepSeek 工具循环保留 reasoning_content 并把真实工具结果送回下一轮', async () => {
  const api = await mockSequentialApi([
    { choices: [{ finish_reason: 'tool_calls', message: {
      content: null,
      reasoning_content: '先观察坐标再决定下一步',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'observe_world', arguments: '{}' } }]
    } }] },
    { choices: [{ finish_reason: 'stop', message: { content: '看清楚了，我们继续。', reasoning_content: '工具结果正常' } }] }
  ])
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-llm-tools-${process.pid}.log`), level: 'error', console: false })
  try {
    const provider = createLlmProvider(config('deepseek', api.baseUrl), 'test-key', logger)
    const first = await provider.toolTurn!({
      system: '你是游戏 Agent。',
      user: '观察环境',
      tools: [{ name: 'observe_world', description: '读取最新世界状态', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    })
    assert.equal(first.toolCalls[0]?.name, 'observe_world')
    const second = await provider.toolTurn!({
      system: '你是游戏 Agent。',
      user: '观察环境',
      tools: [{ name: 'observe_world', description: '读取最新世界状态', parameters: { type: 'object', properties: {}, additionalProperties: false } }],
      continuation: first.continuation,
      toolResults: [{ callId: 'call-1', output: '{"connected":true,"position":{"x":1,"y":64,"z":2}}' }]
    })
    const received = await api.requests
    const secondMessages = received[1]?.body.messages as Array<Record<string, unknown>>
    assert.equal(secondMessages[2]?.role, 'assistant')
    assert.equal(secondMessages[2]?.reasoning_content, '先观察坐标再决定下一步')
    assert.equal(secondMessages[3]?.role, 'tool')
    assert.equal(secondMessages[3]?.tool_call_id, 'call-1')
    assert.equal(second.text, '看清楚了，我们继续。')
  } finally { await logger.flush(); await api.close() }
})

test('OpenAI Responses 工具循环用 previous_response_id 回传 function_call_output', async () => {
  const api = await mockSequentialApi([
    { id: 'resp-1', output: [{ type: 'function_call', call_id: 'call-9', name: 'observe_world', arguments: '{}' }] },
    { id: 'resp-2', output_text: '完成观察。', output: [] }
  ])
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-openai-tools-${process.pid}.log`), level: 'error', console: false })
  try {
    const provider = createLlmProvider(config('openai', api.baseUrl), 'test-key', logger)
    const first = await provider.toolTurn!({
      system: '你是游戏 Agent。', user: '观察环境',
      tools: [{ name: 'observe_world', description: '读取状态', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    })
    const second = await provider.toolTurn!({
      system: '你是游戏 Agent。', user: '观察环境', tools: [],
      continuation: first.continuation,
      toolResults: [{ callId: 'call-9', output: '{"connected":true}' }]
    })
    const received = await api.requests
    assert.equal(received[1]?.body.previous_response_id, 'resp-1')
    assert.deepEqual(received[1]?.body.input, [{ type: 'function_call_output', call_id: 'call-9', output: '{"connected":true}' }])
    assert.equal(second.text, '完成观察。')
  } finally { await logger.flush(); await api.close() }
})

test('小米 MiMo 使用官方 Chat Completions 参数、原生工具调用和用量统计', async () => {
  const api = await mockApi({
    model: 'mimo-v2.5',
    choices: [{ finish_reason: 'tool_calls', message: { content: null, tool_calls: [{ id: 'm1', type: 'function', function: { name: 'observe_world', arguments: '{}' } }] } }],
    usage: { prompt_tokens: 321, completion_tokens: 45, total_tokens: 366, completion_tokens_details: { reasoning_tokens: 12 } }
  })
  const logger = new Logger({ file: path.join(tmpdir(), `minecraft-ai-mimo-${process.pid}.log`), level: 'error', console: false })
  try {
    const mimo = config('mimo', api.baseUrl)
    mimo.model = 'mimo-v2.5'
    mimo.apiKeyEnv = 'MIMO_API_KEY'
    const provider = createLlmProvider(mimo, 'test-key', logger)
    const result = await provider.toolTurn!({
      system: 's', user: 'u', maxOutputTokens: 768, reasoningEffort: 'high',
      attachments: [{ type: 'image', mimeType: 'image/png', dataBase64: 'aW1hZ2U=' }],
      tools: [{ name: 'observe_world', description: 'observe', parameters: { type: 'object', properties: {}, additionalProperties: false } }]
    })
    const received = await api.request
    assert.equal(received.url, '/chat/completions')
    assert.equal(received.body.max_completion_tokens, 768)
    assert.deepEqual(received.body.thinking, { type: 'enabled' })
    const messages = received.body.messages as Array<Record<string, unknown>>
    assert.ok(Array.isArray(messages[1]?.content))
    assert.match(JSON.stringify(messages[1]?.content), /data:image\/png;base64,aW1hZ2U=/u)
    assert.equal(result.toolCalls[0]?.name, 'observe_world')
    assert.equal(result.usage?.totalTokens, 366)
    assert.equal(result.usage?.reasoningTokens, 12)
    assert.equal(provider.capabilities?.vision, true)
    assert.equal(provider.capabilities?.audio, true)
    assert.equal(provider.capabilities?.webSearch, true)
  } finally { await logger.flush(); await api.close() }
})
