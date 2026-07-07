import { application } from '@application'
import { agentChannelService as channelService } from '@data/services/AgentChannelService'
import { agentChannelWorkflowService } from '@data/services/AgentChannelWorkflowService'
import { agentService } from '@data/services/AgentService'
import { agentTaskService as taskService } from '@data/services/AgentTaskService'
import { loggerService } from '@logger'
import { type ChannelAdapter, resolveWorkspaceFile, sanitizeChannelOutput } from '@main/ai/channels'
import type { AgentConfiguration } from '@shared/data/api/schemas/agents'
import type { AgentSessionWorkspaceSource } from '@shared/data/api/schemas/agentWorkspaces'
import type { Trigger } from '@shared/data/api/schemas/jobs'
import { type ChannelConfig, ChannelConfigSchema } from '@shared/data/types/channel'
import QRCode from 'qrcode'

import { type NeutralTool, type NeutralToolResult, ToolError, ToolErrorCode } from './types'

const logger = loggerService.withContext('AgentTools:Claw')

/** Per-session context the claw autonomy tools operate on. */
export interface ClawToolContext {
  agentId: string
  workspace: AgentSessionWorkspaceSource
  workspacePath: string
  sourceChannelId?: string
}

/**
 * Parse a human-friendly duration string (e.g. '30m', '2h', '1h30m') into minutes.
 */
function parseDurationToMinutes(duration: string): number {
  let totalMinutes = 0
  const hourMatch = duration.match(/(\d+)\s*h/i)
  const minMatch = duration.match(/(\d+)\s*m/i)

  if (hourMatch) totalMinutes += parseInt(hourMatch[1], 10) * 60
  if (minMatch) totalMinutes += parseInt(minMatch[1], 10)

  if (totalMinutes === 0) {
    const raw = parseInt(duration, 10)
    if (!isNaN(raw) && raw > 0) return raw
    throw new Error(`Invalid duration: "${duration}". Use formats like '30m', '2h', '1h30m'.`)
  }

  return totalMinutes
}

const CRON_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: ['add', 'list', 'remove'],
      description: 'The action to perform'
    },
    name: {
      type: 'string',
      description: 'Name of the job (required for add)'
    },
    message: {
      type: 'string',
      description: 'The prompt/instruction to execute on schedule (required for add)'
    },
    cron: {
      type: 'string',
      description: "Cron expression, e.g. '0 9 * * 1-5' for weekdays at 9am (use cron OR every, not both)"
    },
    every: {
      type: 'string',
      description: "Duration, e.g. '30m', '2h', '24h' (use every OR cron, not both)"
    },
    at: {
      type: 'string',
      description:
        "RFC3339 timestamp for a one-time job, e.g. '2024-01-15T14:30:00+08:00' (use at OR cron OR every, not combined)"
    },
    channel_ids: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Channel IDs to send task results to. Omit to auto-bind all agent channels. Use an empty array [] to skip channel delivery.'
    },
    timeout_minutes: {
      type: 'number',
      description:
        'Timeout in minutes before the task is aborted. Default is 2. Increase for long-running tasks (e.g. 10).'
    },
    id: {
      type: 'string',
      description: 'Job ID (required for remove)'
    }
  },
  required: ['action']
}

const NOTIFY_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    message: {
      type: 'string',
      description: 'The notification message to send to the user. Optional if file_path is provided.'
    },
    file_path: {
      type: 'string',
      description:
        'Optional: path to a file in your workspace to forward to the user (relative to the workspace, or an absolute path inside it). The file must reside within the session workspace.'
    },
    channel_id: {
      type: 'string',
      description: 'Optional: send to a specific channel only (omit to send to all notify-enabled channels)'
    }
  },
  // Enforce "message or file_path" so MCP clients can pre-validate; the handler re-checks
  // the trimmed values (empty strings must still be rejected).
  anyOf: [{ required: ['message'] }, { required: ['file_path'] }]
}

