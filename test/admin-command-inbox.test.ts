import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { AdminCommandInbox } from '../src/admin/admin-command-inbox.js'

test('WebUI 管理指令用独立原子文件提交、领取和落终态', async () => {
  const inbox = new AdminCommandInbox(path.join(tmpdir(), `mcai-admin-${process.pid}-${Date.now()}`))
  const submitted = await inbox.submit('  回家并等待  ')
  assert.equal(submitted.message, '回家并等待')
  const claimed = await inbox.claimNext()
  assert.equal(claimed?.id, submitted.id)
  assert.equal(claimed?.status, 'processing')
  await inbox.finish(claimed!, true, 'accepted')
  assert.equal(await inbox.claimNext(), null)
})
