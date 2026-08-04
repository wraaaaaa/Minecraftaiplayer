export function parseJsonDocument<T>(value: string): T {
  return JSON.parse(value.replace(/^\uFEFF/u, '')) as T
}