/** Per-adapter-type config schema descriptions (for agent self-documentation). */
const CHANNEL_CONFIG_SCHEMAS: Record<string, { required: string[]; optional: string[]; description: string }> = {
  telegram: {
    required: ['bot_token'],
    optional: ['allowed_chat_ids'],
    description: 'Telegram Bot. Get bot_token from @BotFather.'
  },
  feishu: {
    required: [],
    optional: ['app_id', 'app_secret', 'encrypt_key', 'verification_token', 'allowed_chat_ids', 'domain'],
    description:
      'Feishu/Lark bot. If app_id and app_secret are omitted, a QR code is returned for the user to scan with Feishu to auto-create a bot app and obtain credentials. domain defaults to "feishu" (use "lark" for international).'
  },
  qq: {
    required: ['app_id', 'client_secret'],
    optional: ['allowed_chat_ids'],
    description: 'QQ official bot via QQ Open Platform.'
  },
  wechat: {
    required: [],
    optional: ['token_path', 'allowed_chat_ids'],
    description:
      'WeChat via local WeChat desktop client bridge. After adding, a QR code image is returned — display it inline for the user to scan with their phone.'
  },
  discord: {
    required: ['bot_token'],
    optional: ['allowed_channel_ids'],
    description: [
      'Discord bot via WebSocket gateway.',
      'Setup steps:',
      '1. Go to https://discord.com/developers/applications and click "New Application".',
      '2. Go to the "Bot" tab, click "Reset Token" to generate a new token — this is your bot_token.',
      '3. Under "Privileged Gateway Intents", enable "MESSAGE CONTENT INTENT".',
      '4. Go to "OAuth2 > URL Generator", select scopes: "bot", and bot permissions: "Send Messages", "Read Message History", "View Channels".',
      '5. Copy the generated URL, open it in a browser to invite the bot to your server.',
      '6. allowed_channel_ids format: "channel:<channel_id>" for guild channels, "dm:<channel_id>" for DMs. Send /whoami in Discord to get the correct ID.'
    ].join(' ')
  },
  slack: {
    required: ['bot_token', 'app_token'],
    optional: ['allowed_channel_ids'],
    description: [
      'Slack bot via Socket Mode (WebSocket).',
      'Setup steps:',
      '1. Go to https://api.slack.com/apps and click "Create New App" > "From scratch".',
      '2. Go to "OAuth & Permissions", add Bot Token Scopes: "chat:write", "reactions:write", "channels:history", "groups:history", "im:history", "mpim:history", "users:read", "files:read".',
      '3. Click "Install to Workspace" and copy the "Bot User OAuth Token" (xoxb-...) — this is your bot_token.',
      '4. Go to "Socket Mode" and enable it. Generate an App-Level Token with scope "connections:write" — this is your app_token (xapp-...).',
      '5. Go to "Event Subscriptions", enable events, and subscribe to bot events: "message.channels", "message.groups", "message.im", "message.mpim", "app_mention".',
      '6. Invite the bot to channels by typing /invite @YourBotName in the desired Slack channel.',
      '7. allowed_channel_ids is optional — leave empty to allow all channels the bot is in.'
    ].join(' ')
  }
}

const CONFIG_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    action: {
      type: 'string',
      enum: [
        'status',
        'rename',
        'add_channel',
        'update_channel',
        'remove_channel',
        'reconnect_channel',
        'complete_bootstrap',
        'reset_bootstrap'
      ],
      description: 'The action to perform'
    },
    type: {
      type: 'string',
      enum: ['telegram', 'feishu', 'qq', 'wechat', 'discord', 'slack'],
      description: "Channel adapter type (required for 'add_channel')"
    },
    name: {
      type: 'string',
      description: "For 'rename': the new agent display name. For 'add_channel': human-readable channel name."
    },
    channel_id: {
      type: 'string',
      description: "Channel ID (required for 'update_channel' and 'remove_channel')"
    },
    config: {
      type: 'object',
      description: "Adapter-specific configuration (required for 'add_channel', optional for 'update_channel')"
    },
    enabled: {
      type: 'boolean',
      description: 'Enable or disable the channel (optional for add/update, defaults to true)'
    }
  },
  required: ['action']
}

// ── cron ──────────────────────────────────────────────────────────

