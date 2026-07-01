/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tools/v4/skills/toolBridge.ts — v4.12 OM.2 search bridge for deferred tools.
 *
 * When MCP tool schemas defer (cost over threshold), these reach the model:
 *   - tool_search(query)  → ranked deferred-tool names + descriptions.
 *   - lookup_tool_schema  → the "describe" step (already shipped; reused).
 *   - tool_call(name,args)→ dispatch the deferred tool THROUGH buildExecutor so
 *     it inherits the SAME approval gating (mutates:true) + result redaction/
 *     fence as a direct call. Scoped to the live deferrable (mcp) set so a
 *     restricted toolset can't escape through it.
 *
 * Search text = tool name + description + top-level param names only (no full
 * schema bodies — reduces noisy retrieval). Reads the LIVE registry every call.
 */
import type { ToolHandler, ToolRegistry } from '../../../core/v4/toolRegistry';
import { BRIDGE_TOOLSET, deferredMcpNames } from '../../../core/v4/toolDeferral';

const SEARCH_LIMIT = 20;

export function makeToolBridge(registry: ToolRegistry): ToolHandler[] {
  const tool_search: ToolHandler = {
    schema: {
      name: 'tool_search',
      description:
        'Search the deferred integration/MCP tools by keyword. Returns matching tool names + one-line descriptions. Then call lookup_tool_schema(toolName) for the full schema and tool_call(name, arguments) to run it.',
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Keywords matched against tool name / description / parameter names.' } },
        required: ['query'],
      },
    },
    category: 'read',
    mutates: false,
    toolset: BRIDGE_TOOLSET,
    riskTier: 'safe',
    async execute(args) {
      const q = String(args.query ?? '').toLowerCase().trim();
      const terms = q.split(/\s+/).filter(Boolean);
      const ranked = deferredMcpNames(registry) // LIVE — never cached
        .map((name) => {
          const h = registry.get(name)!;
          const params = Object.keys(h.schema.inputSchema?.properties ?? {});
          // search text = name + description + top-level param names ONLY
          const hay = `${h.schema.name} ${h.schema.description ?? ''} ${params.join(' ')}`.toLowerCase();
          const score = terms.length === 0 ? 1 : terms.reduce((a, t) => a + (hay.includes(t) ? 1 : 0), 0);
          return { name: h.schema.name, description: h.schema.description ?? '', score };
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, SEARCH_LIMIT);
      return { success: true, count: ranked.length, tools: ranked.map(({ name, description }) => ({ name, description })) };
    },
  };

  const tool_call: ToolHandler = {
    schema: {
      name: 'tool_call',
      description:
        'Run a deferred integration/MCP tool by name with its arguments (discover names via tool_search, the schema via lookup_tool_schema). Only deferred tools are reachable; the call is approval-gated and its result sanitized exactly like a direct tool call.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'The deferred tool name to run.' },
          arguments: { type: 'object', description: 'Arguments object for the tool (per its schema).' },
        },
        required: ['name'],
      },
    },
    category: 'read',     // dispatcher — the TARGET's mutates/tier drive approval inside the inner executor
    mutates: false,
    toolset: BRIDGE_TOOLSET,
    riskTier: 'safe',
    async execute(args, ctx) {
      const name = String(args.name ?? '').trim();
      const targetArgs =
        args.arguments && typeof args.arguments === 'object' ? (args.arguments as Record<string, unknown>) : {};
      // ★ scope: only deferrable (mcp) tools are reachable — a restricted toolset
      // cannot escape through tool_call.
      if (!deferredMcpNames(registry).includes(name)) {
        return {
          success: false,
          error: `tool_call only reaches deferred integration tools. "${name}" is not one — call tool_search to list available tools.`,
        };
      }
      // ★ dispatch THROUGH buildExecutor (the single approval/guardrail chokepoint).
      // The target inherits its own approval (mutates:true) + result redaction/fence.
      const exec = registry.buildExecutor(ctx);
      const res = await exec({ id: `bridge-${name}`, name, arguments: targetArgs });
      return res.error ? { success: false, error: res.error } : { success: true, result: res.result };
    },
  };

  return [tool_search, tool_call];
}
