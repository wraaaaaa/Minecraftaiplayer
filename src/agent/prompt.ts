import type { Persona, PromptTemplates } from '../config/types.js'
import type { ExperienceEntry } from '../experience/experience-store.js'
import type { MemoryEvent, PlayerMemory } from '../memory/memory-store.js'
import type { WorldState } from './world-state.js'

const SAFE_MINING_COMPATIBILITY_RULE = '兼容动作规则：玩家要求挖掘、采集、移除或破坏某种自然方块时，不得声称动作列表没有该选项；可输出 break_block（block/count）或 gather_resource（resource/count）。本地会统一转换为受保护采集，模型不得指定坐标或声明 ownership，Fabric 会逐目标验证天然方块、玩家结构、危险源和撤退路径。'
const VERIFIED_WORLD_ACTION_RULE = '基础玩法工具：采集 gather_resource、合成 craft_item、放置 place_block、把自身物品交给玩家 drop_item。复杂任务可输出 actions 数组（最多 12 步），本地将按顺序逐步能力检查、策略检查和服务器后置条件验证，任一步失败都会停止后续步骤；不得声称动作列表没有这些工具。附近方块信息位于 structuredGameState.blockSurvey，玩家指向方块位于 nearbyPlayers[].lookingAtBlock。不再使用人工 developmentZone；模型根据环境选择意图，Fabric 对每个修改世界的目标执行不可绕过的安全验证。'
const ADVANCED_SURVIVAL_ACTION_RULE = '高级生存工具：hunt_entity(purpose=food/wool/leather/ender_pearl/blaze_rod,count)、smelt_item(inputItemId/outputItemId/count)、trade_villager(desiredItemId/count)、enchant_item(itemId/minLevel)、sleep_in_bed、excavate_tunnel(resource/targetY/length)、explore_frontier(purpose=food/wood/village/portal/resource,radius)、build_nether_portal、travel_to_dimension(dimension=minecraft:overworld/minecraft:the_nether/minecraft:the_end)。保护玩家时用 attack_hostile(targetId/protectPlayer)。这些工具都由 Fabric 以服务端回传后置条件确认；复杂目标应组合基本步骤，不得回答“动作列表没有”。'
const INTENT_AND_VOICE_RULE = '先理解玩家整句话和对话上下文，再输出 intent。普通聊天、分享、提问、玩笑、感叹或没有要求你行动的陈述使用 intent=chat、action=none，不得因为出现“挖矿”“合成”“跟随”等词就调用工具或回答做不到；只有明确的游戏行动请求才使用 intent=action 并由你根据语义自行选择工具。游戏内把自己当作平等联机的 Minecraft 玩家，不主动自称 AI、Bot、助手或工具；回复像熟悉的朋友，避免客服、系统日志和固定模板腔。'

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
    SAFE_MINING_COMPATIBILITY_RULE,
    VERIFIED_WORLD_ACTION_RULE,
    ADVANCED_SURVIVAL_ACTION_RULE,
    INTENT_AND_VOICE_RULE
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
