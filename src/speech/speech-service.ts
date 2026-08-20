import { createHash, randomUUID } from 'node:crypto'
import type { Logger } from '../core/logger.js'
import type { SpeechConfig, SpeechProtocol } from '../config/types.js'

export interface PcmSpeech {
  pcm16le: Buffer
  sampleRate: number
}

export type SpeechPlayback = (speech: PcmSpeech) => Promise<void>

type FetchLike = typeof fetch
type Environment = Record<string, string | undefined>

function endpoint(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl)
  const cleanPath = url.pathname.replace(/\/+$/u, '')
  if (cleanPath.endsWith(suffix)) return url.toString()
  url.pathname = `${cleanPath}${suffix}`.replace(/\/+/gu, '/')
  return url.toString()
}

function protocol(config: SpeechConfig): SpeechProtocol {
  switch (config.provider) {
    case 'volcengine': return 'volcengine_v1'
    case 'openai': return 'openai_speech'
    case 'mimo': return 'mimo_chat_audio'
    case 'multimodal': return 'openai_chat_audio'
    case 'custom': return config.protocol
  }
}

function requiredSecret(environment: Environment, name: string): string {
  const value = environment[name]?.trim()
  if (!value) throw new Error(`语音接口缺少环境变量 ${name}`)
  return value
}

