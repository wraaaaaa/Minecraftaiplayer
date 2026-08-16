import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'

interface AuditIssue {
  code: string
  path: string
  count: number
}

interface AuditResult {
  ok: boolean
  historyScanned: boolean
  issues: AuditIssue[]
  history?: {
    commitsScanned: number
    objectsScanned: number
    commitsWithIssues: number
    objectsWithIssues: number
    issueCount: number
  }
}

const scriptFile = fileURLToPath(new URL('../scripts/audit-repository.mjs', import.meta.url))
const thisTestFile = fileURLToPath(import.meta.url)
const importModule = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{
  auditRepository(options?: { cwd?: string; envFile?: string; history?: boolean }): Promise<AuditResult>
}>

function git(root: string, args: string[]): void {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
}

async function put(root: string, file: string, content: string | Buffer): Promise<void> {
  const target = path.join(root, ...file.split('/'))
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, content)
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'minecraft-ai-repository-audit-'))
  git(root, ['init', '-b', 'main'])
  git(root, ['config', 'user.name', 'Repository Audit Test'])
  git(root, ['config', 'user.email', 'audit@example.invalid'])
  await put(root, '.gitignore', [
    '.env',
    'config/bot.json',
    'config/persona.json',
    'config/prompts.json',
    'config/mods.json',
    'config/skin.json',
    'config/behavior-rules.json',
    'userdata/',
    'data/',
    'logs/',
    '.runtime/',
    'dist/',
    'build/',
    'fabric-bridge/build/'
  ].join('\n'))
  await put(root, 'README.md', 'clean repository\nconst password = options.password\n')
  await put(root, 'package.json', '{"name":"audit-fixture","private":true}\n')
  await put(root, 'scripts/audit-repository.mjs', await readFile(scriptFile))
  await put(root, 'test/repository-audit.test.ts', await readFile(thisTestFile))
  git(root, ['add', '.'])
  git(root, ['commit', '-m', 'initial'])
  return root
}

test('repository audit accepts clean tracked UTF-8 and ignored runtime paths', async (t) => {
  const root = await fixture()
  t.after(async () => rm(root, { recursive: true, force: true }))
  const { auditRepository } = await importModule(pathToFileURL(scriptFile).href)
  const result = await auditRepository({ cwd: root })
  assert.equal(result.ok, true)
  assert.equal(result.historyScanned, false)
  assert.deepEqual(result.issues, [])
})

test('repository audit reports encoding, control, mojibake, and JSON failures by file and count', async (t) => {
  const root = await fixture()
  t.after(async () => rm(root, { recursive: true, force: true }))
  const mojibake = String.fromCodePoint(0x951f, 0x65a4, 0x62f7)
  await put(root, 'bad-utf8.txt', Buffer.from([0xc3, 0x28]))
  await put(root, 'bom.txt', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('text')]))
  await put(root, 'control.txt', `before${String.fromCodePoint(0)}after`)
  await put(root, 'directional.txt', `before${String.fromCodePoint(0x202e)}after`)
  await put(root, 'zero-width.txt', `before${String.fromCodePoint(0x200b)}after`)
  await put(root, 'replacement.txt', String.fromCodePoint(0xfffd))
  await put(root, 'mojibake.txt', mojibake)
  await put(root, 'broken.json', '{"missing":')
  await put(root, 'config/bot.json', '{}\n')
  const ignoreWithoutRootBuild = (await readFile(path.join(root, '.gitignore'), 'utf8')).replace('build/\n', '')
  await put(root, '.gitignore', ignoreWithoutRootBuild)
  git(root, ['add', '.'])
  git(root, ['add', '--force', 'config/bot.json'])

  const { auditRepository } = await importModule(pathToFileURL(scriptFile).href)
  const result = await auditRepository({ cwd: root })
  const codes = new Set(result.issues.map(issue => issue.code))
  assert.equal(result.ok, false)
  for (const expected of ['invalid_utf8', 'utf8_bom', 'replacement_character', 'control_character', 'directional_or_zero_width_character', 'mojibake_signature', 'invalid_json', 'protected_path_tracked', 'protected_path_not_ignored']) {
    assert.equal(codes.has(expected), true, `missing ${expected}`)
  }
  assert.equal(result.issues.every(issue => typeof issue.path === 'string' && issue.count > 0), true)
})

