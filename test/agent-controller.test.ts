import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AgentController } from '../src/agent/agent-controller.js'
import type { WorldState } from '../src/agent/world-state.js'
import type { BehaviorRules, BotConfig, Persona, PromptTemplates } from '../src/config/types.js'
import { Logger } from '../src/core/logger.js'
import { ExperienceStore } from '../src/experience/experience-store.js'
import type { LlmProvider } from '../src/llm/types.js'
import { MemoryStore } from '../src/memory/memory-store.js'
import type { AgentAction } from '../src/policy/policy-engine.js'
import { PolicyEngine } from '../src/policy/policy-engine.js'

const config: BotConfig = {
  server: { adapter: 'fabric_bridge', connectionMode: 'direct', host: 'localhost', port: 25565, lanDiscoveryTimeoutMs: 8000, version: '26.2', username: 'CialloAI', auth: 'offline', connectTimeoutMs: 30000, reconnectDelayMs: 10000, bridgeHost: '127.0.0.1', bridgePort: 8765, actionTimeoutMs: 10000 },
  easyAuth: { enabled: false, registerIfNeeded: false, passwordEnv: 'MINECRAFT_LOGIN_PASSWORD', loginDelayMs: 0 },
  model: { provider: 'deepseek', model: 'mock', apiKeyEnv: 'TEST_KEY', baseUrl: 'http://127.0.0.1', reasoningEffort: 'low', timeoutMs: 5000, maxOutputTokens: 4096 },
  chat: { requireMention: true, replyPrefix: '', cooldownMs: 0, proactiveEnabled: false, proactiveIdleMs: 1000, proactiveMinIntervalMs: 1000 },
  storage: { memoryFile: 'data/memory.json', experienceFile: 'data/experience.json', maxEvents: 100 },
  policyFile: 'config/behavior-rules.json', personaFile: 'config/persona.json', promptsFile: 'config/prompts.json', logging: { file: 'logs/bot.log', level: 'error', console: false }
}
const persona: Persona = { name: 'CialloAI', description: '测试队友', speakingStyle: '简短', goals: ['帮助玩家'], boundaries: ['不破坏'] }
const prompts: PromptTemplates = { identity: '{{name}} {{description}}', capabilityRules: ['只按状态行动'], memoryRules: ['玩家分别记忆'], actionContract: '只输出 JSON', proactiveInstruction: '保持安静' }
const rules: BehaviorRules = { version: 1, denyBreakingPlayerProperty: true, denyOpeningPlayerContainers: true, denyTakingPlayerItems: true, wildernessDevelopmentOnly: true, allowSelfDefense: true, selfDefenseWindowMs: 15000, stopSelfDefenseWhenThreatEnds: true, allowPlayerOrderedPvp: false, allowDestructiveActionsWhenOwnershipUnknown: false, proactiveChat: { enabled: true, avoidSecrets: true, avoidSpam: true } }
const world: WorldState = { connected: true, position: { x: 0, y: 64, z: 0 }, health: 20, food: 20, inventory: [], nearbyPlayers: [{ name: 'Alice', distance: 2 }], dimension: 'minecraft:overworld' }

test('玩家消息经过模型、策略、真实动作接口并写入专属记忆', async () => {
  const suffix = `${process.pid}-${Date.now()}`
  const memory = new MemoryStore(path.join(tmpdir(), `mcai-agent-memory-${suffix}.json`), persona.name, 100)
  const experience = new ExperienceStore(path.join(tmpdir(), `mcai-agent-experience-${suffix}.json`))
  const logger = new Logger({ file: path.join(tmpdir(), `mcai-agent-${suffix}.log`), level: 'error', console: false })
  const provider: LlmProvider = { complete: async () => ({ text: '{"reply":"我跟着你。","action":{"type":"follow_player","target":"Alice"},"remember":"Alice 喜欢结伴探索"}', model: 'mock', requestedEffort: 'low', effectiveEffort: 'low' }) }
  const actions: AgentAction[] = []; const chats: string[] = []
  const executor = { execute: async (action: AgentAction) => { actions.push(action); return { ok: true, detail: 'executed' } }, chat: async (message: string) => { chats.push(message) } }
  const controller = new AgentController({ config, persona, prompts, provider, memory, experience, policy: new PolicyEngine(rules), executor, logger })
  await controller.handlePlayerMessage({ name: 'Alice', uuid: 'alice-uuid' }, 'CialloAI 跟着我', world)
  assert.deepEqual(actions, [{ type: 'follow_player', target: 'Alice' }])
  assert.deepEqual(chats, ['我跟着你。'])
  const saved = await memory.load()
  const alice = saved.players['uuid:alice-uuid']
  assert.ok(alice?.facts.includes('Alice 喜欢结伴探索'))
  assert.deepEqual(saved.events.map(event => event.type), ['player_message', 'fact', 'bot_reply'])
  await logger.flush()
})

test('模型超时时在游戏内返回明确提示', async () => {
  const suffix = `${process.pid}-${Date.now()}-timeout`
  const memory = new MemoryStore(path.join(tmpdir(), `mcai-agent-memory-${suffix}.json`), persona.name, 100)
  const experience = new ExperienceStore(path.join(tmpdir(), `mcai-agent-experience-${suffix}.json`))
  const logger = new Logger({ file: path.join(tmpdir(), `mcai-agent-${suffix}.log`), level: 'error', console: false })
  const provider: LlmProvider = { complete: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError') } }
  const chats: string[] = []
  const executor = { execute: async () => ({ ok: true, detail: 'executed' }), chat: async (message: string) => { chats.push(message) } }
  const controller = new AgentController({ config, persona, prompts, provider, memory, experience, policy: new PolicyEngine(rules), executor, logger })
  await controller.handlePlayerMessage({ name: 'Alice', uuid: 'alice-timeout' }, '你好', world)
  assert.deepEqual(chats, ['我这次思考超时了，请再说一次。'])
  await logger.flush()
})
