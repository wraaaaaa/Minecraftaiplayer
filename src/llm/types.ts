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
  /** Provider-owned continuation. Callers must return it unchanged on the next turn. */
  continuation?: unknown
  toolResults?: LlmToolResult[]
  /** Only sent with the first user turn. */
  attachments?: LlmInputAttachment[]
  /** Per-turn cost/latency controls used by the Agent loop. */
  maxOutputTokens?: number
  reasoningEffort?: ReasoningEffort
}

export interface LlmToolTurnResponse {
  text: string
  toolCalls: LlmToolCall[]
  /** Opaque provider state containing assistant tool calls and private reasoning linkage. */
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
