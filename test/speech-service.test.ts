import assert from 'node:assert/strict'
import test from 'node:test'
import { Logger } from '../src/core/logger.js'
import type { SpeechConfig } from '../src/config/types.js'
import { SpeechService, synthesizeSpeech } from '../src/speech/speech-service.js'

function config(overrides: Partial<SpeechConfig> = {}): SpeechConfig {
  return {
    enabled: true, provider: 'openai', protocol: 'openai_speech', model: 'gpt-4o-mini-tts', apiKeyEnv: 'TEST_TTS_KEY', baseUrl: 'https://api.example.test/v1', voice: 'alloy', style: 'warm',
    speed: 1, volume: 1, sampleRate: 24000, timeoutMs: 5000, maxTextChars: 180, maxAudioSeconds: 18, queueLimit: 3, cacheEntries: 8,
    volcengineAppIdEnv: 'TEST_VOLC_APP_ID', volcengineCluster: 'volcano_tts', customAuthHeader: 'Authorization', customAuthScheme: 'Bearer', customAudioJsonPath: 'audio.data',
    ...overrides
  }
}

test('OpenAI Speech API returns raw PCM and keeps credentials in headers', async () => {
  let request: { url: string; init: RequestInit | undefined } | undefined
  const speech = await synthesizeSpeech(config(), '你好', {
    environment: { TEST_TTS_KEY: 'secret' },
    fetchImpl: (async (url, init) => {
      request = { url: String(url), init }
      return new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 })
    }) as typeof fetch
  })
  assert.equal(request?.url, 'https://api.example.test/v1/audio/speech')
  assert.equal((request?.init?.headers as Record<string, string>).Authorization, 'Bearer secret')
  const body = JSON.parse(String(request?.init?.body)) as Record<string, unknown>
  assert.equal(body.response_format, 'pcm')
  assert.equal(body.input, '你好')
  assert.deepEqual([...speech.pcm16le], [1, 0, 2, 0])
})

test('Volcengine online TTS uses AppID, Bearer-semicolon token and Base64 PCM', async () => {
  let body: Record<string, any> = {}
  let authorization = ''
  const speech = await synthesizeSpeech(config({ provider: 'volcengine', apiKeyEnv: 'VOLC_TOKEN', volcengineAppIdEnv: 'VOLC_APP', baseUrl: 'https://openspeech.example.test/api/v1/tts' }), '火山测试', {
    environment: { VOLC_TOKEN: 'token', VOLC_APP: 'appid' },
    fetchImpl: (async (_url, init) => {
      authorization = (init?.headers as Record<string, string>).Authorization ?? ''
      body = JSON.parse(String(init?.body))
      return Response.json({ code: 3000, data: Buffer.from([10, 0, 20, 0]).toString('base64') })
    }) as typeof fetch
  })
  assert.equal(authorization, 'Bearer;token')
  assert.equal(body.app.appid, 'appid')
  assert.equal(body.audio.encoding, 'pcm')
  assert.equal(body.request.operation, 'query')
  assert.deepEqual([...speech.pcm16le], [10, 0, 20, 0])
})

test('MiMo and multimodal Chat Audio responses are decoded from message.audio.data', async () => {
  for (const provider of ['mimo', 'multimodal'] as const) {
    let headers: Record<string, string> = {}
    let body: Record<string, any> = {}
    const speech = await synthesizeSpeech(config({ provider, protocol: provider === 'mimo' ? 'mimo_chat_audio' : 'openai_chat_audio', model: provider === 'mimo' ? 'mimo-v2.5-tts' : 'gpt-audio' }), '语音测试', {
      environment: { TEST_TTS_KEY: 'secret' },
      fetchImpl: (async (_url, init) => {
        headers = init?.headers as Record<string, string>
        body = JSON.parse(String(init?.body))
        return Response.json({ choices: [{ message: { audio: { data: Buffer.from([3, 0, 4, 0]).toString('base64') } } }] })
      }) as typeof fetch
    })
    assert.deepEqual([...speech.pcm16le], [3, 0, 4, 0])
    assert.equal(body.audio.format, 'pcm16')
    assert.equal(body.messages.at(-1).role, 'assistant')
    if (provider === 'mimo') assert.equal(headers['api-key'], 'secret')
    else assert.equal(headers.Authorization, 'Bearer secret')
  }
})

test('custom local PCM endpoint can run without an authentication header', async () => {
  let headers: Record<string, string> = {}
  const speech = await synthesizeSpeech(config({
    provider: 'custom', protocol: 'custom_binary', apiKeyEnv: '', baseUrl: 'http://127.0.0.1:18080/tts', customAuthHeader: ''
  }), '本地语音', {
    environment: {},
    fetchImpl: (async (_url, init) => {
      headers = init?.headers as Record<string, string>
      return new Response(new Uint8Array([7, 0, 8, 0]), { status: 200 })
    }) as typeof fetch
  })
  assert.equal(headers['content-type'], 'application/json')
  assert.equal(Object.keys(headers).length, 1)
  assert.deepEqual([...speech.pcm16le], [7, 0, 8, 0])
})

test('SpeechService serializes playback and caches identical replies', async () => {
  let calls = 0
  const played: number[] = []
  const logger = new Logger({ file: '.runtime/test-artifacts/speech-service.log', level: 'error', console: false })
  const service = new SpeechService({
    config: config(), logger,
    environment: { TEST_TTS_KEY: 'secret' },
    fetchImpl: (async () => {
      calls++
      return new Response(new Uint8Array([1, 0, 2, 0]), { status: 200 })
    }) as typeof fetch,
    playback: async audio => { played.push(audio.pcm16le.length) }
  })
  assert.equal(service.enqueue('同一句话'), true)
  await service.waitForIdle()
  assert.equal(service.enqueue('同一句话'), true)
  await service.waitForIdle()
  assert.equal(calls, 1)
  assert.deepEqual(played, [4, 4])
  service.close()
  await logger.flush()
})
