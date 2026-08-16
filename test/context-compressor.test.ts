import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { AgentWorkspaceConfig } from '../src/config/types.js'
import type { LlmProvider } from '../src/llm/types.js'
import { ContextCompressor } from '../src/memory/context-compressor.js'
import { MemoryStore } from '../src/memory/memory-store.js'
import { PromptWorkspace } from '../src/prompts/prompt-workspace.js'
import { SecretGuard } from '../src/security/secret-guard.js'

const provider: LlmProvider = {
  complete: async () => ({
    text: JSON.stringify({
      conversationSummary: 'Alice 喜欢一起挖矿，当前没有未完成承诺。',
      globalSummary: '主世界发育中。',
      playerProfileMarkdown: 'Alice 喜欢协作挖矿，偏好简短回复。'
    }),
    model: 'test',
    requestedEffort: 'none',
    effectiveEffort: 'none'
  })
}

test('上下文接近预算时由模型压缩旧事件并更新对应 USER.md', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcai-compress-'))
  try {
    const workspace = new PromptWorkspace({
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      exampleDirectory: path.resolve('config/agent-prompts.example'),
      allowedRoot: root
    })
    const memory = new MemoryStore(path.join(root, 'memory.json'), '小麦', 500)
    const identity = { name: 'Alice', uuid: 'uuid-a' }
    for (let index = 0; index < 14; index++) {
      await memory.recordPlayerMessage(identity, `第 ${index} 条关于挖矿的较长聊天内容 ${'x'.repeat(80)}`)
      await memory.recordBotReply(identity, `第 ${index} 条回复`)
    }
    const config: AgentWorkspaceConfig = {
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      contextBudgetChars: 8_000,
      compressionTriggerRatio: 0.5,
      retainRecentEvents: 4,
      selfImprovement: {
        enabled: false,
        allowPromptEdits: false,
        allowBehaviorPatches: false,
        allowSkillLearning: false,
        minimumRepeatedFailures: 3,
        minimumStepsForSkill: 2,
        researchProvider: 'disabled',
        researchEndpoint: '',
        researchTimeoutMs: 1000
      }
    }
    const compressor = new ContextCompressor({
      config,
      provider,
      memory,
      workspace,
      secrets: new SecretGuard([])
    })
    const result = await compressor.maybeCompress(identity, 7_000)
    assert.equal(result.compressed, 24)
    const saved = await memory.load()
    assert.equal(saved.events.length, 4)
    assert.match(saved.players['uuid:uuid-a']!.conversationSummary, /喜欢一起挖矿/u)
    const profile = await workspace.ensurePlayerProfile(identity)
    assert.match(await readFile(profile.file, 'utf8'), /偏好简短回复/u)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
