export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export interface BotConfig {
  server: {
    adapter: 'fabric_bridge' | 'mineflayer'
    connectionMode: 'direct' | 'lan'
    host: string
    port: number
    lanDiscoveryTimeoutMs: number
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
    registerIfNeeded: boolean
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
  promptsFile: string
  logging: {
    file: string
    level: 'debug' | 'info' | 'warn' | 'error'
    console: boolean
  }
}

export interface PromptTemplates {
  identity: string
  capabilityRules: string[]
  memoryRules: string[]
  actionContract: string
  proactiveInstruction: string
}

export interface SkinConfig {
  enabled: boolean
  model: 'classic' | 'slim'
  visibilityMode: 'client_pack' | 'online_provider' | 'microsoft'
  skinFile: string
  capeFile: string
  onlineProvider: {
    name: string
    profileName: string
    website: string
  }
}

export interface ModsConfig {
  sourceDirectory: string
  syncOnClientStart: boolean
  excludeFilePatterns: string[]
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
