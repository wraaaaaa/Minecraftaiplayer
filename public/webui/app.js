let state
let dirty = false

const AUTONOMY_DEFAULTS = Object.freeze({
  enabled: true,
  ownerName: 'wraaaaaa',
  commandArbitrationMs: 350,
  contextualAddressing: true,
  directAddressDistance: 8,
  conversationWindowMs: 60000,
  lowHealthThreshold: 10,
  criticalHealthThreshold: 6,
  eatBelowFood: 20,
  hostileScanRadius: 12,
  wildernessMinPlayerDistance: 48,
  safeIdleEnabled: true,
  autoInviteNearbyPlayers: true,
  inviteRadius: 7,
  inviteCooldownMs: 1800000,
  discardWornTools: true,
  wornToolRemainingDurability: 1,
  autoGather: true,
  autoCraft: true,
  autoBuildShelter: true,
  autoHunt: true,
  autoSmelt: true,
  autoMine: true,
  autoTrade: true,
  autoEnchant: true,
  autoDimensionTravel: true,
  autoSleep: true,
  protectOwner: true,
  allowVerifiedWilderness: true,
  allowTeleportCommand: false,
  firstHome: Object.freeze({ enabled: true, dimension: 'minecraft:overworld', x: 1226, y: 65, z: 199, radius: 10 })
})

const WORKSPACE_DEFAULTS = Object.freeze({
  promptDirectory: 'data/agent-prompts', playerProfilesDirectory: 'data/player-profiles', contextBudgetChars: 48000,
  compressionTriggerRatio: 0.72, retainRecentEvents: 16,
  selfImprovement: Object.freeze({ enabled: true, allowPromptEdits: true, allowBehaviorPatches: true, minimumRepeatedFailures: 3, researchProvider: 'baidu', researchEndpoint: 'https://www.baidu.com/s', researchTimeoutMs: 12000 })
})

const SPEECH_DEFAULTS = Object.freeze({
  enabled: false, provider: 'volcengine', protocol: 'volcengine_v1', model: 'volcano_tts', apiKeyEnv: 'VOLCENGINE_TTS_ACCESS_TOKEN',
  baseUrl: 'https://openspeech.bytedance.com/api/v1/tts', voice: 'BV001_streaming', style: '用自然、温柔、像朋友聊天的中文语气朗读，不要播报表情符号或系统信息。',
  speed: 1, volume: 1, sampleRate: 24000, timeoutMs: 30000, maxTextChars: 180, maxAudioSeconds: 18, queueLimit: 3, cacheEntries: 32,
  volcengineAppIdEnv: 'VOLCENGINE_TTS_APP_ID', volcengineCluster: 'volcano_tts', customAuthHeader: 'Authorization', customAuthScheme: 'Bearer', customAudioJsonPath: 'audio.data'
})

const $ = id => document.getElementById(id)
const value = id => $(id).value
const number = id => Number($(id).value)
const checked = id => $(id).checked
const lines = id => value(id).split(/\r?\n/).map(item => item.trim()).filter(Boolean)
const set = (id, next) => { $(id).value = next ?? '' }
const setNumber = (id, next) => { $(id).value = Number(next ?? 0) }
const setChecked = (id, next) => { $(id).checked = Boolean(next) }

async function request(url, options = {}) {
  const response = await fetch(url, { headers: { 'content-type': 'application/json' }, ...options })
  const payload = await response.json()
  if (!response.ok || payload.ok === false) throw new Error(payload.error || `请求失败 (${response.status})`)
  return payload
}

function toast(message, error = false) {
  const element = $('toast')
  element.textContent = message
  element.className = error ? 'show error' : 'show'
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => { element.className = '' }, 3500)
}

function setDirty(next) {
  dirty = next
  $('saveState').textContent = next ? '有未保存修改' : '设置已同步'
  $('saveState').style.color = next ? 'var(--amber)' : 'var(--muted)'
}

function centralTimeline(snapshot) {
  const memory = snapshot.memory
  const players = memory?.players || {}
  const messages = (memory?.events || [])
    .filter(event => event.type === 'player_message' || event.type === 'bot_reply')
    .map(event => ({
      id: event.id, at: event.at, kind: event.type === 'player_message' ? 'player' : 'bot',
      level: 'info', title: event.type === 'player_message' ? (players[event.playerKey]?.currentName || '玩家') : (memory?.botName || 'Bot'),
      summary: event.content, detail: ''
    }))
  const diagnostics = (snapshot.diagnostics?.events || [])
    .filter(event => event.type !== 'request')
    .map(event => ({ ...event, kind: 'diagnostic' }))
  return [...messages, ...diagnostics]
    .sort((left, right) => Date.parse(left.at) - Date.parse(right.at) || String(left.id).localeCompare(String(right.id)))
    .slice(-250)
}

function appendTimelineEvent(parent, event) {
  const article = document.createElement('article')
  article.className = `timeline-event ${event.kind} ${event.level || 'info'}`
  const meta = document.createElement('div')
  meta.className = 'timeline-meta'
  const title = document.createElement('strong')
  title.textContent = event.title || '诊断'
  const time = document.createElement('span')
  const timestamp = new Date(event.at)
  time.textContent = Number.isNaN(timestamp.getTime()) ? event.at : timestamp.toLocaleString()
  meta.append(title, time)
  if (event.playerName && event.kind === 'diagnostic') {
    const player = document.createElement('span')
    player.textContent = `玩家：${event.playerName}`
    meta.append(player)
  }
  const summary = document.createElement('p')
  summary.textContent = event.summary || '—'
  article.append(meta, summary)
  if (event.detail) {
    const details = document.createElement('details')
    const toggle = document.createElement('summary')
    toggle.textContent = event.level === 'error' ? '查看完整错误原因' : '查看动作、参数与后置条件'
    const content = document.createElement('pre')
    content.textContent = event.detail
    details.append(toggle, content)
    article.append(details)
  }
  parent.append(article)
}

