export interface ParsedPlayerChat {
  name: string
  message: string
}

export function parseDecoratedPlayerChat(value: string): ParsedPlayerChat | null {
  const match = value.trim().match(/^<(.+?)>\s+(.+)$/u)
  if (!match) return null
  let name = match[1]?.trim() ?? ''
  while (name.startsWith('[')) {
    const end = name.indexOf(']')
    if (end < 0) return null
    name = name.slice(end + 1).trim()
  }
  const message = match[2]?.trim() ?? ''
  if (!/^[A-Za-z0-9_]{3,16}$/u.test(name) || !message) return null
  return { name, message }
}
