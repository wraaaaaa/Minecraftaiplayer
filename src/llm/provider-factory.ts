import type { BotConfig, ReasoningEffort } from '../config/types.js'
import type { Logger } from '../core/logger.js'
import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
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

  async toolTurn(request: LlmToolTurnRequest): Promise<LlmToolTurnResponse> {
    const requested = this.#options.effort
    let effective = requested
    const previous = Array.isArray(request.continuation) ? request.continuation as ChatMessage[] : undefined
    const messages: ChatMessage[] = previous
      ? structuredClone(previous)
      : [{ role: 'system', content: request.system }, { role: 'user', content: request.user }]
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
    return {
      text,
      toolCalls: calls,
      continuation: messages,
      model: this.#options.model,
      requestedEffort: requested,
      effectiveEffort: effective
    }
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

  async toolTurn(request: LlmToolTurnRequest): Promise<LlmToolTurnResponse> {
    const effort = this.#options.effort
    const state = request.continuation && typeof request.continuation === 'object'
      ? request.continuation as { previousResponseId?: string }
      : undefined
    const input = state?.previousResponseId
      ? (request.toolResults ?? []).map(result => ({ type: 'function_call_output', call_id: result.callId, output: result.output }))
      : [{ role: 'system', content: request.system }, { role: 'user', content: request.user }]
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
      max_output_tokens: this.#options.maxOutputTokens
    }
    if (state?.previousResponseId) body.previous_response_id = state.previousResponseId
    const payload = await postJson(`${normalizeBaseUrl(this.#options.baseUrl)}/responses`, this.#options.apiKey, body, this.#options.timeoutMs)
    const response = payload as {
      id?: string
      output_text?: string
      output?: Array<{ type?: string; call_id?: string; name?: string; arguments?: string; content?: Array<{ type?: string; text?: string }> }>
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
    return {
      text,
      toolCalls,
      continuation: { previousResponseId: response.id },
      model: this.#options.model,
      requestedEffort: effort,
      effectiveEffort: effort
    }
  }
}

class MissingKeyProvider implements LlmProvider {
  readonly #variable: string
  constructor(variable: string) { this.#variable = variable }
  async complete(): Promise<LlmResponse> { throw new Error(`缺少模型 API Key 环境变量：${this.#variable}`) }
  async toolTurn(): Promise<LlmToolTurnResponse> { throw new Error(`缺少模型 API Key 环境变量：${this.#variable}`) }
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
