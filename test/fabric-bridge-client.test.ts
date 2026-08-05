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
import { SecretGuard } from '../src/security/secret-guard.js'

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
      adapter: 'fabric_bridge', connectionMode: 'direct', host: '你的域名.com', port: 25565, lanDiscoveryTimeoutMs: 8000, version: '26.2', username: 'CialloAI', auth: 'offline',
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
  const bridge = new FabricBridgeClient({ config, persona, logger, memory, policy: new PolicyEngine(rules), secrets: new SecretGuard([]), statusHandler: async () => {} })
  const receivedMessages: Array<{ name: string; message: string }> = []
  bridge.setMessageHandler(async (identity, message) => { receivedMessages.push({ name: identity.name, message }) })

  try {
    const connecting = bridge.connect()
    const socket = await connectWithRetry(port)
    socket.setEncoding('utf8')
    socket.write(`${JSON.stringify({ type: 'hello', protocolVersion: 1, adapter: 'fabric-26.2' })}\n`)
    await connecting
    socket.write(`${JSON.stringify({ type: 'state', connected: true, position: { x: 1, y: 64, z: 2 }, health: 20, food: 20, inventory: [{ name: '石头', itemId: 'minecraft:stone', placeableBlockId: 'minecraft:stone', count: 3 }], nearbyPlayers: [{ name: 'Alice', distance: 4 }], blockSurvey: { radius: 8, verticalRadius: 5, sampledBlocks: 3179, solidBlocks: 1200, blockEntityCount: 0, center: { x: 1, y: 64, z: 2 }, resources: [{ blockId: 'minecraft:stone', category: 'stone', count: 500, nearestDistance: 1, nearest: { x: 1, y: 63, z: 2 } }], artificial: [], other: [], classification: 'natural_terrain_likely', protectedLikely: false, reasons: ['natural_resource_blocks_detected'] }, activePrimitive: 'seek_shelter', home: { dimension: 'minecraft:overworld', x: 8, y: 65, z: 9, doorX: 9, doorY: 65, doorZ: 9, persisted: true } })}\n`)
    await delay(20)
    assert.deepEqual(bridge.snapshot().position, { x: 1, y: 64, z: 2 })
    assert.equal(bridge.snapshot().nearbyPlayers[0]?.name, 'Alice')
    assert.equal(bridge.snapshot().inventory[0]?.placeableBlockId, 'minecraft:stone')
    assert.equal(bridge.snapshot().blockSurvey?.classification, 'natural_terrain_likely')
    assert.equal(bridge.snapshot().blockSurvey?.resources[0]?.nearest?.y, 63)
    assert.equal(bridge.snapshot().activePrimitive, 'seek_shelter')
    assert.deepEqual(bridge.snapshot().home, { dimension: 'minecraft:overworld', x: 8, y: 65, z: 9, doorX: 9, doorY: 65, doorZ: 9, persisted: true })

    socket.write(`${JSON.stringify({ type: 'game_message', message: '<[管理员]Alice> @CialloAI 跟我来' })}\n`)
    await delay(20)
    assert.deepEqual(receivedMessages, [{ name: 'Alice', message: '跟我来' }])
    socket.write(`${JSON.stringify({ type: 'player_chat', name: 'Alice', uuid: '00000000-0000-0000-0000-000000000001', message: '@CialloAI 跟我来' })}\n`)
    await delay(20)
    assert.equal(receivedMessages.length, 1)

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
