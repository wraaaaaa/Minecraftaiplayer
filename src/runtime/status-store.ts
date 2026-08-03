import type { WorldState } from '../agent/world-state.js'
import { AtomicJsonFile } from '../core/atomic-json-file.js'

export interface RuntimeStatus {
  schemaVersion: 1
  phase: 'starting' | 'waiting_for_client' | 'connected' | 'in_world' | 'disconnected' | 'stopped'
  adapter: string
  server: string
  updatedAt: string
  world: WorldState
}

export class RuntimeStatusStore {
  readonly #file = new AtomicJsonFile<RuntimeStatus>('data/runtime-status.json', () => ({
    schemaVersion: 1,
    phase: 'stopped',
    adapter: 'unknown',
    server: '',
    updatedAt: new Date().toISOString(),
    world: { connected: false, inventory: [], nearbyPlayers: [] }
  }))

  async load(): Promise<void> { await this.#file.load() }

  async report(phase: RuntimeStatus['phase'], adapter: string, server: string, world: WorldState): Promise<void> {
    await this.#file.save({ schemaVersion: 1, phase, adapter, server, updatedAt: new Date().toISOString(), world })
  }
}
