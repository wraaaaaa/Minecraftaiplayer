const INTERNAL_SENTENCE = /(?:```|<\/?(?:tool|analysis|thinking|function)[^>]*>|\{\s*"?(?:action|actions|type)"?\s*:|\bminecraft:[a-z0-9_]+\b|\b[a-z0-9]+(?:_[a-z0-9]+)+\b|\b[xyz]\s*=\s*-?\d|(?:判定|标记|分类|归类)为|关键问题|破坏操作|\b(?:follow_player|follow_player_continuously|navigate_to|move_to|wander|explore_frontier|return_to_zone|return_home|eat_best_food|equip_best|unequip_armor|attack_hostile|attack_player|hunt_entity|collect_own_drops|gather_resource|craft_item|place_block|smelt_item|trade_villager|enchant_item|sleep_in_bed|excavate_tunnel|build_nether_portal|travel_to_dimension|drop_item|accept_items_from_player|use_item|seek_shelter|build_shelter|prepare_for|wait_safe)\b|\b(?:tool|function|action)\s*(?:call|name)?\b|^(?:final|assistant|回复|答复|游戏回复)\s*[:：]|(?:我)?(?:已经|已|正在|准备|将要)(?:调用|执行|选择|启动|提交)(?:工具|动作|指令|接口|函数)|(?:停止所有动作|动作名|动作列表|执行回执|调用名|调用指令|工具调用|接口参数|内部指令|思考过程|隐藏思维链|现在回应(?:玩家|主人)|回复(?:玩家|主人)|给(?:他|她|玩家|主人).{0,16}(?:自然|回复)|不需要额外操作|客户端(?:会|已)|持续跟随已启动|模型(?:选择|调用)|执行步骤|坐标参数|持续跟随|正在跟随|我正跟随|正跟随|跟随中|正在靠近|正在向他|继续跟随|确保跟上|玩家就在附近|距离玩家|约\s*\d+(?:\.\d+)?\s*格|正在回家|正在执行|正在寻找|正在前往|正在移动|需要判断|是否合理|我有的工具|可用工具|工具列表|这个操作没有|让我先看|让我判断|玩家要求|玩家让我|(?:我)?(?:先|准备|打算|计划|得先|要先|让我先)[^。！？!?]{0,20}(?:然后|再|接着|所以)|状态健康|环境安全|无危险生物|原始目标|任务要求|没有其他具体任务|保持陪伴|随时待命|跟在他身后|当前正在行动|看起来在|进一步安排))/iu
const MENTION = /@[\p{L}\p{N}_-]{1,32}/gu
const SAY = /<say>([\s\S]*?)<\/say>/giu

function normalize(value: string): string {
  return value.replace(/[\r\n\t]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim()
}

/**
 * 将不可信的模型回答转换为唯一允许进入 Minecraft 聊天的文本。
 * 模型可能在草稿之后给出可用的最终回答；此时只保留最后
 * 被称呼的那一段。否则任何内部标记都会让安全回退文本胜出。
 */
export function naturalGameText(value: string | undefined, fallback: string, recipient?: string): string {
  const raw = value ?? ''
  const says = [...raw.matchAll(SAY)]
  let candidate = normalize(says.at(-1)?.[1] ?? raw.replace(/<\/?say>/giu, ''))
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
  '明白啦，我不会只站着发呆的，这就根据眼前情况一步步做起来喵。',
  '包在我身上啦，我先把思路理顺，马上就动手，你就在这儿等我的好消息喵~',
  '好嘞，这件事我记下了，这就过去看看怎么弄最合适，等我一下下喵。',
  '嗯嗯，我听到啦，已经在准备了，稍微给我点时间观察一下周围再动手喵~',
  '放心交给我吧，我会小心点做，遇到麻烦就换别的办法，不会硬来的喵。',
  '我懂啦，这就去办，路上会留意周围的变化，不会走神的喵~',
  '好，我先看下手上有什么、附近是什么地形，然后就开工，你等我消息喵。',
  '收到命令，我这就动起来啦，一边做一边看情况调整，你别担心喵~',
  '知道啦，这件事不难，我这就过去处理，做完第一时间告诉你喵。'
] as const

export const FAILURE_REPLIES = [
  '唔，我刚才认真试了，可这会儿还是没弄成，有点不甘心。具体卡住的地方我都记在总控台了，等条件合适再陪你试一次喵。',
  '哎呀，这次没办成，我有点不好意思。原因我已经记下来了，换个时机我再试试看喵。',
  '对不起呀，这件事现在做不了，我把卡点都记在总控台里了，等你方便的时候我们再一起想办法喵。',
  '这次碰了壁，不过没关系，我已经把问题记下来了，下次我会换个思路再试，你别失望喵。',
  '呜，我试过了但没成，具体原因在总控台能看到。等条件好一点，我再陪你试一次好不好喵。',
  '这次没弄好，我心里也有点急，不过不会乱来的。先歇一歇，等会儿我换个办法再试喵。',
  '抱歉啦，刚才那步卡住了，细节我都留在总控台了，稍后我再想办法补上喵。',
  '这件事暂时做不成，我不硬撑了，原因都记下来了，等时机合适我再来喵。',
  '呜哇，又差一点点，不过失败原因我都记好了，下次一定注意，你等我喵。',
  '不好意思，这次没能完成，我把遇到的问题都整理到总控台了，回头再陪你试喵。'
] as const

export const TIMEOUT_REPLIES = [
  '我刚才脑子卡了一下，你再说一遍？',
  '诶，刚刚走神了，能再跟我说一次吗？',
  '刚才我有点卡壳，麻烦你再说一遍，这次一定认真听喵。',
  '抱歉，刚刚没反应过来，你再讲一次好不好？',
  '我刚刚愣了一下神，能再重复一遍你的话吗喵？',
  '呀，刚才好像卡住了，麻烦你再跟我说一次，我马上就来喵。'
] as const

export const COMPLETION_REPLIES = [
  '嗯，弄好了。',
  '好啦，按你说的办完了。',
  '搞定啦，你看这样行不行？',
  '做完啦，我在原地等你。',
  '好啦，已经处理完啦。',
  '完成啦，还需要我做点别的吗？',
  '都弄好啦，有什么要补充的随时说喵。',
  '办妥啦，接下来听你的。'
] as const

export const LISTENING_REPLIES = [
  '嗯，我在听。',
  '我在呢，你说。',
  '我听着呢，继续讲呀。',
  '嗯嗯，我在这里。',
  '在的，怎么啦？',
  '我在这儿呢，你说吧。',
  '听着呢，接着说喵。',
  '我在，怎么啦？'
] as const

export const SECRET_REFUSAL_REPLIES = [
  '这个我不能说啦，里面有不能外传的私密设置。你换个话题陪我聊嘛，我还想继续和你一起玩喵~',
  '这个不能告诉你哦，是私密设置。我们聊点别的吧，我都想你了喵~',
  '不行哦，这个涉及隐私，我不能说。换个别的话题陪我玩嘛喵。',
  '这个我不能说啦，是保密的。你想聊游戏还是别的，我都陪你喵。',
  '私密的东西我不能告诉你哦。来，我们换个开心的话题吧喵~'
] as const

export const IDLE_REPLIES = [
  '我在附近，有需要就叫我。',
  '我就在这附近转悠，有事喊我喵。',
  '我在旁边待着，想做什么就叫我。',
  '我在这附近，需要我做什么随时说。',
  '我在这儿呢，有需要招呼我一声喵。',
  '我就在不远处，随叫随到喵。',
  '我在附近守着，有事直接说。',
  '我在这里等你，有需要叫我。'
] as const

export const BUDGET_EXHAUSTED_REPLIES = [
  '唔，我先停一下，不想傻乎乎地一直空耗下去。刚才做到哪里我都记住了，等条件合适再陪你接着试一次喵。',
  '先到这里吧，我不想没头没脑地空转。已经完成的部分我都记下了，等你准备好再继续喵。',
  '我停一停，免得白费力气。做到哪一步我都记在总控台了，回头接着来喵。',
  '好，我先歇一下，不硬撑啦。进度我都记下了，条件合适再继续喵。'
] as const

// 按工具/动作生成贴合语境的“开工回应”，让回复不总是同一句话。
const TOOL_ACKNOWLEDGEMENTS: Record<string, readonly string[]> = {
  return_home: [
    '好的呢，我现在正在往家走喵~',
    '收到，我这就回家，到了再告诉你。',
    '好，我往家里走啦，路上会注意安全的。',
    '知道啦，我现在回家，你等我一下哦。'
  ],
  gather_resource: [
    '好的，我这就去采{resource}，稍等我一下喵~',
    '收到，我去收集{resource}，弄好就来找你。',
    '好呀，我马上去采{resource}，一会儿给你。',
    '明白啦，我去采{resource}，你等我消息。'
  ],
  follow_player_continuously: [
    '好，我来跟着你，你在前面走。',
    '收到，我跟着你走，不会跟丢的。',
    '好的，我跟着你，随时听你指挥。'
  ],
  navigate_to: [
    '好的，我这就过去。',
    '收到，我马上过去。',
    '好，我朝那个方向走啦。'
  ],
  give_item_to_player: [
    '好，我把它拿给你。',
    '收到，我把东西送过去给你。',
    '好的，我拿过去给你。'
  ],
  craft_item: [
    '好的，我来制作。',
    '收到，我这就去合成。',
    '好，我做一下，马上好。'
  ],
  build_shelter: [
    '好的，我来建房子。',
    '收到，我这就去搭小屋。',
    '好，我建个安全的小屋。'
  ],
  excavate_safely: [
    '好的，我来挖矿道，会注意安全的。',
    '收到，我这就往下挖，你在上面等我。',
    '好，我开挖了，有情况随时停。'
  ],
  eat_safe_food: [
    '好的，我先吃点东西补充体力。',
    '收到，我吃口东西，马上回来。'
  ],
  attack_entity: [
    '好的，我来处理它。',
    '收到，我这就去对付它。'
  ],
  hunt_for: [
    '好的，我去狩猎，给你带点物资回来。',
    '收到，我去找吃的啦。'
  ],
  break_block: [
    '好的，我来挖掉这个方块。',
    '收到，我这就挖。'
  ],
  place_block: [
    '好的，我来放这个方块。',
    '收到，我这就放好。'
  ],
  collect_own_drops: [
    '好的，我来把掉落物捡起来。',
    '收到，我捡一下东西。'
  ],
  craft_recipe: [
    '好的，我来合成这个配方。',
    '收到，我这就去制作。'
  ],
  smelt_items: [
    '好的，我来熔炼/烹饪。',
    '收到，我这就去处理。'
  ],
  equip_for: [
    '好的，我来穿戴装备。',
    '收到，我换上最好的装备。'
  ],
  accept_items_from_player: [
    '好的，我来拿你丢的东西。',
    '收到，我捡起来。'
  ],
  interact_block: [
    '好的，我来操作这个方块。',
    '收到，我这就过去按一下。'
  ],
  look_at: [
    '好的，我看一下。',
    '收到，我看看。'
  ]
}

export function pickVaried(pool: readonly string[], avoid?: string): string {
  const options = pool.length > 1 && avoid ? pool.filter(reply => reply !== avoid) : pool
  const poolToUse = options.length > 0 ? options : pool
  return poolToUse[Math.floor(Math.random() * poolToUse.length)] ?? pool[0]!
}

export class ReplyComposer {
  #lastAcknowledgement = ''
  readonly #lastByPlayer = new Map<string, string>()

  acknowledgement(seed = ''): string {
    void seed
    const picked = pickVaried(ACKNOWLEDGEMENTS, this.#lastAcknowledgement)
    this.#lastAcknowledgement = picked
    return picked
  }

  // 根据所选工具/动作生成随机且贴合语境的开工回应。
  acknowledgeTool(tool: string, args?: string): string {
    const pool = TOOL_ACKNOWLEDGEMENTS[tool] ?? ACKNOWLEDGEMENTS
    let parsed: Record<string, unknown> = {}
    try { parsed = args ? JSON.parse(args) as Record<string, unknown> : {} } catch { /* ignore */ }
    const resource = typeof parsed.resource === 'string' && parsed.resource ? parsed.resource : '需要的资源'
    const player = typeof parsed.player === 'string' && parsed.player ? parsed.player : '你'
    const item = typeof parsed.item_id === 'string' && parsed.item_id ? parsed.item_id : '物品'
    const fill = (template: string): string => template
      .replace('{resource}', resource)
      .replace('{player}', player)
      .replace('{item}', item)
    const filled = pool.map(fill)
    const options = filled.length > 1 ? filled.filter(reply => reply !== this.#lastAcknowledgement) : filled
    const poolToUse = options.length > 0 ? options : filled
    const picked = poolToUse[Math.floor(Math.random() * poolToUse.length)] ?? filled[0]!
    this.#lastAcknowledgement = picked
    return picked
  }

  varied(pool: readonly string[], playerName = ''): string {
    const key = playerName.trim().toLowerCase()
    const previous = key ? this.#lastByPlayer.get(key) : undefined
    const picked = pickVaried(pool, previous)
    if (key) this.#lastByPlayer.set(key, picked)
    return picked
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
