import type { BotConfig, ReasoningEffort } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmInputAttachment,
  LlmUsage,
  ModelCapabilities,
  LlmToolCall,
  LlmToolTurnRequest,
  LlmToolTurnResponse
} from './types.js'

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
    message?: {
      role?: string
      content?: string | null
      reasoning_content?: string | null
      tool_calls?: Array<{ id?: string; type?: string; function?: { name?: string; arguments?: string } }>
    }
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
    completion_tokens_details?: { reasoning_tokens?: number }
    prompt_tokens_details?: { cached_tokens?: number } | null
  }
}

type ChatMessage = Record<string, unknown>

function chatToolCalls(payload: unknown): LlmToolCall[] {
  const root = payload as ChatPayload
  return (root.choices?.[0]?.message?.tool_calls ?? []).flatMap(call =>
    typeof call.id === 'string' && typeof call.function?.name === 'string'
      ? [{ id: call.id, name: call.function.name, arguments: typeof call.function.arguments === 'string' ? call.function.arguments : '{}' }]
      : [])
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

function numeric(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0 }

function chatUsage(payload: unknown): LlmUsage | undefined {
  const usage = (payload as ChatPayload).usage
  if (!usage) return undefined
  const inputTokens = numeric(usage.prompt_tokens)
  const outputTokens = numeric(usage.completion_tokens)
  return {
    inputTokens,
    outputTokens,
    totalTokens: numeric(usage.total_tokens) || inputTokens + outputTokens,
    ...(numeric(usage.completion_tokens_details?.reasoning_tokens) > 0 ? { reasoningTokens: numeric(usage.completion_tokens_details?.reasoning_tokens) } : {}),
    ...(numeric(usage.prompt_tokens_details?.cached_tokens) > 0 ? { cachedInputTokens: numeric(usage.prompt_tokens_details?.cached_tokens) } : {})
  }
}

function attachmentContent(text: string, attachments: LlmInputAttachment[] | undefined): unknown {
  if (!attachments?.length) return text
  return [
    { type: 'text', text },
    ...attachments.map(attachment => attachment.type === 'image'
      ? { type: 'image_url', image_url: { url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` } }
      : attachment.type === 'audio'
        ? { type: 'input_audio', input_audio: { data: attachment.dataBase64, format: audioInputFormat(attachment.mimeType) } }
        : { type: 'video_url', video_url: { url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` } })
  ]
}

function audioInputFormat(mimeType: string): string {
  const normalized = mimeType.toLowerCase().split(';', 1)[0]?.trim()
  if (normalized === 'audio/wav' || normalized === 'audio/x-wav' || normalized === 'audio/wave') return 'wav'
  if (normalized === 'audio/mpeg' || normalized === 'audio/mp3') return 'mp3'
  if (normalized === 'audio/flac') return 'flac'
  if (normalized === 'audio/ogg' || normalized === 'audio/opus') return 'ogg'
  return normalized?.replace(/^audio\//u, '') || 'wav'
}

export function detectModelCapabilities(config: BotConfig['model']): ModelCapabilities {
  const model = config.model.toLowerCase()
  let detected: Omit<ModelCapabilities, 'detection'> = { vision: false, audio: false, video: false, webSearch: false }
  let detection: ModelCapabilities['detection'] = 'provider_model_registry'
  if (config.provider === 'mimo' && /^mimo-v2\.5(?:-pro)?(?:$|[-_])/u.test(model)) {
    detected = { vision: true, audio: true, video: true, webSearch: true }
  } else if (config.provider === 'openai' && /(?:^|[-_.])audio(?:$|[-_.])/u.test(model)) {
    detected = { vision: false, audio: true, video: false, webSearch: false }
  } else if (config.provider === 'openai' && /(?:gpt-4o|gpt-5(?:\.|-|$))/u.test(model)) {
    detected = { vision: true, audio: /(?:audio|realtime)/u.test(model), video: false, webSearch: true }
  } else if (config.provider === 'volcengine' && /(?:vision|doubao-seed-2\.1)/u.test(model)) {
    detected = { vision: true, audio: false, video: false, webSearch: false }
  } else if (config.provider !== 'deepseek') {
    detection = 'unknown'
  }
  const enabled = config.multimodal
  if (enabled?.autoDetect === false) {
    return {
      vision: enabled.visionEnabled,
      audio: enabled.audioEnabled,
      video: false,
      webSearch: enabled.onlineResearchEnabled,
      detection: 'configured_override'
    }
  }
  return {
    vision: detected.vision && (enabled?.visionEnabled ?? true),
    audio: detected.audio && (enabled?.audioEnabled ?? true),
    video: detected.video && (enabled?.visionEnabled ?? true),
    webSearch: detected.webSearch && (enabled?.onlineResearchEnabled ?? true),
    detection
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
  readonly capabilities: ModelCapabilities
  readonly #options: ProviderOptions
  readonly #provider: 'deepseek' | 'volcengine' | 'mimo' | 'openai'

  constructor(provider: 'deepseek' | 'volcengine' | 'mimo' | 'openai', options: ProviderOptions, capabilities: ModelCapabilities) {
    this.#provider = provider
    this.#options = options
    this.capabilities = capabilities
  }

  async complete(request: LlmRequest): Promise<LlmResponse> {
    const requested = this.#options.effort
    let effective = requested
    const body: Record<string, unknown> = {
      model: this.#options.model,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.user }],
      stream: false,
      ...(this.#provider === 'openai'
        ? { max_completion_tokens: this.#options.maxOutputTokens }
        : { max_tokens: this.#options.maxOutputTokens })
    }
    if (this.#provider !== 'openai') body.response_format = { type: 'json_object' }
    if (this.#provider === 'deepseek') {
      if (requested === 'none') body.thinking = { type: 'disabled' }
      else {
        effective = requested === 'max' || requested === 'xhigh' ? 'max' : 'high'
        body.thinking = { type: 'enabled' }
        body.reasoning_effort = effective
      }
    } else if (this.#provider !== 'openai') {
      body.reasoning_effort = requested
    }
    if (effective !== requested) this.#options.logger.warn('供应商调整了推理强度', { provider: this.#provider, requested, effective })
    const endpoint = `${normalizeBaseUrl(this.#options.baseUrl)}/chat/completions`
    const payload = await postJson(endpoint, this.#options.apiKey, body, this.#options.timeoutMs)
    const firstText = chatText(payload)
    const usage = chatUsage(payload)
    if (firstText) return { text: firstText, model: this.#options.model, requestedEffort: requested, effectiveEffort: effective, ...(usage ? { usage } : {}) }
    if (this.#provider !== 'deepseek') return { text: requireChatText(payload), model: this.#options.model, requestedEffort: requested, effectiveEffort: effective, ...(usage ? { usage } : {}) }

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
    const retryUsage = chatUsage(retried)
    return { text: retriedText, model: this.#options.model, requestedEffort: requested, effectiveEffort: 'none', ...(retryUsage ? { usage: retryUsage } : {}) }
  }

  async toolTurn(request: LlmToolTurnRequest): Promise<LlmToolTurnResponse> {
    const requested = request.reasoningEffort ?? this.#options.effort
    let effective = requested
    const previous = Array.isArray(request.continuation) ? request.continuation as ChatMessage[] : undefined
    const messages: ChatMessage[] = previous
      ? structuredClone(previous)
      : [{ role: 'system', content: request.system }, { role: 'user', content: attachmentContent(request.user, request.attachments) }]
    for (const result of request.toolResults ?? []) {
      messages.push({ role: 'tool', tool_call_id: result.callId, content: result.output })
    }
    const body: Record<string, unknown> = {
      model: this.#options.model,
      messages,
      tools: request.tools.map(tool => ({ type: 'function', function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      } })),
      parallel_tool_calls: false,
      stream: false,
      ...(this.#provider === 'mimo' || this.#provider === 'openai'
        ? { max_completion_tokens: request.maxOutputTokens ?? this.#options.maxOutputTokens }
        : { max_tokens: request.maxOutputTokens ?? this.#options.maxOutputTokens })
    }
    if (this.#provider === 'deepseek') {
      if (requested === 'none') body.thinking = { type: 'disabled' }
      else {
        effective = requested === 'max' || requested === 'xhigh' ? 'max' : 'high'
        body.thinking = { type: 'enabled' }
        body.reasoning_effort = effective
      }
    } else if (this.#provider === 'mimo') {
      effective = requested === 'none' ? 'none' : 'high'
      body.thinking = { type: requested === 'none' ? 'disabled' : 'enabled' }
    } else if (this.#provider !== 'openai') {
      body.reasoning_effort = requested
    }
    const endpoint = `${normalizeBaseUrl(this.#options.baseUrl)}/chat/completions`
    const payload = await postJson(endpoint, this.#options.apiKey, body, this.#options.timeoutMs)
    const root = payload as ChatPayload
    const assistant = root.choices?.[0]?.message
    if (!assistant) throw new Error('模型工具调用返回缺少 choices[0].message')
    const calls = chatToolCalls(payload)
    const text = typeof assistant.content === 'string' ? assistant.content.trim() : ''
    if (calls.length === 0 && !text) throw new Error('模型既未调用工具，也未返回最终文本')
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: assistant.content ?? '',
      ...(typeof assistant.reasoning_content === 'string' ? { reasoning_content: assistant.reasoning_content } : {}),
      ...(assistant.tool_calls ? { tool_calls: assistant.tool_calls } : {})
    }
    messages.push(assistantMessage)
    const usage = chatUsage(payload)
    return {
      text,
      toolCalls: calls,
      continuation: messages,
      model: this.#options.model,
      requestedEffort: requested,
      effectiveEffort: effective,
      ...(usage ? { usage } : {})
    }
  }
}

class OpenAiResponsesProvider implements LlmProvider {
  readonly capabilities: ModelCapabilities
  readonly #options: ProviderOptions
  constructor(options: ProviderOptions, capabilities: ModelCapabilities) { this.#options = options; this.capabilities = capabilities }

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

  async toolTurn(request: LlmToolTurnRequest): Promise<LlmToolTurnResponse> {
    const effort = request.reasoningEffort ?? this.#options.effort
    const state = request.continuation && typeof request.continuation === 'object'
      ? request.continuation as { previousResponseId?: string }
      : undefined
    const input = state?.previousResponseId
      ? (request.toolResults ?? []).map(result => ({ type: 'function_call_output', call_id: result.callId, output: result.output }))
      : [{ role: 'system', content: request.system }, { role: 'user', content: request.attachments?.length
        ? [{ type: 'input_text', text: request.user }, ...request.attachments.flatMap(attachment => attachment.type === 'image'
          ? [{ type: 'input_image', image_url: `data:${attachment.mimeType};base64,${attachment.dataBase64}` }]
          : [])]
        : request.user }]
    const body: Record<string, unknown> = {
      model: this.#options.model,
      input,
      tools: request.tools.map(tool => ({
        type: 'function', name: tool.name, description: tool.description,
        parameters: tool.parameters, strict: true
      })),
      parallel_tool_calls: false,
      reasoning: { effort },
      text: { verbosity: 'low' },
      max_output_tokens: request.maxOutputTokens ?? this.#options.maxOutputTokens
    }
    if (state?.previousResponseId) body.previous_response_id = state.previousResponseId
    const payload = await postJson(`${normalizeBaseUrl(this.#options.baseUrl)}/responses`, this.#options.apiKey, body, this.#options.timeoutMs)
    const response = payload as {
      id?: string
      output_text?: string
      output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ type?: string; text?: string }> }>
      usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number; input_tokens_details?: { cached_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
    }
    if (!response.id) throw new Error('OpenAI Responses 工具调用返回缺少 id')
    const toolCalls: LlmToolCall[] = (response.output ?? []).flatMap(item =>
      item.type === 'function_call' && typeof item.call_id === 'string' && typeof item.name === 'string'
        ? [{ id: item.call_id, name: item.name, arguments: typeof item.arguments === 'string' ? item.arguments : '{}' }]
        : [])
    let text = typeof response.output_text === 'string' ? response.output_text.trim() : ''
    if (!text) {
      for (const item of response.output ?? []) {
        if (item.type !== 'message') continue
        const part = item.content?.find(content => content.type === 'output_text' && typeof content.text === 'string')
        if (part?.text) { text = part.text.trim(); break }
      }
    }
    if (toolCalls.length === 0 && !text) throw new Error('OpenAI 既未调用工具，也未返回最终文本')
    const usage = response.usage ? {
      inputTokens: numeric(response.usage.input_tokens), outputTokens: numeric(response.usage.output_tokens),
      totalTokens: numeric(response.usage.total_tokens) || numeric(response.usage.input_tokens) + numeric(response.usage.output_tokens),
      ...(numeric(response.usage.output_tokens_details?.reasoning_tokens) > 0 ? { reasoningTokens: numeric(response.usage.output_tokens_details?.reasoning_tokens) } : {}),
      ...(numeric(response.usage.input_tokens_details?.cached_tokens) > 0 ? { cachedInputTokens: numeric(response.usage.input_tokens_details?.cached_tokens) } : {})
    } : undefined
    return {
      text,
      toolCalls,
      continuation: { previousResponseId: response.id },
      model: this.#options.model,
      requestedEffort: effort,
      effectiveEffort: effort,
      ...(usage ? { usage } : {})
    }
  }
}

class MissingKeyProvider implements LlmProvider {
  readonly capabilities: ModelCapabilities
  readonly #variable: string
  constructor(variable: string, capabilities: ModelCapabilities) { this.#variable = variable; this.capabilities = capabilities }
  async complete(): Promise<LlmResponse> { throw new Error(`缺少模型 API Key 环境变量：${this.#variable}`) }
  async toolTurn(): Promise<LlmToolTurnResponse> { throw new Error(`缺少模型 API Key 环境变量：${this.#variable}`) }
}

export function createLlmProvider(config: BotConfig['model'], apiKey: string, logger: Logger): LlmProvider {
  const capabilities = detectModelCapabilities(config)
  if (!apiKey) {
    logger.warn('模型 API Key 未配置；Bot 仍可进入游戏，但不会处理 AI 请求', { variable: config.apiKeyEnv })
    return new MissingKeyProvider(config.apiKeyEnv, capabilities)
  }
  const options: ProviderOptions = { model: config.model, apiKey, baseUrl: config.baseUrl, effort: config.reasoningEffort, timeoutMs: config.timeoutMs, maxOutputTokens: config.maxOutputTokens ?? 4096, logger }
  if (config.provider === 'openai') {
    if (/(?:^|[-_.])audio(?:$|[-_.])/u.test(config.model.toLowerCase())) return new ChatCompletionsProvider('openai', options, capabilities)
    return new OpenAiResponsesProvider(options, capabilities)
  }
  return new ChatCompletionsProvider(config.provider, options, capabilities)
}
