const INTERNAL_SENTENCE = /(?:```|\{\s*"?(?:action|actions|type)"?\s*:|\bminecraft:[a-z0-9_]+\b|\b(?:follow_player|follow_player_continuously|navigate_to|move_to|wander|explore_frontier|return_to_zone|return_home|eat_best_food|equip_best|attack_hostile|attack_player|hunt_entity|collect_own_drops|gather_resource|craft_item|place_block|smelt_item|trade_villager|enchant_item|sleep_in_bed|excavate_tunnel|build_nether_portal|travel_to_dimension|drop_item|accept_items_from_player|use_item|seek_shelter|build_shelter|prepare_for|wait_safe)\b|\b(?:tool|function|action)\s*(?:call|name)?\b|^(?:已经|已)(?:停止|开始|完成|确认|选择|装备|移动|跟随|到达|进入|退出|返回|放置|破坏|采集|合成|丢出|拾取|执行)|(?:动作名|调用名|调用指令|工具调用|接口参数|内部指令|思考过程|隐藏思维链|现在回应(?:玩家|主人)|回复(?:玩家|主人)|给(?:他|她|玩家|主人).{0,16}(?:自然|回复)|不需要额外操作|客户端(?:会|已)|持续跟随已启动|模型(?:选择|调用)|执行步骤|坐标参数))/iu
const MENTION = /@[\p{L}\p{N}_-]{1,32}/gu

function normalize(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
}

/**
 * Converts an untrusted model answer into the only text allowed to reach Minecraft chat.
 * A model may put a usable final answer after its scratchpad; in that case only the final
 * addressed segment is retained.  Otherwise any internal marker makes the safe fallback win.
 */
export function naturalGameText(value: string | undefined, fallback: string, recipient?: string): string {
  let candidate = normalize(value ?? '')
  if (!candidate) return fallback

  const mentions = [...candidate.matchAll(MENTION)]
  if (mentions.length > 0) {
    const preferred = recipient
      ? [...mentions].reverse().find(match => match[0].slice(1).toLowerCase() === recipient.toLowerCase())
      : mentions.at(-1)
    if (preferred?.index !== undefined && preferred.index > 0) candidate = candidate.slice(preferred.index + preferred[0].length).trim()
  }

  candidate = candidate.replace(MENTION, '').replace(/^\s*[:：,，-]+\s*/u, '').trim()
  const sentences = candidate.split(/(?<=[。！？!?~～])\s*/u)
    .map(sentence => normalize(sentence).replace(/^[,，、;；:：。！？!?~～]+\s*/u, ''))
    .filter(Boolean)
  const safe = sentences.filter(sentence => !INTERNAL_SENTENCE.test(sentence)).join('').trim()
  if (!safe || INTERNAL_SENTENCE.test(safe)) return fallback
  return safe.slice(0, 220)
}

const ACKNOWLEDGEMENTS = [
  '嗯嗯，我听明白啦，先看看周围怎么做最稳妥，你稍等我一下喵~',
  '好，我这就动手试试，会边看环境边调整路线的，你在附近等我一下喵。',
  '收到啦，我先确认手边的东西和周围地形，然后认真替你办喵~',
  '交给我吧，我会一步一步来，哪里不对就马上换办法，不让你白等喵。',
  '我知道你想要什么了，现在就开始弄；要是环境有变化，我会自己想办法绕开的喵~',
  '好呀，我已经记住这件事了，先去现场看看，再挑最合适的做法喵。',
  '嗯，我来处理，先给我一点点时间确认路线和背包，马上开始喵~',
  '明白啦，我不会只站着发呆的，这就根据眼前情况一步步做起来喵。'
] as const

export class ReplyComposer {
  #acknowledgementIndex = 0
  readonly #lastByPlayer = new Map<string, string>()

  acknowledgement(seed = ''): string {
    void seed
    const index = this.#acknowledgementIndex++ % ACKNOWLEDGEMENTS.length
    return ACKNOWLEDGEMENTS[index]!
  }

  avoidImmediateRepeat(playerName: string, reply: string): string {
    const key = playerName.trim().toLowerCase()
    const normalized = normalize(reply)
    const previous = this.#lastByPlayer.get(key)
    if (previous !== normalized) {
      this.#lastByPlayer.set(key, normalized)
      return normalized
    }
    const replacement = this.acknowledgement(`${key}:${normalized}`)
    this.#lastByPlayer.set(key, replacement)
    return replacement
  }
}
