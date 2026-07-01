/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 OM.2 — cost-based MCP/plugin tool deferral + the search bridge.
 *
 * Under threshold → schemas unchanged (no bridge, byte-identical). Over → mcp
 * schemas removed, bridge injected; tool_search ranks the LIVE deferred set;
 * tool_call dispatches THROUGH buildExecutor (approval + redaction inherited)
 * and is scoped to deferrable names; core tools never defer; catalog is live.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry, type ToolHandler, type ToolContext } from '../../core/v4/toolRegistry';
import { ApprovalEngine } from '../../moat/approvalEngine';
import { applyToolDeferral, deferredMcpNames, shouldDeferMcp } from '../../core/v4/toolDeferral';
import { makeToolBridge } from '../../tools/v4/skills/toolBridge';

function coreTool(name: string, toolset: string): ToolHandler {
  return {
    schema: { name, description: `${name} core`, inputSchema: { type: 'object', properties: {} } },
    category: 'read', mutates: false, toolset,
    async execute() { return { success: true }; },
  };
}
function mcpTool(name: string, opts: { dangerousArgs?: boolean } = {}): ToolHandler {
  return {
    // big-ish schema so a handful crosses the byte threshold
    schema: {
      name,
      description: `MCP integration tool ${name} — ${'lorem ipsum '.repeat(20)}`,
      inputSchema: { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(200) }, n: { type: 'number' } } },
    },
    category: 'execute', mutates: true, toolset: 'mcp',
    async execute() { return { success: true, did: name, danger: opts.dangerousArgs }; },
  };
}
function reg(mcpCount: number): ToolRegistry {
  const r = new ToolRegistry();
  r.register(coreTool('file_read', 'files'));
  r.register(coreTool('shell_exec', 'terminal'));
  for (const h of makeToolBridge(r)) r.register(h); // tool_search, tool_call
  for (let i = 0; i < mcpCount; i++) r.register(mcpTool(`mcp__srv__t${i}`));
  return r;
}
const baseCtx = (): ToolContext => ({ cwd: process.cwd(), paths: { authJson: '/tmp/x' } as never } as ToolContext);
// schemas a normal assembly would emit (core + mcp; bridge excluded by toolset).
const assembled = (r: ToolRegistry) => r.list()
  .filter((n) => r.get(n)!.toolset !== 'bridge')
  .map((n) => r.get(n)!.schema);
const OPTS = { providerId: 'p', modelId: 'm' }; // unknown model → 128k default context

describe('shouldDeferMcp threshold', () => {
  it('no mcp → never defer', () => expect(shouldDeferMcp(0, 0, 128000)).toBe(false));
  it('small mcp cost under 10% → no defer', () => expect(shouldDeferMcp(3, 500, 128000)).toBe(false));
  it('cost over 10% of context → defer', () => expect(shouldDeferMcp(3, 13000, 128000)).toBe(true));
  it('force-defer at >100 tools', () => expect(shouldDeferMcp(101, 10, 128000)).toBe(true));
  it('force-defer at >20K tokens', () => expect(shouldDeferMcp(5, 20001, 128000)).toBe(true));
});

describe('OM.2 — under threshold: unchanged (no bridge, byte-identical)', () => {
  it('a couple of small mcp tools → injected directly, no bridge', () => {
    const r = reg(2);
    const out = applyToolDeferral(assembled(r), r, OPTS);
    const names = out.map((s) => s.name);
    expect(names).toContain('mcp__srv__t0');           // mcp injected directly
    expect(names).not.toContain('tool_search');         // no bridge
    expect(names).not.toContain('tool_call');
    expect(out).toEqual(assembled(r));                  // byte-identical passthrough
  });
  it('zero mcp tools → unchanged', () => {
    const r = new ToolRegistry(); r.register(coreTool('file_read', 'files'));
    for (const h of makeToolBridge(r)) r.register(h);
    expect(applyToolDeferral(assembled(r), r, OPTS)).toEqual(assembled(r));
  });
});

