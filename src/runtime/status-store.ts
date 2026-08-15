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

/**
 * Runtime status is a dashboard/health-check snapshot, not the Agent's observation store.
 * Keep it small so the one-second Fabric state stream cannot rewrite tens of gigabytes of
 * nearby-block data per day. The controller still retains the complete in-memory WorldState.
 */
export function compactRuntimeWorld(world: WorldState): WorldState {
  return {
    connected: world.connected,
    ...(world.schemaVersion === undefined ? {} : { schemaVersion: world.schemaVersion }),
    ...(world.sequence === undefined ? {} : { sequence: world.sequence }),
    ...(world.observedAt === undefined ? {} : { observedAt: world.observedAt }),
    ...(world.position ? { position: world.position } : {}),
    ...(world.health === undefined ? {} : { health: world.health }),
    ...(world.maxHealth === undefined ? {} : { maxHealth: world.maxHealth }),
    ...(world.food === undefined ? {} : { food: world.food }),
    ...(world.saturation === undefined ? {} : { saturation: world.saturation }),
    ...(world.air === undefined ? {} : { air: world.air }),
    ...(world.onFire === undefined ? {} : { onFire: world.onFire }),
    ...(world.inWater === undefined ? {} : { inWater: world.inWater }),
    ...(world.onGround === undefined ? {} : { onGround: world.onGround }),
    ...(world.dimension === undefined ? {} : { dimension: world.dimension }),
    inventory: [],
    nearbyPlayers: world.nearbyPlayers.slice(0, 16).map(player => ({
      name: player.name,
      distance: player.distance,
      ...(player.uuid ? { uuid: player.uuid } : {}),
      ...(player.health === undefined ? {} : { health: player.health })
    })),
    ...(world.nearbyHostiles?.length ? { nearbyHostiles: world.nearbyHostiles.slice(0, 8).map(hostile => ({
      id: hostile.id,
      typeId: hostile.typeId,
      distance: hostile.distance,
      ...(hostile.name ? { name: hostile.name } : {}),
      ...(hostile.health === undefined ? {} : { health: hostile.health }),
      ...(hostile.targetingBot === undefined ? {} : { targetingBot: hostile.targetingBot }),
      ...(hostile.targetPlayerName ? { targetPlayerName: hostile.targetPlayerName } : {})
    })) } : {}),
    ...(world.environment ? { environment: world.environment } : {}),
    ...(world.home ? { home: world.home } : {}),
    ...(world.activePrimitive === undefined ? {} : { activePrimitive: world.activePrimitive }),
    ...(world.navigationStatus === undefined ? {} : { navigationStatus: world.navigationStatus })
  }
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
  #lastPhase: RuntimeStatus['phase'] | undefined
  #lastFingerprint = ''
  #lastSavedAt = 0

  async load(): Promise<void> { await this.#file.load() }

  async report(phase: RuntimeStatus['phase'], adapter: string, server: string, world: WorldState): Promise<void> {
    const now = Date.now()
    const compactWorld = compactRuntimeWorld(world)
    const { sequence: _sequence, observedAt: _observedAt, ...materialWorld } = compactWorld
    const fingerprint = JSON.stringify({ phase, adapter, server, world: materialWorld })
    if (phase === this.#lastPhase) {
      if (now - this.#lastSavedAt < 1_000) return
      if (fingerprint === this.#lastFingerprint && now - this.#lastSavedAt < 30_000) return
    }
    this.#lastPhase = phase
    this.#lastFingerprint = fingerprint
    this.#lastSavedAt = now
    try {
      await this.#file.save({ schemaVersion: 1, phase, adapter, server, updatedAt: new Date(now).toISOString(), world: compactWorld })
    } catch (error) {
      // A transient Windows file lock must not suppress the next report for 30 seconds.
      this.#lastPhase = undefined
      this.#lastFingerprint = ''
      this.#lastSavedAt = 0
      throw error
    }
  }
}
