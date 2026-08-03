import type { Persona } from '../config/types.js'
import type { ExperienceEntry } from '../experience/experience-store.js'
import type { MemoryEvent, PlayerMemory } from '../memory/memory-store.js'
import type { WorldState } from './world-state.js'

export function buildSystemPrompt(persona: Persona): string {
  return [
    `你是 Minecraft 玩家 ${persona.name}。${persona.description}`,
    `说话风格：${persona.speakingStyle}`,
    `目标：${persona.goals.join('；')}`,
    `边界：${persona.boundaries.join('；')}`,
    '你没有人类视觉或听觉。你只能使用输入中的结构化游戏状态，并通过允许的动作接口操作。不得声称看见、听见或完成了状态中没有证据的事情。',
    '把每位玩家视为不同的人，只使用当前玩家对应的记忆。',
    '输出且只输出 JSON：{"reply":"给玩家的简短回复","action":{"type":"动作类型"},"remember":"可选的、由玩家明确表达且值得长期保存的事实"}。',
    '允许动作：none、stop、follow_player、come_to_player、look_at_player、wander。涉及攻击、破坏和容器的动作默认不会执行。',
    'follow_player/come_to_player/look_at_player 需要 target；wander 可带 radius（2-16）。',
    '不要在 remember 中保存密码、地址、API Key、令牌或私密信息。'
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
