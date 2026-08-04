export interface WorldState {
  schemaVersion?: number
  sequence?: number
  observedAt?: number
  connected: boolean
  position?: { x: number; y: number; z: number }
  health?: number
  maxHealth?: number
  food?: number
  saturation?: number
  air?: number
  onFire?: boolean
  inWater?: boolean
  onGround?: boolean
  dimension?: string
  timeOfDay?: number
  inventory: Array<{
    name: string
    itemId?: string
    count: number
    slot?: number
    durability?: number
    maxDurability?: number
    enchanted?: boolean
    enchantments?: Array<{ id: string; level: number }>
  }>
  equipment?: Record<string, { itemId: string; name: string; count: number; durability?: number; maxDurability?: number; enchanted?: boolean } | null>
  nearbyPlayers: Array<{ name: string; uuid?: string; distance: number }>
  nearbyHostiles?: Array<{ id: string; typeId: string; name?: string; distance: number; health?: number; targetingBot?: boolean }>
  nearbyItems?: Array<{ id: string; itemId: string; count: number; distance: number }>
  environment?: {
    isNight?: boolean
    blockLight?: number
    skyLight?: number
    skyVisible?: boolean
    safeToIdle?: boolean
    safetyReasons?: string[]
  }
  activePrimitive?: string
  home?: { dimension: string; x: number; y: number; z: number; doorX?: number; doorY?: number; doorZ?: number; persisted?: boolean }
  currentTask?: string
}
