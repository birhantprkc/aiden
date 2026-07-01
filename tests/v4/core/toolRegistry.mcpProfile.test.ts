/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * tests/v4/core/toolRegistry.mcpProfile.test.ts — v4.12 Slice 1 completion.
 *
 * MCP tools (toolset 'mcp') are explicitly user-added, so they bypass the
 * profile *include*-filter and always reach the model — otherwise they're
 * registry-visible (`/mcp status`) but model-invisible (the bug). The
 * exclude-filter and context-filter must still apply: only the include
 * decision is bypassed for 'mcp', nothing else.
 */
import { describe, it, expect } from 'vitest';
import { ToolRegistry } from '../../../core/v4/toolRegistry';
import type { ToolHandler, ExecutionContext } from '../../../core/v4/toolRegistry';

function makeTool(name: string, toolset: string, contexts?: ExecutionContext[]): ToolHandler {
  return {
    schema: { name, description: `Test tool ${name}`, inputSchema: { type: 'object', properties: {} } },
    execute: async () => ({ ok: true }),
    category: 'read',
    mutates: false,
    toolset,
    ...(contexts ? { contexts } : {}),
  };
}

function makeRegistry(): ToolRegistry {
  const r = new ToolRegistry();
  r.register(makeTool('file_list', 'files'));
  r.register(makeTool('web_search', 'web'));
  r.register(makeTool('mcp_fs_read_file', 'mcp'));
  r.register(makeTool('mcp_fs_list_directory', 'mcp'));
  return r;
}

const names = (schemas: { name: string }[]) => schemas.map((s) => s.name).sort();

describe('ToolRegistry — MCP tools bypass profile include-filter (v4.12)', () => {
  it('restrictive profile (no "mcp") still returns mcp_* tools; non-matching non-mcp dropped', () => {
    // Profile = files only (mirrors standard/minimal NOT listing 'mcp').
    const out = names(makeRegistry().getSchemas(['files']));
    expect(out).toContain('file_list');             // in-profile built-in → kept
    expect(out).toContain('mcp_fs_read_file');       // mcp → always (the fix)
    expect(out).toContain('mcp_fs_list_directory');
    expect(out).not.toContain('web_search');         // non-mcp, out-of-profile → still dropped
  });

  it('excludeToolsets: ["mcp"] STILL drops mcp tools (the opt-out lever survives)', () => {
    const out = names(makeRegistry().getSchemas(['files'], undefined, ['mcp']));
    expect(out).toContain('file_list');
    expect(out).not.toContain('mcp_fs_read_file');
    expect(out).not.toContain('mcp_fs_list_directory');
  });

  it('context filter still applies to mcp tools (only the include-filter is bypassed)', () => {
    const r = new ToolRegistry();
    r.register(makeTool('mcp_daemon_only', 'mcp', ['daemon']));
    r.register(makeTool('mcp_anyctx', 'mcp'));
    const out = names(r.getSchemas(['files'], 'repl')); // restrictive profile + repl context
    expect(out).toContain('mcp_anyctx');             // mcp + no contexts → visible in repl
    expect(out).not.toContain('mcp_daemon_only');    // mcp but daemon-only → context filter drops it
  });

  it('non-mcp profile filtering still works normally (regression guard)', () => {
    const out = names(makeRegistry().getSchemas(['files', 'web']));
    expect(out).toContain('file_list');
    expect(out).toContain('web_search');             // both now in profile
    expect(out).toContain('mcp_fs_read_file');       // mcp always
  });

  it('full profile (undefined filter) returns mcp tools too (unchanged)', () => {
    expect(names(makeRegistry().getSchemas(undefined))).toContain('mcp_fs_read_file');
  });
});
