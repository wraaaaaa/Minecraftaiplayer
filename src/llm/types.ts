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

export interface LlmProvider {
  complete(request: LlmRequest): Promise<LlmResponse>
}