function renderCentralChat(snapshot) {
  const timeline = $('centralChatTimeline')
  if (!timeline) return
  const nearBottom = timeline.scrollHeight - timeline.scrollTop - timeline.clientHeight < 80
  const filter = value('centralChatFilter')
  const all = centralTimeline(snapshot)
  const visible = filter === 'conversation' ? all.filter(event => event.kind === 'player' || event.kind === 'bot')
    : filter === 'errors' ? all.filter(event => event.level === 'error' || event.level === 'warning') : all
  timeline.replaceChildren()
  if (!visible.length) {
    const empty = document.createElement('p')
    empty.className = 'central-chat-empty'
    empty.textContent = filter === 'all' ? '暂无对话或诊断记录' : '当前筛选条件下没有记录'
    timeline.append(empty)
  } else {
    visible.forEach(event => appendTimelineEvent(timeline, event))
  }
  $('centralChatCount').textContent = `${visible.length} 条（最多显示最近 250 条）`
  if (nearBottom) timeline.scrollTop = timeline.scrollHeight

  const tasks = (snapshot.tasks?.tasks || []).slice().sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
  const important = [...tasks.filter(task => task.status === 'running' || task.status === 'queued'), ...tasks.filter(task => task.status === 'failed').slice(0, 3)].slice(0, 8)
  const taskSummary = $('centralTaskSummary')
  taskSummary.replaceChildren()
  if (!important.length) taskSummary.textContent = '暂无任务'
  for (const task of important) {
    const item = document.createElement('div')
    item.className = 'task-pill'
    const status = document.createElement('strong')
    status.textContent = `${task.issuer.name} · ${{ queued: '排队', running: '执行中', failed: '失败', completed: '完成' }[task.status] || task.status}`
    const requestText = document.createElement('span')
    requestText.textContent = task.request
    item.append(status, requestText)
    taskSummary.append(item)
  }
  const modelTurns = (snapshot.diagnostics?.events || []).filter(event => event.metadata?.source === 'native-tool-loop' && Number(event.metadata?.apiCall) > 0)
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000
  const recentTurns = modelTurns.filter(event => Date.parse(event.at) >= recentCutoff)
  const lastTaskId = modelTurns.at(-1)?.taskId
  const lastTaskTurns = lastTaskId ? modelTurns.filter(event => event.taskId === lastTaskId) : []
  const sum = (events, key) => events.reduce((total, event) => total + Number(event.metadata?.[key] || 0), 0)
  const costSummary = $('centralCostSummary')
  costSummary.replaceChildren()
  if (!modelTurns.length) costSummary.textContent = '暂无模型轮次'
  else {
    for (const [titleText, detailText] of [
      ['最近任务', `${lastTaskTurns.length} 次 API · ${sum(lastTaskTurns, 'totalTokens').toLocaleString()} Token · ${sum(lastTaskTurns, 'elapsedMs').toLocaleString()} ms`],
      ['最近 24 小时', `${recentTurns.length} 次 API · ${sum(recentTurns, 'totalTokens').toLocaleString()} Token`]
    ]) {
      const item = document.createElement('div'); item.className = 'task-pill'
      const title = document.createElement('strong'); title.textContent = titleText
      const detail = document.createElement('span'); detail.textContent = detailText
      item.append(title, detail); costSummary.append(item)
    }
  }
}

