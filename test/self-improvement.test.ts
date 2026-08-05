import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import type { LlmProvider } from '../src/llm/types.js'
import { PromptWorkspace } from '../src/prompts/prompt-workspace.js'
import { SecretGuard } from '../src/security/secret-guard.js'
import { SelfImprovementManager } from '../src/self-improvement/self-improvement-manager.js'

test('SearXNG 研究只发送清洗后的查询并把结果作为限长文本返回', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcai-research-'))
  let received = ''
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    received = url.searchParams.get('q') ?? ''
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ results: [{ title: 'Fabric 导航建议', content: '重新读取真实落脚格并规划相邻安全节点。', url: 'https://example.invalid/guide' }] }))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert(address && typeof address === 'object')
    const workspace = new PromptWorkspace({
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      exampleDirectory: path.resolve('config/agent-prompts.example'),
      allowedRoot: root
    })
    const manager = new SelfImprovementManager({
      config: {
        enabled: true,
        allowPromptEdits: false,
        allowBehaviorPatches: false,
        minimumRepeatedFailures: 3,
        researchProvider: 'searxng',
        researchEndpoint: `http://127.0.0.1:${address.port}/search`,
        researchTimeoutMs: 1000
      },
      provider: { complete: async () => { throw new Error('research 不应调用模型') } },
      workspace,
      secrets: new SecretGuard(['private-value']),
      file: path.join(root, 'self-improvement.json')
    })
    const rejected = await manager.research('矿道失败 private-value\n下一行')
    assert.deepEqual(rejected, [])
    assert.equal(received, '')
    const results = await manager.research('矿道上行台阶无法进入\n重新规划')
    assert.doesNotMatch(received, /[\r\n]/u)
    assert.match(received, /重新规划/u)
    assert.equal(results[0]?.title, 'Fabric 导航建议')
    assert.match(results[0]?.snippet ?? '', /真实落脚格/u)
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()))
    await rm(root, { recursive: true, force: true })
  }
})

test('重复失败达到阈值后只写受限提示词托管区和声明式补丁', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mcai-improve-'))
  try {
    const workspace = new PromptWorkspace({
      promptDirectory: path.join(root, 'prompts'),
      playerProfilesDirectory: path.join(root, 'profiles'),
      exampleDirectory: path.resolve('config/agent-prompts.example'),
      allowedRoot: root
    })
    const provider: LlmProvider = {
      complete: async () => ({
        text: JSON.stringify({
          guidance: '矿道台阶失败时先按真实落脚高度重新规划，再尝试相邻天然方向。',
          strategies: ['释放旧路径', '从当前真实落脚格重新选择方向']
        }),
        model: 'test',
        requestedEffort: 'none',
        effectiveEffort: 'none'
      })
    }
    const manager = new SelfImprovementManager({
      config: {
        enabled: true,
        allowPromptEdits: true,
        allowBehaviorPatches: true,
        minimumRepeatedFailures: 2,
        researchProvider: 'disabled',
        researchEndpoint: '',
        researchTimeoutMs: 1000
      },
      provider,
      workspace,
      secrets: new SecretGuard([]),
      file: path.join(root, 'self-improvement.json')
    })
    const action = { type: 'excavate_tunnel', resource: 'stone', targetY: 64, length: 12 } as const
    const first = await manager.learnFromFailure({
      action,
      detail: 'cannot enter step at 1, 2, 3',
      taskContext: '返回地表'
    })
    const second = await manager.learnFromFailure({
      action,
      detail: 'cannot enter step at 9, 8, 7',
      taskContext: '返回地表'
    })
    assert.equal(first.status, 'threshold_pending')
    assert.equal(second.status, 'learned')
    assert.match((await workspace.readDocuments())['TOOLS.md'], /真实落脚高度重新规划/u)
    const patches = await workspace.readBehaviorPatches()
    assert.equal(patches.patches.length, 1)
    assert.equal(patches.patches[0]!.actionType, 'excavate_tunnel')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
