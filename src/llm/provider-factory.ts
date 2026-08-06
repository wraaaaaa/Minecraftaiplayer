import type { BotConfig, ReasoningEffort } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type { LlmProvider, LlmRequest, LlmResponse } from './types.js'

interface ProviderOptions {
  model: string
  apiKey: string
  baseUrl: string
  effort: ReasoningEffort
  timeoutMs: number
  maxOutputTokens: number
  logger: Logger
}

function normalizeBaseUrl(value: string): string { return value.replace(/\/+$/u, '') }

interface ChatPayload {
  choices?: Array<{
    finish_reason?: string | null
    message?: { content?: string | null; reasoning_content?: string | null }
  }>
}

function chatText(payload: unknown): string | undefined {
  const root = payload as ChatPayload
  const text = root.choices?.[0]?.message?.content
  return typeof text === 'string' && text.trim() ? text : undefined
}

function emptyChatMetadata(payload: unknown): Record<string, unknown> {
  const root = payload as ChatPayload
  const choice = root.choices?.[0]
  return {
    choiceCount: root.choices?.length ?? 0,
    finishReason: choice?.finish_reason ?? 'missing',
    contentType: choice?.message?.content === null ? 'null' : typeof choice?.message?.content,
    hasReasoningContent: typeof choice?.message?.reasoning_content === 'string' && choice.message.reasoning_content.length > 0
  }
}

function requireChatText(payload: unknown): string {
  const text = chatText(payload)
  if (!text) throw new Error('模型返回中缺少 choices[0].message.content')
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
      response_format: { type: 'json_object' },
      max_tokens: this.#options.maxOutputTokens
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
    const endpoint = `${normalizeBaseUrl(this.#options.baseUrl)}/chat/completions`
    const payload = await postJson(endpoint, this.#options.apiKey, body, this.#options.timeoutMs)
    const firstText = chatText(payload)
    if (firstText) return { text: firstText, model: this.#options.model, requestedEffort: requested, effectiveEffort: effective }
    if (this.#provider !== 'deepseek') return { text: requireChatText(payload), model: this.#options.model, requestedEffort: requested, effectiveEffort: effective }

    // DeepSeek documents that JSON Output may occasionally return an empty content field.
    // Retry once with a changed prompt and thinking disabled: this caps extra spend, avoids
    // treating reasoning_content as the final answer, and still keeps the normal request at
    // the administrator-selected reasoning effort.
    this.#options.logger.warn('DeepSeek JSON Output 返回空内容，使用非思考模式重试一次', emptyChatMetadata(payload))
    const retryBody: Record<string, unknown> = {
      ...body,
      messages: [
        { role: 'system', content: `${request.system}\n\n重要：直接输出一个非空 JSON 对象，不要输出空白内容。` },
        { role: 'user', content: request.user }
      ],
      thinking: { type: 'disabled' }
    }
    delete retryBody.reasoning_effort
    const retried = await postJson(endpoint, this.#options.apiKey, retryBody, this.#options.timeoutMs)
    const retriedText = chatText(retried)
    if (!retriedText) {
      this.#options.logger.warn('DeepSeek JSON Output 重试后仍为空', emptyChatMetadata(retried))
      throw new Error('DeepSeek 连续两次返回空的 JSON content')
    }
    return { text: retriedText, model: this.#options.model, requestedEffort: requested, effectiveEffort: 'none' }
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
      text: { verbosity: 'low' },
      max_output_tokens: this.#options.maxOutputTokens
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
  const options: ProviderOptions = { model: config.model, apiKey, baseUrl: config.baseUrl, effort: config.reasoningEffort, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens ?? 4096, logger }
  if (config.provider === 'openai') return new OpenAiResponsesProvider(options)
  return new ChatCompletionsProvider(config.provider, options)
}
