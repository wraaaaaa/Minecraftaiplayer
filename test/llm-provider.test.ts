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

function config(provider: BotConfig['model']['provider'], baseUrl: string): BotConfig['model'] {
  return { provider, model: 'test-model', apiKeyEnv: 'TEST_KEY', baseUrl, reasoningEffort: 'xhigh', timeoutMs: 5000 }
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
    assert.equal(result.effectiveEffort, 'max')
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
