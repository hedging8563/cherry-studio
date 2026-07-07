import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type { ClawToolContext } from '@main/ai/agents/tools/clawTools'
import { clawTools } from '@main/ai/agents/tools/clawTools'
import type { MemoryToolContext } from '@main/ai/agents/tools/memoryTools'
import { memoryTool } from '@main/ai/agents/tools/memoryTools'
import type { NeutralTool, NeutralToolContent } from '@main/ai/agents/tools/types'

/**
 * pi adapter for the runtime-neutral agent-autonomy tools.
 *
 * Maps each {@link NeutralTool} to a pi `ToolDefinition` for `customTools`.
 * This module only *builds* the definitions — wiring them into
 * `PiRuntimeConnection` is a separate step. Because it is `import type`-only for
 * the pi SDK, it needs no dynamic `loadPiSdk()` and is safe in the CJS main
 * bundle.
 *
 * Design notes:
 * - Names: pi tool names are lowercase by convention; the neutral names
 *   (`cron`, `notify`, `config`, `memory`) already satisfy this, so they pass
 *   through unchanged.
 * - Schema: the neutral canonical form is JSON Schema, which pi accepts directly
 *   as a tool's `parameters` (pi validates plain JSON Schema objects natively).
 *   The `as unknown` hop only bridges the nominal TypeBox `TSchema` type — no
 *   conversion happens at runtime.
 * - Errors: pi has no `isError` result channel; a tool signals failure by
 *   throwing (the agent loop encodes the thrown message). So a handler that
 *   throws propagates as-is, and a soft `isError: true` result is re-thrown with
 *   its text.
 */

function joinTextContent(content: NeutralToolContent[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : '[image]')).join('\n')
}

/** Map one neutral tool (bound to its context) to a pi `ToolDefinition`. */
export function toPiToolDefinition<Ctx>(tool: NeutralTool<Ctx>, ctx: Ctx): ToolDefinition {
  return {
    name: tool.name,
    label: tool.name,
    description: tool.description,
    // JSON Schema flows straight through; pi validates it without a TypeBox build.
    parameters: tool.inputSchema as unknown as ToolDefinition['parameters'],
    async execute(_toolCallId, params) {
      const result = await tool.handler(params as Record<string, unknown>, ctx)
      if (result.isError) {
        throw new Error(joinTextContent(result.content))
      }
      return { content: result.content, details: undefined }
    }
  }
}

/**
 * Build the full set of soul/autonomy tool definitions for a pi session.
 * `clawCtx` and `memoryCtx` carry the per-session state (agent id, workspace).
 */
export function buildSoulToolDefinitions(clawCtx: ClawToolContext, memoryCtx: MemoryToolContext): ToolDefinition[] {
  return [...clawTools.map((tool) => toPiToolDefinition(tool, clawCtx)), toPiToolDefinition(memoryTool, memoryCtx)]
}

/**
 * Names of the soul/autonomy tools (`cron`/`notify`/`config`/`memory`), for the pi approval
 * extension's auto-allow set. Derived from the same tool lists as {@link buildSoulToolDefinitions}
 * so the callable set and the auto-approved set cannot drift.
 */
export const SOUL_TOOL_NAMES: ReadonlySet<string> = new Set([...clawTools.map((tool) => tool.name), memoryTool.name])
