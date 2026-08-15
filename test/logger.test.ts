import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { Logger, redactString } from '../src/core/logger.js'

test('日志脱敏 EasyAuth 密码和常见令牌', () => {
  const output = redactString('send /login super-secret password=abc123 api_key:xyz')
  assert.equal(output.includes('super-secret'), false)
  assert.equal(output.includes('abc123'), false)
  assert.equal(output.includes('xyz'), false)
  assert.match(output, /\[REDACTED\]/u)
})

test('日志保留 Token 用量指标但继续隐藏认证令牌', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'mcai-logger-'))
  const file = path.join(directory, 'bot.log')
  try {
    const logger = new Logger({ file, level: 'info', console: false })
    logger.info('usage', {
      tokens: 14539,
      inputTokens: 14407,
      totalTokens: 14539,
      accessToken: 'fake',
      session_token: 'fake',
      password: 'fake-password'
    })
    await logger.flush()
    const entry = JSON.parse((await readFile(file, 'utf8')).trim()) as { data: Record<string, unknown> }
    assert.equal(entry.data.tokens, 14539)
    assert.equal(entry.data.inputTokens, 14407)
    assert.equal(entry.data.totalTokens, 14539)
    assert.equal(entry.data.accessToken, '[REDACTED]')
    assert.equal(entry.data.session_token, '[REDACTED]')
    assert.equal(entry.data.password, '[REDACTED]')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
