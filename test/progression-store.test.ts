import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { ProgressionStore } from '../src/progression/progression-store.js'

test('长期末地发育阶段和失败回退计数可原子持久化', async () => {
  const file = path.join(tmpdir(), `mcai-progression-${process.pid}-${Date.now()}.json`)
  const store = new ProgressionStore(file)
  assert.equal((await store.load()).goal, 'reach_end')
  await store.notePlan('iron_age', 'gather_resource', '补充铁矿')
  await store.noteResult('gather_resource', false, '当前加载范围没有铁矿')
  await store.noteResult('gather_resource', false, '需要开矿道')
  const failed = await store.load()
  assert.equal(failed.stage, 'iron_age')
  assert.equal(failed.failures.gather_resource?.count, 2)
  await store.noteResult('gather_resource', true, 'verified inventory delta')
  const completed = JSON.parse(await readFile(file, 'utf8')) as Awaited<ReturnType<ProgressionStore['load']>>
  assert.equal(completed.failures.gather_resource, undefined)
  assert.ok(completed.milestones['completed:gather_resource'])
})

test('resource gather failures remain isolated by requested material', async () => {
  const file = path.join(tmpdir(), `mcai-progression-scoped-${process.pid}-${Date.now()}.json`)
  const store = new ProgressionStore(file)
  await store.noteResult('gather_resource', false, 'stone route blocked', 'gather_resource:stone')
  await store.noteResult('gather_resource', false, 'coal route blocked', 'gather_resource:coal')
  const failed = await store.load()
  assert.equal(failed.lastAction, 'gather_resource')
  assert.equal(failed.failures['gather_resource:stone']?.count, 1)
  assert.equal(failed.failures['gather_resource:coal']?.count, 1)
  await store.noteResult('gather_resource', true, 'coal collected', 'gather_resource:coal')
  const completed = await store.load()
  assert.equal(completed.failures['gather_resource:coal'], undefined)
  assert.equal(completed.failures['gather_resource:stone']?.count, 1)
})

test('temporary survival work does not regress the durable progression checkpoint', async () => {
  const file = path.join(tmpdir(), `mcai-progression-monotonic-${process.pid}-${Date.now()}.json`)
  const store = new ProgressionStore(file)
  await store.notePlan('diamond_age', 'gather_resource', '采集钻石')
  await store.notePlan('survive', 'eat_best_food', '补充饥饿值')
  await store.notePlan('wood_age', 'craft_item', '补做工作台')
  const document = await store.load()
  assert.equal(document.stage, 'diamond_age')
  assert.equal(document.lastAction, 'craft_item')
})
