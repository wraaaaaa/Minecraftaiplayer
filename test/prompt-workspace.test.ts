import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Persona } from '../src/config/types.js'
import { PromptWorkspace } from '../src/prompts/prompt-workspace.js'

const persona: Persona = {
  name: '小麦',
  description: '测试队友',
  speakingStyle: '简短',
  goals: ['到达末地'],
  boundaries: ['不破坏玩家建筑']
}

test('OpenClaw 风格提示词可本地读写且每位玩家的 USER.md 相互隔离', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcai-prompts-'))
  try {
    const workspace = new PromptWorkspace({
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      exampleDirectory: path.resolve('config/agent-prompts.example'),
      allowedRoot: root
    })
    await workspace.initialize()
    const documents = await workspace.readDocuments()
    assert.match(documents['rules.md'], /真正不可绕过的限制/u)
    assert.match(documents['SOUL.md'], /核心人格/u)

    const alice = await workspace.ensurePlayerProfile({ name: 'Alice', uuid: 'uuid-a' })
    const bob = await workspace.ensurePlayerProfile({ name: 'Bob', uuid: 'uuid-b' })
    assert.notEqual(alice.file, bob.file)
    await workspace.appendPlayerFact({ name: 'Alice', uuid: 'uuid-a' }, '喜欢一起挖矿')
    assert.match(await readFile(alice.file, 'utf8'), /喜欢一起挖矿/u)
    assert.doesNotMatch(await readFile(bob.file, 'utf8'), /喜欢一起挖矿/u)

    await workspace.writeDocuments({ 'SOUL.md': '# SOUL.md\n\n{{name}} 是沉稳的探险家。' })
    const prompt = await workspace.buildSystemPrompt(persona, { name: 'Alice', uuid: 'uuid-a' })
    assert.match(prompt, /小麦 是沉稳的探险家/u)
    assert.match(prompt, /玩家名：`Alice`/u)
    assert.doesNotMatch(prompt, /玩家名：`Bob`/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('运行时提示词写入范围不能逃出允许的数据目录', () => {
  const root = path.resolve(os.tmpdir(), 'mcai-prompt-boundary')
  assert.throws(
    () => new PromptWorkspace({
      promptDirectory: path.dirname(root),
      playerProfilesDirectory: path.join(root, 'profiles'),
      allowedRoot: root
    }),
    /必须位于项目 data 目录/u
  )
})
