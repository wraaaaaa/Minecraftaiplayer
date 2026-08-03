import type { Bot } from 'mineflayer'
import type { Logger } from '../core/logger.js'

export class EasyAuthController {
  readonly #enabled: boolean
  readonly #password: string | undefined
  readonly #delayMs: number
  readonly #logger: Logger
  #attempted = false
  #authenticated = false

  constructor(options: { enabled: boolean; password?: string; delayMs: number; logger: Logger }) {
    this.#enabled = options.enabled
    this.#password = options.password
    this.#delayMs = options.delayMs
    this.#logger = options.logger
  }

  get authenticated(): boolean { return this.#authenticated }

  reset(): void { this.#attempted = false; this.#authenticated = false }

  onSpawn(bot: Bot): void {
    if (!this.#enabled) { this.#authenticated = true; return }
    setTimeout(() => this.#tryLogin(bot, 'spawn delay'), this.#delayMs).unref()
  }

  onSystemMessage(bot: Bot, message: string): void {
    const normalized = message.toLowerCase()
    if (/successfully logged|logged in|登录成功|认证成功|already logged/iu.test(normalized)) {
      this.#authenticated = true
      this.#logger.info('EasyAuth 登录成功')
      return
    }
    if (/\/login|please login|请登录|未登录|not authenticated/iu.test(normalized)) this.#tryLogin(bot, 'server prompt')
    if (/wrong password|incorrect password|密码错误|login failed/iu.test(normalized)) this.#logger.error('EasyAuth 登录失败：密码错误或服务器拒绝')
  }

  #tryLogin(bot: Bot, reason: string): void {
    if (!this.#enabled || this.#attempted || this.#authenticated) return
    if (!this.#password) {
      this.#logger.warn('EasyAuth 已启用，但没有提供登录密码环境变量')
      return
    }
    this.#attempted = true
    bot.chat(`/login ${this.#password}`)
    this.#logger.info('已发送 EasyAuth 登录命令', { reason })
  }
}
