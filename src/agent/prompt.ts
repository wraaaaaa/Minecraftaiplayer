import type { Persona, PromptTemplates } from '../config/types.js'
import type { ExperienceEntry } from '../experience/experience-store.js'
import type { MemoryEvent, PlayerMemory } from '../memory/memory-store.js'
import type { WorldState } from './world-state.js'

const SAFE_MINING_COMPATIBILITY_RULE = '兼容动作规则：玩家要求挖掘、采集、移除或破坏某种自然方块时，不得声称动作列表没有该选项；可输出 break_block（block/count）或 gather_resource（resource/count）。本地会统一转换为受保护采集，模型不得指定坐标或声明 ownership，Fabric 仍只在管理员批准开发区内选择并验证目标。'

export function buildSystemPrompt(persona: Persona, prompts: PromptTemplates): string {
  const identity = prompts.identity
    .replaceAll('{{name}}', persona.name)
    .replaceAll('{{description}}', persona.description)
    .replaceAll('{{speakingStyle}}', persona.speakingStyle)
    .replaceAll('{{goals}}', persona.goals.join('；'))
    .replaceAll('{{boundaries}}', persona.boundaries.join('；'))
  return [
    identity,
    ...prompts.capabilityRules,
    ...prompts.memoryRules,
    prompts.actionContract,
    // Keep upgraded installations capable even when their ignored prompts.json still contains an
    // older action contract. This adds an action alias, never an authorization bypass.
    SAFE_MINING_COMPATIBILITY_RULE
  ].join('\n')
}

export function buildPlayerRequest(input: {
  player: PlayerMemory
  message: string
  recentEvents: MemoryEvent[]
  globalSummary: string
  experiences: ExperienceEntry[]
  world: WorldState
}): string {
  return JSON.stringify({
    currentPlayer: {
      name: input.player.currentName,
      knownNames: input.player.knownNames,
      facts: input.player.facts,
      conversationSummary: input.player.conversationSummary
    },
    playerMessage: input.message,
    recentRelevantEvents: input.recentEvents.map(({ at, type, content }) => ({ at, type, content })),
    globalSummary: input.globalSummary,
    relevantExperience: input.experiences.map(({ task, outcome, lesson, correction, verified }) => ({ task, outcome, lesson, correction, verified })),
    structuredGameState: input.world
  })
}