function renderStatus(snapshot) {
  const bot = snapshot.runtime.bot
  const client = snapshot.runtime.client
  $('botStatus').textContent = bot.running ? '运行中' : '已停止'
  $('botStatus').style.color = bot.running ? 'var(--green)' : 'var(--muted)'
  $('botPid').textContent = bot.pid ? `PID ${bot.pid}` : '没有后台进程'
  $('clientStatus').textContent = client.running ? '运行中' : '已停止'
  $('clientStatus').style.color = client.running ? 'var(--green)' : 'var(--muted)'
  $('clientPid').textContent = client.pid ? `PID ${client.pid}` : '没有后台进程'
  const mods = snapshot.manifest.files || []
  $('modCount').textContent = `${mods.length} 个外部模组`
  $('modSyncTime').textContent = snapshot.manifest.syncedAt ? new Date(snapshot.manifest.syncedAt).toLocaleString() : '尚未同步'
  const selectedKey = snapshot.config.model.apiKeyEnv
  $('keyStatus').textContent = snapshot.secrets[selectedKey] ? '已配置' : '未配置'
  $('keyStatus').style.color = snapshot.secrets[selectedKey] ? 'var(--green)' : 'var(--amber)'
  const live = snapshot.live
  const world = live?.world
  const phaseLabels = { starting: '正在启动', waiting_for_client: '等待游戏客户端', connected: '客户端已连接', in_world: '已进入世界', disconnected: '连接已断开', stopped: '已停止' }
  $('worldPhase').textContent = live ? (phaseLabels[live.phase] || live.phase) : '没有状态记录'
  $('worldPosition').textContent = world?.position ? `${world.position.x.toFixed(1)}, ${world.position.y.toFixed(1)}, ${world.position.z.toFixed(1)}` : '—'
  $('worldVitals').textContent = world && (world.health !== undefined || world.food !== undefined) ? `${world.health ?? '—'} HP / ${world.food ?? '—'}` : '—'
  $('worldContext').textContent = world ? `${world.dimension || '—'} / ${world.nearbyPlayers?.length ?? 0} 人` : '—'
  $('worldAutonomy').textContent = world ? `${world.activePrimitive || '安全等待'}${world.navigationStatus && world.navigationStatus !== 'idle' ? ` · ${world.navigationStatus}` : ''} / ${world.home ? '住所已记录' : '无住所'}` : '—'
  const taskCounts = (snapshot.tasks?.tasks || []).reduce((counts, task) => { counts[task.status] = (counts[task.status] || 0) + 1; return counts }, {})
  $('taskQueueSummary').textContent = snapshot.tasks ? `执行中 ${taskCounts.running || 0}，排队 ${taskCounts.queued || 0}，完成 ${taskCounts.completed || 0}，失败/拒绝 ${taskCounts.failed || 0}` : '尚无任务记录'
  const progression = snapshot.progression
  $('progressionSummary').textContent = progression
    ? `${progression.stage || 'survive'}；最近：${progression.lastAction || '等待'}${progression.lastResult ? `（${progression.lastResult.ok ? '成功' : '失败'}）` : ''}`
    : '尚未生成发育进度文件'
  $('modsSummary').textContent = snapshot.manifest.sourceDirectory ? `来源：${snapshot.manifest.sourceDirectory}` : '尚未设置模组来源'
  $('modList').replaceChildren(...mods.map(mod => {
    const item = document.createElement('div')
    item.className = 'mod-item'
    const name = document.createElement('span')
    name.textContent = mod.name
    const size = document.createElement('span')
    const compatibility = mod.compatibility?.status === 'copied_unverified' ? '待启动验证' : mod.compatibility?.status === 'likely_server_only' ? '疑似仅服务端' : mod.compatibility?.status === 'likely_incompatible_loader' ? '疑似非 Fabric' : '旧清单'
    size.textContent = `${(mod.size / 1024 / 1024).toFixed(2)} MB · ${compatibility}`
    item.append(name, size)
    return item
  }))
  $('botLogs').textContent = snapshot.logs.bot.join('\n') || '暂无日志'
  $('gameLogs').textContent = snapshot.logs.game.join('\n') || '暂无日志'
  const memory = snapshot.memory
  const experience = snapshot.experience
  $('memoryPlayers').textContent = String(Object.keys(memory?.players || {}).length)
  $('memoryEvents').textContent = String(memory?.events?.length || 0)
  $('experienceEntries').textContent = String(experience?.entries?.length || 0)
  $('memoryView').textContent = memory ? JSON.stringify({ globalSummary: memory.globalSummary, players: Object.values(memory.players || {}).map(player => ({ name: player.currentName, knownNames: player.knownNames, facts: player.facts, lastSeenAt: player.lastSeenAt })), recentEvents: (memory.events || []).slice(-12) }, null, 2) : '尚未生成记忆文件'
  $('experienceView').textContent = experience ? JSON.stringify((experience.entries || []).slice(-12).map(entry => ({ task: entry.task, outcome: entry.outcome, lesson: entry.lesson, correction: entry.correction, verified: entry.verified })), null, 2) : '尚未生成经验文件'
  renderCentralChat(snapshot)
  $('skinState').textContent = snapshot.skin.imported ? `已导入：${snapshot.skin.skinFile}` : '尚未导入标准皮肤 PNG'
  $('skinPreview').src = snapshot.skin.imageUrl ? `${snapshot.skin.imageUrl}?t=${Date.now()}` : ''
  $('skinPreview').hidden = !snapshot.skin.imageUrl
}

function renderPlayerProfiles(snapshot) {
  const select = $('playerProfileSelect')
  const current = select.value
  const profiles = snapshot.playerProfiles || []
  select.replaceChildren()
  if (!profiles.length) {
    const option = document.createElement('option'); option.value = ''; option.textContent = '暂无玩家画像'; select.append(option)
    set('playerProfileContent', '')
  } else {
    profiles.forEach(profile => {
      const option = document.createElement('option'); option.value = profile.id; option.textContent = `${profile.playerName}${profile.uuid ? ` · ${profile.uuid}` : ''}`; select.append(option)
    })
    select.value = profiles.some(profile => profile.id === current) ? current : profiles[0].id
    set('playerProfileContent', profiles.find(profile => profile.id === select.value)?.content || '')
  }
  $('behaviorPatchView').textContent = snapshot.behaviorPatches?.patches?.length
    ? JSON.stringify(snapshot.behaviorPatches.patches, null, 2) : '暂无补丁'
}

