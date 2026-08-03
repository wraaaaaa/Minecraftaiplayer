import { loadProjectConfig } from './config/load-config.js'
import { BotRuntime } from './runtime/bot-runtime.js'

const loaded = await loadProjectConfig()
const runtime = new BotRuntime(loaded)
let stopping = false

async function stop(): Promise<void> {
  if (stopping) return
  stopping = true
  await runtime.stop()
}

process.once('SIGINT', () => { void stop() })
process.once('SIGTERM', () => { void stop() })

await runtime.run()
