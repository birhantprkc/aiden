/**
 * Copyright (c) 2026 Shiva Deore (Taracod).
 * Licensed under AGPL-3.0. See LICENSE for details.
 *
 * Aiden — local-first agent.
 */
/**
 * v4.12 Slice 1c — pure mapper: standard Claude-Desktop/Cursor mcpServers
 * config → Aiden's mcp.servers shape.
 */
import { describe, it, expect } from 'vitest';
import { mapStandardMcpServers } from '../../../tools/v4/mcpImport';

describe('mapStandardMcpServers', () => {
  it('maps a stdio command + args', () => {
    const r = mapStandardMcpServers({ mcpServers: { fs: { command: 'npx', args: ['-y', '@x/fs', '/p'] } } });
    expect(r.hadMcpServersKey).toBe(true);
    expect(r.skipped).toEqual([]);
    expect(r.servers).toEqual([
      { name: 'fs', entry: { type: 'stdio', stdio: { command: 'npx', args: ['-y', '@x/fs', '/p'] } }, cmdLine: 'npx -y @x/fs /p' },
    ]);
  });

  it('preserves env (values coerced to strings) — import is the env-allowed path', () => {
    const r = mapStandardMcpServers({ mcpServers: { git: { command: 'uvx', args: ['mcp-server-git'], env: { K: 'v', N: 3 } } } });
    expect(r.servers[0].entry).toEqual({
      type: 'stdio',
      stdio: { command: 'uvx', args: ['mcp-server-git'], env: { K: 'v', N: '3' } },
    });
  });

  it('maps url → http (no command)', () => {
    const r = mapStandardMcpServers({ mcpServers: { hosted: { url: 'https://e.com/mcp' } } });
    expect(r.servers[0].entry).toEqual({ type: 'http', http: { baseUrl: 'https://e.com/mcp' } });
    expect(r.servers[0].cmdLine).toContain('https://e.com/mcp');
  });

  it('defaults args to [] when missing', () => {
    const r = mapStandardMcpServers({ mcpServers: { c: { command: 'cmd' } } });
    expect(r.servers[0].entry).toEqual({ type: 'stdio', stdio: { command: 'cmd', args: [] } });
  });

  it('skips malformed entries with reasons, keeps the good one', () => {
    const r = mapStandardMcpServers({ mcpServers: { bad1: {}, bad2: 'nope', ok: { command: 'x' } } });
    expect(r.servers.map((s) => s.name)).toEqual(['ok']);
    expect(r.skipped).toEqual([
      { name: 'bad1', reason: 'no "command" or "url"' },
      { name: 'bad2', reason: 'not an object' },
    ]);
  });

  it('hadMcpServersKey=false for missing / non-object / array mcpServers', () => {
    expect(mapStandardMcpServers({}).hadMcpServersKey).toBe(false);
    expect(mapStandardMcpServers({ mcpServers: [] }).hadMcpServersKey).toBe(false);
    expect(mapStandardMcpServers(null).hadMcpServersKey).toBe(false);
    expect(mapStandardMcpServers('x').hadMcpServersKey).toBe(false);
  });

  it('empty mcpServers object → key present, zero servers', () => {
    const r = mapStandardMcpServers({ mcpServers: {} });
    expect(r.hadMcpServersKey).toBe(true);
    expect(r.servers).toEqual([]);
    expect(r.skipped).toEqual([]);
  });
});
