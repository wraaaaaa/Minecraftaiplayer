import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { TextDecoder } from 'node:util'

const STRICT_UTF8 = new TextDecoder('utf-8', { fatal: true })
const MAX_GIT_OUTPUT = 128 * 1024 * 1024

const BINARY_EXTENSIONS = new Set([
  '.7z', '.avi', '.bin', '.bmp', '.class', '.dll', '.dylib', '.eot', '.exe', '.gif', '.gz',
  '.ico', '.jar', '.jpeg', '.jpg', '.mp3', '.mp4', '.ogg', '.otf', '.pdf', '.png', '.so',
  '.tar', '.ttf', '.wav', '.webm', '.webp', '.woff', '.woff2', '.xz', '.zip'
])

const PROTECTED_PATHS = [
  { path: 'userdata', directory: true },
  { path: '.env', directory: false },
  { path: 'config/bot.json', directory: false },
  { path: 'config/persona.json', directory: false },
  { path: 'config/prompts.json', directory: false },
  { path: 'config/mods.json', directory: false },
  { path: 'config/skin.json', directory: false },
  { path: 'config/behavior-rules.json', directory: false },
  { path: 'data', directory: true },
  { path: 'logs', directory: true },
  { path: '.runtime', directory: true },
  { path: 'dist', directory: true },
  { path: 'build', directory: true },
  { path: 'fabric-bridge/build', directory: true }
]

const SENSITIVE_ENV_NAME = /(?:api[_-]?key|authorization|password|secret|token)/iu
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu
const DIRECTIONAL_OR_ZERO_WIDTH = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/gu

// 将这些签名转义，避免此扫描器标记自身的源代码。
const MOJIBAKE_SIGNATURES = [
  '\u6D63\u72B5',
  '\u7487\u950B',
  '\u7EDB\u590A\u7DDF',
  '\u9428\u52EC',
  '\u93C3\u72B3',
  '\u951F\u65A4\u62F7',
  '\u00C3\u00A9',
  '\u00C2\u00A0',
  '\u00E2\u20AC\u2122'
]

