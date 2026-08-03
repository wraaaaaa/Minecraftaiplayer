import assert from 'node:assert/strict'
import test from 'node:test'
import { redactString } from '../src/core/logger.js'

test('日志脱敏 EasyAuth 密码和常见令牌', () => {
  const output = redactString('send /login super-secret password=abc123 api_key:xyz')
  assert.equal(output.includes('super-secret'), false)
  assert.equal(output.includes('abc123'), false)
  assert.equal(output.includes('xyz'), false)
  assert.match(output, /\[REDACTED\]/u)
})
