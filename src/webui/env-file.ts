export type EnvUpdate = string | null | undefined

function assignmentKey(line: string): string | undefined {
  const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u)
  return match?.[1]
}

/**
 * Updates only keys owned by the WebUI while preserving comments, blank lines,
 * ordering and custom environment variables. Empty-string updates mean "leave
 * unchanged" so the UI can submit masked/blank secret inputs safely; null removes
 * a managed key explicitly.
 */
export function mergeManagedEnv(
  source: string,
  updates: Readonly<Record<string, EnvUpdate>>,
  managedKeys: readonly string[]
): string {
  const eol = source.includes('\r\n') ? '\r\n' : '\n'
  const hadBom = source.startsWith('\uFEFF')
  const withoutBom = hadBom ? source.slice(1) : source
  const hadFinalNewline = /(?:\r?\n)$/u.test(withoutBom)
  const lines = withoutBom.split(/\r?\n/u)
  if (hadFinalNewline) lines.pop()

  const managed = new Set(managedKeys)
  const seen = new Set<string>()
  const output: string[] = []
  for (const line of lines) {
    const key = assignmentKey(line)
    if (!key || !managed.has(key)) {
      output.push(line)
      continue
    }
    if (seen.has(key)) continue
    seen.add(key)
    const update = updates[key]
    if (update === null) continue
    if (typeof update === 'string' && update !== '') output.push(`${key}=${update}`)
    else output.push(line)
  }

  for (const key of managedKeys) {
    if (seen.has(key)) continue
    const update = updates[key]
    if (typeof update === 'string' && update !== '') output.push(`${key}=${update}`)
  }

  const body = output.join(eol)
  if (!body) return hadBom ? '\uFEFF' : ''
  return `${hadBom ? '\uFEFF' : ''}${body}${hadFinalNewline || output.length > 0 ? eol : ''}`
}
