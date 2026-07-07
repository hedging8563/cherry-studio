import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { ClawToolContext } from '../clawTools'

const mockCreateTask = vi.fn()
const mockListTasks = vi.fn()
const mockDeleteTask = vi.fn()
const mockGetAgentAdapters = vi.fn()
const mockSendMessage = vi.fn()
const mockSendFile = vi.fn()
const mockGetAgent = vi.fn()
const mockUpdateAgent = vi.fn()
const mockSyncChannel = vi.fn()
const mockWaitForQrUrl = vi.fn()
const mockQRCodeToDataURL = vi.fn()
const mockListChannels = vi.fn()
const mockCreateChannel = vi.fn()
const mockGetChannel = vi.fn()
const mockUpdateChannel = vi.fn()
const mockDeleteChannel = vi.fn()

vi.mock('@data/services/AgentTaskService', () => ({
  agentTaskService: { createTask: mockCreateTask, listTasks: mockListTasks, deleteTask: mockDeleteTask }
}))

vi.mock('@data/services/AgentService', () => ({
  agentService: { getAgent: mockGetAgent, updateAgent: mockUpdateAgent }
}))

vi.mock('@application', async () => {
  const { mockApplicationFactory } = await import('@test-mocks/main/application')
  return mockApplicationFactory({
    ChannelManager: {
      getAgentAdapters: mockGetAgentAdapters,
      getAdapterStatuses: vi.fn().mockReturnValue([]),
      syncChannel: mockSyncChannel,
      waitForQrUrl: mockWaitForQrUrl
    }
  } as Parameters<typeof mockApplicationFactory>[0])
})

vi.mock('qrcode', () => ({ default: { toDataURL: mockQRCodeToDataURL } }))

vi.mock('@data/services/AgentChannelService', () => ({
  agentChannelService: {
    listChannels: mockListChannels,
    createChannel: mockCreateChannel,
    getChannel: mockGetChannel,
    updateChannel: mockUpdateChannel,
    deleteChannel: mockDeleteChannel
  }
}))

vi.mock('@data/services/AgentChannelWorkflowService', () => ({
  agentChannelWorkflowService: {
    createChannel: mockCreateChannel,
    updateChannel: mockUpdateChannel,
    deleteChannel: mockDeleteChannel
  }
}))

const { clawTools } = await import('../clawTools')
const { ToolError, ToolErrorCode } = await import('../types')

const WORKSPACE_SOURCE = { type: 'system' as const }

function ctx(agentId = 'agent_test', workspacePath = '/tmp/claw-test', sourceChannelId?: string): ClawToolContext {
  return { agentId, workspace: WORKSPACE_SOURCE, workspacePath, sourceChannelId }
}

function tool(name: string) {
  const found = clawTools.find((t) => t.name === name)
  if (!found) throw new Error(`Tool not found: ${name}`)
  return found
}

async function call(name: string, args: Record<string, unknown>, c = ctx()) {
  return tool(name).handler(args, c)
}

