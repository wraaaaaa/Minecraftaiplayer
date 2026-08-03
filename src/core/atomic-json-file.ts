import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class AtomicJsonFile<T> {
  readonly #file: string
  readonly #createDefault: () => T
  #value: T | undefined
  #writeChain = Promise.resolve()

  constructor(file: string, createDefault: () => T) {
    this.#file = path.resolve(file)
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
      await rm(this.#file, { force: true })
      await rename(temporary, this.#file)
    }
  }
}
