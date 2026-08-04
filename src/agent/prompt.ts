import type { Persona, PromptTemplates } from '../config/types.js'
import type { ExperienceEntry } from '../experience/experience-store.js'
import type { MemoryEvent, PlayerMemory } from '../memory/memory-store.js'
import type { WorldState } from './world-state.js'

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
    prompts.actionContract
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