function populate(snapshot) {
  state = snapshot
  const c = snapshot.config
  set('connectionMode', c.server.connectionMode); set('serverAdapter', c.server.adapter); set('serverHost', c.server.host); setNumber('serverPort', c.server.port); setNumber('lanDiscoveryTimeout', c.server.lanDiscoveryTimeoutMs)
  set('serverVersion', c.server.version); set('serverUsername', c.server.username); set('serverAuth', c.server.auth)
  setNumber('connectTimeout', c.server.connectTimeoutMs); setNumber('reconnectDelay', c.server.reconnectDelayMs); setChecked('autoRespawn', c.server.autoRespawn ?? true); setNumber('respawnDelay', c.server.respawnDelayMs ?? 3000); setNumber('actionTimeout', c.server.actionTimeoutMs)
  set('bridgeHost', c.server.bridgeHost); setNumber('bridgePort', c.server.bridgePort)
  setChecked('easyAuthEnabled', c.easyAuth.enabled); setChecked('registerIfNeeded', c.easyAuth.registerIfNeeded); set('passwordEnv', c.easyAuth.passwordEnv); setNumber('loginDelay', c.easyAuth.loginDelayMs)
  set('modelProvider', c.model.provider); set('modelName', c.model.model); set('apiKeyEnv', c.model.apiKeyEnv); set('modelBaseUrl', c.model.baseUrl); set('reasoningEffort', c.model.reasoningEffort); setNumber('modelTimeout', c.model.timeoutMs); setNumber('maxOutputTokens', c.model.maxOutputTokens ?? 4096); setNumber('agentMaxSteps', c.model.agentMaxSteps ?? 12); setNumber('autonomousAgentMaxSteps', c.model.autonomousAgentMaxSteps ?? 8)
  setNumber('agentMaxApiCalls', c.model.agentMaxApiCalls ?? 8); setNumber('agentMaxTaskTokens', c.model.agentMaxTaskTokens ?? 160000); setNumber('agentMaxInputTokensPerCall', c.model.agentMaxInputTokensPerCall ?? 48000); setNumber('agentMaxOutputTokens', c.model.agentMaxOutputTokens ?? 1024); set('agentFollowupReasoningEffort', c.model.agentFollowupReasoningEffort ?? 'none')
  const multimodal = { autoDetect: true, visionEnabled: true, audioEnabled: true, onlineResearchEnabled: true, sensoryDirectory: 'data/sensory', ...(c.model.multimodal || {}) }
  setChecked('multimodalAutoDetect', multimodal.autoDetect); setChecked('visionEnabled', multimodal.visionEnabled); setChecked('audioEnabled', multimodal.audioEnabled); setChecked('onlineResearchEnabled', multimodal.onlineResearchEnabled); set('sensoryDirectory', multimodal.sensoryDirectory)
  const speech = { ...SPEECH_DEFAULTS, ...(c.speech || {}) }
  setChecked('speechEnabled', speech.enabled); set('speechProvider', speech.provider); set('speechProtocol', speech.protocol); set('speechModel', speech.model); set('speechApiKeyEnv', speech.apiKeyEnv); set('speechBaseUrl', speech.baseUrl); set('speechVoice', speech.voice); set('speechStyle', speech.style)
  setNumber('speechSpeed', speech.speed); setNumber('speechVolume', speech.volume); set('speechSampleRate', String(speech.sampleRate)); setNumber('speechTimeout', speech.timeoutMs); setNumber('speechMaxTextChars', speech.maxTextChars); setNumber('speechMaxAudioSeconds', speech.maxAudioSeconds); setNumber('speechQueueLimit', speech.queueLimit); setNumber('speechCacheEntries', speech.cacheEntries)
  set('speechVolcAppIdEnv', speech.volcengineAppIdEnv); set('speechVolcCluster', speech.volcengineCluster); set('speechCustomAuthHeader', speech.customAuthHeader); set('speechCustomAuthScheme', speech.customAuthScheme); set('speechCustomAudioJsonPath', speech.customAudioJsonPath)
  setChecked('requireMention', c.chat.requireMention); set('replyPrefix', c.chat.replyPrefix); setNumber('cooldownMs', c.chat.cooldownMs); setChecked('proactiveEnabled', c.chat.proactiveEnabled); setNumber('proactiveIdleMs', c.chat.proactiveIdleMs); setNumber('proactiveMinIntervalMs', c.chat.proactiveMinIntervalMs)
  const autonomy = { ...AUTONOMY_DEFAULTS, ...(c.autonomy || {}) }
  setChecked('autonomyEnabled', autonomy.enabled); set('ownerName', autonomy.ownerName); setNumber('commandArbitrationMs', autonomy.commandArbitrationMs); setChecked('contextualAddressing', autonomy.contextualAddressing); setNumber('directAddressDistance', autonomy.directAddressDistance); setNumber('conversationWindowMs', autonomy.conversationWindowMs)
  setNumber('lowHealthThreshold', autonomy.lowHealthThreshold); setNumber('criticalHealthThreshold', autonomy.criticalHealthThreshold); setNumber('eatBelowFood', autonomy.eatBelowFood); setNumber('hostileScanRadius', autonomy.hostileScanRadius); setNumber('wildernessMinPlayerDistance', autonomy.wildernessMinPlayerDistance)
  setChecked('safeIdleEnabled', autonomy.safeIdleEnabled); setChecked('autoInviteNearbyPlayers', autonomy.autoInviteNearbyPlayers); setNumber('inviteRadius', autonomy.inviteRadius); setNumber('inviteCooldownMs', autonomy.inviteCooldownMs); setChecked('discardWornTools', autonomy.discardWornTools); setNumber('wornToolRemainingDurability', autonomy.wornToolRemainingDurability); setChecked('autoGather', autonomy.autoGather); setChecked('autoCraft', autonomy.autoCraft); setChecked('autoBuildShelter', autonomy.autoBuildShelter)
  for (const id of ['autoHunt', 'autoSmelt', 'autoMine', 'autoTrade', 'autoEnchant', 'autoDimensionTravel', 'autoSleep', 'protectOwner', 'allowVerifiedWilderness', 'allowTeleportCommand']) setChecked(id, autonomy[id])
  const firstHome = { ...AUTONOMY_DEFAULTS.firstHome, ...(autonomy.firstHome || {}) }
  setChecked('firstHomeEnabled', firstHome.enabled); set('firstHomeDimension', firstHome.dimension); setNumber('firstHomeX', firstHome.x); setNumber('firstHomeY', firstHome.y); setNumber('firstHomeZ', firstHome.z); setNumber('firstHomeRadius', firstHome.radius)
  const workspace = { ...WORKSPACE_DEFAULTS, ...(c.agentWorkspace || {}), selfImprovement: { ...WORKSPACE_DEFAULTS.selfImprovement, ...(c.agentWorkspace?.selfImprovement || {}) } }
  set('promptDirectory', workspace.promptDirectory); set('playerProfilesDirectory', workspace.playerProfilesDirectory); setNumber('contextBudgetChars', workspace.contextBudgetChars); setNumber('compressionTriggerRatio', workspace.compressionTriggerRatio); setNumber('retainRecentEvents', workspace.retainRecentEvents)
  setChecked('selfImprovementEnabled', workspace.selfImprovement.enabled); setChecked('allowPromptEdits', workspace.selfImprovement.allowPromptEdits); setChecked('allowBehaviorPatches', workspace.selfImprovement.allowBehaviorPatches); setNumber('minimumRepeatedFailures', workspace.selfImprovement.minimumRepeatedFailures); set('researchProvider', workspace.selfImprovement.researchProvider); set('researchEndpoint', workspace.selfImprovement.researchEndpoint); setNumber('researchTimeoutMs', workspace.selfImprovement.researchTimeoutMs)
  set('memoryFile', c.storage.memoryFile); set('experienceFile', c.storage.experienceFile); set('taskFile', c.storage.taskFile ?? 'data/tasks.json'); set('autonomyFile', c.storage.autonomyFile ?? 'data/autonomy-state.json'); set('progressionFile', c.storage.progressionFile ?? 'data/progression.json'); set('ownedBlocksFile', c.storage.ownedBlocksFile ?? 'data/owned-blocks.json'); setNumber('maxEvents', c.storage.maxEvents); set('logFile', c.logging.file); set('logLevel', c.logging.level); setChecked('logConsole', c.logging.console)
  set('personaName', snapshot.persona.name); set('personaDescription', snapshot.persona.description); set('speakingStyle', snapshot.persona.speakingStyle); set('personaGoals', snapshot.persona.goals.join('\n')); set('personaBoundaries', snapshot.persona.boundaries.join('\n'))
  set('promptIdentity', snapshot.prompts.identity); set('promptCapabilities', snapshot.prompts.capabilityRules.join('\n')); set('promptMemory', snapshot.prompts.memoryRules.join('\n')); set('promptContract', snapshot.prompts.actionContract); set('promptProactive', snapshot.prompts.proactiveInstruction)
  set('agentRules', snapshot.agentPrompts['rules.md']); set('agentIdentity', snapshot.agentPrompts['IDENTITY.md']); set('agentSoul', snapshot.agentPrompts['SOUL.md']); set('agentTools', snapshot.agentPrompts['TOOLS.md']); set('agentMemory', snapshot.agentPrompts['MEMORY.md'])
  setChecked('skinEnabled', snapshot.skin.enabled); set('skinModel', snapshot.skin.model); set('skinVisibility', snapshot.skin.visibilityMode); set('skinProviderName', snapshot.skin.onlineProvider.name); set('skinProfileName', snapshot.skin.onlineProvider.profileName); set('skinProviderWebsite', snapshot.skin.onlineProvider.website)
  const r = snapshot.rules
  setChecked('denyBreaking', r.denyBreakingPlayerProperty); setChecked('denyContainers', r.denyOpeningPlayerContainers); setChecked('denyTaking', r.denyTakingPlayerItems); setChecked('wildernessOnly', r.wildernessDevelopmentOnly); setChecked('allowSelfDefense', r.allowSelfDefense); setNumber('selfDefenseWindow', r.selfDefenseWindowMs); setChecked('stopDefense', r.stopSelfDefenseWhenThreatEnds); setChecked('allowOrderedPvp', r.allowPlayerOrderedPvp); setChecked('allowUnknownDestruction', r.allowDestructiveActionsWhenOwnershipUnknown); setChecked('policyProactive', r.proactiveChat.enabled); setChecked('avoidSecrets', r.proactiveChat.avoidSecrets); setChecked('avoidSpam', r.proactiveChat.avoidSpam)
  set('modsSource', snapshot.mods.sourceDirectory); setChecked('syncOnStart', snapshot.mods.syncOnClientStart); set('excludePatterns', snapshot.mods.excludeFilePatterns.join('\n'))
  renderStatus(snapshot)
  renderPlayerProfiles(snapshot)
  setDirty(false)
}

