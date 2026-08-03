import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'

const root = process.cwd()
const packageRoot = path.join(root, 'node_modules', 'minecraft-data')
const dataRoot = path.join(packageRoot, 'minecraft-data', 'data')
const sourceRoot = path.join(root, 'vendor', 'minecraft-data', '26.2')
const targetRoot = path.join(dataRoot, 'pc', '26.2')

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')) }
async function writeJson(file, value) { await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8') }

await mkdir(targetRoot, { recursive: true })
await copyFile(path.join(sourceRoot, 'protocol.json'), path.join(targetRoot, 'protocol.json'))
await copyFile(path.join(sourceRoot, 'version.json'), path.join(targetRoot, 'version.json'))

const dataPathsFile = path.join(dataRoot, 'dataPaths.json')
const dataPaths = await readJson(dataPathsFile)
dataPaths.pc['26.2'] = {
  attributes: 'pc/1.21.11',
  blockCollisionShapes: 'pc/1.21.11',
  blocks: 'pc/1.21.11',
  blockLoot: 'pc/1.20',
  biomes: 'pc/1.21.11',
  commands: 'pc/1.20.3',
  effects: 'pc/1.21.11',
  enchantments: 'pc/1.21.11',
  entities: 'pc/1.21.11',
  entityLoot: 'pc/1.20',
  foods: 'pc/1.21.11',
  instruments: 'pc/1.21.11',
  items: 'pc/1.21.11',
  language: 'pc/1.21.11',
  loginPacket: 'pc/1.21.11',
  mapIcons: 'pc/1.20.2',
  materials: 'pc/1.21.11',
  particles: 'pc/1.21.11',
  protocol: 'pc/26.2',
  recipes: 'pc/1.21.11',
  sounds: 'pc/1.21.11',
  tints: 'pc/1.21.11',
  version: 'pc/26.2',
  windows: 'pc/1.16.1',
  proto: 'pc/latest'
}
await writeJson(dataPathsFile, dataPaths)

const versionsFile = path.join(dataRoot, 'pc', 'common', 'versions.json')
const versions = await readJson(versionsFile)
if (!versions.includes('26.2')) versions.push('26.2')
await writeJson(versionsFile, versions)

const generator = spawnSync(process.execPath, [path.join(packageRoot, 'bin', 'generate_data.js')], { cwd: packageRoot, stdio: 'inherit' })
if (generator.status !== 0) throw new Error('生成 minecraft-data data.js 失败')

async function addSupportedVersion(file, marker) {
  let source = await readFile(file, 'utf8')
  const start = source.indexOf(marker)
  const end = source.indexOf(']', start + marker.length)
  if (start < 0 || end < 0) throw new Error(`无法在 ${file} 中定位版本数组`)
  const bodyStart = start + marker.length
  const body = source.slice(bodyStart, end).replace(/\s*'26\.2'\s*,?/gu, '').trimEnd().replace(/,\s*$/u, '')
  source = `${source.slice(0, bodyStart)}${body}, '26.2'${source.slice(end)}`
  await writeFile(file, source, 'utf8')
}

await addSupportedVersion(path.join(root, 'node_modules', 'minecraft-protocol', 'src', 'version.js'), 'supportedVersions: [')
await addSupportedVersion(path.join(root, 'node_modules', 'mineflayer', 'lib', 'version.js'), 'const testedVersions = [')

const chunkIndexFile = path.join(root, 'node_modules', 'prismarine-chunk', 'src', 'index.js')
let chunkIndex = await readFile(chunkIndexFile, 'utf8')
if (!chunkIndex.includes('26.2:')) {
  chunkIndex = chunkIndex.replace("    26.1: require('./pc/1.18/chunk')", "    26.1: require('./pc/1.18/chunk'),\n    26.2: require('./pc/1.18/chunk')")
  await writeFile(chunkIndexFile, chunkIndex, 'utf8')
}

const physicsFeaturesFile = path.join(root, 'node_modules', 'prismarine-physics', 'lib', 'features.json')
const physicsFeatures = await readJson(physicsFeaturesFile)
for (const feature of physicsFeatures) {
  if (Array.isArray(feature.versions) && feature.versions.includes('26.1') && !feature.versions.includes('26.2')) feature.versions.push('26.2')
}
await writeJson(physicsFeaturesFile, physicsFeatures)
console.log('Applied audited Minecraft 26.2 protocol data patch (PrismarineJS e492093).')
