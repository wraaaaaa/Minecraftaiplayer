import test from 'node:test'
import assert from 'node:assert/strict'
import { parseDecoratedPlayerChat } from '../src/minecraft/chat-parser.js'

test('parses plugin chat with a rank prefix', () => {
  assert.deepEqual(parseDecoratedPlayerChat('<[管理员]Alice_01> 你好'), { name: 'Alice_01', message: '你好' })
})

test('parses multiple bracketed prefixes before a Minecraft username', () => {
  assert.deepEqual(parseDecoratedPlayerChat('<[VIP][红队]Bob> follow me'), { name: 'Bob', message: 'follow me' })
})

test('rejects system messages and invalid player names', () => {
  assert.equal(parseDecoratedPlayerChat('Alice joined the game'), null)
  assert.equal(parseDecoratedPlayerChat('<[提示]not-a-player> hello'), null)
  assert.equal(parseDecoratedPlayerChat('<[提示]Alice>   '), null)
})