async function addJob(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const name = args.name as string | undefined
  const message = args.message as string | undefined
  const cronExpr = args.cron as string | undefined
  const every = args.every as string | undefined
  const at = args.at as string | undefined
  const rawChannelIds = args.channel_ids as string[] | undefined
  const timeoutMinutes = args.timeout_minutes as number | undefined
  if (!name) throw new ToolError("'name' is required for add", ToolErrorCode.InvalidParams)
  if (!message) throw new ToolError("'message' is required for add", ToolErrorCode.InvalidParams)

  // Determine trigger shape (cron expression / interval ms / one-shot timestamp)
  const scheduleCount = [cronExpr, every, at].filter(Boolean).length
  if (scheduleCount === 0)
    throw new ToolError("One of 'cron', 'every', or 'at' is required", ToolErrorCode.InvalidParams)
  if (scheduleCount > 1) throw new ToolError("Use only one of 'cron', 'every', or 'at'", ToolErrorCode.InvalidParams)

  let trigger: Trigger

  if (cronExpr) {
    trigger = { kind: 'cron', expr: cronExpr }
  } else if (every) {
    const minutes = parseDurationToMinutes(every)
    trigger = { kind: 'interval', ms: minutes * 60_000 }
  } else {
    const date = new Date(at!)
    if (isNaN(date.getTime())) throw new ToolError(`Invalid timestamp: "${at}"`, ToolErrorCode.InvalidParams)
    trigger = { kind: 'once', at: date.getTime() }
  }

  // Resolve channel_ids: explicit array, or default to the current channel
  let channelIds: string[] | undefined
  if (Array.isArray(rawChannelIds)) {
    channelIds = rawChannelIds
  } else if (ctx.sourceChannelId) {
    channelIds = [ctx.sourceChannelId]
  }

  const task = await taskService.createTask(ctx.agentId, {
    name,
    prompt: message,
    trigger,
    workspace: ctx.workspace,
    timeoutMinutes: timeoutMinutes && timeoutMinutes > 0 ? timeoutMinutes : undefined,
    channelIds: channelIds && channelIds.length > 0 ? channelIds : undefined
  })

  logger.info('Cron job created via tool', { agentId: ctx.agentId, taskId: task.id })
  return {
    content: [{ type: 'text', text: `Job created:\n${JSON.stringify(task, null, 2)}` }]
  }
}

function listJobs(ctx: ClawToolContext): NeutralToolResult {
  const { tasks } = taskService.listTasks(ctx.agentId, { limit: 100 })

  if (tasks.length === 0) {
    return { content: [{ type: 'text', text: 'No scheduled jobs.' }] }
  }

  return {
    content: [{ type: 'text', text: JSON.stringify(tasks, null, 2) }]
  }
}

async function removeJob(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const id = args.id as string | undefined
  if (!id) throw new ToolError("'id' is required for remove", ToolErrorCode.InvalidParams)

  const deleted = await taskService.deleteTask(ctx.agentId, id)
  if (!deleted) throw new ToolError(`Job "${id}" not found`, ToolErrorCode.InvalidParams)

  logger.info('Cron job removed via tool', { agentId: ctx.agentId, taskId: id })
  return {
    content: [{ type: 'text', text: `Job "${id}" removed.` }]
  }
}

// ── notify ────────────────────────────────────────────────────────

