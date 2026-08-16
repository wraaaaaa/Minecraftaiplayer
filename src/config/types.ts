export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'

export type SpeechProvider = 'volcengine' | 'openai' | 'mimo' | 'multimodal' | 'custom'
export type SpeechProtocol = 'volcengine_v1' | 'openai_speech' | 'openai_chat_audio' | 'mimo_chat_audio' | 'custom_binary' | 'custom_json_base64'

export interface SpeechConfig {
  enabled: boolean
  provider: SpeechProvider
  /** Protocol is mainly useful for custom gateways; known providers select their native protocol. */
  protocol: SpeechProtocol
  model: string
  apiKeyEnv: string
  baseUrl: string
  voice: string
  style: string
  speed: number
  volume: number
  sampleRate: 16000 | 24000 | 32000 | 48000
  timeoutMs: number
  maxTextChars: number
  maxAudioSeconds: number
  queueLimit: number
  cacheEntries: number
  /** Volcengine online TTS uses an AppID in addition to its Access Token. */
  volcengineAppIdEnv: string
  volcengineCluster: string
  /** Custom endpoints never store the credential itself here, only its environment-variable name. */
  customAuthHeader: string
  customAuthScheme: string
  customAudioJsonPath: string
}

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
  speech?: SpeechConfig
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
      allowSkillLearning: boolean
      minimumRepeatedFailures: number
      minimumStepsForSkill: number
      researchProvider: 'baidu' | 'searxng' | 'disabled'
      researchEndpoint: string
      researchTimeoutMs: number
    }
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
  playerMonitor?: PlayerMonitorConfig
  policyFile: string
  personaFile: string
  promptsFile: string
  logging: {
    file: string
    level: 'debug' | 'info' | 'warn' | 'error'
    console: boolean
  }
}

export const DEFAULT_SPEECH_CONFIG: Readonly<SpeechConfig> = Object.freeze({
  enabled: false,
  provider: 'volcengine',
  protocol: 'volcengine_v1',
  model: 'volcano_tts',
  apiKeyEnv: 'VOLCENGINE_TTS_ACCESS_TOKEN',
  baseUrl: 'https://openspeech.bytedance.com/api/v1/tts',
  voice: 'BV001_streaming',
  style: '用自然、温柔、像朋友聊天的中文语气朗读，不要播报表情符号或系统信息。',
  speed: 1,
  volume: 1,
  sampleRate: 24000,
  timeoutMs: 30000,
  maxTextChars: 180,
  maxAudioSeconds: 18,
  queueLimit: 3,
  cacheEntries: 32,
  volcengineAppIdEnv: 'VOLCENGINE_TTS_APP_ID',
  volcengineCluster: 'volcano_tts',
  customAuthHeader: 'Authorization',
  customAuthScheme: 'Bearer',
  customAudioJsonPath: 'audio.data'
})

export function speechConfig(config: BotConfig): SpeechConfig {
  return { ...DEFAULT_SPEECH_CONFIG, ...config.speech }
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
  firstHome: Object.freeze({ enabled: true, dimension: 'minecraft:overworld', x: 1226, y: 65, z: 199, radius: 10 })
})

export function autonomyConfig(config: BotConfig): AutonomyConfig {
  // 手工坐标框已废弃。旧 bot.json 即使仍保存 developmentZone，也不会再限制或授权行为。
  const configured = { ...config.autonomy }
  delete configured.developmentZone
  return { ...DEFAULT_AUTONOMY_CONFIG, ...configured, firstHome: { ...DEFAULT_AUTONOMY_CONFIG.firstHome, ...configured.firstHome } }
}

export interface PlayerMonitorConfig {
  enabled: boolean
  pollIntervalMs: number
  onlineAfterMs: number
  offlineAfterMs: number
  statusTimeoutMs: number
}

export const DEFAULT_PLAYER_MONITOR_CONFIG: Readonly<PlayerMonitorConfig> = Object.freeze({
  enabled: false,
  pollIntervalMs: 15_000,
  onlineAfterMs: 60_000,
  offlineAfterMs: 30 * 60_000,
  statusTimeoutMs: 5_000
})

export function playerMonitorConfig(config: BotConfig): PlayerMonitorConfig {
  return { ...DEFAULT_PLAYER_MONITOR_CONFIG, ...config.playerMonitor }
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
    allowSkillLearning: boolean
    minimumRepeatedFailures: number
    minimumStepsForSkill: number
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
    allowSkillLearning: true,
    minimumRepeatedFailures: 3,
    minimumStepsForSkill: 2,
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
