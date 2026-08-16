import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveUserData } from './user-data.js'

export class AtomicJsonFile<T> {
  readonly #file: string
  readonly #createDefault: () => T
  #value: T | undefined
  #writeChain = Promise.resolve()

  constructor(file: string, createDefault: () => T) {
    this.#file = resolveUserData(file)
    this.#createDefault = createDefault
  }

  get file(): string { return this.#file }

  async load(): Promise<T> {
    if (this.#value !== undefined) return this.#value
    try {
      this.#value = JSON.parse(await readFile(this.#file, 'utf8')) as T
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      this.#value = this.#createDefault()
      await this.save(this.#value)
    }
    return this.#value
  }

  async update(mutator: (value: T) => void): Promise<T> {
    const value = await this.load()
    mutator(value)
    await this.save(value)
    return value
  }

  async save(value: T): Promise<void> {
    this.#value = value
    this.#writeChain = this.#writeChain.then(() => this.#write(value))
    await this.#writeChain
  }

  async #write(value: T): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true })
    const temporary = `${this.#file}.${process.pid}.tmp`
    const backup = `${this.#file}.bak`
    const body = `${JSON.stringify(value, null, 2)}\n`
    await writeFile(temporary, body, 'utf8')
    try { await copyFile(this.#file, backup) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    try {
      await rename(temporary, this.#file)
    } catch (error) {
      if (process.platform !== 'win32') throw error
      // Windows may briefly deny unlink/rename while the WebUI is polling the file or an
      // antivirus scanner has an open handle. Retrying keeps the atomic temp+backup contract and
      // prevents a read-only dashboard from permanently stopping runtime-state persistence.
      let lastError: unknown = error
      for (let attempt = 0; attempt < 8; attempt += 1) {
        try {
          await rm(this.#file, { force: true })
          await rename(temporary, this.#file)
          return
        } catch (retryError) {
          lastError = retryError
          const code = (retryError as NodeJS.ErrnoException).code
          if (!['EBUSY', 'EPERM', 'EACCES', 'ENOENT'].includes(code ?? '')) throw retryError
          await new Promise(resolve => setTimeout(resolve, Math.min(25 * (attempt + 1), 250)))
        }
      }
      // Some Windows scanners keep FILE_SHARE_DELETE disabled for seconds at a time. The backup
      // above still makes this recoverable, so use an in-place replacement as the bounded final
      // fallback instead of dropping every subsequent status update forever.
      try {
        await writeFile(this.#file, body, 'utf8')
        await rm(temporary, { force: true })
      } catch {
        throw lastError
      }
    }
  }
}
