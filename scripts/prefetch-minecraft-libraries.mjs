import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const minecraftVersion = process.env.MCAI_MINECRAFT_VERSION?.trim() || '26.2'
const platformName = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
const architecture = process.arch === 'ia32' ? '32' : '64'
const minecraftHome = process.env.MCAI_MINECRAFT_HOME?.trim() || (process.platform === 'win32'
  ? path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), '.minecraft')
  : path.join(os.homedir(), '.minecraft'))
const mirrorBase = (process.env.MCAI_MINECRAFT_LIBRARY_MIRROR?.trim() || 'https://mirrors.cernet.edu.cn/bmclapi').replace(/\/+$/u, '')
const metadataBase = (process.env.MCAI_BMCLAPI_BASE?.trim() || 'https://bmclapi2.bangbang93.com').replace(/\/+$/u, '')

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

function matchesOs(rule) {
  if (!rule.os) return true
  if (rule.os.name && rule.os.name !== platformName) return false
  if (rule.os.arch && !new RegExp(rule.os.arch, 'u').test(process.arch)) return false
  if (rule.os.version && !new RegExp(rule.os.version, 'u').test(os.release())) return false
  return true
}

function isAllowed(library) {
  if (!Array.isArray(library.rules) || library.rules.length === 0) return true
  let allowed = false
  for (const rule of library.rules) {
    if (matchesOs(rule)) allowed = rule.action === 'allow'
  }
  return allowed
}

function sha1(buffer) { return createHash('sha1').update(buffer).digest('hex') }

async function validExisting(file, expectedSha1) {
  if (!(await exists(file))) return false
  const content = await readFile(file)
  return sha1(content) === expectedSha1.toLowerCase()
}

async function fetchBuffer(url) {
  let lastError
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    } catch (error) {
      lastError = error
      await new Promise((resolve) => setTimeout(resolve, attempt * 1000))
    }
  }
  throw lastError
}

function downloadEntries(versionJson) {
  const entries = []
  for (const library of versionJson.libraries ?? []) {
    if (!isAllowed(library)) continue
    if (library.downloads?.artifact) entries.push(library.downloads.artifact)
    const nativeTemplate = library.natives?.[platformName]
    if (!nativeTemplate) continue
    const classifier = nativeTemplate.replace('${arch}', architecture)
    const native = library.downloads?.classifiers?.[classifier]
    if (native) entries.push(native)
  }
  return [...new Map(entries.map((entry) => [entry.path, entry])).values()]
}

async function downloadOne(entry) {
  const target = path.join(minecraftHome, 'libraries', ...entry.path.split('/'))
  if (await validExisting(target, entry.sha1)) return { status: 'cached', path: entry.path }
  const url = `${mirrorBase}/${entry.path}`
  const content = await fetchBuffer(url)
  const actualSha1 = sha1(content)
  if (actualSha1 !== entry.sha1.toLowerCase()) throw new Error(`SHA1 mismatch for ${entry.path}: ${actualSha1}`)
  if (typeof entry.size === 'number' && content.length !== entry.size) throw new Error(`Size mismatch for ${entry.path}`)
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.minecraft-ai-download`
  await writeFile(temporary, content)
  await unlink(target).catch(() => undefined)
  try { await rename(temporary, target) } catch (error) {
    await unlink(temporary).catch(() => undefined)
    throw error
  }
  return { status: 'downloaded', path: entry.path }
}

async function downloadClientJar(versionJson) {
  const client = versionJson.downloads?.client
  if (!client?.sha1) throw new Error(`Metadata for ${minecraftVersion} has no client download`)
  const target = path.join(minecraftHome, 'versions', minecraftVersion, `${minecraftVersion}.jar`)
  if (await validExisting(target, client.sha1)) return 'cached'
  const content = await fetchBuffer(`${metadataBase}/version/${encodeURIComponent(minecraftVersion)}/client`)
  const actualSha1 = sha1(content)
  if (actualSha1 !== client.sha1.toLowerCase()) throw new Error(`Client SHA1 mismatch: ${actualSha1}`)
  if (typeof client.size === 'number' && content.length !== client.size) throw new Error('Client size mismatch')
  await mkdir(path.dirname(target), { recursive: true })
  const temporary = `${target}.minecraft-ai-download`
  await writeFile(temporary, content)
  await unlink(target).catch(() => undefined)
  await rename(temporary, target)
  return 'downloaded'
}

const metadataResponse = await fetch(`${metadataBase}/version/${encodeURIComponent(minecraftVersion)}/json`, { signal: AbortSignal.timeout(30000) })
if (!metadataResponse.ok) throw new Error(`Cannot load ${minecraftVersion} metadata: HTTP ${metadataResponse.status}`)
const versionJson = await metadataResponse.json()
const clientJar = await downloadClientJar(versionJson)
const entries = downloadEntries(versionJson)
let cursor = 0
const results = []
const failures = []
const workers = Array.from({ length: Math.min(4, entries.length) }, async () => {
  while (cursor < entries.length) {
    const index = cursor++
    const entry = entries[index]
    try { results.push(await downloadOne(entry)) }
    catch (error) { failures.push({ path: entry.path, error: error instanceof Error ? error.message : String(error) }) }
  }
})
await Promise.all(workers)
const downloaded = results.filter((result) => result.status === 'downloaded').length
const cached = results.filter((result) => result.status === 'cached').length
console.log(JSON.stringify({ minecraftVersion, platform: platformName, minecraftHome, mirrorBase, clientJar, total: entries.length, downloaded, cached, failures }, null, 2))
if (failures.length > 0) process.exitCode = 1
