import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSystemPrompt } from '../src/agent/prompt.js'
import type { Persona, PromptTemplates } from '../src/config/types.js'

const persona: Persona = {
  name: 'CialloAI',
  description: '测试玩家',
  speakingStyle: '简短',
  goals: ['安全生存'],
  boundaries: ['不拆家']
}

test('旧 prompts.json 也会获得受保护破坏方块兼容入口', () => {
  const legacy: PromptTemplates = {
    identity: '{{name}} {{description}} {{speakingStyle}} {{goals}} {{boundaries}}',
    capabilityRules: [],
    memoryRules: [],
    actionContract: '动作只有 gather_resource；绝不输出 break_block。',
    proactiveInstruction: '等待'
  }
  const prompt = buildSystemPrompt(persona, legacy)
  assert.match(prompt, /可输出 break_block（block\/count）或 gather_resource（resource\/count）/u)
  assert.match(prompt, /Fabric 会逐目标验证天然方块、玩家结构、危险源和撤退路径/u)
})
