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