describe('clawTools', () => {
  beforeEach(() => vi.clearAllMocks())

  it('exposes cron, notify, config in order', () => {
    expect(clawTools.map((t) => t.name)).toEqual(['cron', 'notify', 'config'])
    for (const t of clawTools) {
      expect(typeof t.description).toBe('string')
      expect((t.inputSchema as { type: string }).type).toBe('object')
    }
  })

  describe('cron', () => {
    it('creates a cron task', async () => {
      mockCreateTask.mockResolvedValue({ id: 'task_1' })
      const result = await call(
        'cron',
        { action: 'add', name: 'Standup', message: 'run', cron: '0 9 * * 1-5' },
        ctx('agent_1')
      )
      expect(mockCreateTask).toHaveBeenCalledWith('agent_1', {
        name: 'Standup',
        prompt: 'run',
        trigger: { kind: 'cron', expr: '0 9 * * 1-5' },
        workspace: WORKSPACE_SOURCE,
        timeoutMinutes: undefined,
        channelIds: undefined
      })
      expect(result.content[0].type).toBe('text')
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Job created') })
    })

    it('parses interval durations', async () => {
      mockCreateTask.mockResolvedValue({ id: 'task_2' })
      await call('cron', { action: 'add', name: 'x', message: 'y', every: '1h30m' })
      expect(mockCreateTask).toHaveBeenCalledWith(
        'agent_test',
        expect.objectContaining({ trigger: { kind: 'interval', ms: 90 * 60_000 } })
      )
    })

    it('defaults channelIds to the source channel', async () => {
      mockCreateTask.mockResolvedValue({ id: 'task_3' })
      await call('cron', { action: 'add', name: 'x', message: 'y', cron: '* * * * *' }, ctx('a', '/tmp', 'ch_src'))
      expect(mockCreateTask).toHaveBeenCalledWith('a', expect.objectContaining({ channelIds: ['ch_src'] }))
    })

    it('throws ToolError(InvalidParams) when no schedule given', async () => {
      await expect(call('cron', { action: 'add', name: 'x', message: 'y' })).rejects.toMatchObject({
        code: ToolErrorCode.InvalidParams
      })
      expect(mockCreateTask).not.toHaveBeenCalled()
    })

    it('throws when multiple schedules given', async () => {
      await expect(
        call('cron', { action: 'add', name: 'x', message: 'y', cron: '* * * * *', every: '30m' })
      ).rejects.toBeInstanceOf(ToolError)
    })

    it('lists and reports empty', async () => {
      mockListTasks.mockReturnValue({ tasks: [], total: 0 })
      const result = await call('cron', { action: 'list' })
      expect(result.content[0]).toMatchObject({ text: 'No scheduled jobs.' })
    })

    it('removes a task', async () => {
      mockDeleteTask.mockResolvedValue(true)
      const result = await call('cron', { action: 'remove', id: 'task_1' }, ctx('agent_1'))
      expect(mockDeleteTask).toHaveBeenCalledWith('agent_1', 'task_1')
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('removed') })
    })

    it('throws when removing a missing task', async () => {
      mockDeleteTask.mockResolvedValue(false)
      await expect(call('cron', { action: 'remove', id: 'nope' })).rejects.toBeInstanceOf(ToolError)
    })

    it('throws on unknown action', async () => {
      await expect(call('cron', { action: 'frobnicate' })).rejects.toMatchObject({
        code: ToolErrorCode.InvalidParams
      })
    })
  })

  describe('notify', () => {
    const adapter = (channelId: string, chatIds: string[]) => ({
      channelId,
      notifyChatIds: chatIds,
      sendMessage: mockSendMessage,
      sendFile: mockSendFile
    })

    it('sends a message to all notify chats', async () => {
      mockSendMessage.mockResolvedValue(undefined)
      mockGetAgentAdapters.mockReturnValue([adapter('ch1', ['100', '200'])])
      const result = await call('notify', { message: 'Hi' }, ctx('agent_1'))
      expect(mockSendMessage).toHaveBeenCalledTimes(2)
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Message sent to 2 chat(s)') })
      expect(result.isError).toBeFalsy()
    })

    it('returns a normal result when no channels are connected', async () => {
      mockGetAgentAdapters.mockReturnValue([])
      const result = await call('notify', { message: 'Hi' }, ctx('agent_1'))
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('No connected channels') })
      expect(result.isError).toBeFalsy()
    })

    it('throws when both message and file_path are blank', async () => {
      await expect(call('notify', { message: '   ' })).rejects.toMatchObject({ code: ToolErrorCode.InvalidParams })
    })

    it('marks isError when the message reaches no one', async () => {
      mockSendMessage.mockRejectedValue(new Error('rate limited'))
      mockGetAgentAdapters.mockReturnValue([adapter('ch1', ['100'])])
      const result = await call('notify', { message: 'Test' }, ctx('agent_1'))
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Message sent to 0 chat(s)') })
      expect(result.isError).toBe(true)
    })

    describe('file forwarding', () => {
      let workspace: string
      let outside: string
      beforeEach(async () => {
        workspace = await mkdtemp(path.join(tmpdir(), 'clawtools-'))
        outside = await mkdtemp(path.join(tmpdir(), 'clawtools-out-'))
      })
      afterEach(async () => {
        await rm(workspace, { recursive: true, force: true })
        await rm(outside, { recursive: true, force: true })
      })

      it('forwards a workspace file', async () => {
        mockSendFile.mockResolvedValue(undefined)
        mockGetAgentAdapters.mockReturnValue([adapter('ch1', ['100'])])
        await writeFile(path.join(workspace, 'report.txt'), 'hello')
        const result = await call('notify', { file_path: 'report.txt' }, ctx('agent_1', workspace))
        expect(mockSendFile).toHaveBeenCalledTimes(1)
        expect(result.content[0]).toMatchObject({
          text: expect.stringContaining('File "report.txt" sent to 1 chat(s)')
        })
      })

      it('throws when the file escapes the workspace', async () => {
        mockGetAgentAdapters.mockReturnValue([adapter('ch1', ['100'])])
        const secret = path.join(outside, 'secret.txt')
        await writeFile(secret, 'top secret')
        const escape = path.relative(workspace, secret)
        await expect(call('notify', { file_path: escape }, ctx('agent_1', workspace))).rejects.toBeInstanceOf(Error)
        expect(mockSendFile).not.toHaveBeenCalled()
      })
    })
  })

  describe('config', () => {
    const telegramChannel = {
      id: 'ch_1',
      type: 'telegram',
      name: 'My Telegram',
      isActive: true,
      config: { type: 'telegram', bot_token: 'tok', allowed_chat_ids: ['100'] }
    }

    beforeEach(() => {
      mockSyncChannel.mockResolvedValue(undefined)
      mockListChannels.mockReturnValue([])
      mockGetChannel.mockReturnValue(null)
      mockDeleteChannel.mockResolvedValue(undefined)
      mockUpdateChannel.mockResolvedValue(undefined)
    })

    it('returns status with supported channel types', async () => {
      mockGetAgent.mockReturnValue({
        id: 'agent_1',
        name: 'CherryClaw',
        model: 'claude-sonnet-4-20250514',
        configuration: { soul_enabled: true }
      })
      mockListChannels.mockReturnValue([telegramChannel])
      const result = await call('config', { action: 'status' }, ctx('agent_1'))
      const parsed = JSON.parse((result.content[0] as { text: string }).text)
      expect(parsed.agentId).toBe('agent_1')
      expect(parsed.supported_channel_types.map((t: { type: string }) => t.type)).toEqual([
        'telegram',
        'feishu',
        'qq',
        'wechat',
        'discord',
        'slack'
      ])
    })

    it('throws InternalError when the agent is missing', async () => {
      mockGetAgent.mockReturnValue(null)
      await expect(call('config', { action: 'status' }, ctx('agent_1'))).rejects.toMatchObject({
        code: ToolErrorCode.InternalError
      })
    })

    it('adds a non-QR channel', async () => {
      mockCreateChannel.mockResolvedValue({ id: 'ch_new', type: 'telegram', name: 'Work', isActive: true })
      const result = await call(
        'config',
        { action: 'add_channel', type: 'telegram', name: 'Work', config: { bot_token: 'tok' } },
        ctx('agent_1')
      )
      expect(result.content[0]).toMatchObject({ text: expect.stringContaining('Channel added') })
    })

    it('throws when a required config field is missing', async () => {
      await expect(
        call('config', { action: 'add_channel', type: 'telegram', name: 'x', config: {} }, ctx('agent_1'))
      ).rejects.toMatchObject({ code: ToolErrorCode.InvalidParams })
    })

    it('returns a QR image for wechat and cleans up on timeout', async () => {
      mockCreateChannel.mockReturnValue({ id: 'ch_wc', type: 'wechat', name: 'WC', isActive: true })
      mockWaitForQrUrl.mockResolvedValue('https://login.weixin.qq.com/l/abc')
      mockQRCodeToDataURL.mockResolvedValue('data:image/png;base64,iVBORw0KGgo=')
      const result = await call(
        'config',
        { action: 'add_channel', type: 'wechat', name: 'WC', config: { token_path: '/tmp/wc' } },
        ctx('agent_1')
      )
      expect(result.content).toHaveLength(2)
      expect(result.content[1]).toEqual({ type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' })

      // Timeout path: soft isError result + orphan cleanup
      mockWaitForQrUrl.mockRejectedValue(new Error('Timed out'))
      mockCreateChannel.mockReturnValue({ id: 'ch_wc2', type: 'wechat', name: 'WC', isActive: true })
      const timeout = await call(
        'config',
        { action: 'add_channel', type: 'wechat', name: 'WC', config: { token_path: '/tmp/wc' } },
        ctx('agent_1')
      )
      expect(timeout.isError).toBe(true)
      expect(mockDeleteChannel).toHaveBeenCalledWith('ch_wc2')
    })
  })
})
