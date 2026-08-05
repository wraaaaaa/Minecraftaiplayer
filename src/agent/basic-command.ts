import type { AgentDecision } from './decision.js'
import type { WorldState } from './world-state.js'

const CHINESE_NUMBERS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
}

function requestedCount(message: string, maximum: number, fallback = 1): number {
  const digits = message.match(/\d{1,2}/u)?.[0]
  if (digits) return Math.max(1, Math.min(maximum, Number(digits)))
  const compound = message.match(/([一二两三四五六七八九])?十([一二三四五六七八九])?/u)
  if (compound) return Math.min(maximum, (compound[1] ? (CHINESE_NUMBERS[compound[1]] ?? 1) : 1) * 10 + (compound[2] ? (CHINESE_NUMBERS[compound[2]] ?? 0) : 0))
  const single = message.match(/[一二两三四五六七八九十]/u)?.[0]
  return single ? Math.min(maximum, CHINESE_NUMBERS[single] ?? fallback) : fallback
}

function itemCount(world: WorldState, predicate: (id: string) => boolean): number {
  return world.inventory.reduce((sum, item) => sum + (predicate((item.itemId ?? '').toLowerCase()) ? item.count : 0), 0)
}

function surveyed(world: WorldState, category: string): boolean {
  return world.blockSurvey?.resources.some(entry => entry.category === category && entry.count > 0) ?? false
}

function inventoryItem(world: WorldState, predicate: (id: string) => boolean): string | undefined {
  return world.inventory.find(item => item.itemId && predicate(item.itemId.toLowerCase()))?.itemId
}

function placeItem(message: string, world: WorldState): string | undefined {
  const matchers: Array<[RegExp, (id: string) => boolean]> = [
    [/(?:工作台|合成台|crafting[_ ]?table)/iu, id => id === 'minecraft:crafting_table'],
    [/(?:石砖|stone[_ ]?bricks?)/iu, id => id === 'minecraft:stone_bricks'],
    [/(?:原木|木头|logs?)/iu, id => id.endsWith('_log') || id.endsWith('_wood')],
    [/(?:圆石|cobblestone)/iu, id => id === 'minecraft:cobblestone'],
    [/(?:泥土|dirt)/iu, id => id === 'minecraft:dirt'],
    [/(?:木板|planks?)/iu, id => id.endsWith('_planks')],
    [/(?:羊毛|wool)/iu, id => id.endsWith('_wool')],
    [/(?:石头|stone)/iu, id => id === 'minecraft:stone']
  ]
  for (const [pattern, predicate] of matchers) {
    if (pattern.test(message)) return inventoryItem(world, predicate)
  }
  return undefined
}

function gatherResource(message: string, world: WorldState): string | undefined {
  const aliases: Array<[RegExp, string]> = [
    [/(?:石砖|stone[_ ]?bricks?)/iu, 'minecraft:stone_bricks'],
    [/(?:木头|原木|木材|wood|logs?)/iu, 'wood'],
    [/(?:圆石|cobblestone)/iu, 'minecraft:cobblestone'],
    [/(?:石头|石块|stone)/iu, 'stone'],
    [/(?:煤矿|煤炭|煤|coal)/iu, 'coal'],
    [/(?:铁矿|铁|iron)/iu, 'iron'],
    [/(?:铜矿|铜|copper)/iu, 'copper'],
    [/(?:金矿|金|gold)/iu, 'gold'],
    [/(?:钻石矿|钻石|diamond)/iu, 'diamond'],
    [/(?:青金石矿|青金石|lapis)/iu, 'lapis'],
    [/(?:红石矿|红石|redstone)/iu, 'redstone'],
    [/(?:绿宝石矿|绿宝石|emerald)/iu, 'emerald'],
    [/(?:黑曜石|obsidian)/iu, 'obsidian']
  ]
  for (const [pattern, resource] of aliases) if (pattern.test(message)) return resource
  if (!/(?:采集|收集|挖掘|挖|开采|材料|资源|gather|collect|mine)/iu.test(message)) return undefined
  const wood = itemCount(world, id => id.endsWith('_log') || id.endsWith('_wood') || id.endsWith('_planks'))
  if (wood < 8 && surveyed(world, 'logs')) return 'wood'
  if (surveyed(world, 'stone')) return 'stone'
  return world.blockSurvey?.resources[0]?.blockId
}