test('known and shaped secrets are detected without returning their values', async (t) => {
  const root = await fixture()
  t.after(async () => rm(root, { recursive: true, force: true }))
  const knownSecret = ['sk', 'K'.repeat(36)].join('-')
  const bearer = ['Bearer', 'B'.repeat(28)].join(' ')
  const login = ['/login', 'L'.repeat(18)].join(' ')
  await put(root, '.env', `DEEPSEEK_API_KEY=${knownSecret}\n`)
  await put(root, 'leak.txt', `${knownSecret}\n${bearer}\n${login}\n`)
  git(root, ['add', 'leak.txt'])

  const { auditRepository } = await importModule(pathToFileURL(scriptFile).href)
  const result = await auditRepository({ cwd: root })
  const serialized = JSON.stringify(result)
  assert.equal(result.ok, false)
  assert.equal(result.issues.some(issue => issue.code === 'known_secret_value' && issue.path === 'leak.txt'), true)
  assert.equal(result.issues.some(issue => issue.code === 'secret_shape' && issue.path === 'leak.txt'), true)
  assert.equal(serialized.includes(knownSecret), false)
  assert.equal(serialized.includes('K'.repeat(24)), false)
})

test('repository audit also checks non-ignored untracked files before staging', async (t) => {
  const root = await fixture()
  t.after(async () => rm(root, { recursive: true, force: true }))
  const knownSecret = ['sk', 'U'.repeat(32)].join('-')
  await put(root, '.env', `DEEPSEEK_API_KEY=${knownSecret}\n`)
  await put(root, 'new-untracked-source.ts', `export const accidental = '${knownSecret}'\n`)

  const { auditRepository } = await importModule(pathToFileURL(scriptFile).href)
  const result = await auditRepository({ cwd: root })

  assert.equal(result.ok, false)
  assert.equal(result.issues.some(issue => issue.code === 'known_secret_value' && issue.path === 'new-untracked-source.ts'), true)
  assert.equal(JSON.stringify(result).includes(knownSecret), false)
})

test('CLI exits nonzero for findings and emits structured JSON without secret text', async (t) => {
  const root = await fixture()
  t.after(async () => rm(root, { recursive: true, force: true }))
  const knownSecret = ['sk', 'Q'.repeat(32)].join('-')
  await put(root, '.env', `DEEPSEEK_API_KEY=${knownSecret}\n`)
  await put(root, 'leak.txt', knownSecret)
  git(root, ['add', 'leak.txt'])

  const result = spawnSync(process.execPath, [scriptFile, '--root', root], { cwd: root, encoding: 'utf8', windowsHide: true })
  assert.equal(result.status, 1)
  const output = JSON.parse(result.stdout) as AuditResult
  assert.equal(output.ok, false)
  assert.equal(result.stdout.includes(knownSecret), false)
  assert.equal(result.stderr, '')
})

test('history scanning is opt-in and reports only aggregate commit and object counts', async (t) => {
  const root = await fixture()
  t.after(async () => rm(root, { recursive: true, force: true }))
  const knownSecret = ['sk', 'H'.repeat(34)].join('-')
  await put(root, '.env', `DEEPSEEK_API_KEY=${knownSecret}\n`)
  await put(root, 'historical-leak.txt', knownSecret)
  git(root, ['add', 'historical-leak.txt'])
  git(root, ['commit', '-m', 'temporary fixture'])
  await rm(path.join(root, 'historical-leak.txt'))
  git(root, ['add', '-u'])
  git(root, ['commit', '-m', 'remove fixture'])

  const { auditRepository } = await importModule(pathToFileURL(scriptFile).href)
  const current = await auditRepository({ cwd: root })
  assert.equal(current.ok, true)
  assert.equal(current.history, undefined)

  const historical = await auditRepository({ cwd: root, history: true })
  const serializedHistory = JSON.stringify(historical.history)
  assert.equal(historical.ok, false)
  assert.ok((historical.history?.commitsScanned ?? 0) >= 3)
  assert.ok((historical.history?.objectsWithIssues ?? 0) >= 1)
  assert.ok((historical.history?.commitsWithIssues ?? 0) >= 1)
  assert.equal(serializedHistory.includes(knownSecret), false)
  assert.equal(serializedHistory.includes('historical-leak.txt'), false)
})
