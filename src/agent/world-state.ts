export interface WorldState {
  connected: boolean
  position?: { x: number; y: number; z: number }
  health?: number
  food?: number
  dimension?: string
  timeOfDay?: number
  inventory: Array<{ name: string; count: number }>
  nearbyPlayers: Array<{ name: string; distance: number }>
  currentTask?: string
}