function collect() {
  const c = structuredClone(state.config)
  const username = value('serverUsername').trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('Bot 游戏名只能使用 3-16 位英文字母、数字或下划线')
  Object.assign(c.server, { connectionMode: value('connectionMode'), adapter: value('serverAdapter'), host: value('serverHost').trim(), port: number('serverPort'), lanDiscoveryTimeoutMs: number('lanDiscoveryTimeout'), version: value('serverVersion').trim(), username, auth: value('serverAuth'), connectTimeoutMs: number('connectTimeout'), reconnectDelayMs: number('reconnectDelay'), autoRespawn: checked('autoRespawn'), respawnDelayMs: number('respawnDelay'), bridgeHost: value('bridgeHost').trim(), bridgePort: number('bridgePort'), actionTimeoutMs: number('actionTimeout') })
  Object.assign(c.easyAuth, { enabled: checked('easyAuthEnabled'), registerIfNeeded: checked('registerIfNeeded'), passwordEnv: value('passwordEnv').trim(), loginDelayMs: number('loginDelay') })
  Object.assign(c.model, { provider: value('modelProvider'), model: value('modelName').trim(), apiKeyEnv: value('apiKeyEnv').trim(), baseUrl: value('modelBaseUrl').trim(), reasoningEffort: value('reasoningEffort'), timeoutMs: number('modelTimeout'), maxOutputTokens: number('maxOutputTokens'), agentMaxSteps: number('agentMaxSteps'), autonomousAgentMaxSteps: number('autonomousAgentMaxSteps'), agentMaxApiCalls: number('agentMaxApiCalls'), agentMaxTaskTokens: number('agentMaxTaskTokens'), agentMaxInputTokensPerCall: number('agentMaxInputTokensPerCall'), agentMaxOutputTokens: number('agentMaxOutputTokens'), agentFollowupReasoningEffort: value('agentFollowupReasoningEffort'), multimodal: { autoDetect: checked('multimodalAutoDetect'), visionEnabled: checked('visionEnabled'), audioEnabled: checked('audioEnabled'), onlineResearchEnabled: checked('onlineResearchEnabled'), sensoryDirectory: value('sensoryDirectory').trim() } })
  c.speech = {
    enabled: checked('speechEnabled'), provider: value('speechProvider'), protocol: value('speechProtocol'), model: value('speechModel').trim(), apiKeyEnv: value('speechApiKeyEnv').trim(), baseUrl: value('speechBaseUrl').trim(), voice: value('speechVoice').trim(), style: value('speechStyle').trim(),
    speed: number('speechSpeed'), volume: number('speechVolume'), sampleRate: number('speechSampleRate'), timeoutMs: number('speechTimeout'), maxTextChars: number('speechMaxTextChars'), maxAudioSeconds: number('speechMaxAudioSeconds'), queueLimit: number('speechQueueLimit'), cacheEntries: number('speechCacheEntries'),
    volcengineAppIdEnv: value('speechVolcAppIdEnv').trim(), volcengineCluster: value('speechVolcCluster').trim(), customAuthHeader: value('speechCustomAuthHeader').trim(), customAuthScheme: value('speechCustomAuthScheme').trim(), customAudioJsonPath: value('speechCustomAudioJsonPath').trim()
  }
  Object.assign(c.chat, { requireMention: checked('requireMention'), replyPrefix: value('replyPrefix'), cooldownMs: number('cooldownMs'), proactiveEnabled: checked('proactiveEnabled'), proactiveIdleMs: number('proactiveIdleMs'), proactiveMinIntervalMs: number('proactiveMinIntervalMs') })
  const ownerName = value('ownerName').trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(ownerName)) throw new Error('最高优先玩家名只能使用 3-16 位英文字母、数字或下划线')
  const lowHealthThreshold = number('lowHealthThreshold')
  const criticalHealthThreshold = number('criticalHealthThreshold')
  if (criticalHealthThreshold > lowHealthThreshold) throw new Error('危险生命阈值不能高于低生命阈值')
  c.autonomy = {
    enabled: checked('autonomyEnabled'), ownerName, commandArbitrationMs: number('commandArbitrationMs'), contextualAddressing: checked('contextualAddressing'), directAddressDistance: number('directAddressDistance'), conversationWindowMs: number('conversationWindowMs'),
    lowHealthThreshold, criticalHealthThreshold, eatBelowFood: number('eatBelowFood'), hostileScanRadius: number('hostileScanRadius'), wildernessMinPlayerDistance: number('wildernessMinPlayerDistance'),
    safeIdleEnabled: checked('safeIdleEnabled'), autoInviteNearbyPlayers: checked('autoInviteNearbyPlayers'), inviteRadius: number('inviteRadius'), inviteCooldownMs: number('inviteCooldownMs'), discardWornTools: checked('discardWornTools'), wornToolRemainingDurability: number('wornToolRemainingDurability'), autoGather: checked('autoGather'), autoCraft: checked('autoCraft'), autoBuildShelter: checked('autoBuildShelter'),
    autoHunt: checked('autoHunt'), autoSmelt: checked('autoSmelt'), autoMine: checked('autoMine'), autoTrade: checked('autoTrade'), autoEnchant: checked('autoEnchant'),
    autoDimensionTravel: checked('autoDimensionTravel'), autoSleep: checked('autoSleep'), protectOwner: checked('protectOwner'), allowVerifiedWilderness: checked('allowVerifiedWilderness'), allowTeleportCommand: checked('allowTeleportCommand'),
    firstHome: { enabled: checked('firstHomeEnabled'), dimension: value('firstHomeDimension'), x: number('firstHomeX'), y: number('firstHomeY'), z: number('firstHomeZ'), radius: number('firstHomeRadius') }
  }
  c.agentWorkspace = {
    promptDirectory: value('promptDirectory').trim(), playerProfilesDirectory: value('playerProfilesDirectory').trim(), contextBudgetChars: number('contextBudgetChars'), compressionTriggerRatio: number('compressionTriggerRatio'), retainRecentEvents: number('retainRecentEvents'),
    selfImprovement: { enabled: checked('selfImprovementEnabled'), allowPromptEdits: checked('allowPromptEdits'), allowBehaviorPatches: checked('allowBehaviorPatches'), minimumRepeatedFailures: number('minimumRepeatedFailures'), researchProvider: value('researchProvider'), researchEndpoint: value('researchEndpoint').trim(), researchTimeoutMs: number('researchTimeoutMs') }
  }
  Object.assign(c.storage, { memoryFile: value('memoryFile').trim(), experienceFile: value('experienceFile').trim(), taskFile: value('taskFile').trim(), autonomyFile: value('autonomyFile').trim(), progressionFile: value('progressionFile').trim(), ownedBlocksFile: value('ownedBlocksFile').trim(), maxEvents: number('maxEvents') })
  Object.assign(c.logging, { file: value('logFile').trim(), level: value('logLevel'), console: checked('logConsole') })
  const persona = { name: value('personaName').trim(), description: value('personaDescription').trim(), speakingStyle: value('speakingStyle').trim(), goals: lines('personaGoals'), boundaries: lines('personaBoundaries') }
  const prompts = { identity: value('promptIdentity'), capabilityRules: lines('promptCapabilities'), memoryRules: lines('promptMemory'), actionContract: value('promptContract'), proactiveInstruction: value('promptProactive') }
  const agentPrompts = { 'rules.md': value('agentRules'), 'IDENTITY.md': value('agentIdentity'), 'SOUL.md': value('agentSoul'), 'TOOLS.md': value('agentTools'), 'MEMORY.md': value('agentMemory') }
  const skin = structuredClone(state.skin); delete skin.imported; delete skin.imageUrl
  Object.assign(skin, { enabled: checked('skinEnabled'), model: value('skinModel'), visibilityMode: value('skinVisibility'), onlineProvider: { name: value('skinProviderName').trim(), profileName: value('skinProfileName').trim(), website: value('skinProviderWebsite').trim() } })
  const rules = { version: 1, denyBreakingPlayerProperty: checked('denyBreaking'), denyOpeningPlayerContainers: checked('denyContainers'), denyTakingPlayerItems: checked('denyTaking'), wildernessDevelopmentOnly: checked('wildernessOnly'), allowSelfDefense: checked('allowSelfDefense'), selfDefenseWindowMs: number('selfDefenseWindow'), stopSelfDefenseWhenThreatEnds: checked('stopDefense'), allowPlayerOrderedPvp: checked('allowOrderedPvp'), allowDestructiveActionsWhenOwnershipUnknown: checked('allowUnknownDestruction'), proactiveChat: { enabled: checked('policyProactive'), avoidSecrets: checked('avoidSecrets'), avoidSpam: checked('avoidSpam') } }
  const mods = { sourceDirectory: value('modsSource').trim(), syncOnClientStart: checked('syncOnStart'), excludeFilePatterns: lines('excludePatterns') }
  return { config: c, persona, prompts, agentPrompts, skin, rules, mods }
}

