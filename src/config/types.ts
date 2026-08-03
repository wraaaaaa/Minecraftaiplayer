export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface BotConfig {
  server: {
    adapter: 'fabric_bridge' | 'mineflayer'
    host: string
    port: number
    version: string
    username: string
    auth: 'offline' | 'microsoft'
    connectTimeoutMs: number
    reconnectDelayMs: number
    bridgeHost: string
    bridgePort: number
    actionTimeoutMs: number
  }
  easyAuth: {
    enabled: boolean
    passwordEnv: string
    loginDelayMs: number
  }
  model: {
    provider: 'deepseek' | 'volcengine' | 'openai'
    model: string
    apiKeyEnv: string
    baseUrl: string
    reasoningEffort: ReasoningEffort
    timeoutMs: number
  }
  chat: {
    requireMention: boolean
    replyPrefix: string
    cooldownMs: number
    proactiveEnabled: boolean
    proactiveIdleMs: number
    proactiveMinIntervalMs: number
  }
  storage: {
    memoryFile: string
    experienceFile: string
    maxEvents: number
  }
  policyFile: string
  personaFile: string
  logging: {
    file: string
    level: 'debug' | 'info' | 'warn' | 'error'
    console: boolean
  }
}

export interface Persona {
  name: string
  description: string
  speakingStyle: string
  goals: string[]
  boundaries: string[]
}

export interface BehaviorRules {
  version: number
  denyBreakingPlayerProperty: boolean
  denyOpeningPlayerContainers: boolean
  denyTakingPlayerItems: boolean
  wildernessDevelopmentOnly: boolean
  allowSelfDefense: boolean
  selfDefenseWindowMs: number
  stopSelfDefenseWhenThreatEnds: boolean
  allowPlayerOrderedPvp: boolean
  allowDestructiveActionsWhenOwnershipUnknown: boolean
  proactiveChat: {
    enabled: boolean
    avoidSecrets: boolean
    avoidSpam: boolean
  }
}
