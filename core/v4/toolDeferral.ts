/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * core/v4/toolDeferral.ts — v4.12 OM.2 (cost-based MCP/plugin tool deferral).
 *
 * The tool-side half of injection narrowing. CORE tools are NEVER deferred —
 * only high-cardinality `toolset:'mcp'` (and future plugin) tools, and only when
 * their schema cost crosses a threshold. When deferring we REMOVE the mcp tool
 * schemas from the request and inject the search bridge (tool_search + tool_call;
 * lookup_tool_schema already ships as the "describe" step). Under threshold the
 * schemas pass through unchanged — byte-identical, no bridge, no behaviour change.
 *
 * War-story guards:
 *   #1 (no dangling refs): only mcp leaf tools defer; core prose/schemas never
 *      name them (mcp tools are runtime-discovered), so deferral leaves no
 *      dangling reference. Core tools stay fully injected.
 *   #2 (live catalog): deferredMcpNames() + the partition read the LIVE registry
 *      every call — never a cached session-global catalog.
 *   #3 (bridge through the executor): tool_call dispatches via buildExecutor (the
 *      single approval/guardrail chokepoint) — see tools/v4/skills/toolBridge.ts.
 */
import type { ToolRegistry } from './toolRegistry';
import type { ToolSchema } from '../../providers/v4/types';
import { ModelMetadata } from './modelMetadata';

export const BRIDGE_TOOLSET = 'bridge';
/** Bridge tool schemas injected when deferring (lookup_tool_schema = describe, already shipped). */
export const BRIDGE_INJECT_NAMES = ['tool_search', 'tool_call'] as const;

const DEFER_PCT = 0.10;            // mcp schema cost > 10% of context → defer
const FORCE_DEFER_TOOL_COUNT = 100; // > 100 mcp tools → force defer
const FORCE_DEFER_TOKENS = 20_000;  // > 20K mcp schema tokens → force defer

/** LIVE mcp-tagged tool names from the registry (recomputed each call — never cached). */
export function deferredMcpNames(registry: ToolRegistry): string[] {
  return registry.list().filter((n) => registry.get(n)?.toolset === 'mcp');
}

/** The cost-based threshold. Deferral only when there IS an mcp surface. */
export function shouldDeferMcp(mcpCount: number, mcpCostTokens: number, contextLength: number): boolean {
  if (mcpCount === 0) return false;
  if (mcpCount > FORCE_DEFER_TOOL_COUNT) return true;
  if (mcpCostTokens > FORCE_DEFER_TOKENS) return true;
  return mcpCostTokens > contextLength * DEFER_PCT;
}

export interface DeferralOptions {
  providerId: string;
  modelId: string;
  /** Injected for tests; defaults to a fresh ModelMetadata. */
  meta?: ModelMetadata;
}

/**
 * Cost-based MCP tool deferral over an already-assembled schema list. Returns
 * the schemas unchanged when under threshold; otherwise drops mcp schemas and
 * appends the live bridge schemas. Reads the live registry to classify mcp.
 */
export function applyToolDeferral(
  schemas: ToolSchema[],
  registry: ToolRegistry,
  opts: DeferralOptions,
): ToolSchema[] {
  const isMcp = (name: string): boolean => registry.get(name)?.toolset === 'mcp';
  const mcp = schemas.filter((s) => isMcp(s.name));
  if (mcp.length === 0) return schemas; // nothing deferrable → no change

  const meta = opts.meta ?? new ModelMetadata();
  const contextLength = meta.getLimits(opts.providerId, opts.modelId).contextLength;
  const cost = meta.estimateToolTokens(mcp);
  if (!shouldDeferMcp(mcp.length, cost, contextLength)) return schemas; // under threshold → byte-identical

  // Defer: keep everything non-mcp/non-bridge, append the live bridge schemas.
  const core = schemas.filter(
    (s) => !isMcp(s.name) && registry.get(s.name)?.toolset !== BRIDGE_TOOLSET,
  );
  const bridge: ToolSchema[] = [];
  for (const name of BRIDGE_INJECT_NAMES) {
    const h = registry.get(name);
    if (h) bridge.push(h.schema);
  }
  return [...core, ...bridge];
}