async function load() {
  try { populate(await request('/api/snapshot')) } catch (error) { toast(error.message, true) }
}

async function save() {
  try {
    $('saveButton').disabled = true
    await request('/api/settings', { method: 'PUT', body: JSON.stringify(collect()) })
    toast('全部设置已安全保存')
    await load()
  } catch (error) { toast(error.message, true) } finally { $('saveButton').disabled = false }
}

async function savePlayerProfile() {
  const id = value('playerProfileSelect')
  if (!id) return toast('当前没有可保存的玩家画像', true)
  try {
    const result = await request('/api/player-profile', { method: 'PUT', body: JSON.stringify({ id, content: value('playerProfileContent') }) })
    const existing = (state.playerProfiles || []).findIndex(profile => profile.id === id)
    if (existing >= 0) state.playerProfiles[existing] = result.profile
    toast('当前玩家 USER.md 已保存')
  } catch (error) { toast(error.message, true) }
}

async function saveSecrets() {
  try {
    const secrets = { MINECRAFT_LOGIN_PASSWORD: value('minecraftPassword'), DEEPSEEK_API_KEY: value('deepseekKey'), ARK_API_KEY: value('arkKey'), OPENAI_API_KEY: value('openaiKey'), MIMO_API_KEY: value('mimoKey'), VOLCENGINE_TTS_APP_ID: value('volcTtsAppId'), VOLCENGINE_TTS_ACCESS_TOKEN: value('volcTtsToken'), CUSTOM_TTS_API_KEY: value('customTtsKey') }
    await request('/api/secrets', { method: 'PUT', body: JSON.stringify(secrets) })
    for (const id of ['minecraftPassword', 'deepseekKey', 'arkKey', 'openaiKey', 'mimoKey', 'volcTtsAppId', 'volcTtsToken', 'customTtsKey']) set(id, '')
    toast('密钥已保存到本机 .env，不会在页面中回显')
    await refreshStatus()
  } catch (error) { toast(error.message, true) }
}

