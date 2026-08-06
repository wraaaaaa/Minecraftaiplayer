import test from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config/load-config.js'
import type { BotConfig } from '../src/config/types.js'

const baseConfig: BotConfig = {
  server: { adapter: 'fabric_bridge', connectionMode: 'direct', host: 'example.invalid', port: 25565, lanDiscoveryTimeoutMs: 8000, version: '26.2', username: 'Valid_Bot', auth: 'offline', connectTimeoutMs: 30000, reconnectDelayMs: 10000, autoRespawn: true, respawnDelayMs: 3000, bridgeHost: '127.0.0.1', bridgePort: 8765, actionTimeoutMs: 10000 },
  easyAuth: { enabled: true, registerIfNeeded: true, passwordEnv: 'MINECRAFT_LOGIN_PASSWORD', loginDelayMs: 5000 },
  model: { provider: 'deepseek', model: 'deepseek-v4-flash', apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com', reasoningEffort: 'medium', timeoutMs: 120000, maxOutputTokens: 4096 },
  chat: { requireMention: true, replyPrefix: '', cooldownMs: 2500, proactiveEnabled: false, proactiveIdleMs: 90000, proactiveMinIntervalMs: 180000 },
  storage: { memoryFile: 'data/memory.json', experienceFile: 'data/experience.json', maxEvents: 1000 },
  policyFile: 'config/behavior-rules.json', personaFile: 'config/persona.json', promptsFile: 'config/prompts.json', logging: { file: 'logs/bot.log', level: 'info', console: false }
}

test('EasyAuth-compatible Bot names are accepted', () => {
  assert.doesNotThrow(() => validateConfig(structuredClone(baseConfig)))
})

test('spaces, hyphens, Chinese, and invalid lengths are rejected before startup', () => {
  for (const username of ['ab', 'seventeen_chars_17', 'bot-name', 'bot name', '机器人']) {
    const config = structuredClone(baseConfig)
    config.server.username = username
    assert.throws(() => validateConfig(config), /3-16/)
  }
})

test('auto-respawn delay is validated while old configs remain compatible', () => {
  const legacy = structuredClone(baseConfig)
  delete legacy.server.autoRespawn
  delete legacy.server.respawnDelayMs
  assert.doesNotThrow(() => validateConfig(legacy))
  const invalid = structuredClone(baseConfig)
  invalid.server.respawnDelayMs = 60001
  assert.throws(() => validateConfig(invalid), /0-60000/)
})

test('小米 MiMo 与 Agent 费用硬预算配置可通过校验', () => {
  const config = structuredClone(baseConfig)
  config.model = {
    provider: 'mimo', model: 'mimo-v2.5', apiKeyEnv: 'MIMO_API_KEY', baseUrl: 'https://api.xiaomimimo.com/v1',
    reasoningEffort: 'high', timeoutMs: 120_000, maxOutputTokens: 2048,
    agentMaxSteps: 12, agentMaxApiCalls: 8, agentMaxTaskTokens: 160_000,
    agentMaxInputTokensPerCall: 48_000, agentMaxOutputTokens: 1024,
    agentFollowupReasoningEffort: 'none',
    multimodal: { autoDetect: true, visionEnabled: true, audioEnabled: true, onlineResearchEnabled: true, sensoryDirectory: 'data/sensory' }
  }
  assert.doesNotThrow(() => validateConfig(config))
})
