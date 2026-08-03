import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { MemoryStore } from '../src/memory/memory-store.js'

test('单文件记忆可恢复且不同玩家不会串线', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mc-ai-memory-'))
  try {
    const file = path.join(directory, 'memory.json')
    const store = new MemoryStore(file, 'TestBot', 100)
    await store.recordPlayerMessage({ name: 'Alice', uuid: 'uuid-a' }, '我喜欢建造')
    await store.rememberFact({ name: 'Alice', uuid: 'uuid-a' }, 'Alice 喜欢建造')
    await store.recordPlayerMessage({ name: 'Bob', uuid: 'uuid-b' }, '我喜欢探险')
    const restored = new MemoryStore(file, 'TestBot', 100)
    const alice = await restored.contextFor({ name: 'Alice', uuid: 'uuid-a' })
    const bob = await restored.contextFor({ name: 'Bob', uuid: 'uuid-b' })
    assert.deepEqual(alice.player.facts, ['Alice 喜欢建造'])
    assert.equal(alice.recentEvents.some((event) => event.content.includes('探险')), false)
    assert.equal(bob.recentEvents.some((event) => event.content.includes('建造')), false)
    const raw = JSON.parse(await readFile(file, 'utf8')) as { schemaVersion: number }
    assert.equal(raw.schemaVersion, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