async function clearSecrets() {
  if (!confirm('确定清空本机 .env 中全部模型密钥和 EasyAuth 密码？此操作不能撤销。')) return
  try {
    await request('/api/secrets', { method: 'DELETE', body: '{}' })
    toast('本机密钥已全部清空')
    await refreshStatus()
  } catch (error) { toast(error.message, true) }
}

async function discoverLan() {
  try {
    $('lanResult').textContent = '正在监听 Minecraft 局域网广播…'
    const result = await request('/api/lan/discover', { method: 'POST', body: '{}' })
    const server = result.servers[0]
    if (!server) { $('lanResult').textContent = '没有发现世界：请先“对局域网开放”，并检查防火墙/VPN'; return }
    set('connectionMode', 'lan'); set('serverHost', server.host); setNumber('serverPort', server.port); set('serverAuth', 'offline'); setDirty(true)
    $('lanResult').textContent = `${server.motd} · ${server.host}:${server.port}`
  } catch (error) { $('lanResult').textContent = ''; toast(error.message, true) }
}

async function importSkin() {
  const file = $('skinFileInput').files[0]
  if (!file) return toast('请先选择一个 64x64 或 64x32 PNG', true)
  try {
    const dataUrl = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file) })
    const result = await request('/api/skin/import', { method: 'POST', body: JSON.stringify({ dataUrl, model: value('skinModel') }) })
    toast(`皮肤已校验并导入（${result.skin.width}x${result.skin.height}）`)
    await load()
  } catch (error) { toast(error.message, true) }
}

async function buildSkinPack() {
  try {
    if (dirty) await save()
    await request('/api/skin/pack', { method: 'POST', body: '{}' })
    $('skinPackResult').textContent = '.runtime\\skin-pack\\Minecraft-AI-Skin-Pack.zip'
    toast('皮肤包已生成；每位需要看见 Bot 皮肤的玩家安装一次')
  } catch (error) { toast(error.message, true) }
}

async function action(url, success) {
  try {
    document.querySelectorAll('.runtime-actions button').forEach(button => { button.disabled = true })
    await request(url, { method: 'POST', body: '{}' })
    toast(success)
    await new Promise(resolve => setTimeout(resolve, 700))
    await refreshStatus()
  } catch (error) { toast(error.message, true) } finally { document.querySelectorAll('.runtime-actions button').forEach(button => { button.disabled = false }) }
}

async function refreshStatus() {
  try { const next = await request('/api/snapshot'); state.runtime = next.runtime; state.manifest = next.manifest; state.live = next.live; state.secrets = next.secrets; state.logs = next.logs; state.memory = next.memory; state.tasks = next.tasks; state.progression = next.progression; state.diagnostics = next.diagnostics; renderStatus({ ...state, ...next }) } catch (error) { toast(error.message, true) }
}

async function refreshCentralChat() {
  try {
    const next = await request('/api/diagnostics')
    state.memory = next.memory
    state.tasks = next.tasks
    state.diagnostics = next.diagnostics
    renderCentralChat(state)
  } catch (error) { toast(error.message, true) }
}

async function sendAdminCommand(event) {
  event.preventDefault()
  const message = value('adminCommandInput').trim()
  if (!message) return toast('请先填写管理指令', true)
  const button = $('sendAdminCommandButton')
  button.disabled = true
  try {
    await request('/api/admin/command', { method: 'POST', body: JSON.stringify({ message }) })
    set('adminCommandInput', '')
    toast('最高权限指令已提交，正在抢占并执行当前任务')
    await refreshCentralChat()
  } catch (error) { toast(error.message, true) }
  finally { button.disabled = false }
}

