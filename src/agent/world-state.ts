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
  experienceLevel?: number
  experienceProgress?: number
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
    placeableBlockId?: string
    durability?: number
    maxDurability?: number
    enchanted?: boolean
    foodNutrition?: number
    foodSaturation?: number
    safeFood?: boolean
    enchantments?: Array<{ id: string; level: number }>
  }>
  equipment?: Record<string, { itemId: string; name: string; count: number; durability?: number; maxDurability?: number; enchanted?: boolean } | null>
  nearbyPlayers: Array<{
    name: string
    uuid?: string
    distance: number
    health?: number
    position?: { x: number; y: number; z: number }
    lookingAtBlock?: { blockId: string; x: number; y: number; z: number; distance: number }
  }>
  ownerWaypoint?: {
    name: string
    uuid?: string
    bearingDegrees: number
    distance?: number
    precision: 'position' | 'chunk' | 'azimuth' | 'unknown'
  }
  nearbyHostiles?: Array<{ id: string; typeId: string; name?: string; distance: number; health?: number; targetingBot?: boolean; targetPlayerName?: string; position?: { x: number; y: number; z: number } }>
  nearbyCreatures?: Array<{
    id: string
    typeId: string
    name?: string
    distance: number
    health?: number
    position?: { x: number; y: number; z: number }
    baby?: boolean
    tamed?: boolean
    leashed?: boolean
    customNamed?: boolean
    inWater?: boolean
  }>
  nearbyItems?: Array<{ id: string; itemId: string; count: number; distance: number }>
  blockSurvey?: {
    radius: number
    verticalRadius: number
    sampledBlocks: number
    solidBlocks: number
    blockEntityCount: number
    center: { x: number; y: number; z: number }
    resources: Array<{ blockId: string; category: string; count: number; nearestDistance: number; nearest?: { x: number; y: number; z: number } }>
    artificial: Array<{ blockId: string; category: string; count: number; nearestDistance: number; nearest?: { x: number; y: number; z: number } }>
    owned?: Array<{ blockId: string; category: string; count: number; nearestDistance: number; nearest?: { x: number; y: number; z: number } }>
    other: Array<{ blockId: string; category: string; count: number; nearestDistance: number; nearest?: { x: number; y: number; z: number } }>
    classification: 'natural_terrain_likely' | 'protected_structure_nearby' | 'uncertain'
    protectedLikely: boolean
    reasons: string[]
  }
  environment?: {
    isNight?: boolean
    blockLight?: number
    skyLight?: number
    skyVisible?: boolean
    safeToIdle?: boolean
    safetyReasons?: string[]
  }
  activePrimitive?: string
  navigationStatus?: string
  home?: { dimension: string; x: number; y: number; z: number; doorX?: number; doorY?: number; doorZ?: number; persisted?: boolean }
  currentTask?: string
}
