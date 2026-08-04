import test from 'node:test'
import assert from 'node:assert/strict'
import { parseJsonDocument } from '../src/core/json.js'

test('PowerShell UTF-8 BOM JSON is accepted for PID and config files', () => {
  assert.deepEqual(parseJsonDocument<{ pid: number }>('\uFEFF{"pid":123}'), { pid: 123 })
  assert.deepEqual(parseJsonDocument<{ ok: boolean }>('{"ok":true}'), { ok: true })
})
