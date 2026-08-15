import assert from 'node:assert/strict'
import test from 'node:test'
import { redactForWebUi } from '../src/webui/redaction.js'

test('WebUI redaction keeps Java stack traces readable while removing JWTs and credentials', () => {
  const javaFrame = 'at kim.ciallo.minecraftai.bridge.PrimitiveTaskController.tick(PrimitiveTaskController.java:412)'
  assert.equal(redactForWebUi(javaFrame), javaFrame)

  const fakeJwt = 'eyJhbGci.dGVzdC1wYXlsb2Fk.ZmFrZS1zaWduYXR1cmU'
  assert.equal(redactForWebUi(fakeJwt), '[REDACTED_JWT]')
  assert.equal(redactForWebUi('Bearer short-token'), 'Bearer [REDACTED]')
  assert.equal(redactForWebUi('/login secret-value'), '/login [REDACTED]')
  assert.equal(redactForWebUi('OPENAI_API_KEY=sk-fake'), 'OPENAI_API_KEY=[REDACTED]')
  assert.equal(redactForWebUi('{"tokens":14539,"inputTokens":14407}'), '{"tokens":14539,"inputTokens":14407}')
})