async function sendNotification(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const message = (args.message as string | undefined)?.trim()
  const filePath = (args.file_path as string | undefined)?.trim()
  if (!message && !filePath) {
    throw new ToolError("Provide 'message', 'file_path', or both for notify", ToolErrorCode.InvalidParams)
  }

  const targetChannelId = args.channel_id as string | undefined
  let adapters = application.get('ChannelManager').getAgentAdapters(ctx.agentId)

  if (targetChannelId) {
    adapters = adapters.filter((a) => a.channelId === targetChannelId)
  }

  if (adapters.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: 'No connected channels found. Configure at least one channel in settings.'
        }
      ]
    }
  }

  // Resolve the file once before dispatch so a bad path fails fast (one error,
  // not one per chat). Guard errors surface as a clean isError result via the
  // handler's throw. Done after the no-adapters guard so we don't read up to
  // 100MB off disk only to discover there's nowhere to send it.
  const file = filePath ? await resolveWorkspaceFile(ctx.workspacePath, filePath) : undefined
  const sanitizedMessage = message ? sanitizeChannelOutput(message).text : undefined

  let messagesSent = 0
  let filesSent = 0
  const errors: string[] = []

  const recordError = (adapter: ChannelAdapter, chatId: string, what: string, err: unknown) => {
    const errMsg = err instanceof Error ? err.message : String(err)
    errors.push(`${adapter.channelId}/${chatId} (${what}): ${errMsg}`)
    // Log the raw error, not just its message, so the SDK's cause chain and any
    // attached `response` payload survive to the logs for diagnosis.
    logger.warn(`Failed to send ${what} via notify`, {
      agentId: ctx.agentId,
      channelId: adapter.channelId,
      chatId,
      error: err
    })
  }

  for (const adapter of adapters) {
    for (const chatId of adapter.notifyChatIds) {
      // Message and file are independent — one failing must not skip the other.
      if (sanitizedMessage) {
        try {
          await adapter.sendMessage(chatId, sanitizedMessage)
          messagesSent++
        } catch (err) {
          recordError(adapter, chatId, 'message', err)
        }
      }
      if (file) {
        try {
          await adapter.sendFile(chatId, file)
          filesSent++
        } catch (err) {
          recordError(adapter, chatId, 'file', err)
        }
      }
    }
  }

  const parts: string[] = []
  if (sanitizedMessage) parts.push(`Message sent to ${messagesSent} chat(s).`)
  if (file) parts.push(`File "${file.filename}" sent to ${filesSent} chat(s).`)
  if (errors.length > 0) parts.push(`Errors: ${errors.join('; ')}`)

  logger.info('Notification sent via notify tool', {
    agentId: ctx.agentId,
    messagesSent,
    filesSent,
    errors: errors.length
  })

  // A requested payload that reached nobody because every attempt failed is a failed
  // tool call — otherwise the agent sees success while the user received nothing
  // (unsupported adapter, platform size reject, etc.). Zero recipients with no failed
  // attempts (no chats configured) stays a normal result.
  const messageFailed = sanitizedMessage !== undefined && messagesSent === 0
  const fileFailed = file !== undefined && filesSent === 0
  const deliveryFailed = errors.length > 0 && (messageFailed || fileFailed)

  return {
    content: [{ type: 'text', text: parts.join(' ') }],
    ...(deliveryFailed ? { isError: true } : {})
  }
}

// ── config ────────────────────────────────────────────────────────

function configStatus(ctx: ClawToolContext): NeutralToolResult {
  const agent = agentService.getAgent(ctx.agentId)
  if (!agent) throw new ToolError(`Agent not found: ${ctx.agentId}`, ToolErrorCode.InternalError)

  const config = agent.configuration
  const channels = channelService.listChannels({ agentId: ctx.agentId })

  const adapterStatuses = application.get('ChannelManager').getAdapterStatuses(ctx.agentId)
  const statusMap = new Map(adapterStatuses.map((s) => [s.channelId, s.connected]))

  const channelSummary = channels.map((ch) => ({
    id: ch.id,
    type: ch.type,
    name: ch.name,
    enabled: ch.isActive,
    connected: statusMap.get(ch.id) ?? false
  }))

  const result = {
    agentId: agent.id,
    name: agent.name,
    model: agent.model,
    supported_channel_types: Object.entries(CHANNEL_CONFIG_SCHEMAS).map(([type, schema]) => ({
      type,
      description: schema.description,
      required_fields: schema.required,
      optional_fields: schema.optional
    })),
    channels: channelSummary,
    soul_enabled: config?.soul_enabled ?? false,
    heartbeat_enabled: config?.heartbeat_enabled ?? false
  }

  logger.info('Config status queried', { agentId: ctx.agentId })
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
  }
}

/**
 * Remove a channel from config that failed to connect (e.g. QR timeout).
 * Prevents orphaned channels from blocking future connections.
 */
