import { loggerService } from '@logger'
import { type ClawToolContext, clawTools } from '@main/ai/agents/tools/clawTools'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { AgentSessionWorkspaceSource } from '@shared/data/api/schemas/agentWorkspaces'

import { createNeutralToolMcpServer } from './neutralToolMcpServer'

const logger = loggerService.withContext('McpServer:Claw')

/**
 * Claude SDK MCP server exposing the claw agent-autonomy tools (cron, notify,
 * config). A thin wrapper over the runtime-neutral definitions in
 * `@main/ai/agents/tools/clawTools`; the pi runtime consumes the same
 * definitions via its own adapter.
 */
class ClawServer {
  public mcpServer: McpServer

  constructor(
    agentId: string,
    workspace: AgentSessionWorkspaceSource,
    workspacePath: string,
    sourceChannelId?: string
  ) {
    const ctx: ClawToolContext = { agentId, workspace, workspacePath, sourceChannelId }
    this.mcpServer = createNeutralToolMcpServer({ name: 'claw', version: '1.0.0' }, clawTools, ctx, logger)
  }
}

export default ClawServer
