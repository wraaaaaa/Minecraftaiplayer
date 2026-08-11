import { createHash } from 'node:crypto'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..')
const gameDirectory = path.join(projectRoot, '.runtime', 'minecraft')
const targetDirectory = path.join(gameDirectory, 'mods')
const manifestFile = path.join(gameDirectory, 'managed-mods.json')
const localConfigFile = path.join(projectRoot, 'config', 'mods.json')
const exampleConfigFile = path.join(projectRoot, 'config', 'mods.example.json')

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return fallback }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : undefined
}

async function sha256(file) {
  const data = await readFile(file)
  return createHash('sha256').update(data).digest('hex').toUpperCase()
}

function safeManagedName(name) {
  return path.basename(name) === name && name.toLowerCase().endsWith('.jar')
}

function compatibilityHint(name) {
  const lower = name.toLowerCase()
  if (/(?:^|[-_.])(?:forge|neoforge|paper|spigot|bukkit)(?:[-_.]|$)/u.test(lower)) {
    return { status: 'likely_incompatible_loader', note: '文件名显示它可能不是 Fabric 客户端模组。' }
  }
  if (/(?:server[-_.]?only|dedicated[-_.]?server)/u.test(lower)) {
    return { status: 'likely_server_only', note: '文件名显示它可能只应安装在服务端。' }
  }
  return { status: 'copied_unverified', note: '已复制；最终兼容性由 Fabric 启动时的元数据、依赖和 Mixin 检查决定。' }
}

const configPath = await exists(localConfigFile) ? localConfigFile : exampleConfigFile
const config = await readJson(configPath, { sourceDirectory: '', syncOnClientStart: true, excludeFilePatterns: [] })
const sourceArgument = argument('--source')
const sourceValue = sourceArgument ?? process.env.MCAI_MODS_SOURCE ?? config.sourceDirectory
if (!sourceValue || !String(sourceValue).trim()) {
  console.log(JSON.stringify({ ok: true, skipped: true, reason: 'No mod source directory configured.' }))
  process.exit(0)
}

const sourceDirectory = path.resolve(String(sourceValue))
const sourceInfo = await stat(sourceDirectory).catch(() => null)
if (!sourceInfo?.isDirectory()) throw new Error(`Mod source directory does not exist: ${sourceDirectory}`)

const excludePatterns = (config.excludeFilePatterns ?? []).map(value => new RegExp(String(value), 'iu'))
const allSourceNames = (await readdir(sourceDirectory)).filter(safeManagedName)
const excludedNames = allSourceNames.filter(name => excludePatterns.some(pattern => pattern.test(name)))
const sourceNames = allSourceNames
  .filter(name => !excludedNames.includes(name))
  .sort((left, right) => left.localeCompare(right, 'zh-CN'))

await mkdir(targetDirectory, { recursive: true })
const previous = await readJson(manifestFile, { files: [] })
for (const item of previous.files ?? []) {
  if (!safeManagedName(item.name)) continue
  await rm(path.join(targetDirectory, item.name), { force: true })
}

const files = []
for (const name of sourceNames) {
  const source = path.join(sourceDirectory, name)
  const target = path.join(targetDirectory, name)
  const header = (await readFile(source)).subarray(0, 4)
  if (header.length < 4 || header[0] !== 0x50 || header[1] !== 0x4B) {
    throw new Error(`Invalid JAR/ZIP header: ${name}`)
  }
  await copyFile(source, target)
  files.push({ name, size: (await stat(target)).size, sha256: await sha256(target), compatibility: compatibilityHint(name) })
}

const manifest = {
  schemaVersion: 1,
  sourceDirectory,
  syncedAt: new Date().toISOString(),
  excludedPatterns: config.excludeFilePatterns ?? [],
  compatibilityGuarantee: 'best_effort_copy_and_fabric_runtime_validation',
  compatibilityNotice: '不能保证任意未来模组兼容。客户端/服务端环境、Fabric 版本、Java 版本、依赖、Mixin 和 HeadlessMC 图形需求必须由实际启动验证。',
  files
}
const temporary = `${manifestFile}.tmp`
await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await rename(temporary, manifestFile)
console.log(JSON.stringify({
  ok: true, sourceDirectory, imported: files.length, excluded: excludedNames,
  warnings: files.filter(file => file.compatibility.status !== 'copied_unverified').map(file => ({ name: file.name, ...file.compatibility })),
  notice: manifest.compatibilityNotice
}))