describe('OM.2 — over threshold: mcp deferred, bridge injected', () => {
  it('many mcp tools → mcp schemas REMOVED, bridge injected, core kept', () => {
    const r = reg(120); // > 100 → force defer
    const out = applyToolDeferral(assembled(r), r, OPTS);
    const names = out.map((s) => s.name);
    expect(names).toContain('file_read');               // core kept
    expect(names).toContain('shell_exec');
    expect(names).toContain('tool_search');             // bridge injected
    expect(names).toContain('tool_call');
    expect(names.some((n) => n.startsWith('mcp__'))).toBe(false); // ★ no mcp schema in the request
  });

  it('★ no injected (core/bridge) schema NAMES a deferred mcp tool (no dangling ref)', () => {
    const r = reg(120);
    const out = applyToolDeferral(assembled(r), r, OPTS);
    const deferred = deferredMcpNames(r);
    const blob = JSON.stringify(out);
    for (const name of deferred) expect(blob.includes(name)).toBe(false);
  });

  it('core tools never defer regardless of count (only mcp partitions out)', () => {
    const r = reg(120);
    const out = applyToolDeferral(assembled(r), r, OPTS);
    expect(out.find((s) => s.name === 'file_read')).toBeDefined();
    expect(out.find((s) => s.name === 'shell_exec')).toBeDefined();
  });
});

describe('OM.2 — bridge behaviour', () => {
  it('tool_search ranks the LIVE deferred set by query', async () => {
    const r = reg(0);
    r.register(mcpTool('mcp__github__create_issue'));
    r.register(mcpTool('mcp__slack__send_message'));
    const [search] = makeToolBridge(r);
    const res = await search.execute({ query: 'issue' }, baseCtx()) as { tools: Array<{ name: string }> };
    expect(res.tools[0].name).toBe('mcp__github__create_issue');
    expect(res.tools.some((t) => t.name === 'mcp__slack__send_message')).toBe(false); // didn't match
  });

  it('★ catalog is LIVE — a tool added/removed between calls is reflected', async () => {
    const r = reg(0);
    const [search] = makeToolBridge(r);
    expect(deferredMcpNames(r)).toHaveLength(0);
    r.register(mcpTool('mcp__x__added'));
    let res = await search.execute({ query: 'added' }, baseCtx()) as { tools: Array<{ name: string }> };
    expect(res.tools.some((t) => t.name === 'mcp__x__added')).toBe(true);   // appears
    r.unregister('mcp__x__added');
    res = await search.execute({ query: 'added' }, baseCtx()) as { tools: Array<{ name: string }> };
    expect(res.tools.some((t) => t.name === 'mcp__x__added')).toBe(false);  // vanishes (not stale)
  });

  it('★ tool_call dispatches THROUGH buildExecutor → approval-gated; scoped to deferrable names', async () => {
    const r = reg(0);
    let executed = false;
    const target: ToolHandler = {
      schema: { name: 'mcp__srv__danger', description: 'd', inputSchema: { type: 'object', properties: {} } },
      category: 'execute', mutates: true, toolset: 'mcp',
      async execute() { executed = true; return { success: true }; },
    };
    r.register(target);
    const [, toolCall] = makeToolBridge(r);
    r.register(toolCall);

    // smart engine that DENIES dangerous → proves the target was gated, not bypassed.
    const captured: { tier?: string; tool?: string } = {};
    const engine = new ApprovalEngine('smart', {
      riskAssess: async () => ({ tier: 'dangerous', rationale: 'x' }),
      onDecision: (req) => { captured.tier = req.riskTier ?? 'dangerous'; captured.tool = req.toolName; },
    });
    const ctx = { ...baseCtx(), approvalEngine: engine };
    const res = await toolCall.execute({ name: 'mcp__srv__danger', arguments: {} }, ctx) as { success: boolean; error?: string };
    expect(captured.tool).toBe('mcp__srv__danger');  // approval ran for the TARGET (through buildExecutor)
    expect(res.success).toBe(false);                 // smart denied dangerous → not executed
    expect(executed).toBe(false);                    // gate blocked it before execute

    // scoped: a non-deferrable (core) tool is NOT reachable via tool_call
    const blocked = await toolCall.execute({ name: 'file_read', arguments: {} }, ctx) as { success: boolean; error?: string };
    expect(blocked.success).toBe(false);
    expect(blocked.error).toMatch(/not one|tool_search/i);
  });
});