const SECRET_PATTERNS = [
  /\b(?:sk|rk)-(?:proj-)?[A-Za-z0-9_-]{20,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  /\bBearer[ \t]+[A-Za-z0-9._~+/=-]{16,}/giu,
  /(?:api[_-]?key|authorization|password|secret|token|密码|令牌)["' \t]*[:=]["' \t]*(?=[A-Za-z0-9._~+/=-]{16,})(?=[A-Za-z0-9._~+/=-]*[0-9_~+/=-])[A-Za-z0-9._~+/=-]{16,}/giu,
  /\/(?:login|register)[ \t]+(?!(?:\[|<|\{|\$|%|REDACTED\b|password\b|secret\b|super-secret\b|example\b|sample\b|dummy\b|test\b))[A-Za-z0-9._~+/@#%=-]{12,}/giu
]

function runGit(root, args, options = {}) {
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: options.binary ? null : 'utf8',
    maxBuffer: MAX_GIT_OUTPUT,
    windowsHide: true
  })
  if (result.error) throw result.error
  if (result.status !== 0 && !options.allowFailure) {
    const stderr = Buffer.isBuffer(result.stderr) ? result.stderr.toString('utf8') : result.stderr
    throw new Error(`git ${args[0] ?? ''} failed (${result.status ?? 'unknown'}): ${(stderr ?? '').trim()}`)
  }
  return result
}

function splitNull(buffer) {
  const values = []
  let start = 0
  for (let index = 0; index < buffer.length; index += 1) {
    if (buffer[index] !== 0) continue
    if (index > start) values.push(STRICT_UTF8.decode(buffer.subarray(start, index)))
    start = index + 1
  }
  if (start < buffer.length) values.push(STRICT_UTF8.decode(buffer.subarray(start)))
  return values
}

function isBinaryPath(file) {
  return BINARY_EXTENSIONS.has(path.extname(file).toLowerCase())
}

function occurrences(text, needle) {
  if (!needle) return 0
  let count = 0
  let cursor = 0
  while ((cursor = text.indexOf(needle, cursor)) >= 0) {
    count += 1
    cursor += Math.max(needle.length, 1)
  }
  return count
}

function patternOccurrences(text, expression) {
  expression.lastIndex = 0
  let count = 0
  while (expression.exec(text) !== null) count += 1
  expression.lastIndex = 0
  return count
}

function safePath(file, knownSecrets) {
  let result = file
  for (const secret of knownSecrets) result = result.split(secret).join('[REDACTED]')
  for (const expression of SECRET_PATTERNS) {
    expression.lastIndex = 0
    result = result.replace(expression, '[REDACTED]')
    expression.lastIndex = 0
  }
  return result
}

function addIssue(issues, code, file, count, knownSecrets) {
  if (count <= 0) return
  issues.push({ code, path: safePath(file, knownSecrets), count })
}

function inspectText(buffer, file, knownSecrets, options = {}) {
  const issues = []
  const hasBom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf
  if (hasBom) addIssue(issues, 'utf8_bom', file, 1, knownSecrets)

  let text
  try {
    text = STRICT_UTF8.decode(buffer)
  } catch {
    addIssue(issues, 'invalid_utf8', file, 1, knownSecrets)
    return issues
  }

  addIssue(issues, 'replacement_character', file, occurrences(text, '\uFFFD'), knownSecrets)
  addIssue(issues, 'control_character', file, patternOccurrences(text, CONTROL_CHARACTERS), knownSecrets)
  const directionalInput = hasBom && text.startsWith('\uFEFF') ? text.slice(1) : text
  addIssue(issues, 'directional_or_zero_width_character', file, patternOccurrences(directionalInput, DIRECTIONAL_OR_ZERO_WIDTH), knownSecrets)

  let mojibakeCount = 0
  for (const signature of MOJIBAKE_SIGNATURES) mojibakeCount += occurrences(text, signature)
  addIssue(issues, 'mojibake_signature', file, mojibakeCount, knownSecrets)

  let secretShapeCount = 0
  for (const expression of SECRET_PATTERNS) secretShapeCount += patternOccurrences(text, expression)
  addIssue(issues, 'secret_shape', file, secretShapeCount, knownSecrets)

  let knownSecretCount = 0
  for (const secret of knownSecrets) knownSecretCount += occurrences(text, secret)
  addIssue(issues, 'known_secret_value', file, knownSecretCount, knownSecrets)

  if (options.parseJson) {
    try {
      JSON.parse(hasBom && text.startsWith('\uFEFF') ? text.slice(1) : text)
    } catch {
      addIssue(issues, 'invalid_json', file, 1, knownSecrets)
    }
  }
  return issues
}

async function loadKnownSecrets(root, envFile, issues) {
  let buffer
  try {
    buffer = await readFile(envFile)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return []
    issues.push({ code: 'env_read_error', path: safePath(path.relative(root, envFile).replaceAll('\\', '/'), []), count: 1 })
    return []
  }

  let text
  try {
    text = STRICT_UTF8.decode(buffer)
  } catch {
    issues.push({ code: 'env_invalid_utf8', path: safePath(path.relative(root, envFile).replaceAll('\\', '/'), []), count: 1 })
    return []
  }

  const secrets = new Set()
  for (const rawLine of text.split(/\r?\n/u)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const separator = line.indexOf('=')
    if (separator <= 0) continue
    const name = line.slice(0, separator).trim()
    if (!SENSITIVE_ENV_NAME.test(name)) continue
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1)
    if (value) secrets.add(value)
  }
  return [...secrets]
}

function trackedFiles(root) {
  // 纳入未被忽略的未跟踪文件：新创建的源代码/测试正是
  // 提交前秘密或编码泄漏可能规避审计的地方。
  const output = runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { binary: true }).stdout
  return splitNull(output)
}

function inspectProtectedPaths(root, knownSecrets) {
  const issues = []
  for (const entry of PROTECTED_PATHS) {
    const probe = entry.directory ? `${entry.path}/.repository-audit-probe` : entry.path
    const tracked = runGit(root, ['ls-files', '-z', '--', entry.path], { binary: true }).stdout
    const trackedCount = splitNull(tracked).length
    addIssue(issues, 'protected_path_tracked', entry.path, trackedCount, knownSecrets)
    const ignored = runGit(root, ['check-ignore', '--no-index', '-q', '--', probe], { allowFailure: true }).status === 0
    if (!ignored) addIssue(issues, 'protected_path_not_ignored', entry.path, 1, knownSecrets)
  }
  return issues
}

async function inspectCurrent(root, files, knownSecrets) {
  const issues = []
  let textFiles = 0
  let binaryFiles = 0
  for (const file of files) {
    if (isBinaryPath(file)) {
      binaryFiles += 1
      continue
    }
    textFiles += 1
    const absolute = path.resolve(root, ...file.split('/'))
    let buffer
    try {
      buffer = await readFile(absolute)
    } catch {
      addIssue(issues, 'tracked_file_read_error', file, 1, knownSecrets)
      continue
    }
    issues.push(...inspectText(buffer, file, knownSecrets, { parseJson: file.toLowerCase().endsWith('.json') }))
    let pathSecretCount = 0
    for (const secret of knownSecrets) pathSecretCount += occurrences(file, secret)
    for (const expression of SECRET_PATTERNS) pathSecretCount += patternOccurrences(file, expression)
    addIssue(issues, 'secret_in_path', file, pathSecretCount, knownSecrets)
  }
  return { issues, textFiles, binaryFiles }
}

function parseTreeRecord(record) {
  const separator = record.indexOf('\t')
  if (separator < 0) return null
  const metadata = record.slice(0, separator).split(' ')
  if (metadata.length !== 3 || metadata[1] !== 'blob') return null
  return { object: metadata[2], path: record.slice(separator + 1) }
}

function inspectHistory(root, knownSecrets) {
  const commitsText = runGit(root, ['rev-list', '--all']).stdout.trim()
  const commits = commitsText ? commitsText.split(/\r?\n/u).filter(Boolean) : []
  const objects = new Map()
  const commitObjects = new Map()

  for (const commit of commits) {
    const tree = runGit(root, ['ls-tree', '-r', '-z', '--full-tree', commit], { binary: true }).stdout
    const objectIds = new Set()
    for (const record of splitNull(tree)) {
      const parsed = parseTreeRecord(record)
      if (!parsed) continue
      objectIds.add(parsed.object)
      const paths = objects.get(parsed.object) ?? new Set()
      paths.add(parsed.path)
      objects.set(parsed.object, paths)
    }
    commitObjects.set(commit, objectIds)
  }

  const badObjects = new Set()
  let textObjects = 0
  let binaryObjects = 0
  let issueCount = 0
  for (const [object, paths] of objects) {
    const textPaths = [...paths].filter(file => !isBinaryPath(file))
    if (textPaths.length === 0) {
      binaryObjects += 1
      continue
    }
    textObjects += 1
    const buffer = runGit(root, ['cat-file', 'blob', object], { binary: true }).stdout
    let objectIssues = 0
    const representative = textPaths[0] ?? 'tracked-object'
    const shouldParseJson = textPaths.some(file => file.toLowerCase().endsWith('.json'))
    objectIssues += inspectText(buffer, representative, knownSecrets, { parseJson: shouldParseJson }).reduce((sum, issue) => sum + issue.count, 0)
    for (const file of textPaths) {
      for (const secret of knownSecrets) objectIssues += occurrences(file, secret)
      for (const expression of SECRET_PATTERNS) objectIssues += patternOccurrences(file, expression)
    }
    if (objectIssues > 0) {
      badObjects.add(object)
      issueCount += objectIssues
    }
  }

  let commitsWithIssues = 0
  for (const objectIds of commitObjects.values()) {
    if ([...objectIds].some(object => badObjects.has(object))) commitsWithIssues += 1
  }

  return {
    commitsScanned: commits.length,
    objectsScanned: objects.size,
    textObjectsScanned: textObjects,
    binaryObjectsSkipped: binaryObjects,
    commitsWithIssues,
    objectsWithIssues: badObjects.size,
    issueCount
  }
}

export async function auditRepository(options = {}) {
  const requestedRoot = path.resolve(options.cwd ?? process.cwd())
  const rootResult = runGit(requestedRoot, ['rev-parse', '--show-toplevel'])
  const root = path.resolve(rootResult.stdout.trim())
  const preflightIssues = []
  const userDataEnv = path.resolve(root, process.env.MCAI_USERDATA_DIR?.trim() || 'userdata', '.env')
  const envFile = path.resolve(root, options.envFile ?? (existsSync(userDataEnv) ? path.relative(root, userDataEnv) : '.env'))
  const knownSecrets = await loadKnownSecrets(root, envFile, preflightIssues)
  const files = trackedFiles(root)
  const current = await inspectCurrent(root, files, knownSecrets)
  const issues = [...preflightIssues, ...inspectProtectedPaths(root, knownSecrets), ...current.issues]
  const history = options.history === true ? inspectHistory(root, knownSecrets) : null
  return {
    ok: issues.length === 0 && (!history || history.objectsWithIssues === 0),
    root: safePath(root, knownSecrets),
    historyScanned: options.history === true,
    summary: {
      trackedFiles: files.length,
      textFiles: current.textFiles,
      binaryFilesSkipped: current.binaryFiles,
      issueFiles: new Set(issues.map(issue => issue.path)).size,
      issueCount: issues.reduce((sum, issue) => sum + issue.count, 0)
    },
    issues,
    ...(history ? { history } : {})
  }
}

function parseArguments(argv) {
  const options = { history: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    if (argument === '--history') options.history = true
    else if (argument === '--root') {
      const value = argv[index + 1]
      if (!value) throw new Error('--root requires a directory')
      options.cwd = value
      index += 1
    } else if (argument === '--help' || argument === '-h') options.help = true
    else throw new Error(`Unknown argument: ${argument}`)
  }
  return options
}

async function main() {
  try {
    const options = parseArguments(process.argv.slice(2))
    if (options.help) {
      process.stdout.write('Usage: node scripts/audit-repository.mjs [--root <directory>] [--history]\n')
      return
    }
    const result = await auditRepository(options)
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    if (!result.ok) process.exitCode = 1
  } catch {
    process.stderr.write(`${JSON.stringify({ ok: false, fatal: { code: 'audit_failed', count: 1 } })}\n`)
    process.exitCode = 2
  }
}

const invokedAsScript = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url
if (invokedAsScript) await main()
