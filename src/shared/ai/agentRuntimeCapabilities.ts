import { claudeUserFacingTools } from '@shared/ai/claudecode/toolRegistry'
import { PI_BUILTIN_TOOLS } from '@shared/ai/piBuiltinTools'
import { isPiCompatibleModel } from '@shared/ai/piModelCompatibility'
import type { AgentPermissionMode } from '@shared/data/api/schemas/agents'
import type { AgentType } from '@shared/data/types/agent'
import type { Model } from '@shared/data/types/model'
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

const CLAUDE_CODE_BUILTIN_COMMANDS = [
  { command: '/clear', description: 'Clear conversation history' },
  { command: '/compact', description: 'Compact conversation with optional focus instructions' },
  { command: '/context', description: 'Visualize current context usage as a colored grid' },
  {
    command: '/cost',
    description: 'Show token usage statistics (see cost tracking guide for subscription-specific details)'
  },
  { command: '/todos', description: 'List current todo items' }
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
    soul: false,
    mcp: false,
    skills: false,
    slashCommands: PI_BUILTIN_COMMANDS,
    createDefaults: { permissionMode: 'default', soulEnabled: false },
    // Orphan models are rejected (pre-descriptor behavior): pi needs the provider's endpoint
    // config to resolve a wire protocol, so no provider ⇒ not drivable.
    isModelCompatible: (provider, model) => !!provider && isPiCompatibleModel(provider, model),
    transport: 'pi-agent',
    builtinTools: () =>
      PI_BUILTIN_TOOLS.map((tool) => ({
        id: tool.name,
        i18nKeyBase: `agent.tools.builtin.${tool.name}`,
        category: tool.category
      }))
  }
} as const satisfies Record<AgentType, AgentRuntimeCapabilities>
