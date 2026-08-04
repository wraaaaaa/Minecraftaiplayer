let state
let dirty = false

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
  $('modsSummary').textContent = snapshot.manifest.sourceDirectory ? `来源：${snapshot.manifest.sourceDirectory}` : '尚未设置模组来源'
  $('modList').replaceChildren(...mods.map(mod => {
    const item = document.createElement('div')
    item.className = 'mod-item'
    const name = document.createElement('span')
    name.textContent = mod.name
    const size = document.createElement('span')
    size.textContent = `${(mod.size / 1024 / 1024).toFixed(2)} MB`
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
  $('skinState').textContent = snapshot.skin.imported ? `已导入：${snapshot.skin.skinFile}` : '尚未导入标准皮肤 PNG'
  $('skinPreview').src = snapshot.skin.imageUrl ? `${snapshot.skin.imageUrl}?t=${Date.now()}` : ''
  $('skinPreview').hidden = !snapshot.skin.imageUrl
}

function populate(snapshot) {
  state = snapshot
  const c = snapshot.config
  set('connectionMode', c.server.connectionMode); set('serverAdapter', c.server.adapter); set('serverHost', c.server.host); setNumber('serverPort', c.server.port); setNumber('lanDiscoveryTimeout', c.server.lanDiscoveryTimeoutMs)
  set('serverVersion', c.server.version); set('serverUsername', c.server.username); set('serverAuth', c.server.auth)
  setNumber('connectTimeout', c.server.connectTimeoutMs); setNumber('reconnectDelay', c.server.reconnectDelayMs); setNumber('actionTimeout', c.server.actionTimeoutMs)
  set('bridgeHost', c.server.bridgeHost); setNumber('bridgePort', c.server.bridgePort)
  setChecked('easyAuthEnabled', c.easyAuth.enabled); setChecked('registerIfNeeded', c.easyAuth.registerIfNeeded); set('passwordEnv', c.easyAuth.passwordEnv); setNumber('loginDelay', c.easyAuth.loginDelayMs)
  set('modelProvider', c.model.provider); set('modelName', c.model.model); set('apiKeyEnv', c.model.apiKeyEnv); set('modelBaseUrl', c.model.baseUrl); set('reasoningEffort', c.model.reasoningEffort); setNumber('modelTimeout', c.model.timeoutMs)
  setChecked('requireMention', c.chat.requireMention); set('replyPrefix', c.chat.replyPrefix); setNumber('cooldownMs', c.chat.cooldownMs); setChecked('proactiveEnabled', c.chat.proactiveEnabled); setNumber('proactiveIdleMs', c.chat.proactiveIdleMs); setNumber('proactiveMinIntervalMs', c.chat.proactiveMinIntervalMs)
  set('memoryFile', c.storage.memoryFile); set('experienceFile', c.storage.experienceFile); setNumber('maxEvents', c.storage.maxEvents); set('logFile', c.logging.file); set('logLevel', c.logging.level); setChecked('logConsole', c.logging.console)
  set('personaName', snapshot.persona.name); set('personaDescription', snapshot.persona.description); set('speakingStyle', snapshot.persona.speakingStyle); set('personaGoals', snapshot.persona.goals.join('\n')); set('personaBoundaries', snapshot.persona.boundaries.join('\n'))
  set('promptIdentity', snapshot.prompts.identity); set('promptCapabilities', snapshot.prompts.capabilityRules.join('\n')); set('promptMemory', snapshot.prompts.memoryRules.join('\n')); set('promptContract', snapshot.prompts.actionContract); set('promptProactive', snapshot.prompts.proactiveInstruction)
  setChecked('skinEnabled', snapshot.skin.enabled); set('skinModel', snapshot.skin.model); set('skinVisibility', snapshot.skin.visibilityMode); set('skinProviderName', snapshot.skin.onlineProvider.name); set('skinProfileName', snapshot.skin.onlineProvider.profileName); set('skinProviderWebsite', snapshot.skin.onlineProvider.website)
  const r = snapshot.rules
  setChecked('denyBreaking', r.denyBreakingPlayerProperty); setChecked('denyContainers', r.denyOpeningPlayerContainers); setChecked('denyTaking', r.denyTakingPlayerItems); setChecked('wildernessOnly', r.wildernessDevelopmentOnly); setChecked('allowSelfDefense', r.allowSelfDefense); setNumber('selfDefenseWindow', r.selfDefenseWindowMs); setChecked('stopDefense', r.stopSelfDefenseWhenThreatEnds); setChecked('allowOrderedPvp', r.allowPlayerOrderedPvp); setChecked('allowUnknownDestruction', r.allowDestructiveActionsWhenOwnershipUnknown); setChecked('policyProactive', r.proactiveChat.enabled); setChecked('avoidSecrets', r.proactiveChat.avoidSecrets); setChecked('avoidSpam', r.proactiveChat.avoidSpam)
  set('modsSource', snapshot.mods.sourceDirectory); setChecked('syncOnStart', snapshot.mods.syncOnClientStart); set('excludePatterns', snapshot.mods.excludeFilePatterns.join('\n'))
  renderStatus(snapshot)
  setDirty(false)
}

function collect() {
  const c = structuredClone(state.config)
  const username = value('serverUsername').trim()
  if (!/^[A-Za-z0-9_]{3,16}$/.test(username)) throw new Error('Bot 游戏名只能使用 3-16 位英文字母、数字或下划线')
  Object.assign(c.server, { connectionMode: value('connectionMode'), adapter: value('serverAdapter'), host: value('serverHost').trim(), port: number('serverPort'), lanDiscoveryTimeoutMs: number('lanDiscoveryTimeout'), version: value('serverVersion').trim(), username, auth: value('serverAuth'), connectTimeoutMs: number('connectTimeout'), reconnectDelayMs: number('reconnectDelay'), bridgeHost: value('bridgeHost').trim(), bridgePort: number('bridgePort'), actionTimeoutMs: number('actionTimeout') })
  Object.assign(c.easyAuth, { enabled: checked('easyAuthEnabled'), registerIfNeeded: checked('registerIfNeeded'), passwordEnv: value('passwordEnv').trim(), loginDelayMs: number('loginDelay') })
  Object.assign(c.model, { provider: value('modelProvider'), model: value('modelName').trim(), apiKeyEnv: value('apiKeyEnv').trim(), baseUrl: value('modelBaseUrl').trim(), reasoningEffort: value('reasoningEffort'), timeoutMs: number('modelTimeout') })
  Object.assign(c.chat, { requireMention: checked('requireMention'), replyPrefix: value('replyPrefix'), cooldownMs: number('cooldownMs'), proactiveEnabled: checked('proactiveEnabled'), proactiveIdleMs: number('proactiveIdleMs'), proactiveMinIntervalMs: number('proactiveMinIntervalMs') })
  Object.assign(c.storage, { memoryFile: value('memoryFile').trim(), experienceFile: value('experienceFile').trim(), maxEvents: number('maxEvents') })
  Object.assign(c.logging, { file: value('logFile').trim(), level: value('logLevel'), console: checked('logConsole') })
  const persona = { name: value('personaName').trim(), description: value('personaDescription').trim(), speakingStyle: value('speakingStyle').trim(), goals: lines('personaGoals'), boundaries: lines('personaBoundaries') }
  const prompts = { identity: value('promptIdentity'), capabilityRules: lines('promptCapabilities'), memoryRules: lines('promptMemory'), actionContract: value('promptContract'), proactiveInstruction: value('promptProactive') }
  const skin = structuredClone(state.skin); delete skin.imported; delete skin.imageUrl
  Object.assign(skin, { enabled: checked('skinEnabled'), model: value('skinModel'), visibilityMode: value('skinVisibility'), onlineProvider: { name: value('skinProviderName').trim(), profileName: value('skinProfileName').trim(), website: value('skinProviderWebsite').trim() } })
  const rules = { version: 1, denyBreakingPlayerProperty: checked('denyBreaking'), denyOpeningPlayerContainers: checked('denyContainers'), denyTakingPlayerItems: checked('denyTaking'), wildernessDevelopmentOnly: checked('wildernessOnly'), allowSelfDefense: checked('allowSelfDefense'), selfDefenseWindowMs: number('selfDefenseWindow'), stopSelfDefenseWhenThreatEnds: checked('stopDefense'), allowPlayerOrderedPvp: checked('allowOrderedPvp'), allowDestructiveActionsWhenOwnershipUnknown: checked('allowUnknownDestruction'), proactiveChat: { enabled: checked('policyProactive'), avoidSecrets: checked('avoidSecrets'), avoidSpam: checked('avoidSpam') } }
  const mods = { sourceDirectory: value('modsSource').trim(), syncOnClientStart: checked('syncOnStart'), excludeFilePatterns: lines('excludePatterns') }
  return { config: c, persona, prompts, skin, rules, mods }
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

async function saveSecrets() {
  try {
    const secrets = { MINECRAFT_LOGIN_PASSWORD: value('minecraftPassword'), DEEPSEEK_API_KEY: value('deepseekKey'), ARK_API_KEY: value('arkKey'), OPENAI_API_KEY: value('openaiKey') }
    await request('/api/secrets', { method: 'PUT', body: JSON.stringify(secrets) })
    for (const id of ['minecraftPassword', 'deepseekKey', 'arkKey', 'openaiKey']) set(id, '')
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
  try { const next = await request('/api/snapshot'); state.runtime = next.runtime; state.manifest = next.manifest; state.live = next.live; state.secrets = next.secrets; state.logs = next.logs; renderStatus({ ...state, ...next }) } catch (error) { toast(error.message, true) }
}

$('saveButton').addEventListener('click', save)
$('reloadButton').addEventListener('click', () => { if (!dirty || confirm('放弃尚未保存的修改？')) load() })
$('saveSecretsButton').addEventListener('click', saveSecrets)
$('clearSecretsButton').addEventListener('click', clearSecrets)
$('discoverLanButton').addEventListener('click', discoverLan)
$('importSkinButton').addEventListener('click', importSkin)
$('buildSkinPackButton').addEventListener('click', buildSkinPack)
$('startButton').addEventListener('click', () => action('/api/runtime/start', 'Bot 已在后台启动'))
$('stopButton').addEventListener('click', () => action('/api/runtime/stop', 'Bot 已停止'))
$('restartButton').addEventListener('click', () => action('/api/runtime/restart', 'Bot 已重新启动'))
$('syncModsButton').addEventListener('click', async () => { try { if (dirty) await save(); await request('/api/mods/sync', { method: 'POST', body: '{}' }); toast('服务器模组同步完成'); await load() } catch (error) { toast(error.message, true) } })
$('testModelButton').addEventListener('click', async () => { try { $('modelTestResult').textContent = '正在进行一次最小请求…'; const result = await request('/api/model/test', { method: 'POST', body: '{}' }); $('modelTestResult').textContent = `${result.model} · ${result.elapsedMs}ms · ${result.effectiveEffort}`; toast('模型接口测试成功') } catch (error) { $('modelTestResult').textContent = ''; toast(error.message, true) } })
$('refreshLogsButton').addEventListener('click', refreshStatus)
document.querySelectorAll('input, select, textarea').forEach(control => control.addEventListener('input', () => setDirty(true)))
document.querySelectorAll('.sidebar a').forEach(link => link.addEventListener('click', () => { document.querySelectorAll('.sidebar a').forEach(item => item.classList.remove('active')); link.classList.add('active') }))
window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })

load()
setInterval(() => { if (!dirty) refreshStatus() }, 10000)
