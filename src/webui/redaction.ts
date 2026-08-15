/**
 * Remove credentials from text before it is exposed by the local WebUI.
 *
 * JWTs always begin with a base64url encoded JSON header ("eyJ..."). Requiring
 * that prefix avoids treating Java package names and stack-trace frames as JWTs.
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
