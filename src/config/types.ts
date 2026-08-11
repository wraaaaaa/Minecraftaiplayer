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
    provider: 'deepseek' | 'volcengine' | 'openai' | 'mimo'
    model: string
    apiKeyEnv: string
    baseUrl: string
    reasoningEffort: ReasoningEffort
    timeoutMs: number
    maxOutputTokens?: number
    /** Maximum observe/tool/result turns for a player-issued Agent task. */
    agentMaxSteps?: number
    /** Smaller per-heartbeat budget for idle self-development. */
    autonomousAgentMaxSteps?: number
    /** Hard provider-call budget for one player task. */
    agentMaxApiCalls?: number
    /** Hard total input+output token budget for one player task. */
    agentMaxTaskTokens?: number
    /** Estimated/actual input ceiling for any single Agent request. */
    agentMaxInputTokensPerCall?: number
    /** Smaller output ceiling for one Agent decision. */
    agentMaxOutputTokens?: number
    /** Successful tool follow-ups normally do not need another long chain of thought. */
    agentFollowupReasoningEffort?: ReasoningEffort
    multimodal?: {
      autoDetect: boolean
      visionEnabled: boolean
      audioEnabled: boolean
      onlineResearchEnabled: boolean
      sensoryDirectory: string
    }
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
    progressionFile?: string
    ownedBlocksFile?: string
    maxEvents: number
  }
  agentWorkspace?: {
    promptDirectory: string
    playerProfilesDirectory: string
    contextBudgetChars: number
    compressionTriggerRatio: number
    retainRecentEvents: number
    selfImprovement: {
      enabled: boolean
      allowPromptEdits: boolean
      allowBehaviorPatches: boolean
      minimumRepeatedFailures: number
      researchProvider: 'baidu' | 'searxng' | 'disabled'
      researchEndpoint: string
      researchTimeoutMs: number
    }
  }
  autonomy?: {
    enabled: boolean
    /** Companion mode never asks the model to invent idle survival goals. */
    mode?: 'companion' | 'survival'
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
    autoInviteNearbyPlayers?: boolean
    inviteRadius?: number
    inviteCooldownMs?: number
    discardWornTools?: boolean
    wornToolRemainingDurability?: number
    autoGather: boolean
    autoCraft: boolean
    autoBuildShelter: boolean
    autoHunt?: boolean
    autoSmelt?: boolean
    autoMine?: boolean
    autoTrade?: boolean
    autoEnchant?: boolean
    autoDimensionTravel?: boolean
    autoSleep?: boolean
    protectOwner?: boolean
    allowVerifiedWilderness?: boolean
    allowTeleportCommand?: boolean
    longTermGoal?: 'reach_end'
    firstHome?: {
      enabled: boolean
      dimension: string
      x: number
      y: number
      z: number
      radius: number
    }
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
  mode: 'companion' | 'survival'
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
  autoInviteNearbyPlayers: boolean
  inviteRadius: number
  inviteCooldownMs: number
  discardWornTools: boolean
  wornToolRemainingDurability: number
  autoGather: boolean
  autoCraft: boolean
  autoBuildShelter: boolean
  autoHunt: boolean
  autoSmelt: boolean
  autoMine: boolean
  autoTrade: boolean
  autoEnchant: boolean
  autoDimensionTravel: boolean
  autoSleep: boolean
  protectOwner: boolean
  allowVerifiedWilderness: boolean
  allowTeleportCommand: boolean
  longTermGoal: 'reach_end'
  firstHome: {
    enabled: boolean
    dimension: string
    x: number
    y: number
    z: number
    radius: number
  }
  /** @deprecated 仅为读取旧配置保留；运行时不再使用手工坐标范围。 */
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
  mode: 'companion',
  ownerName: 'wraaaaaa',
  commandArbitrationMs: 350,
  contextualAddressing: true,
  directAddressDistance: 8,
  conversationWindowMs: 60_000,
  lowHealthThreshold: 10,
  criticalHealthThreshold: 6,
  eatBelowFood: 20,
  hostileScanRadius: 12,
  wildernessMinPlayerDistance: 48,
  safeIdleEnabled: true,
  autoInviteNearbyPlayers: true,
  inviteRadius: 7,
  inviteCooldownMs: 30 * 60_000,
  discardWornTools: true,
  wornToolRemainingDurability: 1,
  autoGather: true,
  autoCraft: true,
  autoBuildShelter: true,
  autoHunt: true,
  autoSmelt: true,
  autoMine: true,
  autoTrade: true,
  autoEnchant: true,
  autoDimensionTravel: true,
  autoSleep: true,
  protectOwner: true,
  allowVerifiedWilderness: true,
  allowTeleportCommand: false,
  longTermGoal: 'reach_end',
  firstHome: Object.freeze({ enabled: true, dimension: 'minecraft:overworld', x: 1226, y: 65, z: 199, radius: 10 })
})

export function autonomyConfig(config: BotConfig): AutonomyConfig {
  // 手工坐标框已废弃。旧 bot.json 即使仍保存 developmentZone，也不会再限制或授权行为。
  const configured = { ...config.autonomy }
  delete configured.developmentZone
  return { ...DEFAULT_AUTONOMY_CONFIG, ...configured, firstHome: { ...DEFAULT_AUTONOMY_CONFIG.firstHome, ...configured.firstHome } }
}

export interface AgentWorkspaceConfig {
  promptDirectory: string
  playerProfilesDirectory: string
  contextBudgetChars: number
  compressionTriggerRatio: number
  retainRecentEvents: number
  selfImprovement: {
    enabled: boolean
    allowPromptEdits: boolean
    allowBehaviorPatches: boolean
    minimumRepeatedFailures: number
    researchProvider: 'baidu' | 'searxng' | 'disabled'
    researchEndpoint: string
    researchTimeoutMs: number
  }
}

export const DEFAULT_AGENT_WORKSPACE_CONFIG: Readonly<AgentWorkspaceConfig> = Object.freeze({
  promptDirectory: 'data/agent-prompts',
  playerProfilesDirectory: 'data/player-profiles',
  contextBudgetChars: 48_000,
  compressionTriggerRatio: 0.72,
  retainRecentEvents: 16,
  selfImprovement: Object.freeze({
    enabled: true,
    allowPromptEdits: true,
    allowBehaviorPatches: true,
    minimumRepeatedFailures: 3,
    researchProvider: 'baidu',
    researchEndpoint: 'https://www.baidu.com/s',
    researchTimeoutMs: 12_000
  })
})

export function agentWorkspaceConfig(config: BotConfig): AgentWorkspaceConfig {
  const configured = config.agentWorkspace
  return {
    ...DEFAULT_AGENT_WORKSPACE_CONFIG,
    ...configured,
    selfImprovement: {
      ...DEFAULT_AGENT_WORKSPACE_CONFIG.selfImprovement,
      ...configured?.selfImprovement
    }
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
