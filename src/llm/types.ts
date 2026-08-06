import type { ReasoningEffort } from '../config/types.js'

export interface LlmRequest {
  system: string
  user: string
}

export interface LlmResponse {
  text: string
  model: string
  requestedEffort: ReasoningEffort
  effectiveEffort: ReasoningEffort
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
}

export interface LlmToolTurnResponse {
  text: string
  toolCalls: LlmToolCall[]
  /** Opaque provider state containing assistant tool calls and private reasoning linkage. */
  continuation?: unknown
  model: string
  requestedEffort: ReasoningEffort
  effectiveEffort: ReasoningEffort
}

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>
  toolTurn?(request: LlmToolTurnRequest): Promise<LlmToolTurnResponse>
}
