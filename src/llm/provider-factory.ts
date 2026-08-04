import type { BotConfig, ReasoningEffort } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js'

interface ProviderOptions {
  model: string
  apiKey: string
  baseUrl: string
  effort: ReasoningEffort
  timeoutMs: number
  logger: Logger
}

function normalizeBaseUrl(value: string): string { return value.replace(/\/+$/u, '') }

function parseChatText(payload: unknown): string {
  const root = payload as { choices?: Array<{ message?: { content?: string } }> }
  const text = root.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.trim() === '') throw new Error('模型返回中缺少 choices[0].message.content')
  return text
}

function parseResponseText(payload: unknown): string {
  const root = payload as { output_text?: string; output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }> }
  if (typeof root.output_text === 'string' && root.output_text.trim()) return root.output_text
  for (const item of root.output ?? []) {
    if (item.type !== 'message') continue
    for (const content of item.content ?? []) if (content.type === 'output_text' && typeof content.text === 'string') return content.text
  }
  throw new Error('OpenAI Responses 返回中缺少文本输出')
}

async function postJson(url: string, apiKey: string, body: unknown, timeoutMs: number): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs)
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`模型 API 请求失败 (${response.status}): ${text.slice(0, 500)}`)
  return JSON.parse(text) as unknown
}

class ChatCompletionsProvider implements LlmProvider {
  readonly #options: ProviderOptions
  readonly #provider: 'deepseek' | 'volcengine'

  constructor(provider: 'deepseek' | 'volcengine', options: ProviderOptions) { this.#provider = provider; this.#options = options }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const requested = this.#options.effort
    let effective = requested
    const body: Record<string, unknown> = {
      model: this.#options.model,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      stream: false,
      response_format: { type: 'json_object' }
    }
    if (this.#provider === 'deepseek') {
      if (requested === 'none') body.thinking = { type: 'disabled' }
      else {
        effective = requested === 'max' || requested === 'xhigh' ? 'max' : 'high'
        body.thinking = { type: 'enabled' }
        body.reasoning_effort = effective
      }
    } else {
      body.reasoning_effort = requested
    }
    if (effective !== requested) this.#options.logger.warn('供应商调整了推理强度', { provider: this.#provider, requested, effective })
    const payload = await postJson(`${normalizeBaseUrl(this.#options.baseUrl)}/chat/completions`, this.#options.apiKey, body, this.#options.timeoutMs)
    return { text: parseChatText(payload), model: this.#options.model, requestedEffort: requested, effectiveEffort: effective }
  }
}

class OpenAiResponsesProvider implements LlmProvider {
  readonly #options: ProviderOptions
  constructor(options: ProviderOptions) { this.#options = options }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const effort = this.#options.effort
    const payload = await postJson(`${normalizeBaseUrl(this.#options.baseUrl)}/responses`, this.#options.apiKey, {
      model: this.#options.model,
      input: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      reasoning: { effort },
      text: { verbosity: 'low' }
    }, this.#options.timeoutMs)
    return { text: parseResponseText(payload), model: this.#options.model, requestedEffort: effort, effectiveEffort: effort }
  }
}

class MissingKeyProvider implements LlmProvider {
  readonly #variable: string
  constructor(variable: string) { this.#variable = variable }
  async complete(): Promise<LlmResponse> { throw new Error(`缺少模型 API Key 环境变量：${this.#variable}`) }
}

export function createLlmProvider(config: BotConfig['model'], apiKey: string, logger: Logger): LlmProvider {
  if (!apiKey) {
    logger.warn('模型 API Key 未配置；Bot 仍可进入游戏，但不会处理 AI 请求', { variable: config.apiKeyEnv })
    return new MissingKeyProvider(config.apiKeyEnv)
  }
  const options: ProviderOptions = { model: config.model, apiKey, baseUrl: config.baseUrl, effort: config.reasoningEffort, timeoutMs: config.timeoutMs, logger }
  if (config.provider === 'openai') return new OpenAiResponsesProvider(options)
  return new ChatCompletionsProvider(config.provider, options)
}
