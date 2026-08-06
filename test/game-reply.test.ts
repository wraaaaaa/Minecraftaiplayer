import assert from 'node:assert/strict'
import test from 'node:test'
import { naturalGameText, ReplyComposer } from '../src/agent/game-reply.js'

test('模型把内部过程和最终答复混在一起时只保留最后的自然答复', () => {
  const raw = '持续跟随已启动，客户端会继续运行。我给主人一句自然的回复就好。 @wraaaaaa 我穿过来啦，差点把尾巴落在门那边，主人等等我喵~'
  assert.equal(naturalGameText(raw, '回退', 'wraaaaaa'), '我穿过来啦，差点把尾巴落在门那边，主人等等我喵~')
})

test('只有工具、思考或调用过程时使用安全回退', () => {
  assert.equal(naturalGameText('现在回应玩家。调用 navigate_to，坐标参数已准备。', '我还没弄好。', 'Alice'), '我还没弄好。')
})

test('工具结果与自然台词混在一起时不把执行回执发进游戏聊天', () => {
  const raw = '@wraaaaaa 已经停止所有动作并原地等待。，我已经停下来了，就在原地乖乖等你，不走也不挖了喵~'
  assert.equal(naturalGameText(raw, '我在。', 'wraaaaaa'), '我已经停下来了，就在原地乖乖等你，不走也不挖了喵~')
})

test('确认语有轮换且同一玩家不会连续收到完全相同文本', () => {
  const composer = new ReplyComposer()
  const replies = Array.from({ length: 8 }, (_, index) => composer.acknowledgement(`task-${index}`))
  assert.ok(new Set(replies).size >= 5)
  const first = composer.avoidImmediateRepeat('Alice', '好，我来。')
  const second = composer.avoidImmediateRepeat('Alice', '好，我来。')
  assert.equal(first, '好，我来。')
  assert.notEqual(second, first)
})
