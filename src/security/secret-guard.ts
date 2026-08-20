const GENERIC_SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{12,}\b/giu,
  /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}\b/giu,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?\b/gu,
  /\/(?:login|register)\s+\S+(?:\s+\S+)?/giu,
  /\b(?:api[_ -]?key|password|密码|口令|token|令牌|authorization)\b\s*[=:：]\s*\S+/giu
] as const

const EXTRACTION_REQUEST = /(?:api[_\s-]*key|apikey|密钥|密码|口令|token|令牌|authorization|\.env|环境变量|系统提示词|system\s*prompt|本地配置|配置文件|服务器地址|域名).{0,18}(?:告诉|发给|显示|输出|读取|泄露|是什么|多少|给我|show|tell|reveal|print|dump|read)|(?:告诉|发给|显示|输出|读取|泄露|给我|show|tell|reveal|print|dump|read).{0,18}(?:api[_\s-]*key|apikey|密钥|密码|口令|token|令牌|authorization|\.env|环境变量|系统提示词|system\s*prompt|本地配置|配置文件|服务器地址|域名)/iu

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&') }

export class SecretGuard {
  readonly #knownSecrets: string[]

  constructor(values: Array<string | undefined>) {
    this.#knownSecrets = [...new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value && value.length >= 4)))]
      .sort((left, right) => right.length - left.length)
  }

  sanitize(value: string): string {
    let sanitized = value
    for (const secret of this.#knownSecrets) sanitized = sanitized.replace(new RegExp(escapeRegExp(secret), 'giu'), '[REDACTED]')
    for (const pattern of GENERIC_SECRET_PATTERNS) sanitized = sanitized.replace(pattern, '[REDACTED]')
    return sanitized
  }

  sanitizeForModel(value: string): string { return this.sanitize(value) }
  sanitizeForPersistence(value: string): string { return this.sanitize(value) }

  isExtractionRequest(value: string): boolean { return EXTRACTION_REQUEST.test(value) }

  safeChat(value: string): { safe: true; text: string } | { safe: false; text: string; reason: string } {
    const cleaned = value.replace(/[\r\n]+/gu, ' ').trim().slice(0, 240)
    const sanitized = this.sanitize(cleaned)
    if (sanitized !== cleaned) {
      return { safe: false, text: '我不能透露密码、API Key、令牌、服务器地址或本地配置等敏感信息。', reason: '聊天内容触发了敏感信息出站拦截' }
    }
    return { safe: true, text: cleaned }
  }
}
