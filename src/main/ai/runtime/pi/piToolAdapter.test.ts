import type { NeutralTool, NeutralToolResult } from '@main/ai/agents/tools/types'
import { describe, expect, it, vi } from 'vitest'

// Replace the real neutral tool modules (which pull in services) with light fakes
// so the adapter can be exercised in isolation.
const clawHandler = vi.fn()
const memoryHandler = vi.fn()

vi.mock('@main/ai/agents/tools/clawTools', () => ({
  clawTools: [
    { name: 'cron', description: 'cron desc', inputSchema: { type: 'object' }, handler: clawHandler },
    { name: 'notify', description: 'notify desc', inputSchema: { type: 'object' }, handler: clawHandler },
    { name: 'config', description: 'config desc', inputSchema: { type: 'object' }, handler: clawHandler }
  ]
}))

vi.mock('@main/ai/agents/tools/memoryTools', () => ({
  memoryTool: { name: 'memory', description: 'memory desc', inputSchema: { type: 'object' }, handler: memoryHandler }
}))

const { toPiToolDefinition, buildSoulToolDefinitions, SOUL_TOOL_NAMES } = await import('./piToolAdapter')

function fakeTool(result: NeutralToolResult | Error): NeutralTool<{ id: string }> {
  return {
    name: 'demo',
    description: 'demo description',
    inputSchema: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] },
    handler: vi.fn(async () => {
      if (result instanceof Error) throw result
      return result
    })
  }
}

describe('toPiToolDefinition', () => {
  it('maps name, label, description, and passes the JSON Schema through unchanged', () => {
    const tool = fakeTool({ content: [{ type: 'text', text: 'ok' }] })
    const def = toPiToolDefinition(tool, { id: 'ctx1' })
    expect(def.name).toBe('demo')
    expect(def.label).toBe('demo')
    expect(def.description).toBe('demo description')
    // Same object reference — no runtime schema conversion.
    expect(def.parameters).toBe(tool.inputSchema)
  })

  it('threads context and args into the handler and returns pi content with details', async () => {
    const tool = fakeTool({ content: [{ type: 'text', text: 'done' }] })
    const def = toPiToolDefinition(tool, { id: 'ctx1' })
    const out = await def.execute('call-1', { x: '1' }, undefined, undefined, {} as never)
    expect(tool.handler).toHaveBeenCalledWith({ x: '1' }, { id: 'ctx1' })
    expect(out).toEqual({ content: [{ type: 'text', text: 'done' }], details: undefined })
  })

  it('rethrows when the handler throws (hard failure)', async () => {
    const def = toPiToolDefinition(fakeTool(new Error('boom')), { id: 'ctx1' })
    await expect(def.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow('boom')
  })

  it('throws with the joined text when the handler returns a soft isError result', async () => {
    const def = toPiToolDefinition(fakeTool({ content: [{ type: 'text', text: 'reached no one' }], isError: true }), {
      id: 'ctx1'
    })
    await expect(def.execute('c', {}, undefined, undefined, {} as never)).rejects.toThrow('reached no one')
  })
})

describe('buildSoulToolDefinitions', () => {
  it('builds cron, notify, config, memory in order under their claude-parity mcp__ names', () => {
    const defs = buildSoulToolDefinitions(
      { agentId: 'a', workspace: { type: 'system' }, workspacePath: '/w' },
      { agentId: 'a', workspacePath: '/w' }
    )
    expect(defs.map((d) => d.name)).toEqual([
      'mcp__claw__cron',
      'mcp__claw__notify',
      'mcp__claw__config',
      'mcp__agent-memory__memory'
    ])
    // The short neutral name stays as the display label.
    expect(defs.map((d) => d.label)).toEqual(['cron', 'notify', 'config', 'memory'])
    expect(defs.every((d) => typeof d.execute === 'function')).toBe(true)
    // The approval extension's auto-allow set uses exactly the callable names.
    expect(new Set(defs.map((d) => d.name))).toEqual(SOUL_TOOL_NAMES)
  })

  it('routes claw tools to the claw context and memory to the memory context', async () => {
    clawHandler.mockResolvedValue({ content: [{ type: 'text', text: 'c' }] })
    memoryHandler.mockResolvedValue({ content: [{ type: 'text', text: 'm' }] })
    const clawCtx = { agentId: 'a', workspace: { type: 'system' as const }, workspacePath: '/w' }
    const memoryCtx = { agentId: 'a', workspacePath: '/w' }
    const defs = buildSoulToolDefinitions(clawCtx, memoryCtx)

    await defs[0].execute('c', { action: 'list' }, undefined, undefined, {} as never)
    expect(clawHandler).toHaveBeenCalledWith({ action: 'list' }, clawCtx)

    await defs[3].execute('c', { action: 'search' }, undefined, undefined, {} as never)
    expect(memoryHandler).toHaveBeenCalledWith({ action: 'search' }, memoryCtx)
  })
})
