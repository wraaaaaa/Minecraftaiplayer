/**
 * 在文本暴露给本地 WebUI 之前移除其中的凭据。
 *
 * JWT 总是以 base64url 编码的 JSON 头（"eyJ..."）开头。要求匹配该前缀，
 * 可以避免把 Java 包名和堆栈跟踪帧误判为 JWT。
 */
export function redactForWebUi(value: string): string {
  return value
    .replace(/\/login\s+\S+/giu, '/login [REDACTED]')
    .replace(/\/register\s+\S+(?:\s+\S+)?/giu, '/register [REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/giu, 'Bearer [REDACTED]')
    .replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu, '[REDACTED_JWT]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/giu, 'sk-[REDACTED]')
    .replace(/\b([A-Za-z0-9_-]*(?:api[_-]?key|password|token)|key)\b(["'\s:=]+)[^\s,"'}]+/giu, '$1$2[REDACTED]')
}
