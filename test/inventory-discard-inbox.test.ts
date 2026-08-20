import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { InventoryDiscardInbox } from '../src/admin/inventory-discard-inbox.js'

test('背包丢弃收件箱提交槽位、领取与落终态', async () => {
  const inbox = new InventoryDiscardInbox(path.join(tmpdir(), `mcai-discard-${process.pid}-${Date.now()}`))
  const submitted = await inbox.submit([{ slot: 3, count: 10 }, { slot: 12, count: 1 }])
  assert.equal(submitted.slots.length, 2)
  assert.deepEqual(submitted.slots[0], { slot: 3, count: 10 })
  const claimed = await inbox.claimNext()
  assert.equal(claimed?.id, submitted.id)
  assert.equal(claimed?.status, 'processing')
  await inbox.finish(claimed!, true, 'discarded_stacks=2; discarded_items=11; retreat_engaged=true')
  assert.equal(await inbox.claimNext(), null)
})

test('背包丢弃收件箱拒绝非法槽位或数量', async () => {
  const inbox = new InventoryDiscardInbox(path.join(tmpdir(), `mcai-discard-${process.pid}-${Date.now()}-bad`))
  await assert.rejects(() => inbox.submit([{ slot: -1, count: 1 }]))
  await assert.rejects(() => inbox.submit([{ slot: 2, count: 0 }]))
  await assert.rejects(() => inbox.submit([]))
})