function craftItem(message: string, world: WorldState): string | undefined {
  const materialAliases: Array<[RegExp, string]> = [
    [/(?:下界合金|netherite)/iu, 'netherite'],
    [/(?:钻石|diamond)/iu, 'diamond'],
    [/(?:铁制?|iron)/iu, 'iron'],
    [/(?:金制?|黄金|golden)/iu, 'golden'],
    [/(?:石制?|stone)/iu, 'stone'],
    [/(?:木制?|wooden)/iu, 'wooden']
  ]
  const toolAliases: Array<[RegExp, string]> = [
    [/(?:镐|pickaxe)/iu, 'pickaxe'],
    [/(?:斧|axe)/iu, 'axe'],
    [/(?:剑|sword)/iu, 'sword'],
    [/(?:锹|铲|shovel)/iu, 'shovel'],
    [/(?:锄|hoe)/iu, 'hoe']
  ]
  const material = materialAliases.find(([pattern]) => pattern.test(message))?.[1]
  const tool = toolAliases.find(([pattern]) => pattern.test(message))?.[1]
  if (material && tool) return `minecraft:${material}_${tool}`
  if (/(?:木镐|木制镐|wooden[_ ]?pickaxe)/iu.test(message)) return 'minecraft:wooden_pickaxe'
  if (/(?:石镐|stone[_ ]?pickaxe)/iu.test(message)) return 'minecraft:stone_pickaxe'
  if (/(?:木斧|木制斧|wooden[_ ]?axe)/iu.test(message)) return 'minecraft:wooden_axe'
  if (/(?:石斧|stone[_ ]?axe)/iu.test(message)) return 'minecraft:stone_axe'
  if (/(?:木剑|木制剑|wooden[_ ]?sword)/iu.test(message)) return 'minecraft:wooden_sword'
  if (/(?:石剑|stone[_ ]?sword)/iu.test(message)) return 'minecraft:stone_sword'
  if (/(?:木锹|木铲|wooden[_ ]?shovel)/iu.test(message)) return 'minecraft:wooden_shovel'
  if (/(?:石锹|石铲|stone[_ ]?shovel)/iu.test(message)) return 'minecraft:stone_shovel'
  if (/(?:工作台|合成台|crafting[_ ]?table)/iu.test(message)) return 'minecraft:crafting_table'
  if (/(?:熔炉|furnace)/iu.test(message)) return 'minecraft:furnace'
  if (/(?:附魔台|enchanting[_ ]?table)/iu.test(message)) return 'minecraft:enchanting_table'
  if (/(?:床|bed)/iu.test(message)) {
    const wool = inventoryItem(world, id => id.endsWith('_wool'))
    const color = wool?.match(/^minecraft:([a-z_]+)_wool$/u)?.[1] ?? 'white'
    return `minecraft:${color}_bed`
  }
  if (/(?:木棍|sticks?)/iu.test(message)) return 'minecraft:stick'
  if (/(?:火把|torches?)/iu.test(message)) return 'minecraft:torch'
  if (/(?:木板|planks?)/iu.test(message)) {
    const log = inventoryItem(world, id => id.endsWith('_log') || id.endsWith('_wood'))
    const path = log?.match(/^minecraft:([a-z0-9_]+?)(?:_log|_wood)$/u)?.[1]
    if (path) return `minecraft:${path}_planks`
  }
  return undefined
}

function mentionedInventoryItem(message: string, world: WorldState): string | undefined {
  const aliases: Array<[RegExp, (id: string) => boolean]> = [
    [/(?:烤土豆|烤马铃薯|baked[_ ]?potato)/iu, id => id === 'minecraft:baked_potato'],
    [/(?:土豆|马铃薯|potato)/iu, id => id === 'minecraft:potato'],
    [/(?:面包|bread)/iu, id => id === 'minecraft:bread'],
    [/(?:木镐|wooden[_ ]?pickaxe)/iu, id => id === 'minecraft:wooden_pickaxe'],
    [/(?:石镐|stone[_ ]?pickaxe)/iu, id => id === 'minecraft:stone_pickaxe'],
    [/(?:木头|原木|logs?)/iu, id => id.endsWith('_log') || id.endsWith('_wood')],
    [/(?:木板|planks?)/iu, id => id.endsWith('_planks')],
    [/(?:圆石|cobblestone)/iu, id => id === 'minecraft:cobblestone'],
    [/(?:石砖|stone[_ ]?bricks?)/iu, id => id === 'minecraft:stone_bricks']
  ]
  for (const [pattern, predicate] of aliases) {
    if (pattern.test(message)) return inventoryItem(world, predicate)
  }
  return undefined
}

