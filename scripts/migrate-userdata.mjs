import { access, mkdir, readdir, rename } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'

/**
 * One-time migration into the single user-data folder. Older versions scattered personal
 * files across config/, data/ and .env; newer versions read them all from userdata/.
 * This script moves each legacy file only when the userdata copy does not yet exist, so it
 * is safe to run repeatedly. Templates (config/*.example.json, config/agent-prompts.example/)
 * stay in the repository and are never moved.
 */

const projectRoot = path.resolve(import.meta.dirname, '..')
const userDataRoot = path.resolve(process.env.MCAI_USERDATA_DIR?.trim() || path.join(projectRoot, 'userdata'))

const USER_CONFIG_FILES = ['bot.json', 'persona.json', 'prompts.json', 'skin.json', 'behavior-rules.json', 'mods.json']

async function exists(file) {
  try { await access(file); return true } catch { return false }
}

async function moveIfMissing(source, target) {
  if (!(await exists(source))) return { moved: false, reason: 'source_missing' }
  if (await exists(target)) return { moved: false, reason: 'target_exists' }
  await mkdir(path.dirname(target), { recursive: true })
  await rename(source, target)
  return { moved: true, source: path.relative(projectRoot, source), target: path.relative(projectRoot, target) }
}

async function main() {
  await mkdir(userDataRoot, { recursive: true })
  const moved = []
  const skipped = []

  const env = await moveIfMissing(path.join(projectRoot, '.env'), path.join(userDataRoot, '.env'))
  if (env.moved) moved.push(env); else if (env.reason === 'target_exists') skipped.push('.env')

  for (const name of USER_CONFIG_FILES) {
    const result = await moveIfMissing(
      path.join(projectRoot, 'config', name),
      path.join(userDataRoot, 'config', name)
    )
    if (result.moved) moved.push(result); else if (result.reason === 'target_exists') skipped.push(`config/${name}`)
  }

  const legacyData = path.join(projectRoot, 'data')
  const targetData = path.join(userDataRoot, 'data')
  if (await exists(legacyData)) {
    await mkdir(targetData, { recursive: true })
    for (const entry of await readdir(legacyData, { withFileTypes: true })) {
      if (entry.name === '.gitkeep') continue
      const result = await moveIfMissing(
        path.join(legacyData, entry.name),
        path.join(targetData, entry.name)
      )
      if (result.moved) moved.push(result); else if (result.reason === 'target_exists') skipped.push(`data/${entry.name}`)
    }
  }

  console.log(JSON.stringify({
    ok: true,
    userDataRoot: path.relative(projectRoot, userDataRoot) || '.',
    moved: moved.length,
    skippedAlreadyPresent: skipped.length,
    details: moved
  }, null, 2))
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