$('saveButton').addEventListener('click', save)
$('reloadButton').addEventListener('click', () => { if (!dirty || confirm('放弃尚未保存的修改？')) load() })
$('saveSecretsButton').addEventListener('click', saveSecrets)
$('savePlayerProfileButton').addEventListener('click', savePlayerProfile)
$('playerProfileSelect').addEventListener('change', () => set('playerProfileContent', (state.playerProfiles || []).find(profile => profile.id === value('playerProfileSelect'))?.content || ''))
$('clearSecretsButton').addEventListener('click', clearSecrets)
$('discoverLanButton').addEventListener('click', discoverLan)
$('importSkinButton').addEventListener('click', importSkin)
$('buildSkinPackButton').addEventListener('click', buildSkinPack)
$('startButton').addEventListener('click', () => action('/api/runtime/start', 'Bot 已在后台启动'))
$('testStartButton').addEventListener('click', () => action('/api/runtime/test-start', '测试模式已启动，玩家监听不会自动将其下线'))
$('stopButton').addEventListener('click', () => action('/api/runtime/stop', 'Bot 已停止'))
$('restartButton').addEventListener('click', () => action('/api/runtime/restart', 'Bot 已重新启动'))
$('syncModsButton').addEventListener('click', async () => { try { if (dirty) await save(); await request('/api/mods/sync', { method: 'POST', body: '{}' }); toast('服务器模组同步完成'); await load() } catch (error) { toast(error.message, true) } })
$('importModsButton').addEventListener('click', () => $('modsFileInput').click())
$('modsFileInput').addEventListener('change', async () => {
  const input = $('modsFileInput')
  const files = [...input.files]
  if (!files.length) return
  try {
    const payload = { files: await Promise.all(files.map(file => new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => { const dataUrl = String(reader.result); resolve({ name: file.name, dataBase64: dataUrl.includes(',') ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl }) }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    }))) }
    const result = await request('/api/mods/import', { method: 'POST', body: JSON.stringify(payload) })
    toast(`已导入 ${result.imported.length} 个 Mod`)
    input.value = ''
    await load()
  } catch (error) { toast(error.message, true) }
})
$('testModelButton').addEventListener('click', async () => { try { $('modelTestResult').textContent = '正在进行一次最小请求…'; const result = await request('/api/model/test', { method: 'POST', body: '{}' }); $('modelTestResult').textContent = `${result.model} · ${result.elapsedMs}ms · ${result.effectiveEffort} · ${result.usage?.totalTokens ?? '未返回'} Token · 视觉${result.capabilities?.vision ? '开' : '关'}/语音${result.capabilities?.audio ? '开' : '关'}/搜索${result.capabilities?.webSearch ? '开' : '关'}`; toast('模型接口测试成功') } catch (error) { $('modelTestResult').textContent = ''; toast(error.message, true) } })
$('refreshLogsButton').addEventListener('click', refreshStatus)
$('refreshCentralChatButton').addEventListener('click', refreshCentralChat)
$('centralChatFilter').addEventListener('change', () => renderCentralChat(state))
$('adminCommandForm').addEventListener('submit', sendAdminCommand)
$('modelProvider').addEventListener('change', () => {
  const presets = {
    deepseek: { model: 'deepseek-v4-flash', key: 'DEEPSEEK_API_KEY', url: 'https://api.deepseek.com' },
    volcengine: { model: 'doubao-seed-2.1-pro', key: 'ARK_API_KEY', url: 'https://ark.cn-beijing.volces.com/api/v3' },
    openai: { model: 'gpt-5.6-sol', key: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1' },
    mimo: { model: 'mimo-v2.5', key: 'MIMO_API_KEY', url: 'https://api.xiaomimimo.com/v1' }
  }
  const preset = presets[value('modelProvider')]
  if (!preset) return
  set('modelName', preset.model); set('apiKeyEnv', preset.key); set('modelBaseUrl', preset.url); setDirty(true)
})
$('speechProvider').addEventListener('change', () => {
  const presets = {
    volcengine: { protocol: 'volcengine_v1', model: 'volcano_tts', key: 'VOLCENGINE_TTS_ACCESS_TOKEN', url: 'https://openspeech.bytedance.com/api/v1/tts', voice: 'BV001_streaming', sampleRate: 24000 },
    openai: { protocol: 'openai_speech', model: 'gpt-4o-mini-tts', key: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1', voice: 'alloy', sampleRate: 24000 },
    mimo: { protocol: 'mimo_chat_audio', model: 'mimo-v2.5-tts', key: 'MIMO_API_KEY', url: 'https://api.xiaomimimo.com/v1', voice: '冰糖', sampleRate: 24000 },
    multimodal: { protocol: 'openai_chat_audio', model: 'gpt-audio-1.5', key: 'OPENAI_API_KEY', url: 'https://api.openai.com/v1', voice: 'alloy', sampleRate: 24000 },
    custom: { protocol: 'custom_binary', model: 'custom-tts', key: 'CUSTOM_TTS_API_KEY', url: 'http://127.0.0.1:8080/v1/tts', voice: 'default', sampleRate: 24000 }
  }
  const preset = presets[value('speechProvider')]
  if (!preset) return
  set('speechProtocol', preset.protocol); set('speechModel', preset.model); set('speechApiKeyEnv', preset.key); set('speechBaseUrl', preset.url); set('speechVoice', preset.voice); set('speechSampleRate', String(preset.sampleRate)); setDirty(true)
})
document.querySelectorAll('input:not(.ui-only), select:not(.ui-only), textarea:not(.ui-only)').forEach(control => control.addEventListener('input', () => setDirty(true)))
document.querySelectorAll('.sidebar a').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.sidebar a').forEach(item => item.classList.remove('active')); link.classList.add('active') }))
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })

load()
setInterval(() => { if (!dirty) refreshStatus() }, 10000)
setInterval(() => { if (checked('centralChatAuto')) refreshCentralChat() }, 4000)
