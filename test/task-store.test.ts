import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TaskStore, type TaskDocument, type TaskIssuer } from '../src/tasks/task-store.js'

async function withStore(run: (store: TaskStore, file: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcai-task-store-'))
  try {
    const file = path.join(directory, 'tasks.json')
    await run(new TaskStore(file), file)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

test('创建 schemaVersion 1 的持久化任务文件并恢复内容', async () => {
  await withStore(async (store, file) => {
    const created = await store.enqueue({ issuer: { name: 'Alice', uuid: 'uuid-a' }, request: '收集木头', urgency: 2 })
    assert.equal(created.status, 'queued')
    const restored = await new TaskStore(file).load()
    assert.equal(restored.schemaVersion, 1)
    assert.equal(restored.tasks[0]?.id, created.id)
    assert.equal(restored.tasks[0]?.issuer.uuid, 'uuid-a')
  })
})

test('启动时把遗留 running 任务恢复为 queued', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mcai-task-recovery-'))
  try {
    const file = path.join(directory, 'tasks.json')
    const timestamp = new Date().toISOString()
    const document: TaskDocument = {
      schemaVersion: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
      nextSequence: 1,
      tasks: [{
        id: 'task-running', issuer: { name: 'Alice' }, request: '跟随', urgency: 1, status: 'running', sequence: 0,
        attempts: 1, requeueCount: 0, createdAt: timestamp, updatedAt: timestamp, startedAt: timestamp
      }]
    }
    await writeFile(file, `${JSON.stringify(document)}\n`, 'utf8')
    const restored = await new TaskStore(file).load()
    assert.equal(restored.tasks[0]?.status, 'queued')
    assert.equal(restored.tasks[0]?.requeueCount, 1)
    assert.equal(restored.tasks[0]?.lastTransitionReason, 'startup_recovery')
    assert.equal(restored.tasks[0]?.startedAt, undefined)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('wraaaaaa 始终优先，owner 内按 urgency 后 FIFO', async () => {
  await withStore(async (store) => {
    await store.enqueue({ issuer: { name: 'Alice' }, request: '附近普通任务', urgency: 100 })
    const ownerFirst = await store.enqueue({ issuer: { name: 'Wraaaaaa' }, request: 'owner 先入队', urgency: 20 })
    const ownerUrgent = await store.enqueue({ issuer: { name: 'wraaaaaa' }, request: 'owner 紧急任务', urgency: 80 })
    const ownerSameUrgency = await store.enqueue({ issuer: { name: 'wraaaaaa' }, request: 'owner 同级后入队', urgency: 80 })

    const first = await store.takeNext(() => 0)
    assert.equal(first?.id, ownerUrgent.id)
    await store.complete(first!.id)
    const second = await store.takeNext(() => 0)
    assert.equal(second?.id, ownerSameUrgency.id)
    await store.complete(second!.id)
    const third = await store.takeNext(() => 0)
    assert.equal(third?.id, ownerFirst.id)
  })
})

test('普通玩家先选实时最近发令者，再在该玩家内部按 urgency 和 FIFO', async () => {
  await withStore(async (store) => {
    const aliceLow = await store.enqueue({ issuer: { name: 'Alice' }, request: 'Alice 低优先', urgency: 1 })
    const aliceHighFirst = await store.enqueue({ issuer: { name: 'Alice' }, request: 'Alice 高优先先入队', urgency: 90 })
    const aliceHighSecond = await store.enqueue({ issuer: { name: 'Alice' }, request: 'Alice 高优先后入队', urgency: 90 })
    await store.enqueue({ issuer: { name: 'Bob' }, request: 'Bob 超紧急但更远', urgency: 100 })
    const distances = new Map([['alice', 2], ['bob', 20]])
    const resolve = (issuer: Readonly<TaskIssuer>): number | undefined => distances.get(issuer.name.toLowerCase())

    const first = await store.takeNext(resolve)
    assert.equal(first?.id, aliceHighFirst.id)
    await store.complete(first!.id)
    const second = await store.takeNext(resolve)
    assert.equal(second?.id, aliceHighSecond.id)
    await store.complete(second!.id)
    const third = await store.takeNext(resolve)
    assert.equal(third?.id, aliceLow.id)

    await store.complete(third!.id)
    const fourth = await store.takeNext(resolve)
    assert.equal(fourth?.issuer.name, 'Bob')
  })
})

test('每次 takeNext 都使用最新距离并保持全局单任务运行', async () => {
  await withStore(async (store) => {
    const alice = await store.enqueue({ issuer: { name: 'Alice' }, request: 'Alice 任务', urgency: 1 })
    const bob = await store.enqueue({ issuer: { name: 'Bob' }, request: 'Bob 任务', urgency: 1 })
    let distances = new Map([['alice', 12], ['bob', 3]])
    const resolve = (issuer: Readonly<TaskIssuer>): number | undefined => distances.get(issuer.name.toLowerCase())

    const first = await store.takeNext(resolve)
    assert.equal(first?.id, bob.id)
    assert.equal((await store.takeNext(resolve)), null)
    distances = new Map([['alice', 1], ['bob', 30]])
    await store.complete(first!.id)
    const second = await store.takeNext(resolve)
    assert.equal(second?.id, alice.id)
  })
})

test('markRunning、complete、fail 与 requeue 执行合法状态转换', async () => {
  await withStore(async (store) => {
    const first = await store.enqueue({ issuer: { name: 'Alice' }, request: '任务一' })
    const second = await store.enqueue({ issuer: { name: 'Bob' }, request: '任务二' })
    const running = await store.markRunning(first.id)
    assert.equal(running.status, 'running')
    assert.equal(running.attempts, 1)
    await assert.rejects(store.markRunning(second.id), /已有任务正在执行/u)
    const failed = await store.fail(first.id, '路径不可达')
    assert.equal(failed.status, 'failed')
    assert.equal(failed.error, '路径不可达')
    const queued = await store.requeue(first.id, '等待世界状态更新')
    assert.equal(queued.status, 'queued')
    assert.equal(queued.requeueCount, 1)
    const retried = await store.markRunning(first.id)
    assert.equal(retried.attempts, 2)
    const completed = await store.complete(first.id, '已完成')
    assert.equal(completed.status, 'completed')
    assert.equal(completed.result, '已完成')
    await assert.rejects(store.requeue(first.id), /不能重新排队/u)
  })
})

test('并发 takeNext 只能保留一个 running 任务', async () => {
  await withStore(async (store) => {
    await store.enqueue({ issuer: { name: 'Alice' }, request: '任务一' })
    await store.enqueue({ issuer: { name: 'Bob' }, request: '任务二' })
    const selected = await Promise.all([store.takeNext(() => 1), store.takeNext(() => 1), store.takeNext(() => 1)])
    assert.equal(selected.filter(Boolean).length, 1)
    assert.equal((await store.load()).tasks.filter((task) => task.status === 'running').length, 1)
  })
})

test('控制器重连可恢复同进程遗留的 running 任务', async () => {
  await withStore(async (store) => {
    const task = await store.enqueue({ issuer: { name: 'Alice' }, request: '跨连接任务' })
    await store.markRunning(task.id)
    assert.equal(await store.recoverRunning('test_reconnect'), 1)
    const recovered = (await store.load()).tasks.find(candidate => candidate.id === task.id)
    assert.equal(recovered?.status, 'queued')
    assert.equal(recovered?.requeueCount, 1)
    assert.equal(recovered?.lastTransitionReason, 'test_reconnect')
  })
})
