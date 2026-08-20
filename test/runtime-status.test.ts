import assert from 'node:assert/strict'
import test from 'node:test'
import { compactRuntimeWorld } from '../src/runtime/status-store.js'

test('运行状态文件保留总控摘要与背包明细，但不落盘高频附近方块数据', () => {
  const compact = compactRuntimeWorld({
    connected: true,
    sequence: 12,
    observedAt: 123456,
    position: { x: 1, y: 64, z: 2 },
    health: 20,
    food: 19,
    inventory: [{ name: '钻石', itemId: 'minecraft:diamond', count: 64 }],
    nearbyPlayers: [{ name: 'Alice', uuid: 'alice', distance: 3, position: { x: 2, y: 64, z: 2 } }],
    nearbyBlocks: Array.from({ length: 512 }, (_, index) => ({
      blockId: 'minecraft:stone', x: index, y: 63, z: 0, distance: index,
      classification: 'natural_resource' as const, blockEntity: false, replaceable: false, fluid: false, destroySpeed: 1.5
    })),
    activePrimitive: 'idle',
    navigationStatus: 'idle'
  })

  assert.deepEqual(compact.inventory, [{ name: '钻石', itemId: 'minecraft:diamond', count: 64 }])
  assert.equal(compact.nearbyBlocks, undefined)
  assert.deepEqual(compact.position, { x: 1, y: 64, z: 2 })
  assert.deepEqual(compact.nearbyPlayers, [{ name: 'Alice', uuid: 'alice', distance: 3 }])
  assert.ok(JSON.stringify(compact).length < 2_000)
})
