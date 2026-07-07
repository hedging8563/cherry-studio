import { claudeUserFacingTools } from '@shared/ai/claudecode/toolRegistry'
import { PI_BUILTIN_TOOLS } from '@shared/ai/piBuiltinTools'
import { isPiCompatibleModel } from '@shared/ai/piModelCompatibility'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'
import { isManagedCherryAiDefaultModel } from '@shared/data/presets/cherryai'
import type { AgentType } from '@shared/data/types/agent'
import type { Model } from '@shared/data/types/model'
import { parseUniqueModelId } from '@shared/data/types/model'
import type { Provider } from '@shared/data/types/provider'
import { isAgentRuntimeSupportedModel } from '@shared/utils/model'

import type { SlashCommand } from './slashCommands'

export interface AgentRuntimeCapabilities {
  /** i18n key for runtime selector option. */
  labelKey: string
  labelFallback: string
  /** i18n key for capability-limit hint under the selector; null = none. */
  hintKey: string | null
  permissionModes: readonly AgentPermissionMode[]
  /** plan/small model fields. */
  modelTiers: boolean
  /** soul mode + heartbeat orchestration. */
  soul: boolean
  mcp: boolean
  skills: boolean
  slashCommands: readonly SlashCommand[]
  createDefaults: { permissionMode: AgentPermissionMode; soulEnabled: boolean }
  /** Extra restriction on top of the base agent-friendly filter; null = none. `provider` is
   *  undefined for orphan models — each runtime decides fail-open vs fail-closed there. */
  isModelCompatible: ((provider: Provider | undefined, model: Model) => boolean) | null
  /** providerMetadata.cherry.transport tag stamped by the runtime's stream adapter. */
  transport: string
  /** Edit-dialog catalog rows; i18nKeyBase = 'agent.tools.builtin.<key>'. */
  builtinTools: () => readonly {
    id: string
    i18nKeyBase: string
    labelFallback?: string
    descriptionFallback?: string
    category: string
  }[]
}

const ALL_PERMISSION_MODES = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions'
] as const satisfies readonly AgentPermissionMode[]

// Fallback shown only until the runtime reports the session's real catalog via
// `query.supportedCommands()`. Keep it to current Claude Code built-ins (see
// https://code.claude.com/docs/en/commands) — `/todos` was never a built-in and `/cost` is now
// only an alias of `/usage`, so neither belongs here.
const CLAUDE_CODE_BUILTIN_COMMANDS = [
  { command: '/clear', description: 'Start a new conversation with empty context' },
  { command: '/compact', description: 'Free up context by summarizing the conversation so far' },
  { command: '/context', description: 'Visualize current context usage as a colored grid' },
  { command: '/usage', description: 'Show session cost, plan usage limits, and activity stats' }
] as const satisfies readonly SlashCommand[]

const PI_BUILTIN_COMMANDS = [
  { command: '/compact', description: 'Compact conversation with optional focus instructions' }
] as const satisfies readonly SlashCommand[]

export const AGENT_RUNTIME_CAPABILITIES = {
  'claude-code': {
    labelKey: 'library.config.agent.field.runtime.option.claude_code',
    labelFallback: 'Claude Code',
    hintKey: null,
    permissionModes: ALL_PERMISSION_MODES,
    modelTiers: true,
    soul: true,
    mcp: true,
    skills: true,
    slashCommands: CLAUDE_CODE_BUILTIN_COMMANDS,
    createDefaults: { permissionMode: 'bypassPermissions', soulEnabled: true },
    // Orphan models stay allowed: isAgentRuntimeSupportedModel skips the provider check when provider is undefined.
    isModelCompatible: (provider, model) => isAgentRuntimeSupportedModel(model, provider),
    transport: 'claude-agent',
    builtinTools: () =>
      claudeUserFacingTools().map((tool) => ({
        id: tool.name,
        i18nKeyBase: `agent.tools.builtin.${tool.key}`,
        labelFallback: tool.label,
        descriptionFallback: tool.description,
        category: tool.category
      }))
  },
  pi: {
    labelKey: 'library.config.agent.field.runtime.option.pi',
    labelFallback: 'pi',
    hintKey: 'library.config.agent.field.runtime.pi_hint',
    permissionModes: ALL_PERMISSION_MODES.filter((mode) => mode !== 'plan'),
    modelTiers: false,
    soul: true,
    // MCP servers selected on the agent are bridged into the pi session as customTools and gated by
    // the approval extension (not auto-approved) — see PiRuntimeConnection / piMcpToolAdapter.
    mcp: true,
    skills: true,
    slashCommands: PI_BUILTIN_COMMANDS,
    // Soul is opt-in for pi (createDefaults.soulEnabled stays false, unlike claude's true): pi's
    // autonomy tools run at main-process privilege with no sandbox and pi's create-default permission
    // mode is the gated `default`, so auto-enabling autonomy would contradict that posture.
    createDefaults: { permissionMode: 'default', soulEnabled: false },
    // Orphan models are rejected (pre-descriptor behavior): pi needs the provider's endpoint
    // config to resolve a wire protocol, so no provider ⇒ not drivable. The managed CherryAI
    // free-quota default is barred too — like claude, pi must not drive it directly.
    isModelCompatible: (provider, model) =>
      !!provider &&
      isPiCompatibleModel(provider, model) &&
      !isManagedCherryAiDefaultModel(model.providerId, model.apiModelId ?? parseUniqueModelId(model.id).modelId),
    transport: 'pi-agent',
    builtinTools: () =>
      PI_BUILTIN_TOOLS.map((tool) => ({
        id: tool.name,
        i18nKeyBase: `agent.tools.builtin.${tool.name}`,
        category: tool.category
      }))
  }
} as const satisfies Record<AgentType, AgentRuntimeCapabilities>