function nearbyCraftingTable(world: WorldState): boolean {
  return [...(world.blockSurvey?.artificial ?? []), ...(world.blockSurvey?.other ?? [])]
    .some(entry => entry.blockId === 'minecraft:crafting_table' && entry.count > 0)
}

function starterToolPlan(targetItemId: string, world: WorldState): AgentDecision {
  const logs = itemCount(world, id => id.endsWith('_log') || id.endsWith('_wood'))
  const planks = itemCount(world, id => id.endsWith('_planks'))
  const sticks = itemCount(world, id => id === 'minecraft:stick')
  const cobblestone = itemCount(world, id => id === 'minecraft:cobblestone')
  const tableInInventory = itemCount(world, id => id === 'minecraft:crafting_table') > 0
  const tableNearby = nearbyCraftingTable(world)
  const hasPickaxe = world.inventory.some(item => item.itemId?.endsWith('_pickaxe'))
  const logId = inventoryItem(world, id => id.endsWith('_log') || id.endsWith('_wood'))
    ?? world.blockSurvey?.resources.find(entry => entry.category === 'logs')?.blockId
  const species = logId?.match(/^minecraft:([a-z0-9_]+?)(?:_log|_wood)$/u)?.[1] ?? 'oak'
  const actions: NonNullable<AgentDecision['actions']> = []
  const toolPlankCost = targetItemId.endsWith('_shovel') ? 1 : targetItemId.endsWith('_sword') ? 2 : 3
  const woodenPreparationCost = targetItemId.startsWith('minecraft:wooden_')
    ? toolPlankCost
    : targetItemId.startsWith('minecraft:stone_') && !hasPickaxe ? 3 : 0
  const requiredPlanks = (!tableInInventory && !tableNearby ? 4 : 0) + (sticks < 2 ? 2 : 0) + woodenPreparationCost
  const missingLogs = Math.max(0, Math.ceil(Math.max(0, requiredPlanks - planks) / 4) - logs)
  if (missingLogs > 0) actions.push({ type: 'gather_resource', resource: 'wood', count: missingLogs })
  const planksToCraft = Math.max(0, requiredPlanks - planks)
  if (planksToCraft > 0) actions.push({
    type: 'craft_item', itemId: `minecraft:${species}_planks`, count: Math.ceil(planksToCraft / 4) * 4
  })
  if (!tableInInventory && !tableNearby) actions.push({ type: 'craft_item', itemId: 'minecraft:crafting_table', count: 1 })
  if (sticks < 2) actions.push({ type: 'craft_item', itemId: 'minecraft:stick', count: 4 })
  if ((tableInInventory || !tableNearby) && !tableNearby) actions.push({ type: 'place_block', itemId: 'minecraft:crafting_table', count: 1 })

  if (targetItemId.startsWith('minecraft:stone_')) {
    if (!hasPickaxe) {
      actions.push({ type: 'craft_item', itemId: 'minecraft:wooden_pickaxe', count: 1 })
    }
    if (cobblestone < 3) actions.push({ type: 'gather_resource', resource: 'stone', count: 3 })
  }
  actions.push({ type: 'craft_item', itemId: targetItemId, count: 1 })
  return { reply: `我会按步骤获取材料并制作 ${targetItemId}，每一步都要由服务器确认。`, action: actions[0]!, actions }
}

