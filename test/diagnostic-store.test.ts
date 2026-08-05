import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DiagnosticStore } from '../src/diagnostics/diagnostic-store.js'

test('总聊天诊断按时间持久化完整步骤与错误', async () => {
  const file = path.join(tmpdir(), `mcai-diagnostics-${process.pid}-${Date.now()}.json`)
  const store = new DiagnosticStore(file, 100)
  await store.append({
    type: 'step', level: 'info', title: '开始步骤 1/1', summary: 'gather_resource',
    detail: '{"resource":"wood","count":2}', taskId: 'task-1', playerName: 'Alice'
  })
  await store.append({
    type: 'failure', level: 'error', title: '任务无法完成', summary: '完整原因仅在本机显示',
    detail: 'unable to navigate around obstacle', taskId: 'task-1', playerName: 'Alice'
  })

  const restored = await new DiagnosticStore(file, 100).load()
  assert.equal(restored.schemaVersion, 1)
  assert.equal(restored.events.length, 2)
  assert.equal(restored.events[0]?.detail, '{"resource":"wood","count":2}')
  assert.equal(restored.events[1]?.detail, 'unable to navigate around obstacle')
})
