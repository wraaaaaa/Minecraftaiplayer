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
    autoRespawn?: boolean
    respawnDelayMs?: number
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
    maxOutputTokens?: number
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
    taskFile?: string
    autonomyFile?: string
    maxEvents: number
  }
  autonomy?: {
    enabled: boolean
    ownerName: string
    commandArbitrationMs: number
    contextualAddressing: boolean
    directAddressDistance: number
    conversationWindowMs: number
    lowHealthThreshold: number
    criticalHealthThreshold: number
    eatBelowFood: number
    hostileScanRadius: number
    wildernessMinPlayerDistance: number
    safeIdleEnabled: boolean
    autoGather: boolean
    autoCraft: boolean
    autoBuildShelter: boolean
    developmentZone?: {
      enabled: boolean
      dimension: string
      minX: number
      minY: number
      minZ: number
      maxX: number
      maxY: number
      maxZ: number
    }
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

export interface AutonomyConfig {
  enabled: boolean
  ownerName: string
  commandArbitrationMs: number
  contextualAddressing: boolean
  directAddressDistance: number
  conversationWindowMs: number
  lowHealthThreshold: number
  criticalHealthThreshold: number
  eatBelowFood: number
  hostileScanRadius: number
  wildernessMinPlayerDistance: number
  safeIdleEnabled: boolean
  autoGather: boolean
  autoCraft: boolean
  autoBuildShelter: boolean
  developmentZone?: {
    enabled: boolean
    dimension: string
    minX: number
    minY: number
    minZ: number
    maxX: number
    maxY: number
    maxZ: number
  }
}

export const DEFAULT_AUTONOMY_CONFIG: Readonly<AutonomyConfig> = Object.freeze({
  enabled: true,
  ownerName: 'wraaaaaa',
  commandArbitrationMs: 350,
  contextualAddressing: true,
  directAddressDistance: 8,
  conversationWindowMs: 60_000,
  lowHealthThreshold: 10,
  criticalHealthThreshold: 6,
  eatBelowFood: 16,
  hostileScanRadius: 12,
  wildernessMinPlayerDistance: 48,
  safeIdleEnabled: true,
  autoGather: true,
  autoCraft: true,
  autoBuildShelter: true
})

export function autonomyConfig(config: BotConfig): AutonomyConfig {
  return { ...DEFAULT_AUTONOMY_CONFIG, ...config.autonomy }
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