async function removeOrphanChannel(ctx: ClawToolContext, channelId: string): Promise<void> {
  try {
    await agentChannelWorkflowService.deleteChannel(channelId)
  } catch (err) {
    logger.error('Failed to remove orphan channel', {
      agentId: ctx.agentId,
      channelId,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

async function configAddChannel(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const type = args.type as string | undefined
  const name = args.name as string | undefined
  const channelConfig = args.config as Record<string, unknown> | undefined
  const enabled = args.enabled as boolean | undefined

  if (!type) throw new ToolError("'type' is required for add_channel", ToolErrorCode.InvalidParams)
  if (!name) throw new ToolError("'name' is required for add_channel", ToolErrorCode.InvalidParams)

  const schema = CHANNEL_CONFIG_SCHEMAS[type]
  if (!schema) {
    throw new ToolError(
      `Unknown channel type "${type}". Supported: ${Object.keys(CHANNEL_CONFIG_SCHEMAS).join(', ')}`,
      ToolErrorCode.InvalidParams
    )
  }

  // Validate required config fields
  const cfg = channelConfig ?? {}
  for (const field of schema.required) {
    if (!cfg[field]) {
      throw new ToolError(`Missing required config field "${field}" for ${type} channel`, ToolErrorCode.InvalidParams)
    }
  }

  const channelType = type as ChannelConfig['type']
  const config = ChannelConfigSchema.parse({ type: channelType, ...cfg })

  // For channels that use QR-based setup (WeChat login, Feishu app registration),
  // connect is blocking (waits for QR scan), so run sync in background
  // and wait only for the QR URL to return it to the agent.
  const needsQr = type === 'wechat' || (type === 'feishu' && !cfg.app_id && !cfg.app_secret)

  if (needsQr) {
    const newChannel = channelService.createChannel({
      type: channelType,
      name,
      agentId: ctx.agentId,
      workspace: ctx.workspace,
      config,
      isActive: enabled ?? true
    })

    const channelManager = application.get('ChannelManager')
    const qrPromise = channelManager.waitForQrUrl(ctx.agentId, newChannel.id, 30_000)
    // Fire-and-forget: syncChannel will complete once the user scans
    channelManager.syncChannel(newChannel.id).catch((err) => {
      logger.error(`${type} sync failed`, {
        agentId: ctx.agentId,
        channelId: newChannel.id,
        error: err instanceof Error ? err.message : String(err)
      })
    })

    const channelLabel = type === 'wechat' ? 'WeChat' : 'Feishu'
    const scanHint =
      type === 'wechat'
        ? 'scan with WeChat to log in'
        : 'scan with Feishu to create a bot app and obtain credentials automatically'

    try {
      const qrUrl = await qrPromise
      const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 })
      // Extract base64 from data URI: "data:image/png;base64,..."
      const base64 = qrDataUrl.split(',')[1]

      logger.info(`${channelLabel} channel added, QR code generated`, {
        agentId: ctx.agentId,
        channelId: newChannel.id
      })
      return {
        content: [
          {
            type: 'text',
            text: `${channelLabel} channel created (ID: ${newChannel.id}). QR code generated — display it to the user so they can ${scanHint}.`
          },
          {
            type: 'image',
            data: base64,
            mimeType: 'image/png'
          }
        ]
      }
    } catch (err) {
      // QR timed out — remove the orphan channel so it doesn't block future connections
      await removeOrphanChannel(ctx, newChannel.id)

      logger.warn(`Failed to get ${channelLabel} QR code, orphan channel removed`, {
        agentId: ctx.agentId,
        channelId: newChannel.id,
        error: err instanceof Error ? err.message : String(err)
      })
      return {
        content: [
          {
            type: 'text',
            text: `Failed to set up ${channelLabel} channel: ${err instanceof Error ? err.message : String(err)}. The channel was not saved. Please try again.`
          }
        ],
        isError: true
      }
    }
  }

  const newChannel = await agentChannelWorkflowService.createChannel({
    type: channelType,
    name,
    agentId: ctx.agentId,
    workspace: ctx.workspace,
    config,
    isActive: enabled ?? true
  })

  logger.info('Channel added via config tool', { agentId: ctx.agentId, channelId: newChannel.id, type })
  return {
    content: [
      {
        type: 'text',
        text: `Channel added and activated:\n${JSON.stringify({ id: newChannel.id, type, name, enabled: newChannel.isActive }, null, 2)}`
      }
    ]
  }
}

async function configUpdateChannel(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const channelId = args.channel_id as string | undefined
  if (!channelId) throw new ToolError("'channel_id' is required for update_channel", ToolErrorCode.InvalidParams)

  const existing = channelService.getChannel(channelId)
  if (!existing) throw new ToolError(`Channel "${channelId}" not found`, ToolErrorCode.InvalidParams)

  const updates: Record<string, unknown> = {}
  if (args.name !== undefined) updates.name = args.name as string
  if (args.enabled !== undefined) updates.isActive = args.enabled as boolean
  if (args.config !== undefined) {
    updates.config = { ...existing.config, ...(args.config as Record<string, unknown>) }
  }

  await agentChannelWorkflowService.updateChannel(channelId, updates)

  logger.info('Channel updated via config tool', { agentId: ctx.agentId, channelId })
  return {
    content: [{ type: 'text', text: `Channel "${channelId}" updated and reloaded.` }]
  }
}

async function configRemoveChannel(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const channelId = args.channel_id as string | undefined
  if (!channelId) throw new ToolError("'channel_id' is required for remove_channel", ToolErrorCode.InvalidParams)

  const channel = channelService.getChannel(channelId)
  if (!channel) throw new ToolError(`Channel "${channelId}" not found`, ToolErrorCode.InvalidParams)

  await agentChannelWorkflowService.deleteChannel(channelId)

  logger.info('Channel removed via config tool', { agentId: ctx.agentId, channelId, type: channel.type })
  return {
    content: [{ type: 'text', text: `Channel "${channelId}" (${channel.name}) removed.` }]
  }
}

async function configReconnectChannel(args: Record<string, unknown>, ctx: ClawToolContext): Promise<NeutralToolResult> {
  const channelId = args.channel_id as string | undefined
  if (!channelId) throw new ToolError("'channel_id' is required for reconnect_channel", ToolErrorCode.InvalidParams)

  const channel = channelService.getChannel(channelId)
  if (!channel) throw new ToolError(`Channel "${channelId}" not found`, ToolErrorCode.InvalidParams)

  const needsQr = channel.type === 'wechat' || (channel.type === 'feishu' && !channel.config.app_id)

  const channelManager = application.get('ChannelManager')
  if (!needsQr) {
    await channelManager.syncChannel(channelId)
    return {
      content: [{ type: 'text', text: `Channel "${channelId}" reconnected.` }]
    }
  }

  // QR-based reconnect: sync in background, wait for QR URL
  const qrPromise = channelManager.waitForQrUrl(ctx.agentId, channelId, 30_000)
  channelManager.syncChannel(channelId).catch((err) => {
    logger.error('Reconnect sync failed', {
      agentId: ctx.agentId,
      channelId,
      error: err instanceof Error ? err.message : String(err)
    })
  })

  const channelLabel = channel.type === 'wechat' ? 'WeChat' : 'Feishu'

  try {
    const qrUrl = await qrPromise
    const qrDataUrl = await QRCode.toDataURL(qrUrl, { width: 300, margin: 2 })
    const base64 = qrDataUrl.split(',')[1]

    logger.info(`${channelLabel} channel reconnect QR generated`, { agentId: ctx.agentId, channelId })
    return {
      content: [
        {
          type: 'text',
          text: `${channelLabel} channel "${channelId}" needs re-authentication. Display this QR code for the user to scan.`
        },
        {
          type: 'image',
          data: base64,
          mimeType: 'image/png'
        }
      ]
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to generate QR for reconnect: ${err instanceof Error ? err.message : String(err)}`
        }
      ],
      isError: true
    }
  }
}

function configRename(args: Record<string, unknown>, ctx: ClawToolContext): NeutralToolResult {
  const name = args.name as string | undefined
  if (!name || !name.trim()) throw new ToolError("'name' is required for rename", ToolErrorCode.InvalidParams)

  agentService.updateAgent(ctx.agentId, { name: name.trim() })

  logger.info('Agent renamed via config tool', { agentId: ctx.agentId, name: name.trim() })
  return {
    content: [{ type: 'text', text: `Agent renamed to "${name.trim()}".` }]
  }
}

function configCompleteBootstrap(ctx: ClawToolContext): NeutralToolResult {
  const agent = agentService.getAgent(ctx.agentId)
  if (!agent) throw new ToolError(`Agent not found: ${ctx.agentId}`, ToolErrorCode.InternalError)

  const existingConfig = agent.configuration
  agentService.updateAgent(ctx.agentId, {
    configuration: { ...existingConfig, bootstrap_completed: true } as AgentConfiguration
  })

  logger.info('Bootstrap marked as completed', { agentId: ctx.agentId })
  return {
    content: [{ type: 'text', text: 'Bootstrap completed. Future sessions will use your standard personality.' }]
  }
}

function configResetBootstrap(ctx: ClawToolContext): NeutralToolResult {
  const agent = agentService.getAgent(ctx.agentId)
  if (!agent) throw new ToolError(`Agent not found: ${ctx.agentId}`, ToolErrorCode.InternalError)

  const existingConfig = agent.configuration
  agentService.updateAgent(ctx.agentId, {
    configuration: { ...existingConfig, bootstrap_completed: false } as AgentConfiguration
  })

  logger.info('Bootstrap reset', { agentId: ctx.agentId })
  return {
    content: [{ type: 'text', text: 'Bootstrap has been reset. The next session will run the onboarding flow.' }]
  }
}

// ── Neutral tool definitions ──────────────────────────────────────

const cronTool: NeutralTool<ClawToolContext> = {
  name: 'cron',
  description:
    "Manage scheduled tasks. Use action 'add' to create a recurring or one-time job, 'list' to see all jobs, or 'remove' to delete a job. For one-time jobs, use the 'at' field with an RFC3339 timestamp.",
  inputSchema: CRON_INPUT_SCHEMA,
  handler: (args, ctx) => {
    const action = args.action
    switch (action) {
      case 'add':
        return addJob(args, ctx)
      case 'list':
        return listJobs(ctx)
      case 'remove':
        return removeJob(args, ctx)
      default:
        throw new ToolError(`Unknown action "${action}", expected add/list/remove`, ToolErrorCode.InvalidParams)
    }
  }
}

const notifyTool: NeutralTool<ClawToolContext> = {
  name: 'notify',
  description:
    'Send a notification to the user through connected channels (e.g. Telegram). Provide a message, a file to forward from your workspace, or both. Use this to proactively deliver task results, status updates, or produced files. File support by channel: Telegram/Feishu forward any file; WeChat images only; Discord/Slack/QQ do not support files yet (a file_path to those returns an error).',
  inputSchema: NOTIFY_INPUT_SCHEMA,
  handler: (args, ctx) => sendNotification(args, ctx)
}

const configTool: NeutralTool<ClawToolContext> = {
  name: 'config',
  description:
    "Inspect and manage your own agent configuration. Use 'status' to see current channels, model, and supported adapter types. Use 'rename' to change your display name. Use 'add_channel', 'update_channel', 'remove_channel', or 'reconnect_channel' to manage IM channel connections. Use 'reconnect_channel' when a WeChat or Feishu channel needs to re-scan a QR code (e.g. session expired or initial setup failed). Use 'complete_bootstrap' to mark the onboarding ritual as done. Use 'reset_bootstrap' to re-run the onboarding in the next session.",
  inputSchema: CONFIG_INPUT_SCHEMA,
  handler: (args, ctx) => {
    const action = args.action
    switch (action) {
      case 'status':
        return configStatus(ctx)
      case 'rename':
        return configRename(args, ctx)
      case 'add_channel':
        return configAddChannel(args, ctx)
      case 'update_channel':
        return configUpdateChannel(args, ctx)
      case 'remove_channel':
        return configRemoveChannel(args, ctx)
      case 'reconnect_channel':
        return configReconnectChannel(args, ctx)
      case 'complete_bootstrap':
        return configCompleteBootstrap(ctx)
      case 'reset_bootstrap':
        return configResetBootstrap(ctx)
      default:
        throw new ToolError(
          `Unknown action "${action}", expected status/rename/add_channel/update_channel/remove_channel/reconnect_channel/complete_bootstrap/reset_bootstrap`,
          ToolErrorCode.InvalidParams
        )
    }
  }
}

/** The claw autonomy tools (cron, notify, config), in list order. */
export const clawTools: NeutralTool<ClawToolContext>[] = [cronTool, notifyTool, configTool]
