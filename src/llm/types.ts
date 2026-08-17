import type { ReasoningEffort } from '../config/types.js'

export interface LlmUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  reasoningTokens?: number
  cachedInputTokens?: number
}

export interface ModelCapabilities {
  vision: boolean
  audio: boolean
  video: boolean
  webSearch: boolean
  detection: 'provider_model_registry' | 'configured_override' | 'unknown'
}

export type LlmInputAttachment =
  | { type: 'image'; mimeType: string; dataBase64: string }
  | { type: 'audio'; mimeType: string; dataBase64: string }
  | { type: 'video'; mimeType: string; dataBase64: string }

export interface LlmRequest {
  system: string
  user: string
}

export interface LlmResponse {
  text: string
  model: string
  requestedEffort: ReasoningEffort
  effectiveEffort: ReasoningEffort
  usage?: LlmUsage
}

export interface LlmToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LlmToolResult {
  callId: string
  output: string
}

export interface LlmToolCall {
  id: string
  name: string
  arguments: string
}

export interface LlmToolTurnRequest {
  system: string
  user: string
  tools: LlmToolDefinition[]
  /** 供应商拥有的续接状态。调用方必须在下一轮原样返回它。 */
  continuation?: unknown
  toolResults?: LlmToolResult[]
  /** 仅随第一个用户轮次发送。 */
  attachments?: LlmInputAttachment[]
  /** Agent 循环使用的每轮成本/延迟控制。 */
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

export interface LlmToolTurnResponse {
  text: string
  toolCalls: LlmToolCall[]
  /** 不透明的供应商状态，包含助手工具调用和私有推理关联。 */
  continuation?: unknown
  model: string
  requestedEffort: ReasoningEffort
  effectiveEffort: ReasoningEffort
  usage?: LlmUsage
}

export interface LlmProvider {
  readonly capabilities?: ModelCapabilities
  complete(request: LlmRequest): Promise<LlmResponse>
  toolTurn?(request: LlmToolTurnRequest): Promise<LlmToolTurnResponse>
}
