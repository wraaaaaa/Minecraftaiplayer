import path from 'node:path'

/**
 * Single root for every per-install, user-specific file: secrets (.env), skin images,
 * personalized settings, player profiles, AI prompt documents, memory, experience and
 * self-learning state. Everything under this folder can be moved wholesale to a new
 * version of the project and the personal data comes along untouched.
 *
 * Override the location with MCAI_USERDATA_DIR when the folder must live outside the
 * workspace (for example on a shared drive).
 */
const projectRoot = path.resolve(process.cwd())
export const USER_DATA_ROOT = path.resolve(process.env.MCAI_USERDATA_DIR?.trim() || path.join(projectRoot, 'userdata'))

/** Resolve one or more path segments underneath the user-data root. */
export function userDataPath(...segments: string[]): string {
  return path.resolve(USER_DATA_ROOT, ...segments)
}

/**
 * Resolve a path the way configuration files specify it. Relative values are interpreted
 * against the user-data root (so `data/memory.json` becomes `userdata/data/memory.json`);
 * absolute values are kept unchanged.
 */
export function resolveUserData(configured: string): string {
  return path.isAbsolute(configured) ? path.resolve(configured) : path.resolve(USER_DATA_ROOT, configured)
}

export function projectPath(...segments: string[]): string {
  return path.resolve(projectRoot, ...segments)
}
