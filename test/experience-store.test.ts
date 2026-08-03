import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { ExperienceStore } from '../src/experience/experience-store.js'

test('经验文件可持久化并按任务检索', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'mc-ai-experience-'))
  try {
    const file = path.join(directory, 'experience.json')
    const store = new ExperienceStore(file)
    await store.add({ task: '跟随玩家', context: '玩家不在附近', outcome: 'failure', lesson: '先确认目标实体存在', correction: '找不到玩家时不要启动寻路', tags: ['follow_player', '跟随'] })
    const restored = new ExperienceStore(file)
    const matches = await restored.relevant('请跟随 Alice')
    assert.equal(matches.length, 1)
    assert.equal(matches[0]?.lesson, '先确认目标实体存在')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
