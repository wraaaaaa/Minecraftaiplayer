import assert from 'node:assert/strict'
import test from 'node:test'
import { sensorySnapshot } from '../src/agent/multimodal-sensors.js'
import type { BotConfig } from '../src/config/types.js'
import type { WorldState } from '../src/agent/world-state.js'

const model: BotConfig['model'] = {
  provider: 'mimo', model: 'mimo-v2.5', apiKeyEnv: 'MIMO_API_KEY', baseUrl: 'https://api.xiaomimimo.com/v1',
  reasoningEffort: 'high', timeoutMs: 120_000,
  multimodal: { autoDetect: true, visionEnabled: true, audioEnabled: true, onlineResearchEnabled: true, sensoryDirectory: 'data/nonexistent-sensory-test' }
}

const world: WorldState = {
  connected: true, position: { x: 10, y: 64, z: 20 }, health: 20, food: 20, inventory: [],
  nearbyPlayers: [{ name: 'Alice', distance: 3, position: { x: 12, y: 64, z: 20 } }],
  nearbyBlocks: [{ blockId: 'minecraft:diamond_ore', x: 9, y: 63, z: 20, distance: 1.4, resourceCategory: 'diamond_ore', classification: 'natural_resource', blockEntity: false, replaceable: false, fluid: false, destroySpeed: 3 }]
}

test('多模态模型自动获得小尺寸语义视觉图；没有语音帧时不会伪造听觉', async () => {
  const snapshot = await sensorySnapshot(model, { vision: true, audio: true, video: true, webSearch: true, detection: 'provider_model_registry' }, world)
  assert.equal(snapshot.status.vision, 'semantic_map')
  assert.equal(snapshot.status.audio, 'unavailable')
  assert.equal(snapshot.attachments.length, 1)
  const image = snapshot.attachments[0]
  assert.equal(image?.type, 'image')
  if (image?.type !== 'image') throw new Error('missing image')
  const bytes = Buffer.from(image.dataBase64, 'base64')
  assert.deepEqual([...bytes.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  assert.ok(bytes.length < 100_000)
})

test('纯文本模型不会附加图像或音频，避免无效多模态 Token', async () => {
  const snapshot = await sensorySnapshot(model, { vision: false, audio: false, video: false, webSearch: false, detection: 'provider_model_registry' }, world)
  assert.deepEqual(snapshot.attachments, [])
  assert.equal(snapshot.status.vision, 'disabled')
  assert.equal(snapshot.status.audio, 'disabled')
})
