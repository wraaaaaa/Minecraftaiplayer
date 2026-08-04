import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createConnection, createServer, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import type { BehaviorRules, BotConfig, Persona } from '../src/config/types.js'
import { Logger } from '../src/core/logger.js'
import { MemoryStore } from '../src/memory/memory-store.js'
import { FabricBridgeClient } from '../src/minecraft/fabric-bridge-client.js'
import { PolicyEngine } from '../src/policy/policy-engine.js'

const persona: Persona = { name: '小麦', description: '测试', speakingStyle: '简短', goals: [], boundaries: [] }
const rules: BehaviorRules = {
  version: 1,
  denyBreakingPlayerProperty: true,
  denyOpeningPlayerContainers: true,
  denyTakingPlayerItems: true,
  wildernessDevelopmentOnly: true,
  allowSelfDefense: true,
  selfDefenseWindowMs: 15000,
  stopSelfDefenseWhenThreatEnds: true,
  allowPlayerOrderedPvp: false,
  allowDestructiveActionsWhenOwnershipUnknown: false,
  proactiveChat: { enabled: true, avoidSecrets: true, avoidSpam: true }
}

async function unusedPort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert(address && typeof address === 'object')
  const port = address.port
  await new Promise<void>((resolve) => server.close(() => resolve()))
  return port
}

async function connectWithRetry(port: number): Promise<Socket> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return await new Promise<Socket>((resolve, reject) => {
        const socket = createConnection({ host: '127.0.0.1', port })
        socket.once('connect', () => resolve(socket))
        socket.once('error', reject)
      })
    } catch {
      await delay(10)
    }
  }
  throw new Error('测试客户端无法连接 Fabric 桥')
}

test('Fabric 本机桥完成握手、状态同步和动作结果往返', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'minecraft-ai-fabric-'))
  const port = await unusedPort()
  const config = {
    server: {
      adapter: 'fabric_bridge', connectionMode: 'direct', host: 'ciallo.kim', port: 25565, lanDiscoveryTimeoutMs: 8000, version: '26.2', username: 'CialloAI', auth: 'offline',
      connectTimeoutMs: 2000, reconnectDelayMs: 100, bridgeHost: '127.0.0.1', bridgePort: port, actionTimeoutMs: 1000
    },
    easyAuth: { enabled: true, registerIfNeeded: true, passwordEnv: 'MINECRAFT_LOGIN_PASSWORD', loginDelayMs: 10 },
    model: { provider: 'deepseek', model: 'test', apiKeyEnv: 'TEST_KEY', baseUrl: 'https://example.invalid', reasoningEffort: 'low', timeoutMs: 1000 },
    chat: { requireMention: true, replyPrefix: '', cooldownMs: 10, proactiveEnabled: false, proactiveIdleMs: 1000, proactiveMinIntervalMs: 1000 },
    storage: { memoryFile: path.join(directory, 'memory.json'), experienceFile: path.join(directory, 'experience.json'), maxEvents: 10 },
    policyFile: 'config/behavior-rules.json', personaFile: 'config/persona.json', promptsFile: 'config/prompts.json',
    logging: { file: path.join(directory, 'bot.log'), level: 'error', console: false }
  } satisfies BotConfig
  const logger = new Logger(config.logging)
  const memory = new MemoryStore(config.storage.memoryFile, persona.name, config.storage.maxEvents)
  await memory.load()
  const bridge = new FabricBridgeClient({ config, persona, logger, memory, policy: new PolicyEngine(rules), statusHandler: async () => {} })

  try {
    const connecting = bridge.connect()
    const socket = await connectWithRetry(port)
    socket.setEncoding('utf8')
    socket.write(`${JSON.stringify({ type: 'hello', protocolVersion: 1, adapter: 'fabric-26.2' })}\n`)
    await connecting
    socket.write(`${JSON.stringify({ type: 'state', connected: true, position: { x: 1, y: 64, z: 2 }, health: 20, food: 20, inventory: [{ name: '石头', count: 3 }], nearbyPlayers: [{ name: 'Alice', distance: 4 }] })}\n`)
    await delay(20)
    assert.deepEqual(bridge.snapshot().position, { x: 1, y: 64, z: 2 })
    assert.equal(bridge.snapshot().nearbyPlayers[0]?.name, 'Alice')

    const resultPromise = bridge.execute({ type: 'look_at_player', target: 'Alice' })
    const action = await new Promise<{ id: string }>((resolve, reject) => {
      let buffer = ''
      const timeout = setTimeout(() => reject(new Error('未收到动作')), 1000)
      socket.on('data', (chunk: string) => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end < 0) return
        clearTimeout(timeout)
        resolve(JSON.parse(buffer.slice(0, end)) as { id: string })
      })
    })
    socket.write(`${JSON.stringify({ type: 'action_result', id: action.id, ok: true, detail: '完成' })}\n`)
    assert.deepEqual(await resultPromise, { ok: true, detail: '完成' })
    socket.destroy()
  } finally {
    await bridge.close()
    await logger.flush()
    await rm(directory, { recursive: true, force: true })
  }
})
