import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { Persona } from '../src/config/types.js'
import { extractDeclaredBotAlias, PromptWorkspace } from '../src/prompts/prompt-workspace.js'

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
    /必须位于项目 userdata 目录/u
  )
})

test('USER.md 保存玩家对 AI 的专属称呼并可从自然声明增量学习', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcai-aliases-'))
  try {
    const workspace = new PromptWorkspace({
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      exampleDirectory: path.resolve('config/agent-prompts.example'),
      allowedRoot: root
    })
    const identity = { name: 'Alice', uuid: 'uuid-alias' }
    await workspace.ensurePlayerProfile(identity)
    await workspace.appendBotAlias(identity, '粉粉')
    await workspace.appendBotAlias(identity, '胆小鬼')
    assert.deepEqual(await workspace.botAliases(identity), ['粉粉', '胆小鬼'])
    assert.equal(extractDeclaredBotAlias('以后我就叫你小粉吧'), '小粉')
    assert.equal(extractDeclaredBotAlias('帮我挖一块石头'), undefined)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('工具 Agent 使用精简提示词但保留人格、安全规则与自动学习区', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcai-compact-prompt-'))
  try {
    const workspace = new PromptWorkspace({
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      exampleDirectory: path.resolve('config/agent-prompts.example'),
      allowedRoot: root
    })
    await workspace.initialize()
    await workspace.appendLearnedToolGuidance('遇到封闭木门时优先交互开门。')
    const full = await workspace.buildSystemPrompt(persona, { name: 'Alice' })
    const compact = await workspace.buildSystemPrompt(persona, { name: 'Alice' }, { toolAgent: true })
    assert.ok(compact.length < full.length)
    assert.match(compact, /核心人格/u)
    assert.match(compact, /真正不可绕过的限制/u)
    assert.match(compact, /遇到封闭木门时优先交互开门/u)
    assert.doesNotMatch(compact, /## 原子接口/u)
    assert.doesNotMatch(compact, /## 连续技能/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