function jsonPath(value: unknown, path: string): unknown {
  let current = value
  for (const segment of path.split('.').filter(Boolean)) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10)
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined
      current = current[index]
      continue
    }
    if (!current || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

async function checkedFetch(fetchImpl: FetchLike, url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  if (response.ok) return response
  const detail = (await response.text().catch(() => '')).replace(/[\r\n\t]+/gu, ' ').slice(0, 500)
  throw new Error(`语音接口 HTTP ${response.status}${detail ? `: ${detail}` : ''}`)
}

function base64Audio(value: unknown, path: string): Buffer {
  const encoded = jsonPath(value, path)
  if (typeof encoded !== 'string' || !encoded.trim()) throw new Error(`语音响应缺少 Base64 音频字段 ${path}`)
  const audio = Buffer.from(encoded, 'base64')
  if (!audio.length) throw new Error('语音响应的 Base64 音频为空')
  return audio
}

function chatAudioBody(config: SpeechConfig, text: string): Record<string, unknown> {
  return {
    model: config.model,
    messages: [
      ...(config.style.trim() ? [{ role: 'user', content: config.style.trim() }] : []),
      { role: 'assistant', content: text }
    ],
    modalities: ['text', 'audio'],
    audio: { voice: config.voice, format: 'pcm16' }
  }
}

async function synthesizeVolcengine(config: SpeechConfig, text: string, environment: Environment, fetchImpl: FetchLike): Promise<PcmSpeech> {
  const accessToken = requiredSecret(environment, config.apiKeyEnv)
  const appId = requiredSecret(environment, config.volcengineAppIdEnv)
  const response = await checkedFetch(fetchImpl, config.baseUrl, {
    method: 'POST',
    headers: { Authorization: `Bearer;${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      app: { appid: appId, token: accessToken, cluster: config.volcengineCluster },
      user: { uid: 'minecraft-ai-player' },
      audio: { voice_type: config.voice, encoding: 'pcm', sample_rate: config.sampleRate, speed_ratio: config.speed },
      request: { reqid: randomUUID(), text, text_type: 'plain', operation: 'query' }
    })
  }, config.timeoutMs)
  const root = await response.json() as { code?: number; message?: string; data?: string }
  if (root.code !== 3000) throw new Error(`火山引擎语音合成失败 code=${root.code ?? 'unknown'}: ${String(root.message ?? 'unknown error').slice(0, 300)}`)
  return { pcm16le: base64Audio(root, 'data'), sampleRate: config.sampleRate }
}

async function synthesizeOpenAiSpeech(config: SpeechConfig, text: string, environment: Environment, fetchImpl: FetchLike): Promise<PcmSpeech> {
  const key = requiredSecret(environment, config.apiKeyEnv)
  const response = await checkedFetch(fetchImpl, endpoint(config.baseUrl, '/audio/speech'), {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({ model: config.model, input: text, voice: config.voice, response_format: 'pcm', speed: config.speed, ...(config.style.trim() ? { instructions: config.style.trim() } : {}) })
  }, config.timeoutMs)
  return { pcm16le: Buffer.from(await response.arrayBuffer()), sampleRate: config.sampleRate }
}

async function synthesizeMimo(config: SpeechConfig, text: string, environment: Environment, fetchImpl: FetchLike): Promise<PcmSpeech> {
  const key = requiredSecret(environment, config.apiKeyEnv)
  const body = chatAudioBody(config, text)
  delete body.modalities
  const response = await checkedFetch(fetchImpl, endpoint(config.baseUrl, '/chat/completions'), {
    method: 'POST', headers: { 'api-key': key, 'content-type': 'application/json' }, body: JSON.stringify(body)
  }, config.timeoutMs)
  const root = await response.json()
  return { pcm16le: base64Audio(root, 'choices.0.message.audio.data'), sampleRate: config.sampleRate }
}

async function synthesizeOpenAiChatAudio(config: SpeechConfig, text: string, environment: Environment, fetchImpl: FetchLike): Promise<PcmSpeech> {
  const key = requiredSecret(environment, config.apiKeyEnv)
  const response = await checkedFetch(fetchImpl, endpoint(config.baseUrl, '/chat/completions'), {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: JSON.stringify(chatAudioBody(config, text))
  }, config.timeoutMs)
  const root = await response.json()
  return { pcm16le: base64Audio(root, 'choices.0.message.audio.data'), sampleRate: config.sampleRate }
}

function customHeaders(config: SpeechConfig, environment: Environment): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (!config.apiKeyEnv.trim()) return headers
  const key = requiredSecret(environment, config.apiKeyEnv)
  const value = config.customAuthScheme.trim() ? `${config.customAuthScheme.trim()} ${key}` : key
  headers[config.customAuthHeader] = value
  return headers
}

async function synthesizeCustom(config: SpeechConfig, text: string, environment: Environment, fetchImpl: FetchLike, responseMode: 'binary' | 'json'): Promise<PcmSpeech> {
  const response = await checkedFetch(fetchImpl, config.baseUrl, {
    method: 'POST', headers: customHeaders(config, environment),
    body: JSON.stringify({ model: config.model, input: text, voice: config.voice, style: config.style, speed: config.speed, format: 'pcm16', sample_rate: config.sampleRate })
  }, config.timeoutMs)
  const pcm16le = responseMode === 'binary'
    ? Buffer.from(await response.arrayBuffer())
    : base64Audio(await response.json(), config.customAudioJsonPath)
  return { pcm16le, sampleRate: config.sampleRate }
}

export async function synthesizeSpeech(config: SpeechConfig, text: string, options: { environment?: Environment; fetchImpl?: FetchLike } = {}): Promise<PcmSpeech> {
  const environment = options.environment ?? process.env
  const fetchImpl = options.fetchImpl ?? fetch
  switch (protocol(config)) {
    case 'volcengine_v1': return synthesizeVolcengine(config, text, environment, fetchImpl)
    case 'openai_speech': return synthesizeOpenAiSpeech(config, text, environment, fetchImpl)
    case 'mimo_chat_audio': return synthesizeMimo(config, text, environment, fetchImpl)
    case 'openai_chat_audio': return synthesizeOpenAiChatAudio(config, text, environment, fetchImpl)
    case 'custom_binary': return synthesizeCustom(config, text, environment, fetchImpl, 'binary')
    case 'custom_json_base64': return synthesizeCustom(config, text, environment, fetchImpl, 'json')
  }
}

function cleanText(value: string, maxChars: number): string {
  return value
    .replace(/§[0-9A-FK-OR]/giu, '')
    .replace(/https?:\/\/\S+/giu, '链接')
    .replace(/[`*_#>|]+/gu, ' ')
    .replace(/[\r\n\t]+/gu, ' ')
    .replace(/\s{2,}/gu, ' ')
    .trim()
    .slice(0, maxChars)
}

function normalizedPcm(speech: PcmSpeech, config: SpeechConfig): PcmSpeech {
  if (!Number.isInteger(speech.sampleRate) || speech.sampleRate < 8000 || speech.sampleRate > 96000) throw new Error(`语音采样率无效: ${speech.sampleRate}`)
  const evenLength = speech.pcm16le.length - (speech.pcm16le.length % 2)
  const maxLength = Math.floor(config.maxAudioSeconds * speech.sampleRate) * 2
  const output = Buffer.from(speech.pcm16le.subarray(0, Math.min(evenLength, maxLength)))
  if (!output.length) throw new Error('语音接口没有返回 PCM16 音频')
  if (config.volume !== 1) {
    for (let offset = 0; offset < output.length; offset += 2) {
      const scaled = Math.round(output.readInt16LE(offset) * config.volume)
      output.writeInt16LE(Math.max(-32768, Math.min(32767, scaled)), offset)
    }
  }
  return { pcm16le: output, sampleRate: speech.sampleRate }
}

export class SpeechService {
  readonly #config: SpeechConfig
  readonly #logger: Logger
  readonly #playback: SpeechPlayback
  readonly #environment: Environment
  readonly #fetchImpl: FetchLike
  readonly #queue: string[] = []
  readonly #cache = new Map<string, PcmSpeech>()
  #running = false
  #closed = false
  #idleWaiters: Array<() => void> = []

  constructor(options: { config: SpeechConfig; logger: Logger; playback: SpeechPlayback; environment?: Environment; fetchImpl?: FetchLike }) {
    this.#config = options.config
    this.#logger = options.logger
    this.#playback = options.playback
    this.#environment = options.environment ?? process.env
    this.#fetchImpl = options.fetchImpl ?? fetch
  }

  enqueue(value: string): boolean {
    if (!this.#config.enabled || this.#closed) return false
    const text = cleanText(value, this.#config.maxTextChars)
    if (!text) return false
    if (this.#queue.length >= this.#config.queueLimit) {
      this.#logger.warn('语音合成队列已满，已丢弃较晚的语音，但文字聊天不受影响', { queueLimit: this.#config.queueLimit })
      return false
    }
    this.#queue.push(text)
    void this.#drain()
    return true
  }

  close(): void {
    this.#closed = true
    this.#queue.length = 0
    const waiters = this.#idleWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }

  waitForIdle(): Promise<void> {
    if (!this.#running && this.#queue.length === 0) return Promise.resolve()
    return new Promise(resolve => this.#idleWaiters.push(resolve))
  }

  async #drain(): Promise<void> {
    if (this.#running || this.#closed) return
    this.#running = true
    try {
      while (!this.#closed) {
        const text = this.#queue.shift()
        if (!text) break
        const key = createHash('sha256').update(JSON.stringify({ provider: this.#config.provider, protocol: protocol(this.#config), model: this.#config.model, voice: this.#config.voice, style: this.#config.style, speed: this.#config.speed, text })).digest('hex')
        try {
          let speech = this.#cache.get(key)
          if (!speech) {
            speech = normalizedPcm(await synthesizeSpeech(this.#config, text, { environment: this.#environment, fetchImpl: this.#fetchImpl }), this.#config)
            if (this.#config.cacheEntries > 0) {
              this.#cache.set(key, speech)
              while (this.#cache.size > this.#config.cacheEntries) this.#cache.delete(this.#cache.keys().next().value as string)
            }
          }
          await this.#playback({ pcm16le: Buffer.from(speech.pcm16le), sampleRate: speech.sampleRate })
          this.#logger.info('游戏内语音已交给 Simple Voice Chat', { provider: this.#config.provider, model: this.#config.model, characters: text.length, audioBytes: speech.pcm16le.length })
        } catch (error) {
          this.#logger.warn('游戏内语音生成或发送失败；文字聊天仍然有效', error)
        }
      }
    } finally {
      this.#running = false
      for (const resolve of this.#idleWaiters.splice(0)) resolve()
      if (this.#queue.length && !this.#closed) void this.#drain()
    }
  }
}