/** High-confidence local commands bypass the LLM so basic gameplay is not model-lottery. */
export function inferBasicDecision(message: string, world: WorldState, currentPlayerName?: string): AgentDecision | undefined {
  const normalized = message.trim()
  if (!normalized) return undefined

  if (currentPlayerName && /(?:跟随我|跟着我|紧跟我|follow me)/iu.test(normalized)) {
    return { reply: '我会持续紧跟你，并在你受到怪物攻击时保护你。', action: { type: 'follow_player', target: currentPlayerName } }
  }
  if (currentPlayerName && /(?:来找我|到我这里|过来找我|come (?:to|find) me)/iu.test(normalized)) {
    return { reply: '我现在来找你。', action: { type: 'come_to_player', target: currentPlayerName } }
  }

  if (/(?:给我|丢给我|扔给我|交给我|drop|give me)/iu.test(normalized)) {
    if (!currentPlayerName) return undefined
    const itemId = mentionedInventoryItem(normalized, world)
    return {
      reply: itemId ? `我会走近你并把 ${requestedCount(normalized, 64)} 个 ${itemId} 丢给你。` : '我没能从这句话确定要给你的物品。',
      action: itemId
        ? { type: 'drop_item', itemId, count: requestedCount(normalized, 64), target: currentPlayerName }
        : { type: 'none' },
      ...(!itemId ? { validationError: '没有识别出要交付的背包物品' } : {})
    }
  }

  if (/(?:吃|进食|eat)(?:点|一个|东西|食物|food)?/iu.test(normalized)) {
    return { reply: '我现在吃背包里最安全合适的食物。', action: { type: 'eat_best_food' } }
  }

  if (/(?:烹饪|烧制|冶炼|烧炼|smelt|cook)/iu.test(normalized)) {
    const inputAliases: Array<[RegExp, string, string]> = [
      [/(?:粗铁|raw[_ ]?iron)/iu, 'minecraft:raw_iron', 'minecraft:iron_ingot'],
      [/(?:粗金|raw[_ ]?gold)/iu, 'minecraft:raw_gold', 'minecraft:gold_ingot'],
      [/(?:粗铜|raw[_ ]?copper)/iu, 'minecraft:raw_copper', 'minecraft:copper_ingot'],
      [/(?:牛肉|beef)/iu, 'minecraft:beef', 'minecraft:cooked_beef'],
      [/(?:猪排|porkchop)/iu, 'minecraft:porkchop', 'minecraft:cooked_porkchop'],
      [/(?:鸡肉|chicken)/iu, 'minecraft:chicken', 'minecraft:cooked_chicken'],
      [/(?:羊肉|mutton)/iu, 'minecraft:mutton', 'minecraft:cooked_mutton'],
      [/(?:鳕鱼|cod)/iu, 'minecraft:cod', 'minecraft:cooked_cod'],
      [/(?:鲑鱼|salmon)/iu, 'minecraft:salmon', 'minecraft:cooked_salmon'],
      [/(?:土豆|马铃薯|potato)/iu, 'minecraft:potato', 'minecraft:baked_potato']
    ]
    const selected = inputAliases.find(([pattern]) => pattern.test(normalized))
      ?? inputAliases.find(([, itemId]) => itemCount(world, id => id === itemId) > 0)
    if (!selected) return { reply: '我没有识别到背包里可烹饪或冶炼的原料。', action: { type: 'none' }, validationError: '没有可识别的熔炉输入物品' }
    return { reply: '我会使用附近的熔炉处理原料。', action: { type: 'smelt_item', inputItemId: selected[1], outputItemId: selected[2], count: requestedCount(normalized, 64) } }
  }

  if (/(?:打猎|狩猎|获取食物|采集食物|杀(?:牛|猪|鸡|羊|鱼)|hunt)/iu.test(normalized)) {
    return { reply: '我会只选择远离玩家设施、未命名、未驯化且成年的目标。', action: { type: 'hunt_entity', purpose: 'food', count: requestedCount(normalized, 64, 2) } }
  }
  if (/(?:获取羊毛|剪羊毛|羊毛.*(?:获取|收集)|wool)/iu.test(normalized)) {
    return { reply: '我会安全获取制作床所需的羊毛。', action: { type: 'hunt_entity', purpose: 'wool', count: requestedCount(normalized, 64, 3) } }
  }
  if (/(?:村民交易|和村民交易|trade)/iu.test(normalized)) {
    return { reply: '我会选择当前背包承担得起且有用的村民交易。', action: { type: 'trade_villager', count: requestedCount(normalized, 16) } }
  }
  if (/(?:给.+附魔|附魔(?:我的|装备|工具|武器|镐|剑)|\benchant\b)/iu.test(normalized) && !/(?:附魔台|enchanting[_ ]?table)/iu.test(normalized)) {
    return { reply: '我会使用附近附魔台、青金石和现有经验附魔最佳物品。', action: { type: 'enchant_item', minLevel: 1 } }
  }
  if (/(?:睡觉|睡床|设置重生点|sleep)/iu.test(normalized)) {
    return { reply: '我会使用附近的床睡觉并由服务器设置重生点。', action: { type: 'sleep_in_bed' } }
  }
  if (/(?:下矿|挖.*矿道|开.*矿道|branch mine|strip mine)/iu.test(normalized)) {
    return { reply: '我会开掘双格高安全矿道，遇到建筑、危险流体或玩家设施会停止。', action: { type: 'excavate_tunnel', targetY: -53, length: requestedCount(normalized, 64, 12) } }
  }
  if (/(?:去|进入|前往).*(?:下界|地狱|nether)/iu.test(normalized)) {
    return { reply: '我会寻找并进入安全的下界传送门。', action: { type: 'travel_to_dimension', dimension: 'minecraft:the_nether' } }
  }
  if (/(?:去|进入|前往).*(?:末地|末影世界|the end)/iu.test(normalized)) {
    return { reply: '我会寻找、激活并进入末地传送门；若当前没有可定位的传送门会如实停止。', action: { type: 'travel_to_dimension', dimension: 'minecraft:the_end' } }
  }

  if (/(?:挖掉|破坏|移除|打掉|break|remove)/iu.test(normalized)
    && /(?:这个|该|所指|指着|面前|目标|特定|this|target)/iu.test(normalized)) {
    const pointed = world.nearbyPlayers.find(player => player.name.toLowerCase() === currentPlayerName?.toLowerCase())?.lookingAtBlock
    if (!pointed) return { reply: '我没有读到你当前指向的方块。请靠近并持续指着它再说一次。', action: { type: 'none' }, validationError: '未观察到发令玩家指向的方块' }
    return {
      reply: `我会只处理你指向的 ${pointed.blockId}。`,
      action: { type: 'gather_resource', resource: pointed.blockId, count: 1, targetBlock: { x: pointed.x, y: pointed.y, z: pointed.z } }
    }
  }

  if (/(?:采集|收集|获取|自己找|自己弄).*(?:合成|制作|做)|(?:合成|制作).*(?:采集|收集|获取|材料)/iu.test(normalized)) {
    const requested = craftItem(normalized, world) ?? 'minecraft:wooden_pickaxe'
    if (/^minecraft:(?:wooden|stone)_(?:pickaxe|axe|sword|shovel)$/u.test(requested)) return starterToolPlan(requested, world)
  }

  if (/(?:放(?:置|下)?|摆放|place)/iu.test(normalized) && /(?:方块|工作台|合成台|泥土|圆石|石头|石砖|原木|木头|木板|羊毛|block|crafting[_ ]?table|dirt|stone|logs?|planks?|wool)/iu.test(normalized)) {
    const itemId = placeItem(normalized, world)
    return {
      reply: itemId ? `我来放置 ${itemId}。` : '我来放置背包里合适的普通方块。',
      action: { type: 'place_block', count: requestedCount(normalized, 16), ...(itemId ? { itemId } : {}) }
    }
  }

  if (/(?:合成|制作|做[一二两三四五六七八九十\d个些]?|craft|make)/iu.test(normalized)) {
    const itemId = craftItem(normalized, world)
    if (itemId) return { reply: `我来合成 ${itemId}。`, action: { type: 'craft_item', itemId, count: requestedCount(normalized, 64) } }
  }

  if (/(?:采集|收集|挖掘|挖|开采|gather|collect|mine)/iu.test(normalized)) {
    const resource = gatherResource(normalized, world)
    if (resource) return { reply: `我来采集 ${resource}。`, action: { type: 'gather_resource', resource, count: requestedCount(normalized, 64) } }
  }

  return undefined
}
