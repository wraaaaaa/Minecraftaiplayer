import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeManagedEnv } from '../src/webui/env-file.js'

const managed = ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY'] as const

test('WebUI 更新密钥时保留注释、未知变量与原有顺序', () => {
  const source = '# 本地自定义配置\r\nMCAI_WEBUI_PORT=4567\r\nDEEPSEEK_API_KEY=old\r\nCUSTOM_FLAG=a=b\r\n'
  assert.equal(
    mergeManagedEnv(source, { DEEPSEEK_API_KEY: 'new', OPENAI_API_KEY: '' }, managed),
    '# 本地自定义配置\r\nMCAI_WEBUI_PORT=4567\r\nDEEPSEEK_API_KEY=new\r\nCUSTOM_FLAG=a=b\r\n'
  )
})

test('WebUI 可显式删除托管密钥且不会删除未知内容', () => {
  const source = 'OPENAI_API_KEY=one\n# keep\nOPENAI_API_KEY=duplicate\nUNKNOWN_TOKEN=local\n'
  assert.equal(
    mergeManagedEnv(source, { OPENAI_API_KEY: null }, managed),
    '# keep\nUNKNOWN_TOKEN=local\n'
  )
})

test('WebUI 为不存在的托管密钥追加值并保留 UTF-8 BOM', () => {
  assert.equal(
    mergeManagedEnv('\uFEFF# secrets\n', { OPENAI_API_KEY: 'added' }, managed),
    '\uFEFF# secrets\nOPENAI_API_KEY=added\n'
  )
})
